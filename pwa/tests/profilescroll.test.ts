// The profile reconcile's scroll correction, against the live scroll spring.
//
// Two independent things meet on this line. reconcileProfileArtifacts (main.ts)
// repaints the board artifacts from the store when health answers late, then
// corrects t.scrollTop by whatever height appeared or left above the reader's
// fold, so the row he is looking at does not move. The springy transcript reads
// t.scrollTop once per animation frame and stretches the rows by how fast the
// scroll is moving. A correction written while a finger is on the glass is not
// finger travel, and the springs have to be told so, the same way the
// older-page drain and the reconnect replay tell them (springReseat).
//
// Both blocks are cut out of main.ts by name and run together in ONE VM context,
// the way profile.test.ts does it, so what runs here is the app's own reconcile
// driving the app's own spring seam over the real field from springscroll.ts and
// the real end model from endspring.ts. Nothing about the fix is re-implemented
// in this file: the only thing the harness owns is the DOM underneath, a small
// geometric model of a thread: rows with real heights, a scrollTop the browser
// clamps to the range, and artifact rows that exist only while the profile draws
// them, which is what makes the correction necessary in the first place.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";
import { transformWithEsbuild } from "vite";
import { createEndSpring } from "../src/endspring";
import { springCreditsReader, springTakesCoastBack } from "../src/springown";
import { TUNING, createSpringField, relaxLag } from "../src/springscroll";
import type { SpringField } from "../src/springscroll";

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

// The seam's switch, read out of the file the seam is cut from. main.ts ships
// with the transcript spring OFF (the owner's call on 2026-09-15), and the last
// case in this file drives the reconcile exactly as it ships: it still holds the
// reader's row still, and nothing of the spring runs at all. Every other case
// forces the switch ON, because what they are about is what the correction owes
// an armed field, which is the machinery the switch holds off.
const SHIPPED_SPRING = /^const SPRING_ENABLED = (true|false);$/m.exec(main)?.[1] === "true";

function sourceBetween(start: string, end: string): string {
  const at = main.indexOf(start);
  const until = main.indexOf(end, at + start.length);
  expect(at, `missing ${start}`).toBeGreaterThanOrEqual(0);
  expect(until, `missing ${end}`).toBeGreaterThan(at);
  return main.slice(at, until);
}

let profileBlock = "";
let springBlock = "";
let gestureBlock = "";

// `profile`, `springField` and `springDirty` are lexical bindings, invisible
// from outside the script even though the functions beside them are not. The
// probe is appended INSIDE the same script, so the tests read the app's own
// state. `dirty` is settable because decorate(), the thing that marks the row
// table stale after every repaint, lives in a block this context does not cut,
// and the harness's rerender stands in for it.
const PROBE = `
globalThis.__probe = {
  get profile() { return profile; },
  field: springField,
  get dirty() { return springDirty; },
  set dirty(v) { springDirty = v; },
  get els() { return springEls; },
  get motionAt() { return springMotionAt; },
  set motionAt(v) { springMotionAt = v; },
  get appWroteAt() { return springAppWroteAt; },
};
`;

beforeAll(async () => {
  const ts = async (code: string, name: string) =>
    (await transformWithEsbuild(code, name, { loader: "ts" })).code;
  profileBlock = await ts(
    sourceBetween(
      "// --- which deployment shape is answering",
      "// finished-reply hold (hold.ts owns the state machine)",
    ),
    "profile.ts",
  );
  springBlock = await ts(
    sourceBetween(
      "// --- springy transcript (springscroll.ts owns the physics)",
      "// --- scrolling: glide when following the tail",
    ),
    "springseam.ts",
  );
  // the thread's own gesture note and the resume claim beside it: the seam
  // calls both, so they are cut rather than stubbed
  gestureBlock = await ts(
    sourceBetween(
      "// Every genuine gesture ON THE THREAD passes through here",
      "// Re-establish when the THREAD BOX resizes",
    ),
    "gesture.ts",
  );
});

