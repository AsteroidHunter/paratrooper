// Who owns a scroll event, tested as BEHAVIOUR: what the rows do.
//
// The failure this file exists for. The springs are armed by a gesture and the
// hold-off's freeze drops that arm, so the wiring has to be able to take a
// gesture back part way through a motion. The first version of that asked two
// questions — "did a gesture open an era" and "are scroll events still
// arriving" — and neither can tell the app's own writes from a coast. The app
// writes this scroller on every frame of a box animation, a cadence identical
// to momentum, and an era opened by a gesture that scrolled nothing (a tap, a
// sideways peek, a still hold, a pointer press) had no way to close. Put those
// two together and a burst of the app's own writes was drawn as the reader's
// travel, with no finger and no momentum anywhere.
//
// So the tests here drive the SHIPPED helper (springown.ts) and the SHIPPED
// field (springscroll.ts) through event timelines and assert on displacement in
// px. They do not assert how the predicate is spelt: a version that passes
// these by mirroring the source would still have to move the right rows on the
// right frames and none on the wrong ones.
//
// Synthetic throughout. No device, no browser, no recording, no real data: the
// clock, the scroller and the events are all made here, and the timings are the
// ones the wiring uses (one frame = 1000/60 ms). The real wiring's own call
// order is covered by the source pins in springrearm.test.ts, and end to end in
// a local browser outside the suite.
import { describe, expect, it } from "vitest";
import {
  SPRING_RUN_GAP_MS,
  springCreditsReader,
  springScrollIsAppWrite,
  springTakesCoastBack,
} from "../src/springown";
import { TUNING, createSpringField } from "../src/springscroll";
import type { SpringField, SpringRow } from "../src/springscroll";

const FRAME = 1000 / 60;
const CLIENT_H = 700;
const THREAD_TOP = 0;
const THUMB = 525;
const START = 4000;
const COAST = 0.5; // px/ms: an ordinary flick's momentum
const STEADY = COAST * TUNING.LAG_TAU_MS; // the lag that speed settles at

function makeRows(n = 200): SpringRow[] {
  const rows: SpringRow[] = [];
  let top = 0;
  for (let i = 0; i < n; i++) {
    rows.push({ top, height: 40 });
    top += 40 + (i % 2 === 0 ? 4 : 12);
  }
  return rows;
}

/**
 * The thread, its scroll handler's clocks, and the field — as the wiring holds
 * them. The three clocks are the ones main.ts keeps (`springAppWroteAt`,
 * `lastScrollAt`, `springMotionAt`); the two questions are the helper's, called
 * here exactly as the handler calls them.
 *
 * `closers` is the engine question. The app closes an era at `scrollend` where
 * the engine has one and on a 100 ms scroll-quiet debounce where it does not,
 * and BOTH of those need a scroll event to have happened. `closers: false` is
 * the worst case — an engine where neither ever runs — so anything that holds
 * there holds on both of the app's real branches.
 */
interface Thread {
  f: SpringField;
  rows: SpringRow[];
  now: number;
  scrollTop: number;
  fingerDown: boolean;
  blocked: boolean;
  closers: boolean;
  appWroteAt: number;
  lastScrollAt: number;
  motionAt: number;
  quietAt: number; // when the rest closer is due, if this engine has one
  frames: Array<{ t: number; rows: number; px: number }>;
}

function thread(closers = false): Thread {
  return {
    f: createSpringField(),
    rows: makeRows(),
    now: 10000,
    scrollTop: START,
    fingerDown: false,
    blocked: false,
    closers,
    appWroteAt: -Infinity,
    lastScrollAt: 0,
    motionAt: -Infinity,
    quietAt: Infinity,
    frames: [],
  };
}

