import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import {
  PUSH_LINK_DB,
  PUSH_LINK_ID,
  PUSH_LINK_STORE,
  createPushSetup,
  lastRegisteredEndpoint,
  registerBody,
  rememberRegisteredEndpoint,
  savePushLink,
} from "../src/push";
import type { PushLink, PushPermission, PushState } from "../src/push";

interface FakeSubscription {
  id: string;
}

interface HarnessOptions {
  supported?: boolean;
  permission?: PushPermission;
  key?: string | null;
  subscription?: FakeSubscription | null;
  answer?: PushPermission;
}

function harness(options: HarnessOptions = {}) {
  let permission = options.permission ?? "default";
  let subscription = options.subscription ?? null;
  const created = { id: "new" };
  const states: PushState[] = [];
  const supported = vi.fn(() => options.supported ?? true);
  const loadPublicKey = vi.fn(async () =>
    Object.prototype.hasOwnProperty.call(options, "key") ? options.key! : "public-key",
  );
  const requestPermission = vi.fn(async () => options.answer ?? permission);
  const getSubscription = vi.fn(async () => subscription);
  const subscribe = vi.fn(async () => {
    subscription = created;
    return created;
  });
  const registerSubscription = vi.fn(async () => undefined);
  const setup = createPushSetup<FakeSubscription>({
    supported,
    permission: () => permission,
    requestPermission,
    loadPublicKey,
    getSubscription,
    subscribe,
    registerSubscription,
    render: (state) => states.push(state),
  });
  return {
    setup,
    states,
    supported,
    loadPublicKey,
    requestPermission,
    getSubscription,
    subscribe,
    registerSubscription,
    setPermission: (next: PushPermission) => { permission = next; },
  };
}

describe("push state check", () => {
  it("stays hidden when notification APIs are unsupported", async () => {
    const h = harness({ supported: false });
    await h.setup.check();
    expect(h.setup.state()).toEqual({ kind: "hidden" });
    expect(h.loadPublicKey).not.toHaveBeenCalled();
    expect(h.requestPermission).not.toHaveBeenCalled();
  });

  it("stays hidden when the server has no VAPID public key", async () => {
    const h = harness({ key: null });
    await h.setup.check();
    expect(h.states.map((state) => state.kind)).toEqual(["checking", "hidden"]);
    expect(h.requestPermission).not.toHaveBeenCalled();
  });

  it("offers Enable for never-asked permission without prompting on boot", async () => {
    const h = harness({ permission: "default" });
    await h.setup.check();
    expect(h.setup.state()).toEqual({ kind: "enable" });
    expect(h.loadPublicKey).toHaveBeenCalledTimes(1);
    expect(h.requestPermission).not.toHaveBeenCalled();
    expect(h.getSubscription).not.toHaveBeenCalled();
  });

  it("shows popup Settings guidance for denied permission and never retries the prompt", async () => {
    const h = harness({ permission: "denied" });
    await h.setup.check();
    expect(h.setup.state()).toEqual({ kind: "denied" });
    h.setup.action();
    expect(h.requestPermission).not.toHaveBeenCalled();
  });

  it("silently re-registers an existing granted subscription", async () => {
    const existing = { id: "existing" };
    const h = harness({ permission: "granted", subscription: existing });
    await h.setup.check();
    expect(h.subscribe).not.toHaveBeenCalled();
    expect(h.registerSubscription).toHaveBeenCalledWith(existing);
    expect(h.setup.state()).toEqual({ kind: "active" });
  });

  it("silently repairs a missing subscription when permission is already granted", async () => {
    const h = harness({ permission: "granted" });
    await h.setup.check();
    expect(h.subscribe).toHaveBeenCalledWith("public-key");
    expect(h.registerSubscription).toHaveBeenCalledWith({ id: "new" });
    expect(h.setup.state()).toEqual({ kind: "active" });
  });

  it("quietly retries a failed key check on the next visibility/open check", async () => {
    const h = harness();
    h.loadPublicKey
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce("public-key");
    await h.setup.check();
    expect(h.setup.state()).toEqual({ kind: "hidden" });
    await h.setup.check();
    expect(h.setup.state()).toEqual({ kind: "enable" });
  });
});

describe("session-only Not Now dismissal", () => {
  it("hides Paratrooper's popup without calling Apple or starting subscription work", async () => {
    const h = harness({ permission: "default" });
    await h.setup.check();
    h.setup.dismiss();
    expect(h.setup.state()).toEqual({ kind: "hidden" });
    expect(h.requestPermission).not.toHaveBeenCalled();
    expect(h.getSubscription).not.toHaveBeenCalled();
    expect(h.subscribe).not.toHaveBeenCalled();
    expect(h.registerSubscription).not.toHaveBeenCalled();

    await h.setup.check();
    expect(h.setup.state()).toEqual({ kind: "hidden" });
    expect(h.requestPermission).not.toHaveBeenCalled();
  });

  it("does not persist dismissal into a fresh controller/app load", async () => {
    const first = harness({ permission: "default" });
    await first.setup.check();
    first.setup.dismiss();
    expect(first.setup.state()).toEqual({ kind: "hidden" });

    const fresh = harness({ permission: "default" });
    await fresh.setup.check();
    expect(fresh.setup.state()).toEqual({ kind: "enable" });
  });

  it("still silently repairs push if iPhone Settings grants permission later", async () => {
    const h = harness({ permission: "default" });
    await h.setup.check();
    h.setup.dismiss();
    h.setPermission("granted");
    await h.setup.check();
    expect(h.subscribe).toHaveBeenCalledWith("public-key");
    expect(h.registerSubscription).toHaveBeenCalledWith({ id: "new" });
    expect(h.setup.state()).toEqual({ kind: "active" });
    expect(h.requestPermission).not.toHaveBeenCalled();
  });

  it("dismisses denied guidance without creating a route back to Apple's prompt", async () => {
    const h = harness({ permission: "denied" });
    await h.setup.check();
    h.setup.dismiss();
    h.setup.action();
    expect(h.setup.state()).toEqual({ kind: "hidden" });
    expect(h.requestPermission).not.toHaveBeenCalled();
  });

  it("can hide a Retry popup while later checks continue repair silently", async () => {
    const h = harness({ permission: "granted" });
    h.registerSubscription.mockRejectedValueOnce(new Error("server unavailable"));
    await h.setup.check();
    expect(h.setup.state()).toEqual({ kind: "retry" });
    h.setup.dismiss();
    expect(h.setup.state()).toEqual({ kind: "hidden" });
    await h.setup.check();
    expect(h.registerSubscription).toHaveBeenCalledTimes(2);
    expect(h.setup.state()).toEqual({ kind: "active" });
  });
});