// --- the thread the two blocks work on ---------------------------------------

const ROW_H = 70; // an ordinary two-line bubble
const GAP = 6; // the seat gap between rows
const SHOT_H = 620; // a board screenshot: a tall bubble on a phone
const PR_H = 44; // the pull-request card with its Publish button
const CLIENT_H = 800; // the thread's own box
const THREAD_TOP = 100; // its screen-Y: the reader's fold
const FRAME = 1000 / 60;
const COUNT = 30; // frames in the cached thread
const SHOT_SEQ = 2;
const PR_SEQ = 3;
// what a reveal of both artifacts adds above the fold, and a withhold takes away
const ARTIFACT_HEIGHT = SHOT_H + GAP + PR_H + GAP;

class FakeStyle {
  translate: string | undefined;
  removeProperty(name: string): void {
    if (name === "translate") this.translate = undefined;
  }
}

// one laid-out row (.evt > .row). The wrapper is display: contents, so the row
// is what both the reconcile's anchor walk and measureSpring actually read.
class FakeRow {
  readonly parentElement: { dataset: { seq: string } };
  readonly style = new FakeStyle();
  isConnected = true;
  top = 0; // content coordinate, kept by the harness's layout walk
  constructor(
    seq: number,
    readonly height: number,
    private readonly view: () => number,
  ) {
    this.parentElement = { dataset: { seq: String(seq) } };
  }
  get offsetTop(): number {
    return this.top;
  }
  get offsetHeight(): number {
    return this.height;
  }
  getBoundingClientRect(): { top: number; bottom: number; height: number } {
    const top = THREAD_TOP + this.top - this.view();
    return { top, bottom: top + this.height, height: this.height };
  }
  getAttribute(name: string): string {
    return name === "style" && this.style.translate ? `translate:${this.style.translate}` : "";
  }
  removeAttribute(): void {
    /* the fake carries no other attributes */
  }
}

interface HarnessOptions {
  /** run the same build with the announcement swallowed: the counterfactual */
  deaf?: boolean;
  /** the resume landing owns the thread's scroll (springBlocked) */
  resumeOwns?: boolean;
  /** the seam's own switch, ON unless a case says otherwise: these cases drive
      the machinery main.ts holds off. Pass SHIPPED_SPRING to drive what ships. */
  springEnabled?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const kind = new Map<number, string>();
  for (let seq = 1; seq <= COUNT; seq++) kind.set(seq, "done");
  kind.set(SHOT_SEQ, "screenshot");
  kind.set(PR_SEQ, "pr");
  const store = new Map<number, { seq: number; kind: string }>(
    [...kind].map(([seq, k]) => [seq, { seq, kind: k }]),
  );
  const height = (seq: number): number =>
    seq === SHOT_SEQ ? SHOT_H : seq === PR_SEQ ? PR_H : ROW_H;

  const rowFor = new Map<number, FakeRow>(); // the row each frame currently draws
  let contentH = 0;
  let scrollTop = 0;

  function laidOut(): FakeRow[] {
    const out: FakeRow[] = [];
    for (let seq = 1; seq <= COUNT; seq++) {
      const row = rowFor.get(seq);
      if (row) out.push(row);
    }
    return out;
  }

  // one layout pass: the rows sit in document order, each under the last
  function relayout(): void {
    let cursor = 0;
    for (const row of laidOut()) {
      row.top = cursor;
      cursor += row.height + GAP;
    }
    contentH = Math.max(cursor - GAP, 0);
  }

  const thread = {
    clientHeight: CLIENT_H,
    get scrollHeight(): number {
      return contentH;
    },
    get scrollTop(): number {
      return scrollTop;
    },
    set scrollTop(v: number) {
      // the browser clamps a scrollTop write to the range that exists; the
      // correction can ask for more than there is at either end
      scrollTop = Math.max(0, Math.min(v, Math.max(contentH - CLIENT_H, 0)));
    },
    getBoundingClientRect: () => ({ top: THREAD_TOP }),
    querySelectorAll: () => laidOut(),
  };

