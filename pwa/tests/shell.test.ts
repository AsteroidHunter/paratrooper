// Regression pins for the shell's pure decision core (src/shell.ts).
// Every case is a bug that shipped to Akash's phone once; it does not ship twice.
// These run without a DOM — the decision functions take World data and return
// targets, so each iOS lie is encoded as plain inputs.
import { describe, expect, it, vi } from "vitest";
import {
  MIN_KEYBOARD_PX,
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

describe("picker lifecycle — settle races, runs once, never trusts one event", () => {
  function lifecycle() {
    const present = vi.fn();
    const dismiss = vi.fn();
    return { p: createPickerLifecycle({ present, dismiss }), present, dismiss };
  }

  it("iOS 26 drops `cancel` on menu dismissal: any other signal settles instead (the alternating-＋ bug)", () => {
    const { p, dismiss } = lifecycle();
    p.open();
    // no cancel ever arrives; the window-refocus racer fires
    p.settle();
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(p.isOpen()).toBe(false);
  });

  it("settle runs exactly once under duplicate signals (cancel AND refocus AND next tap)", () => {
    const { p, dismiss } = lifecycle();
    p.open();
    p.settle();
    p.settle();
    p.settle();
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("settle before any open is a no-op (page taps while no session)", () => {
    const { p, dismiss } = lifecycle();
    p.settle();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("reopening after settle presents again — tap 3 must work", () => {
    const { p, present } = lifecycle();
    p.open();
    p.settle();
    p.open();
    expect(present).toHaveBeenCalledTimes(2);
    expect(p.isOpen()).toBe(true);
  });

  it("open over a stale un-settled session settles it first, then presents", () => {
    const { p, present, dismiss } = lifecycle();
    p.open();
    p.open(); // no completion signal ever arrived for the first
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(present).toHaveBeenCalledTimes(2);
    expect(p.isOpen()).toBe(true);
  });
});
