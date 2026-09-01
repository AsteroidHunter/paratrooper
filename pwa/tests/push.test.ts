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

  it("shows inline Settings guidance for denied permission and never retries the prompt", async () => {
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

  it("moves to Settings guidance after Do Not Allow and does not prompt twice", async () => {
    const h = harness({ answer: "denied" });
    await h.setup.check();
    h.setup.action();
    await vi.waitFor(() => expect(h.setup.state()).toEqual({ kind: "denied" }));
    h.setup.action();
    expect(h.requestPermission).toHaveBeenCalledTimes(1);
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

describe("inline banner wiring", () => {
  it("puts one slim banner immediately above, and outside, the composer", () => {
    const render = sourceBetween("function renderChat()", "async function loadOlder(");
    const bannerAt = render.indexOf('id="push-banner"');
    const composeAt = render.indexOf('id="compose"');
    expect(bannerAt).toBeGreaterThan(render.indexOf('id="pending"'));
    expect(composeAt).toBeGreaterThan(bannerAt);
    expect(render.match(/id="push-banner"/g)).toHaveLength(1);
    expect(render).not.toContain("push-setting");
    expect(PUSH_CSS_SOURCE).toContain(".push-banner[hidden]");
    expect(PUSH_CSS_SOURCE).toMatch(/\.push-banner \{[\s\S]*?font-size:\s*12px;/);
  });

  it("uses the approved copy, one Enable action, and concise denied guidance", () => {
    const renderState = sourceBetween("function renderPushState(", "function pushApisSupported(");
    expect(renderState).toContain("Enable notifications from your Paratrooper?");
    expect(renderState).toContain('action.textContent = state.kind === "requesting" ? "Enabling…" : "Enable"');
    expect(renderState).toContain("Re-enable them in iPhone Settings.");
    expect(renderState).toContain("Notifications couldn’t be enabled.");
    expect(renderState).toContain('action.textContent = "Retry"');
  });

  it("routes the tap directly into the synchronous action boundary", () => {
    const render = sourceBetween("function renderChat()", "async function loadOlder(");
    expect(render).toMatch(
      /getElementById\("push-action"\)[\s\S]*?addEventListener\("click", \(\) => \{\s*pushNotifications\?\.action\(\);/,
    );
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
  it("uses the Paratrooper title and current PWA icon, then increments the app badge", async () => {
    const h = serviceWorkerHarness();
    await h.dispatch("push", { data: { text: () => "first reply" } });
    await h.dispatch("push", { data: { text: () => "second reply" } });

    expect(h.showNotification).toHaveBeenNthCalledWith(1, "Paratrooper", {
      body: "first reply",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
    });
    expect(MANIFEST.icons.some((icon) => icon.src === "/icon-192.png")).toBe(true);
    expect(h.setAppBadge.mock.calls.map(([count]) => count)).toEqual([1, 2]);
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