/** springHandleScroll's contract: credit the event, then decide. */
function scrollEvent(d: Thread): void {
  const run = {
    sinceAppWriteMs: d.now - d.appWroteAt,
    sinceScrollMs: d.now - d.lastScrollAt,
    sinceMotionMs: d.now - d.motionAt,
    armed: d.f.armed(),
    fingerDown: d.fingerDown,
  };
  if (springCreditsReader(run)) d.motionAt = d.now;
  if (d.blocked) {
    d.f.freeze();
  } else if (springTakesCoastBack(run)) {
    // armSpring: fresh geometry, open on the anchor the momentum belongs to
    d.f.measure(d.rows);
    d.f.begin(CLIENT_H, THREAD_TOP, d.fingerDown ? THUMB : null, d.fingerDown);
  }
  d.lastScrollAt = d.now;
  if (d.closers) d.quietAt = d.now + SPRING_RUN_GAP_MS;
}

/** a gesture act on the thread: wheel, pointerdown, touchstart, touchmove.
    It arms no closer, because in the app none of them is armed from here: the
    rest debounce is scheduled inside the scroll listener and the engine's
    scrollend follows a scroll. That is the whole shape of the leak. */
function gestureAct(d: Thread): void {
  d.motionAt = d.now;
}

/** one animation frame. `move` is how far the scroller went and `by` is who
    moved it: the engine carrying the reader's motion, or the app writing. */
function frame(d: Thread, move = 0, by: "engine" | "app" | "none" = "none"): void {
  d.now += FRAME;
  if (d.closers && d.now >= d.quietAt) {
    d.quietAt = Infinity; // the app's own rest closer, where the engine allows one
    d.lastScrollAt = 0;
    d.motionAt = -Infinity;
  }
  if (by !== "none" && move !== 0) {
    d.scrollTop += move;
    if (by === "app") d.appWroteAt = d.now; // noteSpringAppWrite, at the write
    scrollEvent(d);
  }
  if (d.f.armed()) d.f.frame(d.now, d.scrollTop); // the pump
  const disp = d.f.displacements();
  const px = Math.max(0, ...[...disp.values()].map(Math.abs));
  d.frames.push({ t: d.now, rows: disp.size, px });
}

function run(d: Thread, ms: number, move = 0, by: "engine" | "app" | "none" = "none"): void {
  for (let k = 0; k < Math.round(ms / FRAME); k++) frame(d, move, by);
}

/** a flick: a finger drags the thread and lets go while it is still moving */
function flick(d: Thread, ms = 200): void {
  d.fingerDown = true;
  gestureAct(d); // touchstart
  d.f.measure(d.rows);
  d.f.begin(CLIENT_H, THREAD_TOP, THUMB, true);
  for (let k = 0; k < Math.round(ms / FRAME); k++) {
    gestureAct(d); // touchmove
    frame(d, -COAST * FRAME, "engine");
  }
  d.fingerDown = false;
  d.f.lift(); // touchend: the momentum is still his
}

/** what the app does on every frame of a box animation: settleTail,
    scrollToBottom(true), keepView, the lift pad, a ride — an instant write */
function appWrites(d: Thread, ms: number, perFrame = -6): void {
  run(d, ms, perFrame, "app");
}

function since(d: Thread, at: number): { spring: number; px: number } {
  const w = d.frames.filter((f) => f.t > at);
  return {
    spring: w.filter((f) => f.rows > 0).length,
    px: Math.round(Math.max(0, ...w.map((f) => f.px)) * 100) / 100,
  };
}

// ---------------------------------------------------------------------------

