// Pins for the TEMP keyboard/picker diagnostic (src/shell.ts, bottom block):
// the recorders that answer the keyboard's motion on both edges, the misplaced
// picker panel and the second-compose-bar screenshot. What matters about a
// probe is that it carries the fields the session will be read from, that its
// frame loop is bounded, and above all that it never writes anything: a probe
// that disturbs the glide it is measuring measures its own weather. So the
// record builders are pure and tested directly, and the wiring (where each read
// sits relative to the writes around it) is pinned by source read, the same
// split flight.test.ts and photobox.test.ts use for code that boots a real
// shell.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CENSUS_SELECTORS,
  EDGE_FRAMES,
  EVT_FRESH_MS,
  RISE_FRAME_CAP,
  RISE_TAIL_EVERY,
  RISE_TRACE_MS,
  anchorFrame,
  closeCause,
  closeMark,
  domCensus,
  edgeFrame,
  edgeMark,
  pinRecord,
  pumpFrames,
  riseKeeps,
  sizeRecord,
} from "../src/shell";
import type { EdgeReader, World } from "../src/shell";

// a world as the shell reads one, full-screen and idle unless a case says
// otherwise; 844 is the baseline the device trails were taken on
function world(over: Partial<World> = {}): World {
  return {
    editorFocused: false,
    fileFocused: false,
    baseline: 844,
    vvHeight: 844,
    vvTop: 0,
    ...over,
  };
}

// one edge frame's geometry reads, as plain numbers
function reader(over: Partial<Record<keyof EdgeReader, unknown>> = {}): EdgeReader {
  const base = {
    padB: 34, shellH: 844, shellTop: 0, pillBot: 800.5, thBot: 760, st: 1200,
    sy: 0, vvTop: 0,
  };
  const ft = "ft" in over ? (over.ft as boolean | undefined) : true;
  const fts = "fts" in over ? (over.fts as number | undefined) : undefined;
  return {
    padB: () => (over.padB as number) ?? base.padB,
    shellH: () => (over.shellH as number) ?? base.shellH,
    shellTop: () => (over.shellTop as number) ?? base.shellTop,
    pillBot: () => (over.pillBot as number) ?? base.pillBot,
    thBot: () => (over.thBot as number) ?? base.thBot,
    st: () => (over.st as number) ?? base.st,
    sy: () => (over.sy as number) ?? base.sy,
    vvTop: () => (over.vvTop as number) ?? base.vvTop,
    fts: () => fts,
    ft: () => ft,
  };
}

describe("kb-fall / kb-rise: one record per frame, one builder for both edges", () => {
  it("carries every field an edge is read from, and nothing else", () => {
    expect(edgeFrame(16.7, reader())).toEqual({
      ms: 17, padB: 34, shellH: 844, shellTop: 0,
      pillBot: 800.5, thBot: 760, st: 1200, sy: 0, vvTop: 0, ft: true,
    });
  });

  it("the two displacement sources of a shove ride every frame, to a tenth of a pixel", () => {
    // the shoved open under hunt: the window scroll AND the viewport offset
    // both moved, and the per-frame trail recorded neither of them
    const shoved = edgeFrame(700, reader({ sy: 411.96, vvTop: 362.04 }));
    expect(shoved.sy).toBe(412);
    expect(shoved.vvTop).toBe(362);
    const rest = edgeFrame(0, reader());
    expect(rest.sy).toBe(0);
    expect(rest.vvTop).toBe(0);
  });

  it("a missing visual viewport reads null, never a zero that reads as at rest", () => {
    expect(edgeFrame(16, reader({ vvTop: NaN })).vvTop).toBeNull();
    expect(edgeFrame(16, reader({ sy: NaN })).sy).toBeNull();
  });

  it("keeps a tenth of a pixel: the hop under test is sub-pixel at its edges", () => {
    const f = edgeFrame(0, reader({ padB: 8, pillBot: 471.33, shellH: 508.06 }));
    expect(f.padB).toBe(8);
    expect(f.pillBot).toBe(471.3);
    expect(f.shellH).toBe(508.1);
  });

  it("a missing element reads null, never a number a reader could mistake for a coordinate", () => {
    const f = edgeFrame(50, reader({ pillBot: NaN, thBot: NaN, padB: NaN, shellTop: NaN }));
    expect(f.pillBot).toBeNull();
    expect(f.thBot).toBeNull();
    expect(f.padB).toBeNull();
    expect(f.shellTop).toBeNull();
    expect(f.ms).toBe(50);
  });

  it("ft is dropped rather than guessed when nothing registered a follow reader", () => {
    const f = edgeFrame(0, reader({ ft: undefined }));
    expect("ft" in f).toBe(false);
  });

  it("the shell's rendered TOP rides every frame: shrink-and-pan moves it 362px", () => {
    // the coordinate the close probe never sampled. In the pan mode the shell
    // is translated down by the whole keyboard inset and back, and a trail of
    // heights alone cannot tell a smooth translation from a snap.
    const up = edgeFrame(0, reader({ shellTop: 412, shellH: 508 }));
    const mid = edgeFrame(16, reader({ shellTop: 206, shellH: 676 }));
    expect(up.shellTop).toBe(412);
    expect(mid.shellTop).toBe(206);
  });

  it("the frame's own start rides beside the read, so a slow frame reads apart from a slow callback", () => {
    // ms is when the probe read; fts is when the browser started that frame.
    // 33ms of ms with fts moving too is a dropped frame; 33ms of ms with fts
    // where it should be is a starved callback, and the two want opposite fixes.
    const dropped = edgeFrame(33.4, reader({ fts: 33.2 }));
    const starved = edgeFrame(33.4, reader({ fts: 16.8 }));
    expect(dropped.fts).toBe(33);
    expect(dropped.ms! - dropped.fts!).toBe(0);
    expect(starved.ms! - starved.fts!).toBe(16);
  });

  it("fts is dropped on the edge sample, which happens in a handler and not in a frame", () => {
    expect("fts" in edgeFrame(0, reader())).toBe(false);
  });

  it("the discriminator survives the record: the pill's bottom before vs after the close", () => {
    // the hypothesis, as the trail would carry it — --pad-b steps its full
    // safe-area value in one frame while the shell is still gliding
    const before = edgeFrame(0, reader({ padB: 8, pillBot: 800 }));
    const after = edgeFrame(16, reader({ padB: 34, pillBot: 774 }));
    expect(before.pillBot! - after.pillBot!).toBe(26);
    expect(after.padB! - before.padB!).toBe(26);
  });
});

