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
// Two halves, because main.ts boots a real shell at import and cannot load
// under node (springscroll.test.ts says the same): the field contract the
// hand-back leans on is driven directly, and the wiring is source-pinned the
// way flight.test.ts and shift.test.ts pin theirs.
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

// --- the wiring, source-pinned (main.ts boots a shell at import) -------------
describe("main.ts wiring: the finger takes its own drag back", () => {
  const finger = src.slice(
    src.indexOf("function springFinger("),
    src.indexOf("function liftSpring("),
  );

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

describe("main.ts wiring: a coast is taken back only on the reader's own evidence", () => {
  const handler = src.slice(
    src.indexOf("function springHandleScroll()"),
    src.indexOf("function armSpring("),
  );

  it("the hold-off is still the first thing the scroll handler asks", () => {
    expect(handler.indexOf("if (springBlocked())")).toBeLessThan(handler.indexOf("armSpring("));
    expect(handler).toContain("springFreeze();");
  });

  it("it re-opens only with no finger, an open gesture era, and scroll events still arriving", () => {
    expect(handler).toContain("!springField.armed() &&");
    expect(handler).toContain("!threadTouching &&"); // a finger takes its own drag back
    expect(handler).toContain("springGestureEra &&"); // his gesture started this motion
    expect(handler).toContain("performance.now() - lastScrollAt < SPRING_RUN_GAP_MS");
    expect(handler).toContain("armSpring(springTouchY, false);"); // the anchor the momentum belongs to
  });

  it("it still drives nothing itself and still pumps only an open gesture", () => {
    expect(handler).not.toContain("springField.frame(");
    expect(handler).not.toContain("springField.begin(");
    expect(handler).not.toMatch(/scrollTop\s*=/);
    expect(handler).toContain("if (springField.armed()) springPump();");
  });

  it("the era is opened by every genuine gesture on the thread, and by nothing else", () => {
    const note = src.slice(
      src.indexOf("function noteThreadGesture()"),
      src.indexOf("}", src.indexOf("function noteThreadGesture()")),
    );
    expect(note).toContain("lastGestureAt = performance.now();");
    expect(note).toContain("springGestureEra = true;");
    const wheel = src.slice(
      src.indexOf('thread.addEventListener("wheel"'),
      src.indexOf('thread.addEventListener("scroll"'),
    );
    expect(wheel).toContain("noteThreadGesture();"); // wheel and pointerdown
    expect(wheel.match(/noteThreadGesture\(\);/g)?.length).toBe(2);
    const touch = src.slice(
      src.indexOf('thread.addEventListener(\n    "touchstart"'),
      src.indexOf("const endPeek = () =>"),
    );
    expect(touch.match(/noteThreadGesture\(\);/g)?.length).toBe(2); // touchstart and touchmove
    // the era is a gesture's, so nothing else may open one
    expect(src.match(/springGestureEra = true;/g)?.length).toBe(1);
  });

  it("the era closes where the thread comes to rest, where the page goes away, and with a fresh shell", () => {
    const endAt = src.indexOf('thread.addEventListener("scrollend"');
    const scrollend = src.slice(endAt, src.indexOf("});", endAt));
    expect(scrollend).toContain("springGestureEra = false;");
    const debounce = src.slice(
      src.indexOf("restTimer = setTimeout(() => {"),
      src.indexOf('if (hasScrollend) {'),
    );
    expect(debounce).toContain("springGestureEra = false;");
    const hidden = src.slice(
      src.indexOf("function resumeHidden()"),
      src.indexOf("function resumeHidden()") + 600,
    );
    expect(hidden).toContain("springGestureEra = false;");
    const freshShell = src.slice(
      src.indexOf("springField.reset();"),
      src.indexOf("replyHold.reset();"),
    );
    expect(freshShell).toContain("springGestureEra = false;");
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

  it("the claim is a gesture's, is fresh for each resume era, and is read by the hold-off alone", () => {
    const note = src.slice(
      src.indexOf("function noteThreadGesture()"),
      src.indexOf("}", src.indexOf("function noteThreadGesture()")),
    );
    expect(note).toContain("resumeClaimed = true;");
    const openWin = src.slice(
      src.indexOf("function openResumeWindow()"),
      src.indexOf("function closeResumeWindow()"),
    );
    expect(openWin).toContain("resumeClaimed = threadTouching;"); // a finger already down owns it
    // the window's other duties are untouched: nothing else reads the claim, so
    // the instant pins, the landing's arming and its end rules are as they were
    for (const fn of [
      ["function closeResumeWindow()", "function resumeArrival()"],
      ["function armResumeRide(", "function stopResumeRide()"],
      ["function stopResumeRide()", "// The window in which the app is still landing"],
      ["function resumeArrival()", "function resumeVisible()"],
      ["function scrollToBottom(", "// the jump tap's glide"],
    ] as const) {
      const body = src.slice(src.indexOf(fn[0]), src.indexOf(fn[1]));
      expect(body.length).toBeGreaterThan(50);
      expect(body).not.toContain("resumeClaimed");
    }
    // declared once, set in the two places above, read by the hold-off, named
    // in the hold-off's own note: a claim that spreads is a claim nobody owns
    expect(src.match(/resumeClaimed/g)?.length).toBeLessThanOrEqual(5);
  });
});
