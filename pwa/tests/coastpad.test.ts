// The keyboard's landing while the thread is still moving under the reader.
//
// The owner's report: "When I'm moving and I press the compose bar, it does a
// jagged motion." He flicks the thread, and while it is still coasting he taps
// the compose field. The keyboard rises, the lift carries the list and the bar
// up with it, and when the lift lands the thread is given its reachability
// padding with the scroll moved by the same amount in the same frame (main.ts
// setLiftPad). That write is content-preserving only if the page's scroll
// offset is the one on screen, and during a coast it is not: the phone's UI
// process owns the offset, the page reads a stale one, and iOS 26 and earlier
// also stop the momentum dead on any script write to the scroller. So the
// landing's write was a jolt back and a hard stop in the middle of a glide.
//
// The rule now: the landing never writes into the reader's own motion. A
// landing that arrives while a finger is on the thread or its scroll events are
// still coming parks the padding, and the glide boundary the older-history
// insert already waits for (scrollend, the quiet debounce, the release check)
// lands it, still content-preserving, once the thread is at rest. A new
// keyboard edge drops a parked padding, because the lift is moving again and
// its own landing will say what the padding is.
//
// Built like springpins.test.ts and shortlift.test.ts: the lift block is cut
// out of main.ts by name and run in a VM context, so the landing, the padding
// write and the parking are the app's own code. The harness owns only the
// thread underneath: a scroll offset the engine clamps to the range, content
// that moves when the padding lands, and a coast that moves the offset without
// the page writing it. Synthetic throughout: no device, no browser, no real data.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";
import { GLIDE_QUIET_MS, closingListLift, padShift, threadCoasting } from "../src/viewport";

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

function sourceBetween(start: string, end: string): string {
  const at = main.indexOf(start);
  const until = main.indexOf(end, at + start.length);
  expect(at, `missing ${start}`).toBeGreaterThanOrEqual(0);
  expect(until, `missing ${end}`).toBeGreaterThan(at);
  return main.slice(at, until);
}

let liftBlock = "";

beforeAll(async () => {
  const { transformWithEsbuild } = await import("vite");
  liftBlock = (
    await transformWithEsbuild(
      sourceBetween(
        "let liftPad = 0;",
        "// TEMP DIAGNOSTIC (kb-lift, shell.ts): the app's write counter",
      ),
      "coastpad.ts",
      { loader: "ts" },
    )
  ).code;
});

describe("threadCoasting: whether the reader's own motion owns the scroll", () => {
  const NOW = 50_000;

  it("a finger on the thread is motion, moving or not", () => {
    expect(threadCoasting(true, 0, NOW)).toBe(true);
  });

  it("a scroll event inside the quiet window is a glide still running", () => {
    expect(threadCoasting(false, NOW - 16, NOW)).toBe(true);
    expect(threadCoasting(false, NOW - (GLIDE_QUIET_MS - 1), NOW)).toBe(true);
  });

  it("a thread quiet for the whole window is at rest", () => {
    expect(threadCoasting(false, NOW - GLIDE_QUIET_MS, NOW)).toBe(false);
  });

  it("0 is the rest mark scrollend and the debounce leave, whatever the page's age", () => {
    expect(threadCoasting(false, 0, NOW)).toBe(false);
    expect(threadCoasting(false, 0, 30)).toBe(false);
  });

  it("the quiet window is the history insert's own glide boundary", () => {
    expect(GLIDE_QUIET_MS).toBe(140);
  });
});

// --- the thread the landing works on ------------------------------------------

const CONTENT = 6000; // a long chat: many screens of rows
const CLIENT = 723; // the thread's own height
const LIFT = 336; // the keyboard's lift, as the wrapper's translate carries it
const FRAME = 1000 / 60;
const READER_ROW = 3000; // a row in the reader's view, in content coordinates