  // an ordinary frame always draws its row; an artifact frame draws one only
  // while the profile shows its kind (renderInto draws nothing for a withheld
  // kind, so there is no row in the DOM to measure)
  function paint(seq: number, show: boolean): void {
    if (show) rowFor.set(seq, new FakeRow(seq, height(seq), () => scrollTop));
    else rowFor.delete(seq);
  }
  for (let seq = 1; seq <= COUNT; seq++) paint(seq, kind.get(seq) === "done");
  relayout();

  // --- the frame pump's clock --------------------------------------------------
  let rafId = 0;
  let now = 0;
  const pending = new Map<number, (t: number) => void>();
  function runFrame(t: number): void {
    const due = [...pending.values()];
    pending.clear();
    for (const fn of due) fn(t);
  }

  const reseats: number[] = []; // every dy the reconcile hands the springs
  const pins: boolean[] = []; // the tail branch's shared bottom pin
  const ghosts: Array<[string, number]> = [];
  const rerendered: number[] = [];

  // the real field, with the announcement counted (and, for the counterfactual,
  // swallowed): the physics underneath is springscroll.ts's own
  function field(): SpringField {
    const real = createSpringField();
    return {
      ...real,
      reseat(dy: number): void {
        reseats.push(dy);
        if (!options.deaf) real.reseat(dy);
      },
    };
  }

  const context: Record<string, unknown> = {
    JSON,
    store,
    location: { host: "paratrooper.example" },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    document: { getElementById: (id: string) => (id === "thread" ? thread : null) },
    requestAnimationFrame: (fn: (t: number) => void) => {
      pending.set(++rafId, fn);
      return rafId;
    },
    cancelAnimationFrame: (id: number) => void pending.delete(id),
    // --- the reconcile's collaborators
    THREAD_ID: "default",
    CACHE_SCHEMA_VERSION: 1,
    suppressAnim: false,
    followTail: false,
    scrollToBottom: (force?: boolean) => {
      pins.push(force === true);
      thread.scrollTop = thread.scrollHeight; // the pin's write, clamped like any other
      // main.ts's own scrollToBottom notes its write to the springs beside this
      // line; the stub does the same so the seam sees the app's write clock move
      (context.noteSpringAppWrite as () => void)();
    },
    scrollGhostWrite: (tag: string, at: number) => void ghosts.push([tag, at]),
    // --- the spring seam's collaborators
    SPRING_ENABLED: options.springEnabled ?? true,
    createSpringField: field,
    createEndSpring,
    laidOutRows: () => laidOut(),
    // the ownership question the scroll seam asks, imported rather than
    // stubbed: what runs here is springown.ts itself
    springCreditsReader,
    springTakesCoastBack,
    performance: { now: () => now },
    lastGestureAt: 0, // the intent clock the follow flip reads (not this seam's)
    threadTouching: false, // a finger is on the thread (the touch handlers own it)
    lastScrollAt: 0, // stamped by the scroll listener AFTER the seam, as below
    resumeClaimed: false, // a gesture has taken this resume era back
    flightsUp: 0,
    airborneRows: new Set(),
    arrival: null,
    glide: null,
    glideRaf: 0,
    landingHold: false,
    resumeWindowOpen: () => options.resumeOwns === true,
    shiftAnims: [],
    app: { classList: { contains: () => false } },
  };

  // rerender(): the wrapper's children are replaced from the store, so an
  // artifact row is a NEW element and an ordinary row keeps its identity. The
  // filter asked is the app's own (rendersKind), and decorate()'s one lasting
  // effect on this seam (the row table is stale now) stands in for it.
  context.rerender = (seq: number) => {
    const m = store.get(seq);
    if (!m) return;
    rerendered.push(seq);
    paint(seq, (context.rendersKind as (k: string) => boolean)(m.kind));
    relayout();
    probe().dirty = true;
  };