describe("the frame loop is bounded — a probe must not outlive what it probes", () => {
  function pump(budget: number) {
    const queue: (() => void)[] = [];
    const seen: number[] = [];
    pumpFrames(budget, (i) => seen.push(i), (cb) => queue.push(cb));
    let drained = 0;
    while (queue.length > 0 && drained < 1000) {
      queue.shift()!();
      drained += 1;
    }
    return { seen, queue };
  }

  it("runs exactly its budget of frames and then stops rescheduling", () => {
    const { seen, queue } = pump(EDGE_FRAMES);
    expect(seen).toEqual([...Array(EDGE_FRAMES).keys()]);
    expect(queue.length).toBe(0);
  });

  it("30 frames is the budget: about 0.5s at 60fps, past the 450ms settle window", () => {
    // it has to outlive the motion, and the motion outlives the 0.2s
    // transition: the shell holds a numeric box for the whole settle window and
    // drops it for the pin at about 470ms, which is where a mislanded ride home
    // snaps. Eighteen frames stopped at 300ms and could not see it.
    expect(EDGE_FRAMES).toBe(30);
    expect(EDGE_FRAMES * 16.7).toBeGreaterThan(470);
  });

  it("a zero budget schedules nothing at all", () => {
    const { seen, queue } = pump(0);
    expect(seen).toEqual([]);
    expect(queue.length).toBe(0);
  });

  it("one frame runs once and never reschedules", () => {
    const { seen, queue } = pump(1);
    expect(seen).toEqual([0]);
    expect(queue.length).toBe(0);
  });
});

// The raise's long window. The shove this trace hunts can land well after the
// glide settles: one open read sx 0 sy 0 at its edge while its own shove clear
// proved the displacement fired ten ms later, and a probe that stopped with
// the motion recorded nothing of the yank the screen actually showed. So the
// raise keeps sampling to RISE_TRACE_MS on a timed stop, dense for the first
// EDGE_FRAMES callbacks exactly as before and every other callback past them,
// while the close keeps its unchanged EDGE_FRAMES budget.
describe("the raise's window: timed to ~1.5s, dense head unchanged, tail thinned", () => {
  it("the head records every callback: exactly the frames the old budget recorded", () => {
    for (let i = 0; i < EDGE_FRAMES; i += 1) expect(riseKeeps(i)).toBe(true);
  });

  it("past the head the tail records every other callback", () => {
    expect(RISE_TAIL_EVERY).toBe(2);
    expect(riseKeeps(EDGE_FRAMES)).toBe(true);
    expect(riseKeeps(EDGE_FRAMES + 1)).toBe(false);
    expect(riseKeeps(EDGE_FRAMES + 2)).toBe(true);
    expect(riseKeeps(EDGE_FRAMES + 3)).toBe(false);
  });

  it("the timed stop ends the run at the window, well short of the callback cap", () => {
    // pump on a fake 60fps clock: the run must outlive the settle window by a
    // second, so a late shove and its correction land in recorded frames
    let clock = 0;
    const seen: number[] = [];
    pumpFrames(
      RISE_FRAME_CAP,
      (i) => seen.push(i),
      (cb) => { clock += 16.7; cb(); },
      () => clock >= RISE_TRACE_MS,
    );
    expect(seen.length).toBe(90); // ~1500ms of 16.7ms frames
    expect(seen.length).toBeLessThan(RISE_FRAME_CAP);
    expect(seen.length).toBeGreaterThan(EDGE_FRAMES); // the old budget saw none of this
  });

  it("about sixty records per raise: the tail is thinned, the ring is not flooded", () => {
    const recorded: number[] = [];
    let clock = 0;
    pumpFrames(
      RISE_FRAME_CAP,
      (i) => { if (riseKeeps(i)) recorded.push(i); },
      (cb) => { clock += 16.7; cb(); },
      () => clock >= RISE_TRACE_MS,
    );
    expect(recorded.length).toBe(60); // 30 dense + 30 thinned, not 90
    // the thinned tail still reaches the window's far end, where the late
    // shove and its correction land
    expect(recorded[recorded.length - 1] * 16.7).toBeGreaterThan(1400);
    // and no two kept callbacks are ever further apart than the stride
    for (let k = 1; k < recorded.length; k += 1) {
      expect(recorded[k] - recorded[k - 1]).toBeLessThanOrEqual(RISE_TAIL_EVERY);
    }
  });

  it("a done that never fires defers to the budget, the close's unchanged behavior", () => {
    const seen: number[] = [];
    pumpFrames(5, (i) => seen.push(i), (cb) => cb(), () => false);
    expect(seen).toEqual([0, 1, 2, 3, 4]);
  });

  it("the cap outlives the window even at 120Hz, so the clock is the stopper", () => {
    expect(RISE_TRACE_MS).toBe(1500);
    expect(RISE_FRAME_CAP * (1000 / 120)).toBeGreaterThan(RISE_TRACE_MS);
  });
});

