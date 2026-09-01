import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createPushSetup } from "../src/push";
import type { PushPermission, PushState } from "../src/push";

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
    expect(PUSH_CSS_RULES).toMatch(/transition:\s*opacity 360ms/);
    expect(PUSH_CSS_RULES).toMatch(/translateY\(8px\) scale\(0\.95\)/);
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
});

type WorkerListener = (event: Record<string, unknown>) => void;

function serviceWorkerHarness() {
  const listeners = new Map<string, WorkerListener>();
  const showNotification = vi.fn(async () => undefined);
  const setAppBadge = vi.fn(async () => undefined);
  const clearAppBadge = vi.fn(async () => undefined);
  const matchAll = vi.fn(async () => [] as Array<Record<string, unknown>>);
  const openWindow = vi.fn(async () => undefined);
  const workerSelf = {
    addEventListener: (type: string, listener: WorkerListener) => listeners.set(type, listener),
    registration: { showNotification },
    clients: { matchAll, openWindow, claim: vi.fn(async () => undefined) },
    skipWaiting: vi.fn(),
    location: { origin: "https://example.test" },
  };
  runInNewContext(SW_SOURCE, {
    self: workerSelf,
    navigator: { setAppBadge, clearAppBadge },
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
