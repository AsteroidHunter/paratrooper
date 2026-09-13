// The app's two content-preserving pins, against the live scroll spring.
//
// A photo four screens back finishes decoding and its box takes the shape of
// the pixels that arrived; the keyboard's close lands and the thread's
// reachability padding comes back off. Neither is the reader moving. Both slide
// the content under him and both correct scrollTop by exactly what the change
// cost, so what he is looking at does not move by a pixel (main.ts keepView and
// setLiftPad, photofit.ts scrollFix, viewport.ts padShift).
//
// The springy transcript reads scrollTop once a frame and stretches the rows by
// how fast it is moving, so a correction written while a gesture is live is a
// whole screen of travel in one frame unless the field is told. DECLARING the
// write (noteSpringAppWrite) is not that: it refuses the write's scroll event
// credit, which is the answer for a field that is asleep, and says nothing at
// all to a field that is already armed, because an armed field reads the
// position itself. Carrying the reference across the jump (springReseat) is the
// other half, and these are the two pins that were missing it. The row table
// has to move with them too: it is a list of offsetTops read once per gesture,
// and both of these change every seat below them.
//
// The pins are cut out of main.ts by name and run in ONE VM context beside the
// spring seam, the way profilescroll.test.ts does it, so what runs here is the
// app's own keepView and setLiftPad driving the app's own spring seam over the
// real field from springscroll.ts. Nothing is re-implemented: the harness owns
// only the DOM underneath — a thread whose rows really do move when a row
// changes height or the padding lands, with a scrollTop the browser clamps to
// the range and re-clamps when the content shrinks under it.
//
// Synthetic throughout: no device, no browser, no recording, no real data, no
// photo. The two counterfactuals are labelled where they are built — a DEAF
// field (the announcement thrown away) and a STALE row table (the invalidation
// undone from the test). Both are what the app did before this change; neither
// is app code.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";
import { createEndSpring } from "../src/endspring";
import { FOLD_SLOP_PX, scrollFix } from "../src/photofit";
import { springCreditsReader, springTakesCoastBack } from "../src/springown";
import { TUNING, createSpringField, relaxLag, windowBounds } from "../src/springscroll";
import type { SpringField } from "../src/springscroll";
import { padShift } from "../src/viewport";

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

function sourceBetween(start: string, end: string): string {
  const at = main.indexOf(start);
  const until = main.indexOf(end, at + start.length);
  expect(at, `missing ${start}`).toBeGreaterThanOrEqual(0);
  expect(until, `missing ${end}`).toBeGreaterThan(at);
  return main.slice(at, until);
}

let springBlock = "";
let gestureBlock = "";
let keepViewBlock = "";
let liftPadBlock = "";

const PROBE = `
globalThis.__probe = {
  field: springField,
  get dirty() { return springDirty; },
  set dirty(v) { springDirty = v; },
  get els() { return springEls; },
  get motionAt() { return springMotionAt; },
  get appWroteAt() { return springAppWroteAt; },
};
`;

beforeAll(async () => {
  const { transformWithEsbuild } = await import("vite");
  const ts = async (code: string, name: string) =>
    (await transformWithEsbuild(code, name, { loader: "ts" })).code;
  springBlock = await ts(
    sourceBetween(
      "// --- springy transcript (springscroll.ts owns the physics)",
      "// --- scrolling: glide when following the tail",
    ),
    "springseam.ts",
  );
  gestureBlock = await ts(
    sourceBetween(
      "// Every genuine gesture ON THE THREAD passes through here",
      "// Re-establish when the THREAD BOX resizes",
    ),
    "gesture.ts",
  );
  keepViewBlock = await ts(
    sourceBetween("function keepView(row: HTMLElement", "/**\n * @param owner which ride this is"),
    "keepview.ts",
  );
  liftPadBlock = await ts(
    sourceBetween("let liftPad = 0;", "watchLiftLanding((up, lift) => {"),
    "liftpad.ts",
  );
});

// --- the thread the pins work on ---------------------------------------------

const ROW_H = 70; // an ordinary two-line bubble
const GAP = 2; // styles.css .thread gap
const BASE_PAD = 12; // the thread's own padding, before any lift
const CLIENT_H = 800;
const THREAD_TOP = 100; // the thread's screen-Y: the reader's fold
const FRAME = 1000 / 60;
const COUNT = 60;
const PHOTO_SEQ = 8;
const GUESSED_H = 293; // the 4:3 box a photo with no known size lays out in
const DECODED_H = 520; // the shape a portrait photo turns out to be
const GREW = DECODED_H - GUESSED_H;
const CHIP_H = 40; // the one-line chip an undecodable photo gives way to
const LIFT_PAD = 300; // the keyboard's reachability padding

