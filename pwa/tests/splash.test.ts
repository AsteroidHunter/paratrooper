// Pins for the iOS home-screen launch image (src/splash.ts).
//
// This is the picture the PHONE stores and shows: the app paints it at runtime
// for the device it is running on and installs it as apple-touch-startup-image.
// The geometry and the drawing are pure, so every device is encoded as plain
// inputs: canvas size, centered logo rect, and the device-matching media query
// come out as data, and the paint step is checked against a recording
// 2D-context stand-in. No real DOM and no real canvas needed, so this runs in
// the same node env as the other suites.
//
// The app's own loading page, which is what the phone hands over TO, is a
// different picture with a different job and lives in tests/loading.test.ts.
// One thing crosses between them: the white. Both stand on SPLASH_BG, which is
// what makes the handover a change of drawing rather than a change of colour.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
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
  drawSplashHandle,
  paintSplash,
  splashHandleBox,
  splashLayout,
} from "../src/splash";

// the real top-bar logo is 140x160 (portrait); the layout is fed its aspect
// ratio, so that is the one number the tests here need about the art
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
// screen's CSS pixels it was asked for in and in the canvas's device pixels it
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
    expect(SPLASH_BG).toBe("#ffffff"); // the loading page stands on this same white
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
    // asked for in the screen's pixels, but landing on the layout's own
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

  it("anchors it by its middle on both axes, the way CSS places a line box", () => {
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
    // px. paintSplash asks splashHandleBox for the size and scales the canvas up
    // to it instead. Its own comment carries the measurement.
    const r = painted();
    expect(r.fontAtText()).toBe(`${splashHandleBox(g, 844).fontPx}px ${SPLASH_FONT_FAMILY}`);
    expect(splashHandleBox(g, 844).fontPx).not.toBe(g.handleFont); // genuinely a different number
  });

  it("scales by the canvas-to-screen ratio, and puts the transform back", () => {
    // The scale is taken per axis off the ROUNDED canvas rather than as the
    // device pixel ratio, for the reason splashHandleBox gives: the phone
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

describe("splashHandleBox — the same credit line, in the screen's CSS pixels", () => {
  it("is the device-pixel anchor divided by the dpr when the canvas divides evenly", () => {
    const g = splashLayout({ screenW: 390, screenH: 844, dpr: 3, logoAspect: LOGO_ASPECT });
    const b = splashHandleBox(g, 844);
    expect(b.fontPx).toBeCloseTo(g.handleFont / 3, 6);
    expect(b.top + b.height / 2).toBeCloseTo(g.handleCenterY / 3, 6);
  });

  it("hands back a line box whose middle IS the canvas's middle baseline", () => {
    // the caller sets top AND height (as line-height): a line box's middle sits
    // where canvas "middle" sits, so the pair of them is the whole match
    for (const [name, w, h, dpr] of PHONES) {
      const g = splashLayout({ screenW: w, screenH: h, dpr, logoAspect: LOGO_ASPECT });
      const b = splashHandleBox(g, h);
      const middleInCss = (g.handleCenterY * h) / g.canvasH;
      expect([name, Math.abs(b.top + b.height / 2 - middleInCss) < 1e-9]).toEqual([name, true]);
      expect([name, b.height]).toEqual([name, b.fontPx]);
    }
  });

  it("follows the canvas splashLayout actually rounded to, not a bare 1/dpr", () => {
    // same fractional-dpr device the logo's rect is pinned on: the credit line
    // has to track the rounded canvas or it drifts off the launch image's row
    const g = splashLayout({ screenW: 393, screenH: 851, dpr: 2.75, logoAspect: LOGO_ASPECT });
    const b = splashHandleBox(g, 851);
    expect(g.canvasH).not.toBeCloseTo(851 * 2.75, 6); // rounding really happened
    expect(b.fontPx).toBeCloseTo((g.handleFont * 851) / g.canvasH, 6);
    expect(b.fontPx).not.toBeCloseTo(g.handleFont / 2.75, 6);
  });

  it("puts the text as far off the bottom as the canvas does, in its own units", () => {
    const g = splashLayout({ screenW: 430, screenH: 932, dpr: 3, logoAspect: LOGO_ASPECT });
    const b = splashHandleBox(g, 932);
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
      expect([name, splashHandleBox(g, h).fontPx < chatPx]).toEqual([name, true]);
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

// a hair, for comparing two float routes to the same number: everything below
// that uses it is an EXACT agreement claim, not an approximate one
function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6;
}

// the screens the guard sweeps: the phones above, plus the shapes an iPhone
// list would never reach: a ratio of 1, a fractional one, and both
// orientations, since the layout is written off the SHORTER edge
const SCREENS: Array<[string, number, number, number]> = [
  ...PHONES,
  ["a 1x screen", 412, 915, 1],
  ["a fractional ratio", 393, 851, 2.625],
  ["landscape", 812, 375, 3],
  ["a square screen", 800, 800, 2],
];

// --- the credit line, asked for in one unit and drawn in another --------------
//
// The line is drawn at the layout's whole DEVICE pixels but asked for at the
// size it occupies on the SCREEN, through a scale, and those are not the same
// instruction: the system face spaces small type looser than large type.
// Measured in this app's own stack, the string is 8.735 em-widths long at 13px
// and 8.091 at 39px, so a line set at the canvas's own size came out about
// eight percent narrower than one set at the screen's.
//
// The app's first page used to restate this same line as live text, and the two
// had to agree glyph for glyph. It does not any more, so there is nothing left
// to compare the picture WITH, and what is checked here is what the picture is
// built from: the size the font engine is handed, the point it is anchored on,
// and the scale that carries one to the other, on every screen shape in the
// list. The numbers are load-bearing on their own now, since a change to any of
// them changes the file the phone stores and shows.
describe("the launch image asks for its credit line in the screen's own size", () => {
  it("asks for the screen's size and lands on the layout's anchor, on every shape", () => {
    for (const [name, w, h, dpr] of SCREENS) {
      const g = splashLayout({
        screenW: w,
        screenH: h,
        dpr,
        logoAspect: LOGO_ASPECT,
      });
      const box = splashHandleBox(g, h);
      const r = recordingCtx();
      paintSplash(r.ctx, {} as CanvasImageSource, g);
      // the size the font engine is asked for is the size the line occupies on
      // the screen, to the last bit
      expect([name, r.fontAtText()]).toEqual([name, `${box.fontPx}px ${SPLASH_FONT_FAMILY}`]);
      // the point it is anchored on is the middle of that same line box, on the
      // screen's own centre column
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
        logoAspect: LOGO_ASPECT,
      });
      const px = splashHandleBox(g, h).fontPx;
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

describe("drawSplashHandle: the routine the launch image draws its line with", () => {
  const g = splashLayout({ screenW: 390, screenH: 844, dpr: 3, logoAspect: LOGO_ASPECT });

  it("is what paintSplash uses: the launch image makes no calls of its own", () => {
    const whole = recordingCtx();
    paintSplash(whole.ctx, {} as CanvasImageSource, g);
    const ref = recordingCtx();
    drawSplashHandle(
      ref.ctx,
      SPLASH_HANDLE,
      splashHandleBox(g).fontPx,
      g.screenW / g.canvasW,
      g.screenH / g.canvasH,
      g.handleCenterX,
      g.handleCenterY,
    );
    // everything after the white fill and the logo is exactly this routine
    expect(whole.calls.slice(2)).toEqual(ref.calls);
    expect(whole.fontAtText()).toBe(ref.fontAtText());
    expect(whole.fillAtText()).toBe(ref.fillAtText());
  });

  it("sets the font through the ladder, and puts its transform back", () => {
    const r = recordingCtx((v) => v.includes("-apple-system"));
    drawSplashHandle(r.ctx, "@x", 13, 1 / 3, 1 / 3, 30, 40);
    expect(r.fontAtText()).toBe("13px system-ui"); // the rung below the refused one
    expect(r.ctx.textAlign).toBe("center");
    expect(r.ctx.textBaseline).toBe("middle");
    expect(r.fillAtText()).toBe(SPLASH_HANDLE_COLOR);
    expect(r.openTransforms()).toBe(0);
    expect(r.textAtDevice()).toEqual([30, 40]);
  });
});
