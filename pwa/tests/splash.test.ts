// Pins for the iOS launch-image generator (src/splash.ts), for the in-page
// copy of it that index.html carries, and for that copy's lift rule. The
// geometry and the drawing are pure, so every device is encoded as plain
// inputs: canvas size, centered logo rect, and the device-matching media query
// come out as data, and the paint step is checked against a recording
// 2D-context stand-in; the lift rule is pure too and runs entirely on fake
// timers. No real DOM and no real canvas needed, so this runs in the same node
// env as the other suites. The cover itself is checked by reading index.html,
// which is the document that actually ships, and the cases that have to watch
// the script take that cover over drive it against a recording element
// stand-in, the same way the paint step is driven against a recording context.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COVER_CAP_MS,
  COVER_FADE_MS,
  COVER_MIN_HOLD_MS,
  type CoverLift,
  type DrawTarget,
  SPLASH_BG,
  SPLASH_FONT_FAMILY,
  SPLASH_FONT_LADDER,
  SPLASH_HANDLE,
  SPLASH_HANDLE_BOTTOM_FRACTION,
  SPLASH_HANDLE_COLOR,
  SPLASH_HANDLE_FRACTION,
  SPLASH_LOGO_FRACTION,
  type SplashLayout,
  applySplashFont,
  coverHandleBox,
  coverLogoRect,
  createSplashCover,
  paintSplash,
  splashLayout,
} from "../src/splash";
import { SPLASH_LOGO_H, SPLASH_LOGO_W } from "../src/splashlogo";

// the real top-bar logo is 140x160 (portrait); most tests use its aspect ratio
const LOGO_ASPECT = 140 / 160;

describe("splashLayout — canvas sized to the exact device pixels", () => {
  it("iPhone 13/14 (390x844 @3) -> a 1170x2532 canvas", () => {
    const g = splashLayout({ screenW: 390, screenH: 844, dpr: 3, logoAspect: LOGO_ASPECT });
    expect(g.canvasW).toBe(1170);
    expect(g.canvasH).toBe(2532);
  });

  it("a 2x device doubles the CSS pixels (375x667 @2 -> 750x1334)", () => {
    const g = splashLayout({ screenW: 375, screenH: 667, dpr: 2, logoAspect: LOGO_ASPECT });
    expect(g.canvasW).toBe(750);
    expect(g.canvasH).toBe(1334);
  });
});

describe("splashLayout — the logo, centered and aspect-preserving", () => {
  const g = splashLayout({ screenW: 390, screenH: 844, dpr: 3, logoAspect: LOGO_ASPECT });

  it("sits dead center", () => {
    expect(g.logoX + g.logoW / 2).toBeCloseTo(g.canvasW / 2, 6);
    expect(g.logoY + g.logoH / 2).toBeCloseTo(g.canvasH / 2, 6);
  });

  it("keeps the logo's aspect ratio", () => {
    expect(g.logoW / g.logoH).toBeCloseTo(LOGO_ASPECT, 6);
  });

  it("longer side spans the fraction of the screen's shorter edge (single constant)", () => {
    const shortSide = Math.min(g.canvasW, g.canvasH);
    expect(Math.max(g.logoW, g.logoH)).toBeCloseTo(shortSide * SPLASH_LOGO_FRACTION, 6);
  });

  it("fits inside the canvas with room to spare", () => {
    expect(g.logoX).toBeGreaterThan(0);
    expect(g.logoY).toBeGreaterThan(0);
    expect(g.logoX + g.logoW).toBeLessThan(g.canvasW);
    expect(g.logoY + g.logoH).toBeLessThan(g.canvasH);
  });

  it("a landscape logo (aspect 2) pins its WIDTH to the box, height derived", () => {
    const wide = splashLayout({ screenW: 390, screenH: 844, dpr: 3, logoAspect: 2 });
    const box = Math.min(wide.canvasW, wide.canvasH) * SPLASH_LOGO_FRACTION;
    expect(wide.logoW).toBeCloseTo(box, 6);
    expect(wide.logoH).toBeCloseTo(box / 2, 6);
  });

  it("a square logo fills the box on both sides", () => {
    const sq = splashLayout({ screenW: 390, screenH: 844, dpr: 3, logoAspect: 1 });
    const box = Math.min(sq.canvasW, sq.canvasH) * SPLASH_LOGO_FRACTION;
    expect(sq.logoW).toBeCloseTo(box, 6);
    expect(sq.logoH).toBeCloseTo(box, 6);
  });
});

// every iPhone shape the app is opened on, smallest first: the credit line has
// to read the same way on all of them, which is what pins the two fractions
const PHONES: Array<[string, number, number, number]> = [
  ["SE (no home indicator)", 375, 667, 2],
  ["13 mini", 375, 812, 3],
  ["13/14", 390, 844, 3],
  ["14 Pro Max", 430, 932, 3],
  ["16 Pro Max", 440, 956, 3],
];

