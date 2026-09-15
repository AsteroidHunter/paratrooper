// The transcript spring is OFF, and this file is what says so.
//
// The owner's call on 2026-09-15: "turn spring animation for message bubbles
// completely off". The bubbles are to sit still in the thread, the thread is to
// scroll the way the browser scrolls it, nothing is to trail the finger and
// nothing is to ease back when it stops. main.ts carries one switch above the
// seam (SPRING_ENABLED) and every entry point of the seam returns on it.
//
// Two halves, and the second is the one that matters. First the switch itself
// and the shape of the guards, pinned as source the way the rest of the seam's
// wiring is pinned (main.ts boots a real shell at import and cannot load under
// node). Then the seam is lifted out of main.ts WITH ITS OWN SWITCH LINE and
// run: a real drag, a lift, its momentum, a wheel, a pinned insert and a freeze
// go through the app's own armSpring, springFinger, liftSpring, springReseat and
// springHandleScroll over the real field from springscroll.ts and the real end
// model from endspring.ts, and nothing about any of it moves a row, asks for a
// frame, or so much as reads the DOM.
//
// The machinery the switch holds off is still exercised, deliberately, in
// springclaim.test.ts, springpins.test.ts and profilescroll.test.ts: each of
// those forces the switch on and ends with a case driving what ships.
//
// Synthetic throughout: no device, no browser, no recording, no real data.
import { readFileSync, readdirSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";
import { createEndSpring } from "../src/endspring";
import { springCreditsReader, springTakesCoastBack } from "../src/springown";
import { createSpringField } from "../src/springscroll";
import type { SpringField } from "../src/springscroll";

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

const SWITCH_LINE = /^const SPRING_ENABLED = (?:true|false);$/m.exec(main)?.[0] ?? "";
const SEAM_MARK = "// --- springy transcript (springscroll.ts owns the physics)";

/** the body of a top-level function in main.ts, from its brace to the end of
    the file: enough to read the statements it opens with */
function bodyOf(name: string): string {
  const at = main.indexOf(`function ${name}(`);
  expect(at, `missing ${name}`).toBeGreaterThanOrEqual(0);
  return main.slice(main.indexOf("{", at) + 1);
}

/** the first n statements of that body, comments and indentation stripped */
function opens(name: string, n = 1): string[] {
  return bodyOf(name)
    .split("\n")
    .slice(1, 1 + n)
    .map((line) => line.trim().replace(/\s*\/\/.*$/, ""));
}

// --- the switch ---------------------------------------------------------------

describe("the switch main.ts ships", () => {
  it("is declared once, is off, and says whose call it was", () => {
    expect(SWITCH_LINE).toBe("const SPRING_ENABLED = false;");
    expect(main.match(/^const SPRING_ENABLED = /gm)).toHaveLength(1);
    const note = main.slice(main.indexOf("// --- the transcript spring, OFF"), main.indexOf(SWITCH_LINE));
    expect(note).toContain("2026-09-15");
  });

  it("sits above the seam, which is lifted out of this file by the comment below it", () => {
    const sw = main.indexOf(SWITCH_LINE);
    const seam = main.indexOf(SEAM_MARK);
    expect(sw).toBeGreaterThan(-1);
    expect(seam).toBeGreaterThan(sw);
    expect(main.indexOf("const springField = createSpringField();")).toBeGreaterThan(seam);
  });

  it("every way into the seam returns on it, before anything else happens", () => {
    for (const fn of [
      "measureSpring", // no geometry is read
      "applySpring", // no row is written
      "springPump", // no frame is asked for
      "springFreeze", // nothing to zero
      "armSpring", // no gesture opens on the field
      "springFinger", // a travelling finger moves the scroller and nothing else
      "liftSpring", // a lift leaves nothing to settle
    ]) {
      expect(opens(fn), fn).toEqual(["if (!SPRING_ENABLED) return;"]);
    }
    // the one exception, and why: the pinned inserts' helper declares the app's
    // write first, because that clock is read by the ownership rules and is not
    // the effect (springown.ts). The field half of it returns with the rest.
    expect(opens("springReseat", 2)).toEqual([
      "noteSpringAppWrite(true);",
      "if (!SPRING_ENABLED) return;",
    ]);
  });

  it("the one writer of a row's displacement is inside the guarded apply, and there is no other", () => {
    const apply = main.slice(main.indexOf("function applySpring()"), main.indexOf("function springPump"));
    expect(apply).toContain("el.style.translate = px;");
    expect(main.match(/\.style\.translate\s*=/g)).toHaveLength(1);
    // and no other module in the app writes one either
    const dir = new URL("../src/", import.meta.url);
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "main.ts")) {
      const src = readFileSync(new URL(file, dir), "utf8");
      expect(src, file).not.toMatch(/\.style\.translate\s*=/);
    }
  });

  it("leaves the swipe-to-peek alone: a different property, a different feature", () => {
    expect(main).toContain('thread.style.setProperty("--peek"');
    expect(styles).toContain("transform: translateX(var(--peek, 0px));");
  });
});

// --- the seam, run as it ships ------------------------------------------------

