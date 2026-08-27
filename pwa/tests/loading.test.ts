// Pins for the app's own loading page: the scene index.html draws, the rule
// that decides when it comes down, and the watch that decides when the app
// underneath has stopped moving.
//
// The page is markup and styles in index.html, so that file is what has to be
// read to check it. There is no DOM in this env, but more to the point the
// whole claim is about what the SERVED document says before a line of the
// bundle has run, and the file is exactly that. The scene is geometry, so the
// checks on it are arithmetic: the orbit's keyframes are recomputed from the
// ring's own declarations and compared stop by stop, which is what stops the
// dot and the line it is supposed to be riding drifting apart.
//
// The lift rule and the quiet watch are pure, so they run on fake timers and a
// hand-pumped frame clock, and the cases that have to watch the script take the
// page over drive it against a recording element stand-in.
//
// The phone's own launch image, which is what hands over TO this page, is a
// different picture with a different job and lives in tests/splash.test.ts.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOAD_CAP_MS,
  LOAD_FADE_MS,
  LOAD_MIN_HOLD_MS,
  type LiftReason,
  QUIET_FRAMES,
  QUIET_SLACK_PX,
  type QuietFrame,
  SPLASH_BG,
  createLoadingGate,
  createQuietWatch,
  watchQuiet,
} from "../src/splash";

const INDEX_HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");

// the page's own markup, from its opening tag to where the app's root begins
const MARKUP = INDEX_HTML.slice(
  INDEX_HTML.indexOf('<div id="loading">'),
  INDEX_HTML.indexOf('<div id="app">'),
);

// the document's one inline <style>, with its comments taken out: everything
// below reads the declarations, and a comment can say anything at all
const STYLE_SRC = (/<style>([\s\S]*?)<\/style>/.exec(INDEX_HTML)?.[1] ?? "").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

// --- reading that stylesheet ---------------------------------------------------
//
// A stylesheet is not a flat list of rules: an at-rule carries a block of its
// own, and a regular expression that stops at the first closing brace reads one
// of those as garbage. So the sheet is split by COUNTING braces, which is the
// whole of what the parsing below needs to be right about, and the pieces are
// then sorted into plain rules, at-rule bodies and keyframe stops.

interface Block {
  head: string; // whatever stood before the brace
  body: string; // whatever stood inside it
}

function blocks(css: string): Block[] {
  const out: Block[] = [];
  let head = "";
  let body = "";
  let depth = 0;
  for (const ch of css) {
    if (ch === "{") {
      depth += 1;
      if (depth === 1) continue; // the block's own opening brace is not content
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        out.push({ head: head.trim().replace(/\s+/g, " "), body });
        head = "";
        body = "";
        continue;
      }
    }
    if (depth === 0) head += ch;
    else body += ch;
  }
  return out;
}

// one block's declarations as a property -> value map. No value in this sheet
// carries a semicolon, so splitting on one is the whole of it.
function decls(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of body.split(";")) {
    const at = d.indexOf(":");
    if (at > 0) out[d.slice(0, at).trim()] = d.slice(at + 1).trim().replace(/\s+/g, " ");
  }
  return out;
}

interface Rule {
  sel: string[]; // the selectors this block was written against
  decls: Record<string, string>;
  media: string; // "" for a rule at the top level of the sheet
  order: number; // where it sits in the sheet, which is what settles a tie
}

const RULES: Rule[] = [];
const FRAMES: Record<string, Array<[string, Record<string, string>]>> = {};

{
  let order = 0;
  const push = (head: string, body: string, media: string): void => {
    RULES.push({
      sel: head.split(",").map((s) => s.trim().replace(/\s+/g, " ")),
      decls: decls(body),
      media,
      order: order++,
    });
  };
  for (const b of blocks(STYLE_SRC)) {
    if (b.head.startsWith("@keyframes")) {
      FRAMES[b.head.slice("@keyframes".length).trim()] = blocks(b.body).map((s) => [
        s.head,
        decls(s.body),
      ]);
    } else if (b.head.startsWith("@media")) {
      const media = b.head.slice("@media".length).trim();
      for (const inner of blocks(b.body)) push(inner.head, inner.body, media);
    } else {
      push(b.head, b.body, "");
    }
  }
}

// every declaration in force for one selector, in sheet order, which for a
// selector written more than once is the later rule winning. Only rules written
// against this exact selector count, so nothing here has to reason about which
// of two different selectors an element matches.
function styleOf(selector: string, media = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of RULES) {
    if (r.media === media && r.sel.includes(selector)) Object.assign(out, r.decls);
  }
  return out;
}

// where the last rule written against a selector sits in the sheet
function orderOf(selector: string, media = ""): number {
  const hit = RULES.filter((r) => r.media === media && r.sel.includes(selector));
  if (!hit.length) throw new Error(`no rule for ${selector}`);
  return hit[hit.length - 1].order;
}

