// The reader's claim on a resume era, tested as behaviour: what the rows do.
//
// Coming back on screen the app opens a six second window in which it is still
// landing for a reader who was not there: the landing's wait holds the position
// the phone handed back, every bottom pin inside the window is written INSTANT
// rather than ridden, and the springs are held at zero throughout, because none
// of that motion is his (main.ts springBlocked, resume.ts).
//
// The claim is what ends that for the springs alone. The question this file
// exists for is what BUYS it. Bought by contact — any pointerdown or touchstart
// on the thread — a tap to open a lightbox or dismiss the keyboard released six
// seconds of the app's own writes into a field the reader's next touch could
// arm. So it is bought by TRAVEL instead: a wheel tick, a drag the app's own
// direction verdict calls a scroll rather than a sideways peek, or a scroll
// event credited to him (springown.ts). The first two are the touch handlers'
// and are exercised end to end in a local browser; this file drives the seam:
// the era's own window, the claim, the hold-off it releases and the ones it
// must never release, and what an app-owned instant pin does inside it.
//
// The blocks are cut out of main.ts by name and run in ONE VM context, the way
// profilescroll.test.ts does it, so what runs here is the app's own
// openResumeWindow, closeResumeWindow, resumeHidden, scrollToBottom and spring
// seam over the real field from springscroll.ts.
//
// Synthetic throughout: no device, no browser, no recording, no real data.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";
import { createEndSpring } from "../src/endspring";
import { RESUME_WINDOW_MS } from "../src/resume";
import { springCreditsReader, springTakesCoastBack } from "../src/springown";
import { createSpringField } from "../src/springscroll";
import type { SpringField } from "../src/springscroll";

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

// The seam's switch, read out of the file the seam is cut from. main.ts ships
// with the transcript spring OFF (the owner's call on 2026-09-15), and the last
// case in this file drives the seam exactly as it ships: nothing moves. Every
// other case forces the switch ON, the way keepArmed forces its counterfactual
// below, because what they are about is the machinery the switch holds off and
// would hand back the day it is turned on again: whose motion a scroll event is,
// what buys the reader's claim on a resume era, and what an app-owned instant
// pin does inside that window. That bookkeeping is live code either way.
const SHIPPED_SPRING = /^const SPRING_ENABLED = (true|false);$/m.exec(main)?.[1] === "true";

function sourceBetween(start: string, end: string): string {
  const at = main.indexOf(start);
  const until = main.indexOf(end, at + start.length);
  expect(at, `missing ${start}`).toBeGreaterThanOrEqual(0);
  expect(until, `missing ${end}`).toBeGreaterThan(at);
  return main.slice(at, until);
}

let springBlock = "";
let gestureBlock = "";
let windowBlock = "";
let hiddenBlock = "";
let bottomBlock = "";

