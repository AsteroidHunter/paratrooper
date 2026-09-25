// The keyboard lift in a chat too short to fill the screen.
//
// The wrapper lifts the message list and the compose bar together by the
// keyboard's height (shell.ts), which assumes the newest message sits on the
// bar. Once a chat fills the screen it does. A new chat has its messages at the
// top and empty room below them, so lifting the whole way pushed them under the
// header (a two-message chat went blank), and the padding swap at the landing
// had no scroll range to absorb it: the messages jumped down when the open
// landed, rode down past their place on the close and snapped back up.
//
// The list now takes only its own share of the lift: the lift less the room
// under its newest message, never less than nothing (main.ts aimListLift, the
// #app.kb .thread rule in styles.css). The padding swap uses that share on top
// and the rest of the lift at the bottom, and the close re-splits the two if
// the chat changed while the keyboard was up (main.ts reaimListLift,
// viewport.ts closingListLift).
//
// Built like springpins.test.ts: the lift block is cut out of main.ts by name
// and run in a VM context, so what runs here is the app's own measurement,
// padding swap and re-split. The harness owns only what the engine would do:
// the thread's rows and paddings, a scroll offset the engine clamps to the
// range, the two CSS rules that turn the shell's inset and the list's room into
// translates, and the two transitions, which leave together on one clock and
// are walked here in even steps. Positions are screen y, the way a reader sees
// them. Synthetic throughout: no device, no browser, no real data.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";
import { closingListLift, padShift } from "../src/viewport";

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

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
      "shortlift.ts",
      { loader: "ts" },
    )
  ).code;
});

// --- the screen the lift works on ----------------------------------------------

const HEADER = 65; // the header's bottom edge: the top of the clip
const BOX = 691; // the thread's own height, header to bar, keyboard down
const BASE = 12.75; // the thread's own padding, 0.75rem
const MARGIN = 10; // .row margin-top
const GAP = 2; // .thread gap
const ROW = 43; // a one-line bubble
const LIFT = 336; // the keyboard's lift, as the wrapper's translate carries it
const STEPS = 12; // frames walked through each motion

class FakeMatrix {
  readonly f: number;
  constructor(s: string) {
    this.f = Number(/,\s*(-?[\d.e+-]+)\)$/.exec(s)?.[1] ?? 0);
  }
}

interface Motion {
  from: number;
  to: number;
}