function harness() {
  let now = 100_000;
  let offset = 2600;
  let padTop = 0; // the lift's share of the thread's top padding
  let padBottom = 0;
  const writes: number[] = []; // every scroll write the page made
  const range = (): number => Math.max(0, CONTENT + padTop + padBottom - CLIENT);
  const clamp = (v: number): number => Math.min(Math.max(0, v), range());
  const thread = {
    get scrollTop(): number {
      return offset;
    },
    set scrollTop(v: number) {
      writes.push(v);
      offset = clamp(v);
    },
    get scrollHeight(): number {
      return CONTENT + padTop + padBottom;
    },
    clientHeight: CLIENT,
  };
  let landing: ((up: boolean, lift: number) => void) | null = null;
  let edge: ((edge: "open" | "close" | "retime") => void) | null = null;
  const context: Record<string, unknown> = {
    document: { getElementById: (id: string) => (id === "thread" ? thread : null) },
    app: {
      style: {
        setProperty: (name: string, value: string) => {
          if (name === "--lift-pad") padTop = parseFloat(value);
          if (name === "--lift-pad-b") padBottom = parseFloat(value);
        },
        removeProperty: () => {},
      },
    },
    // a chat that fills the screen: the list takes the whole lift, no room
    getComputedStyle: () => ({ transform: "none", paddingTop: "0px", paddingBottom: "0px" }),
    laidOutRows: () => [],
    closingListLift,
    padShift,
    threadCoasting,
    performance: { now: () => now },
    threadTouching: false,
    lastScrollAt: 0,
    springDirty: false,
    springReseat: () => {},
    scrollGhostWrite: () => {},
    holdDiagRecord: () => {},
    widen: { landed: () => {} },
    watchLiftLanding: (cb: (up: boolean, lift: number) => void) => void (landing = cb),
    watchLiftEdge: (cb: (e: "open" | "close" | "retime") => void) => void (edge = cb),
  };
  runInNewContext(liftBlock, context);
  return {
    writes,
    get offset() {
      return offset;
    },
    get padTop() {
      return padTop;
    },
    /** where the reader's row sits on screen, relative to the thread's top */
    seen: (): number => READER_ROW + padTop - offset,
    /** the lift's landing, as shell.ts hands it over */
    land: (up: boolean) => landing!(up, up ? LIFT : 0),
    /** a keyboard edge, as shell.ts hands it over */
    edge: (e: "open" | "close" | "retime") => edge!(e),
    /** one frame of the reader's glide: the engine moves the offset, the page
        writes nothing, and the scroll handler stamps its clock */
    coast: (px: number) => {
      now += FRAME;
      offset = clamp(offset + px);
      context.lastScrollAt = now;
    },
    finger: (down: boolean) => void (context.threadTouching = down),
    /** scrollend (or the quiet debounce): the rest mark, then the boundary */
    boundary: () => {
      context.lastScrollAt = 0;
      (context.landParkedPad as () => void)();
    },
    /** the boundary's own call, made while the thread is still moving */
    boundaryTooSoon: () => (context.landParkedPad as () => void)(),
  };
}