describe("splashLayout — the credit line, off the same numbers as the logo", () => {
  it("sizes the type off the shorter edge, on a 3x and on a 2x device", () => {
    const tall = splashLayout({ screenW: 390, screenH: 844, dpr: 3, logoAspect: LOGO_ASPECT });
    const short = splashLayout({ screenW: 375, screenH: 667, dpr: 2, logoAspect: LOGO_ASPECT });
    expect(tall.handleFont).toBe(Math.round(1170 * SPLASH_HANDLE_FRACTION)); // 41 device px
    expect(short.handleFont).toBe(Math.round(750 * SPLASH_HANDLE_FRACTION)); // 26 device px
  });

  it("sits dead center horizontally, whatever the screen", () => {
    for (const [name, w, h, dpr] of PHONES) {
      const g = splashLayout({ screenW: w, screenH: h, dpr, logoAspect: LOGO_ASPECT });
      expect([name, g.handleCenterX]).toEqual([name, g.canvasW / 2]);
    }
  });

  it("keeps the same gap off the bottom on a tall phone and a short one", () => {
    // measured against the shorter edge, so a taller screen does not push the
    // credit further down: in CSS px the two land within a couple of px
    const gaps = PHONES.map(([, w, h, dpr]) => {
      const g = splashLayout({ screenW: w, screenH: h, dpr, logoAspect: LOGO_ASPECT });
      const shortEdge = Math.min(g.canvasW, g.canvasH);
      expect(g.canvasH - g.handleCenterY).toBeCloseTo(shortEdge * SPLASH_HANDLE_BOTTOM_FRACTION, 6);
      return (g.canvasH - g.handleCenterY) / dpr; // CSS px up from the bottom edge
    });
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(8);
  });

  it("clears the home indicator's 34px inset on every one of them", () => {
    for (const [name, w, h, dpr] of PHONES) {
      const g = splashLayout({ screenW: w, screenH: h, dpr, logoAspect: LOGO_ASPECT });
      const bottomOfText = (g.canvasH - (g.handleCenterY + g.handleFont / 2)) / dpr;
      expect([name, bottomOfText > 34]).toEqual([name, true]);
    }
  });

  it("reads a bit smaller than the chat's 17px, and never turns tiny", () => {
    for (const [name, w, h, dpr] of PHONES) {
      const g = splashLayout({ screenW: w, screenH: h, dpr, logoAspect: LOGO_ASPECT });
      const cssPx = g.handleFont / dpr;
      expect([name, cssPx < 17 && cssPx > 12]).toEqual([name, true]);
    }
  });

  it("stays clear of the logo above it", () => {
    for (const [name, w, h, dpr] of PHONES) {
      const g = splashLayout({ screenW: w, screenH: h, dpr, logoAspect: LOGO_ASPECT });
      const topOfText = g.handleCenterY - g.handleFont / 2;
      expect([name, topOfText > g.logoY + g.logoH]).toEqual([name, true]);
    }
  });
});

describe("splashLayout — the device-matching media query", () => {
  it("portrait device names its width, height, dpr, and orientation", () => {
    const g = splashLayout({ screenW: 390, screenH: 844, dpr: 3, logoAspect: LOGO_ASPECT });
    expect(g.media).toBe(
      "(device-width: 390px) and (device-height: 844px) " +
        "and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)",
    );
  });

  it("a wider-than-tall screen reads as landscape", () => {
    const g = splashLayout({ screenW: 844, screenH: 390, dpr: 3, logoAspect: LOGO_ASPECT });
    expect(g.media).toContain("(orientation: landscape)");
  });
});

// A stand-in 2D context that records what was drawn and, like the real thing,
// keeps its previous font when handed a shorthand it cannot parse — `rejects`
// says which strings this particular context refuses.
function recordingCtx(rejects: (v: string) => boolean = () => false) {
  const calls: Array<[string, ...unknown[]]> = [];
  let fillAtRect: DrawTarget["fillStyle"] | null = null;
  let fillAtText: DrawTarget["fillStyle"] | null = null;
  let fontAtText = "";
  let fill: DrawTarget["fillStyle"] = "";
  let font = "10px sans-serif"; // what a fresh canvas context starts on
  const ctx: DrawTarget = {
    get fillStyle() {
      return fill;
    },
    set fillStyle(v) {
      fill = v;
    },
    get font() {
      return font;
    },
    set font(v) {
      if (!rejects(v)) font = v;
    },
    textAlign: "start",
    textBaseline: "alphabetic",
    fillRect(x, y, w, h) {
      fillAtRect = fill; // capture the color in force at fill time
      calls.push(["fillRect", x, y, w, h]);
    },
    drawImage(_img, x, y, w, h) {
      calls.push(["drawImage", x, y, w, h]);
    },
    fillText(text, x, y) {
      fillAtText = fill; // same for the credit line: colour and font as drawn
      fontAtText = font;
      calls.push(["fillText", text, x, y]);
    },
  };
  return {
    ctx,
    calls,
    fillAt: () => fillAtRect,
    fillAtText: () => fillAtText,
    fontAtText: () => fontAtText,
  };
}

describe("paintSplash — white first, then the logo at its rect", () => {
  const g: SplashLayout = splashLayout({
    screenW: 390,
    screenH: 844,
    dpr: 3,
    logoAspect: LOGO_ASPECT,
  });

  it("fills the whole canvas with solid white before drawing", () => {
    const r = recordingCtx();
    const logo = {} as CanvasImageSource;
    paintSplash(r.ctx, logo, g);
    expect(SPLASH_BG).toBe("#ffffff"); // the cover stands on this same white
    expect(r.fillAt()).toBe(SPLASH_BG);
    expect(r.calls[0]).toEqual(["fillRect", 0, 0, g.canvasW, g.canvasH]);
  });

  it("draws the logo at the centered rect, after the fill", () => {
    const r = recordingCtx();
    const logo = {} as CanvasImageSource;
    paintSplash(r.ctx, logo, g);
    expect(r.calls[1]).toEqual(["drawImage", g.logoX, g.logoY, g.logoW, g.logoH]);
  });
});