function harness(rowHeights: number[]) {
  const heights = [...rowHeights];
  const vars = new Map<string, number>();
  let scrollTop = 0;
  let kb = false;
  let lift = LIFT;
  // the two translates, each with its target and its transition
  let wrapY = 0;
  let listY = 0;
  let listNone = true; // the thread's computed transform is `none`
  let wrapRun: Motion | null = null;
  let listRun: Motion | null = null;
  let wrapTarget = 0;
  let listTarget: number | null = null;
  let landing: ((up: boolean, lift: number) => void) | null = null;
  let edge: ((edge: "open" | "close" | "retime") => void) | null = null;

  const pad = (name: string): number => vars.get(name) ?? 0;
  const padTop = (): number => BASE + pad("--lift-pad");
  const padBottom = (): number => BASE + pad("--lift-pad-b");
  // each row's top in the thread's content coordinates, padding included
  const rowTops = (): number[] => {
    const out: number[] = [];
    let cursor = padTop();
    heights.forEach((h, i) => {
      const top = cursor + (i === 0 ? 0 : GAP) + MARGIN;
      out.push(top);
      cursor = top + h;
    });
    return out;
  };
  const contentEnd = (): number => {
    const tops = rowTops();
    return (tops.length ? tops[tops.length - 1] + heights[heights.length - 1] : padTop()) + padBottom();
  };
  const maxScroll = (): number => Math.max(0, contentEnd() - BOX);
  const clamp = (): void => {
    scrollTop = Math.max(0, Math.min(scrollTop, maxScroll()));
  };

  const thread = {
    clientHeight: BOX,
    clientTop: 0,
    isConnected: true,
    style: { transition: "", transform: "" },
    get scrollTop(): number {
      clamp(); // content that shrank under the offset takes the offset with it
      return scrollTop;
    },
    set scrollTop(v: number) {
      scrollTop = v;
      clamp(); // the browser's clamp
    },
    scrollTo(o: { top: number }): void {
      thread.scrollTop = o.top;
    },
    getBoundingClientRect: () => ({ top: HEADER + wrapY + listY }),
    get offsetHeight(): number {
      recalc(); // a forced style pass, which is what the re-split's flush is
      return BOX;
    },
  };

  const rows = () =>
    rowTops().map((top, i) => ({
      getBoundingClientRect: () => {
        const y = HEADER + wrapY + listY + top - scrollTop;
        return { top: y, bottom: y + heights[i] };
      },
    }));

  // The engine's half of the two CSS rules and their shared transition:
  //   .lift             translateY(--kb-lift): -LIFT under .kb, 0 otherwise
  //   #app.kb .thread   translateY(min(--list-room, lift)) when the room is
  //                     set; `none` when it is not, or without .kb
  // A change of target starts a transition from where the element stands,
  // unless the element's transition is held off, which moves it at once.
  function recalc(): void {
    const wt = kb ? -lift : 0;
    if (wt !== wrapTarget) {
      wrapTarget = wt;
      wrapRun = { from: wrapY, to: wt };
    }
    const room = vars.has("--list-room") ? pad("--list-room") : null;
    const lt = kb && room !== null ? Math.min(room, lift) : null;
    if (lt !== listTarget) {
      listTarget = lt;
      const to = lt ?? 0;
      if (thread.style.transition === "none") {
        listY = to;
        listRun = null;
      } else {
        listRun = { from: listY, to };
      }
      if (lt !== null) listNone = false;
    }
  }

  function at(p: number): void {
    if (wrapRun) wrapY = wrapRun.from + (wrapRun.to - wrapRun.from) * p;
    if (listRun) listY = listRun.from + (listRun.to - listRun.from) * p;
  }

  function land(): void {
    at(1);
    wrapRun = null;
    listRun = null;
    if (listTarget === null && listY === 0) listNone = true;
  }

  const context: Record<string, unknown> = {
    document: { getElementById: (id: string) => (id === "thread" ? thread : null) },
    app: {
      style: {
        setProperty: (name: string, value: string) => void vars.set(name, parseFloat(value)),
        removeProperty: (name: string) => void vars.delete(name),
      },
    },
    getComputedStyle: (el: unknown) => {
      recalc();
      if (el === thread) {
        return {
          transform: listNone ? "none" : `matrix(1, 0, 0, 1, 0, ${listY})`,
          paddingTop: `${padTop()}px`,
          paddingBottom: `${padBottom()}px`,
        };
      }
      return { transform: "none", marginBottom: "0px" };
    },
    DOMMatrixReadOnly: FakeMatrix,
    laidOutRows: () => rows(),
    closingListLift,
    padShift,
    springDirty: false,
    springReseat: () => {},
    scrollGhostWrite: () => {},
    holdDiagRecord: () => {},
    widen: { landed: () => {} },
    watchLiftLanding: (cb: (up: boolean, lift: number) => void) => void (landing = cb),
    watchLiftEdge: (cb: (e: "open" | "close" | "retime") => void) => void (edge = cb),
  };
  runInNewContext(liftBlock, context);

  // every row's screen y, oldest first
  const seen = (): number[] => rows().map((r) => r.getBoundingClientRect().top);
  const bar = (): number => HEADER + BOX + wrapY; // the bar's top edge rides the wrapper
  const newestBottom = (): number => {
    const r = rows();
    return r.length ? r[r.length - 1].getBoundingClientRect().bottom : HEADER + BASE;
  };

  // One keyboard edge played through: the edge (shell.ts calls the listener
  // before the classes turn), the class, the motion in even steps, the
  // landing. Returns every row's screen y: before the edge, right after the
  // edge's own writes, at every step, and after the landing.
  function play(up: boolean): number[][] {
    const frames: number[][] = [seen()];
    edge!(up ? "open" : "close");
    frames.push(seen());
    kb = up;
    recalc();
    for (let i = 1; i <= STEPS; i++) {
      at(i / STEPS);
      frames.push(seen());
    }
    land();
    landing!(up, up ? Math.abs(wrapY) : 0);
    frames.push(seen());
    return frames;
  }

  // A later report with a different keyboard height while it is up: the
  // list's share is asked again (shell.ts calls the listener with "retime"
  // before it pins the motion), the new height is written, both translates
  // run from where they stand to their new targets, and the lift lands again.
  function retime(to: number): number[][] {
    const frames: number[][] = [seen()];
    edge!("retime");
    frames.push(seen());
    lift = to;
    recalc();
    for (let i = 1; i <= STEPS; i++) {
      at(i / STEPS);
      frames.push(seen());
    }
    land();
    landing!(true, Math.abs(wrapY));
    frames.push(seen());
    return frames;
  }

  return {
    open: () => play(true),
    close: () => play(false),
    retime,
    seen,
    bar,
    newestBottom,
    scrollTop: () => thread.scrollTop,
    listNone: () => listNone,
    listY: () => listY,
    pads: () => [pad("--lift-pad"), pad("--lift-pad-b")],
    /** a message landing at the tail; `pin` is the bottom pin a follower gets */
    arrive(height = ROW, pin = true): void {
      heights.push(height);
      if (pin) thread.scrollTop = maxScroll();
    },
    /** the reader scrolls the thread himself */
    scrollTo: (v: number) => void (thread.scrollTop = v),
    maxScroll,
  };
}

