// Pins for the iOS launch-image generator (src/splash.ts). The geometry and the
// drawing are pure, so every device is encoded as plain inputs — canvas size,
// centered logo rect, and the device-matching media query come out as data, and
// the paint step is checked against a recording 2D-context stand-in. No DOM and
// no real canvas needed, so this runs in the same node env as the other suites.
import { describe, expect, it } from "vitest";
import {
  SPLASH_LOGO_FRACTION,
  type DrawTarget,
  type SplashLayout,
  paintSplash,
  splashLayout,
} from "../src/splash";

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

describe("paintSplash — white first, then the logo at its rect", () => {
  function recordingCtx() {
    const calls: Array<[string, ...unknown[]]> = [];
    let fillAtRect: DrawTarget["fillStyle"] | null = null;
    let fill: DrawTarget["fillStyle"] = "";
    const ctx: DrawTarget = {
      get fillStyle() {
        return fill;
      },
      set fillStyle(v) {
        fill = v;
      },
      fillRect(x, y, w, h) {
        fillAtRect = fill; // capture the color in force at fill time
        calls.push(["fillRect", x, y, w, h]);
      },
      drawImage(_img, x, y, w, h) {
        calls.push(["drawImage", x, y, w, h]);
      },
    };
    return { ctx, calls, fillAt: () => fillAtRect };
  }

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
    expect(r.fillAt()).toBe("#ffffff");
    expect(r.calls[0]).toEqual(["fillRect", 0, 0, g.canvasW, g.canvasH]);
  });

  it("draws the logo at the centered rect, after the fill", () => {
    const r = recordingCtx();
    const logo = {} as CanvasImageSource;
    paintSplash(r.ctx, logo, g);
    expect(r.calls[1]).toEqual(["drawImage", g.logoX, g.logoY, g.logoW, g.logoH]);
  });
});