describe("paintSplash — the credit line, last and off the layout", () => {
  const g: SplashLayout = splashLayout({
    screenW: 390,
    screenH: 844,
    dpr: 3,
    logoAspect: LOGO_ASPECT,
  });

  function painted() {
    const r = recordingCtx();
    paintSplash(r.ctx, {} as CanvasImageSource, g);
    return r;
  }

  it("draws the handle on the layout's anchor, after the logo", () => {
    const r = painted();
    expect(r.calls[2]).toEqual(["fillText", SPLASH_HANDLE, g.handleCenterX, g.handleCenterY]);
    expect(SPLASH_HANDLE).toBe("@theonetrueakash");
  });

  it("anchors it by its middle on both axes, so the cover can match it", () => {
    const r = painted();
    expect(r.ctx.textAlign).toBe("center");
    expect(r.ctx.textBaseline).toBe("middle");
  });

  it("is faint grey, and leaves the white fill it stands on alone", () => {
    const r = painted();
    expect(r.fillAtText()).toBe(SPLASH_HANDLE_COLOR);
    expect(r.fillAt()).toBe(SPLASH_BG); // the background was still white when filled
  });

  it("is set in the layout's size, in the chat's own font", () => {
    const r = painted();
    expect(r.fontAtText()).toBe(`${g.handleFont}px ${SPLASH_FONT_FAMILY}`);
  });
});