describe("a burst of the app's own writes is never the reader's travel", () => {
  // Each case leaves a gesture era in whatever state the gesture leaves it and
  // then runs the app's writes at frame cadence. Both engines: the one with a
  // working closer, and the one with none at all.
  for (const closers of [false, true]) {
    const engine = closers ? "with a rest closer" : "with no closer at all";

    it(`a tap, then a burst, moves nothing (${engine})`, () => {
      const d = thread(closers);
      d.fingerDown = true;
      gestureAct(d); // touchstart on the thread
      d.f.measure(d.rows);
      d.f.begin(CLIENT_H, THREAD_TOP, THUMB, true);
      d.fingerDown = false;
      d.f.lift();
      run(d, 60); // the tap scrolled nothing, so no scroll event ever arrives
      expect(d.f.armed()).toBe(false); // the field ended its own gesture
      run(d, 1500); // he puts the phone down
      const at = d.now;
      appWrites(d, 400);
      expect(since(d, at)).toEqual({ spring: 0, px: 0 });
    });

    it(`a sideways peek, which scrolls nothing, then a burst, moves nothing (${engine})`, () => {
      const d = thread(closers);
      d.fingerDown = true;
      gestureAct(d);
      for (let k = 0; k < 18; k++) {
        gestureAct(d); // touchmove: the peek preventDefaults the vertical scroll
        frame(d);
      }
      d.fingerDown = false;
      run(d, 1500);
      const at = d.now;
      appWrites(d, 400);
      expect(since(d, at)).toEqual({ spring: 0, px: 0 });
    });

    it(`a drag ending in a still hold, then a burst, moves nothing (${engine})`, () => {
      const d = thread(closers);
      flick(d, 150); // the drag scrolls: scroll events do arrive
      d.fingerDown = true;
      for (let k = 0; k < 14; k++) {
        gestureAct(d); // the finger rests on the glass and keeps reporting
        frame(d);
      }
      d.fingerDown = false;
      d.f.freeze(); // whatever the hold-off did, the arm is gone
      run(d, 1500);
      const at = d.now;
      appWrites(d, 400);
      expect(since(d, at)).toEqual({ spring: 0, px: 0 });
    });

    it(`writes that carry on after a hold-off wrote through his coast move nothing (${engine})`, () => {
      // the hardest case: a real flick, the app writing this scroller through
      // the hold-off, and the hold-off letting go while the writes carry on
      const d = thread(closers);
      flick(d);
      run(d, 100, -COAST * FRAME, "engine"); // genuine momentum
      d.blocked = true;
      appWrites(d, 400); // the app owns the scroll and is writing every frame
      d.blocked = false;
      const at = d.now;
      appWrites(d, 600); // ... and carries on after the hold-off lets go
      expect(since(d, at)).toEqual({ spring: 0, px: 0 });
    });

    it(`a burst with no gesture in the session moves nothing (${engine})`, () => {
      const d = thread(closers);
      run(d, 500);
      const at = d.now;
      appWrites(d, 600);
      expect(since(d, at)).toEqual({ spring: 0, px: 0 });
    });
  }

  it("scroll events alone cannot open an era: a platform restore is not a gesture", () => {
    // the engine putting a scroll position back on its own, which is a run of
    // ordinary scroll events with nothing of the app's in it either
    const d = thread();
    run(d, 200);
    const at = d.now;
    run(d, 500, -9, "engine");
    expect(since(d, at)).toEqual({ spring: 0, px: 0 });
  });

  it("isolated writes further apart than the run gap move nothing", () => {
    const d = thread();
    flick(d);
    run(d, 300, -COAST * FRAME, "engine"); // a genuine coast, then rest
    run(d, 400);
    const at = d.now;
    for (let k = 0; k < 8; k++) {
      frame(d, -300, "app");
      run(d, 200);
    }
    expect(since(d, at)).toEqual({ spring: 0, px: 0 });
  });

  it("a burst long after the thread came to rest moves nothing", () => {
    const d = thread();
    flick(d);
    run(d, 300, -COAST * FRAME, "engine");
    run(d, 2000);
    const at = d.now;
    appWrites(d, 600);
    expect(since(d, at)).toEqual({ spring: 0, px: 0 });
  });

  it("a finger on the glass never reaches this path: that drag is taken back on the finger", () => {
    const d = thread();
    d.fingerDown = true;
    gestureAct(d);
    d.f.freeze();
    const at = d.now;
    run(d, 300, -COAST * FRAME, "engine");
    expect(since(d, at)).toEqual({ spring: 0, px: 0 });
  });
});