class FakeStyle {
  translate: string | undefined;
  removeProperty(name: string): void {
    if (name === "translate") this.translate = undefined;
  }
}

class FakeRow {
  readonly style = new FakeStyle();
  top = 0; // content coordinate, kept by the harness's layout walk
  height: number;
  constructor(
    readonly seq: number,
    height: number,
    private readonly view: () => number,
  ) {
    this.height = height;
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
  /** the announcement swallowed: what a declared-but-unreseated pin left behind */
  deaf?: boolean;
  /** the row table left stale after the pin: what an un-invalidated pin left */
  stale?: boolean;
}

function harness(options: HarnessOptions = {}) {
  let padTop = BASE_PAD;
  let scrollTop = 0;
  let contentH = 0;
  const rows: FakeRow[] = [];
  for (let seq = 1; seq <= COUNT; seq++) {
    rows.push(new FakeRow(seq, seq === PHOTO_SEQ ? GUESSED_H : ROW_H, () => scrollTop));
  }

  const maxScroll = (): number => Math.max(contentH - CLIENT_H, 0);

  // one layout pass: the rows sit in document order under the thread's padding.
  // Content that shrinks under the offset takes the offset with it, which is
  // the engine's own clamp and not a write of anyone's.
  function relayout(): void {
    let cursor = padTop;
    for (const row of rows) {
      row.top = cursor;
      cursor += row.height + GAP;
    }
    contentH = cursor - GAP + BASE_PAD;
    if (scrollTop > maxScroll()) scrollTop = maxScroll();
  }
  relayout();

  const thread = {
    clientHeight: CLIENT_H,
    get scrollHeight(): number {
      return contentH;
    },
    get scrollTop(): number {
      return scrollTop;
    },
    set scrollTop(v: number) {
      scrollTop = Math.max(0, Math.min(v, maxScroll())); // the browser's clamp
    },
    scrollTo: (o: { top: number }) => void (thread.scrollTop = o.top),
    getBoundingClientRect: () => ({ top: THREAD_TOP }),
  };

  // --- the frame pump's clock --------------------------------------------------
  let rafId = 0;
  let now = 0;
  const pending = new Map<number, (t: number) => void>();

  const reseats: number[] = [];
  const ghosts: Array<[string, number]> = [];
  let kb = false;

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
    document: { getElementById: (id: string) => (id === "thread" ? thread : null) },
    requestAnimationFrame: (fn: (t: number) => void) => {
      pending.set(++rafId, fn);
      return rafId;
    },
    cancelAnimationFrame: (id: number) => void pending.delete(id),
    performance: { now: () => now },
    // --- the pins' collaborators, imported rather than stubbed
    scrollFix,
    FOLD_SLOP_PX,
    padShift,
    createSpringField: field,
    createEndSpring,
    springCreditsReader,
    springTakesCoastBack,
    laidOutRows: () => rows,
    scrollGhostWrite: (tag: string, at: number) => void ghosts.push([tag, at]),
    holdDiagRecord: () => {},
    followTail: false,
    // the shell element: its class is the keyboard's own hold-off signal, and
    // its style is where the lift padding lands (styles.css .thread reads it)
    app: {
      classList: { contains: (c: string) => c === "kb" && kb },
      style: {
        setProperty: (name: string, value: string) => {
          if (name !== "--lift-pad") return;
          padTop = BASE_PAD + parseFloat(value);
          relayout();
        },
      },
    },
    // --- the spring seam's collaborators
    lastGestureAt: 0,
    threadTouching: false,
    lastScrollAt: 0,
    resumeClaimed: false,
    flightsUp: 0,
    airborneRows: new Set(),
    arrival: null,
    glide: null,
    glideRaf: 0,
    landingHold: false,
    resumeWindowOpen: () => false,
    shiftAnims: [],
  };

  runInNewContext(
    `${springBlock}\n${gestureBlock}\n${keepViewBlock}\n${liftPadBlock}\n${PROBE}`,
    context,
  );

  function probe(): {
    field: SpringField;
    dirty: boolean;
    els: FakeRow[];
    motionAt: number;
    appWroteAt: number;
  } {
    return context.__probe as ReturnType<typeof probe>;
  }