// a selector's weight, as ids and classes. Nothing in this sheet uses an
// element name or anything heavier, so those two counts settle every contest.
function weight(selector: string): [number, number] {
  return [
    (selector.match(/#/g) ?? []).length,
    (selector.match(/\./g) ?? []).length,
  ];
}

// the number out of a vmin length
function vmin(value: string): number {
  const m = /(-?[\d.]+)vmin/.exec(value);
  if (!m) throw new Error(`no vmin in: ${value}`);
  return Number(m[1]);
}

// a hair, for comparing two float routes to the same number
function near(a: number, b: number, slack = 1e-6): boolean {
  return Math.abs(a - b) < slack;
}

// --- the ring, and the ellipse the dot has to ride ------------------------------
//
// Every number below is READ off the shipped stylesheet rather than restated
// here, so the orbit is compared against the ring the page actually draws. The
// dot rides the ring's centre line, not its outer edge: the box is a border-box
// and the stroke is drawn inside it, so the line itself is half a stroke in on
// each side.
const RING = styleOf("#loading .ring");
const RING_RX = vmin(RING.width) / 2;
const RING_RY = vmin(RING.height) / 2;
const RING_STROKE = vmin(RING.border);
const RING_TILT = Number(/rotate\((-?[\d.]+)deg\)/.exec(RING.transform)?.[1]);
const ORBIT_RX = RING_RX - RING_STROKE / 2;
const ORBIT_RY = RING_RY - RING_STROKE / 2;

// A point on that ellipse, at the parameter one stop of the animation stands
// for. The parameter starts at half a turn, which puts the first stop on one
// end of the ring's long axis: that is where the far side of the ring meets the
// near side, so the animation's first half is one arc and its second half is
// the other.
function orbitPoint(p: number): [number, number] {
  const t = Math.PI + 2 * Math.PI * p;
  const f = (RING_TILT * Math.PI) / 180;
  return [
    ORBIT_RX * Math.cos(t) * Math.cos(f) - ORBIT_RY * Math.sin(t) * Math.sin(f),
    ORBIT_RX * Math.cos(t) * Math.sin(f) + ORBIT_RY * Math.sin(t) * Math.cos(f),
  ];
}

// the same point taken back out of the tilt, whose sign says which side of the
// ring's long axis it is on: negative is the arc that passes behind the planet
function ringSide(x: number, y: number): number {
  const f = (-RING_TILT * Math.PI) / 180;
  return x * Math.sin(f) + y * Math.cos(f);
}

// one stop's translate, as a pair of vmin numbers
function stopXY(value: string): [number, number] {
  const m = /^translate\((-?[\d.]+)vmin, (-?[\d.]+)vmin\)$/.exec(value);
  if (!m) throw new Error(`not a plain translate: ${value}`);
  return [Number(m[1]), Number(m[2])];
}

// one animation shorthand, split into its comma-separated parts
function anims(value: string): Array<{ name: string; ms: number; ease: string; count: string }> {
  return value.split(",").map((part) => {
    const [name, dur, ease, count] = part.trim().split(" ");
    return { name, ms: Number(dur.replace("ms", "")), ease, count };
  });
}

describe("the loading page lives in the document, not in the bundle", () => {
  it("is in the served page, and the only script the page has is a fetched module", () => {
    // The whole point of it being here: the element is parsed and paintable
    // before a line of the bundle runs. A module script is DEFERRED by
    // definition, so it cannot execute until the document has been parsed.
    //
    // There is exactly one script tag now. The page used to carry a second one,
    // inline in the head, which recomputed the old cover's geometry off the
    // screen because that cover had to land on the very pixels the phone's
    // stored picture used. This scene is its own picture, every length in it is
    // a fraction of the viewport's shorter edge, and nothing has to be
    // corrected, so there is no code at all in front of the first paint.
    expect(INDEX_HTML).toContain('<div id="loading">');
    const scripts = [...INDEX_HTML.matchAll(/<script([^>]*)>/g)].map((m) => m[1]);
    expect(scripts.length).toBe(1);
    expect(scripts[0]).toContain("src=");
    expect(scripts[0]).toContain('type="module"');
  });

  it("carries everything it shows, with nothing left to go and get", () => {
    // no request, no service-worker lookup, no second file and no decode
    // between the document arriving and the picture being on screen
    expect([...MARKUP.matchAll(/(?:src|href)="[^"]*"/g)].map((m) => m[0])).toEqual([]);
    expect(MARKUP).not.toContain("<img");
    expect(MARKUP).not.toContain("data:");
    expect(STYLE_SRC).not.toContain("url(");
  });

  it("says nothing: the page it replaced was a logo and a name, this is neither", () => {
    const text = MARKUP.replace(/<[^>]*>/g, "").replace(/\s+/g, "");
    expect(text).toBe("");
  });

  it("is five empty boxes, in the order they are painted in", () => {
    const parts = [...MARKUP.matchAll(/<div class="([^"]*)"><\/div>/g)].map((m) => m[1]);
    expect(parts).toEqual(["ring back", "moon far", "planet", "ring front", "moon near"]);
  });

  it("gets its styles from the document too, in the head, before the markup", () => {
    expect(INDEX_HTML.indexOf("<style>")).toBeLessThan(INDEX_HTML.indexOf("</head>"));
    expect(INDEX_HTML.indexOf("</style>")).toBeLessThan(INDEX_HTML.indexOf('<div id="loading">'));
    for (const sel of ["#loading", "#loading .scene", "#loading .planet", "#loading .ring", "#loading .moon"]) {
      expect([sel, RULES.some((r) => r.sel.includes(sel))]).toEqual([sel, true]);
    }
  });

  it("stands on the launch image's own white, and fades the way splash.ts says", () => {
    // the one thing this page keeps from the picture the phone hands over: the
    // colour. That is what makes the handover a change of drawing rather than a
    // flash of a different white.
    const panel = styleOf("#loading");
    expect(panel.background).toBe(SPLASH_BG);
    expect(panel.transition).toBe(`opacity ${LOAD_FADE_MS}ms ease`);
    expect(panel.position).toBe("fixed");
    expect(panel.inset).toBe("0");
  });

  it("hides itself in a browser tab, where there was no launch image to hold", () => {
    // the rule that acts before any code runs; splash.ts removes the element
    // outright in the same case, which is what catches a browser that does not
    // know the query at all
    expect(styleOf("#loading", "(display-mode: browser)").display).toBe("none");
  });

  it("measures nothing against the viewport's height, which iOS reports short", () => {
    // The layout viewport comes up short on the first standalone frame and
    // grows into its real height a moment later. The shorter edge of a phone is
    // its width, so a scene written in vmin is the same size before and after
    // that, and the only thing the growth can move is where the middle is.
    expect(STYLE_SRC).not.toMatch(/[\d.]+(vh|vw|vmax|svh|lvh|dvh)\b/);
    expect((STYLE_SRC.match(/vmin/g) ?? []).length).toBeGreaterThan(10);
  });

  it("comes up rather than being there, which is what the growth hides under", () => {
    const scene = styleOf("#loading .scene");
    const rise = anims(scene.animation);
    expect(rise.length).toBe(1);
    expect(rise[0].name).toBe("ld-appear");
    expect(FRAMES["ld-appear"]).toEqual([
      ["from", { opacity: "0" }],
      ["to", { opacity: "1" }],
    ]);
    // and it is over well before the page's own minimum hold is, so the planet
    // is never still arriving when the page is already allowed to leave
    const delay = Number(/(\d+)ms both/.exec(scene.animation)?.[1] ?? 0);
    expect(rise[0].ms + delay).toBeLessThan(LOAD_MIN_HOLD_MS);
  });
});

describe("the scene: a planet with a ring round it", () => {
  it("is a disc the ring reaches past on both sides", () => {
    const planet = styleOf("#loading .planet");
    const r = vmin(planet.width) / 2;
    expect(vmin(planet.height) / 2).toBe(r); // a circle, not an oval
    expect(planet["border-radius"]).toBe("50%");
    expect(RING_RX).toBeGreaterThan(r); // the ring sticks out past the disc
  });

  it("is a ring flat enough that both of its arcs cross the disc", () => {
    // this is the whole look. A ring taller than the planet would clear it
    // top and bottom and read as a halo; one flatter than it passes behind on
    // the far side and in front on the near side, which is the shape everyone
    // knows.
    const r = vmin(styleOf("#loading .planet").width) / 2;
    expect(RING_RY).toBeLessThan(r);
    expect(RING_RY).toBeLessThan(RING_RX); // and it is an ellipse, not a circle
    expect(RING_TILT).not.toBe(0); // seen at a tilt, or it is a line
  });

  it("draws that one ellipse twice, at the same size and the same tilt", () => {
    // both copies come off the same rule, and the front one adds only where it
    // sits and how much of it shows, so the two cannot come apart
    expect(RING["border-radius"]).toBe("50%");
    expect(RING.transform).toContain("rotate(");
    const front = RULES.filter((r) => r.sel.includes("#loading .front"));
    const said = new Set(front.flatMap((r) => Object.keys(r.decls)));
    expect([...said].sort()).toEqual(["clip-path", "z-index"]);
    expect(MARKUP).toContain('class="ring back"');
    expect(MARKUP).toContain('class="ring front"');
  });

  it("centres every part on the panel, off the same pair of numbers", () => {
    for (const sel of ["#loading .planet", "#loading .ring", "#loading .moon"]) {
      const s = styleOf(sel);
      expect([sel, s.position, s.left, s.top]).toEqual([sel, "absolute", "50%", "50%"]);
      // and pulled back by half its own size, so one length says both where a
      // thing is and how big it is
      const m = s.margin.split(" ");
      expect([sel, near(vmin(m[0]), -vmin(s.height) / 2), near(vmin(m[3]), -vmin(s.width) / 2)])
        .toEqual([sel, true, true]);
    }
  });
});

describe("the far arc passes behind the planet and the near arc in front", () => {
  it("paints the five parts in depth order", () => {
    const layers: Array<[string, string]> = [
      ["the ring's far side", "#loading .ring"],
      ["the moon while it is out there", "#loading .moon"],
      ["the planet", "#loading .planet"],
      ["the ring's near side", "#loading .front"],
      ["the moon while it is in front", "#loading .near"],
    ];
    const zs = layers.map(([, sel]) => Number(styleOf(sel)["z-index"]));
    expect(zs).toEqual([1, 2, 3, 4, 5]);
    // and the markup puts them in that order too, so the depth would be right
    // even if every one of those numbers went away
    const parts = [...MARKUP.matchAll(/<div class="([^"]*)"><\/div>/g)].map((m) => m[1]);
    expect(parts.map((p) => p.split(" ")[1] ?? p)).toEqual([
      "back",
      "far",
      "planet",
      "front",
      "near",
    ]);
  });

  it("cuts the front copy of the ring to its near half and leaves the back whole", () => {
    // clip-path applies to the element and the transform applies to the result,
    // so "the lower half" is the lower half of the UNTILTED ellipse, which is
    // exactly the half the tilt brings towards the viewer. The back copy is not
    // cut at all: the part of it that would show through the cut is the same
    // arc the front copy draws, so there is no seam for a gap to open in.
    expect(styleOf("#loading .front")["clip-path"]).toBe("inset(50% 0 0 0)");
    expect(styleOf("#loading .ring")["clip-path"]).toBeUndefined();
  });

  it("shows one copy of the moon per half, and swaps between them as a step", () => {
    // two dots cross-fading through each other would read as one dot dimming,
    // which is the one thing an orbit must not do
    expect(FRAMES["ld-far"]).toEqual([["0%", { opacity: "1" }], ["50%", { opacity: "0" }]]);
    expect(FRAMES["ld-near"]).toEqual([["0%", { opacity: "0" }], ["50%", { opacity: "1" }]]);
    for (const sel of ["#loading .far", "#loading .near"]) {
      const gate = anims(styleOf(sel).animation)[1];
      expect([sel, gate.ease]).toEqual([sel, "step-end"]);
    }
  });

  it("swaps them where the two are on the same pixel, so nothing shows", () => {
    // the handover happens at one end of the ring's long axis, which both
    // copies reach at the same instant on the same path
    const stops = FRAMES["ld-orbit"];
    const at = (pct: string): [number, number] =>
      stopXY(stops.find(([head]) => head === pct)?.[1].transform ?? "");
    expect(at("0%")).toEqual(at("100%"));
    expect(near(Math.abs(ringSide(...at("0%"))), 0, 1e-3)).toBe(true);
    expect(near(Math.abs(ringSide(...at("50%"))), 0, 1e-3)).toBe(true);
  });

  it("gives the half that hides to the copy under the planet, and the other to the one over it", () => {
    // THE STACKING CLAIM, end to end. The half of the path the far copy is
    // shown for is the half the front copy of the RING is cut away from, which
    // is the half that passes behind the disc.
    const stops = FRAMES["ld-orbit"];
    for (let i = 1; i < 18; i++) {
      const side = ringSide(...stopXY(stops[i][1].transform));
      expect([stops[i][0], side < 0]).toEqual([stops[i][0], true]); // behind
    }
    for (let i = 19; i < 36; i++) {
      const side = ringSide(...stopXY(stops[i][1].transform));
      expect([stops[i][0], side > 0]).toEqual([stops[i][0], true]); // in front
    }
    // the far copy owns the first half, and it is the one painted under the
    // planet; the near copy owns the second and is painted over it
    expect(anims(styleOf("#loading .far").animation)[1].name).toBe("ld-far");
    expect(anims(styleOf("#loading .near").animation)[1].name).toBe("ld-near");
    expect(Number(styleOf("#loading .moon")["z-index"])).toBeLessThan(
      Number(styleOf("#loading .planet")["z-index"]),
    );
    expect(Number(styleOf("#loading .near")["z-index"])).toBeGreaterThan(
      Number(styleOf("#loading .front")["z-index"]),
    );
  });
});

describe("the orbit traces the ring's own ellipse", () => {
  const stops = FRAMES["ld-orbit"];

  it("is sampled evenly, all the way round and back to where it started", () => {
    expect(stops.length).toBe(37);
    stops.forEach(([head], i) => {
      expect([i, near(Number(head.replace("%", "")), (i / 36) * 100, 0.01)]).toEqual([i, true]);
    });
    expect(stops[0][1].transform).toBe(stops[36][1].transform);
  });

  it("puts every stop on the ring's centre line, on the ring's own tilt", () => {
    // the numbers in the sheet are recomputed here from the ring's declared
    // box, its stroke and its tilt, so the dot cannot drift off the line it is
    // meant to be riding without this failing
    stops.forEach(([head, d], i) => {
      const [x, y] = stopXY(d.transform);
      const [wx, wy] = orbitPoint(i / 36);
      expect([head, near(x, wx, 5e-4), near(y, wy, 5e-4)]).toEqual([head, true, true]);
    });
  });

  it("is sampled finely enough that the straight runs between stops read as a curve", () => {
    // a keyframed path is a polygon inscribed in the ellipse: what matters is
    // how far inside the true curve the chord between two stops falls
    let worst = 0;
    for (let i = 0; i < 36; i++) {
      const [ax, ay] = orbitPoint(i / 36);
      const [bx, by] = orbitPoint((i + 1) / 36);
      const [cx, cy] = orbitPoint((i + 0.5) / 36);
      worst = Math.max(worst, Math.hypot(cx - (ax + bx) / 2, cy - (ay + by) / 2));
    }
    expect(worst).toBeLessThan(0.1); // vmin, which is well under a device pixel
  });

  it("goes round once, calmly, and never stops", () => {
    for (const sel of ["#loading .far", "#loading .near"]) {
      const [orbit, gate] = anims(styleOf(sel).animation);
      expect([sel, orbit.name]).toEqual([sel, "ld-orbit"]);
      expect([sel, orbit.ease, orbit.count]).toEqual([sel, "linear", "infinite"]);
      expect([sel, gate.count]).toEqual([sel, "infinite"]);
      // the two tracks on one dot share a period, or the dot would be on the
      // wrong side of the planet for part of every turn
      expect([sel, orbit.ms]).toEqual([sel, gate.ms]);
      expect([sel, orbit.ms >= 2000 && orbit.ms <= 3000]).toEqual([sel, true]);
    }
    // and both copies share it with each other, which is what puts them on the
    // same pixel at the instant they swap
    expect(anims(styleOf("#loading .far").animation)[0].ms).toBe(
      anims(styleOf("#loading .near").animation)[0].ms,
    );
  });

  it("animates nothing but transform and opacity, so no frame needs the layout", () => {
    // the main thread is at its busiest during a boot, which is the whole
    // reason the scene is drawn this way rather than by script
    const props = new Set<string>();
    for (const stops of Object.values(FRAMES)) {
      for (const [, d] of stops) for (const p of Object.keys(d)) props.add(p);
    }
    expect([...props].sort()).toEqual(["opacity", "transform"]);
    // and the moving parts are marked as such, so they get their own layer
    expect(styleOf("#loading .moon")["will-change"]).toBe("transform");
  });
});

describe("asked for no motion, the scene stands still", () => {
  it("turns the orbit off for both copies of the moon with one line", () => {
    const reduce = "(prefers-reduced-motion: reduce)";
    expect(styleOf("#loading .moon", reduce).animation).toBe("none");
    // and that one line reaches both, because all three rules weigh the same
    // and it is written last. A rule aimed at a class on top of a class would
    // weigh more and quietly keep running.
    expect(weight("#loading .far")).toEqual(weight("#loading .moon"));
    expect(weight("#loading .near")).toEqual(weight("#loading .moon"));
    expect(orderOf("#loading .moon", reduce)).toBeGreaterThan(orderOf("#loading .far"));
    expect(orderOf("#loading .moon", reduce)).toBeGreaterThan(orderOf("#loading .near"));
  });

  it("leaves one dot showing, resting on the ring where the orbit would put it", () => {
    // with no animation the dot falls back to what the sheet says outright, so
    // the still picture has to be a finished one: one moon, on the line, in
    // front of the planet
    const moon = styleOf("#loading .moon");
    expect(moon.opacity).toBe("0"); // the copy behind the planet stays hidden
    expect(styleOf("#loading .near").opacity).toBe("1");
    const parked = stopXY(moon.transform);
    const stops = FRAMES["ld-orbit"];
    expect(moon.transform).toBe(stops.find(([head]) => head === "75%")?.[1].transform);
    expect(ringSide(...parked)).toBeGreaterThan(0); // the near arc, not the far one
  });

  it("still fades, because a change of opacity is not movement", () => {
    // the alternative is the page appearing and vanishing as cuts, which is
    // harsher than the thing reduced motion is asked for to avoid
    const reduce = "(prefers-reduced-motion: reduce)";
    expect(styleOf("#loading", reduce).transition).toBeUndefined();
    expect(styleOf("#loading .scene", reduce).animation).toBeUndefined();
  });
});

describe("createLoadingGate: when the page lifts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function harness() {
    const lifts: LiftReason[] = [];
    const gate = createLoadingGate((why) => lifts.push(why));
    return { lifts, gate };
  }

  it("the hold is a second and the cap two", () => {
    expect(LOAD_MIN_HOLD_MS).toBe(1000);
    expect(LOAD_CAP_MS).toBe(2000);
    expect(LOAD_CAP_MS).toBeGreaterThan(LOAD_MIN_HOLD_MS);
  });

  it("stays up through the whole minimum hold, however early the app settles", () => {
    const { lifts, gate } = harness();
    gate.settled(); // cached thread, images and all, before the first frame
    vi.advanceTimersByTime(LOAD_MIN_HOLD_MS - 1);
    expect(gate.lifted()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(gate.lifted()).toBe(true);
    expect(lifts).toEqual(["settled"]);
  });

  it("waits for the settle when the hold passes first, then lifts on it", () => {
    const { lifts, gate } = harness();
    vi.advanceTimersByTime(LOAD_MIN_HOLD_MS);
    expect(gate.lifted()).toBe(false);
    gate.settled();
    expect(gate.lifted()).toBe(true);
    expect(lifts).toEqual(["settled"]);
  });

  it("lifts at the cap when nothing ever settles", () => {
    const { lifts, gate } = harness();
    vi.advanceTimersByTime(LOAD_CAP_MS - 1);
    expect(gate.lifted()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(gate.lifted()).toBe(true);
    expect(lifts).toEqual(["cap"]);
  });

  it("lifts once: a settle arriving after the cap changes nothing", () => {
    const { lifts, gate } = harness();
    vi.advanceTimersByTime(LOAD_CAP_MS);
    gate.settled();
    vi.advanceTimersByTime(LOAD_CAP_MS);
    expect(lifts).toEqual(["cap"]);
  });

  it("a settle before the cap wins the reason, and the cap adds nothing after", () => {
    const { lifts, gate } = harness();
    vi.advanceTimersByTime(LOAD_MIN_HOLD_MS);
    gate.settled();
    vi.advanceTimersByTime(LOAD_CAP_MS * 4);
    expect(lifts).toEqual(["settled"]);
  });

  it("the windows are injectable, so the rule is not tied to its own constants", () => {
    const lifts: LiftReason[] = [];
    const gate = createLoadingGate((why) => lifts.push(why), 40, 90);
    gate.settled();
    vi.advanceTimersByTime(39);
    expect(gate.lifted()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(lifts).toEqual(["settled"]);
  });
});

describe("createQuietWatch: what counts as the app having stopped moving", () => {
  const still: QuietFrame = { sh: 4000, st: 3200, ch: 800, vh: 844 };

  it("needs a run of frames that read the same, not just one", () => {
    const w = createQuietWatch();
    expect(QUIET_FRAMES).toBeGreaterThan(1);
    // the first frame has nothing to be compared with, so the run can only
    // start on the second
    for (let i = 0; i <= QUIET_FRAMES; i++) {
      expect([i, w.frame(still)]).toEqual([i, i === QUIET_FRAMES]);
    }
    expect(w.seen()).toBe(QUIET_FRAMES + 1);
  });

  it("starts the run over when the thread is still growing", () => {
    // the late-growth case, which is what the whole gate is for: a thread that
    // gains height after the cached paint, pinned to the bottom every frame,
    // reads as at-rest on every single frame and is still moving
    const w = createQuietWatch();
    let sh = 4000;
    for (let i = 0; i < 20; i++) {
      sh += 40;
      expect([i, w.frame({ sh, st: sh - 800, ch: 800, vh: 844 })]).toEqual([i, false]);
    }
    // it goes quiet only once the growth does
    const rest = { sh, st: sh - 800, ch: 800, vh: 844 };
    for (let i = 0; i < QUIET_FRAMES - 1; i++) expect(w.frame(rest)).toBe(false);
    expect(w.frame(rest)).toBe(true);
  });

  it("starts it over when the viewport is still growing into its real height", () => {
    const w = createQuietWatch();
    for (let i = 0; i < 8; i++) {
      expect([i, w.frame({ ...still, vh: 762 + i * 6 })]).toEqual([i, false]);
    }
  });

  it("starts it over when the scroll is still being moved", () => {
    const w = createQuietWatch();
    for (let i = 0; i < 8; i++) {
      // a glide towards the bottom: at rest on no frame, and never the same twice
      expect([i, w.frame({ sh: 4000, st: 3000 + i * 25, ch: 800, vh: 844 })]).toEqual([i, false]);
    }
  });

  it("never counts a thread parked away from where it comes to rest", () => {
    // dead still, but not at the bottom: this is the boot that never reports
    // quiet at all, and the cap is what takes the page down over it
    const w = createQuietWatch();
    const parked: QuietFrame = { sh: 4000, st: 2000, ch: 800, vh: 844 };
    for (let i = 0; i < 30; i++) expect([i, w.frame(parked)]).toEqual([i, false]);
  });

  it("counts a thread shorter than its own box, which is at the bottom already", () => {
    const w = createQuietWatch();
    const shortThread: QuietFrame = { sh: 300, st: 0, ch: 800, vh: 844 };
    for (let i = 0; i < QUIET_FRAMES; i++) w.frame(shortThread);
    expect(w.frame(shortThread)).toBe(true);
  });

  it("forgives the slack a fractional layout leaves at the bottom, and no more", () => {
    const inside = createQuietWatch();
    const at: QuietFrame = { sh: 4000, st: 3200 - QUIET_SLACK_PX, ch: 800, vh: 844 };
    for (let i = 0; i < QUIET_FRAMES; i++) inside.frame(at);
    expect(inside.frame(at)).toBe(true);
    const outside = createQuietWatch();
    const past: QuietFrame = { sh: 4000, st: 3200 - QUIET_SLACK_PX - 0.5, ch: 800, vh: 844 };
    for (let i = 0; i < QUIET_FRAMES + 4; i++) expect(outside.frame(past)).toBe(false);
  });

  it("takes the run length as a parameter, so the rule is not tied to its constant", () => {
    const w = createQuietWatch(1);
    expect(w.frame(still)).toBe(false);
    expect(w.frame(still)).toBe(true);
  });
});

describe("watchQuiet: the frame loop, which reads and never writes", () => {
  let queued: FrameRequestCallback[] = [];

  // one frame of the fake clock: whatever was asked for before this call runs,
  // and whatever those ask for lands in the next frame
  function pump(n = 1): void {
    for (let i = 0; i < n; i++) {
      const batch = queued;
      queued = [];
      for (const cb of batch) cb(0);
    }
  }

  // a thread that answers reads off a live closure and REMEMBERS any write,
  // which is the whole of what the reveal is not allowed to do
  function recordingThread(read: () => [number, number, number]) {
    const writes: string[] = [];
    const el = {
      get scrollHeight() {
        return read()[0];
      },
      set scrollHeight(_v: number) {
        writes.push("scrollHeight");
      },
      get scrollTop() {
        return read()[1];
      },
      set scrollTop(_v: number) {
        writes.push("scrollTop");
      },
      get clientHeight() {
        return read()[2];
      },
      set clientHeight(_v: number) {
        writes.push("clientHeight");
      },
    };
    return { el, writes };
  }

  beforeEach(() => {
    queued = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => queued.push(cb));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("answers once the readings hold still, and says how many frames it took", () => {
    const { el, writes } = recordingThread(() => [4000, 3200, 800]);
    let frames = -1;
    watchQuiet(el, () => 844, () => false, (n) => {
      frames = n;
    });
    pump(QUIET_FRAMES);
    expect(frames).toBe(-1);
    pump(1);
    expect(frames).toBe(QUIET_FRAMES + 1);
    expect(writes).toEqual([]);
  });

  it("holds on through late growth, and lets go the moment it stops", () => {
    // the thread gains a screen of height over twenty frames, pinned to the
    // bottom the whole way, which is the shape of the boot this gate exists for
    let sh = 4000;
    let growing = true;
    const { el, writes } = recordingThread(() => [sh, sh - 800, 800]);
    let frames = -1;
    watchQuiet(el, () => 844, () => false, (n) => {
      frames = n;
    });
    for (let i = 0; i < 20; i++) {
      if (growing) sh += 40;
      pump(1);
      expect([i, frames]).toEqual([i, -1]);
    }
    growing = false;
    pump(QUIET_FRAMES);
    expect(frames).toBeGreaterThan(20);
    expect(writes).toEqual([]);
  });

  it("stops when the page has already gone, which is the cap's doing", () => {
    // nothing in this path has a clock of its own: the ceiling it answers to is
    // the loading page's own cap, and this is how the loop hears about it
    let lifted = false;
    let sh = 4000;
    const { el } = recordingThread(() => [sh, sh - 800, 800]);
    let frames = -1;
    watchQuiet(el, () => 844, () => lifted, (n) => {
      frames = n;
    });
    for (let i = 0; i < 5; i++) {
      sh += 40; // never settles on its own
      pump(1);
    }
    expect(frames).toBe(-1);
    lifted = true;
    pump(1);
    expect(frames).toBeGreaterThan(0);
    pump(5);
    expect(queued).toEqual([]); // and it asked for no further frames
  });

  it("watches the viewport as well as the thread", () => {
    let vh = 762;
    const { el } = recordingThread(() => [4000, 3200, 800]);
    let frames = -1;
    watchQuiet(el, () => vh, () => false, (n) => {
      frames = n;
    });
    for (let i = 0; i < 10; i++) {
      vh += 5; // the safe-area insets appearing, with the thread dead still
      pump(1);
      expect([i, frames]).toEqual([i, -1]);
    }
    pump(QUIET_FRAMES + 1);
    expect(frames).toBeGreaterThan(10);
  });

  it("answers straight away where there is no frame clock to watch on", () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    const { el } = recordingThread(() => [4000, 3200, 800]);
    let frames = -1;
    watchQuiet(el, () => 844, () => false, (n) => {
      frames = n;
    });
    expect(frames).toBe(0);
  });
});

describe("installLoadingScreen: it adopts the document's page, it never builds one", () => {
  interface FakeEl {
    id: string;
    style: Record<string, string>;
    gone: boolean;
    remove(): void;
  }

  function fakeEl(id = ""): FakeEl {
    const el: FakeEl = {
      id,
      style: {},
      gone: false,
      remove() {
        el.gone = true;
      },
    };
    return el;
  }

  // every Image the module constructs is a thing the page would have to wait
  // for; the adoption must construct none
  class RecordingImage {
    static made = 0;
    src = "";
    constructor() {
      RecordingImage.made += 1;
    }
  }

  let created: string[] = []; // every element the module asked the document to make
  let attached = 0; // every child the module added to the body

  async function adopt(standalone = true, withPage = true) {
    created = [];
    attached = 0;
    RecordingImage.made = 0;
    const el = fakeEl("loading");
    const byId: Record<string, FakeEl> = withPage ? { loading: el } : {};
    vi.stubGlobal("document", {
      body: { appendChild: () => (attached += 1) },
      getElementById: (id: string) => byId[id] ?? null,
      createElement(tag: string) {
        created.push(tag);
        return fakeEl(tag);
      },
    });
    vi.stubGlobal("navigator", { standalone, userAgent: "iPhone" });
    vi.stubGlobal("screen", { width: 390, height: 844 });
    vi.stubGlobal("window", { devicePixelRatio: 3 });
    vi.stubGlobal("Image", RecordingImage);
    vi.resetModules(); // the adoption runs once per module load, so reload it per case
    const mod = await import("../src/splash");
    return { page: mod.installLoadingScreen(), el };
  }

  beforeEach(() => {
    vi.useFakeTimers(); // the lift timers start with the adoption
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("takes the element the page already carries: no second one is made", async () => {
    const { el } = await adopt();
    expect(created).toEqual([]); // no div, no img, no canvas
    expect(attached).toBe(0); // and nothing added to the body
    expect(RecordingImage.made).toBe(0); // and nothing left to decode
    expect(el.gone).toBe(false); // the one it was handed is still in the page
  });

  it("measures nothing: the page states its own geometry and needs no help", async () => {
    // the old cover had its rect rewritten from here, because it had to land on
    // the pixels the phone's stored picture used. This scene is its own
    // picture, so the adoption writes nothing at all until the lift.
    const { el } = await adopt();
    expect(Object.keys(el.style)).toEqual([]);
  });

  it("lifts on the cap, and touches only what the fade needs", async () => {
    const { page, el } = await adopt();
    expect(page.lifted()).toBe(false);
    vi.advanceTimersByTime(LOAD_CAP_MS);
    expect(page.lifted()).toBe(true);
    expect(el.style.opacity).toBe("0"); // the transition index.html states
    expect(el.style.pointerEvents).toBe("none"); // the fade must not eat the first tap
    // and nothing else, which is this side of "the reveal moves nothing"
    expect(Object.keys(el.style).sort()).toEqual(["opacity", "pointerEvents"]);
    expect(el.gone).toBe(false); // still fading
    vi.advanceTimersByTime(LOAD_FADE_MS);
    expect(el.gone).toBe(true);
  });

  it("lifts on the settle, once the minimum hold has passed", async () => {
    const { page, el } = await adopt();
    page.settled();
    vi.advanceTimersByTime(LOAD_MIN_HOLD_MS - 1);
    expect(page.lifted()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(page.lifted()).toBe(true);
    expect(el.style.opacity).toBe("0");
  });

  it("takes the page out of the document in a browser tab, and holds nothing", async () => {
    const { page, el } = await adopt(false);
    expect(el.gone).toBe(true); // a fixed full-screen panel does not get to linger
    expect(page.lifted()).toBe(true); // the no-op page: nothing to wait on
  });

  it("does not fall back to building one where the document carries none", async () => {
    // an old page still in the service worker's cache predates this markup, and
    // it is served with the bundle it shipped with
    const { page, el } = await adopt(true, false);
    expect(created).toEqual([]);
    expect(attached).toBe(0);
    expect(el.gone).toBe(false);
    expect(page.lifted()).toBe(true);
  });
});

// --- the reveal path, as the app actually wires it ------------------------------
//
// The two halves above are the page and the rule. This is the join: main.ts is
// where "arrived" and "still" are put in front of the settle, and it is not a
// module a suite can import, since loading it boots a whole app. So it is read.
const MAIN_TS = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const REVEAL =
  /async function settleLoadingScreen\(\): Promise<void> \{[\s\S]*?\n\}/.exec(MAIN_TS)?.[0] ?? "";

describe("the reveal waits for quiet, and moves nothing on its way out", () => {
  it("is wired at all, and reads as one path", () => {
    expect(REVEAL).not.toBe("");
    expect(MAIN_TS).toContain("installLoadingScreen(");
    expect(MAIN_TS).toContain('holdDiagRecord("splash-cover"');
  });

  it("waits for the images, then for the app to hold still, and only then tells the page", () => {
    const decoded = REVEAL.indexOf("img.decode()");
    const quiet = REVEAL.indexOf("watchQuiet(");
    // the last one, because the path has an early way out for a boot with no
    // thread at all to wait on, and that one is allowed to say so straight away
    const told = REVEAL.lastIndexOf("loadingScreen.settled()");
    expect(decoded).toBeGreaterThan(-1);
    expect(quiet).toBeGreaterThan(decoded);
    expect(told).toBeGreaterThan(quiet);
  });

  it("hands the watch the page's own lifted() as its way out, and no clock", () => {
    // the cap is the only ceiling in the whole path; a second one invented here
    // would be a number nobody could justify
    expect(REVEAL).toContain("loadingScreen.lifted()");
    expect(REVEAL).not.toMatch(/setTimeout|setInterval|Date\.now|performance\.now/);
  });

  it("writes no scroll position of its own", () => {
    // the pins this waits on are made by the paths that own them. A nudge from
    // the one thing that is supposed to be proving the app is still would be
    // the app moving again, on the very frame it is measured on.
    expect(REVEAL).not.toMatch(/scrollTop\s*=/);
    expect(REVEAL).not.toMatch(/scrollTo\(|scrollBy\(|scrollIntoView|scrollToBottom\(/);
  });

  it("keeps the boot-motion recorder, which is the record of what it waits out", () => {
    expect(MAIN_TS).toContain('holdDiagRecord("boot-motion"');
    expect(MAIN_TS).toContain('holdDiagRecord("boot-repin"');
    expect(MAIN_TS).toContain('holdDiagRecord("boot-blank"');
  });
});

// ===================== TEMP DIAGNOSTIC (remove after the cold-open session) =====================
// Pins for the blank-stretch probe (src/splash.ts, the block at the top of it):
// the record main.ts posts is the only thing a deploy log will have, so every
// mark has to be in it and they have to be in the right order. A fresh module
// load stands in for a page load, since the code mark is read as the module
// evaluates; the second mark is read where the script takes the document's
// loading page over, so the two are separated here by a timer step the way real
// startup work would separate them.
describe("bootBlankGap: the ends of the blank stretch, in one record", () => {
  interface FakeEl {
    id: string;
    style: Record<string, string>;
    remove(): void;
  }

  function fakeEl(id = ""): FakeEl {
    return { id, style: {}, remove() {} };
  }

  async function loadFresh(standalone: boolean) {
    const byId: Record<string, FakeEl> = { loading: fakeEl("loading") };
    vi.stubGlobal("document", { getElementById: (id: string) => byId[id] ?? null });
    vi.stubGlobal("navigator", { standalone, userAgent: "iPhone" });
    vi.stubGlobal("screen", { width: 390, height: 844 });
    vi.stubGlobal("window", { devicePixelRatio: 3 });
    vi.resetModules(); // a fresh evaluation is a fresh page load: the code mark is re-read
    return await import("../src/splash");
  }

  beforeEach(() => {
    vi.useFakeTimers(); // the lift timers arm on adoption
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("carries both marks, and the adoption's is never earlier than the code's", async () => {
    const beforeLoad = performance.now();
    const mod = await loadFresh(true);
    vi.advanceTimersByTime(50); // stands in for whatever the app does before it adopts
    const beforeAdopt = performance.now();
    mod.installLoadingScreen();
    const afterAdopt = performance.now();
    const gap = mod.bootBlankGap();
    expect(typeof gap.codeStartMs).toBe("number");
    expect(typeof gap.coverUpMs).toBe("number");
    // each mark has to sit inside the window it claims to have been taken in:
    // the code one while the module evaluated, the other while the script took
    // the page over. Bracketing them rather than pinning exact numbers keeps
    // this honest whether or not the runner's clock is the faked one.
    expect(gap.codeStartMs).toBeGreaterThanOrEqual(Math.round(beforeLoad));
    expect(gap.codeStartMs).toBeLessThanOrEqual(Math.round(beforeAdopt));
    expect(gap.coverUpMs as number).toBeGreaterThanOrEqual(Math.round(beforeAdopt));
    expect(gap.coverUpMs as number).toBeLessThanOrEqual(Math.round(afterAdopt));
    expect(gap.coverUpMs as number).toBeGreaterThanOrEqual(gap.codeStartMs);
  });

  it("reports no second mark until the script has taken a page over", async () => {
    const mod = await loadFresh(true);
    expect(mod.bootBlankGap().coverUpMs).toBeNull(); // nothing adopted yet: nothing to claim
    mod.installLoadingScreen();
    expect(mod.bootBlankGap().coverUpMs).not.toBeNull();
  });

  it("leaves it null where no page is adopted at all", async () => {
    const mod = await loadFresh(false); // a browser tab: no launch image to hand over from
    mod.installLoadingScreen();
    const gap = mod.bootBlankGap();
    expect(gap.coverUpMs).toBeNull();
    expect(typeof gap.codeStartMs).toBe("number"); // the code mark still stands on its own
  });

  it("degrades the html mark to null where there is no navigation entry", async () => {
    const mod = await loadFresh(true);
    expect(mod.bootBlankGap().htmlDoneMs).toBeNull(); // node reports no navigation timing
  });

  it("degrades the paint mark to null where the browser reports no paint", async () => {
    // the mark that says when the page actually appeared, which is the whole
    // question the move into the document is judged on. It is the browser's own
    // and there is nothing to fall back to, so where it is missing the record
    // says so rather than substituting one of ours.
    const mod = await loadFresh(true);
    expect(mod.bootBlankGap().firstPaintMs).toBeNull();
  });
});
// =================== END TEMP DIAGNOSTIC (remove after the cold-open session) ===================
