// The hand-back: what has to happen when the spring hold-off lets go PART WAY
// through a motion, and what must not happen when it lets go with no motion to
// give back.
//
// The hold-off freezes the field, and freeze() drops the arm, while arming only
// ever happened where a gesture BEGAN. So every state the hold-off covers used
// to eat the remainder of the gesture it crossed: the finger's own travel after
// a seat move, the momentum it had already thrown, and the whole first gesture
// after a resume. The wiring takes the gesture back instead, on evidence that
// the motion is the reader's, and re-opening takes a fresh baseline so the
// travel that passed while the springs read zero is never injected as one frame
// of scrolling.
//
// THE HAND-BACK IS SWITCHED OFF WITH THE REST OF IT (main.ts SPRING_ENABLED,
// the owner's call on 2026-09-15): nothing arms, so nothing has to be handed
// back. The field contract below is the module's own and is untouched; the
// wiring pins are the shape the switch holds off, except the ownership
// bookkeeping at the foot of this file, which is live code either way and is
// pinned as such. springoff.test.ts drives what ships.
//
// Two halves, because main.ts boots a real shell at import and cannot load
// under node (springscroll.test.ts says the same): the field contract the
// hand-back leans on is driven directly, and the wiring is source-pinned the
// way flight.test.ts and shift.test.ts pin theirs. What the wiring DECIDES —
// whose motion a scroll event is, and how long a gesture era lives — is
// behaviour, and it is tested as behaviour against the shipped helper in
// springown.test.ts rather than pinned as a spelling here.
//
// Synthetic throughout: no device, no browser, no recording, no real data.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TUNING, createSpringField } from "../src/springscroll";
import type { SpringField, SpringRow } from "../src/springscroll";

const src = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

const FRAME = 1000 / 60;
const TAU = TUNING.LAG_TAU_MS;
const CLIENT_H = 700;
const THREAD_TOP = 0;
const THUMB = 525; // screen-Y of the finger
const START = 1500; // scrollTop when the gesture opens

function makeRows(n = 60): SpringRow[] {
  const rows: SpringRow[] = [];
  let top = 0;
  for (let i = 0; i < n; i++) {
    rows.push({ top, height: 40 });
    top += 40 + (i % 2 === 0 ? 4 : 12);
  }
  return rows;
}

interface Drive {
  f: SpringField;
  rows: SpringRow[];
  now: number;
  scrollTop: number;
  fingerY: number;
}

/** what armSpring does: fresh geometry, open the gesture, first frame */
function open(d: Drive, held: boolean, anchorY: number | null): void {
  d.f.measure(d.rows);
  d.f.begin(CLIENT_H, THREAD_TOP, anchorY, held);
  d.f.frame(d.now, d.scrollTop); // the baseline frame
}

function fresh(): Drive {
  const d: Drive = {
    f: createSpringField(), rows: makeRows(), now: 0, scrollTop: START, fingerY: THUMB,
  };
  open(d, true, THUMB);
  return d;
}

/** a constant-speed finger drag: the scroll moves and the finger moves with it,
    which is what every touchmove does (anchor + a frame) */
function dragFor(d: Drive, speed: number, ms: number, dir: -1 | 1 = -1): void {
  for (let k = 0; k < Math.round(ms / FRAME); k++) {
    d.now += FRAME;
    d.scrollTop += dir * speed * FRAME;
    d.fingerY -= dir * speed * FRAME;
    d.f.anchor(d.fingerY);
    d.f.frame(d.now, d.scrollTop);
  }
}

/** the thread carrying on under its own momentum: no finger to re-anchor */
function coastFor(d: Drive, speed: number, ms: number, dir: -1 | 1 = -1): void {
  for (let k = 0; k < Math.round(ms / FRAME); k++) {
    d.now += FRAME;
    d.scrollTop += dir * speed * FRAME;
    d.f.frame(d.now, d.scrollTop);
  }
}