describe("the reader's own momentum is still taken back", () => {
  it("a coast crossing a hold-off that writes nothing is taken back, and melts to rest", () => {
    const d = thread();
    flick(d);
    run(d, 100, -COAST * FRAME, "engine");
    d.blocked = true; // a keyboard edge, a seat move, a landing wait: no writes
    run(d, 250, -COAST * FRAME, "engine");
    d.blocked = false;
    expect(d.f.armed()).toBe(false); // the freeze dropped the gesture
    const at = d.now;
    run(d, 250, -COAST * FRAME, "engine");
    const back = since(d, at);
    expect(back.spring).toBeGreaterThan(8);
    expect(back.px).toBeGreaterThan(2);
    expect(Math.abs(d.f.lag())).toBeGreaterThan(STEADY * 0.7); // the coast's own value
    expect(Math.abs(d.f.lag())).toBeLessThan(STEADY * 1.3); // and nothing more
    run(d, 400); // the coast dies
    expect(d.f.lag()).toBe(0);
    expect(d.f.armed()).toBe(false);
    expect(d.f.displacements().size).toBe(0);
  });

  it("the re-open is a baseline: the travel held at zero is never injected", () => {
    const d = thread();
    flick(d);
    d.blocked = true;
    run(d, 300, -COAST * FRAME, "engine"); // ~150 px passed while the springs read zero
    d.blocked = false;
    const at = d.now;
    frame(d, -COAST * FRAME, "engine"); // the frame that takes it back
    frame(d, -COAST * FRAME, "engine"); // and the first frame of the re-opened gesture
    const first = since(d, at).px;
    expect(first).toBeLessThan(STEADY * 0.5); // a lag climbing from zero, not a step
    run(d, 250, -COAST * FRAME, "engine");
    expect(since(d, at).px).toBeGreaterThan(first);
  });

  it("an era survives a coast of any length: a slow three-second glide is still his", () => {
    const d = thread();
    flick(d);
    run(d, 2500, -0.2 * FRAME, "engine"); // a long, slow coast, no hold-off yet
    d.blocked = true;
    run(d, 200, -0.2 * FRAME, "engine");
    d.blocked = false;
    const at = d.now;
    run(d, 400, -0.2 * FRAME, "engine");
    expect(since(d, at).spring).toBeGreaterThan(8);
  });

  it("a write landing inside a frozen coast ends that era, and the momentum stays rigid", () => {
    // The second half of the cost, and the reason it is drawn here rather than
    // left to be discovered: one pin inside a run gap refuses credit to the
    // events around it, and with no credited event the era lapses — so a coast
    // the hold-off already dropped is not taken back after it. A pin while the
    // gesture is still ARMED costs nothing; this is only the frozen case.
    const d = thread();
    flick(d);
    d.blocked = true;
    run(d, 200, -COAST * FRAME, "engine");
    d.blocked = false;
    frame(d, -40, "app"); // a single pin lands in the middle of his momentum
    const at = d.now;
    run(d, 400, -COAST * FRAME, "engine");
    expect(since(d, at)).toEqual({ spring: 0, px: 0 });
    // and a fresh gesture is all it takes to get them back
    const again = d.now;
    d.fingerDown = true;
    gestureAct(d);
    d.f.measure(d.rows);
    d.f.begin(CLIENT_H, THREAD_TOP, THUMB, true);
    for (let k = 0; k < 12; k++) {
      gestureAct(d);
      frame(d, -COAST * FRAME, "engine");
    }
    expect(since(d, again).spring).toBeGreaterThan(4);
  });

  it("a stall longer than the run gap ends an unarmed coast's eligibility too", () => {
    // The same arithmetic, with no write in it at all, and the reason the
    // module says a LIMIT rather than a recovery guarantee. The era needs
    // evidence inside the run gap; a main thread that stops delivering for
    // longer than that leaves the next event outside it, and there is nothing
    // left to credit. The app's own scroll-jank diagnostics suspect exactly
    // this at the history drain. It fails toward no springs, which is the safe
    // direction, and it bites only while the field is already UNARMED.
    const d = thread();
    flick(d);
    d.blocked = true;
    run(d, 200, -COAST * FRAME, "engine");
    d.blocked = false;
    d.now += SPRING_RUN_GAP_MS + 20; // the main thread stops: no frames, no events
    const at = d.now;
    run(d, 400, -COAST * FRAME, "engine"); // the momentum is still running
    expect(since(d, at)).toEqual({ spring: 0, px: 0 });
  });

  it("... and a stall inside the gap does not: the same coast comes back", () => {
    const d = thread();
    flick(d);
    d.blocked = true;
    run(d, 200, -COAST * FRAME, "engine");
    d.blocked = false;
    d.now += 60; // a shorter stall, still inside the run gap
    const at = d.now;
    run(d, 400, -COAST * FRAME, "engine");
    expect(since(d, at).spring).toBeGreaterThan(8);
  });

  it("THE COST, stated: while the app writes every frame, a genuine coast is NOT taken back", () => {
    // Nothing here can tell a coast from a burst of writes at the same cadence,
    // and the springs stay handed back rather than guess. This is the price of
    // the case above it, and it is the right way round: a motion of his that
    // stays rigid is a missed animation, and the other way round throws rows
    // across the screen with no finger anywhere.
    const d = thread();
    flick(d);
    d.blocked = true;
    run(d, 200, -COAST * FRAME, "engine");
    d.blocked = false;
    const at = d.now;
    run(d, 400, -COAST * FRAME, "app"); // his momentum, with the app writing through it
    expect(since(d, at)).toEqual({ spring: 0, px: 0 });
  });
});