// A census is only worth reading if it counts the real document, so the fake
// below matches selectors rather than answering from a lookup table: it is the
// same minimal-node approach dots.test.ts uses, narrowed to the five selectors
// the census asks about.
class FakeEl {
  constructor(
    public tag: string,
    public id = "",
    public classes: string[] = [],
    public data: Record<string, string> = {},
  ) {}

  matches(sel: string): boolean {
    if (sel.startsWith("#")) return this.id === sel.slice(1);
    if (sel.startsWith(".")) return this.classes.includes(sel.slice(1));
    const attr = /^([a-z]+)\[data-([a-z-]+)='([^']+)'\]$/.exec(sel);
    if (attr) return this.tag === attr[1] && this.data[attr[2]] === attr[3];
    throw new Error(`census selector the fake cannot match: ${sel}`);
  }
}

class FakeDoc {
  constructor(private nodes: FakeEl[]) {}
  querySelectorAll(sel: string): { length: number } {
    return this.nodes.filter((n) => n.matches(sel));
  }
}

const shellDoc = (): FakeEl[] => [
  new FakeEl("div", "app"),
  new FakeEl("header", "", ["bar"]),
  new FakeEl("main", "thread", ["thread"]),
  new FakeEl("form", "compose", ["compose"]),
  new FakeEl("textarea", "text"),
  new FakeEl("textarea", "", [], { mirror: "compose" }),
];

describe("dom-census — is there really only one compose bar", () => {
  it("a healthy shell reads one of everything", () => {
    expect(domCensus(new FakeDoc(shellDoc()))).toEqual({
      app: 1, compose: 1, bar: 1, thread: 1, mirror: 1,
    });
  });

  it("a second compose bar would read 2 — the whole point of taking the census", () => {
    const doc = new FakeDoc([...shellDoc(), new FakeEl("form", "", ["compose"])]);
    expect(domCensus(doc).compose).toBe(2);
    expect(domCensus(doc).app).toBe(1); // one shell, as the earlier investigation found
  });

  it("counts zero rather than throwing when the shell has not rendered yet", () => {
    expect(domCensus(new FakeDoc([new FakeEl("div", "app")]))).toEqual({
      app: 1, compose: 0, bar: 0, thread: 0, mirror: 0,
    });
  });

  it("the selectors are the ones the app actually renders", () => {
    // a census aimed at markup that does not exist would report 0 forever and
    // read as proof of the very thing it is meant to test
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    const mirror = readFileSync(new URL("../src/mirror.ts", import.meta.url), "utf8");
    const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    expect(index).toMatch(/<div id="app">/);
    expect(main).toMatch(/<header class="bar">/);
    expect(main).toMatch(/<main id="thread" class="thread">/);
    expect(main).toMatch(/<form id="compose" class="compose">/);
    expect(mirror).toMatch(/twinEl\.dataset\.mirror = "compose";/);
    expect(Object.values(CENSUS_SELECTORS)).toEqual([
      "#app", ".compose", ".bar", ".thread", "textarea[data-mirror='compose']",
    ]);
  });
});

describe("pick-anchor — which rect iOS anchored the panel to", () => {
  it("names both rects and hands the reader the gap already subtracted", () => {
    const file = { left: 12, top: 742, width: 34, height: 34 };
    const plus = { left: 12, top: 742, width: 34, height: 34 };
    expect(anchorFrame(file, plus, false, 8123.6)).toEqual({
      fileLeft: 12, fileTop: 742, fileW: 34, fileH: 34,
      plusLeft: 12, plusTop: 742, plusW: 34, plusH: 34,
      dx: 0, dy: 0, fresh: false, upMs: 8124,
    });
  });

  it("the failure shape reads straight off the line: the input drifted right of the ＋", () => {
    const f = anchorFrame(
      { left: 168, top: 742, width: 34, height: 34 },
      { left: 12, top: 742, width: 34, height: 34 },
      true,
      2100,
    );
    expect(f.dx).toBe(156);
    expect(f.dy).toBe(0); // vertically it looks right on device, and should read so
    expect(f.fresh).toBe(true); // whether this present swapped in a virgin input
  });

  it("uptime rides the record, because the misfire clusters soon after a load", () => {
    expect(anchorFrame(
      { left: 12, top: 0, width: 34, height: 34 },
      { left: 12, top: 0, width: 34, height: 34 },
      false,
      1499.5,
    ).upMs).toBe(1500);
  });
});