const chat = (n: number, h = ROW): number[] => Array.from({ length: n }, () => h);
// the room a chat of n rows leaves under its newest message, keyboard down
const roomOf = (n: number, h = ROW): number =>
  BOX - (BASE + n * (h + MARGIN) + (n - 1) * GAP + BASE);

// the largest one-step move of any row between two consecutive frames
function largestStep(frames: number[][]): number {
  let worst = 0;
  for (let i = 1; i < frames.length; i++) {
    frames[i].forEach((y, k) => {
      if (k < frames[i - 1].length) worst = Math.max(worst, Math.abs(y - frames[i - 1][k]));
    });
  }
  return worst;
}

// how far a row moved on the landing step alone, which is where a padding swap
// the scroll could not absorb shows
const landingMove = (frames: number[][]): number =>
  Math.max(...frames[frames.length - 1].map((y, k) => Math.abs(y - frames[frames.length - 2][k])));

describe("a chat with more room under it than the keyboard is tall", () => {
  it("an empty chat: the open and the close move nothing and write no padding", () => {
    const h = harness([]);
    expect(roomOf(0)).toBeGreaterThan(LIFT);
    const up = h.open();
    expect(h.listY()).toBe(LIFT); // the list stood back down by the whole lift
    expect(h.pads()).toEqual([0, LIFT]);
    expect(h.scrollTop()).toBe(0);
    h.close();
    expect(h.pads()).toEqual([0, 0]);
    expect(up.every((f) => f.length === 0)).toBe(true);
  });

  it("two messages: nothing moves on the open, the landing, the close or its landing", () => {
    const h = harness(chat(2));
    expect(roomOf(2)).toBeGreaterThan(LIFT);
    const rest = h.seen();
    const up = h.open();
    for (const f of up) expect(f).toEqual(rest);
    expect(h.newestBottom()).toBeLessThanOrEqual(h.bar() - BASE); // above the bar, as ever
    expect(Math.min(...h.seen())).toBeGreaterThan(HEADER); // never under the header: no blank
    const down = h.close();
    for (const f of down) expect(f).toEqual(rest);
    expect(h.scrollTop()).toBe(0);
    expect(h.pads()).toEqual([0, 0]);
  });

  it("the thread's box behind the bar is bottom padding, so the thread still cannot scroll", () => {
    const h = harness(chat(2));
    h.open();
    expect(h.maxScroll()).toBe(0);
    h.scrollTo(200); // a drag has nothing to take
    expect(h.scrollTop()).toBe(0);
  });
});