/** frames with the scroll standing still */
function stillFor(d: Drive, ms: number): void {
  for (let k = 0; k < Math.round(ms / FRAME); k++) {
    d.now += FRAME;
    d.f.frame(d.now, d.scrollTop);
  }
}

/** the hold-off's own interval: the springs read zero, the thread keeps moving,
    and no frame is driven (the pump is cancelled) */
function heldOff(d: Drive, px: number, ms: number): void {
  d.f.freeze();
  d.now += ms;
  d.scrollTop -= px;
  d.fingerY += px;
}

function biggest(m: Map<number, number>): number {
  return Math.max(0, ...[...m.values()].map(Math.abs));
}

describe("the field contract the hand-back leans on", () => {
  const SPEED = 0.5; // px/ms, an ordinary drag: steady lag is SPEED x TAU
  const STEADY = SPEED * TAU;

  it("a freeze drops the gesture, so frames alone can never bring the springs back", () => {
    // the defect's root: springFreeze -> field.freeze() clears isArmed, and
    // frame() returns immediately while unarmed. The pump can be woken all it
    // likes; without a re-open there is nothing to pump.
    const d = fresh();
    dragFor(d, SPEED, 200);
    expect(Math.abs(d.f.lag())).toBeGreaterThan(STEADY * 0.5);
    d.f.freeze();
    expect(d.f.armed()).toBe(false);
    dragFor(d, SPEED, 200); // the finger is still travelling
    expect(d.f.armed()).toBe(false);
    expect(d.f.lag()).toBe(0);
    expect(d.f.displacements().size).toBe(0);
  });

  it("re-opening on the finger brings them back and injects nothing that passed under the hold-off", () => {
    const d = fresh();
    dragFor(d, SPEED, 200);
    heldOff(d, 300, 400); // 300 px of drag crossed the hold-off
    open(d, true, d.fingerY);
    // the re-open's own frame is a baseline: a reading, never a delta
    expect(d.f.lag()).toBe(0);
    expect(d.f.displacements().size).toBe(0);
    // one frame of the SAME drag: the lag rises from zero at the rate the
    // relaxation allows. Reading the 300 px as one frame's travel would put it
    // past 200 px here (relaxLag of a 300 px step over a frame), which is the
    // shape of the abrupt shift this whole hand-back must not produce.
    d.now += FRAME;
    d.scrollTop -= SPEED * FRAME;
    d.fingerY += SPEED * FRAME;
    d.f.anchor(d.fingerY);
    d.f.frame(d.now, d.scrollTop);
    expect(Math.abs(d.f.lag())).toBeLessThan(STEADY);
    dragFor(d, SPEED, 200);
    expect(Math.abs(d.f.lag())).toBeGreaterThan(STEADY * 0.7);
    expect(Math.abs(d.f.lag())).toBeLessThan(STEADY * 1.3); // the drag's own value, nothing more
    expect(biggest(d.f.displacements())).toBeGreaterThan(0);
  });

  it("re-opening mid-coast tracks the momentum and still melts with it", () => {
    const d = fresh();
    dragFor(d, SPEED, 200);
    d.f.lift();
    coastFor(d, SPEED, 100);
    heldOff(d, 200, 300); // the hold-off opened and closed inside the coast
    open(d, false, d.fingerY); // no finger: the anchor it lifted from
    expect(d.f.lag()).toBe(0);
    coastFor(d, SPEED, 200);
    expect(Math.abs(d.f.lag())).toBeGreaterThan(STEADY * 0.7);
    expect(Math.abs(d.f.lag())).toBeLessThan(STEADY * 1.3);
    stillFor(d, 300); // the coast is over
    expect(d.f.lag()).toBe(0);
    expect(d.f.armed()).toBe(false); // the field ends its own gesture
    expect(d.f.active()).toBe(false); // and asks for no more frames
    expect(d.f.displacements().size).toBe(0);
  });

  it("a re-open with nothing moving writes nothing and hands itself back", () => {
    // what a stray wake-up must cost: an app write with no motion behind it
    // re-opens at most a baseline, displaces nothing, and disarms on the next
    // frame, so a wrong guess cannot leave a gesture standing open.
    const d: Drive = {
      f: createSpringField(), rows: makeRows(), now: 0, scrollTop: START, fingerY: THUMB,
    };
    open(d, false, null);
    stillFor(d, 2 * FRAME);
    expect(d.f.displacements().size).toBe(0);
    expect(d.f.lag()).toBe(0);
    expect(d.f.armed()).toBe(false);
    expect(d.f.active()).toBe(false);
  });

  it("the re-open carries the gesture's own anchor: the row under the finger is the one that stays", () => {
    const d = fresh();
    dragFor(d, SPEED, 200);
    heldOff(d, 120, 300);
    open(d, true, d.fingerY);
    dragFor(d, SPEED, 200);
    const disp = d.f.displacements();
    const atFinger = d.rows.findIndex(
      (r) => r.top + r.height > d.scrollTop + (d.fingerY - THREAD_TOP),
    );
    const near = Math.abs(disp.get(atFinger) ?? 0);
    const far = Math.abs(disp.get(atFinger - 8) ?? 0);
    expect(far).toBeGreaterThan(near);
  });
});