  const call = <A extends unknown[]>(name: string) => context[name] as (...args: A) => void;

  return {
    thread,
    rows,
    reseats,
    ghosts,
    dirty: () => probe().dirty,
    wroteAt: () => probe().appWroteAt,
    field: () => probe().field,
    park: (at: number) => void (thread.scrollTop = at),
    follow: (v: boolean) => void (context.followTail = v),
    /** the keyboard's hold-off, as the app's own class carries it */
    keyboard: (up: boolean) => void (kb = up),
    arm: (touchY: number, fingerDown: boolean) =>
      call<[number | null, boolean]>("armSpring")(touchY, fingerDown),
    finger: (touchY: number) => call<[number]>("springFinger")(touchY),
    scrolled: () => {
      call<[]>("springHandleScroll")();
      context.lastScrollAt = now;
    },
    touching: (v: boolean) => void (context.threadTouching = v),
    /** a gesture act on the thread, through the app's own one place for it */
    gesture: () => call<[]>("noteThreadGesture")(),
    wait: (ms: number) => void (now += ms),
    tick: () => {
      now += FRAME;
      const due = [...pending.values()];
      pending.clear();
      for (const fn of due) fn(now);
    },
    /** the photo's own box change: what adoptPhotoBox hands keepView */
    photoDecoded: (to = DECODED_H) => {
      call<[FakeRow, () => void]>("keepView")(rows[PHOTO_SEQ - 1], () => {
        rows[PHOTO_SEQ - 1].height = to;
        relayout();
      });
      // SYNTHETIC COUNTERFACTUAL, not app behaviour: undo the invalidation the
      // pin now makes, which is the state the app left the table in before
      if (options.stale) probe().dirty = false;
    },
    /** the lift's landing: the thread's reachability padding (shell.ts) */
    liftPad: (px: number) => {
      call<[number]>("setLiftPad")(px);
      if (options.stale) probe().dirty = false;
    },
    row: (seq: number) => rows[seq - 1],
    seen: (row: FakeRow) => row.getBoundingClientRect().top,
    /** the row at the reader's fold: the one he is looking at */
    atFold: () => rows.find((r) => r.getBoundingClientRect().bottom > THREAD_TOP)!,
    /** the spring's displacement for one row, px */
    shift: (row: FakeRow) => probe().field.displacements().get(rows.indexOf(row)) ?? 0,
    /** the largest translate any row is carrying this frame */
    worstRow: () => {
      let worst = 0;
      for (const dy of probe().field.displacements().values()) worst = Math.max(worst, Math.abs(dy));
      return Math.round(worst * 100) / 100;
    },
    /** the rows the field is actually moving, by seq */
    moving: () => [...probe().field.displacements().keys()].map((i) => rows[i].seq).sort((a, b) => a - b),
    /** the rows that are IN the field's participation window right now, read
        off the layout as it stands: the answer a fresh row table would give */
    inWindow: () => {
      const [lo, hi] = windowBounds(thread.scrollTop, CLIENT_H, TUNING.PARTICIPATION_BUFFER_PX);
      return rows.filter((r) => r.top + r.height >= lo && r.top <= hi).map((r) => r.seq);
    },
    translated: () => rows.filter((r) => r.style.translate !== undefined).length,
  };
}

type Harness = ReturnType<typeof harness>;

/** a finger dragging the thread, one 16 ms frame at a time */
function drag(h: Harness, frames: number, pxPerMs: number, fingerY = 500): number {
  h.touching(true);
  h.gesture(); // touchstart
  h.arm(fingerY, true);
  for (let i = 0; i < frames; i++) {
    h.thread.scrollTop += pxPerMs * FRAME;
    fingerY -= pxPerMs * FRAME;
    h.gesture(); // touchmove
    h.finger(fingerY);
    h.scrolled();
    h.tick();
  }
  return fingerY;
}

// ---------------------------------------------------------------------------