describe("createSplashCover: when the in-app copy lifts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // every lift, with the reason it happened: one entry means one fade
  function harness() {
    const lifts: CoverLift[] = [];
    const cover = createSplashCover((why) => lifts.push(why));
    return { lifts, cover };
  }

  it("the hold is a second and the cap two", () => {
    expect(COVER_MIN_HOLD_MS).toBe(1000);
    expect(COVER_CAP_MS).toBe(2000);
    expect(COVER_CAP_MS).toBeGreaterThan(COVER_MIN_HOLD_MS);
  });

  it("stays up through the whole minimum hold, however early the thread settles", () => {
    const { lifts, cover } = harness();
    cover.settled(); // cached thread, images and all, before the first frame
    vi.advanceTimersByTime(COVER_MIN_HOLD_MS - 1);
    expect(cover.lifted()).toBe(false);
    expect(lifts).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(cover.lifted()).toBe(true);
    expect(lifts).toEqual(["settled"]);
  });

  it("waits for the settle when the hold passes first, then lifts on it", () => {
    const { lifts, cover } = harness();
    vi.advanceTimersByTime(COVER_MIN_HOLD_MS + 200); // hold done, thread still working
    expect(cover.lifted()).toBe(false);
    expect(lifts).toEqual([]);
    cover.settled();
    expect(cover.lifted()).toBe(true);
    expect(lifts).toEqual(["settled"]);
  });

  it("lifts at the cap when nothing ever settles", () => {
    const { lifts, cover } = harness();
    vi.advanceTimersByTime(COVER_CAP_MS - 1);
    expect(cover.lifted()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(cover.lifted()).toBe(true);
    expect(lifts).toEqual(["cap"]); // a dead network can never strand it
  });

  it("lifts once: a settle arriving after the cap changes nothing", () => {
    const { lifts, cover } = harness();
    vi.advanceTimersByTime(COVER_CAP_MS + 5000);
    cover.settled();
    vi.advanceTimersByTime(10000);
    expect(lifts).toEqual(["cap"]);
  });

  it("a settle before the cap wins the reason, and the cap adds nothing after", () => {
    const { lifts, cover } = harness();
    vi.advanceTimersByTime(COVER_MIN_HOLD_MS);
    cover.settled();
    expect(lifts).toEqual(["settled"]);
    vi.advanceTimersByTime(COVER_CAP_MS * 2); // the cap timer is spent, not pending
    expect(lifts).toEqual(["settled"]);
  });

  it("the windows are injectable, so the rule is not tied to its own constants", () => {
    const lifts: CoverLift[] = [];
    const cover = createSplashCover((why) => lifts.push(why), 40, 90);
    cover.settled();
    vi.advanceTimersByTime(39);
    expect(cover.lifted()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(lifts).toEqual(["settled"]);
  });
});

describe("coverLogoRect — the same rect, restated in the cover's CSS pixels", () => {
  it("is the device-pixel rect divided by the dpr when the canvas divides evenly", () => {
    const g = splashLayout({ screenW: 390, screenH: 844, dpr: 3, logoAspect: LOGO_ASPECT });
    const r = coverLogoRect(g, 390, 844);
    expect(r.left).toBeCloseTo(g.logoX / 3, 6);
    expect(r.top).toBeCloseTo(g.logoY / 3, 6);
    expect(r.width).toBeCloseTo(g.logoW / 3, 6);
    expect(r.height).toBeCloseTo(g.logoH / 3, 6);
  });

  it("stays centered on the screen it is laid over", () => {
    const g = splashLayout({ screenW: 430, screenH: 932, dpr: 3, logoAspect: LOGO_ASPECT });
    const r = coverLogoRect(g, 430, 932);
    expect(r.left + r.width / 2).toBeCloseTo(430 / 2, 6);
    expect(r.top + r.height / 2).toBeCloseTo(932 / 2, 6);
  });

  it("follows the canvas splashLayout actually rounded to, not a bare 1/dpr", () => {
    // a fractional dpr rounds the canvas, so the two are genuinely different
    // numbers here: the rect has to track the canvas or the cover's logo drifts
    // off the spot the phone's launch image put it
    const g = splashLayout({ screenW: 393, screenH: 851, dpr: 2.75, logoAspect: LOGO_ASPECT });
    const r = coverLogoRect(g, 393, 851);
    expect(g.canvasW).not.toBeCloseTo(393 * 2.75, 6); // rounding really happened
    expect(r.left + r.width / 2).toBeCloseTo(393 / 2, 6);
    expect(r.top + r.height / 2).toBeCloseTo(851 / 2, 6);
  });
});

describe("coverHandleBox — the same credit line, in the cover's CSS pixels", () => {
  it("is the device-pixel anchor divided by the dpr when the canvas divides evenly", () => {
    const g = splashLayout({ screenW: 390, screenH: 844, dpr: 3, logoAspect: LOGO_ASPECT });
    const b = coverHandleBox(g, 844);
    expect(b.fontPx).toBeCloseTo(g.handleFont / 3, 6);
    expect(b.top + b.height / 2).toBeCloseTo(g.handleCenterY / 3, 6);
  });

  it("hands back a line box whose middle IS the canvas's middle baseline", () => {
    // the caller sets top AND height (as line-height): a line box's middle sits
    // where canvas "middle" sits, so the pair of them is the whole match
    for (const [name, w, h, dpr] of PHONES) {
      const g = splashLayout({ screenW: w, screenH: h, dpr, logoAspect: LOGO_ASPECT });
      const b = coverHandleBox(g, h);
      const middleInCss = (g.handleCenterY * h) / g.canvasH;
      expect([name, Math.abs(b.top + b.height / 2 - middleInCss) < 1e-9]).toEqual([name, true]);
      expect([name, b.height]).toEqual([name, b.fontPx]);
    }
  });

  it("follows the canvas splashLayout actually rounded to, not a bare 1/dpr", () => {
    // same fractional-dpr device the logo's rect is pinned on: the credit line
    // has to track the rounded canvas or it drifts off the launch image's row
    const g = splashLayout({ screenW: 393, screenH: 851, dpr: 2.75, logoAspect: LOGO_ASPECT });
    const b = coverHandleBox(g, 851);
    expect(g.canvasH).not.toBeCloseTo(851 * 2.75, 6); // rounding really happened
    expect(b.fontPx).toBeCloseTo((g.handleFont * 851) / g.canvasH, 6);
    expect(b.fontPx).not.toBeCloseTo(g.handleFont / 2.75, 6);
  });

  it("puts the text as far off the bottom as the canvas does, in its own units", () => {
    const g = splashLayout({ screenW: 430, screenH: 932, dpr: 3, logoAspect: LOGO_ASPECT });
    const b = coverHandleBox(g, 932);
    const canvasGap = (g.canvasH - g.handleCenterY) / 3; // device px gap, in CSS px
    expect(932 - (b.top + b.height / 2)).toBeCloseTo(canvasGap, 6);
  });
});

describe("the splash font: the chat's own stack, and what a canvas does with it", () => {
  it("names exactly the family list styles.css sets on the body", () => {
    // the stack is restated in JS because the canvas needs it as a string; this
    // is the guard against the two copies drifting apart
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const flat = css.replace(/\s+/g, " ");
    expect(flat).toContain(SPLASH_FONT_FAMILY);
    expect(SPLASH_FONT_LADDER[0]).toBe(SPLASH_FONT_FAMILY);
  });

  it("asks for less than the size the chat sets its messages in", () => {
    const flat = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(
      /\s+/g,
      " ",
    );
    const chatPx = Number(/font:\s*(\d+(?:\.\d+)?)px\//.exec(flat)?.[1]);
    expect(chatPx).toBe(17);
    for (const [name, w, h, dpr] of PHONES) {
      const g = splashLayout({ screenW: w, screenH: h, dpr, logoAspect: LOGO_ASPECT });
      expect([name, coverHandleBox(g, h).fontPx < chatPx]).toEqual([name, true]);
    }
  });

  it("takes the whole stack on a context that parses it", () => {
    const r = recordingCtx();
    expect(applySplashFont(r.ctx, 41)).toBe(`41px ${SPLASH_FONT_FAMILY}`);
  });

  it("steps down to the closest thing that parses when the stack is refused", () => {
    // a context drops a shorthand it dislikes WHOLE and keeps its old font, so
    // the readback is the only way to know; system-ui names the same face
    const r = recordingCtx((v) => v.includes("-apple-system"));
    expect(applySplashFont(r.ctx, 41)).toBe("41px system-ui");
  });

  it("ends on a plain generic rather than on the canvas default", () => {
    const r = recordingCtx((v) => v.includes("-apple-system") || v.includes("system-ui"));
    expect(applySplashFont(r.ctx, 41)).toBe("41px sans-serif");
  });
});

// --- the cover the document itself carries -------------------------------------
//
// The cover is markup, styles and art in index.html now, so that file is what
// has to be read to check it. There is no DOM in this env, but more to the
// point the whole claim is about what the SERVED document says before a line of
// this bundle has run, and the file is exactly that. Same idea as the styles.css
// read above: the copy that ships is the copy under test.
const INDEX_HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");

// the cover's own markup, from its opening tag to where the app's root begins
const COVER_HTML = INDEX_HTML.slice(
  INDEX_HTML.indexOf('<div id="splashcover">'),
  INDEX_HTML.indexOf('<div id="app">'),
);

// the document's inline <style> block, whitespace flattened the way the
// styles.css checks above flatten theirs, so a wrapped declaration reads as one
const COVER_CSS = (/<style>([\s\S]*?)<\/style>/.exec(INDEX_HTML)?.[1] ?? "").replace(/\s+/g, " ");

// one rule's declarations, by selector, as a property -> value map. The first
// match in the file wins, which is the top-level rule: the display-mode
// override deliberately sits below all three of them.
function cssRule(selector: string): Record<string, string> {
  const body = new RegExp(`${selector}\\s*\\{([^}]*)\\}`).exec(COVER_CSS)?.[1] ?? "";
  const out: Record<string, string> = {};
  for (const decl of body.split(";")) {
    const at = decl.indexOf(":");
    if (at > 0) out[decl.slice(0, at).trim()] = decl.slice(at + 1).trim();
  }
  return out;
}

// the vmin coefficient out of a value, for the checks that pin the stylesheet
// to the layout's constants rather than to any one device
function vminOf(value: string): number {
  const m = /([\d.]+)vmin/.exec(value);
  if (!m) throw new Error(`no vmin in: ${value}`);
  return Number(m[1]);
}

// The handful of length shapes the cover's stylesheet uses, resolved to CSS px
// for a given viewport: "28vmin", "calc(50% - 14vmin)", "calc(100% - 13.75vmin)".
// vmin is the viewport's shorter edge; the percentage is of the cover, and the
// cover is fixed at inset 0, so the cover IS the viewport. That pair of
// substitutions is the whole of what a browser would do with these values, and
// what the suite below compares against splashLayout()'s answer.
function resolveCss(value: string, w: number, h: number, axis: "x" | "y"): number {
  const short = Math.min(w, h);
  const pct = axis === "x" ? w : h;
  const calc = /^calc\(([\d.]+)% - ([\d.]+)vmin\)$/.exec(value);
  if (calc) return (Number(calc[1]) / 100) * pct - (Number(calc[2]) / 100) * short;
  const plain = /^([\d.]+)vmin$/.exec(value);
  if (plain) return (Number(plain[1]) / 100) * short;
  throw new Error(`unhandled length: ${value}`);
}

// a hair, for comparing two float routes to the same number: everything below
// that uses it is an EXACT agreement claim, not an approximate one
function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6;
}

describe("the launch cover lives in the document, not in the bundle", () => {
  it("is in the served page, and the one script the page loads is a module", () => {
    // The whole point of the move: the element is parsed and paintable before a
    // line of the bundle runs. A module script is DEFERRED by definition, so it
    // cannot execute until the document has been parsed, and that is the
    // guarantee rather than where the tag sits: vite hoists it into the head at
    // build time, ahead of this markup, and it makes no difference.
    expect(INDEX_HTML).toContain('<div id="splashcover">');
    const scripts = [...INDEX_HTML.matchAll(/<script([^>]*)>/g)].map((m) => m[1]);
    expect(scripts.length).toBe(1);
    expect(scripts[0]).toContain('type="module"');
  });

  it("carries both of the things it shows, with nothing left to go and get", () => {
    expect(COVER_HTML).toContain('id="splashlogo"');
    expect(COVER_HTML).toContain(`>${SPLASH_HANDLE}<`);
    // every src/href inside the cover: there is one, it is the art, and it is a
    // data URI. No request, no service-worker lookup and no second file between
    // the document arriving and the picture being on screen.
    const refs = [...COVER_HTML.matchAll(/(?:src|href)="([^"]*)"/g)].map((m) => m[1]);
    expect(refs.length).toBe(1);
    expect(refs[0].startsWith("data:image/webp;base64,")).toBe(true);
    // and the browser is told not to defer the decode either, so the frame that
    // carries the element carries the picture
    expect(COVER_HTML).toContain('decoding="sync"');
  });

  it("gets its styles from the document too, in the head, before the markup", () => {
    expect(COVER_CSS).toContain("#splashcover");
    expect(COVER_CSS).toContain("#splashlogo");
    expect(COVER_CSS).toContain("#splashhandle");
    expect(INDEX_HTML.indexOf("<style>")).toBeLessThan(INDEX_HTML.indexOf("</head>"));
    expect(INDEX_HTML.indexOf("</style>")).toBeLessThan(INDEX_HTML.indexOf('<div id="splashcover">'));
  });

  it("stands on the same white, in the same grey, with the same fade", () => {
    expect(cssRule("#splashcover").background).toBe(SPLASH_BG);
    expect(cssRule("#splashcover").transition).toBe(`opacity ${COVER_FADE_MS}ms ease`);
    expect(cssRule("#splashhandle").color).toBe(SPLASH_HANDLE_COLOR);
    expect(cssRule("#splashhandle").font.endsWith(SPLASH_FONT_FAMILY)).toBe(true);
  });

  it("hides itself in a browser tab, where there was no launch image to cover", () => {
    // the rule that acts before any code runs; splash.ts removes the element
    // outright in the same case, which is what catches a browser that does not
    // know the query at all
    const tab = /@media \(display-mode: browser\) \{ #splashcover \{([^}]*)\}/.exec(COVER_CSS)?.[1];
    expect(tab).toBeDefined();
    expect(tab).toContain("display: none");
  });
});

describe("the cover's stylesheet says exactly what splashLayout() says", () => {
  it("sizes the logo's box by the layout's own fraction of the shorter edge", () => {
    // splashLayout() puts the logo's bounding square at SPLASH_LOGO_FRACTION of
    // the shorter edge and contain-fits the art inside it. vmin IS that edge, so
    // the stylesheet can carry the same statement without carrying the function.
    const r = cssRule("#splashlogo");
    expect(vminOf(r.height)).toBeCloseTo(SPLASH_LOGO_FRACTION * 100, 9);
    expect(vminOf(r.width)).toBeCloseTo(SPLASH_LOGO_FRACTION * (SPLASH_LOGO_W / SPLASH_LOGO_H) * 100, 9);
    // centered on both axes: the corner is the middle less half the box
    expect(vminOf(r.left)).toBeCloseTo(vminOf(r.width) / 2, 9);
    expect(vminOf(r.top)).toBeCloseTo(vminOf(r.height) / 2, 9);
  });

  it("sizes and places the credit line by the layout's other two fractions", () => {
    const r = cssRule("#splashhandle");
    const [size, lineHeight] = r.font.split(" ")[0].split("/");
    expect(vminOf(size)).toBeCloseTo(SPLASH_HANDLE_FRACTION * 100, 9);
    // the line-height is pinned to the size, which is what makes the box's
    // middle land where the canvas's "middle" baseline lands
    expect(vminOf(lineHeight)).toBeCloseTo(SPLASH_HANDLE_FRACTION * 100, 9);
    // CSS places a box by its top and the canvas draws from the text's middle,
    // so the top is the layout's bottom gap plus half the type
    expect(vminOf(r.top)).toBeCloseTo(
      (SPLASH_HANDLE_BOTTOM_FRACTION + SPLASH_HANDLE_FRACTION / 2) * 100,
      9,
    );
  });

  it("resolves to the logo's exact rect on every phone the app is opened on", () => {
    // this is what makes the correction splash.ts writes afterwards invisible:
    // the numbers it writes are the numbers already in force
    const r = cssRule("#splashlogo");
    for (const [name, w, h, dpr] of PHONES) {
      const g = splashLayout({ screenW: w, screenH: h, dpr, logoAspect: SPLASH_LOGO_W / SPLASH_LOGO_H });
      const want = coverLogoRect(g, w, h);
      expect([name, near(resolveCss(r.left, w, h, "x"), want.left)]).toEqual([name, true]);
      expect([name, near(resolveCss(r.top, w, h, "y"), want.top)]).toEqual([name, true]);
      expect([name, near(resolveCss(r.width, w, h, "x"), want.width)]).toEqual([name, true]);
      expect([name, near(resolveCss(r.height, w, h, "y"), want.height)]).toEqual([name, true]);
    }
  });

  it("resolves to the credit line's row too, within the type's own rounding", () => {
    // The ONE place the two sides can differ. splashLayout() rounds the type to
    // whole DEVICE pixels, because the canvas is rasterized once at exactly
    // those pixels and never resampled, and a stylesheet cannot round. So the
    // sizes can sit a fraction of a CSS pixel apart and the row half of that,
    // which is a quarter of a device pixel at worst and is the only tolerance
    // anywhere in this file's geometry.
    const r = cssRule("#splashhandle");
    const size = r.font.split(" ")[0].split("/")[0];
    for (const [name, w, h, dpr] of PHONES) {
      const g = splashLayout({ screenW: w, screenH: h, dpr, logoAspect: SPLASH_LOGO_W / SPLASH_LOGO_H });
      const want = coverHandleBox(g, h);
      const fontGap = Math.abs(resolveCss(size, w, h, "y") - want.fontPx);
      const topGap = Math.abs(resolveCss(r.top, w, h, "y") - want.top);
      expect([name, fontGap < 0.2, topGap < 0.1]).toEqual([name, true, true]);
    }
  });
});

describe("the inlined logo art (index.html)", () => {
  const art = /src="(data:[^"]*)"/.exec(COVER_HTML)?.[1] ?? "";

  it("is a data URI, so there is nothing for the cover to go and fetch", () => {
    expect(art.startsWith("data:image/webp;base64,")).toBe(true);
  });

  it("keeps the full-res file's aspect, so the geometry is unchanged by inlining", () => {
    // PNG header: 8-byte signature, then the IHDR length and tag, then width
    // and height as big-endian 32-bit ints at offsets 16 and 20
    const png = readFileSync(new URL("../public/splash-logo.png", import.meta.url));
    const fullW = png.readUInt32BE(16);
    const fullH = png.readUInt32BE(20);
    expect(SPLASH_LOGO_W / SPLASH_LOGO_H).toBeCloseTo(fullW / fullH, 10);
  });

  it("is big enough for the largest rect any iPhone shows the logo at", () => {
    // the widest iPhone screen in CSS px at dpr 3; the logo's own device-pixel
    // size there is what the inlined art has to stand up to
    const g = splashLayout({
      screenW: 440,
      screenH: 956,
      dpr: 3,
      logoAspect: SPLASH_LOGO_W / SPLASH_LOGO_H,
    });
    expect(SPLASH_LOGO_H).toBeGreaterThan(g.logoH * 0.6);
  });

  it("stays small enough that inlining it cannot slow the first paint", () => {
    // the whole point of a small inline copy, and it matters more here than it
    // did in the bundle: the document is now the thing that has to arrive
    // before anything can be on screen, so every byte of this is in front of
    // the cover it draws. A full-res raster as base64 would trade the flash for
    // a heavier document, which is the worse bug.
    expect(art.length).toBeLessThan(8 * 1024);
  });
});

