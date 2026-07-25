// Regression pins for the shell's pure decision core (src/shell.ts).
// Every case is a bug that shipped to Akash's phone once; it does not ship twice.
// These run without a DOM — the decision functions take World data and return
// targets, so each iOS lie is encoded as plain inputs.
import { describe, expect, it, vi } from "vitest";
import {
  MIN_KEYBOARD_PX,
  TEARDOWN_MAX_MS,
  computeShell,
  createPickerLifecycle,
  keyboardInset,
  preservesFocus,
  type World,
} from "../src/shell";

function world(over: Partial<World> = {}): World {
  return {
    editorFocused: false,
    fileFocused: false,
    innerHeight: 844, // iPhone-ish logical viewport
    vvHeight: 844,
    vvTop: 0,
    ...over,
  };
}

describe("keyboardInset — the iOS 26 lie filter (webkit bug 297779)", () => {
  it("stale ~24px-short viewport after dismissal reads as NO keyboard (v0.1.11 'chat dips, no keyboard')", () => {
    expect(keyboardInset(844, 820)).toBe(0);
  });

  it("a real keyboard's hundreds-of-px shrink passes through", () => {
    expect(keyboardInset(844, 508)).toBe(336);
  });

  it("threshold boundary: exactly MIN_KEYBOARD_PX counts, one less does not", () => {
    expect(keyboardInset(844, 844 - MIN_KEYBOARD_PX)).toBe(MIN_KEYBOARD_PX);
    expect(keyboardInset(844, 844 - MIN_KEYBOARD_PX + 1)).toBe(0);
  });
});

describe("computeShell — when the shell may trust the visual viewport", () => {
  it("focusin before the keyboard moves (delta 0) stays in pure-CSS mode", () => {
    expect(computeShell(world({ editorFocused: true })).kb).toBe(false);
  });

  it("editor focused + real keyboard tracks the visual viewport (v0.1.10 bug 2)", () => {
    const t = computeShell(world({ editorFocused: true, vvHeight: 508, vvTop: 40 }));
    expect(t).toEqual({ kb: true, vvTop: 40, vvHeight: 508 });
  });

  it("no editor focused: a shrunken viewport is never trusted (stale after blur)", () => {
    expect(computeShell(world({ vvHeight: 508 })).kb).toBe(false);
  });

  it("parked file-input focus is not 'keyboard up' — no shell nudge for the picker", () => {
    expect(computeShell(world({ fileFocused: true, vvHeight: 508 })).kb).toBe(false);
  });
});

describe("preservesFocus — the ＋ pointerdown preventDefault rule", () => {
  it("from idle the tap must NOT preserve focus (v0.1.11 keyboard-swallow)", () => {
    expect(preservesFocus(world())).toBe(false);
  });

  it("keyboard up: preserve, so the menu presents without collapsing it (v0.1.10 bug 6)", () => {
    expect(preservesFocus(world({ editorFocused: true }))).toBe(true);
  });

  it("focus parked on the file input: preserve, so the tap's click survives (alternating-＋ belt)", () => {
    expect(preservesFocus(world({ fileFocused: true }))).toBe(true);
  });
});

describe("picker lifecycle — the WebKit teardown window (taplog-proven 2026-07-24)", () => {
  function lifecycle() {
    const present = vi.fn();
    const dismiss = vi.fn();
    const clock = { t: 0 };
    const p = createPickerLifecycle({ present, dismiss }, () => clock.t);
    return { p, present, dismiss, clock };
  }

  it("a ＋ tap during teardown QUEUES instead of forwarding a click WebKit would drop (the dead-＋-tap bug)", () => {
    const { p, present } = lifecycle();
    p.open();
    p.settle(); // menu dismissed from the screen; native teardown still running
    expect(p.open()).toBe("queued");
    expect(present).toHaveBeenCalledTimes(1); // no click into the void
    expect(p.isTearing()).toBe(true);
  });

  it("the queued tap presents the moment the teardown signal lands (window refocus / cancel)", () => {
    const { p, present } = lifecycle();
    p.open();
    p.settle();
    p.open(); // queued
    expect(p.teardownComplete(true)).toBe("flushed");
    expect(present).toHaveBeenCalledTimes(2);
    expect(p.isOpen()).toBe(true);
  });

  it("tap AFTER the teardown signal presents normally — the working-tap population in the device log", () => {
    const { p, present } = lifecycle();
    p.open();
    p.settle();
    expect(p.teardownComplete(true)).toBe("completed");
    expect(p.open()).toBe("presented");
    expect(present).toHaveBeenCalledTimes(2);
  });

  it("dismiss effects run exactly once under duplicate settle signals", () => {
    const { p, dismiss } = lifecycle();
    p.open();
    p.settle();
    p.settle();
    p.settle();
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("settle/teardownComplete with no session are no-ops (every page tap fires them)", () => {
    const { p, dismiss } = lifecycle();
    p.settle();
    expect(p.teardownComplete(true)).toBe("noop");
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("stale tearing (present was dropped, signal never comes): tap presents immediately past TEARDOWN_MAX_MS — never a bricked ＋", () => {
    const { p, present, clock } = lifecycle();
    p.open();
    p.settle();
    clock.t = TEARDOWN_MAX_MS - 1;
    expect(p.open()).toBe("queued"); // still inside the window
    clock.t = TEARDOWN_MAX_MS;
    expect(p.open()).toBe("presented"); // window over: this tap goes through NOW
    expect(present).toHaveBeenCalledTimes(2);
  });

  it("＋ click while a sheet is supposedly up = that present was dropped; re-present within the same gesture", () => {
    const { p, present, dismiss } = lifecycle();
    p.open();
    expect(p.open()).toBe("represented"); // a real sheet swallows page clicks
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(present).toHaveBeenCalledTimes(2);
    expect(p.isOpen()).toBe(true);
  });

  it("return-to-app drops a stale queued tap (flush=false) — no ghost menu on reopen", () => {
    const { p, present } = lifecycle();
    p.open();
    p.settle();
    p.open(); // queued
    expect(p.teardownComplete(false)).toBe("completed");
    expect(present).toHaveBeenCalledTimes(1);
    p.open(); // the user's NEXT real tap works normally
    expect(present).toHaveBeenCalledTimes(2);
  });
});