describe("a chat partly full: less room than the keyboard", () => {
  const n = 9;
  it("rises by the lift less its room, smoothly, and the landing moves nothing", () => {
    const room = roomOf(n);
    expect(room).toBeGreaterThan(0);
    expect(room).toBeLessThan(LIFT);
    const h = harness(chat(n));
    const rest = h.seen();
    const up = h.open();
    const share = LIFT - room;
    up[up.length - 1].forEach((y, k) => expect(y).toBeCloseTo(rest[k] - share, 6));
    expect(landingMove(up)).toBeLessThan(1e-6); // the padding swap is invisible
    expect(largestStep(up)).toBeLessThanOrEqual(share / STEPS + 1e-6); // no step beyond the ease's own
    // the newest message sits on the bar with the thread's own padding under it
    expect(h.newestBottom()).toBeCloseTo(h.bar() - BASE, 6);
    expect(h.pads()[0]).toBeCloseTo(share, 6);
    expect(h.pads()[1]).toBeCloseTo(room, 6);
  });

  it("the oldest message it pushed under the header can be scrolled back into view", () => {
    const h = harness(chat(n));
    const rest = h.seen();
    h.open();
    h.scrollTo(0);
    expect(h.seen()[0]).toBeCloseTo(rest[0], 6); // exactly where it sat at rest
    expect(h.seen()[0]).toBeGreaterThan(HEADER);
  });

  it("the close carries it home by the same share and its landing moves nothing", () => {
    const h = harness(chat(n));
    const rest = h.seen();
    h.open();
    const down = h.close();
    expect(landingMove(down)).toBeLessThan(1e-6);
    down[down.length - 1].forEach((y, k) => expect(y).toBeCloseTo(rest[k], 6));
    // it never rides below its resting place (the old slide-down-then-snap)
    for (const f of down) f.forEach((y, k) => expect(y).toBeLessThanOrEqual(rest[k] + 1e-6));
    expect(h.pads()).toEqual([0, 0]);
  });
});

describe("a chat that fills the screen: exactly as before", () => {
  it("the whole lift, no counter-translate, the whole padding on top", () => {
    const h = harness(chat(20));
    expect(roomOf(20)).toBeLessThan(0);
    h.scrollTo(h.maxScroll()); // at the newest message, as a full chat opens
    const rest = h.seen();
    const st = h.scrollTop();
    const up = h.open();
    expect(h.listNone()).toBe(true); // the thread never carried a transform
    // every row rode the wrapper's full lift, frame by frame
    up.forEach((f, i) => {
      const p = Math.min(Math.max(i - 1, 0), STEPS) / STEPS;
      f.forEach((y, k) => expect(y).toBeCloseTo(rest[k] - LIFT * p, 6));
    });
    expect(h.pads()).toEqual([LIFT, 0]);
    expect(h.scrollTop()).toBe(st + LIFT);
    const down = h.close();
    expect(h.listNone()).toBe(true);
    expect(landingMove(down)).toBeLessThan(1e-6);
    down[down.length - 1].forEach((y, k) => expect(y).toBeCloseTo(rest[k], 6));
    expect(h.scrollTop()).toBe(st);
  });
});

