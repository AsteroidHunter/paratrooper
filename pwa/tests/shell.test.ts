// Regression pins for the shell's pure decision core (src/shell.ts).
// Every case is a bug that shipped to Akash's phone once; it does not ship twice.
// These run without a DOM — the decision functions take World data and return
// targets, so each iOS lie is encoded as plain inputs.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { holdDiagEvents, holdDiagReset } from "../src/hold";
import {
  DISMISS_DOWNNESS,
  DISMISS_TRAVEL_REM,
  EARLY_LIFT_MAX_MS,
  FOCUSING_MAX_MS,
  HEAL_THRESHOLD_PX,
  INSET_KEY,
  KB_ANIM_MS,
  LIFT_SETTLE_MS,
  MAX_SHOVE_CLEARS,
  MIN_KEYBOARD_PX,
  OWNED_FOCUS,
  SETTLE_GUARD_MS,
  TEARDOWN_MAX_MS,
  closeCorrectionNeeded,
  composerTapVerdict,
  computeShell,
  createDismissSwipe,
  createPickerLifecycle,
  earlyLiftActive,
  edgeBoxTop,
  focusComposerTap,
  focusingActive,
  healNeeded,
  holdsBarTap,
  keyboardInset,
  liftAim,
  liftInset,
  plusClickVerdict,
  preservesFocus,
  recallInset,
  shellBox,
  shoveVerdict,
  storeInset,
  type SwipeTouch,
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
  const BASE = 844;

  it("overlay mode: only the visual viewport shrank — the box is the full screen, top from the pan", () => {
    const t = computeShell(world({ editorFocused: true, vvHeight: 508, vvTop: 40 }));
    expect(t.kb).toBe(true);
    expect(shellBox(t, BASE, false)).toEqual({ top: 40, height: 844 });
  });

  it("window-shrink mode: STILL a keyboard (v0.1.16 bug: read as none), and the box is NOT the pin", () => {
    // innerHeight shrank to match the viewport, so the four-edge pin would
    // render 508 tall and carry the lifted compose bar 336px above the
    // keyboard; the explicit baseline height keeps the shell full-size under
    // it, which is the reason the box is written at all in this mode
    const t = computeShell(world({ editorFocused: true, vvHeight: 508, vvTop: 0 }));
    expect(t.kb).toBe(true);
    expect(shellBox(t, BASE, false)).toEqual({ top: 0, height: 844 });
  });

  it("shrink-AND-pan: top rides the pan, so the header stays on screen (the 2026-07-30 hidden-header session)", () => {
    const t = computeShell(world({ editorFocused: true, vvHeight: 400, vvTop: 362 }));
    expect(t.kb).toBe(true);
    expect(shellBox(t, BASE, false)).toEqual({ top: 362, height: 844 });
  });

  it("the height is the baseline in every mode: no keyboard can change the thread's box", () => {
    for (const vvHeight of [508, 400, 458]) {
      const t = computeShell(world({ editorFocused: true, vvHeight }));
      expect(shellBox(t, BASE, false)?.height).toBe(844);
    }
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
    expect(shellBox(t, BASE, false)).toBeNull();
  });

  it("no editor focused: a shrunken viewport is never trusted (stale after blur)", () => {
    const t = computeShell(world({ vvHeight: 508 }));
    expect(t.kb).toBe(false);
    expect(shellBox(t, BASE, false)).toBeNull();
  });

  it("through the close's settle window the box stands at the same height, top still from the viewport", () => {
    // the pin has no height to hand the close to, and in shrink-and-pan the
    // top must stand until iOS un-pans; the moment the window ends the box goes
    const closing = computeShell(world({ editorFocused: false, vvHeight: 400, vvTop: 362 }));
    expect(closing.kb).toBe(false);
    expect(shellBox(closing, BASE, true)).toEqual({ top: 362, height: 844 });
    const unpanned = computeShell(world({ editorFocused: false, vvHeight: 844, vvTop: 0 }));
    expect(shellBox(unpanned, BASE, true)).toEqual({ top: 0, height: 844 });
    expect(shellBox(unpanned, BASE, false)).toBeNull();
  });

  it("parked file-input focus is not 'keyboard up' — no shell resize for the picker", () => {
    expect(computeShell(world({ fileFocused: true, vvHeight: 508 })).kb).toBe(false);
  });
});

// The white band and the snap that follows it, and the abrupt cut that was its
// twin (a recording of thirty-four closes read frame by frame against the
// trail, 2026-09-01/02). Every version of the box-resize design — the glide,
// the hold, the step, the overhang correction — changed the thread's box at
// the keyboard edge, which moved the end of its scroll range and made the page
// rewrite an offset the phone was not taking writes for while the keyboard
// animated. So the box no longer changes at an edge at all, and the inset
// below is the ONE number the shell writes for the keyboard: the lift's driver.
describe("liftInset — the one number the shell writes for the keyboard", () => {
  it("the keyboard's inset, while the keyboard is provably up", () => {
    expect(liftInset(computeShell(world({ editorFocused: true, vvHeight: 458 })), 844)).toBe(386);
    expect(liftInset(computeShell(world({ editorFocused: true, vvHeight: 400 })), 844)).toBe(444);
  });

  it("0 the moment focus leaves, before the viewport has said a word: the close starts there", () => {
    // the trail's every close: the editor loses focus 6 to 13ms before the
    // viewport reports the full screen, and the lift goes home on the focus
    expect(liftInset(computeShell(world({ editorFocused: false, vvHeight: 458 })), 844)).toBe(0);
  });

  it("the iOS 26 stale-viewport lie is not an inset, so it lifts nothing", () => {
    expect(liftInset(computeShell(world({ editorFocused: true, vvHeight: 820 })), 844)).toBe(0);
  });

  it("the threshold is the keyboard filter's own", () => {
    const at = (vvHeight: number): number =>
      liftInset(computeShell(world({ editorFocused: true, vvHeight })), 844);
    expect(at(844 - MIN_KEYBOARD_PX)).toBe(MIN_KEYBOARD_PX);
    expect(at(844 - MIN_KEYBOARD_PX + 1)).toBe(0);
  });

  it("the parked file input lifts nothing: the picker's sheet is not a keyboard", () => {
    expect(liftInset(computeShell(world({ fileFocused: true, vvHeight: 458 })), 844)).toBe(0);
  });
});

describe("the keyboard's clock", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const anim = css.match(/--kb-anim: ([\d.]+)s cubic-bezier\(([^)]*)\);/);
  const points = (): number[] => anim![2].split(",").map((n) => Number(n.trim()));

  it("is the keyboard's measured 220ms, and the settle window outlasts it", () => {
    expect(KB_ANIM_MS).toBe(220);
    expect(LIFT_SETTLE_MS).toBeGreaterThan(KB_ANIM_MS);
    expect(LIFT_SETTLE_MS).toBe(KB_ANIM_MS + 200);
  });

  it("styles.css plays the same duration on the measured curve: the two copies are held together here", () => {
    expect(anim).not.toBeNull();
    expect(Number(anim![1]) * 1000).toBe(KB_ANIM_MS);
    // the fit to the keyboard's own frames (the token's comment carries the derivation)
    expect(points()).toEqual([0.45, 0, 0.55, 1]);
  });

  it("the curve leaves rest and lands at rest, and never overshoots", () => {
    const [x1, y1, x2, y2] = points();
    // a cubic bezier's initial slope is y1/x1 and its final slope (1-y2)/(1-x2):
    // zero velocity at both ends means y1 = 0 and y2 = 1, the S the keyboard
    // was measured to be. The retired curve had y1 = 0.7: a start at full
    // speed, which is the lurch the recording showed.
    expect(y1).toBe(0);
    expect(y2).toBe(1);
    // control x's inside the unit box: progress is monotonic and bounded
    for (const x of [x1, x2]) {
      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThan(1);
    }
  });

  it("the early start's bound is two of the keyboard's own animations, inside the focusing window", () => {
    expect(EARLY_LIFT_MAX_MS).toBe(2 * KB_ANIM_MS);
    expect(EARLY_LIFT_MAX_MS).toBeLessThan(FOCUSING_MAX_MS);
  });
});