  runInNewContext(`${profileBlock}\n${springBlock}\n${gestureBlock}\n${PROBE}`, context);

  function probe(): {
    profile: string | null;
    field: SpringField;
    dirty: boolean;
    els: FakeRow[];
    motionAt: number;
    appWroteAt: number;
  } {
    return context.__probe as {
      profile: string | null;
      field: SpringField;
      dirty: boolean;
      els: FakeRow[];
      motionAt: number;
      appWroteAt: number;
    };
  }

  const call = <A extends unknown[]>(name: string) =>
    context[name] as (...args: A) => void;

  return {
    thread,
    reseats,
    pins,
    ghosts,
    rerendered,
    profile: () => probe().profile,
    field: () => probe().field,
    scheduled: () => pending.size,
    follow: (v: boolean) => void (context.followTail = v),
    park: (at: number) => void (thread.scrollTop = at),
    /** health answers with a deployment shape (the reconcile's one entry point) */
    adopt: (word: string) => call<[unknown]>("adoptProfile")(word),
    arm: (touchY: number, fingerDown: boolean) =>
      call<[number | null, boolean]>("armSpring")(touchY, fingerDown),
    finger: (touchY: number) => call<[number]>("springFinger")(touchY),
    /** the scroller's own scroll event, which any write fires. main.ts's
        listener calls the seam and stamps lastScrollAt after it, so the seam
        always reads the PREVIOUS event's time; the same order here. */
    scrolled: () => {
      call<[]>("springHandleScroll")();
      context.lastScrollAt = now;
    },
    /** a finger arrives on or leaves the glass */
    touching: (v: boolean) => void (context.threadTouching = v),
    /** the hold-off: any motion the app owns is in flight (springBlocked).
        A seat move, which stands OUTSIDE the reader's resume claim, so a test
        that has already scrolled for real still meets a real hold-off. */
    block: (v: boolean) => void (context.shiftAnims = v ? [{}] : []),
    /** what every app write in main.ts says beside itself */
    note: () => call<[]>("noteSpringAppWrite")(),
    /** touchend: the finger leaves, and its momentum (if any) is still his */
    lift: () => call<[]>("liftSpring")(),
    /** the clock the seam reads, so a test can let a motion go quiet */
    wait: (ms: number) => void (now += ms),
    /** a gesture act on the thread, through the app's own one place for it */
    gesture: () => call<[]>("noteThreadGesture")(),
    /** the era's clock and the app's own write clock, as the seam holds them */
    era: () => probe().motionAt,
    wroteAt: () => probe().appWroteAt,
    /** one animation frame */
    tick: () => {
      now += FRAME;
      runFrame(now);
    },
    /** the row at the reader's fold: the one the reconcile anchors on */
    atFold: () => laidOut().find((row) => row.getBoundingClientRect().bottom > THREAD_TOP),
    /** the screen-Y of a row: what the reader actually sees move, or not */
    seen: (row: FakeRow | undefined) => row?.getBoundingClientRect().top ?? Number.NaN,
    /** the spring's displacement for one row, px: what is added on top of that */
    shift: (row: FakeRow | undefined) => {
      const i = probe().els.indexOf(row as FakeRow);
      return probe().field.displacements().get(i) ?? 0;
    },
    /** the largest translate any row is carrying this frame */
    worstRow: () => {
      let worst = 0;
      for (const dy of probe().field.displacements().values()) worst = Math.max(worst, Math.abs(dy));
      return worst;
    },
    /** how many rows carry an inline translate in the DOM right now */
    translated: () => probe().els.filter((el) => el.style.translate !== undefined).length,
  };
}