describe("the chat changes while the keyboard is up", () => {
  it("a reply lands in a short chat with room to spare: nothing that was there moves", () => {
    const h = harness(chat(2));
    const rest = h.seen();
    h.open();
    h.arrive();
    expect(h.seen().slice(0, 2)).toEqual(rest);
    expect(h.newestBottom()).toBeLessThanOrEqual(h.bar() - BASE + 1e-6);
    const down = h.close();
    for (const f of down) expect(f.slice(0, 2)).toEqual(rest);
    expect(landingMove(down)).toBeLessThan(1e-6);
  });

  it("a reply that outgrows the room is pinned above the bar, as in a full chat", () => {
    const n = 9; // partly full
    const h = harness(chat(n));
    h.open();
    const before = h.seen();
    h.arrive(66); // a two-line reply
    // the bottom padding is what the pin scrolls into: the new message ends on
    // the bar, and what was there moved up by exactly what it had to
    expect(h.newestBottom()).toBeCloseTo(h.bar() - BASE, 6);
    const moved = before[0] - h.seen()[0];
    expect(moved).toBeCloseTo(66 + MARGIN + GAP, 6);
  });

  it("a short chat that grows past one screen closes without a jump and lands pinned", () => {
    const h = harness(chat(2));
    h.open();
    for (let i = 0; i < 14; i++) h.arrive(); // well past one screen now
    expect(roomOf(16)).toBeLessThan(0);
    const down = h.close();
    expect(h.pads()[1]).toBe(0); // re-split: the list now takes the whole lift
    down[1].forEach((y, k) => expect(y).toBeCloseTo(down[0][k], 6)); // and nothing on screen moved
    expect(largestStep(down)).toBeLessThanOrEqual(LIFT / STEPS + 1e-6);
    expect(landingMove(down)).toBeLessThan(1e-6);
    // and it lands where a full chat at its newest message rests
    expect(h.newestBottom()).toBeCloseTo(HEADER + BOX - BASE, 6);
    expect(h.scrollTop()).toBeCloseTo(h.maxScroll(), 6);
    expect(h.pads()).toEqual([0, 0]);
  });

  it("a short chat that grows but stays short closes by just its new share", () => {
    const h = harness(chat(2));
    h.open();
    for (let i = 0; i < 5; i++) h.arrive(); // 7 rows: less room than the keyboard now
    const room = roomOf(7);
    expect(room).toBeGreaterThan(0);
    expect(room).toBeLessThan(LIFT);
    const down = h.close();
    down[1].forEach((y, k) => expect(y).toBeCloseTo(down[0][k], 6)); // the re-split moved nothing
    expect(landingMove(down)).toBeLessThan(1e-6);
    expect(largestStep(down)).toBeLessThanOrEqual((LIFT - room) / STEPS + 1e-6);
    // at rest, a seven-row chat sits at the top with its room under it
    expect(h.scrollTop()).toBe(0);
    expect(h.seen()[0]).toBeCloseTo(HEADER + BASE + MARGIN, 6);
  });

  it("a reader who scrolled a partly full chat to its top closes without a jump", () => {
    const h = harness(chat(9));
    const rest = h.seen();
    h.open();
    h.scrollTo(0);
    const down = h.close();
    expect(landingMove(down)).toBeLessThan(1e-6);
    down[down.length - 1].forEach((y, k) => expect(y).toBeCloseTo(rest[k], 6));
  });
});

describe("the keyboard changes height while it is up (emoji keyboard, accessory bar)", () => {
  const TALLER = LIFT + 44;
  const SHORTER = LIFT - 44;

  it("a short chat with room for the taller keyboard still does not move", () => {
    const h = harness(chat(2));
    const rest = h.seen();
    h.open();
    for (const f of h.retime(TALLER)) expect(f).toEqual(rest);
    for (const f of h.retime(SHORTER)) expect(f).toEqual(rest);
    for (const f of h.close()) expect(f).toEqual(rest);
  });

  it("a partly full chat rises by just the extra height, and every landing is still", () => {
    const h = harness(chat(9));
    h.open();
    const up = h.seen();
    const r = h.retime(TALLER);
    expect(landingMove(r)).toBeLessThan(1e-6);
    r[r.length - 1].forEach((y, k) => expect(y).toBeCloseTo(up[k] - 44, 6));
    expect(h.newestBottom()).toBeCloseTo(h.bar() - BASE, 6);
    const down = h.close();
    expect(landingMove(down)).toBeLessThan(1e-6);
  });

  it("a short chat that grew past one screen, then changed height: no jump, still on the bar", () => {
    const h = harness(chat(2));
    h.open();
    for (let i = 0; i < 14; i++) h.arrive();
    for (const to of [TALLER, SHORTER, LIFT]) {
      const r = h.retime(to);
      r[1].forEach((y, k) => expect(y).toBeCloseTo(r[0][k], 6)); // the re-split moved nothing
      expect(landingMove(r)).toBeLessThan(1e-6);
      expect(h.newestBottom()).toBeCloseTo(h.bar() - BASE, 6); // rode the bar, like a full chat
    }
    const down = h.close();
    expect(landingMove(down)).toBeLessThan(1e-6);
    expect(h.newestBottom()).toBeCloseTo(HEADER + BOX - BASE, 6);
  });

  it("a chat that fills the screen re-times exactly as before: no counter-translate", () => {
    const h = harness(chat(20));
    h.scrollTo(h.maxScroll());
    h.open();
    const up = h.seen();
    const r = h.retime(TALLER);
    expect(h.listNone()).toBe(true);
    r[r.length - 1].forEach((y, k) => expect(y).toBeCloseTo(up[k] - 44, 6));
    expect(h.pads()).toEqual([TALLER, 0]);
    expect(landingMove(r)).toBeLessThan(1e-6);
  });
});