const ROW_H = 70;
const GAP = 2;
const CLIENT_H = 800;
const THREAD_TOP = 100;
const FRAME = 1000 / 60;
const COUNT = 60;

/** every write the seam could make to a row, recorded as well as kept */
class FakeStyle {
  readonly writes: string[] = [];
  #translate: string | undefined;
  get translate(): string | undefined {
    return this.#translate;
  }
  set translate(v: string | undefined) {
    this.writes.push(`translate ${v}`);
    this.#translate = v;
  }
  removeProperty(name: string): void {
    this.writes.push(`remove ${name}`);
  }
}

class FakeRow {
  readonly style = new FakeStyle();
  top = 0;
  constructor(
    readonly seq: number,
    private readonly reads: () => void,
  ) {}
  get offsetTop(): number {
    this.reads();
    return this.top;
  }
  get offsetHeight(): number {
    this.reads();
    return ROW_H;
  }
  getBoundingClientRect(): { top: number; bottom: number; height: number } {
    this.reads();
    return { top: THREAD_TOP + this.top, bottom: THREAD_TOP + this.top + ROW_H, height: ROW_H };
  }
  getAttribute(): string {
    return "";
  }
  removeAttribute(): void {
    this.style.writes.push("remove style");
  }
}

let springBlock = "";
let gestureBlock = "";

beforeAll(async () => {
  const { transformWithEsbuild } = await import("vite");
  const ts = async (code: string, name: string) =>
    (await transformWithEsbuild(code, name, { loader: "ts" })).code;
  const seam = main.slice(main.indexOf(SEAM_MARK), main.indexOf("// --- scrolling: glide when following the tail"));
  // the switch line is the app's own, verbatim: what runs below is what ships
  springBlock = await ts(`${SWITCH_LINE}\n${seam}`, "springseam.ts");
  // noteThreadGesture and claimResumeEra, the app's own: the bookkeeping the
  // handlers do beside every one of the calls this file drives
  gestureBlock = await ts(
    main.slice(
      main.indexOf("// Every genuine gesture ON THE THREAD passes through here"),
      main.indexOf("// Re-establish when the THREAD BOX resizes"),
    ),
    "gesture.ts",
  );
});

const PROBE = `
globalThis.__probe = {
  field: springField,
  get motionAt() { return springMotionAt; },
  get appWroteAt() { return springAppWroteAt; },
  get els() { return springEls; },
  get dirty() { return springDirty; },
  get blocked() { return springBlocked(); },
};
`;

function harness() {
  let scrollTop = 0;
  let now = 0;
  let frames = 0; // frames the seam asked for
  let reads = 0; // layout reads it made
  const rows: FakeRow[] = [];
  for (let seq = 1; seq <= COUNT; seq++) rows.push(new FakeRow(seq, () => void (reads += 1)));
  let cursor = 0;
  for (const row of rows) {
    row.top = cursor;
    cursor += ROW_H + GAP;
  }
  const contentH = cursor - GAP;

  const thread = {
    get clientHeight(): number {
      reads += 1;
      return CLIENT_H;
    },
    get scrollHeight(): number {
      reads += 1;
      return contentH;
    },
    get scrollTop(): number {
      reads += 1;
      return scrollTop;
    },
    getBoundingClientRect: () => {
      reads += 1;
      return { top: THREAD_TOP };
    },
  };

  const context: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => {
        reads += 1;
        return id === "thread" ? thread : null;
      },
    },
    requestAnimationFrame: () => ++frames,
    cancelAnimationFrame: () => {},
    performance: { now: () => now },
    createSpringField,
    createEndSpring,
    springCreditsReader,
    springTakesCoastBack,
    laidOutRows: () => {
      reads += 1;
      return rows;
    },
    resumeWindowOpen: () => false,
    resumeClaimed: false,
    lastGestureAt: 0,
    lastScrollAt: 0,
    threadTouching: false,
    flightsUp: 0,
    airborneRows: new Set(),
    arrival: null,
    glide: null,
    glideRaf: 0,
    landingHold: false,
    shiftAnims: [],
    app: { classList: { contains: () => false } },
  };

  runInNewContext(`${springBlock}\n${gestureBlock}\n${PROBE}`, context);

  const probe = (): { field: SpringField; motionAt: number; appWroteAt: number; blocked: boolean } =>
    context.__probe as { field: SpringField; motionAt: number; appWroteAt: number; blocked: boolean };
  const call = <A extends unknown[]>(name: string) => context[name] as (...args: A) => void;

  return {
    rows,
    field: () => probe().field,
    frames: () => frames,
    reads: () => reads,
    claimed: () => context.resumeClaimed as boolean,
    wroteAt: () => probe().appWroteAt,
    motionAt: () => probe().motionAt,
    /** a gesture act on the thread, through the app's own one place for it */
    gesture: () => call<[]>("noteThreadGesture")(),
    /** the touch handlers' own calls */
    arm: (touchY: number | null, fingerDown: boolean) =>
      call<[number | null, boolean]>("armSpring")(touchY, fingerDown),
    finger: (touchY: number) => call<[number]>("springFinger")(touchY),
    lift: () => call<[]>("liftSpring")(),
    touching: (v: boolean) => void (context.threadTouching = v),
    /** the scroll listener's one line, in the app's own order */
    scrolled: () => {
      call<[]>("springHandleScroll")();
      context.lastScrollAt = now;
    },
    /** what the app says beside a write of its own, and what a pin carries */
    note: () => call<[]>("noteSpringAppWrite")(),
    reseat: (dy: number) => call<[number]>("springReseat")(dy),
    freeze: () => call<[]>("springFreeze")(),
    scroll: (by: number) => void (scrollTop = Math.max(0, Math.min(scrollTop + by, contentH - CLIENT_H))),
    at: () => scrollTop,
    step: () => void (now += FRAME),
    wait: (ms: number) => void (now += ms),
    /** every write any row has taken, ever */
    writes: () => rows.flatMap((row) => row.style.writes),
    translated: () => rows.filter((row) => row.style.translate !== undefined).length,
    moving: () => probe().field.displacements().size,
  };
}