describe("installSplashCover: it adopts the document's cover, it never builds one", () => {
  // A recording stand-in for the handful of DOM calls the adoption makes, in
  // the spirit of the recording 2D context above: a document that already
  // carries the cover, because every real one does, which remembers whether
  // anything was ever made or attached and whether the cover was taken out.
  interface FakeEl {
    tag: string;
    id: string;
    style: Record<string, string>;
    children: FakeEl[];
    gone: boolean;
    appendChild(c: FakeEl): void;
    remove(): void;
  }

  function fakeEl(tag: string, id = ""): FakeEl {
    const el: FakeEl = {
      tag,
      id,
      style: { cssText: "" },
      children: [],
      gone: false,
      appendChild(c) {
        el.children.push(c);
      },
      remove() {
        el.gone = true;
      },
    };
    return el;
  }

  // every Image the module constructs is a thing the cover would have to wait
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

  async function adopt(
    standalone = true,
    screenW = 390,
    screenH = 844,
    dpr = 3,
    withCover = true,
  ) {
    created = [];
    attached = 0;
    RecordingImage.made = 0;
    const el = fakeEl("div", "splashcover");
    const logo = fakeEl("img", "splashlogo");
    const handle = fakeEl("div", "splashhandle");
    el.appendChild(logo);
    el.appendChild(handle);
    const byId: Record<string, FakeEl> = withCover
      ? { splashcover: el, splashlogo: logo, splashhandle: handle }
      : {};
    const body = fakeEl("body");
    body.appendChild = () => {
      attached += 1;
    };
    vi.stubGlobal("document", {
      body,
      getElementById: (id: string) => byId[id] ?? null,
      createElement(tag: string) {
        created.push(tag);
        return fakeEl(tag);
      },
    });
    vi.stubGlobal("navigator", { standalone, userAgent: "iPhone" });
    vi.stubGlobal("screen", { width: screenW, height: screenH });
    vi.stubGlobal("window", { devicePixelRatio: dpr });
    vi.stubGlobal("Image", RecordingImage);
    vi.resetModules(); // the adoption runs once per module load, so reload it per case
    const mod = await import("../src/splash");
    return { cover: mod.installSplashCover("/splash-logo.png"), el, logo, handle };
  }

  beforeEach(() => {
    vi.useFakeTimers(); // the lift timers start with the adoption
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("takes the element the page already carries: no second cover is made", async () => {
    const { el } = await adopt();
    expect(created).toEqual([]); // no div, no img, no canvas
    expect(attached).toBe(0); // and nothing added to the body
    expect(RecordingImage.made).toBe(0); // and nothing left to decode
    expect(el.gone).toBe(false); // the one it was handed is still in the page
  });

  it("still lifts on the cap, on the element it adopted", async () => {
    const { cover, el } = await adopt();
    expect(cover.lifted()).toBe(false);
    vi.advanceTimersByTime(COVER_CAP_MS);
    expect(cover.lifted()).toBe(true);
    expect(el.style.opacity).toBe("0"); // the transition index.html states
    expect(el.style.pointerEvents).toBe("none"); // the fade must not eat the first tap
    expect(el.gone).toBe(false); // still fading
    vi.advanceTimersByTime(COVER_FADE_MS);
    expect(el.gone).toBe(true);
  });

  it("still lifts on the settle, once the minimum hold has passed", async () => {
    const { cover, el } = await adopt();
    cover.settled();
    vi.advanceTimersByTime(COVER_MIN_HOLD_MS - 1);
    expect(cover.lifted()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(cover.lifted()).toBe(true);
    expect(el.style.opacity).toBe("0");
  });

  it("writes the launch image's own rect onto the logo it adopted", async () => {
    const { logo } = await adopt(true, 390, 844, 3);
    const g = splashLayout({
      screenW: 390,
      screenH: 844,
      dpr: 3,
      logoAspect: SPLASH_LOGO_W / SPLASH_LOGO_H,
    });
    const r = coverLogoRect(g, 390, 844);
    expect(logo.style.cssText).toBe(
      `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;`,
    );
  });

  it("writes the credit line's row and size onto the one it adopted", async () => {
    for (const [w, h, dpr] of [
      [390, 844, 3],
      [375, 667, 2],
    ]) {
      const { handle } = await adopt(true, w, h, dpr);
      const g = splashLayout({
        screenW: w,
        screenH: h,
        dpr,
        logoAspect: SPLASH_LOGO_W / SPLASH_LOGO_H,
      });
      const b = coverHandleBox(g, h);
      expect(handle.style.cssText).toBe(
        `top:${b.top}px;font:${b.fontPx}px/${b.height}px ${SPLASH_FONT_FAMILY};`,
      );
    }
  });

  it("takes the cover out of the page in a browser tab, and covers nothing", async () => {
    const { cover, el } = await adopt(false);
    expect(el.gone).toBe(true); // a fixed full-screen panel does not get to linger
    expect(cover.lifted()).toBe(true); // the no-op cover: nothing to wait on
  });

  it("does not fall back to building one where the page carries none", async () => {
    // an old page still in the service worker's cache predates the markup, and
    // it is served with the bundle it shipped with, which builds its own
    const { cover, el } = await adopt(true, 390, 844, 3, false);
    expect(created).toEqual([]);
    expect(attached).toBe(0);
    expect(el.gone).toBe(false);
    expect(cover.lifted()).toBe(true);
  });
});

// ===================== TEMP DIAGNOSTIC (remove after the cold-open session) =====================
// Pins for the blank-stretch probe (src/splash.ts, the block at the top of it):
// the record main.ts posts is the only thing a deploy log will have, so every
// mark has to be in it and they have to be in the right order. A fresh module
// load stands in for a page load, since the code mark is read as the module
// evaluates; the cover mark is read where the script takes the document's cover
// over, so the two are separated here by a timer step the way real startup work
// would separate them.
describe("bootBlankGap: the ends of the blank stretch, in one record", () => {
  // the same recording stand-in idea as the adoption suite above, pared to the
  // handful of properties the script writes
  interface FakeEl {
    id: string;
    style: Record<string, string>;
    remove(): void;
  }

  function fakeEl(id = ""): FakeEl {
    return { id, style: { cssText: "" }, remove() {} };
  }

  async function loadFresh(standalone: boolean) {
    // a document that carries the cover, like every served one does
    const byId: Record<string, FakeEl> = {
      splashcover: fakeEl("splashcover"),
      splashlogo: fakeEl("splashlogo"),
      splashhandle: fakeEl("splashhandle"),
    };
    vi.stubGlobal("document", { getElementById: (id: string) => byId[id] ?? null });
    vi.stubGlobal("navigator", { standalone, userAgent: "iPhone" });
    vi.stubGlobal("screen", { width: 390, height: 844 });
    vi.stubGlobal("window", { devicePixelRatio: 3 });
    vi.resetModules(); // a fresh evaluation is a fresh page load: the code mark is re-read
    return await import("../src/splash");
  }

  beforeEach(() => {
    vi.useFakeTimers(); // the cover's lift timers arm on adoption
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("carries both marks, and the cover's is never earlier than the code's", async () => {
    const beforeLoad = performance.now();
    const mod = await loadFresh(true);
    vi.advanceTimersByTime(50); // stands in for whatever the app does before it adopts
    const beforeAdopt = performance.now();
    mod.installSplashCover("/splash-logo.png");
    const afterAdopt = performance.now();
    const gap = mod.bootBlankGap();
    expect(typeof gap.codeStartMs).toBe("number");
    expect(typeof gap.coverUpMs).toBe("number");
    // each mark has to sit inside the window it claims to have been taken in:
    // the code one while the module evaluated, the cover one while the script
    // took the cover over. Bracketing them rather than pinning exact numbers
    // keeps this honest whether or not the runner's clock is the faked one.
    expect(gap.codeStartMs).toBeGreaterThanOrEqual(Math.round(beforeLoad));
    expect(gap.codeStartMs).toBeLessThanOrEqual(Math.round(beforeAdopt));
    expect(gap.coverUpMs as number).toBeGreaterThanOrEqual(Math.round(beforeAdopt));
    expect(gap.coverUpMs as number).toBeLessThanOrEqual(Math.round(afterAdopt));
    expect(gap.coverUpMs as number).toBeGreaterThanOrEqual(gap.codeStartMs);
  });

  it("reports no cover mark until the script has taken a cover over", async () => {
    const mod = await loadFresh(true);
    expect(mod.bootBlankGap().coverUpMs).toBeNull(); // nothing adopted yet: nothing to claim
    mod.installSplashCover("/splash-logo.png");
    expect(mod.bootBlankGap().coverUpMs).not.toBeNull();
  });

  it("leaves the cover mark null where no cover is adopted at all", async () => {
    const mod = await loadFresh(false); // a browser tab: no launch image to hand over from
    mod.installSplashCover("/splash-logo.png");
    const gap = mod.bootBlankGap();
    expect(gap.coverUpMs).toBeNull();
    expect(typeof gap.codeStartMs).toBe("number"); // the code mark still stands on its own
  });

  it("degrades the html mark to null where there is no navigation entry", async () => {
    const mod = await loadFresh(true);
    expect(mod.bootBlankGap().htmlDoneMs).toBeNull(); // node reports no navigation timing
  });

  it("degrades the paint mark to null where the browser reports no paint", async () => {
    // the mark that says when the cover actually appeared, which is the whole
    // question the move into the document is judged on. It is the browser's own
    // and there is nothing to fall back to, so where it is missing the record
    // says so rather than substituting one of ours.
    const mod = await loadFresh(true);
    expect(mod.bootBlankGap().firstPaintMs).toBeNull();
  });
});
// =================== END TEMP DIAGNOSTIC (remove after the cold-open session) ===================
