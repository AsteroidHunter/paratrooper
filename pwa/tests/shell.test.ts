// Regression pins for the shell's pure decision core (src/shell.ts).
// Every case is a bug that shipped to Akash's phone once; it does not ship twice.
// These run without a DOM — the decision functions take World data and return
// targets, so each iOS lie is encoded as plain inputs.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { holdDiagEvents, holdDiagReset } from "../src/hold";
import {
  FOCUSING_MAX_MS,
  HEAL_THRESHOLD_PX,
  MAX_SHOVE_CLEARS,
  MIN_KEYBOARD_PX,
  SETTLE_GUARD_MS,
  TEARDOWN_MAX_MS,
  boxMotion,
  closeCorrectionNeeded,
  composerTapVerdict,
  computeShell,
  createPickerLifecycle,
  edgeBoxTop,
  focusComposerTap,
  focusingActive,
  healNeeded,
  holdsBarTap,
  holdsShellBox,
  keyboardInset,
  plusClickVerdict,
  preservesFocus,
  shellBox,
  shoveVerdict,
  type BoxMotion,
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

// The white band and the snap that follows it (production trail 2026-09-01,
// nine failures, every one the same shape). "Is there a keyboard" is an AND, so
// it goes false on whichever input flips first, and on all nine that was FOCUS:
// the close was learned from the editor losing it while the viewport was still
// publishing the keyboard-sized height, the shell grew to full height there,
// and 6 to 44ms later the engine handed back the offset the range had held
// while the keyboard was up — 386px past an end the app had already moved. The
// band is that overhang and the snap is the correction taking it back. Closes
// learned from the viewport were clean, all of them, because those grow the
// shell at the instant the screen is whole. So the box waits for the viewport.
describe("holdsShellBox — the close the phone has not admitted yet", () => {
  const UP = 458; // the visual viewport with the keyboard up: 844 less 386
  const inset = (vvHeight: number): number => keyboardInset(844, vvHeight);

  it("the failing close: focus gone, viewport still short — the box stands", () => {
    expect(holdsShellBox(false, true, inset(UP))).toBe(true);
  });

  it("a viewport-learned close never holds: the screen is whole when it is asked", () => {
    // kb went false because the height came back, so there is no gap to wait out
    expect(holdsShellBox(false, true, inset(844))).toBe(false);
  });

  it("the wait is drawn on the same threshold the inset filter is", () => {
    expect(holdsShellBox(false, true, inset(844 - MIN_KEYBOARD_PX))).toBe(true);
    expect(holdsShellBox(false, true, inset(844 - MIN_KEYBOARD_PX + 1))).toBe(false);
  });

  it("a keyboard that is up sizes from the viewport as it always did", () => {
    expect(holdsShellBox(true, true, inset(UP))).toBe(false);
  });

  it("nothing to hold at rest: the four-edge pin is never held onto", () => {
    expect(holdsShellBox(false, false, inset(UP))).toBe(false);
  });

  it("the iOS 26 stale-viewport lie is not a keyboard, so it cannot hold the box", () => {
    // a ~24px-short viewport after dismissal reads as no inset at all
    // (keyboardInset's own filter), which is what ends the wait
    expect(holdsShellBox(false, true, inset(820))).toBe(false);
  });

  it("mid-retraction the keyboard is still on the screen, so the wait continues", () => {
    expect(holdsShellBox(false, true, inset(600))).toBe(true);
  });
});

// The band the hold above did NOT fix, and the second half of the same close
// (production trail and a frame-by-frame recording, 2026-09-01: fourteen closes
// and eight, every one the same shape). The hold ran correctly on all of them —
// the shell waited for the viewport and grew once — and the band still came,
// because the growth ANIMATED. Over the 220ms it took, the app's own settle ran
// on every frame and read "already at the bottom, moved 0" every time, since the
// engine clamps scrollTop as the box grows; iOS meanwhile kept compositing the
// message list at its pre-close offset and republished only at the end. So the
// compose bar slid down, the message area's bottom edge followed it, the
// messages did not move, and white opened under the last message to about 386px
// over thirteen to fifteen frames before one frame of snap took it back.
//
// The window is the fault. An engine one frame behind is invisible; an engine
// thirteen frames behind paints a keyboard of white. The close therefore gets no
// window: one write, at the full height, on the frame the viewport admits the
// screen is whole.
describe("boxMotion — the close steps, the open still glides", () => {
  it("the close's write lands in one frame: no window for the engine to lag in", () => {
    expect(boxMotion(false, true)).toBe("step");
  });

  it("the open still glides: WebKit can publish a whole rise as one event", () => {
    expect(boxMotion(true, true)).toBe("glide");
  });

  it("outside a settle window nothing animates, whichever edge it belongs to", () => {
    // a mid-typing write must never smear an active-growth frame
    expect(boxMotion(true, false)).toBe("instant");
    expect(boxMotion(false, false)).toBe("instant");
  });

  it("only the raise ever animates the box — the one thing the band turns on", () => {
    const animated = [true, false].flatMap((kb) =>
      [true, false]
        .filter((gliding) => boxMotion(kb, gliding) === "glide")
        .map((gliding) => [kb, gliding]),
    );
    expect(animated).toEqual([[true, true]]);
  });

  it("a close that arrives inside the raise's own window still steps", () => {
    // dismissing within GLIDE_SETTLE_MS of the tap re-arms the window as a
    // close, and .kb is off from that edge on, so nothing can inherit a glide
    // the raise opened
    expect(boxMotion(false, true)).toBe("step");
  });
});

// The same rule played through a whole close, because the property that matters
// is not one verdict but the sequence: ONE shell resize per close, never two,
// and never one before the phone agrees. The stand-in below is applyShell's box
// branch and nothing else — the wiring pins further down hold it to the source
// it mirrors.
describe("the close's writes: one resize, taken when the viewport says so", () => {
  const UP = 458;

  function shellWriter() {
    let top: number | null = null;
    let height: number | null = null;
    const writes: (readonly [number | null, number | null])[] = [];
    // how each of those writes MOVED, taken from the same decision the real
    // writer records it with, so the sequence pins say not only that the close
    // writes once but that the one write does not travel
    const motions: BoxMotion[] = [];
    return {
      writes,
      motions,
      box: () => [top, height] as const,
      /** one viewport reading, exactly as reconcile hands it to applyShell */
      read(w: World, gliding = true): void {
        const t = computeShell(w);
        const held = holdsShellBox(
          t.kb,
          top !== null || height !== null,
          keyboardInset(w.baseline, w.vvHeight),
        );
        const motion = boxMotion(t.kb, gliding);
        const box = shellBox(t);
        if (box) {
          if (Math.round(box.top) !== top || Math.round(box.height) !== height) {
            top = Math.round(box.top);
            height = Math.round(box.height);
            writes.push([top, height]);
            motions.push(motion);
          }
        } else if (!held && (top !== null || height !== null)) {
          if (gliding) {
            const restH = Math.round(w.baseline);
            if (top !== 0 || height !== restH) {
              top = 0;
              height = restH;
              writes.push([top, height]);
              motions.push(motion);
            }
          } else {
            top = null;
            height = null;
            writes.push([null, null]); // the vars go, the four-edge pin takes over
            motions.push(motion);
          }
        }
      },
    };
  }

  const raised = (): ReturnType<typeof shellWriter> => {
    const s = shellWriter();
    s.read(world({ editorFocused: true, vvHeight: UP }));
    return s;
  };

  it("the raise still sizes the shell from the viewport, once", () => {
    expect(raised().writes).toEqual([[0, UP]]);
  });

  it("focus leaves under a stale viewport: nothing is written, the box stays keyboard-sized", () => {
    const s = raised();
    s.read(world({ editorFocused: false, vvHeight: UP }));
    expect(s.writes).toEqual([[0, UP]]); // still only the raise's own write
    expect(s.box()).toEqual([0, UP]);
  });

  it("the viewport catches up and the shell grows exactly once", () => {
    const s = raised();
    s.read(world({ editorFocused: false, vvHeight: UP })); // the focus edge
    s.read(world({ editorFocused: false, vvHeight: 844 })); // 6-44ms later
    expect(s.writes).toEqual([
      [0, UP],
      [0, 844],
    ]);
  });

  it("every held reading in between is silent, however many arrive", () => {
    const s = raised();
    s.read(world({ editorFocused: false, vvHeight: UP }));
    s.read(world({ editorFocused: false, vvHeight: UP })); // a scroll event on the same numbers
    s.read(world({ editorFocused: false, vvHeight: 600 })); // the keyboard half retracted
    expect(s.writes).toHaveLength(1);
    s.read(world({ editorFocused: false, vvHeight: 844 }));
    expect(s.writes).toHaveLength(2);
  });

  it("a viewport-learned close is untouched: it grows on its own reading, once", () => {
    const s = raised();
    s.read(world({ editorFocused: true, vvHeight: 844 })); // the height came back first
    expect(s.writes).toEqual([
      [0, UP],
      [0, 844],
    ]);
    s.read(world({ editorFocused: false, vvHeight: 844 })); // focus follows it down
    expect(s.writes).toHaveLength(2);
  });

  it("no close writes the box twice, whichever signal taught it", () => {
    for (const close of [
      [world({ editorFocused: false, vvHeight: UP }), world({ editorFocused: false, vvHeight: 844 })],
      [world({ editorFocused: true, vvHeight: 844 }), world({ editorFocused: false, vvHeight: 844 })],
      [world({ editorFocused: false, vvHeight: 844 })],
    ]) {
      const s = raised();
      for (const w of close) s.read(w);
      // one write for the raise, one for the close, and no third
      expect(s.writes).toHaveLength(2);
      expect(s.box()).toEqual([0, 844]);
    }
  });

  it("the step still lands on the pin's own geometry when the window ends", () => {
    const s = raised();
    s.read(world({ editorFocused: false, vvHeight: UP }));
    s.read(world({ editorFocused: false, vvHeight: 844 }));
    s.read(world({ editorFocused: false, vvHeight: 844 }), false); // the window expired
    expect(s.writes).toEqual([
      [0, UP],
      [0, 844],
      [null, null],
    ]);
  });

  // The same sequence read for the other property: not how many writes, but how
  // far each one travelled. This is the whole of the change, played through a
  // close.
  it("the close's one write is a STEP — the full height, arrived at in a frame", () => {
    const s = raised();
    s.read(world({ editorFocused: false, vvHeight: UP })); // the focus edge: held
    s.read(world({ editorFocused: false, vvHeight: 844 })); // the viewport agrees
    expect(s.writes.at(-1)).toEqual([0, 844]); // the final full height, not a stage of it
    expect(s.motions).toEqual(["glide", "step"]);
  });

  it("the raise is untouched: its own write still glides", () => {
    expect(raised().motions).toEqual(["glide"]);
  });

  it("a viewport-learned close steps too — one rule, whichever input taught it", () => {
    const s = raised();
    s.read(world({ editorFocused: true, vvHeight: 844 }));
    expect(s.motions).toEqual(["glide", "step"]);
  });

  it("no close animates the box, and none writes it twice", () => {
    for (const close of [
      [world({ editorFocused: false, vvHeight: UP }), world({ editorFocused: false, vvHeight: 844 })],
      [world({ editorFocused: true, vvHeight: 844 }), world({ editorFocused: false, vvHeight: 844 })],
      [world({ editorFocused: false, vvHeight: 844 })],
    ]) {
      const s = raised();
      for (const w of close) s.read(w);
      expect(s.motions.slice(1)).toEqual(["step"]); // past the raise's own glide
    }
  });

  it("the drop to the pin moves nothing, because the step already sat on it", () => {
    // the window ends about 470ms later and the vars go; if the step had landed
    // anywhere but the pin's own geometry, THAT frame would be the snap
    const s = raised();
    s.read(world({ editorFocused: false, vvHeight: UP }));
    s.read(world({ editorFocused: false, vvHeight: 844 }));
    expect(s.box()).toEqual([0, 844]); // the pin's geometry, written in full
    s.read(world({ editorFocused: false, vvHeight: 844 }), false);
    expect(s.box()).toEqual([null, null]);
  });
});

// Wiring pins for the wait. The decision is one line, so what needs holding
// down is where it sits: it must be read from the box that is actually applied
// and the viewport's own fresh inset, it must gate the box-drop branch and
// NOTHING else — the .kb class, the glide, the close's correction pass and the
// keyboard edge all still fire at the focus edge, which is what keeps a close
// feeling immediate — and it must add no clock, since a wait that could time
// out would resize twice again on exactly the closes this is for.
describe("wiring: the shell box waits for the viewport, and only the box does", () => {
  const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");

  it("read once per pass, from the applied box and the fresh inset", () => {
    expect(shell).toMatch(
      /const held = holdsShellBox\(\n\s*t\.kb,\n\s*appliedTop !== null \|\| appliedHeight !== null,\n\s*keyboardInset\(baseline, t\.vvHeight\),\n\s*\);/,
    );
    expect(shell.match(/holdsShellBox\(/g)).toHaveLength(2); // the definition and the call
  });

  it("it gates the drop alone: the keyboard-up branch writes from the viewport as before", () => {
    expect(shell).toMatch(
      /\} else if \(!held && \(appliedTop !== null \|\| appliedHeight !== null\)\) \{/,
    );
    expect(shell).toMatch(/const box = shellBox\(t\);\n\s*if \(box\) \{/);
  });

  it("the bar's own choreography is not held: the classes still turn at the focus edge", () => {
    expect(shell).toMatch(/appEl\.classList\.toggle\("kb", t\.kb\);/);
    expect(shell).toMatch(/appEl\.classList\.toggle\("gliding", gliding\);/);
    expect(shell).toMatch(/if \(wasUp && !t\.kb\) keyboardClosed\(\);/);
  });

  it("no clock and no latch: the wait is two live numbers, asked again every pass", () => {
    const decide = shell.slice(
      shell.indexOf("export function holdsShellBox"),
      shell.indexOf("// The DOM half"),
    );
    expect(decide).toMatch(
      /export function holdsShellBox\([\s\S]{0,160}return !kb && hasBox && inset > 0;\n\}/,
    );
    expect(shell).not.toMatch(/heldUntil|holdTimer|HOLD_MAX_MS|releaseHold/);
  });

  it("a held close says so on the trail, beside the window it armed", () => {
    expect(shell).toMatch(/function armGlide\(edge: "open" \| "close", held: boolean\): void \{/);
    expect(shell).toMatch(
      /holdDiagRecord\("kb-glide", held \? \{ edge, step, held \} : \{ edge, step \}\);/,
    );
    expect(shell).toMatch(/armGlide\(t\.kb \? "open" : "close", held\);/);
  });

  it("and the same line says the close's growth was one step, not a glide", () => {
    // the trail's own answer to "did this build's close travel", without which
    // a device session would have to infer it from the edge name and a version
    expect(shell).toMatch(/const step = edge === "close";/);
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

// Presentation pins for the glide's scoping: the box transition lives on
// .gliding.kb ALONE — the OPEN edge, since a close that travelled is the white
// band — so a raise glides, a close steps, and every mid-typing box write stays
// instant. The box vars must still survive into .gliding without .kb (the close
// holds its keyboard-era box, then writes the full screen into it), and the
// focusing class must key the same bar choreography as .kb.
describe("presentation — glide scoped to the open edge, focusing keys the choreography", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");

  it("only .gliding.kb carries the top/height transition, 0.2s ease-out", () => {
    expect(css).toMatch(
      /\n#app\.gliding\.kb \{\n  transition: top var\(--glide\), height var\(--glide\);\n\}/,
    );
    expect(css).toMatch(/\n#app \{[^}]*--glide: 0\.2s ease-out;/); // and that token IS the clock
    const kbRule = css.match(/\n#app\.kb \{([^}]*)\}/)?.[1] ?? "";
    expect(kbRule).toContain("--pad-b: 0.5rem"); // the keyboard hug is untouched
    expect(kbRule).not.toContain("transition"); // .kb alone never animates the box
    expect(kbRule).not.toContain("top:"); // the box moved to the shared rule below
    const appRule = css.match(/\n#app \{([^}]*)\}/)?.[1] ?? "";
    expect(appRule).not.toContain("transition"); // the rest pin stays inert
  });

  it("the close carries no box transition at all — .gliding without .kb animates nothing", () => {
    // the whole change, as one pin: every rule that transitions top or height
    // has to demand .kb, so the state a close is actually in cannot match one.
    // Without this the box could travel again from any rule added later, and
    // the 386px band would come back with it.
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
    // the animated property is the FIRST token of each transition entry, so a
    // max-height elsewhere in the sheet is not a shell box travelling
    const boxAnimators = [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) =>
        (m[2].match(/transition:([^;]*);/)?.[1] ?? "")
          .split(",")
          .some((entry) => ["top", "height"].includes(entry.trim().split(/\s+/)[0])),
      )
      .map((m) => m[1].trim());
    expect(boxAnimators).toEqual(["#app.gliding.kb"]);
  });

  it("the box vars apply under .kb and stay through .gliding, so the close has one to step", () => {
    // the four-edge pin has no height of its own to write the full screen into,
    // so the step is written INTO the numeric box and the vars must outlive .kb
    expect(css).toMatch(
      /#app\.kb,\n#app\.gliding \{\n  top: var\(--shell-top, 0px\);\n  height: var\(--shell-h, 100vh\);\n\}/,
    );
  });

  it("shell.ts arms the glide on the .kb edge alone and lets the window expire by clock", () => {
    expect(shell).toMatch(
      /if \(t\.kb !== appliedKb\) \{[\s\S]{0,80}armGlide\(t\.kb \? "open" : "close", held\)/,
    );
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
});

describe("focusComposerTap: the take-over, and everything it must not touch", () => {
  function tapped(over: { focused?: boolean; value?: string; at?: number | null } = {}) {
    const calls: string[] = [];
    const options: { preventScroll: boolean }[] = [];
    const carets: number[] = [];
    let measured = 0;
    const target = {
      focused: over.focused ?? false,
      value: over.value ?? "",
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

  it("only the composer's own textarea can reach the decision", () => {
    expect(handler).toMatch(
      /if \(!\(t instanceof HTMLTextAreaElement\) \|\| t\.id !== "text"\) return;/,
    );
  });

  it("the tap's own facts decide, read at the tap: focus state, contents, button", () => {
    expect(handler).toContain("focused: document.activeElement === t");
    expect(handler).toContain("value: t.value");
    expect(handler).toContain("e.button === 0");
    expect(handler).toContain("() => e.preventDefault()");
  });

  it("the caret is measured from the tap's own point and set on the box it was measured for", () => {
    // the event's coordinates, not a rect read later and not a stored one: the
    // finger is only in one place for the length of this handler
    expect(handler).toContain("caretAt: () => caretOffsetAt(t, e.clientX, e.clientY)");
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
