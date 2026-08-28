// Pins for the TEMP blank-thread probe (src/blankprobe.ts).
//
// The probe exists because a blank message area cannot be caught from inside
// the page: script cannot read the compositor, so the only honest instrument is
// one that clears the other two suspects. Everything pinned here follows from
// that. The band arithmetic is held exactly, because vis is the reading the
// whole question turns on and a count that is loose at the edges would let a
// list of collapsed rows read as a healthy one. The lifecycle is held on
// synthetic timestamps, including the pair either side of the repair and the
// give-up that ships a run nobody ever came back to. And the probe's own
// weight is held by source: it may read, since geometry is the question, but it
// may not write, and its walk may not wander.
//
// The wiring pins follow the split scrolljank.test.ts and flight.test.ts use
// for code that boots a real shell at import time.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BAND_LOOK_CAP,
  BLANK_ARM_MS,
  BLANK_EDGES,
  BLANK_MOMENTS,
  BLANK_OFFSETS,
  BLANK_WAIT_MS,
  findBand,
  rowVisible,
  blankFrame,
  createBlankProbe,
} from "../src/blankprobe";
import type {
  BandSource,
  BlankCounts,
  BlankFrame,
  BlankReader,
  RowBox,
} from "../src/blankprobe";

const probeSrc = readFileSync(new URL("../src/blankprobe.ts", import.meta.url), "utf8");
const mainSrc = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const holdSrc = readFileSync(new URL("../src/hold.ts", import.meta.url), "utf8");

// main.ts boots a real shell at import time and cannot load under node, so the
// call sites are read rather than run — the split tailsettle.test.ts uses
function fnBody(name: string): string {
  const start = mainSrc.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  return mainSrc.slice(start, mainSrc.indexOf("\n}", start));
}

// a 700px band, the shape the failing gesture was reported in
const BAND_TOP = 100;
const BAND_BOTTOM = 800;

function rowsAt(tops: number[], height = 44): RowBox[] {
  return tops.map((top) => ({ top, bottom: top + height }));
}

/** a thread whose children each hold one row, laid out top to bottom from the
    given offset — the shape the real scroller has once its groupings are
    resolved, and the shape the bisection leans on */
function column(n: number, from: number, pitch = 54, height = 44): BandSource {
  return {
    n: () => n,
    at: (i) => (i >= 0 && i < n ? [{ top: from + i * pitch, bottom: from + i * pitch + height }] : []),
  };
}

/** a source that counts what it was asked for, so a test can hold the cost */
function counted(src: BandSource): BandSource & { asked: number[] } {
  const asked: number[] = [];
  return {
    asked,
    n: src.n,
    at: (i) => {
      asked.push(i);
      return src.at(i);
    },
  };
}

function listSource(rows: RowBox[][]): BandSource {
  return { n: () => rows.length, at: (i) => rows[i] ?? [] };
}

function reader(over: Partial<BlankReader> = {}): BlankReader {
  return {
    sh: () => 4329,
    st: () => 2180,
    ch: () => 700,
    band: () => findBand(listSource(rowsAt([-200, -100, 120, 200, 280]).map((r) => [r])),
      BAND_TOP, BAND_BOTTOM),
    kids: () => 168,
    pend: () => ({ h: 76, d: "flex" }),
    anims: () => ({ app: 0, thr: 0 }),
    classes: () => ({ app: "kb", thr: "dragging" }),
    peek: () => "0px",
    follow: () => false,
    ...over,
  };
}

const counts: BlankCounts = { sc: 3, set: 24, setMoved: 0 };

describe("is this row one the reader could have seen", () => {
  const vis = (r: RowBox) => rowVisible(r, BAND_TOP, BAND_BOTTOM);

  it("a row straddling either edge counts: part of it is on screen", () => {
    expect(vis(rowsAt([BAND_TOP - 20])[0])).toBe(true);
    expect(vis(rowsAt([BAND_BOTTOM - 4])[0])).toBe(true);
  });

  it("a row resting exactly on either edge does not", () => {
    expect(vis(rowsAt([BAND_TOP - 44])[0])).toBe(false);
    expect(vis(rowsAt([BAND_BOTTOM])[0])).toBe(false);
  });

  it("a row collapsed to no height does not, wherever it sits", () => {
    // the reading this must never give: a thread whose rows had collapsed would
    // still have every one of them at a plausible offset, and counting those
    // would report a healthy conversation for the very screen in question
    expect(vis(rowsAt([300], 0)[0])).toBe(false);
  });
});