describe("the close's re-split, as arithmetic", () => {
  it("an unchanged chat keeps the share it opened with", () => {
    // partly full: room 200 of a 336 lift, sitting at the bottom of the range
    expect(closingListLift(336, 200, 0, 136)).toBe(136);
    // short: no share, nothing scrolled
    expect(closingListLift(336, 400, 0, 0)).toBe(0);
    // full, at the newest message
    expect(closingListLift(336, 0, 900, 1236)).toBe(336);
  });

  it("a chat that outgrew the screen takes the whole lift", () => {
    expect(closingListLift(336, 0, 300, 636)).toBe(336);
  });

  it("the share is held to what the landing can hand back exactly", () => {
    // a reader at the top of a partly full chat: the landing can only take
    // back what he is scrolled, so the list goes home by nothing
    expect(closingListLift(336, 200, 0, 0)).toBe(0);
    // and the landing's write, scroll less share, is always inside 0..range
    for (const [room, range, st] of [
      [200, 0, 60],
      [0, 300, 100],
      [0, 300, 636],
      [50, 0, 286],
      [0, 20, 30],
    ]) {
      const share = closingListLift(336, room, range, st);
      expect(share).toBeGreaterThanOrEqual(0);
      expect(share).toBeLessThanOrEqual(336);
      expect(st - share).toBeGreaterThanOrEqual(0);
      expect(st - share).toBeLessThanOrEqual(range);
    }
  });
});

describe("wiring", () => {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    sel: m[1].trim().replace(/\s*\n\s*/g, "\n"),
    body: m[2],
  }));
  const rule = (sel: string): string => rules.find((r) => r.sel === sel)?.body ?? "";

  it("the list's share is a CSS translate off the room and the wrapper's own lift", () => {
    expect(rule("#app.kb .thread")).toContain(
      "transform: translateY(min(var(--list-room), -1 * var(--kb-lift)))",
    );
    // on the wrapper's clock, declared where the close can still read it
    expect(rule(".thread")).toContain("transition: transform var(--kb-anim)");
    // never given a default: unset is what leaves a full chat's thread with no
    // transform at all (the declaration is invalid at computed-value time)
    expect(bare.match(/--list-room/g)).toHaveLength(1);
  });

  it("the room is decided at the edge, before the classes turn", () => {
    const apply = shell.match(/function applyShell\([\s\S]*?\n\}/)?.[0] ?? "";
    const call = apply.indexOf('onLiftEdge?.(t.kb ? "open" : "close");');
    expect(call).toBeGreaterThan(-1);
    expect(call).toBeLessThan(apply.indexOf("armLift("));
    expect(call).toBeLessThan(apply.indexOf('appEl.classList.toggle("kb", t.kb);'));
    expect(call).toBeLessThan(apply.indexOf('appEl.style.setProperty("--kb-inset"'));
    expect(main).toMatch(
      /watchLiftEdge\(\(edge\) => \{\n\s*if \(edge === "open"\) aimListLift\(\);\n\s*else if \(edge === "close"\) reaimListLift\(\);\n\s*else retimeListLift\(\);\n\}\);/,
    );
    // and again, first, when a later report changes the keyboard's height
    expect(apply).toMatch(/onLiftEdge\?\.\("retime"\);\n\s*retimeLift\(inset\);/);
  });

  it("a later report re-times the list with the wrapper, in the same flush", () => {
    const retime = shell.match(/function retimeLift\([\s\S]*?\n\}/)?.[0] ?? "";
    const flush = retime.indexOf("void liftEl.offsetHeight;");
    expect(retime.indexOf("liftList.style.transition = \"none\";")).toBeLessThan(flush);
    expect(retime.lastIndexOf("liftList.style.transition = \"\";")).toBeGreaterThan(flush);
  });

  it("the close's re-split writes no scroll offset", () => {
    const body = main.slice(
      main.indexOf("function reaimListLift("),
      main.indexOf("\n}", main.indexOf("function reaimListLift(")),
    );
    expect(body).not.toMatch(/scrollTop\s*=|scrollTo\(/);
    expect(body).toContain('t.style.transition = "none";');
    expect(body).toContain("void t.offsetHeight;");
  });
});
