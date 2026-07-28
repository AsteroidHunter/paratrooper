// Regression pins for the shell's pure decision core (src/shell.ts).
// Every case is a bug that shipped to Akash's phone once; it does not ship twice.
// These run without a DOM — the decision functions take World data and return
// targets, so each iOS lie is encoded as plain inputs.
import { describe, expect, it, vi } from "vitest";
import {
  MIN_KEYBOARD_PX,
  SETTLE_GUARD_MS,
  TEARDOWN_MAX_MS,
  computeShell,
  createPickerLifecycle,
  holdsBarTap,
  keyboardInset,
  preservesFocus,
  type World,
} from "../src/shell";

function world(over: Partial<World> = {}): World {
  return {
    editorFocused: false,
    fileFocused: false,
    baseline: 844, // full-screen visual viewport, learned with no keyboard
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

describe("computeShell — iOS 26's two keyboard modes (taplog-proven 2026-07-25)", () => {
  it("overlay mode: layout viewport stayed tall, so track the visual viewport", () => {
    const t = computeShell(world({ editorFocused: true, vvHeight: 508, vvTop: 40 }));
    expect(t).toEqual({ kb: true, trackViewport: true, vvTop: 40, vvHeight: 508 });
  });

  it("window-shrink mode: innerHeight shrank too — STILL a keyboard (v0.1.16 bug: read as none)", () => {
    const t = computeShell(world({ editorFocused: true, innerHeight: 508, vvHeight: 508 }));
    expect(t.kb).toBe(true);
  });

  it("window-shrink mode does NOT override the four-edge pin — writing top/height moved the shell off-screen", () => {
    const t = computeShell(world({ editorFocused: true, innerHeight: 508, vvHeight: 508, vvTop: 336 }));
    expect(t.trackViewport).toBe(false);
  });

  it("baseline, not innerHeight, decides there is a keyboard — innerHeight lies mid-animation", () => {
    // the transient frame that used to flip the shell off inside 16ms
    const t = computeShell(world({ editorFocused: true, innerHeight: 508, vvHeight: 508, baseline: 844 }));
    expect(t.kb).toBe(true);
  });

  it("focusin before the keyboard moves (delta 0) stays in pure-CSS mode", () => {
    expect(computeShell(world({ editorFocused: true })).kb).toBe(false);
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

describe("picker lifecycle — the WebKit teardown window", () => {
  function lifecycle() {
    const present = vi.fn();
    const dismiss = vi.fn();
    const clock = { t: 0 };
    const p = createPickerLifecycle({ present, dismiss }, () => clock.t);
    const past = (ms = SETTLE_GUARD_MS) => (clock.t += ms);
    return { p, present, dismiss, clock, past };
  }

  it("a tap from idle presents on the EXISTING input — the 16/16 working population", () => {
    const { p, present } = lifecycle();
    expect(p.open()).toBe("presented");
    expect(present).toHaveBeenCalledWith(false);
  });

  it("a ＋ tap during teardown presents on a FRESH input, inside its own gesture (v0.1.16 queued 0/7)", () => {
    const { p, present, past } = lifecycle();
    p.open();
    past();
    p.settle(); // menu dismissed from the screen; native teardown still running
    expect(p.open()).toBe("refreshed");
    expect(present).toHaveBeenLastCalledWith(true);
    expect(p.isOpen()).toBe(true);
  });

  it("the previous session's trailing refocus does NOT tear down the fresh present (the v0.1.16 killer)", () => {
    const { p, dismiss, past, clock } = lifecycle();
    p.open();
    past();
    p.settle();
    p.open(); // refreshed
    dismiss.mockClear();
    clock.t += 3; // the old teardown's window-refocus, 3ms later
    expect(p.settle()).toBe("guarded");
    expect(dismiss).not.toHaveBeenCalled();
    expect(p.isOpen()).toBe(true);
  });

  it("a real dismissal (past the guard) settles normally", () => {
    const { p, dismiss, past } = lifecycle();
    p.open();
    past();
    expect(p.settle()).toBe("settled");
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(p.isTearing()).toBe(true);
  });

  it("tap AFTER teardown completes presents normally on the existing input", () => {
    const { p, present, past } = lifecycle();
    p.open();
    past();
    p.settle();
    expect(p.teardownComplete()).toBe("completed");
    expect(p.open()).toBe("presented");
    expect(present).toHaveBeenLastCalledWith(false);
  });

  it("dismiss effects run exactly once under duplicate settle signals", () => {
    const { p, dismiss, past } = lifecycle();
    p.open();
    past();
    p.settle();
    p.settle();
    p.settle();
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("settle/teardownComplete with no session are no-ops (every page tap fires them)", () => {
    const { p, dismiss } = lifecycle();
    expect(p.settle()).toBe("noop");
    expect(p.teardownComplete()).toBe("noop");
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("stale tearing (present was dropped, signal never comes): past TEARDOWN_MAX_MS a tap presents clean — never a bricked ＋", () => {
    const { p, present, clock, past } = lifecycle();
    p.open();
    past();
    p.settle();
    clock.t += TEARDOWN_MAX_MS - 1;
    expect(p.open()).toBe("refreshed"); // still inside the window
    past();
    p.settle();
    clock.t += TEARDOWN_MAX_MS;
    expect(p.open()).toBe("presented"); // window over: nothing was tearing down
    expect(present).toHaveBeenLastCalledWith(false);
  });

  it("＋ click while a sheet is supposedly up = that present was dropped; re-present within the same gesture", () => {
    const { p, present, dismiss } = lifecycle();
    p.open();
    expect(p.open()).toBe("represented"); // a real sheet swallows page clicks
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(present).toHaveBeenLastCalledWith(true);
    expect(p.isOpen()).toBe(true);
  });

  it("returning to the app with nothing open cannot ghost-present", () => {
    const { p, present, past } = lifecycle();
    p.open();
    past();
    p.settle();
    p.teardownComplete();
    p.teardownComplete();
    expect(present).toHaveBeenCalledTimes(1);
  });

  describe("expireTearing — the settling window's timer backstop", () => {
    it("a settled window past the cap expires — a dropped present sends no signal, ever", () => {
      const { p, past, clock } = lifecycle();
      p.open();
      past();
      p.settle();
      clock.t += TEARDOWN_MAX_MS;
      expect(p.expireTearing()).toBe("expired");
      expect(p.isTearing()).toBe(false);
    });

    it("never expires early — real teardowns end by signal, not by clock", () => {
      const { p, past, clock } = lifecycle();
      p.open();
      past();
      p.settle();
      clock.t += TEARDOWN_MAX_MS - 1;
      expect(p.expireTearing()).toBe("noop");
      expect(p.isTearing()).toBe(true);
    });

    it("a stale timer after the signals already ended the window is a no-op", () => {
      const { p, past, clock } = lifecycle();
      p.open();
      past();
      p.settle();
      p.teardownComplete();
      clock.t += TEARDOWN_MAX_MS;
      expect(p.expireTearing()).toBe("noop");
    });

    it("a timer firing while a sheet is up (armed by the represented-recovery) is a no-op", () => {
      const { p, clock } = lifecycle();
      p.open();
      clock.t += TEARDOWN_MAX_MS + 1;
      expect(p.expireTearing()).toBe("noop");
      expect(p.isOpen()).toBe(true);
    });

    it("after expiry a ＋ tap presents clean on the existing input — never a bricked ＋", () => {
      const { p, present, past, clock } = lifecycle();
      p.open();
      past();
      p.settle();
      clock.t += TEARDOWN_MAX_MS;
      p.expireTearing();
      expect(p.open()).toBe("presented");
      expect(present).toHaveBeenLastCalledWith(false);
    });
  });
});

describe("holdsBarTap — the settling-window tap hold (the eaten ＋ tap and the keyboard flicker)", () => {
  it("holds an editor tap while tearing — a keyboard raised here dies mid-rise", () => {
    expect(holdsBarTap(true, true, false)).toBe(true);
  });
  it("holds a ＋ tap while tearing — its click is the one WebKit silently drops", () => {
    expect(holdsBarTap(true, false, true)).toBe(true);
  });
  it("holds nothing outside the window — idle taps must stay fully native", () => {
    expect(holdsBarTap(false, true, false)).toBe(false);
    expect(holdsBarTap(false, false, true)).toBe(false);
  });
  it("never holds the rest of the page — send and thread taps ride through the window", () => {
    expect(holdsBarTap(true, false, false)).toBe(false);
  });
});