describe("finding the band: the cost is the view's, never the conversation's", () => {
  it("a long thread scrolled to the middle reports the rows actually visible", () => {
    // THE REGRESSION. The first record this channel produced in the wild came
    // off a thread of 656 children with the scroll about half way down it, and
    // said vis 0 on all seven readings — because the old walk started at the top
    // of the list and gave up at a fixed cap hundreds of rows short of the view.
    // A zero that means "never arrived" is indistinguishable from a blank
    // screen, which is the one thing this instrument may not get wrong.
    const rows = 2000;
    const src = counted(column(rows, -30_000)); // the view sits deep in the middle
    const found = findBand(src, BAND_TOP, BAND_BOTTOM);
    expect(found.bw).toBe("ok");
    expect(found.vis).toBe(14); // a 700px band over a 54px pitch
    expect(found.top1).toBeLessThanOrEqual(0);
    expect(found.h1).toBe(44);
    // and it got there without reading its way down the conversation
    expect(src.asked.length).toBeLessThan(BAND_LOOK_CAP);
    expect(Math.min(...src.asked)).toBeGreaterThan(100);
  });

  it("the reads grow with the log of the thread, not with the thread", () => {
    const cost = (n: number): number => {
      const src = counted(column(n, BAND_TOP - Math.floor(n / 2) * 54));
      findBand(src, BAND_TOP, BAND_BOTTOM);
      return src.asked.length;
    };
    const short = cost(64);
    const long = cost(16_384); // two hundred and fifty times as many rows
    expect(long).toBeLessThan(short * 2); // eight more bisection steps, not 250x
    expect(long).toBeLessThan(BAND_LOOK_CAP);
  });

  it("the view at the very top and at the very end are both answered", () => {
    const top = findBand(column(400, BAND_TOP), BAND_TOP, BAND_BOTTOM);
    expect(top.bw).toBe("ok");
    expect(top.vis).toBe(13); // row 0 opens on the top edge, so one fewer fits
    expect(top.nearT).toBeNull(); // nothing above the first row, honestly
    // a view past the end of the content: every row is behind it
    const past = findBand(column(400, BAND_TOP - 400 * 54), BAND_TOP, BAND_BOTTOM);
    expect(past.bw).toBe("ok");
    expect(past.vis).toBe(0);
    expect(past.nearT).toBeLessThan(0); // and it says where the content ended
  });

  it("groupings that hold no box of their own are stepped over, not counted", () => {
    // every row sits inside a display:contents wrapper, and a hidden spinner
    // sits at the head of the list holding nothing at all
    const rows: RowBox[][] = [[], ...rowsAt([-100, -46, 8, 62, 116, 900]).map((r) => [r])];
    const found = findBand(listSource(rows), BAND_TOP, BAND_BOTTOM);
    expect(found.bw).toBe("ok");
    expect(found.vis).toBe(2); // 62 and 116 clear the top edge; 8 ends at 52
    expect(found.rows).toBeGreaterThanOrEqual(3);
  });

  it("an empty scroller is an answer, and says so as one", () => {
    const found = findBand(listSource([]), BAND_TOP, BAND_BOTTOM);
    expect(found).toMatchObject({ vis: 0, bw: "empty", rows: 0 });
  });

  it("a list where nothing has a box cannot answer, and refuses to", () => {
    const found = findBand(listSource([[], [], [], []]), BAND_TOP, BAND_BOTTOM);
    expect(found.vis).toBeNull();
    expect(found.bw).toBe("unresolved");
  });

  it("a search that runs out of budget reports null, never a number", () => {
    // the exact shape of the failure this section was rewritten for: whatever
    // stops the search short, it may not hand back a count that looks like one
    const found = findBand(column(4000, -100_000), BAND_TOP, BAND_BOTTOM, 4);
    expect(found.vis).toBeNull();
    expect(found.bw).toBe("capped");
    expect(found.look).toBe(4);
  });
});