type Harness = ReturnType<typeof harness>;

// a finger dragging the thread, one 16 ms frame at a time. Returns where the
// finger got to, so a test can carry the same drag on through the correction.
function drag(h: Harness, frames: number, pxPerMs: number, fingerY = 500): number {
  h.touching(true);
  h.gesture(); // touchstart
  h.arm(fingerY, true);
  for (let i = 0; i < frames; i++) {
    h.thread.scrollTop += pxPerMs * FRAME;
    fingerY -= pxPerMs * FRAME; // the finger travels up as the content does
    h.gesture(); // touchmove
    h.finger(fingerY);
    h.scrolled();
    h.tick();
  }
  return fingerY;
}

describe("a profile reconcile while a finger is on the glass", () => {
  it("corrects the view without the springs reading the correction as travel", () => {
    const h = harness();
    h.park(900); // reading history, both artifacts withheld above the fold
    const finger = drag(h, 8, 0.5);
    const steady = h.field().lag();
    const worstBefore = h.worstRow();
    expect(Math.abs(steady)).toBeGreaterThan(15); // a real stretch is on screen
    const anchor = h.atFold(); // the row the reader is looking at
    const seenBefore = h.seen(anchor);
    const shiftBefore = h.shift(anchor);
    const scrollBefore = h.thread.scrollTop;

    h.adopt("pinboard"); // health answers, mid-drag
    h.scrolled();
    h.tick();

    // the reveal happened, the reader's row held both its seat and its identity,
    // and the springs were told once, with the delta the scroller actually took
    expect(h.profile()).toBe("pinboard");
    expect(h.rerendered).toEqual([SHOT_SEQ, PR_SEQ]);
    expect(h.thread.scrollTop).toBe(scrollBefore + ARTIFACT_HEIGHT);
    expect(h.atFold()).toBe(anchor); // the same element: nothing was re-ingested
    expect(h.seen(anchor)).toBe(seenBefore);
    expect(h.reseats).toEqual([ARTIFACT_HEIGHT]);
    // the frame after the correction reads no motion at all: the lag simply
    // carries on relaxing from where the drag left it. Measured on this harness,
    // 20.82 px of reference lag becomes 14.37 px, and the stretch the reader's
    // row is carrying eases from 14.23 px to 10.15 px, where unannounced the
    // same row is thrown out to 55.87 px (the case below).
    expect(h.field().lag()).toBeCloseTo(relaxLag(steady, 0, FRAME), 6);
    expect(h.worstRow()).toBeLessThanOrEqual(worstBefore);
    expect(Math.abs(h.shift(anchor))).toBeLessThanOrEqual(Math.abs(shiftBefore));

    // and the drag carries on through it as one continuous gesture
    let y = finger;
    for (let i = 0; i < 6; i++) {
      h.thread.scrollTop += 0.5 * FRAME;
      y -= 0.5 * FRAME;
      h.finger(y);
      h.scrolled();
      h.tick();
      expect(Math.abs(h.field().lag())).toBeLessThanOrEqual(Math.abs(steady) + 1);
      expect(h.worstRow()).toBeLessThanOrEqual(Math.abs(steady) + 1);
    }
  });

  it("without the announcement the same write is felt as a flick and throws the rows", () => {
    const deaf = harness({ deaf: true });
    deaf.park(900);
    drag(deaf, 8, 0.5);
    const steady = deaf.field().lag();
    const worstBefore = deaf.worstRow();
    const anchor = deaf.atFold();
    const shiftBefore = deaf.shift(anchor);

    deaf.adopt("pinboard");
    deaf.scrolled();
    deaf.tick();

    // the app announces the correction either way (the counted call below); this
    // harness is the one that throws the announcement away, and that is the whole
    // difference: 676 px of repaint read as one frame of finger travel takes the
    // reference lag from 20.82 px to 207.33 px, the worst row from 20.82 px to
    // 89.59 px, and the row the reader is looking at from 14.23 px to 55.87 px.
    expect(deaf.reseats).toEqual([ARTIFACT_HEIGHT]);
    expect(Math.abs(deaf.field().lag())).toBeGreaterThan(Math.abs(steady) * 3);
    expect(deaf.worstRow()).toBeGreaterThan(worstBefore * 3);
    expect(Math.abs(deaf.shift(anchor))).toBeGreaterThan(Math.abs(shiftBefore) * 3);
    expect(Math.abs(deaf.field().lag())).toBeLessThanOrEqual(TUNING.STRETCH_CAP_PX);
  });

  it("announces the delta the scroller took, not the one asked for, at the end of the range", () => {
    const h = harness();
    h.follow(true);
    h.adopt("pinboard"); // the first answer, parked at the tail: the shared pin
    expect(h.pins).toEqual([true]);
    expect(h.reseats).toEqual([]); // the bottom pin is not this path's write

    h.follow(false);
    h.park(500); // reading near the top, both artifacts drawn above the fold
    const finger = drag(h, 6, -0.4); // dragging back up towards the first message
    const steady = h.field().lag();
    const scrollBefore = h.thread.scrollTop;
    expect(Math.abs(steady)).toBeGreaterThan(10);
    expect(finger).toBeGreaterThan(500);
    expect(scrollBefore).toBeLessThan(ARTIFACT_HEIGHT); // less range left than the fix wants

    h.adopt("plain"); // a reconnect answers with the other deployment shape
    h.scrolled();
    h.tick();

    // the withhold takes 676 px out from above the fold, so the correction asks
    // for -676 and there is not that much scroll left: the scroller stops at the
    // top and the springs are told the 460 px it really moved, not the 676 px
    expect(h.thread.scrollTop).toBe(0);
    expect(h.reseats).toHaveLength(1);
    expect(h.reseats[0]).toBeGreaterThan(-ARTIFACT_HEIGHT);
    expect(h.reseats[0]).toBe(-scrollBefore);
    // and the difference is not injected as motion either: the lag keeps relaxing
    expect(h.field().lag()).toBeCloseTo(relaxLag(steady, 0, FRAME), 6);
  });
});