// The early start (shell.ts liftAim). The property that matters is the
// sequence: the lift leaves with the focus, the report either agrees (nothing
// written) or retargets (one write), a focus the keyboard never answers goes
// home at the bound, and the close is the close it always was. The stand-in
// is the aim plus the two edges applyShell keeps (the up edge that arms the
// window, the inset write that moves the transition); the wiring pins further
// down hold it to the source it mirrors.
describe("the early start: the lift leaves with the focus tap, aimed at the height the keyboard last reported", () => {
  const UP = 458; // the keyboard the phone reports: 844 - 458 = 386 of inset
  const REMEMBERED = 386;

  function aimer(remembered: number) {
    let appliedUp = false;
    let appliedInset = 0;
    const arms: string[] = []; // every up/down edge, as armLift would be told it
    const insets: number[] = []; // every --kb-inset write, in order
    return {
      arms,
      insets,
      read(w: World, sinceFocusMs: number) {
        const t = computeShell(w);
        const aim = liftAim(t, w.baseline, w.editorFocused, sinceFocusMs, remembered);
        if (aim.up !== appliedUp) {
          appliedUp = aim.up;
          arms.push(aim.up ? (aim.early ? "open-early" : "open") : "close");
        }
        if (aim.inset !== appliedInset) {
          appliedInset = aim.inset;
          insets.push(aim.inset);
        }
        return aim;
      },
    };
  }

  it("the rule: a remembered inset, an editor focused, no keyboard proven yet, inside the bound", () => {
    expect(earlyLiftActive(true, false, 0, REMEMBERED)).toBe(true);
    expect(earlyLiftActive(true, false, EARLY_LIFT_MAX_MS - 1, REMEMBERED)).toBe(true);
    expect(earlyLiftActive(true, false, EARLY_LIFT_MAX_MS, REMEMBERED)).toBe(false); // lapsed
    expect(earlyLiftActive(true, true, 0, REMEMBERED)).toBe(false); // the keyboard is proven: the report aims
    expect(earlyLiftActive(false, false, 0, REMEMBERED)).toBe(false); // nothing focused
    expect(earlyLiftActive(true, false, 0, 0)).toBe(false); // nothing remembered: wait for the report
  });

  it("focus with a remembered inset arms the lift at once, at the remembered height", () => {
    const s = aimer(REMEMBERED);
    const aim = s.read(world({ editorFocused: true }), 0); // the tap: the viewport is still whole
    expect(aim).toEqual({ up: true, early: true, inset: REMEMBERED });
    expect(s.arms).toEqual(["open-early"]);
    expect(s.insets).toEqual([REMEMBERED]);
  });

  it("a report that agrees writes nothing: the running transition simply lands", () => {
    const s = aimer(REMEMBERED);
    s.read(world({ editorFocused: true }), 0);
    const aim = s.read(world({ editorFocused: true, vvHeight: UP }), 80); // the phone's report
    expect(aim).toEqual({ up: true, early: false, inset: REMEMBERED });
    expect(s.arms).toEqual(["open-early"]); // one run: the report is not a second edge
    expect(s.insets).toEqual([REMEMBERED]); // no second write, so no retarget
  });

  it("a report that differs retargets: one more inset write, still the same run", () => {
    const s = aimer(REMEMBERED);
    s.read(world({ editorFocused: true }), 0);
    s.read(world({ editorFocused: true, vvHeight: 400 }), 80); // a taller keyboard than last time
    expect(s.arms).toEqual(["open-early"]);
    expect(s.insets).toEqual([REMEMBERED, 444]);
  });

  it("with nothing remembered the open waits for the report, exactly as before", () => {
    const s = aimer(0);
    expect(s.read(world({ editorFocused: true }), 0)).toEqual({ up: false, early: false, inset: 0 });
    expect(s.arms).toEqual([]);
    expect(s.insets).toEqual([]);
    s.read(world({ editorFocused: true, vvHeight: UP }), 80);
    expect(s.arms).toEqual(["open"]);
    expect(s.insets).toEqual([386]);
  });

  it("a focus the keyboard never answers goes home at the bound", () => {
    const s = aimer(REMEMBERED);
    s.read(world({ editorFocused: true }), 0);
    s.read(world({ editorFocused: true }), EARLY_LIFT_MAX_MS - 1); // still waiting, still up
    expect(s.arms).toEqual(["open-early"]);
    const aim = s.read(world({ editorFocused: true }), EARLY_LIFT_MAX_MS); // the lapse clock
    expect(aim).toEqual({ up: false, early: false, inset: 0 });
    expect(s.arms).toEqual(["open-early", "close"]);
    expect(s.insets).toEqual([REMEMBERED, 0]);
  });

  it("focus while the keyboard is already up takes the viewport's number, never the memory", () => {
    const s = aimer(REMEMBERED);
    const aim = s.read(world({ editorFocused: true, vvHeight: 400 }), 0);
    expect(aim).toEqual({ up: true, early: false, inset: 444 });
    expect(s.arms).toEqual(["open"]);
  });

  it("the close path is unchanged: the focus loss sends the lift home under a stale viewport", () => {
    const s = aimer(REMEMBERED);
    s.read(world({ editorFocused: true }), 0);
    s.read(world({ editorFocused: true, vvHeight: UP }), 80);
    const aim = s.read(world({ editorFocused: false, vvHeight: UP }), 5000); // the focus edge, 6-13ms ahead of the viewport
    expect(aim).toEqual({ up: false, early: false, inset: 0 });
    expect(s.arms).toEqual(["open-early", "close"]);
    expect(s.insets).toEqual([REMEMBERED, 0]);
    s.read(world({ editorFocused: false }), 5100); // the viewport catches up: nothing more
    expect(s.insets).toEqual([REMEMBERED, 0]);
  });

  it("a viewport-learned close is the same: the keyboard gone under a held focus is a close, not an early open", () => {
    const s = aimer(REMEMBERED);
    s.read(world({ editorFocused: true }), 0);
    s.read(world({ editorFocused: true, vvHeight: UP }), 80);
    // the picker's sheet takes the keyboard while the editor keeps focus, long
    // after the tap: outside the bound, so nothing is aimed early
    const aim = s.read(world({ editorFocused: true }), 5000);
    expect(aim).toEqual({ up: false, early: false, inset: 0 });
    expect(s.arms).toEqual(["open-early", "close"]);
  });

  describe("the remembered inset survives a relaunch, for the width it was measured on", () => {
    it("round-trips through its storage form", () => {
      expect(recallInset(storeInset(390, 386), 390)).toBe(386);
    });

    it("another width recalls nothing: a rotation has its own keyboard height", () => {
      expect(recallInset(storeInset(390, 386), 844)).toBe(0);
    });

    it("nothing stored, garbage, or a non-keyboard's worth all recall nothing", () => {
      expect(recallInset(null, 390)).toBe(0);
      expect(recallInset("", 390)).toBe(0);
      expect(recallInset("{not json", 390)).toBe(0);
      expect(recallInset(JSON.stringify({ w: 390, inset: "386" }), 390)).toBe(0);
      expect(recallInset(JSON.stringify({ w: 390 }), 390)).toBe(0);
      expect(recallInset(storeInset(390, MIN_KEYBOARD_PX - 1), 390)).toBe(0);
      expect(recallInset(storeInset(390, MIN_KEYBOARD_PX), 390)).toBe(MIN_KEYBOARD_PX);
    });

    it("the key is one string, namespaced like the app's other storage", () => {
      expect(INSET_KEY).toBe("paratrooper:kb-inset");
    });
  });
});

// The rule played through a whole open and close, because the property that
// matters is the sequence: ONE box write per keyboard session, at the open, at
// the full-screen height; NONE at the close; the drop to the pin when the
// window ends, on a box that is already the pin's geometry. The stand-in below
// is applyShell's box branch and nothing else — the wiring pins further down
// hold it to the source it mirrors.
describe("the box's writes: one at the open, none at the close, the pin at the end", () => {
  const UP = 458;

  function shellWriter() {
    let top: number | null = null;
    let height: number | null = null;
    const writes: (readonly [number | null, number | null])[] = [];
    const insets: number[] = []; // every --kb-inset write, in order
    let appliedInset = 0;
    return {
      writes,
      insets,
      box: () => [top, height] as const,
      /** one viewport reading, exactly as reconcile hands it to applyShell */
      read(w: World, lifting = true): void {
        const t = computeShell(w);
        const inset = liftInset(t, w.baseline);
        if (inset !== appliedInset) {
          appliedInset = inset;
          insets.push(inset);
        }
        const box = shellBox(t, w.baseline, lifting);
        if (box) {
          if (Math.round(box.top) !== top || Math.round(box.height) !== height) {
            top = Math.round(box.top);
            height = Math.round(box.height);
            writes.push([top, height]);
          }
        } else if (top !== null || height !== null) {
          top = null;
          height = null;
          writes.push([null, null]); // the vars go, the four-edge pin takes over
        }
      },
    };
  }

  const raised = (): ReturnType<typeof shellWriter> => {
    const s = shellWriter();
    s.read(world({ editorFocused: true, vvHeight: UP }));
    return s;
  };

  it("the open writes the box once, at the full screen, and arms the lift with the inset", () => {
    const s = raised();
    expect(s.writes).toEqual([[0, 844]]);
    expect(s.insets).toEqual([386]);
  });

  it("focus leaves under a stale viewport: the lift goes home, the box is untouched", () => {
    const s = raised();
    s.read(world({ editorFocused: false, vvHeight: UP })); // the focus edge, 6-13ms ahead of the viewport
    expect(s.insets).toEqual([386, 0]); // the close's transition starts here
    expect(s.writes).toEqual([[0, 844]]); // still only the open's write
    expect(s.box()).toEqual([0, 844]);
  });

  it("the viewport catching up writes nothing either: the box was already the full screen", () => {
    const s = raised();
    s.read(world({ editorFocused: false, vvHeight: UP }));
    s.read(world({ editorFocused: false, vvHeight: 844 }));
    s.read(world({ editorFocused: false, vvHeight: 844 })); // a scroll event on the same numbers
    expect(s.writes).toEqual([[0, 844]]);
  });

  it("a viewport-learned close is the same: no write, whichever input taught it", () => {
    for (const close of [
      [world({ editorFocused: false, vvHeight: UP }), world({ editorFocused: false, vvHeight: 844 })],
      [world({ editorFocused: true, vvHeight: 844 }), world({ editorFocused: false, vvHeight: 844 })],
      [world({ editorFocused: false, vvHeight: 844 })],
    ]) {
      const s = raised();
      for (const w of close) s.read(w);
      expect(s.writes).toEqual([[0, 844]]);
      expect(s.insets.at(-1)).toBe(0);
    }
  });

  it("the window's end drops the box, and the drop moves nothing: it was the pin's geometry all along", () => {
    const s = raised();
    s.read(world({ editorFocused: false, vvHeight: 844 }));
    expect(s.box()).toEqual([0, 844]); // the pin's geometry, written at the open
    s.read(world({ editorFocused: false, vvHeight: 844 }), false); // the window expired
    expect(s.writes).toEqual([
      [0, 844],
      [null, null],
    ]);
    expect(s.box()).toEqual([null, null]);
  });

  it("shrink-and-pan: the top follows the viewport through the close, and un-pans before the drop", () => {
    const s = shellWriter();
    s.read(world({ editorFocused: true, vvHeight: 400, vvTop: 362 }));
    expect(s.writes).toEqual([[362, 844]]);
    s.read(world({ editorFocused: false, vvHeight: 400, vvTop: 362 })); // the focus edge, still panned
    expect(s.writes).toHaveLength(1);
    s.read(world({ editorFocused: false, vvHeight: 844, vvTop: 0 })); // iOS un-pans, inside the window
    expect(s.writes).toEqual([
      [362, 844],
      [0, 844],
    ]);
    s.read(world({ editorFocused: false, vvHeight: 844, vvTop: 0 }), false);
    expect(s.box()).toEqual([null, null]);
  });

  it("a keyboard that changes height mid-session re-aims the lift and leaves the box alone", () => {
    const s = raised();
    s.read(world({ editorFocused: true, vvHeight: 400 })); // an accessory bar came up
    expect(s.insets).toEqual([386, 444]);
    expect(s.writes).toEqual([[0, 844]]);
  });
});

