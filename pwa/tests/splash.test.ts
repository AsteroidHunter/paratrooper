// Pins for the iOS launch-image generator (src/splash.ts) and for the in-app
// copy's lift rule. The geometry and the drawing are pure, so every device is
// encoded as plain inputs: canvas size, centered logo rect, and the
// device-matching media query come out as data, and the paint step is checked
// against a recording 2D-context stand-in; the lift rule is pure too and runs
// entirely on fake timers. No real DOM and no real canvas needed, so this runs
// in the same node env as the other suites: the one case that has to watch the
// cover actually mount drives it against a recording element stand-in, the same
// way the paint step is driven against a recording context.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COVER_CAP_MS,
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
import { SPLASH_LOGO_H, SPLASH_LOGO_INLINE, SPLASH_LOGO_W } from "../src/splashlogo";

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

describe("the inlined logo art (src/splashlogo.ts)", () => {
  it("is a data URI, so there is nothing for the cover to go and fetch", () => {
    expect(SPLASH_LOGO_INLINE.startsWith("data:image/webp;base64,")).toBe(true);
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
    // the whole point of a small inline copy: a full-res raster as base64 would
    // trade the flash for a heavier bundle, which is the worse bug. The bundle
    // this lands in is tens of kB, so a few kB is the ceiling.
    expect(SPLASH_LOGO_INLINE.length).toBeLessThan(8 * 1024);
  });
});

describe("installSplashCover: both marks are in the cover the frame it appears", () => {
  // A recording stand-in for the handful of DOM calls the mount makes, in the
  // spirit of the recording 2D context above: enough surface to be driven, and
  // it remembers WHEN each child arrived, which is the whole question here.
  interface FakeEl {
    tag: string;
    id: string;
    alt: string;
    src: string;
    decoding: string;
    textContent: string;
    style: Record<string, string>;
    children: FakeEl[];
    appendChild(c: FakeEl): void;
    remove(): void;
  }

  function fakeEl(tag: string): FakeEl {
    const el: FakeEl = {
      tag,
      id: "",
      alt: "",
      src: "",
      decoding: "",
      textContent: "",
      style: { cssText: "" },
      children: [],
      appendChild(c) {
        el.children.push(c);
      },
      remove() {},
    };
    return el;
  }

  // every Image the module constructs is a thing the cover would have to wait
  // for; the mount must construct none
  class RecordingImage {
    static made = 0;
    onload: (() => void) | null = null;
    naturalWidth = 0;
    naturalHeight = 0;
    src = "";
    constructor() {
      RecordingImage.made += 1;
    }
  }

  // the cover's children AT THE MOMENT it entered the document: an empty cover
  // here is a frame the user sees as bare white
  let attachedWith: number | null = null;
  let created: FakeEl[] = [];

  async function mount(screenW = 390, screenH = 844, dpr = 3) {
    attachedWith = null;
    created = [];
    RecordingImage.made = 0;
    const body = fakeEl("body");
    body.appendChild = (c) => {
      attachedWith = c.children.length;
      body.children.push(c);
    };
    vi.stubGlobal("document", {
      body,
      createElement(tag: string) {
        const e = fakeEl(tag);
        created.push(e);
        return e;
      },
    });
    vi.stubGlobal("navigator", { standalone: true, userAgent: "iPhone" });
    vi.stubGlobal("screen", { width: screenW, height: screenH });
    vi.stubGlobal("window", { devicePixelRatio: dpr });
    vi.stubGlobal("Image", RecordingImage);
    vi.resetModules(); // the mount runs once per module load, so reload it per case
    const mod = await import("../src/splash");
    const cover = mod.installSplashCover("/splash-logo.png");
    return { cover, el: body.children[0] };
  }

  beforeEach(() => {
    vi.useFakeTimers(); // the lift timers start with the mount
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("enters the document already carrying its logo: no frame shows it empty", async () => {
    const { el } = await mount();
    expect(el.id).toBe("splashcover");
    // the cover was NEVER attached without BOTH of the things it shows
    expect(attachedWith).toBe(2);
    expect(el.children[0].tag).toBe("img");
    expect(el.children[1].tag).toBe("div");
  });

  it("that logo needs no fetch: it carries the inlined art itself", async () => {
    const { el } = await mount();
    expect(el.children[0].src).toBe(SPLASH_LOGO_INLINE);
    expect(el.children[0].src.startsWith("data:")).toBe(true);
  });

  it("the credit line is there at mount, as text in a font the device has", async () => {
    const { el } = await mount();
    const handle = el.children[1];
    expect(handle.textContent).toBe(SPLASH_HANDLE);
    expect(handle.src).toBe(""); // nothing to go and get, in the same frame
    expect(handle.style.cssText).toContain(SPLASH_FONT_FAMILY);
    expect(handle.style.cssText).toContain(`color:${SPLASH_HANDLE_COLOR}`);
  });

  it("nothing is left pending: no Image is constructed and no canvas is drawn", async () => {
    const { el } = await mount();
    expect(RecordingImage.made).toBe(0);
    expect(created.map((e) => e.tag)).not.toContain("canvas");
    // and the browser is told not to defer the decode either, so the frame
    // that carries the element carries the picture
    expect(el.children[0].decoding).toBe("sync");
  });

  it("puts the logo on the exact rect the phone's launch image put it", async () => {
    const { el } = await mount(390, 844, 3);
    const g = splashLayout({
      screenW: 390,
      screenH: 844,
      dpr: 3,
      logoAspect: SPLASH_LOGO_W / SPLASH_LOGO_H,
    });
    const r = coverLogoRect(g, 390, 844);
    const css = el.children[0].style.cssText;
    expect(css).toContain(`left:${r.left}px`);
    expect(css).toContain(`top:${r.top}px`);
    expect(css).toContain(`width:${r.width}px`);
    expect(css).toContain(`height:${r.height}px`);
  });

  it("puts the credit line on the exact row the launch image drew it on", async () => {
    // the canvas draws it at handleCenterY in device px; the cover has to land
    // the middle of its line box on that same row, converted
    for (const [w, h, dpr] of [
      [390, 844, 3],
      [375, 667, 2],
    ]) {
      const { el } = await mount(w, h, dpr);
      const g = splashLayout({
        screenW: w,
        screenH: h,
        dpr,
        logoAspect: SPLASH_LOGO_W / SPLASH_LOGO_H,
      });
      const b = coverHandleBox(g, h);
      const css = el.children[1].style.cssText;
      expect(css).toContain(`top:${b.top}px`);
      expect(css).toContain(`font:${b.fontPx}px/${b.height}px `);
      expect(css).toContain("left:0;right:0;text-align:center"); // the canvas's canvasW/2
      expect(b.top + b.height / 2).toBeCloseTo((g.handleCenterY * h) / g.canvasH, 9);
    }
  });

  it("still stands on the launch image's own white, and still lifts on the cap", async () => {
    const { cover, el } = await mount();
    expect(el.style.cssText).toContain(`background:${SPLASH_BG}`);
    expect(cover.lifted()).toBe(false);
    vi.advanceTimersByTime(COVER_CAP_MS);
    expect(cover.lifted()).toBe(true);
    expect(el.style.opacity).toBe("0"); // the fade is unchanged by the inlining
  });
});