describe("a profile reconcile with no gesture live", () => {
  it("is invisible to the springs, which stay asleep: the ordinary boot case", () => {
    const h = harness();
    h.park(900);
    const anchor = h.atFold();
    const before = h.seen(anchor);

    h.adopt("pinboard"); // health answers a few seconds after the paint
    h.scrolled();

    expect(h.thread.scrollTop).toBe(900 + ARTIFACT_HEIGHT);
    expect(h.atFold()).toBe(anchor);
    expect(h.seen(anchor)).toBe(before); // the reader's row held its place
    expect(h.reseats).toEqual([ARTIFACT_HEIGHT]);
    expect(h.field().armed()).toBe(false);
    expect(h.field().active()).toBe(false);
    expect(h.field().lag()).toBe(0);
    expect(h.field().displacements().size).toBe(0);
    expect(h.translated()).toBe(0); // no row carries a transform
    expect(h.scheduled()).toBe(0); // and no frame was asked for
    expect(h.ghosts).toEqual([["profile-view", 900 + ARTIFACT_HEIGHT]]);
  });

  it("changes nothing while the resume landing owns the scroll", () => {
    const h = harness({ resumeOwns: true });
    h.park(900);
    h.arm(500, true); // a finger during the resume window: the seam holds off
    const anchor = h.atFold();
    const before = h.seen(anchor);

    h.adopt("pinboard");
    h.scrolled();
    h.tick();

    expect(h.thread.scrollTop).toBe(900 + ARTIFACT_HEIGHT);
    expect(h.seen(anchor)).toBe(before);
    expect(h.field().armed()).toBe(false); // the hold-off, not this path
    expect(h.field().lag()).toBe(0);
    expect(h.translated()).toBe(0);
  });

  it("leaves the tail's shared bottom pin to speak for itself", () => {
    // Following the tail, the position is scrollToBottom's: the same pin every
    // late height change in the app goes through, whose relationship with the
    // springs is its own everywhere it is used. This path adds no second account
    // of that write, with a finger on the glass or without one.
    const h = harness();
    h.follow(true);
    h.park(9999); // sitting at the tail, where a reader following it sits
    h.arm(500, true); // a finger resting on the glass
    h.tick();

    h.adopt("pinboard");
    h.scrolled();
    h.tick();

    expect(h.pins).toEqual([true]); // scrollToBottom owns that position
    expect(h.reseats).toEqual([]); // told once, or not at all: never twice
    expect(h.ghosts).toEqual([]); // and the correction branch never ran
    expect(h.thread.scrollTop).toBe(h.thread.scrollHeight - CLIENT_H);
  });
});