// Wiring pins for the lift. What needs holding down is that the shell writes
// ONE number for the keyboard and never a box height off the viewport, that the
// transition is armed by the same style recalculation that reads it, that the
// bar's own choreography still turns at the focus edge, and that the landing
// (the transform's own transitionend, with the clock as a backstop) is what
// closes the window and hands main.ts the padding — never the edge.
describe("wiring: the lift is the keyboard's one write, and the landing is its one clock", () => {
  const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
  const apply = shell.match(/function applyShell\([\s\S]*?\n\}/)?.[0] ?? "";

  it("the box is read from the baseline and the window, never from the viewport's height", () => {
    expect(apply).toContain("const box = shellBox(t, baseline, lifting);");
    expect(shell).toMatch(/return t\.kb \|\| lifting \? \{ top: t\.vvTop, height: baseline \} : null;/);
    expect(apply).not.toMatch(/height: t\.vvHeight|vvHeight\}px|restH/);
  });

  it("the inset is written in the same pass as the classes, and only when it changed", () => {
    expect(apply).toContain(
      "const { up, early, inset } = liftAim(t, baseline, editorFocused, sinceFocus, rememberedInset);",
    );
    expect(apply).toMatch(
      /if \(inset !== appliedInset\) \{\n\s*appliedInset = inset;\n\s*appEl\.style\.setProperty\("--kb-inset", `\$\{inset\}px`\);/,
    );
    expect(shell.match(/setProperty\("--kb-inset"/g)).toHaveLength(1); // one writer
  });

  it("the bar's own choreography still turns at the focus edge", () => {
    expect(apply).toContain('appEl.classList.toggle("kb", t.kb);');
    expect(apply).toContain('appEl.classList.toggle("lifting", lifting);');
    expect(shell).toMatch(/if \(wasUp && !t\.kb\) keyboardClosed\(\);/);
  });

  it("the up edge arms the window with the inset, and the clock is only a backstop", () => {
    // `up` is the aim, not the proof: an early start and its report are one
    // run, and the report is read against the aim BEFORE the edge can move it
    expect(apply).toMatch(
      /if \(t\.kb !== appliedKb\) \{\n\s*appliedKb = t\.kb;\n[\s\S]{0,300}if \(t\.kb\) reportedInset\(appliedUp, inset\);\n\s*\}\n\s*if \(up !== appliedUp\) \{\n\s*appliedUp = up;\n\s*armLift\(up \? "open" : "close", inset, early\);/,
    );
    expect(shell).toMatch(/liftUntil = performance\.now\(\) \+ LIFT_SETTLE_MS;/);
    expect(shell).toMatch(/LIFT_SETTLE_MS \+ 20/);
  });

  it("the early start is wired: its class, its lapse clock, its memory recalled at boot and on rotation", () => {
    expect(apply).toContain('appEl.classList.toggle("kbearly", early);');
    expect(shell).toMatch(/setTimeout\(reconcile, EARLY_LIFT_MAX_MS \+ 20\);/);
    // recalled once at initShell and again whenever the width changes, from one key
    expect(shell.match(/recallRemembered\(\)/g)).toHaveLength(3); // the definition and its two callers
    expect(shell).toMatch(/appEl = el;\n\s*recallRemembered\(\);/);
    expect(shell).toMatch(/baseline = 0;\n\s*recallRemembered\(\);/);
    expect(shell).toMatch(/localStorage\.getItem\(INSET_KEY\)/);
    expect(shell).toMatch(/localStorage\.setItem\(INSET_KEY, storeInset\(window\.innerWidth, inset\)\);/);
    // remembered at the report, and again when the keyboard changes height while up
    expect(shell).toMatch(/function reportedInset\([\s\S]*?rememberInset\(reported\);\n\}/);
    expect(apply).toMatch(/if \(t\.kb && !atEdge\) rememberInset\(inset\);/);
    // and no reduce-motion rule was hung on the lift: the user said no
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    expect(css).not.toMatch(/prefers-reduced-motion[\s\S]{0,400}\.lift\b/);
  });

  it("the landing is the transform's own transitionend, on the wrapper alone", () => {
    expect(shell).toMatch(
      /el\.addEventListener\("transitionend", \(e\) => \{\n\s*if \(e\.target !== el \|\| e\.propertyName !== "transform"\) return;\n\s*liftLanded\("end"\);/,
    );
  });

  it("the landing closes the window, hands main.ts the lift, and reconverges — once per edge", () => {
    const landed = shell.match(/function liftLanded\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(landed).toContain(
      "if (liftLandedRun !== liftRun || (Number.isFinite(y) && y !== landedLift)) {",
    );
    expect(landed).toContain("onLiftLanding?.(appliedUp, Number.isFinite(y) ? Math.abs(y) : 0);");
    // a close the phone has not finished reporting keeps the clock, so the top
    // stands until the un-pan; the clock's own fire closes it regardless
    expect(landed).toContain("const whole = keyboardInset(w.baseline, w.vvHeight) === 0 && w.vvTop <= 1;");
    expect(landed).toContain('if (via === "clock" || appliedKb || whole) liftUntil = 0;');
    expect(landed).toMatch(/reconcile\(\);\n\}$/);
    // and no scroll of its own: the padding write is main.ts's, at the landing
    expect(landed).not.toMatch(/scrollTo\(|scrollTop/);
  });

  it("nothing of the retired design survives: no hold, no step, no glide, no seed", () => {
    expect(shell).not.toMatch(/holdsShellBox|boxMotion|GLIDE_SETTLE_MS|armGlide|edgeSeeded|"gliding"|kb-glide/);
    expect(apply).not.toContain("offsetHeight");
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

  it("through the box: the edge still holds the top alone, and the lift still reads the fresh height", () => {
    const t = computeShell(world({ editorFocused: true, vvHeight: 400, vvTop: 362 }));
    expect(shellBox(t, 844, false)).toEqual({ top: 362, height: 844 }); // as the fresh read has it
    const held = { ...t, vvTop: edgeBoxTop(t.vvTop, 412, null) };
    expect(shellBox(held, 844, false)).toEqual({ top: 0, height: 844 });
    expect(liftInset(held, 844)).toBe(444); // the keyboard's height, off the fresh viewport
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

  it("the dismissal signal alone never ends the session: tearing holds until a completion signal or the clock", () => {
    // the guard design: the input's cancel is a settle and nothing more, so
    // the machine stays tearing (and the bar stays visually off) for the
    // whole native teardown, not just the instant the signal fired
    const { p, past, clock } = lifecycle();
    p.open();
    past();
    p.settle(); // the cancel, demoted to a settle
    p.settle(); // and however many duplicates arrive, the same
    clock.t += TEARDOWN_MAX_MS - 1;
    expect(p.expireTearing()).toBe("noop"); // the clock has not run out
    expect(p.isTearing()).toBe(true); // so the guarded stretch persists
    expect(p.teardownComplete()).toBe("completed"); // the hand-back ends it
    expect(p.isTearing()).toBe(false);
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

  it("the comeback tap: down under the hold, refocus completes teardown before its click, nothing presents (the full-width menu, 2026-08-26)", () => {
    const { p, present, past } = lifecycle();
    p.open();
    past();
    p.settle(); // the dismissing tap leaks into the page and settles the session
    const downHeld = p.isTearing(); // the fast re-tap's pointerdown, under the hold
    p.teardownComplete(); // the refocus signal lands between that down and its click
    // the click arrives with the window closed, but the PHYSICAL touch was
    // held, so the engine's anchor credit never went to the plus: swallow
    expect(plusClickVerdict(p.isTearing(), downHeld)).toBe("held");
    expect(present).toHaveBeenCalledTimes(1); // the swallowed click presents nothing
    // the next tap runs idle end to end and opens anchored on the plus
    expect(plusClickVerdict(p.isTearing(), false)).toBe("open");
    expect(p.open()).toBe("presented");
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
      /verdict === "clear"[\s\S]{0,200}window\.scrollTo\(0, 0\);\n\s*target = \{ kb: t\.kb, vvTop: appliedTop, vvHeight: appliedVvHeight \};/,
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
    expect(shell).toMatch(/return t\.kb \|\| lifting \? \{ top: t\.vvTop, height: baseline \} : null;/);
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

// Presentation pins for the lift: the thread, the drawer and the compose bar
// ride one transformed wrapper on the keyboard's own clock, inside a clip that
// is not a scroll container; the shell box is applied under .kb and through
// .lifting and NOTHING transitions it; and the home-indicator gap no longer
// collapses at the edge — the lift carries the bar the gap's worth further down
// instead, so no reader of --pad-b changes at a keyboard edge and none may be
// given a clock. The focusing class must still key the bar choreography.
describe("presentation — the lift rides the keyboard's clock; the box and the gap hold still", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  // comments carry the prose about durations, so strip them: a pin must never
  // be satisfied by an explanation of the thing it is checking for
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  // innermost brace pairs, which for this sheet is every plain rule (the two
  // at-rules that wrap anything hold ordinary rules inside them)
  const rules = [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    sel: m[1].trim().replace(/\s*\n\s*/g, "\n"),
    body: m[2],
  }));
  const rule = (sel: string): string => rules.find((r) => r.sel === sel)?.body ?? "";
  const transitionOf = (body: string): string => body.match(/transition:([^;]*);/)?.[1] ?? "";

  it("the wrapper translates by --kb-lift and transitions the transform on --kb-anim, nothing else", () => {
    const lift = rule(".lift");
    expect(lift).toContain("transform: translateY(var(--kb-lift))");
    expect(transitionOf(lift).trim()).toBe("transform var(--kb-anim)");
    expect(lift).toContain("will-change: transform");
    expect(lift).toContain("min-height: 0"); // a flex item's automatic minimum is the whole thread
  });

  it("the clip is `clip`, not `hidden`: a hidden box is a scroll container for the caret reveal to grab", () => {
    const clip = rule(".liftclip");
    expect(clip).toContain("overflow: clip");
    expect(clip).not.toContain("hidden");
    expect(clip).toContain("min-height: 0");
  });

  it("the lift is derived in CSS from the inset and two CSS lengths; the shell writes only the inset", () => {
    // under the proven keyboard and under the early start alike: one formula
    expect(rule("#app.kb,\n#app.kbearly")).toContain(
      "--kb-lift: calc(var(--pad-b) - var(--kb-gap) - var(--kb-inset))",
    );
    // the early class moves two things and only two: the chat's wrapper (this
    // formula) and the sign-in card (its own block below), each once
    expect(bare.match(/kbearly/g)).toHaveLength(2);
    expect(rule("#app")).toContain("--kb-inset: 0px");
    expect(rule("#app")).toContain("--kb-lift: 0px");
    expect(rule("#app")).toContain("--kb-gap: 0.5rem");
    expect(bare).not.toMatch(/--kb-lift: -?[1-9]/); // never a written-down pixel lift; 0px is rest
  });

  it("the home-indicator gap no longer collapses under .kb, so no reader of it moves at an edge", () => {
    expect(rule("#app.kb")).not.toMatch(/--pad-b:/); // it reads the gap for the lift, never sets it
    expect(rule("#app")).toContain("--pad-b: max(0.5rem, env(safe-area-inset-bottom))");
    const consumers = rules.filter((r) => r.body.includes("var(--pad-b)")).map((r) => r.sel);
    expect(consumers).toContain(".compose"); // the pill and the ＋
    expect(consumers).toContain(".jump"); // on screen exactly when the thread is scrolled away
    expect(consumers).toContain(".filepick"); // invisible, parked on the ＋
    for (const r of rules) {
      const decl = transitionOf(r.body);
      expect(decl).not.toContain("padding-bottom");
      expect(decl).not.toMatch(/(^|,)\s*bottom\s/);
    }
  });

  it("the box vars apply under .kb and stay through .lifting, and nothing transitions top or height", () => {
    expect(css).toMatch(
      /#app\.kb,\n#app\.lifting \{\n  top: var\(--shell-top, 0px\);\n  height: var\(--shell-h, 100vh\);\n\}/,
    );
    // the animated property is the FIRST token of each transition entry, so a
    // max-height elsewhere in the sheet is not a shell box travelling
    const boxAnimators = rules
      .filter((r) =>
        transitionOf(r.body)
          .split(",")
          .some((entry) => ["top", "height"].includes(entry.trim().split(/\s+/)[0])),
      )
      .map((r) => r.sel);
    expect(boxAnimators).toEqual([]);
    expect(bare).not.toMatch(/\.gliding|--glide\b/);
  });

  it("one keyboard clock, written once: the only transition on the keyboard's path spells the token", () => {
    const onToken = rules.filter((r) => transitionOf(r.body).includes("--kb-anim")).map((r) => r.sel);
    // the chat's wrapper and the sign-in card, in source order; both spell the
    // token rather than a duration of their own, so there is one clock to change
    expect(onToken).toEqual([".lift", ".gate"]);
    expect(rule("#app")).toMatch(/--kb-anim: 0\.22s cubic-bezier\(0\.45, 0, 0\.55, 1\);/);
  });

  it("the thread's top padding is the reachability pad, and only that pad moves it", () => {
    expect(rule(".thread")).toContain("padding: calc(0.75rem + var(--lift-pad, 0px)) 1rem 0.75rem");
    expect(bare.match(/--lift-pad/g)).toHaveLength(1); // one reader; main.ts is the one writer
  });

  it("the focusing class keys the same bar choreography as .kb", () => {
    expect(css).toMatch(/#app\.kb \.compose textarea,\n#app\.focusing \.compose textarea \{/);
    expect(css).toMatch(/#app\.kb \.compose \.attach,\n#app\.focusing \.compose \.attach \{/);
  });

  it("the wrapper is what the app renders around the thread, the drawer and the bar, and it is bound", () => {
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(main).toMatch(
      /<div class="liftclip">\n\s*<div class="lift">\n\s*<main id="thread" class="thread">[\s\S]*?<div id="pending" class="pending"><\/div>\n\s*<form id="compose" class="compose">[\s\S]*?<\/form>\n\s*<\/div>\n\s*<\/div>`;/,
    );
    expect(main).toContain('bindLift(app.querySelector<HTMLElement>(".lift")!);');
  });
});

// The sign-in screen, which has no wrapper to lift. The gate is one card
// centred by auto margins in a shell that holds its full-screen baseline height
// for the whole keyboard session, so the keyboard simply covered the token box
// and nothing could bring it back: the shell is fixed, html/body refuse
// panning, and iOS's caret reveal was cancelled by the shell's top rewrite and
// the shove clear. The card now rides the same inset, the same two classes and
// the same measured curve as the chat's wrapper, at HALF the inset — a box
// centred in a height H is centred in the strip H - inset once it rises by
// inset/2. Source-parsed like the other presentation pins: the arithmetic is
// the engine's, and jsdom resolves none of it.
//
// Cancelling the reveal is what the user then SAW (0.3.96): the page yanked
// down as iOS panned to show the box, and back up as the shell took the pan
// away. The chat box never did that, because the app focuses it itself and the
// reveal never starts. So the token box now carries the same mark the compose
// textarea carries and gets the same treatment by construction, rather than a
// second copy of it — that half is pinned in the take-over's own block below.
describe("presentation — the sign-in card rides the keyboard by half its inset", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    sel: m[1].trim().replace(/\s*\n\s*/g, "\n"),
    body: m[2],
  }));
  const rule = (sel: string): string => rules.find((r) => r.sel === sel)?.body ?? "";
  const transitionOf = (body: string): string => body.match(/transition:([^;]*);/)?.[1] ?? "";
  const gateLift = rule("#app.kb .gate,\n#app.kbearly .gate");

  it("the card rises by half the one inset the shell writes, under the proven keyboard and the early start alike", () => {
    expect(gateLift).toContain("transform: translateY(");
    expect(gateLift).toContain("var(--kb-inset) / 2"); // half, and half is the whole construction
    expect(gateLift).toContain("-1 *"); // upward
    expect(bare.match(/var\(--kb-inset\) \/ 2/g)).toHaveLength(1); // one copy of it, nowhere else
  });

  it("the card plays the keyboard's clock, declared where the CLOSE can still read it", () => {
    // on .gate itself, not under the classes: a transition is started from the
    // after-change style, so one that left with the class would never play the
    // close and the card would snap home
    expect(transitionOf(rule(".gate")).trim()).toBe("transform var(--kb-anim)");
    expect(transitionOf(gateLift)).toBe("");
  });

  it("the lift is capped by the card's own centring, so it can never climb off the top", () => {
    // a percentage in a translate is a share of the border box, so 50% is half
    // the card and this term is exactly its auto top margin — the whole
    // distance there is to rise before the card's top passes the shell's top
    expect(gateLift).toContain("var(--shell-h, 100vh) / 2 - 50%");
    // clamp(floor, want, cap): a card taller than the visible strip makes the
    // cap negative, clamp hands back the floor, and the card stays put
    expect(gateLift).toContain(
      "clamp(0px, var(--kb-inset) / 2, var(--shell-h, 100vh) / 2 - 50%)",
    );
  });

  it("nothing in the card's lift is a number measured off a phone", () => {
    expect(gateLift).not.toMatch(/[1-9][\d.]*px/); // 0px is the clamp's floor: rest
    expect(gateLift).not.toMatch(/[\d.]+m?s\b/); // the clock is the token, on .gate
    expect(gateLift).not.toMatch(/\d+(\.\d+)?(rem|em|pt|ex|ch)/);
  });

  it("the chat screen is untouched: the wrapper's formula, its clock and the box vars are as they were", () => {
    expect(rule("#app.kb,\n#app.kbearly").trim()).toBe(
      "--kb-lift: calc(var(--pad-b) - var(--kb-gap) - var(--kb-inset));",
    );
    expect(rule(".lift")).toContain("transform: translateY(var(--kb-lift))");
    expect(transitionOf(rule(".lift")).trim()).toBe("transform var(--kb-anim)");
    expect(css).toMatch(
      /#app\.kb,\n#app\.lifting \{\n  top: var\(--shell-top, 0px\);\n  height: var\(--shell-h, 100vh\);\n\}/,
    );
  });

  it("the rule reaches the sign-in screen alone: the card is rendered there and nowhere else", () => {
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(main.match(/class="gate"/g)).toHaveLength(1);
    const gateRender = main.match(/function renderTokenGate\(\)[\s\S]*?\n\}/)?.[0] ?? "";
    expect(gateRender).toContain('<div class="gate">');
    expect(gateRender).toContain('id="token-input" type="password"');
  });

  it("the inset the card reads is written whatever screen is up: no wrapper in the write's path", () => {
    const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
    const apply = shell.match(/function applyShell\([\s\S]*?\n\}/)?.[0] ?? "";
    // the one writer puts the classes and the inset on #app and never consults
    // the chat's wrapper, so a screen without one is driven by the same numbers
    expect(apply).toContain('appEl.style.setProperty("--kb-inset", `${inset}px`);');
    expect(apply).toContain('appEl.classList.toggle("kb", t.kb);');
    expect(apply).toContain('appEl.classList.toggle("kbearly", early);');
    expect(apply).not.toContain("liftEl");
    // and the aim behind it is pure: the world, the baseline and the focus
    const up = world({ editorFocused: true, vvHeight: 458 }); // 844 - 458 = 386
    expect(liftAim(computeShell(up), up.baseline, true, 0, 0).inset).toBe(386);
    const early = world({ editorFocused: true }); // focused, no shrink reported yet
    expect(liftAim(computeShell(early), early.baseline, true, 0, 386)).toEqual({
      up: true,
      early: true,
      inset: 386,
    });
    const rest = world();
    expect(liftAim(computeShell(rest), rest.baseline, false, 0, 386).inset).toBe(0);
  });

  it("the token box is an editable to the shell, so the keyboard session runs on this screen", () => {
    const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
    // the gate's box is <input type="password">, which this selector matches
    expect(shell).toContain(`t.matches("textarea, input:not([type='file'])")`);
  });

  it("the token box carries the mark, so the take-over reaches it and the reveal never starts", () => {
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    const gateRender = main.match(/function renderTokenGate\(\)[\s\S]*?\n\}/)?.[0] ?? "";
    expect(gateRender).toContain(
      `<input id="token-input" type="password" autocomplete="off" ${OWNED_FOCUS} />`,
    );
  });

  it("the lift is the only thing left that moves the card on a tap", () => {
    // the shell has exactly two writers that could move the page under the card
    // — the close-time correction pass and the mid-session shove clear — and
    // neither has anything to act on once the reveal never runs
    const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
    expect(shell.match(/window\.scrollTo\(0, 0\)/g)).toHaveLength(2);
    // no scroll source means "track": nothing is corrected, so nothing snaps
    expect(shoveVerdict(true, true, 0, 0, false, 0)).toBe("track");
    // and a pan with no scroll under it is followed, not fought
    expect(edgeBoxTop(412, 0, 0)).toBe(412);
    // the close pass writes only on real displacement, and there is none
    expect(closeCorrectionNeeded(0, 0, 0)).toBe(false);
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

// iOS centres the picker menu on whatever element its own hit test credited
// the last PHYSICAL touch to, and the credit is fixed at the touch. A tap
// whose pointerdown was held mid-teardown therefore must never present, even
// when teardown-complete slips in between that down and its click: the menu
// would open centred on the last credited full-width element (his 2026-08-26
// screenshot, 64pt in from each screen edge) instead of on the plus.
describe("plusClickVerdict: never open from a tap the engine did not credit to the plus", () => {
  it("a clean tap opens: down and click both outside the teardown window", () => {
    expect(plusClickVerdict(false, false)).toBe("open");
  });

  it("still tearing at click time: swallowed, whatever the down said (the shipped 0/6 refusal)", () => {
    expect(plusClickVerdict(true, false)).toBe("tearing");
    expect(plusClickVerdict(true, true)).toBe("tearing");
  });

  it("the comeback window, down held but the window closed by click time: swallowed, not presented", () => {
    expect(plusClickVerdict(false, true)).toBe("held");
  });
});

// Wiring pins for the credit rule. The shield must stamp the down-time phase
// (the capture-path hold runs first, so isTearing() there is the phase the
// hold decided on), the click must consume that stamp through the verdict,
// no verdict but "open" may reach open(), and the one open() call site is the
// click handler, so no other path can present from an uncredited tap.
describe("wiring: the plus click opens only from a tap credited to the plus", () => {
  const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");

  it("the shield stamps the down-time phase before the focus rule runs", () => {
    expect(shell).toMatch(
      /function pickerTapShield\(e: Event\): void \{\n(?:\s*\/\/[^\n]*\n)*\s*plusDownHeld = picker\.isTearing\(\);\n\s*if \(preservesFocus\(readWorld\(\)\)\) e\.preventDefault\(\);\n\}/,
    );
  });

  it("the click consumes the stamp, and only the open verdict reaches open()", () => {
    expect(shell).toMatch(
      /const verdict = plusClickVerdict\(picker\.isTearing\(\), plusDownHeld\);\n\s*plusDownHeld = false;/,
    );
    // both swallow verdicts take ONE path now: a guard-window tap is
    // swallowed whole whether the window was still open at click time or
    // only at the down (a deferred present was falsified twice on device,
    // 0/7 queued and the centred menu of the stale anchor credit)
    expect(shell).toMatch(/if \(verdict !== "open"\) \{/);
    expect(shell.match(/picker\.open\(\)/g)).toHaveLength(1); // pickerTapOpen alone presents
  });

  it("every swallowed guard-window tap records on the pick-anchor channel, distinguished by `held`", () => {
    expect(shell).toMatch(
      /holdDiagRecord\("pick-anchor", \{ held: true, upMs: Math\.round\(performance\.now\(\)\) \}\);/,
    );
  });

  it("the document hold is untouched: settle first, then the two held bar targets", () => {
    expect(shell).toMatch(
      /picker\.settle\(\);\n\s*if \(holdsBarTap\(picker\.isTearing\(\), isEditable\(e\.target\), e\.target === plusEl\)\) \{\n\s*e\.preventDefault\(\);/,
    );
  });
});

// The guard change (the centred-menu fix): the picker session counts as over
// only when attention comes back (window focus, or its page-level siblings)
// or when the expiry backstop fires, never at the input's own cancel/change.
// Those land at the dismissing tap while the native panel keeps tearing down
// for seconds, and completing there un-greyed the bar inside the dead window
// and invited the tap whose spoiled anchor credit centred the menu on the
// screen. These pins hold the wiring to that rule: which handlers may call
// teardownComplete, which may not, and that no new clock was smuggled in.
describe("wiring: the session ends at the hand-back or the expiry, never at the instant signals", () => {
  const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");

  it("cancel and change only settle: the input's handler cannot complete the teardown", () => {
    expect(shell).toMatch(
      /const sessionDone = \(\): void => \{\n\s*picker\.settle\(\);\n\s*reconcile\(\);\n\s*\};/,
    );
    const bind = shell.match(/function bindInputSignals[\s\S]*?\n\}/)?.[0] ?? "";
    expect(bind.length).toBeGreaterThan(0);
    expect(bind).not.toContain("teardownComplete");
    expect(bind).not.toContain("releaseParkedEditor"); // release belongs to completion alone
    expect(bind).toContain('input.addEventListener("cancel", sessionDone)');
    expect(bind).toContain("onPick?.();"); // the pick handler still fires at change
  });

  it("the window refocus completes, records its word, and releases parked focus", () => {
    expect(shell).toMatch(
      /window\.addEventListener\("focus", \(\) => \{\n\s*picker\.settle\(\);\n\s*const done = picker\.teardownComplete\(\) === "completed";\n\s*if \(done\) pickEndRecord\("focus"\);[^\n]*\n\s*reconcile\(\);\n\s*if \(done\) releaseParkedEditor\(\);/,
    );
  });

  it("pageshow and visibility-to-visible stay completion signals: the same hand-back, other paths", () => {
    expect(shell).toMatch(
      /window\.addEventListener\("pageshow", \(\) => \{\n\s*picker\.settle\(\);\n\s*if \(picker\.teardownComplete\(\) === "completed"\) \{\n\s*pickEndRecord\("pageshow"\);/,
    );
    expect(shell).toMatch(
      /document\.visibilityState === "visible"[\s\S]{0,120}if \(picker\.teardownComplete\(\) === "completed"\) \{\n\s*pickEndRecord\("visible"\);/,
    );
  });

  it("the expiry backstop completes like the refocus does: record, reconcile, release", () => {
    expect(shell).toMatch(
      /if \(picker\.expireTearing\(\) === "expired"\) \{\n\s*pickEndRecord\("expiry"\);[^\n]*\n\s*reconcile\(\);\n\s*releaseParkedEditor\(\);/,
    );
  });

  it("no new clock anywhere: the one backstop timer, armed only by settle's dismiss effect", () => {
    expect(shell.match(/TEARDOWN_MAX_MS \+ 50/g)).toHaveLength(1); // the existing expiry alone
    expect(shell.match(/armTeardownExpiry\(\);/g)).toHaveLength(1); // called from dismiss, nowhere else
  });

  it("the grey rides the machine's own phases, so it now lasts the whole guarded stretch", () => {
    // settling derives from presented-or-tearing on every reconcile; with
    // completion moved to the hand-back, the un-grey moves with it for free,
    // and the moment the row visibly re-arms IS the moment a tap is safe
    expect(shell).toMatch(/applyShell\(target, picker\.isOpen\(\) \|\| picker\.isTearing\(\)\);/);
  });

  it("the completion diagnostic is one tiny record: the signal's word and the uptime", () => {
    expect(shell).toMatch(
      /function pickEndRecord\(signal: string\): void \{\n\s*holdDiagRecord\("pick-anchor", \{ end: signal, upMs: Math\.round\(performance\.now\(\)\) \}\);\n\}/,
    );
    // one word per signal, and only these four: the demoted instant signals
    // must never appear as completers
    for (const sig of ["focus", "pageshow", "visible", "expiry"]) {
      expect(shell).toContain(`pickEndRecord("${sig}")`);
    }
    expect(shell.match(/pickEndRecord\("/g)).toHaveLength(4);
  });
});

// Presentation pins for the plus's squared tap target. border-radius clips
// the button's own hit area to the circle, so the corners of its 34px box
// never registered and a tap grazing one was credited to the full-width bar
// behind it, the element iOS then centres the picker menu on. The square is
// a transparent unrounded pseudo, at least the platform's 44pt minimum, and
// the button must stay unclipped or the clip takes the square with it.
describe("presentation: the plus's 44pt hit square", () => {
  const bare = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const attach = bare.match(/\n\.attach \{([^}]*)\}/)?.[1] ?? "";
  const attachKb =
    bare.match(/\n#app\.kb \.compose \.attach,\n#app\.focusing \.compose \.attach \{([^}]*)\}/)?.[1] ?? "";
  const square = bare.match(/\n\.attach::after \{([^}]*)\}/)?.[1] ?? "";

  it("a transparent unrounded pseudo squares the target to the 44pt minimum", () => {
    expect(square).toContain('content: ""');
    expect(square).toContain("position: absolute");
    expect(attach).toContain("position: relative"); // the square's seat
    const inset = Number(square.match(/inset: (-[\d.]+)px/)?.[1]);
    expect(34 - 2 * inset).toBeGreaterThanOrEqual(44); // 34px circle plus the flanks
    expect(square).not.toContain("border-radius"); // a radius would shave the corners back off
    expect(square).not.toContain("background"); // invisible: no paint, no visual change
  });

  it("the button stays unclipped (a clip would take the square with it), the circle look untouched", () => {
    expect(attach).not.toContain("overflow");
    expect(attach).toContain("width: 34px");
    expect(attach).toContain("border-radius: 50%");
  });

  it("the collapsed keyboard-time plus still takes no taps, square included", () => {
    // pseudos ride the button's pointer-events, so this one line covers both
    expect(attachKb).toContain("pointer-events: none");
  });

  it("the clip could go because the fade and the width move never overlap, either direction", () => {
    // keyboard-DOWN (base rule): width moves first, opacity waits out the whole move
    const down = attach.match(/width ([\d.]+)s ease, margin-right [\d.]+s ease, opacity ([\d.]+)s ease ([\d.]+)s/);
    expect(down).not.toBeNull();
    expect(Number(down![3])).toBeGreaterThanOrEqual(Number(down![1]));
    // keyboard-UP (.kb rule): opacity fades first, width waits for it to land
    const up = attachKb.match(/opacity ([\d.]+)s ease, width [\d.]+s ease ([\d.]+)s/);
    expect(up).not.toBeNull();
    expect(Number(up![2])).toBeGreaterThanOrEqual(Number(up![1]));
  });
});

// The composer's focusing tap (the caret-reveal shove, about two keyboard opens
// in ten). iOS focuses a tapped box with default focus options and reveals the
// caret by centring the box above the keyboard, which on a bottom composer
// clamps to the whole 412px an 812 tall document has to give, painted before
// the app gets a turn. The only refusal the engine honours is preventScroll on
// the focus call itself, and a tap cannot carry it, so the app takes the focus
// over inside the tap. What every pin below is really about is what the
// take-over is allowed to touch: a tap that carries no caret position of its
// own (an empty box), or one whose caret position was MEASURED first. A tap
// whose caret cannot be measured goes back to the engine unchanged.
describe("composerTapVerdict: which taps the app may focus itself", () => {
  it("the focusing tap on an empty box is taken over: one caret position, so none to lose", () => {
    expect(composerTapVerdict(false, true, true, false)).toBe("intercept");
    // an empty box has nothing to measure, so a measurement cannot change it
    expect(composerTapVerdict(false, true, true, true)).toBe("intercept");
  });

  it("a tap inside an already-focused box is left alone, whatever it holds", () => {
    // the reveal rides the focusing tap alone, and this is the tap that moves
    // the caret, extends a selection, or ends a long press
    expect(composerTapVerdict(true, true, true, false)).toBe("focused");
    expect(composerTapVerdict(true, false, true, false)).toBe("focused");
    // even with an offset in hand: a focused box is never this rule's business
    expect(composerTapVerdict(true, false, true, true)).toBe("focused");
  });

  it("a box with text is taken over once the tapped character is known", () => {
    expect(composerTapVerdict(false, false, true, true)).toBe("caret");
  });

  it("a box with text whose character could NOT be measured is left alone", () => {
    // the shove is the lesser bug: a caret that jumps to the end of a half
    // written message is the one that must never ship
    expect(composerTapVerdict(false, false, true, false)).toBe("text");
  });

  it("only the primary button, so a right or middle click keeps the platform's behaviour", () => {
    expect(composerTapVerdict(false, true, false, false)).toBe("aux");
    expect(composerTapVerdict(true, false, false, false)).toBe("aux");
    expect(composerTapVerdict(false, false, false, true)).toBe("aux");
  });

  // The sign-in screen's token box is the same rule's second control, and the
  // one thing it cannot do is carry a measured offset: tapcaret.ts reads a laid
  // out textarea and has nothing to say about a one-line field. Every case
  // above is stated again with the box declared single-line, so the two
  // controls' verdicts sit side by side and neither can be moved alone.
  it("a one-line box holding text is taken over anyway, with no offset to place", () => {
    // the opposite trade from the multi-line rule, and the right one here: the
    // field renders dots, so no tap into it was ever aiming a caret
    expect(composerTapVerdict(false, false, true, false, true)).toBe("single");
    // and a measurement it could never have had changes nothing about that
    expect(composerTapVerdict(false, false, true, true, true)).toBe("single");
  });

  it("an EMPTY one-line box is the plain interception, exactly as an empty composer is", () => {
    // the tap the sign-in bug was actually about: nothing typed yet
    expect(composerTapVerdict(false, true, true, false, true)).toBe("intercept");
  });

  it("focus and the primary button still come first for a one-line box", () => {
    // the reveal rides the focusing tap alone on both controls, and a right
    // click keeps the platform's behaviour on both
    expect(composerTapVerdict(true, false, true, false, true)).toBe("focused");
    expect(composerTapVerdict(false, false, false, false, true)).toBe("aux");
  });

  it("saying nothing about lines IS the composer, so none of its cases moved", () => {
    // the default is the control every case above was worked out on: a new
    // caller has to say it is single-line before it is treated as one, and
    // saying so explicitly is the same answer as saying nothing
    expect(composerTapVerdict(false, false, true, false)).toBe("text");
    expect(composerTapVerdict(false, false, true, false, false)).toBe("text");
    expect(composerTapVerdict(false, false, true, true, false)).toBe("caret");
    expect(composerTapVerdict(false, true, true, false, false)).toBe("intercept");
  });
});

describe("focusComposerTap: the take-over, and everything it must not touch", () => {
  function tapped(
    over: {
      focused?: boolean;
      value?: string;
      at?: number | null;
      singleLine?: boolean;
    } = {},
  ) {
    const calls: string[] = [];
    const options: { preventScroll: boolean }[] = [];
    const carets: number[] = [];
    let measured = 0;
    const target = {
      focused: over.focused ?? false,
      value: over.value ?? "",
      singleLine: over.singleLine,
      caretAt: (): number | null => {
        measured += 1;
        calls.push("measure");
        return over.at ?? null;
      },
      focus: (o: { preventScroll: boolean }): void => {
        calls.push("focus");
        options.push(o);
      },
      setCaret: (at: number): void => {
        calls.push("caret");
        carets.push(at);
      },
    };
    return {
      target,
      calls,
      options,
      carets,
      measures: (): number => measured,
      prevent: (): void => void calls.push("prevent"),
    };
  }

  const taps = (): unknown[] =>
    holdDiagEvents().filter((e) => e.ev === "kb-focusing").map((e) => e.d);

  beforeEach(() => {
    holdDiagReset();
  });

  it("refuses the engine's focus and takes it with preventScroll, in that order, one turn", () => {
    const t = tapped();
    expect(focusComposerTap(t.target, true, t.prevent)).toBe("intercept");
    // the refusal first, the focus immediately after it: the flag only reaches
    // the UI process on a focus the app made, and the keyboard only rises from
    // one made inside the tap
    expect(t.calls).toEqual(["prevent", "focus"]);
    expect(t.options).toEqual([{ preventScroll: true }]);
  });

  it("a box holding text is taken over too, with the caret put at the tapped character", () => {
    const t = tapped({ value: "half a sentence", at: 7 });
    expect(focusComposerTap(t.target, true, t.prevent)).toBe("caret");
    // the measurement first (it decides whether this tap may be touched at
    // all), then the refusal and the focus with nothing between them, then the
    // caret, which can only be set on a control that already holds focus
    expect(t.calls).toEqual(["measure", "prevent", "focus", "caret"]);
    expect(t.options).toEqual([{ preventScroll: true }]);
    expect(t.carets).toEqual([7]);
  });

  it("offset 0 is a real answer, not a missing one: the tap on the first character", () => {
    // the trap a truthiness check would fall into, and the caret it would send
    // to the engine instead of placing
    const t = tapped({ value: "half a sentence", at: 0 });
    expect(focusComposerTap(t.target, true, t.prevent)).toBe("caret");
    expect(t.carets).toEqual([0]);
  });

  it("a tap inside a focused box is not prevented, not refocused, not even measured", () => {
    const t = tapped({ focused: true, value: "half a sentence", at: 3 });
    expect(focusComposerTap(t.target, true, t.prevent)).toBe("focused");
    expect(t.calls).toEqual([]); // nothing happened at all, so nothing can break
    expect(t.measures()).toBe(0); // and no layout was forced to decide that
    expect(taps()).toEqual([]);
  });

  it("a tap into text whose character could not be measured goes back to the engine whole", () => {
    const t = tapped({ value: "half a sentence", at: null });
    expect(focusComposerTap(t.target, true, t.prevent)).toBe("text");
    expect(t.calls).toEqual(["measure"]); // asked, unanswered, and then dropped
    expect(t.carets).toEqual([]); // above all: no offset was invented to use
  });

  it("an empty box is never measured: it has one caret position and it is known", () => {
    const t = tapped();
    focusComposerTap(t.target, true, t.prevent);
    expect(t.measures()).toBe(0);
    expect(t.carets).toEqual([]);
  });

  it("a non-primary button does nothing, measures nothing and records nothing", () => {
    const t = tapped({ value: "half a sentence", at: 4 });
    expect(focusComposerTap(t.target, false, t.prevent)).toBe("aux");
    expect(t.calls).toEqual([]);
    expect(t.measures()).toBe(0);
    expect(taps()).toEqual([]);
  });

  it("a one-line box holding text is refused and refocused, and no caret is set", () => {
    // the whole point of the sign-in fix: the same refusal and the same
    // preventScroll focus the composer gets, with the caret left wherever a
    // scripted focus puts it rather than at an offset nobody measured
    const t = tapped({ value: "a-token", at: 3, singleLine: true });
    expect(focusComposerTap(t.target, true, t.prevent)).toBe("single");
    expect(t.calls).toEqual(["prevent", "focus"]);
    expect(t.options).toEqual([{ preventScroll: true }]);
    expect(t.carets).toEqual([]); // no offset was placed, and none was invented
  });

  it("a one-line box is never measured, even when it offers an answer", () => {
    // the ruler is a textarea's; asking it here would be a layout read whose
    // answer could not be used, and an offset this rule must not have
    const t = tapped({ value: "a-token", at: 3, singleLine: true });
    focusComposerTap(t.target, true, t.prevent);
    expect(t.measures()).toBe(0);
  });

  it("an empty one-line box is the plain interception, and reads as one on the trail", () => {
    const t = tapped({ singleLine: true });
    expect(focusComposerTap(t.target, true, t.prevent)).toBe("intercept");
    expect(t.calls).toEqual(["prevent", "focus"]);
    expect(taps()).toEqual([{ tap: "intercept" }]);
  });

  it("the one-line take-over lands on the trail carrying what it held, and no offset", () => {
    // `at` is absent rather than null: null is tapcaret.ts answering "could not
    // measure", and nothing asked it anything here
    const t = tapped({ value: "a-token", singleLine: true });
    focusComposerTap(t.target, true, t.prevent);
    expect(taps()).toEqual([{ tap: "single", of: 7 }]);
  });

  it("a tap inside a focused one-line box is left alone too", () => {
    const t = tapped({ focused: true, value: "a-token", singleLine: true });
    expect(focusComposerTap(t.target, true, t.prevent)).toBe("focused");
    expect(t.calls).toEqual([]);
    expect(taps()).toEqual([]);
  });

  it("every focusing tap lands on the keyboard channel, named by what was decided", () => {
    // the empty-box take-over, so a device session shows the interception...
    const own = tapped();
    focusComposerTap(own.target, true, own.prevent);
    // ...the with-text one, told apart from it by name and carrying the offset
    // the caret was put at, so a caret that landed wrong is a number here...
    const held = tapped({ value: "half a sentence", at: 7 });
    focusComposerTap(held.target, true, held.prevent);
    // ...and the one it declined, so a shove recorded after it is explained
    const left = tapped({ value: "x" });
    focusComposerTap(left.target, true, left.prevent);
    expect(holdDiagEvents().map((e) => e.ev)).toEqual([
      "kb-focusing",
      "kb-focusing",
      "kb-focusing",
    ]);
    expect(taps()).toEqual([
      { tap: "intercept" },
      { tap: "caret", at: 7, of: 15 },
      { tap: "text", at: null, of: 1 },
    ]);
  });

  it("the trail says a caret that ran to the end of the text: at equals of", () => {
    // the one outcome he ruled out, so it must be readable rather than felt
    const t = tapped({ value: "half a sentence", at: 15 });
    focusComposerTap(t.target, true, t.prevent);
    expect(taps()).toEqual([{ tap: "caret", at: 15, of: 15 }]);
  });

  it("the record comes after the focus, never between the tap and the keyboard", () => {
    const order: string[] = [];
    const target = {
      focused: false,
      value: "",
      caretAt: (): number | null => null,
      focus: (): void => void order.push("focus"),
      setCaret: (): void => void order.push("caret"),
    };
    focusComposerTap(target, true, () => order.push("prevent"));
    order.push(...holdDiagEvents().map((e) => e.ev));
    expect(order).toEqual(["prevent", "focus", "kb-focusing"]);
  });

  it("the record comes after the caret too, on the tap that places one", () => {
    const order: string[] = [];
    const target = {
      focused: false,
      value: "half a sentence",
      caretAt: (): number | null => 7,
      focus: (): void => void order.push("focus"),
      setCaret: (): void => void order.push("caret"),
    };
    focusComposerTap(target, true, () => order.push("prevent"));
    order.push(...holdDiagEvents().map((e) => e.ev));
    expect(order).toEqual(["prevent", "focus", "caret", "kb-focusing"]);
  });
});

// Wiring pins for the take-over: which event carries it, what may reach it, and
// that nothing else in the shell's focus handling moved to make room for it.
describe("wiring: the focusing tap is intercepted on mousedown and nowhere else", () => {
  const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
  const handler = shell.match(/function composerTapListener[\s\S]*?\n\}/)?.[0] ?? "";
  const takeover = shell.match(/export function focusComposerTap[\s\S]*?\n\}/)?.[0] ?? "";

  it("mousedown carries it: the event that grants focus, and the last one before it", () => {
    // iOS synthesises a mousedown only for a gesture it has already ruled a
    // tap, so a scroll, a long press and a selection drag never arrive here
    expect(shell).toMatch(
      /document\.addEventListener\("mousedown", composerTapListener, true\);/,
    );
    expect(shell.match(/composerTapListener/g)).toHaveLength(2); // the function and its one listener
    // touchstart and pointerdown were both turned down (see the header there)
    expect(handler).not.toContain("touchstart");
    expect(handler).not.toContain("pointerdown");
  });

  it("only the app's own boxes reach the decision, and the mark says which", () => {
    // the gate is a mark on the element, not a list of ids in the handler: the
    // sign-in screen was left out of every one of these rules exactly because
    // each of them named the composer separately (the 0.3.96 yank)
    expect(handler).toContain("if (!ownsFocus(t)) return;");
    expect(handler).not.toContain('id !== "text"');
    expect(handler).toMatch(
      /if \(!\(t instanceof HTMLTextAreaElement \|\| t instanceof HTMLInputElement\)\) return;/,
    );
    // and the mark is read, never spelled out again, wherever it is consulted
    expect(shell).toContain(`export const OWNED_FOCUS = "${OWNED_FOCUS}";`);
    expect(shell).toContain("return t instanceof HTMLElement && t.hasAttribute(OWNED_FOCUS);");
  });

  it("both boxes carry the mark, and no third element in the app does", () => {
    // read off the tags themselves, so the list IS every marked element in the
    // app: two, and the pair the take-over was written for
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    const marked = [...main.matchAll(new RegExp(`<(\\w+)[^>]*\\s${OWNED_FOCUS}[\\s/>]`, "g"))];
    expect(marked.map((m) => m[1])).toEqual(["input", "textarea"]); // the gate's, then the chat's
  });

  it("the blink is given off the same mark, so neither box can be left without it", () => {
    // one opacity-0 frame at focus is what makes iOS skip the reveal in the
    // first place; the take-over is the second lock on that same door, and a
    // rule that named the composer would have opened one of them on the gate
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    expect(css).toMatch(
      new RegExp(`\\[${OWNED_FOCUS}\\]:focus \\{\\n  animation: focus-blink 0\\.02s;\\n\\}`),
    );
    expect(css).not.toContain(".compose textarea:focus {"); // not a second copy for the chat
    expect(css.match(/animation: focus-blink/g)).toHaveLength(1);
  });

  it("the window snap-back is gated on the same mark, by the same function", () => {
    // main.ts's one defensive scroll fighter used to read the composer's id, so
    // it could never have covered the gate either
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    const snapback = main.match(/window\.addEventListener\(\n  "scroll",[\s\S]*?\n\);/)?.[0] ?? "";
    expect(snapback, "the window scroll listener").not.toBe("");
    expect(snapback).toContain("if (!ownsFocus(document.activeElement)) return;");
    expect(snapback).toContain("window.scrollTo(0, 0);");
    // one gate, and it is the shell's — not a lookalike predicate in main.ts
    expect(snapback).not.toContain('activeElement?.id');
    expect(main).toMatch(/import \{[\s\S]*?\n  ownsFocus,\n[\s\S]*?\} from "\.\/shell";/);
  });

  it("the tap's own facts decide, read at the tap: focus state, contents, button", () => {
    expect(handler).toContain("focused: document.activeElement === t");
    expect(handler).toContain("value: t.value");
    expect(handler).toContain("e.button === 0");
    expect(handler).toContain("() => e.preventDefault()");
  });

  it("the caret is measured from the tap's own point and set on the box it was measured for", () => {
    // the event's coordinates, not a rect read later and not a stored one: the
    // finger is only in one place for the length of this handler — and only
    // for the box that has lines to measure, which is the ONE thing that
    // differs between the two controls
    expect(handler).toContain(
      "t instanceof HTMLTextAreaElement ? caretOffsetAt(t, e.clientX, e.clientY) : null",
    );
    expect(handler).toContain("singleLine: !(t instanceof HTMLTextAreaElement)");
    expect(handler).toContain("setCaret: (at) => t.setSelectionRange(at, at)");
  });

  it("the offset is placed, never derived at the edge: the handler does no arithmetic", () => {
    // every number that could put a caret in the wrong place is measured in
    // tapcaret.ts against real rects, so a fallback here would be the one
    // guess the whole rule exists to refuse
    for (const body of [handler, takeover]) {
      expect(body).not.toMatch(/value\.length\s*[-+]|\|\|\s*0\b|\?\?\s*\d/);
    }
  });

  it("no clock and no wait anywhere on the path: the focus is the tap's own turn", () => {
    for (const body of [handler, takeover]) {
      expect(body).not.toMatch(/setTimeout|setInterval|requestAnimationFrame|await|then\(/);
    }
  });

  it("the verdict has one caller and the take-over has one, so no other path can focus", () => {
    expect(shell.match(/composerTapVerdict\(/g)).toHaveLength(2); // its definition and the one call
    expect(shell.match(/focusComposerTap\(/g)).toHaveLength(2);
    // the composer is focused in exactly one place in the shell, and it is this
    expect(shell.match(/\.focus\(\{ preventScroll: true \}\)/g)).toHaveLength(1);
  });

  it("focus that arrives without a tap is untouched: focusin still only stamps and reconciles", () => {
    // a hardware keyboard, assistive technology, anything that is not a finger
    expect(shell).toMatch(
      /document\.addEventListener\("focusin", \(e\) => \{\n\s*if \(isEditable\(e\.target\)\) \{\n\s*focusStartAt = performance\.now\(\);/,
    );
  });

  it("the shove clear stays exactly where it was: the take-over is a prevention, not a swap", () => {
    expect(shell).toMatch(/shoveClears \+= 1;\n\s*window\.scrollTo\(0, 0\);/);
  });
});

describe("createDismissSwipe — the swipe down the compose bar that puts the keyboard away", () => {
  // px per rem for these cases. Every threshold the reducer holds is stated in
  // rem and multiplied by whatever the phone's root font size turns out to be,
  // so nothing below is a number fitted to one screen.
  const REM = 16;
  const PAST = DISMISS_TRAVEL_REM * REM + 1;
  const SHORT = DISMISS_TRAVEL_REM * REM - 1;
  const Y = 700; // a finger on the bar, near the bottom of the screen
  const X = 100;

  function touch(over: Partial<SwipeTouch> = {}): SwipeTouch {
    return { x: X, y: Y, kbUp: true, inEditor: false, editorScrollTop: 0, rem: REM, ...over };
  }

  it("a tap is still a tap: no travel, no dismissal, and the box keeps its focus", () => {
    const s = createDismissSwipe();
    expect(s.start(touch({ inEditor: true }))).toBe("watch");
    expect(s.move(X, Y)).toBe("watch"); // a finger that never moved
    expect(s.move(X + 2, Y + 3)).toBe("watch"); // and one that only wobbled
    expect(s.move(X, Y + SHORT)).toBe("watch");
    s.end();
  });

  it("past the travel and mostly downward: the keyboard goes", () => {
    const s = createDismissSwipe();
    s.start(touch());
    expect(s.move(X, Y + PAST)).toBe("dismiss");
  });

  it("mostly sideways is not a dismissal, however far down it also went", () => {
    const s = createDismissSwipe();
    s.start(touch());
    // the drop clears the travel on its own; the sideways drift is what refuses it
    expect(s.move(X + PAST * 2, Y + PAST)).toBe("watch");
  });

  it("the ratio is the test, not the axis: a diagonal that is mostly down still dismisses", () => {
    const s = createDismissSwipe();
    s.start(touch());
    expect(s.move(X + PAST / DISMISS_DOWNNESS - 1, Y + PAST)).toBe("dismiss");
  });

  it("upward is never a dismissal", () => {
    const s = createDismissSwipe();
    s.start(touch());
    expect(s.move(X, Y - PAST)).toBe("watch");
  });

  it("a scrolled draft owns the drag: the swipe never steals the textarea's own scroll", () => {
    // a long message past the pill's five-line cap scrolls INSIDE the box, and
    // a downward drag there is that scroll — not an exit
    const s = createDismissSwipe();
    expect(s.start(touch({ inEditor: true, editorScrollTop: 40 }))).toBe("ignore");
    expect(s.move(X, Y + PAST)).toBe("ignore");
  });

  it("a draft already at its top is a pull PAST the top, and that dismisses", () => {
    const s = createDismissSwipe();
    expect(s.start(touch({ inEditor: true, editorScrollTop: 0 }))).toBe("watch");
    expect(s.move(X, Y + PAST)).toBe("dismiss");
  });

  it("a finger outside the box never asks the draft's permission", () => {
    // the bar's padding, the ＋ and the ↑: whatever the textarea's own scroll
    // reads, it is not this gesture's business
    const s = createDismissSwipe();
    expect(s.start(touch({ inEditor: false, editorScrollTop: 400 }))).toBe("watch");
    expect(s.move(X, Y + PAST)).toBe("dismiss");
  });

  it("no keyboard of ours is up: there is nothing to put down", () => {
    const s = createDismissSwipe();
    expect(s.start(touch({ kbUp: false }))).toBe("ignore");
    expect(s.move(X, Y + PAST)).toBe("ignore");
  });

  it("an unreadable rem is not a threshold, and a gesture with no threshold does not arm", () => {
    const s = createDismissSwipe();
    expect(s.start(touch({ rem: NaN }))).toBe("ignore");
    expect(s.move(X, Y + PAST)).toBe("ignore");
  });

  it("the boundary: exactly the travel counts, one pixel short does not", () => {
    const s = createDismissSwipe();
    s.start(touch());
    expect(s.move(X, Y + DISMISS_TRAVEL_REM * REM - 1)).toBe("watch");
    expect(s.move(X, Y + DISMISS_TRAVEL_REM * REM)).toBe("dismiss");
  });

  it("one dismissal per gesture; the rest of the drag, and any move without a start, is nothing", () => {
    const s = createDismissSwipe();
    s.start(touch());
    expect(s.move(X, Y + PAST)).toBe("dismiss");
    expect(s.move(X, Y + PAST * 2)).toBe("ignore");
    s.end();
    expect(s.move(X, Y + PAST * 2)).toBe("ignore");
  });
});

describe("wiring: the bar's swipe is a blur and nothing else", () => {
  const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const binder = shell.match(/export function bindComposeDismiss[\s\S]*?\n\}/)?.[0] ?? "";
  const core = shell.match(/export function createDismissSwipe[\s\S]*?\n\}/)?.[0] ?? "";

  it("every listener is on the compose FORM, and the form is what main.ts hands it", () => {
    expect(binder, "bindComposeDismiss").not.toBe("");
    const bound = [...binder.matchAll(/(\w+)\.addEventListener\(\s*"(\w+)"/g)];
    expect(bound.map((m) => `${m[1]}.${m[2]}`)).toEqual([
      "form.touchstart",
      "form.touchmove",
      "form.touchend",
      "form.touchcancel",
    ]);
    expect(main).toContain('bindComposeDismiss(document.getElementById("compose")!, textEl);');
    expect(shell.match(/createDismissSwipe\(/g)).toHaveLength(2); // the factory and its one use
  });

  it("the dismissal IS the blur: the ordinary close is what follows, and nothing new moves", () => {
    expect(binder).toContain('if (swipe.move(t.clientX, t.clientY) === "dismiss") editor.blur();');
    expect(binder.match(/\.blur\(\)/g)).toHaveLength(1);
    // no class, no transition, no scroll write, no clock of its own: the lift
    // leaves on the keyboard's curve because focusout reconciles, as always
    expect(binder).not.toMatch(
      /classList|\.style\.|transition|scrollTo\(|requestAnimationFrame|setTimeout/,
    );
  });

  it("nothing is prevented, and all four listeners say so by being passive", () => {
    // a blur needs no default stopped; preventing would cancel the very inner
    // scroll the long-draft rule hands back, and would sit in front of iOS's
    // own caret, loupe and selection handling
    expect(binder).not.toMatch(/preventDefault|stopPropagation|stopImmediatePropagation/);
    expect(binder.match(/\{ passive: true \}/g)).toHaveLength(4);
    expect(binder).not.toContain("passive: false");
  });

  it("the focusing take-over is untouched: mousedown is still its event, touchmove is ours", () => {
    expect(shell).toMatch(/document\.addEventListener\("mousedown", composerTapListener, true\);/);
    expect(shell.match(/composerTapListener/g)).toHaveLength(2); // the function and its one listener
    expect(binder).not.toContain("mousedown");
    expect(binder).not.toContain("pointerdown");
    // and the composer is still focused in exactly one place in the whole shell
    expect(shell.match(/\.focus\(\{ preventScroll: true \}\)/g)).toHaveLength(1);
  });

  it("the thresholds are a length and a ratio; the reducer measures nothing itself", () => {
    expect(shell).toMatch(/^export const DISMISS_TRAVEL_REM = 2\.5;$/m);
    expect(shell).toMatch(/^export const DISMISS_DOWNNESS = 1\.5;$/m);
    // the rem comes off the document root, so the phone's own text size sets it
    expect(shell).toContain(
      "return parseFloat(getComputedStyle(document.documentElement).fontSize);",
    );
    expect(core, "createDismissSwipe").not.toBe("");
    expect(core).not.toMatch(/\d+px|\b\d{2,}\b/); // no pixel constant anywhere in it
    expect(core).not.toMatch(/window\.|document\.|performance\./); // and no reading either
  });

  it("the touch-time reads are taken only where the verdict turns on them", () => {
    // the same discipline as the take-over's caret measurement: a focusing tap
    // reads nothing here, so no layout is forced ahead of the keyboard's rise
    expect(binder).toContain("const focused = document.activeElement === editor;");
    expect(binder).toContain("editorScrollTop: focused && inEditor ? editor.scrollTop : 0,");
    expect(binder).toContain("rem: focused ? rootRem() : 0,");
    expect(binder).not.toContain("getBoundingClientRect");
  });

  it("the textarea itself gains no listener, and the thread's own drag is left alone", () => {
    expect(main).not.toMatch(/textEl\.addEventListener\("(?:pointer|touch|mouse)/);
    expect(main).toMatch(/import \{\n  bindComposeDismiss,\n/);
    // the peek gesture still owns its own preventDefault on its own element
    expect(main).toContain('thread.addEventListener(\n    "touchmove",');
    expect(main).toContain("e.preventDefault(); // we own this gesture");
    expect(main).toContain("{ passive: false },");
  });
});
