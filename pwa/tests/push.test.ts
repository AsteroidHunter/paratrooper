import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  it("keeps the control hidden when Notifications or PushManager are unsupported", async () => {
    const h = harness({ supported: false });
    await h.setup.check();
    expect(h.setup.state()).toEqual({ kind: "hidden" });
    expect(h.loadPublicKey).not.toHaveBeenCalled();
    expect(h.requestPermission).not.toHaveBeenCalled();
  });

  it("treats a null public key as feature-off and shows no control", async () => {
    const h = harness({ key: null });
    await h.setup.check();
    expect(h.states.map((state) => state.kind)).toEqual(["checking", "hidden"]);
    expect(h.requestPermission).not.toHaveBeenCalled();
  });

  it("loads the key and offers an enable control without prompting on boot", async () => {
    const h = harness({ permission: "default" });
    await h.setup.check();
    expect(h.setup.state()).toEqual({ kind: "enable" });
    expect(h.loadPublicKey).toHaveBeenCalledTimes(1);
    expect(h.requestPermission).not.toHaveBeenCalled();
    expect(h.getSubscription).not.toHaveBeenCalled();
  });

  it("shows Settings guidance state for a permission already denied", async () => {
    const h = harness({ permission: "denied" });
    await h.setup.check();
    expect(h.setup.state()).toEqual({ kind: "denied" });
    h.setup.action();
    expect(h.requestPermission).not.toHaveBeenCalled();
  });

  it("re-registers an existing granted subscription automatically", async () => {
    const existing = { id: "existing" };
    const h = harness({ permission: "granted", subscription: existing });
    await h.setup.check();
    expect(h.subscribe).not.toHaveBeenCalled();
    expect(h.registerSubscription).toHaveBeenCalledWith(existing);
    expect(h.setup.state()).toEqual({ kind: "active" });
  });

  it("repairs a missing subscription automatically when permission is granted", async () => {
    const h = harness({ permission: "granted" });
    await h.setup.check();
    expect(h.subscribe).toHaveBeenCalledWith("public-key");
    expect(h.registerSubscription).toHaveBeenCalledWith({ id: "new" });
    expect(h.setup.state()).toEqual({ kind: "active" });
  });
});

describe("the user-gesture permission action", () => {
  it("calls requestPermission synchronously and uses the key already fetched at boot", async () => {
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
    expect(h.loadPublicKey).toHaveBeenCalledTimes(1); // never fetched in the tap path

    resolvePermission("granted");
    await vi.waitFor(() => expect(h.setup.state()).toEqual({ kind: "active" }));
  });

  it("leaves the enable control available when the native prompt is dismissed", async () => {
    const h = harness({ answer: "default" });
    await h.setup.check();
    h.setup.action();
    await vi.waitFor(() => expect(h.setup.state()).toEqual({ kind: "enable" }));
  });

  it("moves to denied guidance when the user chooses Do Not Allow", async () => {
    const h = harness({ answer: "denied" });
    await h.setup.check();
    h.setup.action();
    await vi.waitFor(() => expect(h.setup.state()).toEqual({ kind: "denied" }));
    h.setup.action();
    expect(h.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("keeps a retryable enable action when requestPermission rejects", async () => {
    const h = harness();
    h.requestPermission.mockRejectedValueOnce(new Error("native sheet failed"));
    await h.setup.check();
    h.setup.action();
    await vi.waitFor(() =>
      expect(h.setup.state()).toEqual({ kind: "enable", requestFailed: true }),
    );
  });

  it("does not let a visibility check supersede a permission prompt in flight", async () => {
    let resolvePermission!: (value: PushPermission) => void;
    const h = harness();
    h.requestPermission.mockImplementation(() =>
      new Promise<PushPermission>((resolve) => { resolvePermission = resolve; }),
    );
    await h.setup.check();
    h.setup.action();
    await h.setup.check(); // the visible edge caused by a native sheet
    expect(h.loadPublicKey).toHaveBeenCalledTimes(1);
    expect(h.setup.state()).toEqual({ kind: "requesting" });
    resolvePermission("default");
    await vi.waitFor(() => expect(h.setup.state()).toEqual({ kind: "enable" }));
  });
});

describe("recoverable setup failures", () => {
  it("offers retry when the public-key request fails and recovers on action", async () => {
    const h = harness();
    h.loadPublicKey
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce("public-key");
    await h.setup.check();
    expect(h.setup.state()).toEqual({ kind: "retry" });
    h.setup.action();
    await vi.waitFor(() => expect(h.setup.state()).toEqual({ kind: "enable" }));
  });

  it("offers retry after subscribe fails and can finish on the next check", async () => {
    const h = harness({ permission: "granted" });
    h.subscribe.mockRejectedValueOnce(new Error("push service unavailable"));
    await h.setup.check();
    expect(h.setup.state()).toEqual({ kind: "retry" });
    h.setup.action();
    await vi.waitFor(() => expect(h.setup.state()).toEqual({ kind: "active" }));
    expect(h.subscribe).toHaveBeenCalledTimes(2);
  });

  it("offers retry after backend registration fails and reuses the browser subscription", async () => {
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

  it("turns a setup failure into denied guidance if permission changed meanwhile", async () => {
    const h = harness({ permission: "granted" });
    h.subscribe.mockImplementationOnce(async () => {
      h.setPermission("denied");
      throw new Error("permission revoked");
    });
    await h.setup.check();
    expect(h.setup.state()).toEqual({ kind: "denied" });
  });

  it("discards late async results after logout stops the setup", async () => {
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

// main.ts boots a real DOM shell at import, so its integration points are
// source-pinned in the same style as the existing flight/thread-cache tests.
const here = dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(join(here, "../src/main.ts"), "utf8");

function functionBody(name: string): string {
  const start = mainSource.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = mainSource.indexOf("\n}", start);
  return mainSource.slice(start, end);
}

describe("main push wiring", () => {
  it("places one notification action and status area in the existing settings menu", () => {
    const render = functionBody("renderChat");
    expect(render).toContain('id="push-setting"');
    expect(render).toContain('id="push-action"');
    expect(render).toContain('id="push-status"');
    expect(render).toContain('id="push-help"');
  });

  it("maps denied state to iPhone Settings guidance instead of another prompt", () => {
    const render = functionBody("renderPushState");
    const denied = render.slice(render.indexOf('state.kind === "denied"'));
    expect(denied).toContain("Notifications Off");
    expect(denied).toContain("iPhone Settings → Notifications → Paratrooper");
    expect(denied).not.toContain("requestPermission");
  });

  it("routes the click straight into the synchronous action boundary", () => {
    const render = functionBody("renderChat");
    expect(render).toMatch(
      /getElementById\("push-action"\)[\s\S]*?addEventListener\("click", \(\) => \{\s*pushNotifications\?\.action\(\);/,
    );
  });

  it("boots from the registered worker and never requests permission on window load", () => {
    const boot = mainSource.slice(mainSource.indexOf('if ("serviceWorker" in navigator)'));
    expect(boot).toContain('navigator.serviceWorker.register("/sw.js")');
    expect(boot).toContain("startPushNotifications()");
    expect(boot).not.toContain("requestPermission");
  });

  it("uses only the authenticated public-key and subscription endpoints", () => {
    const start = functionBody("startPushNotifications");
    expect(start).toContain('fetch("/api/push/key", { headers: authHeaders() })');
    expect(start).toContain('fetch("/api/push/subscribe"');
    expect(start).toContain("...authHeaders()");
    expect(start).not.toContain("private");
  });
});