describe("a view with nothing in it still says what is around it", () => {
  it("a scroll landed in a gap names the rows either side and their height", () => {
    // rows present, none of them visible: the view is in a hole. That is a
    // scroll fault, and it must not read the same as an unpainted screen.
    const rows = [...rowsAt([-500, -444]), ...rowsAt([1400, 1456])].map((r) => [r]);
    const found = findBand(listSource(rows), BAND_TOP, BAND_BOTTOM);
    expect(found.bw).toBe("ok");
    expect(found.vis).toBe(0);
    expect(found.nearT).toBe(-500); // the row above ends 500px over the top edge
    expect(found.nearB).toBe(1300); // and the next begins 500px past the foot
    expect(found.nearH).toBe(44); // at a normal height: nothing has collapsed
    expect(found.rows).toBeGreaterThan(0);
  });

  it("a collapsed list is told apart from a gap by the height it reports", () => {
    const rows = rowsAt([200, 200, 200, 200], 0).map((r) => [r]);
    const found = findBand(listSource(rows), BAND_TOP, BAND_BOTTOM);
    expect(found.vis).toBe(0); // no height: nothing the reader could have seen
    expect(found.nearH).toBe(0); // and the record says that, rather than staying null
    expect(found.rows).toBeGreaterThan(0);
  });
});

describe("one reading: exactly its fields, rounded, off the injected reader", () => {
  it("carries the geometry, the band, the strip, the animations and the counters", () => {
    const f = blankFrame("beat", 401.4, reader(), counts);
    expect(f).toEqual({
      w: "beat",
      ms: 401,
      st: 2180,
      sh: 4329,
      ch: 700,
      over: 0,
      kids: 168,
      rows: 4, // the row above the band, the three inside it, and no row below
      vis: 3,
      bw: "ok",
      look: 6,
      top1: 20,
      botN: 224,
      h1: 44,
      nearT: -156, // the row above ends 156px over the top edge
      nearB: null, // and the list runs out before anything sits below the band
      nearH: 44,
      pendH: 76,
      pendD: "flex",
      anA: 0,
      anT: 0,
      app: "kb",
      thr: "dragging",
      peek: "0px",
      ft: false,
      sc: 3,
      set: 24,
      setMoved: 0,
    });
  });

  it("overhang is the scroll past the end of its own range, never negative", () => {
    const past = blankFrame("beat", 0, reader({ st: () => 4000 }), counts);
    expect(past.over).toBe(371); // 4000 against a 4329 content in a 700 box
    expect(blankFrame("beat", 0, reader({ st: () => 10 }), counts).over).toBe(0);
  });

  it("a conversation shorter than its box reports no overhang from the arithmetic", () => {
    const short = reader({ sh: () => 400, st: () => 0, ch: () => 700 });
    expect(blankFrame("edge", 0, short, counts).over).toBe(0);
  });
});