describe("a profile reconcile with no finger and no momentum anywhere", () => {
  // The reconcile is one of the app's writers, and the writers are what the
  // spring hand-back has to be able to refuse. Each case here leaves a gesture
  // era in the state an ordinary gesture leaves it, then drives the app's own
  // reconcile — the real function, the real write, the real seam — and asks
  // whether a single row moved. Synthetic DOM, synthetic clock: no browser.

  /** a tap: the thread is touched and released, and nothing scrolls */
  function tap(h: Harness): void {
    h.touching(true);
    h.gesture(); // touchstart -> noteThreadGesture
    h.arm(500, true);
    h.tick();
    h.touching(false); // touchend, with no scroll event in between
    h.lift();
    h.tick();
  }

  it("a tap, then the reconcile's correction, moves nothing", () => {
    const h = harness();
    h.park(900);
    tap(h);
    expect(h.field().armed()).toBe(false); // the tap's own gesture ended itself
    h.wait(1500); // he puts the phone down; nothing scrolls, so no closer runs

    h.adopt("pinboard"); // health answers: the artifacts appear above his fold
    h.scrolled();
    h.tick();

    expect(h.reseats).toEqual([ARTIFACT_HEIGHT]); // the correction still announced
    expect(h.field().armed()).toBe(false); // ... and no gesture was invented
    expect(h.field().lag()).toBe(0);
    expect(h.worstRow()).toBe(0);
    expect(h.translated()).toBe(0);
  });

  it("a tap, then the tail branch's unannounced bottom pin, moves nothing", () => {
    // the tail branch is deliberately left unannounced (the test above says
    // why), which is only safe while nothing can arm the springs without a
    // gesture of the reader's
    const h = harness();
    h.follow(true);
    h.park(9999);
    tap(h);
    h.wait(1500);

    h.adopt("pinboard");
    h.scrolled();
    h.tick();

    expect(h.pins).toEqual([true]); // the app's own pin ran
    expect(h.reseats).toEqual([]); // unannounced, as designed
    expect(h.field().armed()).toBe(false);
    expect(h.worstRow()).toBe(0);
    expect(h.translated()).toBe(0);
  });

  it("a run of the app's writes after a real drag has gone quiet moves nothing", () => {
    const h = harness();
    h.park(900);
    drag(h, 8, 0.5); // a genuine drag, with real scroll events
    h.touching(false); // and it ends
    h.block(true); // a hold-off crosses the end of it: the arm is dropped
    h.tick();
    h.block(false);
    expect(h.field().armed()).toBe(false);
    h.wait(1500); // the thread comes to rest

    // now the app writes this scroller at frame cadence, which is what every
    // box-animation settle burst in the app does
    for (let i = 0; i < 20; i++) {
      h.note();
      h.thread.scrollTop -= 6;
      h.scrolled();
      h.tick();
      expect(h.field().armed()).toBe(false);
      expect(h.worstRow()).toBe(0);
    }
    expect(h.translated()).toBe(0);
  });

  it("the era a gesture opened lapses on its own, with no closer anywhere", () => {
    // the defect this replaced needed a scroll event to close an era, and a
    // tap, a peek or a still hold produces none
    const h = harness();
    h.park(900);
    h.touching(true);
    h.gesture();
    h.touching(false);
    const opened = h.era();
    expect(Number.isFinite(opened)).toBe(true);
    h.wait(1500);
    // the clock has not been touched: it is the READING that has gone stale
    expect(h.era()).toBe(opened);
    h.note();
    h.thread.scrollTop -= 6;
    h.scrolled();
    h.tick();
    h.thread.scrollTop -= 6;
    h.scrolled();
    h.tick();
    expect(h.field().armed()).toBe(false);
    expect(h.worstRow()).toBe(0);
  });

  it("his own momentum across a hold-off that writes nothing is still taken back", () => {
    // the change this correction sits inside, kept: a coast the hold-off
    // crossed comes back to the springs on the reader's own evidence
    const h = harness();
    h.park(900);
    drag(h, 8, 0.5);
    h.touching(false); // touchend: the momentum is still his
    h.block(true); // a landing, a seat move, a keyboard edge — no writes
    for (let i = 0; i < 6; i++) {
      h.thread.scrollTop += 0.5 * FRAME;
      h.scrolled();
      h.tick();
    }
    h.block(false);
    expect(h.field().armed()).toBe(false); // the freeze dropped the gesture

    for (let i = 0; i < 10; i++) {
      h.thread.scrollTop += 0.5 * FRAME;
      h.scrolled();
      h.tick();
    }
    expect(h.field().armed()).toBe(true); // taken back on his coast
    expect(h.worstRow()).toBeGreaterThan(1);
    expect(h.reseats).toEqual([]); // nothing announced: this is a real scroll
  });
});