// --- the wiring, as far as a source read can pin it -------------------------
//
// main.ts boots a real shell at import and cannot load under node, so what is
// checked here is the CALL ORDER and the COMPLETENESS of the wiring — the two
// things a behavioural test of the helper cannot see. What the wiring's
// decision actually does to the rows is tested against the shipped helper and
// the shipped field in springown.test.ts, and end to end in a local browser
// against synthetic fixtures, outside this suite.
describe("main.ts wiring: the finger takes its own drag back, when the seam is on", () => {
  const finger = src.slice(
    src.indexOf("function springFinger("),
    src.indexOf("function liftSpring("),
  );

  it("the seam ships off, so this path returns before any of it", () => {
    expect(src).toMatch(/^const SPRING_ENABLED = false;$/m);
    expect(finger.split("\n")[1].trim().replace(/\s*\/\/.*$/, "")).toBe("if (!SPRING_ENABLED) return;");
  });

  it("a touchmove re-opens the gesture when the hold-off has let go, before it re-anchors", () => {
    expect(finger).toContain("if (!springField.armed() && !springBlocked()) armSpring(touchY, true);");
    // ... and in that order: the anchor and the pull belong to the re-opened
    // gesture, not to the one the freeze ended
    expect(finger.indexOf("armSpring(touchY, true)")).toBeLessThan(
      finger.indexOf("springField.anchor(touchY)"),
    );
    expect(finger).toContain("if (springField.armed()) springPump();");
  });

  it("it asks the hold-off first, so a keyboard, flight, shift or ride still holds it off", () => {
    // the only arming this path does is the guarded one: no second, bare call
    expect(finger.match(/armSpring\(/g)?.length).toBe(1);
    expect(finger.indexOf("!springBlocked()")).toBeLessThan(finger.indexOf("armSpring("));
  });
});

describe("main.ts wiring: the scroll handler asks springown.ts, in this order", () => {
  const handler = src.slice(
    src.indexOf("function springHandleScroll()"),
    src.indexOf("function armSpring("),
  );

  it("the event is credited BEFORE the hold-off's early return", () => {
    // Otherwise a motion of his stops being his the moment the app holds the
    // springs at zero, and the hand-back below has nothing left to recognise
    // when the hold-off lets go. This ordering is the mid-coast recovery.
    expect(handler.indexOf("springCreditsReader(run)")).toBeLessThan(
      handler.indexOf("if (springBlocked())"),
    );
    expect(handler).toContain("springFreeze();");
  });

  it("the clocks are read BEFORE this event re-stamps them", () => {
    // the question is whether this event CONTINUES a motion of his, so every
    // reading handed to the helper has to pre-date it
    const build = handler.indexOf("const run = {");
    expect(build).toBeGreaterThan(-1);
    expect(build).toBeLessThan(handler.indexOf("springMotionAt = now"));
    expect(handler).toMatch(/sinceAppWriteMs: now - springAppWroteAt,/);
    expect(handler).toMatch(/sinceScrollMs: now - lastScrollAt,/);
    expect(handler).toMatch(/sinceMotionMs: now - springMotionAt,/);
    expect(handler).toMatch(/armed: springField\.armed\(\),/);
    expect(handler).toMatch(/fingerDown: threadTouching,/);
  });

  it("the hold-off still comes before any arming, and the handler drives nothing itself", () => {
    expect(handler.indexOf("if (springBlocked())")).toBeLessThan(handler.indexOf("armSpring("));
    expect(handler).toContain("if (springTakesCoastBack(run)) armSpring(springTouchY, false);");
    expect(handler).not.toContain("springField.frame(");
    expect(handler).not.toContain("springField.begin(");
    expect(handler).not.toMatch(/scrollTop\s*=/);
    expect(handler).toContain("if (springField.armed()) springPump();");
  });

  it("the era is opened by a gesture on the thread and by nothing else", () => {
    const note = src.slice(
      src.indexOf("function noteThreadGesture()"),
      src.indexOf("}", src.indexOf("function noteThreadGesture()")),
    );
    expect(note).toContain("lastGestureAt = performance.now();");
    expect(note).toContain("springMotionAt = lastGestureAt;");
    const wheel = src.slice(
      src.indexOf('thread.addEventListener("wheel"'),
      src.indexOf('thread.addEventListener("scroll"'),
    );
    expect(wheel.match(/noteThreadGesture\(\);/g)?.length).toBe(2); // wheel and pointerdown
    const touch = src.slice(
      src.indexOf('thread.addEventListener(\n    "touchstart"'),
      src.indexOf("const endPeek = () =>"),
    );
    expect(touch.match(/noteThreadGesture\(\);/g)?.length).toBe(2); // touchstart and touchmove
    // Only a gesture and a credited scroll event may stamp the clock, and the
    // credited one is inside the handler above. Anything else stamping it is a
    // way for an era to exist that no reader opened.
    const stamps = src.match(/springMotionAt = (?!-Infinity)/g)?.length ?? 0;
    expect(stamps).toBe(2);
  });

  it("the era is cleared outright where it cannot survive, and lapses everywhere else", () => {
    for (const [from, to] of [
      ['thread.addEventListener("scrollend"', "tryApplyOlder();"], // the engine says so
      ["restTimer = setTimeout(() => {", "tryApplyOlder();"], // the rest debounce
      ["function resumeHidden()", "closeResumeWindow();"], // the page goes away
      ["springField.reset();", "springTouchY = null;"], // a fresh shell
    ] as const) {
      const at = src.indexOf(from);
      expect(at).toBeGreaterThan(-1);
      const body = src.slice(at, src.indexOf(to, at));
      expect(body).toContain("springMotionAt = -Infinity;");
    }
    // ... and the lapse itself needs no closer to run: -Infinity is the only
    // value that means "no era", and a stale clock reads the same way
    expect(src).toContain("let springMotionAt = -Infinity;");
  });
});

describe("main.ts wiring: every write of the app's own is declared as one", () => {
  // The completeness sweep, and the taxonomy under it. There are TWO
  // obligations here and they are not interchangeable.
  //
  //   DECLARING a write (noteSpringAppWrite, which springReseat calls for its
  //   own callers) refuses that write's scroll event any credit as the reader's
  //   travel. It is what stops a burst of the app's writes from being drawn as
  //   momentum, and it is all a write that moves the VIEW to a new end can
  //   offer: there is no reference to keep, the end really did move.
  //
  //   RESEATING carries the field's reference across the jump. A write that
  //   slides CONTENT under a still reader owes this as well, because an ARMED
  //   field reads the scroll position itself on its next frame and never asks
  //   the ownership helper anything — declared or not, the correction is one
  //   frame of travel to it, and every row on screen is thrown.
  //
  // So the sweep below insists every writer declares itself, and the two lists
  // after it say which obligation each writer has. What the difference DOES to
  // the rows is proved as behaviour in springpins.test.ts; nothing here is
  // evidence about an armed field.
  // ASSIGNMENT, not comparison: `=` only where no second `=` follows it, so a
  // writer that reads its own offset back to ask whether the write moved
  // anything (`t.scrollTop === before`) is not counted as a write itself. `==`,
  // `===` and `!==` are reads; `=`, `+=` and `-=` are the three ways this file
  // moves a scroller, and .scrollTo({...}) is the fourth.
  const WRITE = /^[^\n]*?\b\w+\.scrollTop\s*(?:=(?!=)|\+=|-=)[^\n]*$|^[^\n]*?\.scrollTo\(\{[^\n]*$/gm;
  const lines = src.split("\n");

  /** every scroll-offset write in main.ts, with the code that follows it (the
      comments stripped: a writer may explain itself before it declares) */
  function writers(): Array<{ at: number; line: string; after: string }> {
    const out: Array<{ at: number; line: string; after: string }> = [];
    for (const m of src.matchAll(WRITE)) {
      const line = m[0];
      if (line.includes("window.scrollTo")) continue; // the document, not a scroller
      if (line.trimStart().startsWith("//")) continue; // prose
      const at = src.slice(0, m.index).split("\n").length - 1;
      const after = lines
        .slice(at + 1, at + 20)
        .filter((l) => l.trim() !== "" && !l.trim().startsWith("//"))
        .slice(0, 3)
        .join("\n");
      out.push({ at, line, after });
    }
    return out;
  }

  it("every scroll-offset write in main.ts declares itself to the springs", () => {
    const missing = writers()
      .filter((w) => !w.after.includes("noteSpringAppWrite(") && !w.after.includes("springReseat("))
      .map((w) => `${w.at + 1}: ${w.line.trim()}`);
    expect(missing).toEqual([]);
    // the exact count, not a floor: a floor below the real number lets writers
    // be deleted without notice, and a new one has to be classified below
    expect(writers()).toHaveLength(11);
  });

  it("the pins that preserve content carry the reference, not just the note", () => {
    // Each of these corrects scrollTop by exactly what a change above the fold
    // cost, so that nothing on screen moves. The delta announced is read BACK
    // off the scroller, never the one asked for: the range can run out at
    // either end and the field must be told the move that happened.
    for (const [name, from, to] of [
      ["the profile reconcile", "function reconcileProfileArtifacts(", "\n}"],
      ["the lift padding", "function setLiftPad(", "\n}"],
      ["the older-page drain", "function drainOlder(", "\n}"],
      ["the keep-view fix", "function keepView(", "\n}"],
      ["the replay pin", "function applyReplay(", "\n}"],
    ] as const) {
      const at = src.indexOf(from);
      expect(at, name).toBeGreaterThan(-1);
      const body = src.slice(at, src.indexOf(to, at));
      expect(body, name).toMatch(/springReseat\(\s*\w+\.scrollTop - \w+\)/);
    }
  });

  it("the pins that move the view to a new end declare themselves and no more", () => {
    // The view really does go somewhere new here, so there is no reference to
    // carry and reseating one of these would be a lie about where the reader
    // is. They declare, and that is the whole obligation.
    for (const [name, from, to] of [
      ["the bottom pin", "function scrollToBottom(", "// the jump tap's glide"],
      ["the tail settle", "function settleTail(", "\n}"],
      ["the ride", "function startGlide(", "function blinkComposer("],
    ] as const) {
      const at = src.indexOf(from);
      expect(at, name).toBeGreaterThan(-1);
      const body = src.slice(at, src.indexOf(to, at));
      // Declared, and declared honestly. A write that lands the view somewhere
      // new declares with no argument at all. The one exception is a pin that
      // can be ASKED FOR on the end it is already on — the bottom pin, whose
      // instant write clamps to the position it started from — and it may say
      // so only from the offset read BACK off the scroller after the write.
      // A bare `noteSpringAppWrite(true)` here would be the lie this guard
      // exists to catch: a reference claimed across a jump that did happen.
      const notes = body.match(/noteSpringAppWrite\([^)]*\)/g) ?? [];
      expect(notes, name).not.toEqual([]);
      for (const note of notes) {
        expect(note, name).toMatch(/^noteSpringAppWrite\((?:|\w+\.scrollTop === \w+)\)$/);
      }
      expect(body, name).not.toContain("springReseat(");
    }
  });

  it("the springs' write clock is its own, and the follow flip's is untouched", () => {
    // appWroteAt credits the RESUME ride only, on purpose: resume.ts's
    // appOwnsScroll is what keeps the chevron's ride unfollowed and the
    // resume's followed. Folding the springs into it would change that
    // attribution, so they have a clock of their own that every write stamps.
    expect(src).toContain('if (owner === "resume") appWroteAt = performance.now();');
    expect(src.match(/appWroteAt = performance\.now\(\);/g)?.length).toBe(1);
    const noteAt = src.indexOf("function noteSpringAppWrite(");
    const note = src.slice(noteAt, src.indexOf("\n}", noteAt));
    expect(note).toContain("springAppWroteAt = performance.now();");
    // the ride is the app's for the springs whichever ride it is
    const ride = src.slice(src.indexOf("function startGlide("), src.indexOf("function blinkComposer("));
    expect(ride).toContain("noteSpringAppWrite();");
    expect(ride).not.toMatch(/if \([^)]*\) noteSpringAppWrite\(\);/);
  });

  it("a write inside the resume window drops the field, unless it carries the reference", () => {
    // the one place the window's own exposure is closed: the claim releases the
    // springs' hold-off for that window, so the writes in it that have no
    // reference to carry drop the field the way the hold-off does. What that
    // does to the rows is behaviour, and springclaim.test.ts drives it.
    const noteAt = src.indexOf("function noteSpringAppWrite(");
    const note = src.slice(noteAt, src.indexOf("\n}", noteAt));
    expect(note).toContain("if (!carried && resumeWindowOpen()) springFreeze();");
    const reseatAt = src.indexOf("function springReseat(");
    expect(src.slice(reseatAt, src.indexOf("\n}", reseatAt))).toContain("noteSpringAppWrite(true)");
  });
});

describe("main.ts wiring: the resume era's hold-off, and what the reader takes back", () => {
  const blocked = src.slice(
    src.indexOf("function springBlocked()"),
    src.indexOf("}", src.indexOf("function springBlocked()") + 200),
  );

  it("every app-owned motion is still read", () => {
    for (const signal of [
      "flightsUp > 0", // a send flight
      "airborneRows.size", // its rows
      "arrival !== null", // the arrival morph
      "glide !== null", // a scroll ride
      "glideRaf !== 0",
      "landingHold", // the resume landing
      "resumeWindowOpen()", // the resume window
      "shiftAnims.length", // a seat move / the receipt crossfade
      'app.classList.contains("kb")', // the keyboard lift
    ]) {
      expect(blocked).toContain(signal);
    }
  });

  it("only the resume pair yields to the reader's claim; a ride in the air never does", () => {
    expect(blocked).toContain("(!resumeClaimed && (landingHold || resumeWindowOpen()))");
    // the landing's RIDE is a scroll the app is writing, and the glide terms
    // hold it off whoever owns the era: they stand on their own, unclaimed
    expect(blocked).toMatch(/^\s*glide !== null \|\|$/m);
    expect(blocked).toMatch(/^\s*glideRaf !== 0 \|\|$/m);
    expect(blocked.match(/resumeClaimed/g)?.length).toBe(1);
  });

  it("the claim is bought with travel, and never outlives the era it was made in", () => {
    // Contact is not travel. noteThreadGesture is every gesture ACT on the
    // thread — a tap, a still hold and a sideways peek included — and it must
    // not claim; the three acts that carry travel do, through one function.
    // What each of them then does to the rows is behaviour, and
    // springclaim.test.ts drives it against the real seam.
    const note = src.slice(
      src.indexOf("function noteThreadGesture()"),
      src.indexOf("}", src.indexOf("function noteThreadGesture()")),
    );
    expect(note).not.toContain("resumeClaimed");
    const claimAt = src.indexOf("function claimResumeEra()");
    expect(claimAt).toBeGreaterThan(-1);
    expect(src.slice(claimAt, src.indexOf("}", claimAt))).toContain("resumeClaimed = true;");
    expect(src.match(/resumeClaimed = true;/g)?.length).toBe(1); // one writer of it
    // and its three callers: the wheel, a drag the app has decided is a scroll
    // rather than a peek, and a scroll event credited to the reader
    const wheel = src.slice(
      src.indexOf('thread.addEventListener("wheel"'),
      src.indexOf('thread.addEventListener("pointerdown"'),
    );
    expect(wheel).toContain("claimResumeEra();");
    const pointer = src.slice(
      src.indexOf('thread.addEventListener("pointerdown"'),
      src.indexOf('thread.addEventListener("scroll"'),
    );
    expect(pointer).not.toContain("claimResumeEra"); // a press is contact
    const touch = src.slice(
      src.indexOf('thread.addEventListener(\n    "touchstart"'),
      src.indexOf("const endPeek = () =>"),
    );
    expect(touch).toContain("if (!peeking) {\n"); // the direction verdict's own branch
    expect(touch.match(/claimResumeEra\(\);/g)?.length).toBe(1); // in that branch alone
    const seam = src.slice(
      src.indexOf("function springHandleScroll()"),
      src.indexOf("function armSpring("),
    );
    expect(seam).toMatch(/if \(springCreditsReader\(run\)\) \{[\s\S]*?claimResumeEra\(\);/);
    expect(src.match(/claimResumeEra\(\);/g)?.length).toBe(3);
    const openWin = src.slice(
      src.indexOf("function openResumeWindow()"),
      src.indexOf("function closeResumeWindow()"),
    );
    expect(openWin).toContain("resumeClaimed = false;"); // a finger down is not a claim
    // the two boundaries where a claim could go stale with no new era to reset
    // it: the page going away, and a shell rebuilt under an open window
    const hiddenAt = src.indexOf("function resumeHidden()");
    const hidden = src.slice(hiddenAt, src.indexOf("closeResumeWindow();", hiddenAt));
    expect(hidden).toContain("resumeClaimed = false;");
    const freshShell = src.slice(src.indexOf("springField.reset();"), src.indexOf("springTouchY = null;"));
    expect(freshShell).toContain("resumeClaimed = false;");
    // the window's other duties are untouched: nothing else reads the claim, so
    // the instant pins, the landing's arming and its end rules are as they were
    for (const fn of [
      ["function armResumeRide(", "function stopResumeRide()"],
      ["function stopResumeRide()", "// The window in which the app is still landing"],
      ["function resumeArrival()", "function resumeVisible()"],
      ["function scrollToBottom(", "// the jump tap's glide"],
    ] as const) {
      const body = src.slice(src.indexOf(fn[0]), src.indexOf(fn[1]));
      expect(body.length).toBeGreaterThan(50);
      expect(body).not.toContain("resumeClaimed");
    }
  });
});