const PROBE = `
globalThis.__probe = {
  field: springField,
  get claimed() { return resumeClaimed; },
  get blocked() { return springBlocked(); },
  get windowOpen() { return resumeWindowOpen(); },
  get motionAt() { return springMotionAt; },
  get appWroteAt() { return springAppWroteAt; },
  get els() { return springEls; },
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
  windowBlock = await ts(
    sourceBetween(
      "// The window in which the app is still landing",
      "// A tail frame applied while the app is still coming back",
    ),
    "resumewindow.ts",
  );
  hiddenBlock = await ts(
    sourceBetween("function resumeHidden()", "// A back-forward-cache restore"),
    "resumehidden.ts",
  );
  bottomBlock = await ts(
    sourceBetween("function scrollToBottom(force = false)", "// the jump tap's glide"),
    "bottompin.ts",
  );
});

// --- the thread ---------------------------------------------------------------

const ROW_H = 70;
const GAP = 2;
const CLIENT_H = 800;
const THREAD_TOP = 100;
const FRAME = 1000 / 60;
const COUNT = 60;
const REPLY_H = 96; // a reply landing at the tail: what an instant pin travels

class FakeStyle {
  translate: string | undefined;
  removeProperty(name: string): void {
    if (name === "translate") this.translate = undefined;
  }
}

class FakeRow {
  readonly style = new FakeStyle();
  top = 0;
  constructor(
    readonly seq: number,
    readonly height: number,
    private readonly view: () => number,
  ) {}
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
  getAttribute(): string {
    return "";
  }
  removeAttribute(): void {
    /* the fake carries no other attributes */
  }
}

interface HarnessOptions {
  /** the field refuses to be dropped: what an app write in a claimed window
      reached before this change */
  keepArmed?: boolean;
  /** the seam's own switch, ON unless a case says otherwise: these cases drive
      the machinery main.ts holds off. Pass SHIPPED_SPRING to drive what ships. */
  springEnabled?: boolean;
}

function harness(options: HarnessOptions = {}) {
  let scrollTop = 0;
  let contentH = 0;
  let now = 0;
  const rows: FakeRow[] = [];
  for (let seq = 1; seq <= COUNT; seq++) rows.push(new FakeRow(seq, ROW_H, () => scrollTop));

  function relayout(): void {
    let cursor = 0;
    for (const row of rows) {
      row.top = cursor;
      cursor += row.height + GAP;
    }
    contentH = Math.max(cursor - GAP, 0);
    const max = Math.max(contentH - CLIENT_H, 0);
    if (scrollTop > max) scrollTop = max;
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
      scrollTop = Math.max(0, Math.min(v, Math.max(contentH - CLIENT_H, 0)));
    },
    scrollTo: (o: { top: number }) => void (thread.scrollTop = o.top),
    getBoundingClientRect: () => ({ top: THREAD_TOP }),
  };

  // --- clocks -------------------------------------------------------------
  let rafId = 0;
  const pending = new Map<number, (t: number) => void>();
  let timerId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();

  const ghosts: Array<[string, number]> = [];
  const rides: string[] = [];
  let frozen = 0;

  function field(): SpringField {
    const real = createSpringField();
    return {
      ...real,
      freeze(): void {
        frozen += 1;
        // SYNTHETIC COUNTERFACTUAL, not app behaviour
        if (!options.keepArmed) real.freeze();
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
    setTimeout: (fn: () => void, ms: number) => {
      timers.set(++timerId, { at: now + ms, fn });
      return timerId;
    },
    clearTimeout: (id: number) => void timers.delete(id),
    performance: { now: () => now },
    // --- the seam's collaborators
    SPRING_ENABLED: options.springEnabled ?? true,
    createSpringField: field,
    createEndSpring,
    springCreditsReader,
    springTakesCoastBack,
    laidOutRows: () => rows,
    scrollGhostWrite: (tag: string, at: number) => void ghosts.push([tag, at]),
    holdDiagRecord: () => {},
    lastGestureAt: 0,
    threadTouching: false,
    lastScrollAt: 0,
    flightsUp: 0,
    airborneRows: new Set(),
    arrival: null,
    glide: null,
    glideOwner: "jump",
    glideRaf: 0,
    landingHold: false,
    shiftAnims: [],
    app: { classList: { contains: () => false } },
    // --- the resume window's and the bottom pin's collaborators
    RESUME_WINDOW_MS,
    resumeHolding: () => false,
    threadEl: () => thread,
    suppressAnim: false,
    pinInstant: false,
    startGlide: () => void rides.push("glide"),
    followTail: true,
    scrolledUpByHand: false,
    stopResumeRide: () => {},
    sendPresence: () => {},
    keepAliveSync: () => {},
    AWAY_FRAME: {},
  };

  runInNewContext(
    `${springBlock}\n${gestureBlock}\n${windowBlock}\n${hiddenBlock}\n${bottomBlock}\n${PROBE}`,
    context,
  );

  function probe(): {
    field: SpringField;
    claimed: boolean;
    blocked: boolean;
    windowOpen: boolean;
    motionAt: number;
    appWroteAt: number;
    els: FakeRow[];
  } {
    return context.__probe as ReturnType<typeof probe>;
  }

  const call = <A extends unknown[]>(name: string) => context[name] as (...args: A) => void;

  const api = {
    thread,
    rows,
    ghosts,
    rides,
    claimed: () => probe().claimed,
    blocked: () => probe().blocked,
    windowOpen: () => probe().windowOpen,
    field: () => probe().field,
    freezes: () => frozen,
    park: (at: number) => void (thread.scrollTop = at),
    /** the end of the range as it stands */
    max: () => Math.max(contentH - CLIENT_H, 0),
    touching: (v: boolean) => void (context.threadTouching = v),
    /** the app comes back on screen (resumeVisible's first act) */
    openWindow: () => call<[]>("openResumeWindow")(),
    /** he reads away by hand: the scroll listener ends the window early */
    closeWindow: () => call<[]>("closeResumeWindow")(),
    /** the page goes away */
    hidden: () => call<[]>("resumeHidden")(),
    /** a gesture act on the thread: wheel, pointerdown, touchstart, touchmove */
    gesture: () => call<[]>("noteThreadGesture")(),
    /** what the wheel handler and a decided vertical drag say beside it */
    claim: () => call<[]>("claimResumeEra")(),
    arm: (touchY: number | null, fingerDown: boolean) =>
      call<[number | null, boolean]>("armSpring")(touchY, fingerDown),
    finger: (touchY: number) => call<[number]>("springFinger")(touchY),
    lift: () => call<[]>("liftSpring")(),
    scrolled: () => {
      call<[]>("springHandleScroll")();
      context.lastScrollAt = now;
    },
    /** an app write of any kind, as every writer declares it */
    note: () => call<[]>("noteSpringAppWrite")(),
    /** a reply lands at the tail and the app pins the bottom (applyEvent) */
    reply: () => {
      rows.push(new FakeRow(rows.length + 1, REPLY_H, () => thread.scrollTop));
      relayout();
      call<[boolean?]>("scrollToBottom")();
    },
    /** the hold-off states that stand outside the claim */
    hold: (name: "glide" | "glideRaf" | "flight" | "airborne" | "arrival" | "shift" | "kb" | "landing", on: boolean) => {
      if (name === "glide") context.glide = on ? { done: () => false } : null;
      if (name === "glideRaf") context.glideRaf = on ? 1 : 0;
      if (name === "flight") context.flightsUp = on ? 1 : 0;
      if (name === "airborne") context.airborneRows = new Set(on ? [1] : []);
      if (name === "arrival") context.arrival = on ? {} : null;
      if (name === "shift") context.shiftAnims = on ? [{}] : [];
      if (name === "kb") context.app = { classList: { contains: () => on } };
      if (name === "landing") context.landingHold = on;
    },
    wait: (ms: number) => {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    tick: () => {
      now += FRAME;
      const due = [...pending.values()];
      pending.clear();
      for (const fn of due) fn(now);
    },
    worstRow: () => {
      let worst = 0;
      for (const dy of probe().field.displacements().values()) worst = Math.max(worst, Math.abs(dy));
      return Math.round(worst * 100) / 100;
    },
    movingRows: () => probe().field.displacements().size,
    /** where the field's vertex is on screen. Each row's share of the lag is
        its distance from the vertex, so the profile is flat on the far side of
        it and RISES from there: the first row past the flat is the one the
        stretch is anchored on, to within a row's pitch. */
    vertexScreenY: () => {
      const disp = [...probe().field.displacements()].sort((a, b) => a[0] - b[0]);
      if (!disp.length) return Number.NaN;
      const least = Math.min(...disp.map(([, dy]) => Math.abs(dy)));
      const hit = disp.find(([, dy]) => Math.abs(dy) > least + 0.5) ?? disp[0];
      const box = rows[hit[0]].getBoundingClientRect();
      return Math.round(box.top + box.height / 2);
    },
  };
  return api;
}

type Harness = ReturnType<typeof harness>;

/** a finger dragging the thread, one frame at a time: the touch handlers'
    sequence, with the claim left to the caller (that is what is under test) */
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

describe("what buys the reader's claim on a resume era", () => {
  it("a bare contact does not: the window keeps the springs", () => {
    const h = harness();
    h.park(1400);
    h.openWindow();
    expect(h.claimed()).toBe(false);

    // a tap: touchstart, no travel, touchend. The gesture act is real and the
    // era it opens for the springs is real; what it is not is the thread moving
    h.touching(true);
    h.gesture();
    h.arm(500, true);
    h.touching(false);
    h.lift();

    expect(h.claimed()).toBe(false);
    expect(h.blocked()).toBe(true);
    expect(h.field().armed()).toBe(false);
    expect(h.movingRows()).toBe(0);
  });

  it("a finger that stays still does not either, however long it reports", () => {
    const h = harness();
    h.park(1400);
    h.openWindow();
    h.touching(true);
    h.gesture(); // touchstart
    for (let i = 0; i < 30; i++) {
      h.gesture(); // touchmove, under the direction threshold: no scroll at all
      h.tick();
    }
    h.touching(false);

    expect(h.claimed()).toBe(false);
    expect(h.blocked()).toBe(true);
    expect(h.movingRows()).toBe(0);
  });

  it("a wheel tick does, and the springs come back on it", () => {
    const h = harness();
    h.park(1400);
    h.openWindow();

    h.gesture(); // the wheel handler's own note
    h.claim(); // ... and what it says beside it
    h.arm(null, false); // a wheel anchors on the viewport centre

    expect(h.claimed()).toBe(true);
    expect(h.blocked()).toBe(false);
    expect(h.field().armed()).toBe(true);
  });

  it("a scroll event credited to him does, with no finger left on the glass", () => {
    const h = harness();
    h.park(1400);
    h.openWindow();
    // a scrollbar drag: pointerdown is contact, and the travel arrives as
    // scroll events the app credits to him
    h.gesture(); // pointerdown
    expect(h.claimed()).toBe(false);
    h.thread.scrollTop += 40;
    h.scrolled();

    expect(h.claimed()).toBe(true);
    expect(h.blocked()).toBe(false);
  });

  it("a run of the app's own writes never does, however long it runs", () => {
    const h = harness();
    h.park(1400);
    h.openWindow();
    for (let i = 0; i < 40; i++) {
      h.note(); // every writer in the app declares itself beside its write
      h.thread.scrollTop -= 6;
      h.scrolled();
      h.tick();
    }

    expect(h.claimed()).toBe(false);
    expect(h.blocked()).toBe(true);
    expect(h.movingRows()).toBe(0);
  });

  it("a fresh window with a finger already on the glass starts unclaimed, and his first travel takes it", () => {
    const h = harness();
    h.park(1400);
    h.touching(true); // he never put the phone down
    h.gesture();
    h.openWindow(); // the app comes back under his finger

    expect(h.claimed()).toBe(false);
    expect(h.blocked()).toBe(true);

    // the same touch, now travelling: the app's direction verdict says scroll
    h.gesture();
    h.claim();
    h.finger(480);
    h.thread.scrollTop += 20;
    h.scrolled();

    expect(h.claimed()).toBe(true);
    expect(h.blocked()).toBe(false);
    expect(h.field().armed()).toBe(true); // without lifting the finger
  });
});

describe("what the claim releases, and what it must never release", () => {
  it("the landing's wait and the window yield to it; every motion in the air does not", () => {
    const h = harness();
    h.park(1400);
    h.openWindow();
    h.hold("landing", true);
    expect(h.blocked()).toBe(true);

    h.gesture();
    h.claim();
    expect(h.blocked()).toBe(false); // the wait writes nothing; he is here now

    for (const name of ["glide", "glideRaf", "flight", "airborne", "arrival", "shift", "kb"] as const) {
      h.hold(name, true);
      expect(h.blocked(), `${name} must block whoever owns the era`).toBe(true);
      h.hold(name, false);
      expect(h.blocked()).toBe(false);
    }
  });

  it("closing the window on his own upward gesture does not hand the springs back", () => {
    // the scroll listener ends the window the moment he reads away by hand, and
    // a landing wait may still be in the air behind it
    const h = harness();
    h.park(1400);
    h.openWindow();
    h.hold("landing", true);
    h.gesture();
    h.thread.scrollTop -= 40;
    h.scrolled(); // his travel: the claim
    expect(h.claimed()).toBe(true);

    h.closeWindow();

    expect(h.windowOpen()).toBe(false);
    expect(h.claimed()).toBe(true); // NOT cleared here, on purpose
    expect(h.blocked()).toBe(false); // the wait he took over does not come back
  });

  it("the page going away clears it, and the next era opens unclaimed", () => {
    const h = harness();
    h.park(1400);
    h.openWindow();
    h.gesture();
    h.thread.scrollTop -= 40;
    h.scrolled();
    expect(h.claimed()).toBe(true);

    h.hidden();
    expect(h.claimed()).toBe(false);
    expect(h.windowOpen()).toBe(false);

    h.openWindow(); // he comes back
    expect(h.claimed()).toBe(false);
    expect(h.blocked()).toBe(true);
  });

  it("the window closes itself on its own clock with the claim never made", () => {
    const h = harness();
    h.park(1400);
    h.openWindow();
    h.touching(true);
    h.gesture(); // a tap inside it
    h.touching(false);
    h.wait(RESUME_WINDOW_MS + 1);

    expect(h.windowOpen()).toBe(false);
    expect(h.claimed()).toBe(false);
    expect(h.blocked()).toBe(false); // nothing left to hold the springs off
  });
});

describe("the anchor a coast is taken back on", () => {
  // main.ts's own comment says it: the momentum belongs to where the finger
  // lifted, and "null for a wheel, the centre". Only a non-null anchor was ever
  // recorded, and nothing but a fresh shell cleared it, so a wheel coast taken
  // back after any touch that session anchored on a finger long gone.
  const THUMB_Y = 200; // high on the screen, nowhere near the viewport's middle
  const CENTRE_Y = THREAD_TOP + CLIENT_H / 2;
  const PITCH = ROW_H + GAP; // the vertex is read to within one row's pitch

  /** a wheel's coast: events at frame cadence with no finger anywhere */
  function coast(h: Harness, frames: number, pxPerMs = 0.5): void {
    for (let i = 0; i < frames; i++) {
      h.thread.scrollTop += pxPerMs * FRAME;
      h.scrolled();
      h.tick();
    }
  }

  /** the thread comes to rest: the stretch melts and the field ends its own
      gesture, which is the state a later wheel arrives in */
  function rest(h: Harness, frames = 60): void {
    for (let i = 0; i < frames; i++) h.tick();
  }

  it("a wheel coast taken back anchors on the viewport centre, not on the last finger", () => {
    const h = harness();
    h.park(1400);
    drag(h, 8, 0.5, THUMB_Y); // a touch earlier in the session
    h.touching(false);
    h.lift();
    rest(h); // it comes to rest and the era lapses
    expect(h.field().armed()).toBe(false);

    h.gesture(); // the wheel handler
    h.claim();
    h.arm(null, false); // a wheel has no finger
    expect(h.field().armed()).toBe(true);
    coast(h, 6);
    expect(Math.abs(h.field().lag())).toBeGreaterThan(10);

    expect(Math.abs(h.vertexScreenY() - CENTRE_Y)).toBeLessThan(PITCH);
    expect(Math.abs(h.vertexScreenY() - THUMB_Y)).toBeGreaterThan(200);
  });

  it("... and still does when the hold-off swallowed the wheel's first tick", () => {
    const h = harness();
    h.park(1400);
    drag(h, 8, 0.5, THUMB_Y);
    h.touching(false);
    h.lift();
    rest(h);
    expect(h.field().armed()).toBe(false);

    h.hold("shift", true); // a seat move is in the air as the wheel arrives
    h.gesture();
    h.claim();
    h.arm(null, false); // refused: the hold-off owns the scroll
    expect(h.field().armed()).toBe(false);
    h.hold("shift", false);

    // the wheel's own motion is still running, and the seam takes it back
    coast(h, 8);
    expect(h.field().armed()).toBe(true);
    expect(Math.abs(h.field().lag())).toBeGreaterThan(10);

    expect(Math.abs(h.vertexScreenY() - CENTRE_Y)).toBeLessThan(PITCH);
    expect(Math.abs(h.vertexScreenY() - THUMB_Y)).toBeGreaterThan(200);
  });

  it("a touch coast taken back still anchors where the finger lifted", () => {
    const h = harness();
    h.park(1400);
    drag(h, 8, 0.5, THUMB_Y);
    h.touching(false);
    h.lift(); // his momentum is still his

    h.hold("shift", true); // a hold-off opens inside the coast and drops the arm
    coast(h, 3);
    expect(h.field().armed()).toBe(false);
    h.hold("shift", false);

    coast(h, 8);
    expect(h.field().armed()).toBe(true);
    expect(Math.abs(h.field().lag())).toBeGreaterThan(10);

    // the anchor is the finger's, not the centre: this is the case the take-back
    // exists for and the one the wheel must not borrow
    expect(Math.abs(h.vertexScreenY() - THUMB_Y)).toBeLessThan(PITCH + 100);
    expect(Math.abs(h.vertexScreenY() - CENTRE_Y)).toBeGreaterThan(200);
  });
});

describe("an app-owned instant tail pin inside a claimed window", () => {
  it("is written instant, and does not reach the reader's field as travel", () => {
    const h = harness();
    h.park(h.max() - 200); // reading at the tail, still following it
    h.openWindow();
    const finger = drag(h, 10, 0.5); // his own drag: claimed and armed
    expect(h.claimed()).toBe(true);
    expect(h.field().armed()).toBe(true);
    const steady = h.field().lag();
    expect(Math.abs(steady)).toBeGreaterThan(10);
    const worstBefore = h.worstRow();
    const scrollBefore = h.thread.scrollTop;

    const freezesBefore = h.freezes();
    h.reply(); // a message lands: applyEvent -> scrollToBottom, inside the window

    expect(h.rides).toEqual([]); // instant, not ridden: the window forces that
    expect(h.ghosts.at(-1)?.[0]).toBe("bottom");
    expect(h.thread.scrollTop).toBeGreaterThan(scrollBefore);
    // the field is dropped at the write, exactly as the hold-off drops it, so
    // the teleport has nothing live to be read into
    expect(h.freezes()).toBe(freezesBefore + 1);
    expect(h.field().armed()).toBe(false);
    expect(h.worstRow()).toBe(0);

    h.scrolled();
    h.tick();
    expect(h.worstRow()).toBeLessThanOrEqual(worstBefore);
    expect(h.field().lag()).toBeLessThanOrEqual(Math.abs(steady));

    // and his drag carries on afterwards, on a fresh baseline
    let y = finger;
    for (let i = 0; i < 6; i++) {
      h.thread.scrollTop += 0.4 * FRAME;
      y -= 0.4 * FRAME;
      h.finger(y);
      h.scrolled();
      h.tick();
    }
    expect(h.field().armed()).toBe(true);
    expect(h.worstRow()).toBeLessThanOrEqual(Math.abs(steady) + 1);
  });

  it("without that, the same pin is read as a frame of his travel", () => {
    // SYNTHETIC COUNTERFACTUAL: the field refuses to be dropped, which is what
    // the claim released the window's writes into before this change
    const h = harness({ keepArmed: true });
    h.park(h.max() - 200);
    h.openWindow();
    drag(h, 10, 0.5);
    expect(h.claimed()).toBe(true);
    const steady = h.field().lag();
    const worstBefore = h.worstRow();

    h.reply();
    h.scrolled();
    h.tick();

    expect(h.field().armed()).toBe(true);
    expect(h.worstRow()).toBeGreaterThan(worstBefore * 3);
    expect(Math.abs(h.field().lag())).toBeGreaterThan(Math.abs(steady) * 3);
  });

  it("rides instead of teleporting once the window is over", () => {
    const h = harness();
    h.park(9999);
    h.openWindow();
    h.wait(RESUME_WINDOW_MS + 1);
    expect(h.windowOpen()).toBe(false);

    h.reply();

    expect(h.rides).toEqual(["glide"]); // the ordinary landing, which blocks
    expect(h.ghosts.at(-1)?.[0]).not.toBe("bottom");
  });
});

// --- and what actually ships --------------------------------------------------
describe("the seam as main.ts ships it: the switch is off", () => {
  it("the claim is still bought and still made, and no row moves for it", () => {
    expect(SHIPPED_SPRING).toBe(false);
    const h = harness({ springEnabled: SHIPPED_SPRING });
    h.park(1400);
    h.openWindow();

    // the same travel that takes the era back above: the bookkeeping is live
    drag(h, 10, 0.5);
    expect(h.claimed()).toBe(true);
    expect(h.blocked()).toBe(false);

    // ... and the rows it used to stretch sit exactly where they were laid out
    expect(h.field().armed()).toBe(false);
    expect(h.movingRows()).toBe(0);
    expect(h.worstRow()).toBe(0);
    expect(h.rows.every((row) => row.style.translate === undefined)).toBe(true);

    // the lift, its momentum and the frames after it are the same nothing
    h.touching(false);
    h.lift();
    for (let i = 0; i < 30; i++) {
      h.thread.scrollTop += 6;
      h.scrolled();
      h.tick();
    }
    expect(h.field().armed()).toBe(false);
    expect(h.worstRow()).toBe(0);
    expect(h.rows.every((row) => row.style.translate === undefined)).toBe(true);
  });
});