describe("a photo's box changing shape while a finger is on the glass", () => {
  it("holds the reader's row still and hands the springs the delta the scroller took", () => {
    const h = harness();
    h.park(1400); // reading history, the photo's box above the fold
    drag(h, 8, 0.5);
    const steady = h.field().lag();
    expect(Math.abs(steady)).toBeGreaterThan(15); // a real stretch is on screen
    const anchor = h.atFold();
    const seenBefore = h.seen(anchor);
    const worstBefore = h.worstRow();
    const scrollBefore = h.thread.scrollTop;

    h.photoDecoded(); // img.onload -> adoptPhotoBox -> keepView, mid-drag

    // the correction happened, and the reader's row did not move by a pixel
    expect(h.thread.scrollTop).toBe(scrollBefore + GREW);
    expect(h.seen(anchor)).toBe(seenBefore);
    expect(h.reseats).toEqual([GREW]); // the delta the scroller actually took
    expect(h.ghosts.at(-1)).toEqual(["keep-view", scrollBefore + GREW]);

    h.scrolled();
    h.tick();
    // and the frame after it reads no motion at all: the lag simply carries on
    // relaxing from where the drag left it
    expect(h.field().lag()).toBeCloseTo(relaxLag(steady, 0, FRAME), 6);
    expect(h.worstRow()).toBeLessThanOrEqual(worstBefore);
    expect(h.field().armed()).toBe(true); // still one continuous gesture
  });

  it("declared but not reseated, the same pin is felt as a flick and throws the rows", () => {
    // SYNTHETIC COUNTERFACTUAL: the field's announcement is swallowed, which is
    // what a bare note beside the write left an armed field with
    const deaf = harness({ deaf: true });
    deaf.park(1400);
    drag(deaf, 8, 0.5);
    const steady = deaf.field().lag();
    const worstBefore = deaf.worstRow();

    deaf.photoDecoded();
    deaf.scrolled();
    deaf.tick();

    expect(deaf.reseats).toEqual([GREW]); // the app announced it either way
    expect(Math.abs(deaf.field().lag())).toBeGreaterThan(Math.abs(steady) * 3);
    expect(deaf.worstRow()).toBeGreaterThan(worstBefore * 2);
    expect(Math.abs(deaf.field().lag())).toBeLessThanOrEqual(TUNING.STRETCH_CAP_PX);
  });

  it("keeps the springs on the rows that are there now, not on the seats they left", () => {
    const h = harness();
    h.park(1400);
    drag(h, 8, 0.5);
    h.photoDecoded();
    h.scrolled();
    h.tick(); // the pump re-measures on this frame: the invalidation buys that

    expect(h.dirty()).toBe(false); // marked by the pin, cleared by the measure
    expect(h.moving()).toEqual(h.inWindow());
  });

  it("left stale, the same table moves the rows that USED to be there", () => {
    // SYNTHETIC COUNTERFACTUAL: the invalidation undone from the test. The
    // announcement is intact, so what this isolates is the row table alone.
    const stale = harness({ stale: true });
    stale.park(1400);
    drag(stale, 8, 0.5);
    stale.photoDecoded();
    stale.scrolled();
    stale.tick();

    expect(stale.dirty()).toBe(false); // never marked, so never re-measured
    expect(stale.moving()).not.toEqual(stale.inWindow());
    // the whole span is off by the height the photo gained: those rows really
    // sit 227 px further down than the table says, so the span the field picks
    // out of it is three rows below the one the reader is looking at
    expect(stale.moving()[0]).toBeGreaterThan(stale.inWindow()[0]);
    expect(stale.moving()[0] - stale.inWindow()[0]).toBe(Math.round(GREW / (ROW_H + GAP)));
  });

  it("writes nothing and says nothing when the change is below the fold", () => {
    const h = harness();
    h.park(120); // the photo's box is well below the reader's top edge here
    drag(h, 6, 0.4);
    const before = h.wroteAt();
    const scrollBefore = h.thread.scrollTop;
    const anchor = h.atFold();
    const seenBefore = h.seen(anchor);

    h.photoDecoded();

    // scrollFix answers zero: the reader can see this box change, and moving
    // the scroll under him is the last thing he wants
    expect(h.thread.scrollTop).toBe(scrollBefore);
    expect(h.reseats).toEqual([]);
    expect(h.wroteAt()).toBe(before); // no write, so nothing to declare
    expect(h.seen(anchor)).toBe(seenBefore);
    // the seats below it moved all the same, so the table is still marked
    expect(h.dirty()).toBe(true);
  });

  it("is invisible to the springs with no gesture live", () => {
    const h = harness();
    h.park(1400);
    const anchor = h.atFold();
    const seenBefore = h.seen(anchor);

    h.photoDecoded();
    h.scrolled();
    h.tick();

    expect(h.seen(anchor)).toBe(seenBefore);
    expect(h.field().armed()).toBe(false);
    expect(h.field().lag()).toBe(0);
    expect(h.field().displacements().size).toBe(0);
    expect(h.translated()).toBe(0);
  });
});

