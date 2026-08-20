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
  SPLASH_LOGO_FRACTION,
  type SplashLayout,
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

describe("installSplashCover: the logo is in the cover the frame the cover appears", () => {
  // A recording stand-in for the handful of DOM calls the mount makes, in the
  // spirit of the recording 2D context above: enough surface to be driven, and
  // it remembers WHEN each child arrived, which is the whole question here.
  interface FakeEl {
    tag: string;
    id: string;
    alt: string;
    src: string;
    decoding: string;
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
    expect(attachedWith).toBe(1); // the cover was NEVER attached without its logo
    expect(el.children[0].tag).toBe("img");
  });

  it("that logo needs no fetch: it carries the inlined art itself", async () => {
    const { el } = await mount();
    expect(el.children[0].src).toBe(SPLASH_LOGO_INLINE);
    expect(el.children[0].src.startsWith("data:")).toBe(true);
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

  it("still stands on the launch image's own white, and still lifts on the cap", async () => {
    const { cover, el } = await mount();
    expect(el.style.cssText).toContain(`background:${SPLASH_BG}`);
    expect(cover.lifted()).toBe(false);
    vi.advanceTimersByTime(COVER_CAP_MS);
    expect(cover.lifted()).toBe(true);
    expect(el.style.opacity).toBe("0"); // the fade is unchanged by the inlining
  });
});