describe("the direct user-gesture permission action", () => {
  it("calls requestPermission synchronously with the key already fetched", async () => {
    let resolvePermission!: (value: PushPermission) => void;
    const answer = new Promise<PushPermission>((resolve) => { resolvePermission = resolve; });
    const h = harness();
    h.requestPermission.mockImplementation(() => answer);
    await h.setup.check();

    const calls: string[] = [];
    h.requestPermission.mockImplementation(() => {
      calls.push("permission");
      return answer;
    });
    h.setup.action();
    calls.push("returned");

    expect(calls).toEqual(["permission", "returned"]);
    expect(h.setup.state()).toEqual({ kind: "requesting" });
    expect(h.loadPublicKey).toHaveBeenCalledTimes(1);

    resolvePermission("granted");
    await vi.waitFor(() => expect(h.setup.state()).toEqual({ kind: "active" }));
  });

  it("leaves Enable available when the native prompt is dismissed", async () => {
    const h = harness({ answer: "default" });
    await h.setup.check();
    h.setup.action();
    await vi.waitFor(() => expect(h.setup.state()).toEqual({ kind: "enable" }));
  });

  it("hides after Do Not Allow instead of revealing a second Paratrooper popup", async () => {
    const h = harness({ answer: "denied" });
    await h.setup.check();
    h.setup.action();
    await vi.waitFor(() => expect(h.setup.state()).toEqual({ kind: "hidden" }));
    h.setup.action();
    expect(h.requestPermission).toHaveBeenCalledTimes(1);
    await h.setup.check();
    expect(h.setup.state()).toEqual({ kind: "hidden" });
  });

  it("keeps Enable retryable when the browser permission call rejects", async () => {
    const h = harness();
    h.requestPermission.mockRejectedValueOnce(new Error("native sheet failed"));
    await h.setup.check();
    h.setup.action();
    await vi.waitFor(() => expect(h.setup.state()).toEqual({ kind: "enable" }));
    h.setup.action();
    await vi.waitFor(() => expect(h.requestPermission).toHaveBeenCalledTimes(2));
  });

  it("does not let the native sheet's visibility edge supersede the in-flight choice", async () => {
    let resolvePermission!: (value: PushPermission) => void;
    const h = harness();
    h.requestPermission.mockImplementation(() =>
      new Promise<PushPermission>((resolve) => { resolvePermission = resolve; }),
    );
    await h.setup.check();
    h.setup.action();
    await h.setup.check();
    expect(h.loadPublicKey).toHaveBeenCalledTimes(1);
    expect(h.setup.state()).toEqual({ kind: "requesting" });
    resolvePermission("default");
    await vi.waitFor(() => expect(h.setup.state()).toEqual({ kind: "enable" }));
  });

  it("ignores duplicate primary/dismiss actions while Apple's request is in flight", async () => {
    let resolvePermission!: (value: PushPermission) => void;
    const h = harness();
    h.requestPermission.mockImplementation(() =>
      new Promise<PushPermission>((resolve) => { resolvePermission = resolve; }),
    );
    await h.setup.check();
    h.setup.action();
    h.setup.action();
    h.setup.dismiss();
    expect(h.requestPermission).toHaveBeenCalledTimes(1);
    expect(h.setup.state()).toEqual({ kind: "requesting" });
    resolvePermission("default");
    await vi.waitFor(() => expect(h.setup.state()).toEqual({ kind: "enable" }));
  });
});