describe("the keyboard's reachability padding", () => {
  it("the open lands with the hold-off on, so there is nothing armed to carry", () => {
    const h = harness();
    h.park(1400);
    h.keyboard(true); // shell.ts applies .kb at the viewport's own edge
    drag(h, 4, 0.5); // a finger cannot arm through the hold-off
    expect(h.field().armed()).toBe(false);
    const before = h.wroteAt();

    h.liftPad(LIFT_PAD); // the open's landing (shell.ts watchLiftLanding)

    expect(h.wroteAt()).toBeGreaterThan(before); // declared all the same
    expect(h.reseats).toEqual([LIFT_PAD]);
    expect(h.field().armed()).toBe(false);
    expect(h.field().displacements().size).toBe(0);
  });

  it("the close lands with the hold-off already gone, and holds the reader's row", () => {
    const h = harness();
    h.park(1400);
    h.keyboard(true);
    h.liftPad(LIFT_PAD); // the open landed while the keyboard was up
    h.keyboard(false); // .kb comes off at the viewport's edge, BEFORE the landing
    const finger = drag(h, 8, 0.5); // he reads while the bar glides home
    expect(h.field().armed()).toBe(true);
    const steady = h.field().lag();
    expect(Math.abs(steady)).toBeGreaterThan(15);
    const anchor = h.atFold();
    const seenBefore = h.seen(anchor);
    const worstBefore = h.worstRow();
    const scrollBefore = h.thread.scrollTop;
    h.reseats.length = 0;

    h.liftPad(0); // the close's landing, mid-drag

    expect(h.thread.scrollTop).toBe(scrollBefore - LIFT_PAD);
    expect(h.seen(anchor)).toBe(seenBefore); // nothing on screen moved
    expect(h.reseats).toEqual([-LIFT_PAD]);

    h.scrolled();
    h.tick();
    expect(h.field().lag()).toBeCloseTo(relaxLag(steady, 0, FRAME), 6);
    expect(h.worstRow()).toBeLessThanOrEqual(worstBefore);
    expect(h.moving()).toEqual(h.inWindow()); // and on the seats they are at now
    // the drag carries on through it as one gesture
    let y = finger;
    for (let i = 0; i < 5; i++) {
      h.thread.scrollTop += 0.5 * FRAME;
      y -= 0.5 * FRAME;
      h.finger(y);
      h.scrolled();
      h.tick();
      expect(h.worstRow()).toBeLessThanOrEqual(Math.abs(steady) + 1);
    }
  });

  it("declared but not reseated, the close's padding throws the rows", () => {
    // SYNTHETIC COUNTERFACTUAL, as above
    const deaf = harness({ deaf: true });
    deaf.park(1400);
    deaf.keyboard(true);
    deaf.liftPad(LIFT_PAD);
    deaf.keyboard(false);
    drag(deaf, 8, 0.5);
    const steady = deaf.field().lag();
    const worstBefore = deaf.worstRow();

    deaf.liftPad(0);
    deaf.scrolled();
    deaf.tick();

    expect(Math.abs(deaf.field().lag())).toBeGreaterThan(Math.abs(steady) * 3);
    expect(deaf.worstRow()).toBeGreaterThan(worstBefore * 2);
  });

  it("announces the delta the scroller took when the range runs out", () => {
    // near the top with the keyboard up there is less scroll above him than the
    // padding about to leave, so padShift floors and the view DOES move: what
    // the springs are told is the move that happened, not the one asked for
    const h = harness();
    h.keyboard(true);
    h.liftPad(LIFT_PAD); // the open's landing
    h.park(90); // inside the padding's own height
    h.keyboard(false); // .kb off at the edge; the close's landing is still to come
    const finger = drag(h, 4, -0.4);
    expect(finger).toBeGreaterThan(500);
    const steady = h.field().lag();
    expect(Math.abs(steady)).toBeGreaterThan(5);
    const scrollBefore = h.thread.scrollTop;
    expect(scrollBefore).toBeLessThan(LIFT_PAD);
    h.reseats.length = 0;

    h.liftPad(0);

    expect(h.thread.scrollTop).toBe(0);
    expect(h.reseats).toEqual([-scrollBefore]); // not the -300 asked for
    h.scrolled();
    h.tick();
    // and the difference is not injected as motion either: the lag relaxes
    expect(h.field().lag()).toBeCloseTo(relaxLag(steady, 0, FRAME), 6);
  });
});
