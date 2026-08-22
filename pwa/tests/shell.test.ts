// Regression pins for the shell's pure decision core (src/shell.ts).
// Every case is a bug that shipped to Akash's phone once; it does not ship twice.
// These run without a DOM — the decision functions take World data and return
// targets, so each iOS lie is encoded as plain inputs.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  FOCUSING_MAX_MS,
  HEAL_THRESHOLD_PX,
  MAX_SHOVE_CLEARS,
  MIN_KEYBOARD_PX,
  SETTLE_GUARD_MS,
  TEARDOWN_MAX_MS,
  closeCorrectionNeeded,
  computeShell,
  createPickerLifecycle,
  edgeBoxTop,
  focusingActive,
  healNeeded,
  holdsBarTap,
  keyboardInset,
  preservesFocus,
  shellBox,
  shoveVerdict,
  type World,
} from "../src/shell";

function world(over: Partial<World> = {}): World {
  return {
    editorFocused: false,
    fileFocused: false,
    baseline: 844, // full-screen visual viewport, learned with no keyboard
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

describe("computeShell + shellBox — one rule for iOS 26's keyboard modes (taplogs 2026-07-25/30)", () => {
  it("overlay mode: only the visual viewport shrank — the shell box IS the visual viewport", () => {
    const t = computeShell(world({ editorFocused: true, vvHeight: 508, vvTop: 40 }));
    expect(t.kb).toBe(true);
    expect(shellBox(t)).toEqual({ top: 40, height: 508 });
  });

  it("window-shrink mode: STILL a keyboard (v0.1.16 bug: read as none), and the box equals the pin", () => {
    // innerHeight shrank to match the viewport, so top 0 / height 508 is
    // exactly what the four-edge pin already renders — writing it moves
    // nothing, which is why one rule can serve every mode
    const t = computeShell(world({ editorFocused: true, vvHeight: 508, vvTop: 0 }));
    expect(t.kb).toBe(true);
    expect(shellBox(t)).toEqual({ top: 0, height: 508 });
  });

  it("shrink-AND-pan: top rides the pan, so the header stays on screen (the 2026-07-30 hidden-header session)", () => {
    const t = computeShell(world({ editorFocused: true, vvHeight: 400, vvTop: 362 }));
    expect(t.kb).toBe(true);
    expect(shellBox(t)).toEqual({ top: 362, height: 400 });
  });

  it("baseline decides there is a keyboard — no innerHeight comparison exists to lie mid-animation", () => {
    // the transient innerHeight frame used to flip the old per-mode override
    // off inside 16ms; the box derives from baseline + vv numbers alone
    const t = computeShell(world({ editorFocused: true, vvHeight: 508, baseline: 844 }));
    expect(t.kb).toBe(true);
  });

  it("focusin before the keyboard moves (delta 0): no box — the four-edge pin holds", () => {
    const t = computeShell(world({ editorFocused: true }));
    expect(t.kb).toBe(false);
    expect(shellBox(t)).toBeNull();
  });

  it("no editor focused: a shrunken viewport is never trusted (stale after blur)", () => {
    const t = computeShell(world({ vvHeight: 508 }));
    expect(t.kb).toBe(false);
    expect(shellBox(t)).toBeNull();
  });

  it("parked file-input focus is not 'keyboard up' — no shell resize for the picker", () => {
    expect(computeShell(world({ fileFocused: true, vvHeight: 508 })).kb).toBe(false);
  });
});

// The whole-app yank (device trail 2026-08-21, and the same double box write on
// the build before it): an edge fired on a scrolled window sized its box from a
// vv.offsetTop that the very next event's shove clear was about to take away,
// and the still-open glide rode the whole app from the very top down to that
// value and back. Every number below is off that trail.
describe("edgeBoxTop: the edge's box top, refusing a displacement the window scroll made", () => {
  it("the trail's own edge (sy 412 under vvTop 362): the top stays where it stands", () => {
    expect(edgeBoxTop(362, 412, null)).toBe(0);
  });

  it("an unscrolled window is the fresh number, so shrink-and-pan is untouched", () => {
    expect(edgeBoxTop(362, 0, null)).toBe(362);
    expect(edgeBoxTop(40, 0, 0)).toBe(40); // overlay mode's small pan, likewise
  });

  it("a scroll SMALLER than the pan is refused whole, never subtracted", () => {
    // max(0, vvTop - scrollY) would write 262 here: a number that was never
    // true of anything, and one the shell would then travel to on its way to
    // the honest offsetTop that arrives an event later
    expect(edgeBoxTop(362, 100, null)).toBe(0);
  });

  it("the held top is the one already applied, not a hardcoded zero", () => {
    expect(edgeBoxTop(362, 412, 40)).toBe(40);
  });

  it("any scroll at all is displacement, in either direction", () => {
    expect(edgeBoxTop(362, 1, null)).toBe(0);
    expect(edgeBoxTop(362, -20, null)).toBe(0);
  });

  it("window-shrink mode, nothing scrolled and nothing panned: the ordinary edge", () => {
    expect(edgeBoxTop(0, 0, null)).toBe(0);
  });

  it("through the box: the edge still writes the keyboard's height, only the top is held", () => {
    const t = computeShell(world({ editorFocused: true, vvHeight: 400, vvTop: 362 }));
    expect(shellBox(t)).toEqual({ top: 362, height: 400 }); // as the fresh read has it
    const held = { ...t, vvTop: edgeBoxTop(t.vvTop, 412, null) };
    expect(shellBox(held)).toEqual({ top: 0, height: 400 });
  });
});

describe("closeCorrectionNeeded — the close-only scrollTo(0,0); mid-typing never fights", () => {
  it("clean close: nothing stuck, nothing written", () => {
    expect(closeCorrectionNeeded(0, 0, 0)).toBe(false);
  });

  it("a stuck window scroll is displacement on either axis", () => {
    expect(closeCorrectionNeeded(0, 48, 0)).toBe(true);
    expect(closeCorrectionNeeded(3, 0, 0)).toBe(true);
  });

  it("the iOS 26 regression: offsetTop still nonzero after dismissal (Apple forums 800125)", () => {
    expect(closeCorrectionNeeded(0, 0, 362)).toBe(true);
    expect(closeCorrectionNeeded(0, 0, 44)).toBe(true);
  });

  it("sub-pixel pan residue is measurement noise, not displacement", () => {
    expect(closeCorrectionNeeded(0, 0, 1)).toBe(false);
  });
});

describe("healNeeded — the iOS 17/18 standalone stuck-small-viewport reflow", () => {
  it("innerHeight stuck well short of the learned full-screen baseline -> heal", () => {
    expect(healNeeded(844, 700)).toBe(true);
  });

  it("threshold boundary: more than HEAL_THRESHOLD_PX short heals, exactly it does not", () => {
    expect(healNeeded(844, 844 - HEAL_THRESHOLD_PX - 1)).toBe(true);
    expect(healNeeded(844, 844 - HEAL_THRESHOLD_PX)).toBe(false);
  });

  it("a settled viewport, or a just-reset baseline after rotation, never heals", () => {
    expect(healNeeded(844, 844)).toBe(false);
    expect(healNeeded(0, 844)).toBe(false);
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

describe("shoveVerdict — typing-time shove vs layout truth (typing test 2026-08-18)", () => {
  it("the observed shove: kb steady, height steady, a window scroll in the batch -> clear (362 -> 412 stays unwritten)", () => {
    expect(shoveVerdict(true, true, 0, 50, false, 0)).toBe("clear");
  });

  it("horizontal displacement is a shove too", () => {
    expect(shoveVerdict(true, true, 3, 0, false, 0)).toBe("clear");
  });

  it("a genuine keyboard move (vv.height changed) is tracked even with a scroll in the same batch", () => {
    expect(shoveVerdict(true, true, 0, 50, true, 0)).toBe("track");
  });

  it("no window scroll: a pan is layout truth, tracked as today", () => {
    expect(shoveVerdict(true, true, 0, 0, false, 0)).toBe("track");
  });

  it("the open and close edges never reach the decision — the shell owns them", () => {
    expect(shoveVerdict(false, true, 0, 50, false, 0)).toBe("track");
    expect(shoveVerdict(true, false, 0, 50, false, 0)).toBe("track");
  });

  // The 500ms re-shove window this replaced let a second shove through on
  // purpose while he was still typing the same line, so about every other
  // shove stuck and the error piled up line by line. The budget is per
  // keystroke instead: correct on the same frame every time, and only a phone
  // that re-shoves MAX_SHOVE_CLEARS times inside ONE keystroke is yielded to.
  it("a shove is corrected on its own frame for the whole budget, never seen and undone later", () => {
    for (let spent = 0; spent < MAX_SHOVE_CLEARS; spent += 1) {
      expect(shoveVerdict(true, true, 0, 50, false, spent)).toBe("clear");
    }
  });

  it("past the budget the fight stops: the shove is yielded to, so the two sides cannot loop", () => {
    expect(shoveVerdict(true, true, 0, 50, false, MAX_SHOVE_CLEARS)).toBe("yield");
    expect(shoveVerdict(true, true, 0, 50, false, MAX_SHOVE_CLEARS + 5)).toBe("yield");
  });

  it("a fresh keystroke's budget always clears the first shove, with no delay able to withhold it", () => {
    // the wiring resets the count on every keystroke (keystrokeStarted), so
    // the common one-shove-per-key case never reaches the yield arm
    expect(shoveVerdict(true, true, 0, 50, false, 0)).toBe("clear");
  });
});

// Wiring pins: the clear must keep the shell box stable (tracking the shove
// WAS the visible step), the budget must be spent and re-opened where it says
// it is, the blink must ride every keystroke, and the growth give-up must hand
// back exactly the gained height. Source-read tripwires, downbtn-style.
describe("wiring: same-frame clear, per-keystroke budget, per-keystroke blink", () => {
  const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

  it("a cleared shove writes the scroll, not the box: the stable target reuses the applied numbers", () => {
    expect(shell).toMatch(
      /verdict === "clear"[\s\S]{0,200}window\.scrollTo\(0, 0\);\n\s*target = \{ kb: t\.kb, vvTop: appliedTop, vvHeight: appliedHeight \};/,
    );
    expect(shell).toMatch(/holdDiagRecord\("kb-shove", \{ act: "clear", n: shoveClears/);
    expect(shell).toMatch(/holdDiagRecord\("kb-shove", \{ act: "yield", n: shoveClears/);
  });

  it("the correction is same-frame and the guard is a count, not a clock", () => {
    // no delayed correction anywhere in the shove path: the clear is the
    // scrollTo on the event's own frame, and nothing waits for typing to stop
    expect(shell).toMatch(/verdict === "clear"[\s\S]{0,120}shoveClears \+= 1;/);
    expect(shell).not.toMatch(/RESHOVE_YIELD_MS|lastShoveClearAt|sinceClearMs/);
  });

  it("every keystroke re-opens the budget, and a close resets it, so no state leaks across sessions", () => {
    expect(shell).toMatch(/function keystrokeStarted\(\): void \{\n\s*shoveClears = 0;/);
    expect(shell).toMatch(
      /for \(const type of \["beforeinput", "keydown"\]\)[\s\S]{0,240}keystrokeStarted\(\);/,
    );
    expect(shell).toMatch(/function keyboardClosed[\s\S]{0,200}shoveClears = 0;/);
  });

  it("autosize blinks on EVERY keystroke with the keyboard up, and still on any growth", () => {
    expect(main).toMatch(
      /if \(document\.activeElement === textEl && \(grew \|\| \(typed && kbUp\)\)\) \{\n\s*blinkComposer\(textEl\);/,
    );
    expect(main).toMatch(/const kbUp = app\.classList\.contains\("kb"\);/);
    expect(main).toMatch(/holdDiagRecord\("grow-blink", \{\n\s*why: grew \? "grow" : "key"/);
  });

  it("the keystroke path is the one that marks itself typed", () => {
    expect(main).toMatch(/textEl\.addEventListener\("input", \(\) => \{\n\s*autosize\(true\);/);
  });

  it("a blink cancels the one before it, so fast typing stacks no animations", () => {
    expect(main).toMatch(
      /composerBlink\?\.cancel\(\);\n\s*composerBlink = el\.animate\(\[\{ opacity: 0 \}, \{ opacity: 1 \}\], \{ duration: 20 \}\);/,
    );
  });

  it("a mid-history growth hands the thread's scroll back the exact gained height", () => {
    expect(main).toMatch(
      /decision === "give-up"[\s\S]{0,400}t\.scrollTop = giveUpTarget\(t\.scrollTop, oldHeight, newHeight, t\.scrollHeight - t\.clientHeight\);/,
    );
  });
});

// Wiring pins for the edge's held top. The decision is one line, so what needs
// pinning is where it sits: it must be the EDGE that consults it, off the same
// rounded scroll the shove reads, it must leave the height alone, and above all
// it must add no new write. A fix for a yank that itself scrolled the window at
// the edge was measured and rejected (edgeBoxTop's own note says why), and a
// later hand could add one back without noticing.
describe("wiring: the edge holds its top, and only where the window is scrolled under it", () => {
  const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");

  it("consulted at the edge, off the same rounded scroll and the same applied top", () => {
    expect(shell).toMatch(/const y = Math\.round\(window\.scrollY\);/);
    expect(shell).toMatch(
      /if \(t\.kb && wasUp !== t\.kb\) \{\n\s*target = \{ kb: t\.kb, vvTop: edgeBoxTop\(t\.vvTop, y, appliedTop\), vvHeight: t\.vvHeight \};/,
    );
  });

  it("the height stays the fresh read: an edge that stopped resizing would be no fix at all", () => {
    expect(shell).toMatch(/edgeBoxTop\(t\.vvTop, y, appliedTop\), vvHeight: t\.vvHeight \}/);
    expect(shell).not.toMatch(/edgeBoxTop\([^)]*\), vvHeight: appliedHeight/);
  });

  it("one call site, and shellBox is otherwise untouched", () => {
    expect(shell.match(/edgeBoxTop\(/g)).toHaveLength(2); // the definition and the call
    expect(shell).toMatch(/return t\.kb \? \{ top: t\.vvTop, height: t\.vvHeight \} : null;/);
  });

  it("the verdict still hands both edges to the shell: that line is load-bearing history", () => {
    expect(shell).toMatch(
      /if \(!kbWasUp \|\| !kbStillUp\) return "track"; \/\/ the edges are the shell's own business/,
    );
  });

  it("no new fight: the only scrollTo writes are still the shove clear and the close pass", () => {
    expect(shell.match(/^\s*(if \(snap\) )?window\.scrollTo\(0, 0\);$/gm)).toHaveLength(2);
    expect(shell).toMatch(/if \(snap\) window\.scrollTo\(0, 0\);/);
    expect(shell).toMatch(/verdict === "clear"[\s\S]{0,120}window\.scrollTo\(0, 0\);/);
  });

  it("the close edge cannot reach the rule, so the correction pass runs on its own numbers", () => {
    // t.kb is false at the close, so the target is never rebuilt there and
    // keyboardClosed still sees whatever scroll iOS actually left behind
    expect(shell).toMatch(/if \(wasUp && !t\.kb\) keyboardClosed\(\);/);
    expect(shell).toMatch(/function correctionPass[\s\S]{0,300}const snap = closeCorrectionNeeded\(x, y, top\);/);
  });
});

describe("focusingActive — the tap-time choreography signal (the pop-then-expand fix)", () => {
  it("fires with editor focus, before any vv shrink has been seen", () => {
    expect(focusingActive(true, false, 0)).toBe(true);
    expect(focusingActive(true, false, 10)).toBe(true);
  });

  it("hands over to .kb the moment the keyboard proves itself", () => {
    expect(focusingActive(true, true, 10)).toBe(false);
  });

  it("lapses when no keyboard materializes inside the window (hardware keyboard)", () => {
    expect(focusingActive(true, false, FOCUSING_MAX_MS - 1)).toBe(true);
    expect(focusingActive(true, false, FOCUSING_MAX_MS)).toBe(false);
  });

  it("blur ends it whatever the clock says", () => {
    expect(focusingActive(false, false, 10)).toBe(false);
    expect(focusingActive(false, true, 10)).toBe(false);
  });
});

// Presentation pins for the glide's scoping: the transition lives on .gliding
// ALONE — shell.ts arms it on the .kb edges for a settle window — so keyboard
// open/close glide while every mid-typing box write stays instant. The box
// vars must survive into .gliding without .kb (the close ride home), and the
// focusing class must key the same bar choreography as .kb.
describe("presentation — glide scoped to kb edges, focusing keys the choreography", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");

  it("only .gliding carries the top/height transition, 0.2s ease-out", () => {
    expect(css).toMatch(
      /\n#app\.gliding \{\n  transition: top var\(--glide\), height var\(--glide\);\n\}/,
    );
    expect(css).toMatch(/\n#app \{[^}]*--glide: 0\.2s ease-out;/); // and that token IS the clock
    const kbRule = css.match(/\n#app\.kb \{([^}]*)\}/)?.[1] ?? "";
    expect(kbRule).toContain("--pad-b: 0.5rem"); // the keyboard hug is untouched
    expect(kbRule).not.toContain("transition"); // .kb alone never animates the box
    expect(kbRule).not.toContain("top:"); // the box moved to the shared rule below
    const appRule = css.match(/\n#app \{([^}]*)\}/)?.[1] ?? "";
    expect(appRule).not.toContain("transition"); // the rest pin stays inert
  });

  it("the box vars apply under .kb and stay through .gliding for the close ride home", () => {
    expect(css).toMatch(
      /#app\.kb,\n#app\.gliding \{\n  top: var\(--shell-top, 0px\);\n  height: var\(--shell-h, 100vh\);\n\}/,
    );
  });

  it("shell.ts arms the glide on the .kb edge alone and lets the window expire by clock", () => {
    expect(shell).toMatch(/if \(t\.kb !== appliedKb\) \{[\s\S]{0,80}armGlide\(t\.kb \? "open" : "close"\)/);
    expect(shell).toMatch(/GLIDE_SETTLE_MS \+ 20/); // the expiry reconverges via reconcile
  });

  it("an open from the pin seeds a numeric FROM box — `auto` interpolates with nothing", () => {
    expect(shell).toMatch(
      /gliding && appliedTop === null && appliedHeight === null[\s\S]{0,700}void appEl\.offsetHeight;/,
    );
  });

  it("the focusing class keys the same bar choreography as .kb", () => {
    expect(css).toMatch(/#app\.kb \.compose textarea,\n#app\.focusing \.compose textarea \{/);
    expect(css).toMatch(/#app\.kb \.compose \.attach,\n#app\.focusing \.compose \.attach \{/);
  });
});

// The bar's bottom gap and the shell's bottom edge are ONE move. A close
// recorded frame by frame on device caught them apart: --pad-b stepped 8.5px
// to 34px while the shell height was still 400px, so the pill hopped 25.5px
// up in a single frame and only then rode the glide home. These pins say the
// gap can no longer be given its own clock or its own trigger, and that EVERY
// reader of --pad-b rides with it, since one left stepping just moves the hop
// to another element.
describe("presentation — the home-indicator gap rides the shell's own clock", () => {
  // comments carry the prose about durations, so strip them: a pin must never
  // be satisfied by an explanation of the thing it is checking for
  const bare = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  // innermost brace pairs, which for this sheet is every plain rule (the two
  // at-rules that wrap anything hold ordinary rules inside them)
  const rules = [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    sel: m[1].trim().replace(/\s*\n\s*/g, "\n"),
    body: m[2],
  }));
  const selectors = (sel: string): string[] => sel.split(",").map((s) => s.trim());
  const glideRules = rules.filter((r) =>
    selectors(r.sel).every((s) => s.startsWith("#app.gliding")),
  );
  const transitionOf = (body: string): string => body.match(/transition:([^;]*);/)?.[1] ?? "";

  it("one clock, written once: every glided property spells the same token", () => {
    expect(glideRules.length).toBeGreaterThan(1); // the box alone is not enough
    for (const r of glideRules) {
      const entries = transitionOf(r.body).split(",").map((e) => e.trim());
      expect(entries.length).toBeGreaterThan(0);
      // "<property> var(--glide)" and nothing else: a literal duration here
      // would be a second clock, free to drift from the shell's on any edit
      for (const entry of entries) expect(entry).toMatch(/^[a-z-]+ var\(--glide\)$/);
    }
  });

  it("every --pad-b reader glides: the bar, the chevron's seat, the picker anchor", () => {
    const consumers = rules.filter((r) => r.body.includes("var(--pad-b)")).map((r) => r.sel);
    expect(consumers).toContain(".compose"); // the pill and the ＋
    expect(consumers).toContain(".jump"); // on screen exactly when the thread is scrolled away
    expect(consumers).toContain(".filepick"); // invisible, but the rect iOS anchors the sheet to
    const glided = new Set(glideRules.flatMap((r) => selectors(r.sel)));
    for (const sel of consumers) expect([...glided]).toContain(`#app.gliding ${sel}`);
  });

  it("the gap is gated on the shell's own class — nothing animates it elsewhere", () => {
    for (const r of rules) {
      if (selectors(r.sel).every((s) => s.startsWith("#app.gliding"))) continue;
      const decl = transitionOf(r.body);
      expect(decl).not.toContain("padding-bottom");
      expect(decl).not.toMatch(/(^|,)\s*bottom\s/);
    }
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