describe("recoverable subscription setup failures", () => {
  it("offers Retry after subscribe fails and completes on the next action", async () => {
    const h = harness({ permission: "granted" });
    h.subscribe.mockRejectedValueOnce(new Error("push service unavailable"));
    await h.setup.check();
    expect(h.setup.state()).toEqual({ kind: "retry" });
    h.setup.action();
    await vi.waitFor(() => expect(h.setup.state()).toEqual({ kind: "active" }));
    expect(h.subscribe).toHaveBeenCalledTimes(2);
  });

  it("does not erase an earned Retry control when its next key check is offline", async () => {
    const h = harness({ permission: "granted" });
    h.subscribe.mockRejectedValueOnce(new Error("push service unavailable"));
    await h.setup.check();
    expect(h.setup.state()).toEqual({ kind: "retry" });
    h.loadPublicKey.mockRejectedValueOnce(new Error("offline"));
    h.setup.action();
    await vi.waitFor(() => expect(h.loadPublicKey).toHaveBeenCalledTimes(2));
    expect(h.setup.state()).toEqual({ kind: "retry" });
  });

  it("offers Retry after backend registration fails and reuses the browser subscription", async () => {
    const existing = { id: "existing" };
    const h = harness({ permission: "granted", subscription: existing });
    h.registerSubscription.mockRejectedValueOnce(new Error("server unavailable"));
    await h.setup.check();
    expect(h.setup.state()).toEqual({ kind: "retry" });
    h.setup.action();
    await vi.waitFor(() => expect(h.setup.state()).toEqual({ kind: "active" }));
    expect(h.subscribe).not.toHaveBeenCalled();
    expect(h.registerSubscription).toHaveBeenCalledTimes(2);
  });

  it("reuses a newly created browser subscription when only its registration failed", async () => {
    const h = harness({ permission: "granted" });
    h.registerSubscription.mockRejectedValueOnce(new Error("server unavailable"));
    await h.setup.check();
    expect(h.setup.state()).toEqual({ kind: "retry" });
    h.setup.action();
    await vi.waitFor(() => expect(h.setup.state()).toEqual({ kind: "active" }));
    expect(h.subscribe).toHaveBeenCalledTimes(1);
    expect(h.registerSubscription).toHaveBeenCalledTimes(2);
  });

  it("switches a setup failure to denied guidance if permission changed meanwhile", async () => {
    const h = harness({ permission: "granted" });
    h.subscribe.mockImplementationOnce(async () => {
      h.setPermission("denied");
      throw new Error("permission revoked");
    });
    await h.setup.check();
    expect(h.setup.state()).toEqual({ kind: "denied" });
  });

  it("discards late async work after logout", async () => {
    let resolveKey!: (value: string | null) => void;
    const h = harness();
    h.loadPublicKey.mockImplementationOnce(() =>
      new Promise<string | null>((resolve) => { resolveKey = resolve; }),
    );
    const checking = h.setup.check();
    h.setup.stop();
    resolveKey("public-key");
    await checking;
    expect(h.setup.state()).toEqual({ kind: "hidden" });
    expect(h.requestPermission).not.toHaveBeenCalled();
  });
});

// --- endpoint rotation, the page's half --------------------------------------
// The address a push goes to can change while the app is closed, and the server
// cannot tell a rotation from a second device. So a registration NAMES the
// address it replaces. Getting this wrong is not visibly broken: Apple accepts
// a push to a rotated-away address with 201 and shows nothing.

function fakeLocalStorage(): { store: Map<string, string> } {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    },
  });
  return { store };
}

function refuseLocalStorage(): void {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() { throw new Error("storage is disabled in this mode"); },
  });
}

describe("naming the address a registration replaces", () => {
  const subscription = {
    endpoint: "https://push.example/new-address",
    keys: { p256dh: "p", auth: "a" },
  };

  it("names the old address when the phone rotated to a new one", () => {
    const body = JSON.parse(registerBody(subscription, "https://push.example/old-address"));
    expect(body).toEqual({ ...subscription, replaces: "https://push.example/old-address" });
  });

  it("omits replaces when the endpoint has not changed", () => {
    const body = JSON.parse(registerBody(subscription, subscription.endpoint));
    expect(body).toEqual(subscription);
    expect(body).not.toHaveProperty("replaces");
  });

  it("omits replaces on a first-ever registration", () => {
    expect(JSON.parse(registerBody(subscription, null))).toEqual(subscription);
    expect(JSON.parse(registerBody(subscription, ""))).toEqual(subscription);
  });

  it("reads a real subscription through toJSON, not a spread of its prototype", () => {
    // A PushSubscription keeps endpoint and keys behind prototype getters, so
    // { ...subscription } would post an empty object.
    class FakePushSubscription {
      get endpoint() { return "https://push.example/via-getter"; }
      toJSON() { return { endpoint: this.endpoint, keys: { p256dh: "p", auth: "a" } }; }
    }
    const body = JSON.parse(registerBody(new FakePushSubscription(), "https://push.example/old"));
    expect(body.endpoint).toBe("https://push.example/via-getter");
    expect(body.keys).toEqual({ p256dh: "p", auth: "a" });
    expect(body.replaces).toBe("https://push.example/old");
  });
});

describe("the page's memory of its last registered endpoint", () => {
  it("round-trips the endpoint so the next registration can name it", () => {
    fakeLocalStorage();
    expect(lastRegisteredEndpoint()).toBeNull();
    rememberRegisteredEndpoint("https://push.example/first");
    expect(lastRegisteredEndpoint()).toBe("https://push.example/first");
    rememberRegisteredEndpoint("https://push.example/second");
    expect(lastRegisteredEndpoint()).toBe("https://push.example/second");
  });

  it("degrades to no memo instead of throwing when storage is refused", () => {
    refuseLocalStorage();
    expect(() => rememberRegisteredEndpoint("https://push.example/x")).not.toThrow();
    expect(lastRegisteredEndpoint()).toBeNull();
    fakeLocalStorage(); // leave nothing throwing behind for later cases
  });
});

describe("the record the service worker reads", () => {
  const link: PushLink = {
    key: "vapid-public-key",
    token: "app-bearer-token",
    endpoint: "https://push.example/current",
  };

  function readLink(): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open(PUSH_LINK_DB, 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const read = open.result
          .transaction(PUSH_LINK_STORE, "readonly")
          .objectStore(PUSH_LINK_STORE)
          .get(PUSH_LINK_ID);
        read.onsuccess = () => resolve(read.result ?? null);
        read.onerror = () => reject(read.error);
      };
    });
  }

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it("leaves the key, the token and the current endpoint under one id", async () => {
    await savePushLink(link);
    expect(await readLink()).toEqual({ id: PUSH_LINK_ID, ...link });
  });

  it("overwrites the record instead of accumulating one per registration", async () => {
    await savePushLink(link);
    await savePushLink({ ...link, endpoint: "https://push.example/rotated" });
    expect(await readLink()).toEqual({
      id: PUSH_LINK_ID,
      ...link,
      endpoint: "https://push.example/rotated",
    });
  });

  it("resolves quietly when IndexedDB is unavailable", async () => {
    const factory = globalThis.indexedDB;
    (globalThis as { indexedDB?: IDBFactory }).indexedDB = undefined;
    await expect(savePushLink(link)).resolves.toBeUndefined();
    globalThis.indexedDB = factory;
  });
});

