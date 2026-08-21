// Pins for the TEMP keyboard/picker diagnostic (src/shell.ts, bottom block):
// the three recorders that answer the close jitter, the misplaced picker panel
// and the second-compose-bar screenshot. What matters about a probe is that it
// carries the fields the session will be read from, that its frame loop is
// bounded, and above all that it never writes anything — a probe that disturbs
// the glide it is measuring measures its own weather. So the record builders
// are pure and tested directly, and the wiring (where each read sits relative
// to the writes around it) is pinned by source read, the same split
// flight.test.ts and photobox.test.ts use for code that boots a real shell.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CENSUS_SELECTORS,
  FALL_FRAMES,
  anchorFrame,
  domCensus,
  fallFrame,
  pumpFrames,
} from "../src/shell";
import type { FallReader } from "../src/shell";

// a close frame's five geometry reads, as plain numbers
function reader(over: Partial<Record<keyof FallReader, unknown>> = {}): FallReader {
  const base = { padB: 34, shellH: 844, pillBot: 800.5, thBot: 760, st: 1200 };
  const ft = "ft" in over ? (over.ft as boolean | undefined) : true;
  return {
    padB: () => (over.padB as number) ?? base.padB,
    shellH: () => (over.shellH as number) ?? base.shellH,
    pillBot: () => (over.pillBot as number) ?? base.pillBot,
    thBot: () => (over.thBot as number) ?? base.thBot,
    st: () => (over.st as number) ?? base.st,
    ft: () => ft,
  };
}

describe("kb-fall — one record per frame of the close", () => {
  it("carries every field the close is read from, and nothing else", () => {
    expect(fallFrame(16.7, reader())).toEqual({
      ms: 17, padB: 34, shellH: 844, pillBot: 800.5, thBot: 760, st: 1200, ft: true,
    });
  });

  it("keeps a tenth of a pixel: the hop under test is sub-pixel at its edges", () => {
    const f = fallFrame(0, reader({ padB: 8, pillBot: 471.33, shellH: 508.06 }));
    expect(f.padB).toBe(8);
    expect(f.pillBot).toBe(471.3);
    expect(f.shellH).toBe(508.1);
  });

  it("a missing element reads null, never a number a reader could mistake for a coordinate", () => {
    const f = fallFrame(50, reader({ pillBot: NaN, thBot: NaN, padB: NaN }));
    expect(f.pillBot).toBeNull();
    expect(f.thBot).toBeNull();
    expect(f.padB).toBeNull();
    expect(f.ms).toBe(50);
  });

  it("ft is dropped rather than guessed when nothing registered a follow reader", () => {
    const f = fallFrame(0, reader({ ft: undefined }));
    expect("ft" in f).toBe(false);
  });

  it("the discriminator survives the record: the pill's bottom before vs after the close", () => {
    // the hypothesis, as the trail would carry it — --pad-b steps its full
    // safe-area value in one frame while the shell is still gliding
    const before = fallFrame(0, reader({ padB: 8, pillBot: 800 }));
    const after = fallFrame(16, reader({ padB: 34, pillBot: 774 }));
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
    const { seen, queue } = pump(FALL_FRAMES);
    expect(seen).toEqual([...Array(FALL_FRAMES).keys()]);
    expect(queue.length).toBe(0);
  });

  it("about 18 frames is the budget: roughly 0.3s at 60fps, past the 0.2s glide", () => {
    expect(FALL_FRAMES).toBe(18);
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
// The pre-close sample must land before the class toggle that collapses
// --pad-b (after it, the before/after comparison is already gone), the anchor
// read must land after the click that presented (before it, the read's own
// layout flush could straighten the very rect the panel was mis-anchored to),
// and the per-frame body must write nothing whatsoever.
describe("wiring: read-only, and each read on the right side of the writes", () => {
  const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
  const hold = readFileSync(new URL("../src/hold.ts", import.meta.url), "utf8");
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

  it("the pre-close frame is sampled before .kb comes off, not after", () => {
    expect(shell).toMatch(
      /if \(!t\.kb && appliedKb\) fallEdge\(\);[\s\S]{0,900}appEl\.classList\.toggle\("kb", t\.kb\);/,
    );
    // and it is the frame the rest are measured against: ms 0, clock started here
    expect(shell).toMatch(/fallT0 = performance\.now\(\);[\s\S]{0,200}fallSample\(0\);/);
  });

  it("--pad-b is read as a used length, since a custom property computes to its own tokens", () => {
    expect(shell).toMatch(/fallStyle = compose \? getComputedStyle\(compose\) : null;/);
    expect(shell).toMatch(/parseFloat\(fallStyle\.paddingBottom\)/);
  });

  it("the loop starts right after the close-time correction pass", () => {
    expect(shell).toMatch(/correctionPass\("close"\);\n\s*startFallProbe\(\);/);
  });

  it("the per-frame body only reads — no class, style, scroll or node write anywhere in it", () => {
    const body = shell.match(/function fallSample\(ms: number\): void \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(body).toContain('holdDiagRecord("kb-fall"');
    expect(body).not.toMatch(/classList|setProperty|scrollTo\(|scrollTop =|\.style\.|appendChild/);
    // the lookups happen once at the edge, so the loop adds no query per frame
    expect(body).not.toMatch(/querySelector|getElementById|getComputedStyle/);
  });

  it("a second close inside the window owns the frames, so two runs cannot interleave", () => {
    expect(shell).toMatch(/if \(run !== fallRun\) return;/);
  });

  it("kb-fall stays out of the post-now list; pick-anchor, which fires once, is in it", () => {
    expect(hold).toMatch(/ev === "pick-anchor"/);
    expect(hold).not.toMatch(/ev === "kb-fall"/);
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