describe("the questions themselves", () => {
  it("an event inside the run gap of a write is the app's, and one outside it is not", () => {
    expect(springScrollIsAppWrite(0)).toBe(true);
    expect(springScrollIsAppWrite(SPRING_RUN_GAP_MS - 1)).toBe(true);
    expect(springScrollIsAppWrite(SPRING_RUN_GAP_MS)).toBe(false);
    expect(springScrollIsAppWrite(Infinity)).toBe(false);
  });

  it("credit needs BOTH: not the app's write, and a live era to belong to", () => {
    expect(springCreditsReader({ sinceAppWriteMs: Infinity, sinceMotionMs: 16 })).toBe(true);
    expect(springCreditsReader({ sinceAppWriteMs: 8, sinceMotionMs: 16 })).toBe(false);
    expect(springCreditsReader({ sinceAppWriteMs: Infinity, sinceMotionMs: Infinity })).toBe(false);
    // the era lapses on its own: no closer has to run for this to go false
    expect(springCreditsReader({ sinceAppWriteMs: Infinity, sinceMotionMs: SPRING_RUN_GAP_MS }))
      .toBe(false);
  });

  it("every term of the take-back is a veto on its own", () => {
    const live = {
      sinceAppWriteMs: Infinity,
      sinceScrollMs: 16,
      sinceMotionMs: 16,
      armed: false,
      fingerDown: false,
    };
    expect(springTakesCoastBack(live)).toBe(true);
    expect(springTakesCoastBack({ ...live, armed: true })).toBe(false);
    expect(springTakesCoastBack({ ...live, fingerDown: true })).toBe(false);
    expect(springTakesCoastBack({ ...live, sinceMotionMs: 400 })).toBe(false);
    expect(springTakesCoastBack({ ...live, sinceScrollMs: 400 })).toBe(false);
    expect(springTakesCoastBack({ ...live, sinceAppWriteMs: 20 })).toBe(false);
  });
});
