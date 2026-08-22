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
//
// It also keeps a transform, because the credit line is drawn through one: a
// pair of scales, pushed and popped by save/restore exactly as a real context
// would. That is what lets the checks below read the same draw two ways, in the
// cover's CSS pixels it was asked for in and in the canvas's device pixels it
// lands on.
function recordingCtx(rejects: (v: string) => boolean = () => false) {
  const calls: Array<[string, ...unknown[]]> = [];
  let fillAtRect: DrawTarget["fillStyle"] | null = null;
  let fillAtText: DrawTarget["fillStyle"] | null = null;
  let fontAtText = "";
  let fill: DrawTarget["fillStyle"] = "";
  let font = "10px sans-serif"; // what a fresh canvas context starts on
  let sx = 1;
  let sy = 1;
  const saved: Array<[number, number]> = [];
  let scaleAtText: [number, number] = [1, 1];
  let textAtCss: [number, number] = [0, 0];
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
      scaleAtText = [sx, sy]; // and the transform it was drawn through
      textAtCss = [x, y];
      calls.push(["fillText", text, x, y]);
    },
    save() {
      saved.push([sx, sy]);
      calls.push(["save"]);
    },
    restore() {
      const was = saved.pop();
      if (was) [sx, sy] = was;
      calls.push(["restore"]);
    },
    scale(x, y) {
      sx *= x;
      sy *= y;
      calls.push(["scale", x, y]);
    },
  };
  return {
    ctx,
    calls,
    /** the drawing calls only, with save/restore/scale left out */
    drawn: () => calls.filter((c) => c[0] !== "save" && c[0] !== "restore" && c[0] !== "scale"),
    fillAt: () => fillAtRect,
    fillAtText: () => fillAtText,
    fontAtText: () => fontAtText,
    /** where the credit line was asked for, in the unit it was asked for in */
    textAtCss: () => textAtCss,
    /** and the device pixel that same point lands on, once the scale applies */
    textAtDevice: (): [number, number] => [
      textAtCss[0] * scaleAtText[0],
      textAtCss[1] * scaleAtText[1],
    ],
    scaleAtText: () => scaleAtText,
    /** anything left pushed at the end: a transform that was never put back */
    openTransforms: () => saved.length,
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
    // in device pixels, straight onto the canvas: the logo is a rectangle, and
    // a rectangle is the same picture at any scale, so it is drawn where it
    // sits and nothing is transformed for it
    expect(r.calls.slice(0, 2).some((c) => c[0] === "scale")).toBe(false);
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
    // asked for in the cover's pixels, but landing on the layout's own
    // device-pixel anchor once the scale it is drawn through applies: the fix
    // for the type size moved the UNIT the line is asked for in and nothing
    // else, so the spot it is put on is the spot it was always put on
    expect(r.drawn()[2]).toEqual([
      "fillText",
      SPLASH_HANDLE,
      g.handleCenterX * (g.screenW / g.canvasW),
      g.handleCenterY * (g.screenH / g.canvasH),
    ]);
    const [x, y] = r.textAtDevice();
    expect(x).toBeCloseTo(g.handleCenterX, 9);
    expect(y).toBeCloseTo(g.handleCenterY, 9);
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

  it("is set in the size the COVER sets it in, in the chat's own font", () => {
    // Not the layout's device-pixel size, which is what this used to be and
    // what made the tag change width on the handover: the system face spaces
    // small type looser than large type, so a line drawn at 41 device px and
    // shown at a third of that is not the line a stylesheet draws at 13.67 CSS
    // px. paintSplash asks coverHandleBox for the size and scales the canvas up
    // to it instead. Its own comment carries the measurement.
    const r = painted();
    expect(r.fontAtText()).toBe(`${coverHandleBox(g, 844).fontPx}px ${SPLASH_FONT_FAMILY}`);
    expect(coverHandleBox(g, 844).fontPx).not.toBe(g.handleFont); // genuinely a different number
  });

  it("scales by the canvas-to-screen ratio, and puts the transform back", () => {
    // The scale is taken per axis off the ROUNDED canvas rather than as the
    // device pixel ratio, for the reason coverLogoRect gives: the phone
    // stretches this canvas onto the screen, and this is that stretch. And it
    // is pushed and popped, so nothing drawn after it inherits it.
    const r = painted();
    const [sx, sy] = r.scaleAtText();
    expect(sx).toBeCloseTo(g.canvasW / g.screenW, 9);
    expect(sy).toBeCloseTo(g.canvasH / g.screenH, 9);
    expect(r.openTransforms()).toBe(0);
    expect(r.calls[r.calls.length - 1]).toEqual(["restore"]);
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
  it("is in the served page, and the only script the page fetches is a module", () => {
    // The whole point of the move: the element is parsed and paintable before a
    // line of the bundle runs. A module script is DEFERRED by definition, so it
    // cannot execute until the document has been parsed, and that is the
    // guarantee rather than where the tag sits: vite hoists it into the head at
    // build time, ahead of this markup, and it makes no difference.
    expect(INDEX_HTML).toContain('<div id="splashcover">');
    const scripts = [...INDEX_HTML.matchAll(/<script([^>]*)>/g)].map((m) => m[1]);
    // two tags, and only one of them is a file. The other is the geometry
    // script the head carries, and its attribute list is EMPTY: no src to go
    // and get, no type, no defer and no async, which between them are every way
    // a script can be made to run later than where it sits.
    expect(scripts.length).toBe(2);
    const fetched = scripts.filter((s) => s.includes("src="));
    expect(fetched.length).toBe(1);
    expect(fetched[0]).toContain('type="module"');
    expect(scripts.filter((s) => !s.includes("src="))).toEqual([""]);
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

// --- the head's own geometry script --------------------------------------------
//
// The rules above resolve against the VIEWPORT, and on iOS the layout viewport
// is reported short on the first frame and grows a moment later, so those rules
// put the logo somewhere the phone's own launch image never had it and then
// move it. index.html therefore carries a classic, src-less <script> in its
// head, which is a script that runs where it is parsed, and that script reads
// the SCREEN, which is right from the first frame, and appends a <style> saying
// the same thing splashLayout() says.
//
// That is a hand copy of arithmetic that lives in src/splash.ts, because a
// script that must fetch nothing cannot import a module, and a hand copy that
// quietly drifts would put the bug straight back. So this is where the two are
// held together, and it is held by EXECUTION rather than by reading: the block
// below runs the shipped script's own text against made-up screens and compares
// what it wrote with what the functions say. coverLogoRect and coverHandleBox
// are also exactly what installSplashCover writes once the bundle runs, so the
// same comparison is the proof that the later write moves nothing.
const FIT_SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(INDEX_HTML)?.[1] ?? "";

// a stand-in <style>: it remembers its id and whatever text was put inside it,
// which is the whole of what the script does to one
interface FakeStyle {
  id: string;
  text: string;
  appendChild(node: { data: string }): void;
}

// the screens the guard sweeps: the phones above, plus the shapes an iPhone
// list would never cover: a ratio of 1, a fractional one, and both
// orientations, since the layout is written off the SHORTER edge
const SCREENS: Array<[string, number, number, number]> = [
  ...PHONES,
  ["a 1x screen", 412, 915, 1],
  ["a fractional ratio", 393, 851, 2.625],
  ["landscape", 812, 375, 3],
  ["a square screen", 800, 800, 2],
];

// Run the shipped script against a made-up screen and hand back the CSS it
// appended. window and document are parameters, so they shadow whatever the
// test env has, and nothing else in the script reaches outside itself.
function runFitScript(screenObj: unknown, dpr: unknown): { css: string; styles: FakeStyle[] } {
  const made: FakeStyle[] = [];
  const doc = {
    createElement: (): FakeStyle => ({
      id: "",
      text: "",
      appendChild(node: { data: string }): void {
        this.text += node.data;
      },
    }),
    createTextNode: (data: string) => ({ data }),
    head: {
      appendChild: (el: FakeStyle): void => {
        made.push(el);
      },
    },
  };
  const win = { screen: screenObj, devicePixelRatio: dpr };
  new Function("window", "document", FIT_SCRIPT)(win, doc);
  return { css: made.map((s) => s.text).join(""), styles: made };
}

// one rule out of that generated CSS as a property -> number map. Every value
// it writes is a plain px length, so there is nothing else to parse.
function fitRule(css: string, selector: string): Record<string, number> {
  const body = new RegExp(`${selector}\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  const out: Record<string, number> = {};
  for (const decl of body.split(";")) {
    const at = decl.indexOf(":");
    if (at > 0) out[decl.slice(0, at).trim()] = Number(decl.slice(at + 1).replace("px", ""));
  }
  return out;
}

describe("the head's geometry script: the same rect, before the first paint", () => {
  it("is a classic script, in the head, below the rules it overrides", () => {
    // classic and src-less is what makes it parse-time: the parser stops, runs
    // it, and only then reaches the cover, so the style it appends is in force
    // for the frame the cover first appears on. Below the cover's own <style>
    // because the style it appends lands at the end of the head as the head
    // stands at that instant, and two rules of equal weight are settled by
    // which came last.
    expect(FIT_SCRIPT).not.toBe("");
    const at = INDEX_HTML.indexOf("<script>");
    expect(at).toBeGreaterThan(INDEX_HTML.indexOf("</style>"));
    expect(at).toBeLessThan(INDEX_HTML.indexOf("</head>"));
    expect(at).toBeLessThan(INDEX_HTML.indexOf('<div id="splashcover">'));
    // and it goes and gets nothing, which is the other half of parse-time
    expect(FIT_SCRIPT).not.toMatch(/\b(fetch|import|XMLHttpRequest|new Image)\b/);
  });

  it("restates every property the fallback rules state, and nothing besides", () => {
    const { css, styles } = runFitScript({ width: 375, height: 812 }, 3);
    expect(styles.length).toBe(1);
    expect(styles[0].id).toBe("splashfit");
    expect(Object.keys(fitRule(css, "#splashlogo")).sort()).toEqual([
      "height",
      "left",
      "top",
      "width",
    ]);
    // the fallback says the credit line with the font shorthand, which carries
    // the family too, so the row and the size are restated as longhands and the
    // family is left alone
    expect(Object.keys(fitRule(css, "#splashhandle")).sort()).toEqual([
      "font-size",
      "line-height",
      "top",
    ]);
  });

  it("writes exactly what splashLayout() writes, on every screen shape there is", () => {
    // THE DIVERGENCE GUARD. Every constant in the script (0.32, 0.035, 0.12,
    // 280/320) and every step of its arithmetic is checked here against the
    // functions that own them, so changing one side and not the other fails.
    for (const [name, w, h, dpr] of SCREENS) {
      const g = splashLayout({
        screenW: w,
        screenH: h,
        dpr,
        logoAspect: SPLASH_LOGO_W / SPLASH_LOGO_H,
      });
      const rect = coverLogoRect(g, w, h);
      const box = coverHandleBox(g, h);
      const { css } = runFitScript({ width: w, height: h }, dpr);
      const logo = fitRule(css, "#splashlogo");
      const handle = fitRule(css, "#splashhandle");
      expect([
        name,
        near(logo.left, rect.left),
        near(logo.top, rect.top),
        near(logo.width, rect.width),
        near(logo.height, rect.height),
      ]).toEqual([name, true, true, true, true]);
      expect([
        name,
        near(handle.top, box.top),
        near(handle["font-size"], box.fontPx),
        near(handle["line-height"], box.height),
      ]).toEqual([name, true, true, true]);
    }
  });

  it("changes nothing where the layout viewport is the screen from the first frame", () => {
    // The fallback rules resolve against the viewport and the script resolves
    // against the screen, so wherever the two are the same thing the script
    // writes the numbers already in force. That is the claim that it costs a
    // device with an honest viewport nothing: it runs, and the picture it
    // describes is the picture that was already there.
    const logoCss = cssRule("#splashlogo");
    const handleCss = cssRule("#splashhandle");
    const sizeCss = handleCss.font.split(" ")[0].split("/")[0];
    for (const [name, w, h, dpr] of SCREENS) {
      const { css } = runFitScript({ width: w, height: h }, dpr);
      const logo = fitRule(css, "#splashlogo");
      const handle = fitRule(css, "#splashhandle");
      // Where the screen times the ratio is a whole number of device pixels,
      // which it is on every iPhone, the agreement is exact and the script is
      // a no-op to the last bit. Where it is not, splashLayout() rounds the
      // canvas and coverLogoRect() carries THAT rounding back rather than
      // dividing by the ratio, on purpose and for the reason its own comment
      // gives: the logo has to land where the phone's launch image put it, not
      // where a stylesheet would have. So the gap that opens on such a screen
      // is that rounding and nothing else, and it is under half a device pixel.
      const whole = Number.isInteger(w * dpr) && Number.isInteger(h * dpr);
      const agrees = (a: number, b: number): boolean =>
        whole ? near(a, b) : Math.abs(a - b) <= 0.5 / dpr;
      expect([
        name,
        agrees(logo.left, resolveCss(logoCss.left, w, h, "x")),
        agrees(logo.top, resolveCss(logoCss.top, w, h, "y")),
        agrees(logo.width, resolveCss(logoCss.width, w, h, "x")),
        agrees(logo.height, resolveCss(logoCss.height, w, h, "y")),
      ]).toEqual([name, true, true, true, true]);
      // The credit line carries the one tolerance in this file's geometry, and
      // it is the same one the block above explains: splashLayout() rounds the
      // type to whole DEVICE pixels, because the launch image is rasterized
      // once at exactly those pixels, and a stylesheet cannot round at all. So
      // the type can be half a device pixel out and the row half of that again.
      // Stated in device pixels rather than as a flat number, since on a 1x
      // screen half a device pixel IS half a CSS pixel.
      const fontGap = Math.abs(handle["font-size"] - resolveCss(sizeCss, w, h, "y"));
      const topGap = Math.abs(handle.top - resolveCss(handleCss.top, w, h, "y"));
      expect([name, fontGap <= 0.5 / dpr, topGap <= 0.25 / dpr]).toEqual([name, true, true]);
    }
  });

  it("writes nothing at all, rather than throwing, when the screen makes no sense", () => {
    // It runs on every launch before anything else does, so the one thing it
    // must never do is throw. Where it cannot get two real edges and a real
    // ratio it writes nothing and the fallback rules above stand, which is the
    // behaviour the app had before this script existed.
    const junk: Array<[string, unknown, unknown]> = [
      ["no screen at all", undefined, 3],
      ["a null screen", null, 3],
      ["a screen with no edges", {}, 3],
      ["a zero width", { width: 0, height: 812 }, 3],
      ["a zero height", { width: 375, height: 0 }, 3],
      ["a negative edge", { width: 375, height: -812 }, 3],
      ["an edge that is not a number", { width: Number.NaN, height: 812 }, 3],
      ["no device pixel ratio", { width: 375, height: 812 }, undefined],
      ["a zero ratio", { width: 375, height: 812 }, 0],
      ["a ratio that is not a number", { width: 375, height: 812 }, Number.NaN],
    ];
    for (const [name, scr, dpr] of junk) {
      const go = () => runFitScript(scr, dpr);
      expect(go).not.toThrow();
      expect([name, go().styles.length]).toEqual([name, 0]);
    }
  });

  it("swallows a document that will not take the style, for the same reason", () => {
    // the other half of never throwing: the guard above covers bad inputs, and
    // this covers a DOM that refuses the one call the script makes to it
    const doc = {
      createElement: () => ({ id: "", appendChild: () => {} }),
      createTextNode: (data: string) => ({ data }),
      head: null,
    };
    const win = { screen: { width: 375, height: 812 }, devicePixelRatio: 3 };
    expect(() => new Function("window", "document", FIT_SCRIPT)(win, doc)).not.toThrow();
  });
});

// --- all three copies of the credit line, held together -------------------------
//
// The block above holds the DOCUMENT's copy of the geometry to the functions
// that own it. The credit line has a THIRD copy: the launch image paints one
// too, and it used to state its own size in its own unit, which is exactly how
// it drifted. It was drawn at the layout's whole device pixels while the cover
// was laid out at the same size in CSS pixels, and those are not the same line,
// because the system face spaces small type looser than large type. Measured in
// this app's own stack: the string is 8.735 em-widths long at 13px and 8.091 at
// 39px, so the cover's tag came out about eight percent wider than the launch
// image's and the swap between them was visible.
//
// So paintSplash now asks coverHandleBox for the size, which is the same
// function the cover's own write and the head's script are already held to, and
// scales the canvas to put that size on the device pixels the launch image
// needs. This is where that is checked, by DRAWING rather than by reading, the
// same way the head's script is checked by running: the launch image, the
// document's script and the bundle's write are compared against one another on
// every screen shape in the list.
describe("the launch image says the credit line exactly as the cover says it", () => {
  it("asks for the cover's size and lands on the layout's anchor, on every shape", () => {
    for (const [name, w, h, dpr] of SCREENS) {
      const g = splashLayout({
        screenW: w,
        screenH: h,
        dpr,
        logoAspect: SPLASH_LOGO_W / SPLASH_LOGO_H,
      });
      const box = coverHandleBox(g, h);
      const r = recordingCtx();
      paintSplash(r.ctx, {} as CanvasImageSource, g);
      // the size the font engine is asked for is the size the cover asks for,
      // to the last bit: that is the whole of the fix
      expect([name, r.fontAtText()]).toEqual([name, `${box.fontPx}px ${SPLASH_FONT_FAMILY}`]);
      // the point it is anchored on is the middle of the cover's own line box,
      // on the cover's own centre column
      const [x, y] = r.textAtCss();
      expect([name, near(x, w / 2), near(y, box.top + box.height / 2)]).toEqual([name, true, true]);
      // and, back in device pixels, the launch image has not moved an inch off
      // the anchor the layout has always named
      const [dx, dy] = r.textAtDevice();
      expect([name, near(dx, g.handleCenterX), near(dy, g.handleCenterY)]).toEqual([
        name,
        true,
        true,
      ]);
      // per axis, off the rounded canvas, and put back afterwards
      const [sx, sy] = r.scaleAtText();
      expect([name, near(sx, g.canvasW / w), near(sy, g.canvasH / h)]).toEqual([name, true, true]);
      expect([name, r.openTransforms()]).toEqual([name, 0]);
    }
  });

  it("agrees with the document's script and the bundle's write, on every shape", () => {
    // THE THREE-WAY GUARD. The launch image is what the phone shows, the fit
    // script is what the document's first frame shows, and coverHandleBox is
    // what installSplashCover writes over that once the bundle runs. All three
    // are read here off the same screen and required to name one line.
    for (const [name, w, h, dpr] of SCREENS) {
      const g = splashLayout({
        screenW: w,
        screenH: h,
        dpr,
        logoAspect: SPLASH_LOGO_W / SPLASH_LOGO_H,
      });
      const bundle = coverHandleBox(g, h); // what the bundle writes
      const doc = fitRule(runFitScript({ width: w, height: h }, dpr).css, "#splashhandle");
      const r = recordingCtx();
      paintSplash(r.ctx, {} as CanvasImageSource, g); // what the phone shows
      const drawn = Number(/^([\d.]+)px/.exec(r.fontAtText())?.[1]);
      const middle = r.textAtCss()[1];
      expect([
        name,
        near(drawn, bundle.fontPx),
        near(doc["font-size"], bundle.fontPx),
        near(doc["line-height"], bundle.height),
      ]).toEqual([name, true, true, true]);
      // one row, said three ways: the canvas anchors on the middle, and both of
      // the others state the top of a line box whose height they also state
      expect([
        name,
        near(middle, bundle.top + bundle.height / 2),
        near(doc.top + doc["line-height"] / 2, bundle.top + bundle.height / 2),
      ]).toEqual([name, true, true]);
    }
  });

  it("asks for a size the font ladder can still prove it got", () => {
    // The size is a CSS pixel now, so it is a repeating fraction on most
    // screens, and applySplashFont proves a shorthand parsed by reading the
    // size back. A browser is free to hand back a rounded serialization of what
    // it was given, so that readback is numeric; this is the check that the
    // whole stack still survives the trip on a size with a long tail.
    for (const [name, w, h, dpr] of SCREENS) {
      const g = splashLayout({
        screenW: w,
        screenH: h,
        dpr,
        logoAspect: SPLASH_LOGO_W / SPLASH_LOGO_H,
      });
      const px = coverHandleBox(g, h).fontPx;
      // a context that serializes to four decimal places, which is what a real
      // one does with 41/3
      const rounded = recordingCtx();
      const short = (v: string): string => v.replace(/^([\d.]+)px/, (_m, n) => `${+(+n).toFixed(4)}px`);
      const ctx = {
        get font() {
          return short(rounded.ctx.font);
        },
        set font(v: string) {
          rounded.ctx.font = v;
        },
      };
      expect([name, applySplashFont(ctx, px).endsWith(SPLASH_FONT_FAMILY)]).toEqual([name, true]);
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