type Harness = ReturnType<typeof harness>;

/** nothing happened to the transcript: the whole assertion, in one place */
function still(h: Harness): void {
  expect(h.field().armed()).toBe(false);
  expect(h.field().lag()).toBe(0);
  expect(h.moving()).toBe(0);
  expect(h.translated()).toBe(0);
  expect(h.writes()).toEqual([]);
  expect(h.frames()).toBe(0);
  expect(h.reads()).toBe(0);
}

/** a finger dragging the thread, one frame at a time: what the thread's own
    touchstart and touchmove handlers do, in the order they do it */
function drag(h: Harness, frames: number, pxPerMs: number, fingerY = 500): number {
  h.touching(true);
  h.gesture(); // touchstart
  h.arm(fingerY, true);
  for (let i = 0; i < frames; i++) {
    h.step();
    h.scroll(pxPerMs * FRAME);
    fingerY -= pxPerMs * FRAME; // the finger travels with the content
    h.gesture(); // touchmove
    h.finger(fingerY);
    h.scrolled();
  }
  return fingerY;
}

describe("the seam as it ships: a finger, a lift, a coast and a wheel", () => {
  it("a drag moves the scroller and not one row", () => {
    const h = harness();
    h.scroll(1400);
    drag(h, 30, 0.6);
    expect(h.at()).toBeGreaterThan(1400); // the thread really did scroll
    still(h);
  });

  it("the lift, its momentum and the settle after it are the same nothing", () => {
    const h = harness();
    h.scroll(1400);
    drag(h, 20, 1.2);
    h.touching(false);
    h.lift(); // touchend: this is where the return used to begin

    let speed = 1.2;
    for (let i = 0; i < 60; i++) {
      h.step();
      speed *= 0.95;
      h.scroll(speed * FRAME);
      h.scrolled();
    }
    h.wait(1000); // and long after it has stopped
    h.scrolled();
    still(h);
  });

  it("a fling into the end of the thread does not bounce the rows", () => {
    const h = harness();
    h.scroll(1400);
    drag(h, 40, -6); // hard, all the way to the top
    expect(h.at()).toBe(0); // sitting on the end, where the band used to stretch
    h.touching(false);
    h.lift();
    for (let i = 0; i < 40; i++) {
      h.step();
      h.scrolled();
    }
    still(h);
  });

  it("a wheel and a pointer arm nothing either", () => {
    const h = harness();
    h.scroll(900);
    for (let i = 0; i < 10; i++) {
      h.gesture(); // the wheel handler's own note
      h.arm(null, false); // ... and its call, tick after tick
      h.step();
      h.scroll(-120);
      h.scrolled();
    }
    h.gesture(); // pointerdown
    h.arm(420, false); // a pointer that is not a touch
    h.step();
    h.scrolled();
    still(h);
  });
});

describe("the seam as it ships: the app's own writes", () => {
  it("a pinned page landing above the reader still declares itself, and moves nothing", () => {
    const h = harness();
    h.scroll(1400);
    drag(h, 10, -0.5); // reading up into history, mid-drag

    const before = h.wroteAt();
    h.reseat(3460); // drainOlder's pin: a whole page went in above the fold
    expect(h.wroteAt()).toBeGreaterThan(before); // the app's write clock still moves
    h.scrolled();
    still(h);
  });

  it("a freeze in the middle of everything is a no-op, not a write", () => {
    const h = harness();
    h.scroll(1400);
    drag(h, 4, 0.5);
    h.freeze(); // what beginSiblingShift calls before it measures a rect
    h.note(); // and what every app write says beside itself
    h.step();
    h.scrolled();
    still(h);
  });

  it("the bookkeeping the switch deliberately leaves alone still runs", () => {
    // whose motion a scroll event is, and the resume era his travel claims: read
    // elsewhere in the app, never the effect, and left exactly as it was
    const h = harness();
    h.scroll(900);
    expect(h.claimed()).toBe(false);
    drag(h, 6, 0.5);
    expect(h.claimed()).toBe(true); // his travel bought the era
    expect(Number.isFinite(h.motionAt())).toBe(true); // ... and the motion is his
    still(h);
  });
});