describe("the run: armed on a live glide, seven moments, the pair, the give-up", () => {
  const live = (r: BlankReader = reader()) => createBlankProbe(() => r);

  it("a cancel with the conversation standing still arms nothing at all", () => {
    const p = live();
    expect(p.edge("cancel", 1000, BLANK_ARM_MS + 1)).toBe(false);
    expect(p.live()).toBe(false);
    p.frame(1016);
    expect(p.poll(20_000)).toBeNull();
  });

  it("a scroll inside the arming window opens a run and takes the before-picture", () => {
    const p = live();
    expect(p.edge("cancel", 1000, BLANK_ARM_MS)).toBe(true);
    expect(p.live()).toBe(true);
  });

  it("a run with no shell to read refuses rather than opening on nothing", () => {
    const p = createBlankProbe(() => null);
    expect(p.edge("cancel", 1000, 10)).toBe(false);
    expect(p.live()).toBe(false);
  });

  it("every drawer edge can arm a run, and says which one did", () => {
    for (const why of BLANK_EDGES) {
      const p = live();
      expect(p.edge(why, 1000, 10)).toBe(true);
      for (const at of [1016, 1140, 1405, 1710]) p.frame(at);
      p.touched(2000);
      p.frame(2016);
      expect((p.poll(2020) as { why: string }).why).toBe(why);
    }
  });

  it("a later edge inside a run belongs to the beat that run is already describing", () => {
    // the ✕'s own beat ends on the display change that would otherwise be a
    // "shut" edge of its own; restarting there would throw the before-picture away
    const p = live();
    expect(p.edge("cancel", 1000, 10)).toBe(true);
    p.frame(1016);
    expect(p.edge("shut", 1400, 10)).toBe(false);
    p.frame(1140);
    p.frame(1405);
    p.frame(1710);
    p.touched(2000);
    p.frame(2016);
    const rec = p.poll(2020) as { why: string; f: BlankFrame[] };
    expect(rec.why).toBe("cancel");
    expect(rec.f[0].ms).toBe(0); // still the reading taken at the ✕, not at the display change
  });

  it("one gesture with several edges in it produces exactly one run", () => {
    // a pick opens the strip, a second photo grows it, and the settle's own
    // frames follow: three edges, one beat, one record
    const p = live();
    expect(p.edge("open", 1000, 10)).toBe(true);
    expect(p.edge("grow", 1040, 10)).toBe(false);
    expect(p.edge("grow", 1080, 10)).toBe(false);
    for (const at of [1016, 1140, 1405, 1710]) p.frame(at);
    p.touched(2000);
    p.frame(2016);
    expect(p.poll(2020)).not.toBeNull();
    expect(p.poll(2100)).toBeNull(); // and nothing is left behind for a second one
  });

  it("once a run has shipped, the next edge is free to arm its own", () => {
    const p = live();
    p.edge("open", 1000, 10);
    for (const at of [1016, 1140, 1405, 1710]) p.frame(at);
    p.touched(2000);
    p.frame(2016);
    expect((p.poll(2020) as { why: string }).why).toBe("open");
    expect(p.edge("cancel", 5000, 10)).toBe(true);
  });

  it("an edge on a conversation at rest is refused whichever edge it is", () => {
    for (const why of BLANK_EDGES) {
      expect(live().edge(why, 1000, BLANK_ARM_MS + 1)).toBe(false);
    }
  });

  it("a refused edge reads nothing at all: the gate is answered before the shell is", () => {
    // this earns its place now that picking a photo passes through the arming
    // call every single time, armed or not: a probe that measured the shell
    // first and decided second would put a layout flush on the ordinary pick
    const asked = vi.fn();
    const p = createBlankProbe(() => {
      asked();
      return reader();
    });
    for (const why of BLANK_EDGES) p.edge(why, 1000, BLANK_ARM_MS + 1);
    expect(asked).not.toHaveBeenCalled();
    // and a refused edge inside an open run does not read either
    p.edge("open", 2000, 10);
    expect(asked).toHaveBeenCalledTimes(1);
    p.edge("grow", 2040, 10);
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("the record carries the run, its edge, and the readings, and nothing else", () => {
    const p = live();
    p.edge("open", 1000, 10);
    for (const at of [1016, 1140, 1405, 1710]) p.frame(at);
    p.touched(2000);
    p.frame(2016);
    expect(Object.keys(p.poll(2020) as object)).toEqual(["n", "why", "t0", "paired", "f"]);
  });

  it("the moments land in order, each once, at its own offset", () => {
    const p = live();
    p.edge("cancel", 1000, 10);
    p.frame(1016); // the frame after the tap
    p.frame(1033);
    p.frame(1140); // past 130
    p.frame(1300);
    p.frame(1405); // past 400
    p.frame(1710); // past 700
    p.scrolled(3000); // the repair's first half
    p.frame(3016); // and its second
    const rec = p.poll(3020) as { f: BlankFrame[]; paired: boolean; n: number };
    expect(rec.f.map((f) => f.w)).toEqual([...BLANK_MOMENTS]);
    expect(rec.f.map((f) => f.ms)).toEqual([0, 16, 140, 405, 710, 2000, 2016]);
    expect(rec.paired).toBe(true);
    expect(rec.n).toBe(1);
  });

  it("the repair is refused until the beat is fully past, so a mid-beat scroll is not it", () => {
    const p = live();
    p.edge("cancel", 1000, 10);
    p.frame(1016);
    p.scrolled(1100); // momentum still running: counted, but not the repair
    p.frame(1140);
    p.scrolled(1200);
    p.frame(1405);
    const early = p.poll(1500);
    expect(early).toBeNull();
    p.frame(1710); // rest: now the beat is behind us
    p.touched(2000);
    p.frame(2016);
    const rec = p.poll(2020) as { f: BlankFrame[] };
    expect(rec.f.map((f) => f.w)).toEqual([...BLANK_MOMENTS]);
    expect(rec.f[5].ms).toBe(1000); // the touch, not either of the two scrolls
  });

  it("a finger and a scroll are the same repair; whichever lands first owns it", () => {
    const p = live();
    p.edge("cancel", 1000, 10);
    for (const at of [1016, 1140, 1405, 1710]) p.frame(at);
    p.touched(2000);
    p.scrolled(2004); // the scroll the finger caused must not take it a second time
    p.frame(2016);
    const rec = p.poll(2020) as { f: BlankFrame[] };
    expect(rec.f.filter((f) => f.w === "touch")).toHaveLength(1);
    expect(rec.f.filter((f) => f.w === "after")).toHaveLength(1);
  });

  it("a run nobody comes back to gives up and ships what it has, saying so", () => {
    const p = live();
    p.edge("cancel", 1000, 10);
    for (const at of [1016, 1140, 1405, 1710]) p.frame(at);
    expect(p.poll(1000 + BLANK_WAIT_MS)).toBeNull();
    const rec = p.poll(1000 + BLANK_WAIT_MS + 1) as { f: BlankFrame[]; paired: boolean };
    expect(rec.paired).toBe(false);
    expect(rec.f.map((f) => f.w)).toEqual(["edge", "frame", "mid", "beat", "rest"]);
  });

  it("the record ships exactly once, and the next armed cancel numbers itself", () => {
    const p = live();
    p.edge("cancel", 1000, 10);
    for (const at of [1016, 1140, 1405, 1710]) p.frame(at);
    p.touched(2000);
    p.frame(2016);
    expect(p.poll(2020)).not.toBeNull();
    expect(p.live()).toBe(false);
    expect(p.poll(2100)).toBeNull();
    p.edge("cancel", 9000, 10);
    for (const at of [9016, 9140, 9405, 9710]) p.frame(at);
    p.touched(9900);
    p.frame(9916);
    expect((p.poll(9920) as { n: number }).n).toBe(2);
  });

  it("the counters belong to the run: scrolls seen, settles run, and which moved", () => {
    const p = live();
    p.settled(true); // before the tap: not this run's business
    p.edge("cancel", 1000, 10);
    for (let i = 0; i < 24; i += 1) p.settled(i === 7);
    p.scrolled(1050);
    p.scrolled(1100);
    p.frame(1016);
    const rec = p.poll(1020);
    expect(rec).toBeNull();
    p.frame(1140);
    p.frame(1405);
    p.frame(1710);
    p.touched(2000);
    p.frame(2016);
    const out = p.poll(2020) as { f: BlankFrame[] };
    const last = out.f[out.f.length - 1];
    expect(last.set).toBe(24);
    expect(last.setMoved).toBe(1);
    expect(last.sc).toBe(2);
  });

  it("a slow frame that crosses two offsets at once still takes both readings", () => {
    // the phone stalling is the weather this probe works in: a run must not
    // lose a moment because one callback was late enough to cover two
    const p = live();
    p.edge("cancel", 1000, 10);
    p.frame(1016);
    p.frame(1800); // past 130, 400 and 700 in a single callback
    p.touched(2000);
    p.frame(2016);
    const rec = p.poll(2020) as { f: BlankFrame[] };
    expect(rec.f.map((f) => f.w)).toEqual([...BLANK_MOMENTS]);
    expect(rec.f.slice(2, 5).every((f) => f.ms === 800)).toBe(true);
  });

  it("the scheduled offsets are the three the banner names, in order", () => {
    expect([...BLANK_OFFSETS]).toEqual([130, 400, 700]);
    expect(BLANK_OFFSETS.length).toBe(BLANK_MOMENTS.length - 4); // tap, frame, touch, after
  });
});

describe("the probe's own weight, pinned by source", () => {
  const WRITES =
    /\.style\.|setProperty|classList|setAttribute|removeAttribute|innerHTML|textContent\s*=|appendChild|insertBefore|replaceChild|\.remove\(|scrollTo\(|scrollTop\s*=[^=]|\.animate\(|\.focus\(|\.blur\(/;

  it("it reads and never writes: no style, no class, no node, no scroll", () => {
    expect(probeSrc).not.toMatch(WRITES);
  });

  it("it can never cancel, delay or reorder the gesture it watches", () => {
    expect(probeSrc).not.toMatch(/preventDefault|stopPropagation/);
    const opts = probeSrc.match(/\{ capture: true, passive: true \}/g) ?? [];
    expect(opts).toHaveLength(2); // scroll and touchstart, both passive capture
  });

  it("the band is found by bisection, never by reading down the conversation", () => {
    // the property the first wild record cost us: no loop in the search may run
    // from the head of the list toward the view
    expect(BAND_LOOK_CAP).toBeGreaterThan(0);
    expect(probeSrc).toContain("const mid = (lo + hi) >> 1");
    expect(probeSrc).not.toMatch(/ROW_SCAN_CAP|walkBand/);
  });

  it("every resolve is charged against the budget, so nothing escapes the count", () => {
    // the cap is enforced in one place, on the one call that costs a rect read
    const at = probeSrc.slice(probeSrc.indexOf("const at = (i: number)"));
    expect(at.slice(0, 200)).toContain("if (look >= cap) return null");
    expect(at.slice(0, 200)).toContain("look += 1");
  });

  it("one client-rect read per element answers both questions the resolve asks", () => {
    // no box means a display:contents grouping or a hidden subtree, and the same
    // call hands back the box when there is one: two reads apiece would double
    // the cost of every bisection step for nothing
    expect(probeSrc).toContain("const own = el.getClientRects()");
    expect(probeSrc).not.toContain("el.getBoundingClientRect()");
  });

  it("the strip's own numbers are read off the strip, never off the thread", () => {
    expect(probeSrc).toContain("pending.offsetHeight");
  });
});

describe("wiring and call sites, pinned by source across the stamped files", () => {
  it("thread-blank is in hold.ts's post-now list: a run's record posts without waiting", () => {
    expect(holdSrc).toMatch(/ev === "thread-blank"/);
  });

  it("every way the strip's height moves arms it, opening as much as closing", () => {
    // the widening this channel was rebuilt for: an instrument armed on the
    // cancel alone would have caught nothing at all if the drawer OPENING were
    // the real trigger, and the account of it is a memory of two occurrences
    const armed = [...mainSrc.matchAll(/blankProbeEdge\(\s*(?:\n\s*)?([^,]+),/g)]
      .map((m) => m[1].trim());
    expect(armed).toEqual([
      'open ? (wasOpen ? "grow" : "open") : "shut"', // showPending: every display pass
      '"sent"', // the send's own teardown
      '"cancel"', // the ✕
    ]);
  });

  it("the before-picture is taken before anything on the cancel path changes", () => {
    const click = mainSrc.slice(mainSrc.indexOf('x.addEventListener("click"'));
    const edge = click.indexOf('blankProbeEdge("cancel"');
    const splice = click.indexOf("pendingFiles.splice(at, 1)");
    expect(edge).toBeGreaterThan(-1);
    expect(edge).toBeLessThan(splice);
  });

  it("a pass that does not move the strip does not spend the gesture's one run", () => {
    // a picker dismissed with nothing chosen re-renders a tray standing exactly
    // as it was; a run armed there would hold its slot for seconds over a frame
    // where nothing happened
    const show = fnBody("showPending");
    expect(show).toContain(
      "const drawerMoved = wasOpen !== open || pendingFiles.length !== drawerSeats",
    );
    expect(show).toContain("if (drawerMoved) {");
    // and both halves of that answer are free: a style-attribute string and a
    // count, never a measurement
    const decide = show.slice(show.indexOf("const wasOpen"), show.indexOf("if (drawerMoved)"));
    expect(decide).not.toMatch(/offsetHeight|getBoundingClientRect|getComputedStyle|clientHeight/);
  });

  it("the drawer's own edge is read before the display write, not after it", () => {
    const show = fnBody("showPending");
    expect(show.indexOf("blankProbeEdge(")).toBeLessThan(
      show.indexOf("box.style.display = open"),
    );
    // and the name it reports comes off the style attribute, which costs no
    // layout and so leaves an unarmed pass reading nothing at all
    expect(show).toContain('const wasOpen = box.style.display === "flex"');
    expect(show.indexOf("const wasOpen")).toBeLessThan(show.indexOf('box.removeAttribute("style")'));
  });

  it("the send's edge is read before the writes that hand the thread its room", () => {
    const sent = fnBody("dismissSent");
    expect(sent.indexOf('blankProbeEdge("sent"')).toBeLessThan(
      sent.indexOf("box.style.position"),
    );
    expect(sent.indexOf('blankProbeEdge("sent"')).toBeLessThan(
      sent.indexOf("box.getBoundingClientRect()"),
    );
  });

  it("the settle counter is bumped from the one settle, and reads nothing", () => {
    expect(mainSrc).toContain("blankProbeSettle(plan.moved)");
  });

  it("the follow flag is registered rather than tracked here", () => {
    expect(mainSrc).toContain("blankProbeFollow(() => followTail)");
  });

  it("the banner's TO REMOVE names every file it reaches into, so deleting is reading", () => {
    const note = /TO REMOVE, every call site:[\s\S]*?any of it\./.exec(probeSrc)?.[0] ?? "";
    for (const named of [
      "main.ts",
      "hold.ts",
      "web/app.py",
      "test_holddiag.py",
      "blankprobe.test.ts",
    ]) {
      expect([named, note.includes(named)]).toEqual([named, true]);
    }
  });
});

describe("an armed cancel through the real wiring, with a fake shell under it", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("ships one thread-blank record with the pair either side of the repair", async () => {
    vi.resetModules();

    // A LONG thread, deliberately: 400 grouping wrappers each holding one row,
    // laid out top to bottom, with the view three quarters of the way down it.
    // The old walk would have started at the head of this list and never
    // arrived; the bisection has to land on the band and report the rows really
    // standing in it. A hidden spinner sits at the head holding no box at all.
    const row = (top: number, height = 44) => ({
      children: [] as unknown[],
      getClientRects: () => [{ top, bottom: top + height }],
    });
    const wrap = (...kids: unknown[]) => ({ children: kids, getClientRects: () => [] });
    const FIRST = 100 - 300 * 54; // row 300 opens exactly at the band's top edge
    const kids: unknown[] = [wrap()]; // the spinner: a grouping with nothing in it
    for (let i = 0; i < 400; i += 1) kids.push(wrap(row(FIRST + i * 54)));
    const thread = {
      id: "thread",
      className: "thread",
      scrollHeight: 4329,
      scrollTop: 2180,
      clientHeight: 700,
      childElementCount: kids.length,
      children: kids,
      getBoundingClientRect: () => ({ top: 100, bottom: 800 }),
      getAnimations: () => [],
      closest: (sel: string) => (sel === "#thread" ? thread : null),
    };
    const app = { id: "app", className: "kb", getAnimations: () => [{}] };
    const pending = { id: "pending", offsetHeight: 76 };
    const byId: Record<string, unknown> = { thread, app, pending };

    const listeners = new Map<string, ((e: unknown) => void)[]>();
    const options = new Map<string, unknown>();
    vi.stubGlobal("document", {
      getElementById: (id: string) => byId[id] ?? null,
      addEventListener: (type: string, fn: (e: unknown) => void, opts?: unknown) => {
        listeners.set(type, [...(listeners.get(type) ?? []), fn]);
        options.set(type, opts);
      },
    });
    const rafQueue: (() => void)[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      rafQueue.push(cb);
      return 1;
    });
    vi.stubGlobal("getComputedStyle", () => ({
      display: "flex",
      getPropertyValue: () => "0px",
    }));
    vi.stubGlobal("fetch", () => Promise.resolve({ ok: true }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    let clock = 5000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const tick = (ms: number): void => {
      clock += ms;
      vi.advanceTimersByTime(ms);
    };
    const runFrame = (): void => rafQueue.shift()?.();
    const fire = (type: string, e: unknown): void => {
      for (const fn of listeners.get(type) ?? []) fn(e);
    };

    const hold = await import("../src/hold");
    const probe = await import("../src/blankprobe");
    probe.blankProbeFollow(() => false);

    for (const type of ["scroll", "touchstart"]) {
      expect([type, options.get(type)]).toEqual([type, { capture: true, passive: true }]);
    }

    // a cancel with the glide still running, then the whole beat, then the
    // finger that brings the conversation back
    probe.blankProbeEdge("cancel", 40);
    for (const at of [16, 120, 270, 300]) {
      tick(at);
      runFrame();
      fire("scroll", { target: thread });
    }
    tick(400);
    runFrame(); // rest
    tick(1200);
    fire("touchstart", { target: thread });
    tick(16);
    runFrame();

    const recs = hold.holdDiagEvents().filter((e) => e.ev === "thread-blank");
    expect(recs).toHaveLength(1);
    const d = recs[0].d as { n: number; paired: boolean; f: BlankFrame[] };
    expect(d.n).toBe(1);
    expect(d.paired).toBe(true);
    expect(d.f.map((f) => f.w)).toEqual([...BLANK_MOMENTS]);

    // the reading the whole question turns on, off a real bisection down a real
    // list of four hundred: the rows genuinely standing in the band, found
    // without the search ever visiting the head of the conversation
    const edge = d.f[0];
    expect(edge.bw).toBe("ok");
    expect(edge.vis).toBe(13); // a 700px band over a 54px pitch, row 300 on the edge
    expect(edge.top1).toBe(0); // row 300 opens exactly on the top edge
    expect(edge.h1).toBe(44);
    expect(edge.nearT).toBe(-10); // the row above ends just over it
    expect(edge.kids).toBe(401);
    // the neighbourhood it resolved: the row above, the fourteen inside, and
    // the first one below that ended the search
    expect(edge.rows).toBe(15);
    // and the cost stayed a view's worth plus a bisection, on a list this long
    expect(edge.look).toBeLessThan(BAND_LOOK_CAP);
    expect(edge.st).toBe(2180);
    expect(edge.pendH).toBe(76);
    expect(edge.pendD).toBe("flex");
    expect(edge.anA).toBe(1); // an animation on the shell root is the dangerous one
    expect(edge.anT).toBe(0);
    expect(edge.app).toBe("kb");
    expect(edge.peek).toBe("0px");

    // the pair either side of the touch reads the same, which is the shape that
    // says the repair was a repaint and nothing in the page moved
    const [touch, after] = d.f.slice(5);
    expect(after.vis).toBe(touch.vis);
    expect(after.st).toBe(touch.st);
    expect(after.rows).toBe(touch.rows);

    // the pump ends itself once the run is over
    runFrame();
    expect(rafQueue).toHaveLength(0);
  });

  it("a cancel with the conversation at rest records nothing and holds no frame", async () => {
    vi.resetModules();
    vi.stubGlobal("document", {
      getElementById: (id: string) => (id === "app" ? { id: "app" } : null),
      addEventListener: () => {},
    });
    const rafQueue: (() => void)[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      rafQueue.push(cb);
      return 1;
    });
    vi.stubGlobal("fetch", () => Promise.resolve({ ok: true }));
    vi.useFakeTimers();
    const hold = await import("../src/hold");
    const probe = await import("../src/blankprobe");
    probe.blankProbeEdge("open", BLANK_ARM_MS + 1);
    vi.advanceTimersByTime(BLANK_WAIT_MS + 2000);
    expect(hold.holdDiagEvents().filter((e) => e.ev === "thread-blank")).toHaveLength(0);
    expect(rafQueue).toHaveLength(0);
  });
});
