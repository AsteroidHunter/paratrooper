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
  PICK_VIA_PLUS,
  PICK_VIA_PROBE,
  anchorFrame,
  anchorRecord,
  domCensus,
  edgeFrame,
  edgeMark,
  pinRecord,
  pumpFrames,
  sizeRecord,
} from "../src/shell";
import type { EdgeReader } from "../src/shell";

// one edge frame's geometry reads, as plain numbers
function reader(over: Partial<Record<keyof EdgeReader, unknown>> = {}): EdgeReader {
  const base = { padB: 34, shellH: 844, shellTop: 0, pillBot: 800.5, thBot: 760, st: 1200 };
  const ft = "ft" in over ? (over.ft as boolean | undefined) : true;
  const fts = "fts" in over ? (over.fts as number | undefined) : undefined;
  return {
    padB: () => (over.padB as number) ?? base.padB,
    shellH: () => (over.shellH as number) ?? base.shellH,
    shellTop: () => (over.shellTop as number) ?? base.shellTop,
    pillBot: () => (over.pillBot as number) ?? base.pillBot,
    thBot: () => (over.thBot as number) ?? base.thBot,
    st: () => (over.st as number) ?? base.st,
    fts: () => fts,
    ft: () => ft,
  };
}

describe("kb-fall / kb-rise: one record per frame, one builder for both edges", () => {
  it("carries every field an edge is read from, and nothing else", () => {
    expect(edgeFrame(16.7, reader())).toEqual({
      ms: 17, padB: 34, shellH: 844, shellTop: 0,
      pillBot: 800.5, thBot: 760, st: 1200, ft: true,
    });
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
    // and it is the frame the rest are measured against: ms 0, clock started here
    expect(shell).toMatch(/edgeT0 = performance\.now\(\);[\s\S]{0,1400}edgeSample\(0, undefined\);/);
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

// The pick-probe: a second trigger for the picker, put at the far end of the
// screen from the ＋, so that one tap says whether the panel is anchored to the
// hidden input's rect or to where the finger landed. The whole experiment rests
// on one property, and it is the property these pin: the two triggers must be
// ONE code path. If they were two paths that merely look alike, a panel landing
// somewhere new would be evidence about the copy rather than about iOS. So the
// ＋'s handlers are named functions and the probe calls those same functions;
// nothing is duplicated, nothing is re-implemented, and the only thing that
// differs between a ＋ tap and a probe tap is the label that rides the record.
describe("pick-probe: one open, two triggers, one label to tell them apart", () => {
  const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const START = "// ===================== TEMP DIAGNOSTIC (remove after the pick-probe session)";
  const END = "// =================== END TEMP DIAGNOSTIC (remove after the pick-probe session)";
  const from = shell.indexOf(START);
  const to = shell.indexOf(END);
  const block = shell.slice(from, to + END.length);
  const outside = shell.slice(0, from) + shell.slice(to + END.length);
  const probeRule = css.match(/\.pickprobe \{([^}]*)\}/)?.[1] ?? "";
  // The counting pins below are about code, so the prose comes out first: a
  // comment naming picker.open() must neither satisfy a pin nor break one. Same
  // rule the stylesheet pins in shell.test.ts follow.
  const code = (src: string): string =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/[ \t]\/\/.*$/gm, "");
  const shellCode = code(shell);
  const blockCode = code(block);

  it("both triggers call the same open function, and the module holds exactly one picker.open()", () => {
    expect(shell).toMatch(
      /function pickerTapOpen\(\): void \{[\s\S]{0,400}if \(picker\.isTearing\(\)\) return;\n\s*picker\.open\(\);\n\}/,
    );
    expect(shellCode.match(/pickerTapOpen\(\);/g)?.length).toBe(2); // the ＋'s click and the probe's
    expect(shellCode.match(/picker\.open\(\)/g)?.length).toBe(1); // one open in the whole file
  });

  it("that one open clicks the module's one file input; the probe never makes an input of its own", () => {
    expect(shell).toMatch(
      /present: \(fresh: boolean\) => \{\n\s*if \(fresh\) swapFileInput\(\);\n\s*fileEl\?\.click\(\);/,
    );
    expect(shellCode.match(/fileEl\?\.click\(\)/g)?.length).toBe(1);
    // a second input, or a click of its own, would make the two taps
    // incomparable and the whole probe pointless
    expect(blockCode).not.toMatch(/createElement\("input"\)/);
    expect(blockCode).not.toMatch(/type="file"|type = "file"/);
    expect(blockCode).not.toMatch(/\.click\(\)/);
    expect(blockCode).not.toMatch(/swapFileInput|fileEl/);
  });

  it("the probe takes the ＋'s pointerdown shield too, so the taps differ in nothing but place", () => {
    expect(shell).toMatch(
      /function pickerTapShield\(e: Event\): void \{\n\s*if \(preservesFocus\(readWorld\(\)\)\) e\.preventDefault\(\);\n\}/,
    );
    expect(shell).toMatch(/button\.addEventListener\("pointerdown", pickerTapShield\);/);
    expect(block).toMatch(/el\.addEventListener\("pointerdown", pickerTapShield\);/);
  });

  it("the record names the trigger, on top of the rects the session already reads", () => {
    const file = { left: 12, top: 742, width: 34, height: 34 };
    const plus = { left: 12, top: 742, width: 34, height: 34 };
    expect(anchorRecord(file, plus, false, 8123.6, PICK_VIA_PROBE)).toEqual({
      ...anchorFrame(file, plus, false, 8123.6),
      via: "probe",
    });
    expect(anchorRecord(file, plus, true, 0, PICK_VIA_PLUS).via).toBe("plus");
    // the rect record itself keeps its exact shape, so a trail from before this
    // block existed still reads the same way
    expect(Object.keys(anchorRecord(file, plus, false, 0, PICK_VIA_PROBE))).toEqual([
      ...Object.keys(anchorFrame(file, plus, false, 0)),
      "via",
    ]);
  });

  it("each trigger marks its own label, and the record reads the mark rather than guessing", () => {
    expect([PICK_VIA_PLUS, PICK_VIA_PROBE]).toEqual(["plus", "probe"]);
    expect(shell).toMatch(/markPickVia\(PICK_VIA_PLUS\);[\s\S]{0,120}pickerTapOpen\(\);/);
    expect(block).toMatch(/markPickVia\(PICK_VIA_PROBE\);\n\s*pickerTapOpen\(\);/);
    expect(shell).toMatch(/anchorRecord\([\s\S]{0,300}pickVia,\n\s*\),/);
  });

  it("the ＋ is untouched: same shield, same teardown guard, same virgin input on a fresh present", () => {
    expect(shell).toMatch(/if \(picker\.isTearing\(\)\) return;/);
    expect(shell).toMatch(/if \(fresh\) swapFileInput\(\);/);
    expect(shell).toMatch(
      /function swapFileInput\(\): void \{[\s\S]{0,600}parent\.replaceChild\(next, old\);[\s\S]{0,200}bindInputSignals\(next\);/,
    );
    // and the capture-phase hold still recognises the ＋ by identity alone
    expect(shell).toMatch(/holdsBarTap\(picker\.isTearing\(\), isEditable\(e\.target\), e\.target === plusEl\)/);
  });

  it("the probe sits at the top of the screen, the end of it the ＋ is not at", () => {
    expect(probeRule).toContain("position: fixed");
    expect(probeRule).toMatch(/top: calc\(env\(safe-area-inset-top\)/);
    expect(probeRule).toMatch(/left: \d+px/);
    expect(probeRule).not.toMatch(/bottom:/);
    // what it is being told apart from: the ＋ and the invisible input parked on
    // it are both pinned to the bottom of the screen
    expect(css).toMatch(/\.filepick \{[^}]*bottom: calc\(var\(--pad-b\)/);
  });

  it("it is a thumb-sized target, and it animates nothing the shell's glide owns", () => {
    const size = (prop: string): number =>
      Number(new RegExp(`${prop}: (\\d+)px`).exec(probeRule)?.[1] ?? 0);
    expect(size("width")).toBeGreaterThanOrEqual(44); // the platform's own minimum target
    expect(size("height")).toBeGreaterThanOrEqual(44);
    expect(probeRule).not.toContain("transition");
    expect(probeRule).not.toContain("var(--pad-b)");
  });

  it("it is mounted once per page and lives outside the markup a render rewrites", () => {
    expect(block).toMatch(/if \(document\.getElementById\(PICK_PROBE_ID\)\) return;/);
    expect(block).toMatch(/document\.body\.appendChild\(el\);/);
    expect(blockCode).not.toMatch(/appEl|innerHTML|classList|scrollTo\(/);
  });

  it("removable as one block: every name is defined inside it, and the note lists the rest", () => {
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    for (const name of [
      "PICK_PROBE_ID",
      "PICK_VIA_PLUS",
      "PICK_VIA_PROBE",
      "pickVia",
      "markPickVia",
      "anchorRecord",
      "mountPickProbe",
    ]) {
      expect([name, block.includes(name)]).toEqual([name, true]);
    }
    // what is left outside the block is exactly the call sites, and no more
    const sites = outside
      .split("\n")
      .filter((l) => /mountPickProbe|markPickVia|anchorRecord|pickVia|PICK_PROBE_ID|PICK_VIA_/.test(l))
      .map((l) => l.trim());
    expect(sites).toEqual([
      "markPickVia(PICK_VIA_PLUS); // TEMP DIAGNOSTIC (pick-probe, block at the bottom)",
      "mountPickProbe();",
      "// anchorRecord is anchorFrame plus the trigger's name (pick-probe block)",
      "anchorRecord(",
      "pickVia,",
    ]);
    // and the note names each one, so deleting it is reading rather than hunting
    const note = /TO REMOVE, every call site:[\s\S]*?compiles as it did before\./.exec(block)?.[0] ?? "";
    for (const named of [
      "markPickVia(PICK_VIA_PLUS)",
      "mountPickProbe()",
      "anchorFrame",
      "styles.css",
      "shelldiag.test.ts",
    ]) {
      expect([named, note.includes(named)]).toEqual([named, true]);
    }
  });

  it("the stylesheet's half is one delimited block too, and names the class nowhere else", () => {
    const cssFrom = css.indexOf("/* ===================== TEMP DIAGNOSTIC (remove after the pick-probe session)");
    const cssEnd = "/* =================== END TEMP DIAGNOSTIC (remove after the pick-probe session) =================== */";
    const cssTo = css.indexOf(cssEnd);
    expect(cssFrom).toBeGreaterThan(-1);
    expect(cssTo).toBeGreaterThan(cssFrom);
    const cssBlock = css.slice(cssFrom, cssTo + cssEnd.length);
    expect(cssBlock).toContain(".pickprobe {");
    expect(css.split(".pickprobe").length).toBe(cssBlock.split(".pickprobe").length);
  });
});