// Where each read sits relative to the writes around it IS the design here.
// The pre-edge sample must land before the class toggle that moves --pad-b
// (after it, the before/after comparison is already gone), the anchor read must
// land after the click that presented (before it, the read's own layout flush
// could straighten the very rect the panel was mis-anchored to), and the
// per-frame body must write nothing whatsoever.
describe("wiring: read-only, and each read on the right side of the writes", () => {
  const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
  const hold = readFileSync(new URL("../src/hold.ts", import.meta.url), "utf8");
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

  it("both pre-edge frames are sampled before .kb is toggled, not after", () => {
    expect(shell).toMatch(
      /if \(!t\.kb && appliedKb\) fallEdge\(\);[\s\S]{0,900}appEl\.classList\.toggle\("kb", t\.kb\);/,
    );
    expect(shell).toMatch(
      /if \(t\.kb && !appliedKb\) riseEdge\(\);[\s\S]{0,900}appEl\.classList\.toggle\("kb", t\.kb\);/,
    );
    // and it is the frame the rest are measured against: ms 0, clock started
    // here. The window is a proximity pin on one function's body, not a byte
    // budget: it holds the head build between the two, and the head grew when
    // the close learned to name its cause.
    expect(shell).toMatch(/edgeT0 = performance\.now\(\);[\s\S]{0,2100}edgeSample\(0, undefined\);/);
  });

  it("one probe serves both edges: the same start, the same builder, only the channel differs", () => {
    // two probes that merely looked alike would make a difference between the
    // raise and the close evidence about the copies rather than about the phone
    expect(shell).toMatch(/function fallEdge\(\): void \{\n\s*edgeStart\("close"\);\n\}/);
    expect(shell).toMatch(/function riseEdge\(\): void \{\n\s*edgeStart\("open"\);\n\}/);
    expect(shell).toMatch(/edgeChannel = kind === "open" \? "kb-rise" : "kb-fall";/);
    expect(shell.match(/holdDiagRecord\(edgeChannel, frame\);/g)?.length).toBe(1);
    expect(shell.match(/function edgeSample\(/g)?.length).toBe(1);
    expect(shell.match(/pumpFrames\(/g)?.length).toBe(2); // the definition and its one caller
  });

  it("--pad-b is read as a used length, since a custom property computes to its own tokens", () => {
    expect(shell).toMatch(/edgeStyle = compose \? getComputedStyle\(compose\) : null;/);
    expect(shell).toMatch(/parseFloat\(edgeStyle\.paddingBottom\)/);
  });

  it("the loop starts after the close's correction pass, and on the raise there is nothing to wait for", () => {
    expect(shell).toMatch(/correctionPass\("close"\);\n\s*startEdgeProbe\(\);/);
    expect(shell).toMatch(/if \(!wasUp && t\.kb\) startEdgeProbe\(\);/);
    // and both sit at the END of the app's own bookkeeping for the edge, which
    // is what makes the `armed` number on the two edges the same measurement
    expect(shell).toMatch(/if \(wasUp && !t\.kb\) keyboardClosed\(\);[\s\S]{0,400}if \(!wasUp && t\.kb\) startEdgeProbe\(\);/);
  });

  it("the per-frame body only reads — no class, style, scroll or node write anywhere in it", () => {
    const body = shell.match(
      /function edgeSample\(ms: number, fts: number \| undefined\): EdgeFrame \{[\s\S]*?\n\}/,
    )?.[0] ?? "";
    expect(body).toContain("holdDiagRecord(edgeChannel, frame)");
    expect(body).not.toMatch(/classList|setProperty|scrollTo\(|scrollTop =|\.style\.|appendChild/);
    // the lookups happen once at the edge, so the loop adds no query per frame
    expect(body).not.toMatch(/querySelector|getElementById|getComputedStyle/);
    // one rect per element, taken before the readers run: every field lifted
    // off the same element costs one measurement, not one each
    expect(body.match(/getBoundingClientRect\(\)/g)?.length).toBe(3);
    expect(body).toMatch(/shellH: \(\) => shell\?\.height[\s\S]{0,80}shellTop: \(\) => shell\?\.top/);
  });

  it("the frame's scroll reads are the already-computed values, not layout-forcing ones", () => {
    const body = shell.match(
      /function edgeSample\(ms: number, fts: number \| undefined\): EdgeFrame \{[\s\S]*?\n\}/,
    )?.[0] ?? "";
    expect(body).toMatch(/sy: \(\) => window\.scrollY,/);
    expect(body).toMatch(/vvTop: \(\) => window\.visualViewport\?\.offsetTop \?\? NaN,/);
  });

  it("only the raise runs the long window; the close keeps its unchanged budget", () => {
    expect(shell).toMatch(/const rise = edgeChannel === "kb-rise";/);
    expect(shell).toMatch(/rise \? RISE_FRAME_CAP : EDGE_FRAMES,/);
    expect(shell).toMatch(
      /rise \? \(\) => run !== edgeRun \|\| performance\.now\(\) - t0 >= RISE_TRACE_MS : undefined,/,
    );
    // the thinning runs through the one predicate, after the stale-run guard
    expect(shell).toMatch(/if \(run !== edgeRun\) return;[\s\S]{0,260}if \(!riseKeeps\(i\)\) return;/);
  });

  it("the shove clear names its edge: en is the counter the kb-edge record carries as n", () => {
    expect(shell).toMatch(/holdDiagRecord\("kb-shove", \{ act: "clear", n: shoveClears, en: edgeRun/);
    expect(shell).toMatch(/holdDiagRecord\("kb-shove", \{ act: "yield", n: shoveClears, en: edgeRun/);
    expect(shell).toMatch(/n: edgeRun,/); // the edge record's own counter, unchanged
  });

  it("the rAF wrapper hands the frame its own start time and does nothing else", () => {
    expect(shell).toMatch(
      /requestAnimationFrame\(\(ts\) => \{\n\s*fts = ts;\n\s*cb\(\);\n\s*\}\);/,
    );
    // held in the run's own closure, so a stale value cannot leak into the next edge
    expect(shell).toMatch(/let fts = -1; \/\/ the running frame's own start/);
  });

  it("a newer edge inside the window owns the frames, so two runs cannot interleave", () => {
    expect(shell).toMatch(/if \(run !== edgeRun\) return;/);
    // and the edge record is written once, from the run's own first frame
    expect(shell).toMatch(/if \(i === 0 && edgeHead && edgeZero\) \{/);
    expect(shell).toMatch(/edgeHead = null; \/\/ one record per edge/);
  });

  it("the viewport event is stamped by a listener registered ahead of the one that acts on it", () => {
    expect(shell).toMatch(
      /addEventListener\("resize", markViewportEvent\);\n\s*window\.visualViewport\?\.addEventListener\("scroll", markViewportEvent\);\n\s*window\.visualViewport\?\.addEventListener\("resize", reconcile\);/,
    );
    // and it only assigns: an observer that measured anything would be a write
    // in the hottest path the app has
    const body = shell.match(/function markViewportEvent\(e: Event\): void \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(body).toMatch(/edgeVvAt = e\.timeStamp;\n\s*edgeVvSrc = e\.type;/);
    expect(body).not.toMatch(/getBoundingClientRect|getComputedStyle|scroll[XY]|holdDiagRecord/);
  });

  it("kb-fall and kb-rise stay out of the post-now list; kb-edge, which fires once, is in it", () => {
    expect(hold).toMatch(/ev === "pick-anchor"/);
    expect(hold).toMatch(/ev === "kb-edge"/);
    expect(hold).not.toMatch(/ev === "kb-fall"/);
    expect(hold).not.toMatch(/ev === "kb-rise"/);
    expect(hold).not.toMatch(/ev === "shell-pin"/);
  });

  it("the census sits at the kb-close record's site and fires once per close", () => {
    expect(shell).toMatch(
      /if \(phase === "close"\) censusRecord\(\);[\s\S]{0,300}holdDiagRecord\("kb-close"/,
    );
  });

  it("the anchor rects are read after the click that presented, before anything reconciles", () => {
    expect(shell).toMatch(
      /fileEl\?\.click\(\);[\s\S]{0,300}pickAnchorRecord\(fresh\);\n\s*reconcile\(\);/,
    );
  });

  it("the safe-area probe is measured and gone inside one run, and records insetB", () => {
    expect(shell).toMatch(/appEl\.appendChild\(probe\);[\s\S]{0,200}probe\.remove\(\);/);
    expect(shell).toMatch(/height:env\(safe-area-inset-bottom, 0px\)/);
    expect(shell).toMatch(/holdDiagRecord\("safe-area", \{ insetB: px\(insetB\) \}\)/);
    expect(shell).toMatch(/recordSafeArea\(\);\n\}/); // the tail of initShell
  });

  it("followTail is read through a registered reader, never reached into", () => {
    expect(main).toMatch(/watchFollowTail\(\(\) => followTail\);/);
    expect(shell).toMatch(/export function watchFollowTail\(read: \(\) => boolean\): void \{/);
  });
});

// kb-edge is the record this session exists for. The close trail said the bar's
// first painted frame lands 6 to 45ms after the keyboard edge, and that the
// app's bookkeeping for the edge ran 1-3ms on the closes that started gently
// and 8-12ms on the ones that stalled, but both of those were FITTED out of
// timestamps a millisecond apart, and the causation is still only a
// correlation. Fitting is what this record ends: it states each clock, and it
// states the pixels that had actually moved by the first frame, so the stall is
// read rather than inferred.
describe("kb-edge: where the delay between the edge and the first frame went", () => {
  const head = {
    edge: "open", n: 7, src: "resize", evt: 0.4,
    sx: 0, sy: 412, vvTop: 412, vvH: 508,
    foc: 260, boxTop: 412, boxH: 508, seed: true,
  };
  const zero = edgeFrame(0, reader({ padB: 34, shellH: 844, shellTop: 0, pillBot: 800 }));

  it("names the three clocks and hands the reader the pixels already subtracted", () => {
    const first = edgeFrame(24, reader({ padB: 8, shellH: 700, shellTop: 140, pillBot: 690 }));
    expect(edgeMark(head, { armed: 9.6, frame: 20.2, read: 24.1 }, zero, first)).toEqual({
      ...head,
      armed: 9.6, frame: 20.2, read: 24.1,
      dTop: 140, dH: -144, dPad: -26,
    });
  });

  it("a gentle start and a stalled one read apart on one line, without fitting a curve", () => {
    // the two shapes the close trail showed, as this record would carry them
    const gentleFrame = edgeFrame(8, reader({ shellH: 838, shellTop: 0, padB: 33 }));
    const stalledFrame = edgeFrame(45, reader({ shellH: 703, shellTop: 0, padB: 25 }));
    const gentle = edgeMark(head, { armed: 1.8, frame: 6.1, read: 8.0 }, zero, gentleFrame);
    const stalled = edgeMark(head, { armed: 10.4, frame: 41.0, read: 45.2 }, zero, stalledFrame);
    expect(gentle.dH).toBe(-6); // a few px in: the motion started when it was told to
    expect(stalled.dH).toBe(-141); // a third of the trip in one step, after holding still
    expect(gentle.armed).toBe(1.8);
    expect(stalled.armed).toBe(10.4);
  });

  it("keeps a tenth of a millisecond: the whole discriminator is 1-3ms against 8-12ms", () => {
    const m = edgeMark(head, { armed: 2.44, frame: 6.06, read: 7.98 }, zero, zero);
    expect(m.armed).toBe(2.4);
    expect(m.frame).toBe(6.1);
    expect(m.read).toBe(8);
  });

  it("a quantity with no reading moves null rather than an invented zero", () => {
    const blind = edgeFrame(16, reader({ padB: NaN, shellTop: NaN }));
    const m = edgeMark(head, { armed: 1, frame: 2, read: 3 }, zero, blind);
    expect(m.dPad).toBeNull();
    expect(m.dTop).toBeNull();
    expect(m.dH).toBe(0);
  });

  it("carries the head untouched, so the edge's own numbers ride the same line", () => {
    const m = edgeMark(head, { armed: 1, frame: 2, read: 3 }, zero, zero);
    // the raise's double box write, as one line: the edge fired on a window
    // scrolled 412px down, tracked it (shoveVerdict tracks at every edge, and
    // writes no kb-shove for it), and told the shell to go to top 412
    expect(m.sy).toBe(412);
    expect(m.vvTop).toBe(412);
    expect(m.boxTop).toBe(412);
    // and how far apart the two halves of the raise were started: styles.css
    // runs the ＋ collapse from the focus tap, the shell's glide from here
    expect(m.foc).toBe(260);
    expect(m.seed).toBe(true);
  });

  it("a stale viewport stamp is refused rather than read as a fast dispatch", () => {
    expect(EVT_FRESH_MS).toBe(100);
    const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
    expect(shell).toMatch(/const fresh = edgeVvAt >= 0 && since >= 0 && since < EVT_FRESH_MS;/);
    expect(shell).toMatch(/src: fresh \? edgeVvSrc : "other",/);
    expect(shell).toMatch(/evt: fresh \? px\(since\) : -1,/);
  });
});

// The box writes. A raise was seen writing the shell's box twice, first to a
// top of 412 and then to 0 sixteen ms later, with a shove clear alongside, and
// the old record could say neither whether those writes ANIMATED nor how far
// into the motion they landed, which is the whole difference between a harmless
// correction and a shell told to slide most of a screen and then re-aimed.
describe("shell-size / shell-pin: what the box was set to, when, and whether it animated", () => {
  it("keeps the fields the last session was read in and adds the three it lacked", () => {
    expect(sizeRecord(412, 508, true, true, 0.2)).toEqual({
      top: 412, h: 508, glide: true, edge: true, ems: 0.2,
    });
    // the same top/h a trail from before this build carries, so the two read
    // against each other
    expect(Object.keys(sizeRecord(0, 844, false, false, -1)).slice(0, 2)).toEqual(["top", "h"]);
  });

  it("the double write reads as two lines on one clock", () => {
    const first = sizeRecord(412, 508, true, true, 0.3);
    const second = sizeRecord(0, 508, true, false, 16.9);
    expect(first.edge).toBe(true); // the edge's own write
    expect(second.edge).toBe(false); // and the re-aim, one frame later
    expect(second.ems).toBe(16.9); // still inside the glide, so it animates
    expect(second.glide).toBe(true);
  });

  it("a mid-typing write reads instant and off the edge's clock", () => {
    const r = sizeRecord(0, 508, false, false, 3200.4);
    expect(r.glide).toBe(false); // no transition: an active-growth frame never smears
    expect(r.ems).toBe(3200.4);
  });

  it("shell-pin marks the frame the numeric box is dropped for the four-edge pin", () => {
    expect(pinRecord(0, 844, 471.6)).toEqual({ top: 0, h: 844, ems: 471.6 });
    // if the ride home had not landed on the pin's own geometry, this is the
    // height it snapped FROM, and the probe's own last frames say what it
    // snapped TO
    expect(pinRecord(0, 820, 470)).toEqual({ top: 0, h: 820, ems: 470 });
  });

  it("ems reads -1 before there has ever been an edge, never 0", () => {
    // 0 would read as "at the edge", which is the one thing it is not
    expect(sizeRecord(0, 844, false, false, -1).ems).toBe(-1);
    const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
    expect(shell).toMatch(/return edgeT0 === 0 \? -1 : performance\.now\(\) - edgeT0;/);
  });
});

// The box records sit at the writes themselves, and the pin record at the one
// place the box is taken away. Everything else about applyShell has to be
// untouched: it is the app's one writer, and a probe that changed the order of
// its writes would be measuring a different app.
describe("wiring: the box records sit at the writes, and change none of them", () => {
  const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");

  it("the edge flag is read before the toggle that would erase it", () => {
    expect(shell).toMatch(
      /const atEdge = t\.kb !== appliedKb;[\s\S]{0,400}if \(t\.kb !== appliedKb\) \{\n\s*appliedKb = t\.kb;/,
    );
  });

  it("both box writes record through the one builder, after the write, never before", () => {
    expect(shell).toMatch(
      /appEl\.style\.setProperty\("--shell-h", `\$\{box\.height\}px`\);\n[^\n]*\n\s*recordShellSize\(top, height, gliding, atEdge\);/,
    );
    expect(shell).toMatch(
      /appEl\.style\.setProperty\("--shell-h", `\$\{restH\}px`\);\n\s*recordShellSize\(0, restH, gliding, atEdge\);/,
    );
    expect(shell.match(/recordShellSize\(/g)?.length).toBe(3); // the definition and its two sites
  });

  it("the seeding reflow names itself on the edge record instead of being inferred", () => {
    // it is a forced layout inside the write path, once per raise, right at the
    // edge, a candidate for the very stall the edge record measures
    expect(shell).toMatch(/void appEl\.offsetHeight;\n\s*edgeSeeded = true;/);
    expect(shell).toMatch(/edgeHead\.seed = edgeSeeded;/);
  });

  it("the pin record reads the box that was there, not the nulls that replace it", () => {
    expect(shell).toMatch(
      /const wasTop = appliedTop;\n\s*const wasH = appliedHeight;\n\s*appliedTop = null;/,
    );
    expect(shell).toMatch(/appEl\.style\.removeProperty\("--shell-h"\);[\s\S]{0,300}recordShellPin\(wasTop, wasH\);/);
  });

  it("neither record touches the writes it sits beside", () => {
    for (const name of ["recordShellSize", "recordShellPin"]) {
      const body = shell.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))?.[0] ?? "";
      expect([name, body.length > 0]).toEqual([name, true]);
      expect(body).not.toMatch(/classList|setProperty|removeProperty|scrollTo\(|offsetHeight/);
      expect(body).not.toMatch(/getBoundingClientRect|getComputedStyle/);
    }
  });
});

// The white band. The shell keeps standing at keyboard height for about a
// second after the keyboard has visibly gone, leaving white between the compose
// bar and the bottom of the screen, and then snaps to full height — which reads
// as the whole view dropping. "Is there a keyboard" is an AND of focus and a
// short viewport, so the close fires on whichever input flips FIRST, and the
// record could not say which: six of eight production closes carried src
// "other", which only means no fresh viewport event was in flight. Worse, five
// of those six acted while the viewport was STILL reporting the keyboard-sized
// height, so the phone's own number was stale and the app had been standing
// short for a period nothing recorded at all.
describe("kb-edge close: which input flipped it, and whether the viewport still lied", () => {
  // the keyboard-up world every case below closes from: 412px of keyboard
  // against the 844 screen the device trails were taken on
  const up = world({ editorFocused: true, vvHeight: 432 });

  it("focus letting go first is named focus, whatever the viewport still claims", () => {
    // the five closes under hunt: the editor loses focus and the phone is still
    // publishing 432 against an 844 screen
    expect(closeCause(up, world({ editorFocused: false, vvHeight: 432 }))).toBe("focus");
  });

  it("the viewport growing back under a still-focused editor is named viewport", () => {
    expect(closeCause(up, world({ editorFocused: true, vvHeight: 844 }))).toBe("viewport");
  });

  it("both inputs moving in one evaluation reads as both, never as either alone", () => {
    expect(closeCause(up, world({ editorFocused: false, vvHeight: 844 }))).toBe("both");
  });

  it("a first evaluation, with nothing to compare against, says unknown rather than guessing", () => {
    expect(closeCause(null, world({ vvHeight: 844 }))).toBe("unknown");
  });

  it("a shrink too small to be a keyboard is not the viewport growing back", () => {
    // the iOS 26 stale-viewport lie is tens of px (keyboardInset's filter), and
    // a cause read off one would name something that never happened
    const lie = world({ editorFocused: true, vvHeight: 820 });
    expect(closeCause(lie, world({ editorFocused: true, vvHeight: 844 }))).toBe("unknown");
  });

  it("vvStale is true when the phone was still reporting a keyboard-sized screen", () => {
    // the whole point of the record: true means the app had been standing short
    // with no way to know for how long
    expect(closeMark(up, world({ editorFocused: false, vvHeight: 432 }), 980)).toEqual({
      cause: "focus", vvBase: 844, vvStale: true, vvHeldMs: 980,
    });
  });

  it("vvStale is false when the viewport itself is what flipped the close", () => {
    expect(closeMark(up, world({ editorFocused: true, vvHeight: 844 }), 16)).toEqual({
      cause: "viewport", vvBase: 844, vvStale: false, vvHeldMs: 16,
    });
  });

  it("the baseline rides beside the height, so the subtraction is on the line", () => {
    // vvH is already on the head; vvBase is what it was judged against, and
    // 844 - 432 over MIN_KEYBOARD_PX is the whole of the stale verdict
    const m = closeMark(up, world({ editorFocused: false, vvHeight: 432 }), 500);
    expect(m.vvBase).toBe(844);
    expect(m.vvStale).toBe(true);
  });

  it("vvHeldMs is how long that one number had stood: the band's upper bound", () => {
    // a viewport that republished 16ms ago was not stuck; one holding the same
    // number for most of a second is the second the user reports
    expect(closeMark(up, world({ editorFocused: false, vvHeight: 432 }), 16).vvHeldMs).toBe(16);
    expect(closeMark(up, world({ editorFocused: false, vvHeight: 432 }), 983.62).vvHeldMs).toBe(984);
  });

  it("vvHeldMs reads -1 before any height change has been seen, never a 0 that reads as fresh", () => {
    expect(closeMark(up, up, -1).vvHeldMs).toBe(-1);
  });

  it("a fractional baseline rounds like every other pixel on the line", () => {
    expect(closeMark(up, world({ editorFocused: false, baseline: 843.5, vvHeight: 432 }), 0).vvBase)
      .toBe(844);
  });
});

// The close facts are stamps taken before anything acts on the evaluation they
// describe: the pair of worlds the cause is read from, the clock that says how
// long the viewport has been holding one number, and the wait a lying close
// opens. None of them may read geometry or touch the target the shell is about
// to be written from — a probe that moved the close would be measuring itself.
describe("wiring: the close facts are stamped, never measured", () => {
  const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");

  it("the world is read once and shared, so the edge sees the evaluation's own numbers", () => {
    expect(shell).toMatch(/const w = readWorld\(\);\n\s*const t = computeShell\(w\);/);
  });

  it("the two worlds advance as a pair, so an edge can never be handed itself as its before", () => {
    expect(shell).toMatch(/edgeWorldBefore = edgeWorld;\n\s*edgeWorld = w;/);
  });

  it("the height clock moves on ANY change and does nothing else", () => {
    expect(shell).toMatch(
      /if \(w\.vvHeight !== vvHeightSeen\) \{\n\s*vvHeightSeen = w\.vvHeight;\n\s*vvHeightAt = performance\.now\(\);\n\s*\}/,
    );
  });

  it("the close facts join the head right after vvH, and only on a close", () => {
    expect(shell).toMatch(
      /kind === "close" && edgeWorld\n\s*\? closeMark\(edgeWorldBefore, edgeWorld, vvHeightAt === 0 \? -1 : edgeT0 - vvHeightAt\)/,
    );
    expect(shell).toMatch(/vvH: Math\.round\(vv\?\.height \?\? 0\),[\s\S]{0,260}\.\.\.\(close \?\? \{\}\),/);
  });

  it("a stale close arms the follow-up wait and every other edge cancels one", () => {
    expect(shell).toMatch(/staleCloseAt = close\?\.vvStale === true \? edgeT0 : -1;/);
    expect(shell).toMatch(/staleCloseRun = edgeRun;/);
  });

  it("the wait ends on the first reading that agrees the screen is whole again", () => {
    expect(shell).toMatch(
      /if \(staleCloseAt >= 0 && keyboardInset\(w\.baseline, w\.vvHeight\) === 0\) \{/,
    );
    expect(shell).toMatch(/staleCloseAt = -1;\n\s*\}/);
  });

  it("the follow-up is its own record on the same channel, not an edge held back", () => {
    // the edge record must not wait on the very viewport it is accusing
    expect(shell).toMatch(
      /holdDiagRecord\("kb-edge", \{\n\s*edge: "late",\n\s*n: staleCloseRun,\n\s*vvLateMs: Math\.round\(performance\.now\(\) - staleCloseAt\),\n\s*\}\);/,
    );
  });

  it("neither builder reads anything: they are handed worlds and return a record", () => {
    for (const name of ["closeCause", "closeMark"]) {
      const body = shell.match(new RegExp(`export function ${name}\\([\\s\\S]*?\\n\\}`))?.[0] ?? "";
      expect([name, body.length > 0]).toEqual([name, true]);
      expect(body).not.toMatch(/window\.|document\.|performance\.|holdDiagRecord/);
    }
  });

  it("the banner's TO REMOVE names the world split, which is the one line that was not additive", () => {
    const note = shell.match(/\/\/ TO REMOVE: delete this block[\s\S]*?digest filters\./)?.[0] ?? "";
    expect(note).toContain("computeShell(readWorld())");
  });
});