const MAIN_SOURCE = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const PUSH_CSS_SOURCE = readFileSync(new URL("../src/push.css", import.meta.url), "utf8");
const PUSH_CSS_RULES = PUSH_CSS_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "");
const SW_SOURCE = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const MANIFEST = JSON.parse(
  readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
) as { icons: Array<{ src: string }> };

function sourceBetween(start: string, end: string): string {
  const at = MAIN_SOURCE.indexOf(start);
  const until = MAIN_SOURCE.indexOf(end, at + start.length);
  expect(at, `missing ${start}`).toBeGreaterThanOrEqual(0);
  expect(until, `missing ${end}`).toBeGreaterThan(at);
  return MAIN_SOURCE.slice(at, until);
}

describe("centered notification popup wiring", () => {
  it("uses one fixed accessible alert dialog without adding a composer layout row", () => {
    const render = sourceBetween("function renderChat()", "async function loadOlder(");
    const dialogAt = render.indexOf('id="push-dialog"');
    const pendingAt = render.indexOf('id="pending"');
    const composeAt = render.indexOf('id="compose"');
    expect(dialogAt).toBeGreaterThanOrEqual(0);
    expect(render.match(/id="push-dialog"/g)).toHaveLength(1);
    expect(render).toContain('role="alertdialog"');
    expect(render).toContain('aria-modal="true"');
    expect(render).toContain('aria-labelledby="push-copy"');
    expect(render.slice(pendingAt, composeAt)).not.toContain("push-dialog");
    expect(render).not.toContain("push-banner");
    expect(render).not.toContain("push-setting");
    expect(PUSH_CSS_RULES).toMatch(/\.push-dialog \{[\s\S]*?position:\s*fixed;/);
    expect(PUSH_CSS_RULES).toMatch(/\.push-dialog \{[\s\S]*?inset:\s*0;/);
    expect(PUSH_CSS_RULES).toMatch(/\.push-dialog \{[\s\S]*?place-items:\s*center;/);
    expect(PUSH_CSS_RULES).toContain(".push-dialog[hidden]");
    expect(PUSH_CSS_RULES).toMatch(/\.push-card \{[\s\S]*?width:\s*min\(304px,/);
    expect(PUSH_CSS_RULES).toMatch(/\.push-card \{[\s\S]*?border-radius:\s*26px;/);
    expect(PUSH_CSS_RULES).toMatch(/\.push-copy \{[\s\S]*?font-size:\s*18px;/);
    expect(PUSH_CSS_RULES).toMatch(/\.push-copy \{[\s\S]*?font-weight:\s*500;/);
    expect(PUSH_CSS_RULES).toMatch(/\.push-actions button \{[\s\S]*?border-radius:\s*999px;/);
    expect(PUSH_CSS_RULES).toContain(".push-dialog.push-dialog-leaving");
    expect(PUSH_CSS_RULES).not.toMatch(/\.push-dialog\.push-dialog-leaving\s*\{[^}]*pointer-events/);
    expect(PUSH_CSS_RULES).not.toMatch(/\.compose\b/);
  });

  it("shows exactly Not Now and Enable with the approved question", () => {
    const render = sourceBetween("function renderChat()", "async function loadOlder(");
    const renderState = sourceBetween("function renderPushState(", "function pushApisSupported(");
    const dialogMarkup = render.slice(
      render.indexOf('id="push-dialog"'),
      render.indexOf('<main id="thread"'),
    );
    const actionLabels = [...dialogMarkup.matchAll(/<button[^>]*>([^<]+)<\/button>/g)]
      .map((match) => match[1].trim());
    expect(actionLabels).toEqual(["Not Now", "Enable"]);
    expect(renderState).toContain("Enable notifications from your Paratrooper?");
    expect(renderState).toContain('action.textContent = "Enable"');
  });

  it("uses the same popup for denied guidance and retry actions", () => {
    const renderState = sourceBetween("function renderPushState(", "function pushApisSupported(");
    const denied = renderState.slice(
      renderState.indexOf('state.kind === "denied"'),
      renderState.indexOf("// Permission was granted"),
    );
    const retry = renderState.slice(renderState.indexOf("// Permission was granted"));
    expect(renderState).toContain("Re-enable them in iPhone Settings.");
    expect(renderState).toContain("Notifications couldn’t be enabled.");
    expect(renderState).toContain("notNow.hidden = false");
    expect(denied).not.toContain("action.hidden = false"); // Not Now only
    expect(retry).toContain("action.hidden = false");
    expect(retry).toContain('action.textContent = "Retry"');
  });

  it("routes Enable directly into the synchronous action boundary", () => {
    const render = sourceBetween("function renderChat()", "async function loadOlder(");
    expect(render).toMatch(
      /pushAction\.addEventListener\("click", \(\) => \{[\s\S]*?pushNotifications\?\.action\(\);[\s\S]*?beginPushDialogExit\(\);/,
    );
  });

  it("routes Not Now only to session dismissal and has no backdrop dismiss handler", () => {
    const render = sourceBetween("function renderChat()", "async function loadOlder(");
    const at = render.indexOf('pushNotNow.addEventListener("click"');
    const notNowBinding = render.slice(at, render.indexOf("});", at) + 3);
    expect(notNowBinding).toContain("pushNotifications?.dismiss()");
    expect(notNowBinding).not.toMatch(/requestPermission|subscribe|localStorage|\.action\(/);
    expect(MAIN_SOURCE).not.toMatch(
      /getElementById\("push-dialog"\)[\s\S]{0,160}addEventListener/,
    );
    expect(notNowBinding).not.toContain(".focus(");
  });

  it("fades and conceals Paratrooper's popup while Apple's request is in flight", () => {
    const renderState = sourceBetween("function renderPushState(", "function pushApisSupported(");
    const hide = sourceBetween("function hidePushDialog(", "function showPushDialog(");
    const render = sourceBetween("function renderChat()", "async function loadOlder(");
    expect(renderState).toContain('state.kind === "requesting"');
    expect(renderState).toContain("hidePushDialog(dialog, state)");
    expect(hide).toContain('classList.add("push-dialog-leaving")');
    expect(render).toContain('control.addEventListener("pointerdown", beginPushDialogExit)');
    expect(renderState).toContain('action.textContent = "Enable"');
    expect(renderState).not.toContain(".focus(");
  });

  it("gently delays the initial popup without delaying the permission tap", () => {
    const render = sourceBetween("function renderChat()", "async function loadOlder(");
    const popup = sourceBetween("const PUSH_DIALOG_TRANSITION_MS", "function pushApisSupported(");
    expect(popup).toContain("const PUSH_DIALOG_DELAY_MS = 2500");
    expect(popup).toMatch(
      /setTimeout\(\(\) => \{[\s\S]*?pushDialogCanShow = true;[\s\S]*?renderPushState\(pending\);[\s\S]*?PUSH_DIALOG_DELAY_MS/,
    );
    expect(render.indexOf("armPushDialogEntrance()"))
      .toBeLessThan(render.indexOf("startPushNotifications()"));
    // the fade the hide timer above is cut to. It is the layer's own, borrowed
    // by the dismissal, which states no timing; the whole shape of the arrival
    // and the departure is pinned in pushcard.test.ts
    expect(PUSH_CSS_RULES).toMatch(/--alert-anim:\s*200ms ease-in-out;/);
    expect(PUSH_CSS_RULES).toMatch(
      /\.push-dialog \{[^}]*transition:\s*opacity var\(--alert-anim\);/,
    );
    expect(PUSH_CSS_RULES).toMatch(/\.push-dialog\.push-dialog-leaving \{\s*opacity: 0;\s*\}/);
  });

  it("checks on load/resume without automatically requesting permission", () => {
    const boot = sourceBetween('if ("serviceWorker" in navigator)', "// paint this device");
    expect(boot).toContain('navigator.serviceWorker.register("/sw.js")');
    expect(boot).toContain("startPushNotifications()");
    expect(boot).not.toContain("requestPermission");
    const visibility = sourceBetween(
      'document.addEventListener("visibilitychange"',
      'if ("serviceWorker" in navigator)',
    );
    const badge = sourceBetween("function clearBadge(", 'if ("serviceWorker" in navigator)');
    expect(visibility).toContain("pushNotifications?.check()");
    expect(badge).toContain('navigator.clearAppBadge().catch(() => {})');
    expect(badge).toContain('postMessage("badge-clear")');
    expect(visibility).toMatch(/visibilityState === "visible"[\s\S]*?clearBadge\(\)/);
    expect(visibility).toMatch(/\}\);\s*clearBadge\(\);/); // opening, not only resume
  });

  it("uses only authenticated public-key and subscription endpoints", () => {
    const start = sourceBetween("function startPushNotifications(", "// --- boot");
    expect(start).toContain('fetch("/api/push/key", { headers: authHeaders() })');
    expect(start).toContain('fetch("/api/push/subscribe"');
    expect(start).toContain("...authHeaders()");
    expect(start).not.toContain("private");
  });

  it("registers by replacement and only then remembers what it registered", () => {
    const start = sourceBetween("function startPushNotifications(", "// --- boot");
    expect(start).toContain("body: registerBody(subscription, lastRegisteredEndpoint())");
    // the memo and the worker's copy are written AFTER the server accepted, so
    // a failed registration never claims an address the server does not hold
    const okAt = start.indexOf("if (!response.ok) throw new Error(`push subscribe:");
    expect(okAt).toBeGreaterThan(start.indexOf("registerBody(subscription"));
    expect(start.indexOf("rememberRegisteredEndpoint(subscription.endpoint)")).toBeGreaterThan(okAt);
    expect(start.indexOf("savePushLink({")).toBeGreaterThan(okAt);
    expect(start).toContain("key: publicKeyForWorker");
    expect(start).toContain("token,"); // the same bearer authHeaders() sends
    expect(start).toContain("endpoint: subscription.endpoint");
  });

  it("gives the worker the key the page itself just fetched from the key route", () => {
    const start = sourceBetween("function startPushNotifications(", "// --- boot");
    const loadKey = start.slice(start.indexOf("loadPublicKey:"), start.indexOf("getSubscription:"));
    expect(loadKey).toContain("publicKeyForWorker = body.key");
    // never a null/invalid key: those paths return or throw above this line
    expect(loadKey.indexOf("publicKeyForWorker = body.key")).toBeGreaterThan(
      loadKey.indexOf("invalid push key"),
    );
  });
});

type WorkerListener = (event: Record<string, unknown>) => void;

// The worker runs in its own realm, so anything it reaches for has to be handed
// in: the rotation handler uses fetch, indexedDB and atob on top of the
// notification globals the earlier tests supply.
function serviceWorkerHarness() {
  const listeners = new Map<string, WorkerListener>();
  const showNotification = vi.fn(async () => undefined);
  const setAppBadge = vi.fn(async () => undefined);
  const clearAppBadge = vi.fn(async () => undefined);
  const matchAll = vi.fn(async () => [] as Array<Record<string, unknown>>);
  const openWindow = vi.fn(async () => undefined);
  const getNotifications = vi.fn(async () => [] as Array<{ close: () => void }>);
  const subscribe = vi.fn(async (_options: unknown) => ({
    endpoint: "https://push.example/resubscribed",
    keys: { p256dh: "fresh-p256dh", auth: "fresh-auth" },
  }));
  const fetchMock = vi.fn(async (_url: string, _init: unknown) => ({ ok: true, status: 200 }));
  const workerSelf = {
    addEventListener: (type: string, listener: WorkerListener) => listeners.set(type, listener),
    registration: { showNotification, getNotifications, pushManager: { subscribe } },
    clients: { matchAll, openWindow, claim: vi.fn(async () => undefined) },
    skipWaiting: vi.fn(),
    location: { origin: "https://example.test" },
  };
  runInNewContext(SW_SOURCE, {
    self: workerSelf,
    navigator: { setAppBadge, clearAppBadge },
    fetch: fetchMock,
    indexedDB: globalThis.indexedDB,
    atob: (encoded: string) => Buffer.from(encoded, "base64").toString("binary"),
  });
  const dispatch = async (type: string, event: Record<string, unknown>): Promise<void> => {
    let waited: Promise<unknown> = Promise.resolve();
    listeners.get(type)?.({
      ...event,
      waitUntil: (promise: Promise<unknown>) => { waited = promise; },
    });
    await waited;
  };
  return {
    listeners,
    showNotification,
    setAppBadge,
    clearAppBadge,
    matchAll,
    openWindow,
    getNotifications,
    subscribe,
    fetch: fetchMock,
    dispatch,
  };
}

describe("service-worker notification behavior", () => {
  it("titles every notification New message and keeps the server's text as the body", async () => {
    const h = serviceWorkerHarness();
    await h.dispatch("push", { data: { text: () => "first reply" } });
    await h.dispatch("push", { data: { text: () => "second reply" } });

    expect(h.showNotification).toHaveBeenNthCalledWith(1, "New message", {
      body: "first reply",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
    });
    expect(h.showNotification).toHaveBeenNthCalledWith(2, "New message", {
      body: "second reply",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
    });
    expect(h.showNotification.mock.calls.map(([title]) => title)).not.toContain("Paratrooper");
    expect(MANIFEST.icons.some((icon) => icon.src === "/icon-192.png")).toBe(true);
    expect(h.setAppBadge.mock.calls.map(([count]) => count)).toEqual([1, 2]);
  });

  it("stays silent while a window is on screen, banner and badge both", async () => {
    const h = serviceWorkerHarness();
    h.matchAll.mockResolvedValue([{ visibilityState: "visible" }]);
    await h.dispatch("push", { data: { text: () => "read it in the thread" } });

    expect(h.showNotification).not.toHaveBeenCalled();
    expect(h.setAppBadge).not.toHaveBeenCalled();
  });

  it("ignores hidden windows and notifies as usual", async () => {
    const h = serviceWorkerHarness();
    h.matchAll.mockResolvedValue([{ visibilityState: "hidden" }]);
    await h.dispatch("push", { data: { text: () => "away reply" } });

    expect(h.showNotification).toHaveBeenNthCalledWith(1, "New message", {
      body: "away reply",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
    });
    expect(h.setAppBadge.mock.calls.map(([count]) => count)).toEqual([1]);
  });

  it("notifies when the app is not open at all", async () => {
    const h = serviceWorkerHarness();
    h.matchAll.mockResolvedValue([]);
    await h.dispatch("push", { data: { text: () => "nobody home" } });

    expect(h.showNotification).toHaveBeenNthCalledWith(1, "New message", {
      body: "nobody home",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
    });
    expect(h.setAppBadge.mock.calls.map(([count]) => count)).toEqual([1]);
  });

  it("still notifies when one window is hidden alongside no visible one", async () => {
    const h = serviceWorkerHarness();
    h.matchAll.mockResolvedValue([{ visibilityState: "hidden" }, { visibilityState: "prerender" }]);
    await h.dispatch("push", { data: { text: () => "two backgrounded tabs" } });

    expect(h.showNotification).toHaveBeenCalledTimes(1);
  });

  it("suppresses when any one of several windows is visible", async () => {
    const h = serviceWorkerHarness();
    h.matchAll.mockResolvedValue([{ visibilityState: "hidden" }, { visibilityState: "visible" }]);
    await h.dispatch("push", { data: { text: () => "one tab is up front" } });

    expect(h.showNotification).not.toHaveBeenCalled();
    expect(h.setAppBadge).not.toHaveBeenCalled();
  });

  it("asks for window clients including ones this worker does not control", async () => {
    const h = serviceWorkerHarness();
    await h.dispatch("push", { data: { text: () => "any window" } });

    expect(h.matchAll).toHaveBeenCalledWith({ type: "window", includeUncontrolled: true });
  });

  it("leaves the unread count untouched while the app is on screen", async () => {
    const h = serviceWorkerHarness();
    h.matchAll.mockResolvedValue([{ visibilityState: "visible" }]);
    await h.dispatch("push", { data: { text: () => "seen live" } });
    h.matchAll.mockResolvedValue([]);
    await h.dispatch("push", { data: { text: () => "arrived after leaving" } });

    expect(h.setAppBadge.mock.calls.map(([count]) => count)).toEqual([1]);
  });

  it("keeps the whole visibility-and-notify chain inside waitUntil", () => {
    const at = SW_SOURCE.indexOf('self.addEventListener("push"');
    const until = SW_SOURCE.indexOf('self.addEventListener("message"', at);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(until).toBeGreaterThan(at);
    const push = SW_SOURCE.slice(at, until);

    expect(push).toContain('self.clients.matchAll({ type: "window", includeUncontrolled: true })');
    expect(push.indexOf("event.waitUntil(")).toBeGreaterThanOrEqual(0);
    expect(push.indexOf("event.waitUntil(")).toBeLessThan(push.indexOf("self.clients.matchAll"));
    expect(push.indexOf("event.waitUntil(")).toBeLessThan(push.indexOf("showNotification"));
  });

  it("clears unread state on the page message and restarts the next badge at one", async () => {
    const h = serviceWorkerHarness();
    await h.dispatch("push", { data: { text: () => "first" } });
    h.listeners.get("message")?.({ data: "badge-clear" });
    await h.dispatch("push", { data: { text: () => "after open" } });
    expect(h.clearAppBadge).toHaveBeenCalledTimes(1);
    expect(h.setAppBadge.mock.calls.map(([count]) => count)).toEqual([1, 1]);
  });

  it("closes every banner still standing when the page says the thread is on screen", async () => {
    const h = serviceWorkerHarness();
    const closes = [vi.fn(), vi.fn(), vi.fn()];
    h.getNotifications.mockResolvedValue(closes.map((close) => ({ close })));
    h.listeners.get("message")?.({ data: "badge-clear" });

    await vi.waitFor(() => expect(closes[2]).toHaveBeenCalledTimes(1));
    expect(h.getNotifications).toHaveBeenCalledTimes(1);
    for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
    expect(h.clearAppBadge).toHaveBeenCalledTimes(1);
  });

  it("asks for the whole list, unfiltered, so no banner is left behind by a tag", async () => {
    const h = serviceWorkerHarness();
    h.listeners.get("message")?.({ data: "badge-clear" });

    await vi.waitFor(() => expect(h.getNotifications).toHaveBeenCalledTimes(1));
    expect(h.getNotifications).toHaveBeenCalledWith();
  });

  it("clears the badge as usual when there is nothing left to close", async () => {
    const h = serviceWorkerHarness();
    h.getNotifications.mockResolvedValue([]);
    h.listeners.get("message")?.({ data: "badge-clear" });

    await vi.waitFor(() => expect(h.getNotifications).toHaveBeenCalledTimes(1));
    expect(h.clearAppBadge).toHaveBeenCalledTimes(1);
  });

  it("shrugs off a refused notification lookup", async () => {
    const h = serviceWorkerHarness();
    h.getNotifications.mockRejectedValue(new Error("not supported here"));

    expect(() => h.listeners.get("message")?.({ data: "badge-clear" })).not.toThrow();
    await vi.waitFor(() => expect(h.getNotifications).toHaveBeenCalledTimes(1));
    expect(h.clearAppBadge).toHaveBeenCalledTimes(1);
  });

  it("leaves notifications alone for messages that are not badge-clear", async () => {
    const h = serviceWorkerHarness();
    h.listeners.get("message")?.({ data: "something-else" });

    await Promise.resolve();
    expect(h.getNotifications).not.toHaveBeenCalled();
    expect(h.clearAppBadge).not.toHaveBeenCalled();
  });

  it("closes and focuses an existing Paratrooper window on notification tap", async () => {
    const h = serviceWorkerHarness();
    const focus = vi.fn(async () => undefined);
    h.matchAll.mockResolvedValue([{ focus }]);
    const close = vi.fn();
    await h.dispatch("notificationclick", { notification: { close } });
    expect(close).toHaveBeenCalledTimes(1);
    expect(h.matchAll).toHaveBeenCalledWith({ type: "window", includeUncontrolled: true });
    expect(focus).toHaveBeenCalledTimes(1);
    expect(h.openWindow).not.toHaveBeenCalled();
  });

  it("opens Paratrooper when no existing window can be focused", async () => {
    const h = serviceWorkerHarness();
    await h.dispatch("notificationclick", { notification: { close: vi.fn() } });
    expect(h.openWindow).toHaveBeenCalledWith("/");
  });
});

// --- endpoint rotation, the worker's half ------------------------------------
// The page repairs a rotation on its next open; this repairs it at the moment
// it happens, with no page running. Everything the worker needs comes from the
// one IndexedDB record the page writes at registration, because a worker can
// reach neither localStorage nor the authenticated key route.

describe("service-worker push address rotation", () => {
  const link: PushLink = {
    key: "dGVzdC12YXBpZC1rZXk", // base64url; the worker decodes it for subscribe
    token: "app-bearer-token",
    endpoint: "https://push.example/stored-address",
  };
  const rotated = {
    endpoint: "https://push.example/handed-over",
    keys: { p256dh: "handed-p256dh", auth: "handed-auth" },
  };

  function posted(h: ReturnType<typeof serviceWorkerHarness>) {
    const [url, init] = h.fetch.mock.calls[0] as [string, Record<string, unknown>];
    return {
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string),
    };
  }

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it("takes the browser's new subscription and posts it naming the old address", async () => {
    await savePushLink(link);
    const h = serviceWorkerHarness();
    await h.dispatch("pushsubscriptionchange", {
      oldSubscription: { endpoint: link.endpoint },
      newSubscription: rotated,
    });

    expect(h.subscribe).not.toHaveBeenCalled(); // the event already brought one
    const sent = posted(h);
    expect(sent.url).toBe("/api/push/subscribe");
    expect(sent.headers.Authorization).toBe("Bearer app-bearer-token");
    expect(sent.headers["Content-Type"]).toBe("application/json");
    expect(sent.body).toEqual({ ...rotated, replaces: link.endpoint });
  });

  it("subscribes fresh with the stored key when the event brings no subscription", async () => {
    await savePushLink(link);
    const h = serviceWorkerHarness();
    await h.dispatch("pushsubscriptionchange", {});

    expect(h.subscribe).toHaveBeenCalledTimes(1);
    const [options] = h.subscribe.mock.calls[0] as [Record<string, unknown>];
    expect(options.userVisibleOnly).toBe(true);
    expect(Array.from(options.applicationServerKey as Uint8Array)).toEqual(
      Array.from(Buffer.from("test-vapid-key")),
    );
    const sent = posted(h);
    expect(sent.body.endpoint).toBe("https://push.example/resubscribed");
    expect(sent.body.replaces).toBe(link.endpoint); // the stored address, no oldSubscription
  });

  it("prefers the event's own old address over the stored one", async () => {
    await savePushLink(link);
    const h = serviceWorkerHarness();
    await h.dispatch("pushsubscriptionchange", {
      oldSubscription: { endpoint: "https://push.example/actually-previous" },
      newSubscription: rotated,
    });
    expect(posted(h).body.replaces).toBe("https://push.example/actually-previous");
  });

  it("advances the stored address so a second rotation names the right predecessor", async () => {
    await savePushLink(link);
    const first = serviceWorkerHarness();
    await first.dispatch("pushsubscriptionchange", { newSubscription: rotated });
    expect(posted(first).body.replaces).toBe(link.endpoint);

    const second = serviceWorkerHarness();
    await second.dispatch("pushsubscriptionchange", {
      newSubscription: { endpoint: "https://push.example/third", keys: {} },
    });
    expect(posted(second).body.replaces).toBe(rotated.endpoint);
  });

  it("sends no replaces when the address turns out to be unchanged", async () => {
    await savePushLink(link);
    const h = serviceWorkerHarness();
    await h.dispatch("pushsubscriptionchange", {
      newSubscription: { endpoint: link.endpoint, keys: {} },
    });
    expect(posted(h).body).not.toHaveProperty("replaces");
  });

  it("does nothing at all on a device the page has never registered from", async () => {
    const h = serviceWorkerHarness();
    await h.dispatch("pushsubscriptionchange", { newSubscription: rotated });
    expect(h.subscribe).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("stays quiet when the stored record has no token to authenticate with", async () => {
    await savePushLink({ ...link, token: "" });
    const h = serviceWorkerHarness();
    await h.dispatch("pushsubscriptionchange", { newSubscription: rotated });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("swallows a refused re-subscribe and leaves the repair to the next app open", async () => {
    await savePushLink(link);
    const h = serviceWorkerHarness();
    h.subscribe.mockRejectedValueOnce(new Error("push service unavailable"));
    await expect(h.dispatch("pushsubscriptionchange", {})).resolves.toBeUndefined();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("swallows a failed post and keeps the old stored address for the retry", async () => {
    await savePushLink(link);
    const h = serviceWorkerHarness();
    h.fetch.mockRejectedValueOnce(new Error("offline"));
    await expect(
      h.dispatch("pushsubscriptionchange", { newSubscription: rotated }),
    ).resolves.toBeUndefined();

    const retry = serviceWorkerHarness();
    await retry.dispatch("pushsubscriptionchange", { newSubscription: rotated });
    expect(posted(retry).body.replaces).toBe(link.endpoint); // memo never moved
  });

  it("keeps the stored address when the server rejects the registration", async () => {
    await savePushLink(link);
    const h = serviceWorkerHarness();
    h.fetch.mockResolvedValueOnce({ ok: false, status: 401 });
    await h.dispatch("pushsubscriptionchange", { newSubscription: rotated });

    const retry = serviceWorkerHarness();
    await retry.dispatch("pushsubscriptionchange", { newSubscription: rotated });
    expect(posted(retry).body.replaces).toBe(link.endpoint);
  });

  it("survives IndexedDB being refused outright", async () => {
    const factory = globalThis.indexedDB;
    (globalThis as { indexedDB?: IDBFactory }).indexedDB = undefined;
    const h = serviceWorkerHarness();
    await expect(
      h.dispatch("pushsubscriptionchange", { newSubscription: rotated }),
    ).resolves.toBeUndefined();
    expect(h.fetch).not.toHaveBeenCalled();
    globalThis.indexedDB = factory;
  });

  it("opens the same database, store and record the page writes", () => {
    expect(SW_SOURCE).toContain(`const LINK_DB = "${PUSH_LINK_DB}"`);
    expect(SW_SOURCE).toContain(`const LINK_STORE = "${PUSH_LINK_STORE}"`);
    expect(SW_SOURCE).toContain(`const LINK_ID = "${PUSH_LINK_ID}"`);
  });

  it("keeps the whole rotation chain inside waitUntil", () => {
    const at = SW_SOURCE.indexOf('self.addEventListener("pushsubscriptionchange"');
    expect(at).toBeGreaterThanOrEqual(0);
    const handler = SW_SOURCE.slice(at);
    expect(handler.indexOf("event.waitUntil(")).toBeLessThan(handler.indexOf("fetch("));
    expect(handler).toContain("catch");
  });
});