// --- and what actually ships --------------------------------------------------
describe("the reconcile as main.ts ships it: the switch is off", () => {
  it("still holds the reader's row still, with no field, no frame and no translate", () => {
    expect(SHIPPED_SPRING).toBe(false);
    const h = harness({ springEnabled: SHIPPED_SPRING });
    h.park(900);
    const finger = drag(h, 8, 0.5); // a real drag, through the real handlers
    const anchor = h.atFold();
    const seenBefore = h.seen(anchor);
    const scrollBefore = h.thread.scrollTop;

    h.adopt("pinboard"); // health answers, mid-drag
    h.scrolled();
    h.tick();

    // the correction is the feature next door and is untouched
    expect(h.profile()).toBe("pinboard");
    expect(h.thread.scrollTop).toBe(scrollBefore + ARTIFACT_HEIGHT);
    expect(h.seen(anchor)).toBe(seenBefore);
    // the spring is simply not there: nothing armed, nothing scheduled, nothing
    // written, and the announcement itself has nothing left to announce to
    expect(h.reseats).toEqual([]);
    expect(h.field().armed()).toBe(false);
    expect(h.field().lag()).toBe(0);
    expect(h.worstRow()).toBe(0);
    expect(h.translated()).toBe(0);
    expect(h.scheduled()).toBe(0);

    // and the rest of the drag, the lift and its momentum are the same nothing
    let y = finger;
    for (let i = 0; i < 6; i++) {
      h.thread.scrollTop += 0.5 * FRAME;
      y -= 0.5 * FRAME;
      h.finger(y);
      h.scrolled();
      h.tick();
    }
    h.touching(false);
    h.lift();
    for (let i = 0; i < 20; i++) {
      h.thread.scrollTop += 0.5 * FRAME;
      h.scrolled();
      h.tick();
    }
    expect(h.field().armed()).toBe(false);
    expect(h.worstRow()).toBe(0);
    expect(h.translated()).toBe(0);
    expect(h.scheduled()).toBe(0);
  });
});