describe("the landing never writes into the reader's own motion", () => {
  it("at rest the landing lands at once: padding and scroll in one call, nothing moves", () => {
    const h = harness();
    const seen = h.seen();
    h.land(true);
    expect(h.padTop).toBe(LIFT);
    expect(h.writes).toEqual([2600 + LIFT]);
    expect(h.seen()).toBe(seen);
  });

  it("mid-coast the landing writes nothing, and the coast runs on untouched", () => {
    const h = harness();
    h.coast(40); // the flick is still gliding when the tap lands
    h.coast(38);
    h.land(true); // the keyboard's lift lands inside the glide
    expect(h.writes).toEqual([]);
    expect(h.padTop).toBe(0);
    for (let i = 0; i < 20; i++) {
      h.coast(30 - i);
      h.boundaryTooSoon(); // a boundary check that runs while it still moves
    }
    expect(h.writes).toEqual([]);
    expect(h.padTop).toBe(0);
  });

  it("the glide boundary lands the parked padding, and the reader's row does not move", () => {
    const h = harness();
    h.coast(40);
    h.land(true);
    for (let i = 0; i < 10; i++) h.coast(20 - 2 * i);
    const at = h.offset;
    const seen = h.seen();
    h.boundary();
    expect(h.padTop).toBe(LIFT);
    expect(h.writes).toEqual([at + LIFT]);
    expect(h.seen()).toBe(seen);
    h.boundary(); // a second boundary finds nothing parked
    expect(h.writes).toHaveLength(1);
  });

  it("a finger resting on the thread parks it too, and the release's boundary lands it", () => {
    const h = harness();
    h.finger(true);
    h.land(true);
    expect(h.writes).toEqual([]);
    h.boundaryTooSoon();
    expect(h.writes).toEqual([]);
    h.finger(false);
    const seen = h.seen();
    h.boundary();
    expect(h.writes).toEqual([2600 + LIFT]);
    expect(h.seen()).toBe(seen);
  });

  it("the close's landing mid-coast is parked the same way, and lands at rest", () => {
    const h = harness();
    h.land(true); // the open landed at rest
    h.coast(35);
    h.land(false); // the keyboard went away while he was gliding
    expect(h.writes).toHaveLength(1);
    expect(h.padTop).toBe(LIFT);
    h.coast(20);
    const at = h.offset;
    const seen = h.seen();
    h.boundary();
    expect(h.padTop).toBe(0);
    expect(h.writes.at(-1)).toBe(at - LIFT);
    expect(h.seen()).toBe(seen);
  });

  it("a keyboard edge drops a parked padding: the lift is moving again", () => {
    const h = harness();
    h.coast(40);
    h.land(true); // parked
    h.edge("close"); // he dismissed before the glide ended
    h.boundary(); // the glide ends inside the close's own motion
    expect(h.writes).toEqual([]);
    expect(h.padTop).toBe(0);
    h.land(false); // the close lands: there was never a padding to take off
    h.boundary();
    expect(h.writes).toEqual([]);
    expect(h.padTop).toBe(0);
  });

  it("the newest landing is the only word: a later landing replaces the parked one", () => {
    const h = harness();
    h.coast(40);
    h.land(true); // parked
    h.land(false); // the close lands before the glide ends: back to no padding
    h.boundary();
    expect(h.writes).toEqual([]);
    expect(h.padTop).toBe(0);
  });
});

describe("main.ts wiring: parked at the landing, landed at the glide boundary", () => {
  const body = (from: string, to: string): string => sourceBetween(from, to);

  it("setLiftPad parks before it reads or writes anything, and waits on no clock", () => {
    const pad = body("function setLiftPad(", "\n}\n");
    const same = pad.indexOf("if (!t || (next === liftPad && nextB === liftPadB)) return");
    const park = pad.indexOf("if (threadCoasting(threadTouching, lastScrollAt, performance.now()))");
    const read = pad.indexOf("const st = t.scrollTop");
    expect(same).toBeGreaterThan(-1);
    expect(park).toBeGreaterThan(same);
    expect(read).toBeGreaterThan(park);
    expect(pad).toContain("parkedPad = null;");
    expect(pad).not.toMatch(/setTimeout|requestAnimationFrame/);
  });

  it("the three glide boundaries land a parked padding after the history insert", () => {
    for (const [from, to] of [
      ['thread.addEventListener("scrollend", () => {', 'document.getElementById("jump")'],
      ["restTimer = setTimeout(() => {", "}, 100);"],
      ["const endPeek = () => {", 'thread.addEventListener("touchend", endPeek);'],
    ] as const) {
      const span = body(from, to);
      const older = span.indexOf("tryApplyOlder");
      const pad = span.indexOf("landParkedPad();");
      expect(older, from).toBeGreaterThan(-1);
      expect(pad, from).toBeGreaterThan(older);
    }
    expect(main.match(/landParkedPad\(\);/g)).toHaveLength(3);
  });

  it("a keyboard edge drops the parked padding before the list is aimed", () => {
    expect(main).toMatch(
      /watchLiftEdge\(\(edge\) => \{\n\s*parkedPad = null;[^\n]*\n\s*if \(edge === "open"\) aimListLift\(\);/,
    );
  });
});
