// The photo-zoom flight: unit tests for the pure math (zoom.ts) and source
// pins for the DOM wiring (main.ts openLightbox), which lives in the layer
// that boots a real shell at import time and cannot load under node — the
// same split flight.test.ts uses. What the pins hold: the copy launches from
// the tapped photo's measured rect, dismissal re-reads the photo's rect at
// that moment (never the open-time memory), the off-screen and gone-row
// fallbacks exist, the thread photo hides under the copy and is handed back
// byte-clean, the airborne copy is cut by the thread's box exactly as the real
// photo is and its cut opens only as far as the resting frame genuinely needs
// (never to the whole screen, which is what let a band of photo sit on both bars
// for most of the way back), the landed box STANDS as the one source of the
// resting size (with a resize re-running that same source), and both legs leave
// rect-delta records on the flight channel.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FLIGHT_MS, flightEase, morphBox } from "../src/shift";
import type { MorphBox } from "../src/shift";
import {
  ZOOM_EDGE_SCALE,
  ZOOM_FADE_SCALE,
  ZOOM_MAX_VH,
  ZOOM_MAX_VW,
  zoomClipCuts,
  zoomClipInset,
  zoomClipRest,
  zoomFit,
  zoomReturn,
} from "../src/zoom";

describe("zoomFit: the fitted centered box the copy lands on and keeps", () => {
  it("fits a wide photo to 96vw and centers both axes", () => {
    const b = zoomFit(1280, 960, 390, 844);
    expect(b.width).toBeCloseTo(390 * ZOOM_MAX_VW, 5);
    expect(b.height).toBeCloseTo((390 * ZOOM_MAX_VW * 960) / 1280, 5);
    expect(b.left).toBeCloseTo((390 - b.width) / 2, 5);
    expect(b.top).toBeCloseTo((844 - b.height) / 2, 5);
  });

  it("a tall capture binds on 92vh instead", () => {
    const b = zoomFit(400, 4000, 390, 844);
    expect(b.height).toBeCloseTo(844 * ZOOM_MAX_VH, 5);
    expect(b.width).toBeCloseTo((844 * ZOOM_MAX_VH * 400) / 4000, 5);
  });

  it("never upscales past natural size (max-* only constrains)", () => {
    const b = zoomFit(100, 80, 1000, 1000);
    expect(b.width).toBe(100);
    expect(b.height).toBe(80);
    expect(b.left).toBe(450);
    expect(b.top).toBe(460);
  });
});

// --- one source for the resting size ------------------------------------------
// The resting zoom used to be decided TWICE: this fit, off the innerWidth and
// innerHeight main.ts hands in, and the css max-width 96vw / max-height 92vh the
// copy fell back to when the landing frame dropped its inline style. Two
// measurements of one screen, and on this phone they part on the height:
// innerHeight shrinks with the keyboard in two of iOS 26's three modes and can
// stay stuck short after it (shell.ts), while vh keeps reporting the full
// screen. These pin WHY only portrait showed it, and that one source now
// answers every viewport the photo can be resting in.
describe("the resting size, when the two measurements disagree", () => {
  const VIEW_W = 390; // the width halves agree, so this is shared
  const INNER_H = 508; // what the flight reads with the keyboard up
  const CSS_H = 844; // what 100vh keeps reporting through the same moment

  it("a portrait photo flips to the height term, so the two part", () => {
    const flown = zoomFit(960, 1280, VIEW_W, INNER_H);
    const cssRefit = zoomFit(960, 1280, VIEW_W, CSS_H);
    expect(flown.height).toBeCloseTo(1280 * ((INNER_H * ZOOM_MAX_VH) / 1280), 5);
    expect(cssRefit.width).toBeCloseTo(VIEW_W * ZOOM_MAX_VW, 5); // still width-bound
    expect(cssRefit.height).toBeGreaterThan(flown.height); // the resize on the landing frame
    expect(cssRefit.height / flown.height).toBeCloseTo(1.068, 3);
  });

  it("a landscape photo stays width-bound in both, so it never resized", () => {
    const flown = zoomFit(1280, 960, VIEW_W, INNER_H);
    const cssRefit = zoomFit(1280, 960, VIEW_W, CSS_H);
    expect(flown.width).toBeCloseTo(cssRefit.width, 5);
    expect(flown.height).toBeCloseTo(cssRefit.height, 5);
    // the centering still parts, which is the same one-source argument for the
    // axis the owner did not happen to notice
    expect(flown.top).not.toBeCloseTo(cssRefit.top, 1);
  });

  it("a 9:16 capture parts on a far milder shortfall than the keyboard's", () => {
    const flown = zoomFit(720, 1280, VIEW_W, 700);
    const cssRefit = zoomFit(720, 1280, VIEW_W, CSS_H);
    expect(cssRefit.height).toBeGreaterThan(flown.height);
    expect(zoomFit(720, 1280, VIEW_W, 740).height).toBeCloseTo(cssRefit.height, 5); // above it, agree
  });

  it("one source re-run on the rotated screen is the rotated fit, centered", () => {
    const b = zoomFit(960, 1280, CSS_H, VIEW_W); // the same photo, phone turned
    expect(b.height).toBeCloseTo(VIEW_W * ZOOM_MAX_VH, 5); // now the height binds
    expect(b.width).toBeCloseTo((VIEW_W * ZOOM_MAX_VH * 960) / 1280, 5);
    expect(b.left).toBeCloseTo((CSS_H - b.width) / 2, 5);
    expect(b.top).toBeCloseTo((VIEW_W - b.height) / 2, 5);
  });

  it("the fit is a pure function of the viewport it is given, every time", () => {
    for (const [w, h] of [[390, 844], [390, 508], [844, 390], [430, 932]]) {
      const a = zoomFit(960, 1280, w, h);
      expect(zoomFit(960, 1280, w, h)).toEqual(a); // no memory, so a re-run cannot drift
      expect(a.width).toBeLessThanOrEqual(w * ZOOM_MAX_VW + 1e-9);
      expect(a.height).toBeLessThanOrEqual(h * ZOOM_MAX_VH + 1e-9);
    }
  });
});

describe("zoomReturn — where the close leg lands", () => {
  const cur = { left: 20, top: 280, width: 350, height: 280 };

  it("a spot even partly on screen gets the exact flight back onto it", () => {
    const origin = { left: 30, top: -100, width: 300, height: 200 }; // bottom edge still visible
    expect(zoomReturn(origin, cur, 390, 844)).toEqual({ mode: "exact", box: origin });
  });

  it("a spot scrolled above shrinks toward the top edge, straddling it", () => {
    const origin = { left: 30, top: -700, width: 300, height: 200 };
    const r = zoomReturn(origin, cur, 390, 844);
    expect(r.mode).toBe("edge");
    expect(r.box.width).toBeCloseTo(cur.width * ZOOM_EDGE_SCALE, 5);
    expect(r.box.top + r.box.height / 2).toBeCloseTo(0, 5); // centered ON the edge: half out
    expect(r.box.left + r.box.width / 2).toBeCloseTo(180, 5); // the spot's own horizontal line
  });

  it("a spot scrolled below exits across the bottom edge", () => {
    const origin = { left: 30, top: 900, width: 300, height: 200 };
    const r = zoomReturn(origin, cur, 390, 844);
    expect(r.mode).toBe("edge");
    expect(r.box.top + r.box.height / 2).toBeCloseTo(844, 5);
  });

  it("the exit's horizontal line clamps onto the screen", () => {
    const origin = { left: -290, top: -700, width: 300, height: 200 }; // center x = -140
    const r = zoomReturn(origin, cur, 390, 844);
    expect(r.box.left).toBeCloseTo(0, 5); // clamped: fully visible horizontally
  });

  it("a vanished row (retract while zoomed) dissolves in place", () => {
    const r = zoomReturn(null, cur, 390, 844);
    expect(r.mode).toBe("fade");
    expect(r.box.width).toBeCloseTo(cur.width * ZOOM_FADE_SCALE, 5);
    expect(r.box.left + r.box.width / 2).toBeCloseTo(cur.left + cur.width / 2, 5);
    expect(r.box.top + r.box.height / 2).toBeCloseTo(cur.top + cur.height / 2, 5);
  });
});

// --- the cut that keeps the copy off the bars ---------------------------------
// A 390x844 phone: the top bar ends at 103, the compose bar starts at 745, and
// the thread is the box between them — exactly what cuts a photo sitting partly
// behind either bar.
describe("zoomClipInset — the airborne copy is cut where the real photo is", () => {
  const thread = { left: 0, top: 103, width: 390, height: 642 };
  const screen = { left: 0, top: 0, width: 390, height: 844 };

  it("cuts a photo running up under the top bar by exactly the hidden part", () => {
    const photo = { left: 20, top: 60, width: 280, height: 210 }; // 43px behind the bar
    const i = zoomClipInset(photo, thread);
    expect(i.top).toBeCloseTo(43, 5);
    expect(i.bottom).toBe(0);
    expect(i.left).toBe(0);
    expect(i.right).toBe(0);
    expect(zoomClipCuts(i)).toBe(true);
  });

  it("cuts a photo running down under the compose bar the same way", () => {
    const photo = { left: 20, top: 640, width: 280, height: 210 }; // ends 105 past the thread
    const i = zoomClipInset(photo, thread);
    expect(i.bottom).toBeCloseTo(105, 5);
    expect(i.top).toBe(0);
  });

  it("a photo wholly inside the thread is not cut at all", () => {
    const i = zoomClipInset({ left: 20, top: 300, width: 280, height: 210 }, thread);
    expect(i).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(zoomClipCuts(i)).toBe(false);
  });

  it("edges never go negative: past the box is the same picture as no cut", () => {
    const i = zoomClipInset({ left: 20, top: 300, width: 280, height: 210 }, screen);
    expect(i).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it("the resting zoom is uncut, so the open photo still covers both bars", () => {
    const fit = zoomFit(1280, 960, 390, 844);
    expect(zoomClipCuts(zoomClipInset(fit, screen))).toBe(false);
  });
});

describe("the cut over a whole flight (same beat and ease as the box)", () => {
  const thread = { left: 0, top: 103, width: 390, height: 642 };
  const screen = { left: 0, top: 0, width: 390, height: 844 };
  const photo = { left: 20, top: 60, width: 280, height: 210 }; // 43px behind the top bar
  const fit = zoomFit(1280, 960, 390, 844);
  const frame = (a: typeof photo, b: typeof photo, cA: typeof thread, cB: typeof thread, f: number) => {
    const p = flightEase(f);
    const box = morphBox(a, b, p);
    return { box, inset: zoomClipInset(box, morphBox(cA, cB, p)) };
  };

  it("the launch frame is cut exactly as the photo behind the bar is", () => {
    const first = frame(photo, fit, thread, screen, 0);
    expect(first.box).toEqual(photo);
    expect(first.inset.top).toBeCloseTo(43, 5);
  });

  it("the open landing is the fitted box, uncut, covering both bars", () => {
    const last = frame(photo, fit, thread, screen, 1);
    expect(last.box.left).toBeCloseTo(fit.left, 2);
    expect(last.box.top).toBeCloseTo(fit.top, 2);
    expect(last.box.width).toBeCloseTo(fit.width, 2);
    expect(last.box.height).toBeCloseTo(fit.height, 2);
    expect(zoomClipCuts(last.inset)).toBe(false);
  });

  it("the cut only ever shrinks on the way out: no frame gains bar", () => {
    let prev = Infinity;
    for (let f = 0; f <= 1.0001; f += 0.05) {
      const top = frame(photo, fit, thread, screen, Math.min(f, 1)).inset.top;
      expect(top).toBeLessThanOrEqual(prev + 1e-9);
      prev = top;
    }
    expect(prev).toBe(0);
  });

  it("the close landing is the photo's rect, cut exactly as the photo is", () => {
    const ret = zoomReturn(photo, fit, 390, 844);
    expect(ret.mode).toBe("exact");
    const last = frame(fit, ret.box, zoomClipRest(thread, fit), thread, 1);
    expect(last.box.left).toBeCloseTo(photo.left, 2);
    expect(last.box.top).toBeCloseTo(photo.top, 2);
    expect(last.box.width).toBeCloseTo(photo.width, 2);
    expect(last.box.height).toBeCloseTo(photo.height, 2);
    expect(last.inset.top).toBeCloseTo(43, 5); // the handover moves no pixel
  });
});

// --- the cut's open end: the tightest rect the resting frame needs -------------
// The band of photo the close used to paint across both bars came from ONE
// over-general endpoint: the cut started at the whole screen, on the true but
// far too generous reasoning that a resting zoom may cover both bars. Riding
// the flight's own hard ease-out alongside the box, that cut only arrived at
// the thread's box on the last frame, while the copy's own edge crossed the
// bar's edge far earlier — and everything between the two painted on the bar.
// The replacement is the union of the thread's box and the resting box: the
// smallest rect that still cannot cut the frame at rest.
describe("zoomClipRest — the cut opens only as far as the resting frame needs", () => {
  const thread = { left: 0, top: 103, width: 390, height: 642 };

  it("a resting fit that lands inside the thread IS the thread's own box", () => {
    const fit = zoomFit(1280, 960, 390, 844); // 374x281, well clear of both bars
    expect(fit.top).toBeGreaterThan(thread.top);
    expect(fit.top + fit.height).toBeLessThan(thread.top + thread.height);
    expect(zoomClipRest(thread, fit)).toEqual(thread); // so the cut never opens at all
  });

  it("a tall capture reaches past the bars by exactly its own overhang, no further", () => {
    const fit = zoomFit(400, 4000, 390, 844); // binds on 92vh: over both bars
    const r = zoomClipRest(thread, fit);
    expect(fit.top).toBeLessThan(thread.top); // genuinely on the top bar at rest
    expect(fit.top + fit.height).toBeGreaterThan(thread.top + thread.height);
    expect(r.top).toBeCloseTo(fit.top, 5);
    expect(r.top + r.height).toBeCloseTo(fit.top + fit.height, 5);
    expect(r.top).toBeGreaterThan(0); // and still short of the whole screen
  });

  it("the thread spans the width, so the sides stay the thread's own", () => {
    const fit = zoomFit(1280, 960, 390, 844);
    const r = zoomClipRest(thread, fit);
    expect(r.left).toBe(thread.left);
    expect(r.width).toBe(thread.width);
  });

  it("cuts nothing at rest, whatever the photo's shape", () => {
    for (const [w, h] of [[1280, 960], [400, 4000], [960, 1280], [100, 80]]) {
      const fit = zoomFit(w, h, 390, 844);
      expect(zoomClipCuts(zoomClipInset(fit, zoomClipRest(thread, fit)))).toBe(false);
    }
  });
});

// --- the close leg, frame by frame --------------------------------------------
// The defect lived in the frames, not in the landing: the last frame was always
// right. So these sample the whole 400ms and lean on the early ones, where the
// ease has already carried the copy most of the way home while a cut starting
// at the whole screen has barely left it.
describe("the way back paints no photo on either bar, from the first frame on", () => {
  const thread = { left: 0, top: 103, width: 390, height: 642 };
  const screen = { left: 0, top: 0, width: 390, height: 844 };
  const fit = zoomFit(1280, 960, 390, 844); // the resting zoom, inside the thread
  const under = { left: 20, top: 640, width: 280, height: 210 }; // 105px under the compose bar
  const behind = { left: 20, top: 60, width: 280, height: 210 }; // 43px behind the top bar

  // one close frame exactly as main.ts draws it: the box and the cut share the
  // flight's beat and ease, so they are read at the same p
  const frame = (spot: MorphBox, clipFrom: MorphBox, ms: number) => {
    const p = flightEase(ms / FLIGHT_MS);
    return { box: morphBox(fit, spot, p), clip: morphBox(clipFrom, thread, p) };
  };
  // how much photo a frame paints ON a bar: the part of the copy past the
  // thread's edge that the cut still lets through
  type Frame = ReturnType<typeof frame>;
  const onTopBar = (fr: Frame): number =>
    Math.max(0, thread.top - Math.max(fr.box.top, fr.clip.top));
  const onComposeBar = (fr: Frame): number =>
    Math.max(0, Math.min(fr.box.top + fr.box.height, fr.clip.top + fr.clip.height)
      - (thread.top + thread.height));

  // the first 40ms carry the copy 40% of the way home; the rest of the flight
  // is the long creep the ease-out spends arriving
  const MS = [0, 4, 8, 12, 16, 24, 40, 60, 100, 160, 240, 320, 400];

  it("the cut is the thread's box on every frame, not only the last", () => {
    const clipFrom = zoomClipRest(thread, fit);
    for (const spot of [behind, under]) {
      for (const ms of MS) {
        const { clip } = frame(spot, clipFrom, ms);
        expect(clip.top).toBeGreaterThanOrEqual(thread.top - 1e-9);
        expect(clip.top + clip.height)
          .toBeLessThanOrEqual(thread.top + thread.height + 1e-9);
      }
    }
  });

  it("no frame lets photo through onto the top bar or the compose bar", () => {
    const clipFrom = zoomClipRest(thread, fit);
    for (const spot of [behind, under]) {
      for (const ms of MS) {
        const fr = frame(spot, clipFrom, ms);
        expect(onTopBar(fr)).toBe(0);
        expect(onComposeBar(fr)).toBe(0);
      }
    }
  });

  it("the landed frame is still cut exactly like the photo it hands back to", () => {
    const clipFrom = zoomClipRest(thread, fit);
    const top = frame(behind, clipFrom, FLIGHT_MS);
    expect(zoomClipInset(top.box, top.clip).top).toBeCloseTo(43, 5);
    const bottom = frame(under, clipFrom, FLIGHT_MS);
    expect(zoomClipInset(bottom.box, bottom.clip).bottom).toBeCloseTo(105, 5);
  });

  // What the fix removed, kept as the reason it exists: the same frames with the
  // old whole-screen start show a band on both bars for most of the way back.
  // How early it opens is set by how deep the spot sits behind the bar — these
  // two are the file's shallow fixtures, and a spot running off the screen's
  // bottom opens it sooner still.
  it("the whole-screen start is what let the band through, for most of the flight", () => {
    let topBand = 0;
    let bottomBand = 0;
    let topOpens = FLIGHT_MS;
    let bottomOpens = FLIGHT_MS;
    for (let ms = 0; ms <= FLIGHT_MS; ms++) {
      const onTop = onTopBar(frame(behind, screen, ms));
      const onCompose = onComposeBar(frame(under, screen, ms));
      if (onTop > 0) topOpens = Math.min(topOpens, ms);
      if (onCompose > 0) bottomOpens = Math.min(bottomOpens, ms);
      topBand = Math.max(topBand, onTop);
      bottomBand = Math.max(bottomBand, onCompose);
    }
    expect(topBand).toBeGreaterThan(10); // 13.6px of photo sitting on the top bar
    expect(bottomBand).toBeGreaterThan(25); // 26.6px of it on the compose bar
    // and once open it never shuts until the landing frame
    expect(FLIGHT_MS - topOpens).toBeGreaterThan(250);
    expect(FLIGHT_MS - bottomOpens).toBeGreaterThan(300);
  });
});

describe("a tall capture whose resting fit genuinely covers both bars", () => {
  const thread = { left: 0, top: 103, width: 390, height: 642 };
  const fit = zoomFit(400, 4000, 390, 844); // 92vh: past the top bar and the compose bar
  const spot = { left: 150, top: 400, width: 90, height: 900 }; // its row, mostly below the fold
  const clipFrom = zoomClipRest(thread, fit);
  const clipAt = (ms: number): MorphBox => morphBox(clipFrom, thread, flightEase(ms / FLIGHT_MS));
  const MS = [0, 4, 8, 12, 16, 24, 40, 60, 100, 160, 240, 320, 400];

  it("the cut starts on the resting overhang, so the launch frame is uncut", () => {
    expect(zoomClipCuts(zoomClipInset(fit, clipFrom))).toBe(false);
  });

  it("the cut only shrinks: no frame gives back bar the frame before it had taken", () => {
    let prevTop = -Infinity;
    let prevBottom = Infinity;
    for (const ms of MS) {
      const clip = clipAt(ms);
      expect(clip.top).toBeGreaterThanOrEqual(prevTop - 1e-9); // the top edge only descends
      expect(clip.top + clip.height).toBeLessThanOrEqual(prevBottom + 1e-9); // the bottom only rises
      prevTop = clip.top;
      prevBottom = clip.top + clip.height;
    }
    const last = clipAt(FLIGHT_MS);
    expect(last.top).toBeCloseTo(thread.top, 5); // and it ends on the thread's own box
    expect(last.top + last.height).toBeCloseTo(thread.top + thread.height, 5);
  });

  it("no frame shows more bar than the resting frame already did", () => {
    const restingOnTopBar = thread.top - fit.top;
    const restingOnComposeBar = fit.top + fit.height - (thread.top + thread.height);
    expect(restingOnTopBar).toBeGreaterThan(0); // the shape this test exists for
    for (const ms of MS) {
      const p = flightEase(ms / FLIGHT_MS);
      const box = morphBox(fit, spot, p);
      const clip = clipAt(ms);
      const onTop = Math.max(0, thread.top - Math.max(box.top, clip.top));
      const onCompose = Math.max(0, Math.min(box.top + box.height, clip.top + clip.height)
        - (thread.top + thread.height));
      expect(onTop).toBeLessThanOrEqual(restingOnTopBar + 1e-9);
      expect(onCompose).toBeLessThanOrEqual(restingOnComposeBar + 1e-9);
    }
  });
});

describe("the open leg still lands on a cut that takes nothing off the resting photo", () => {
  const thread = { left: 0, top: 103, width: 390, height: 642 };
  const photo = { left: 20, top: 60, width: 280, height: 210 };

  it("every shape ends uncut, so no resting zoom is newly cropped", () => {
    for (const [w, h] of [[1280, 960], [400, 4000], [960, 1280], [100, 80], [720, 1280]]) {
      const fit = zoomFit(w, h, 390, 844);
      const landed = morphBox(thread, zoomClipRest(thread, fit), flightEase(1));
      expect(zoomClipCuts(zoomClipInset(fit, landed))).toBe(false);
    }
  });

  it("the launch frame is still cut exactly as the photo behind the bar is", () => {
    const fit = zoomFit(1280, 960, 390, 844);
    const first = morphBox(thread, zoomClipRest(thread, fit), flightEase(0));
    expect(zoomClipInset(photo, first).top).toBeCloseTo(43, 5);
  });

  // the resting cut is re-measured out of the same helper when the viewport
  // moves under a resting copy, so a rotation cannot leave the landed frame
  // cropped by a cut measured for the screen it used to be on
  it("a rotation re-measures the cut with the box, and it still cuts nothing", () => {
    const turned = { left: 0, top: 60, width: 844, height: 270 }; // the thread, phone turned
    const fit = zoomFit(960, 1280, 844, 390); // the same photo on the rotated screen
    expect(fit.top).toBeLessThan(turned.top); // now tall enough to cover both bars
    expect(zoomClipCuts(zoomClipInset(fit, zoomClipRest(turned, fit)))).toBe(false);
  });
});

// --- source pins on the main.ts wiring ----------------------------------------

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/main.ts"),
  "utf8",
);

function fnBody(name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("\n}", start);
  return src.slice(start, end);
}

describe("photo zoom wiring (openLightbox)", () => {
  const body = fnBody("openLightbox");

  it("opens from the tapped photo's measured rect on the shared beat and ease", () => {
    const measure = body.indexOf("from.getBoundingClientRect()");
    const launch = body.indexOf("fly(fromBox, to");
    expect(measure).toBeGreaterThan(-1);
    expect(measure).toBeLessThan(launch);
    expect(body).toContain("zoomFit(from.naturalWidth, from.naturalHeight");
    expect(body).toContain("FLIGHT_MS");
    expect(body).toContain("flightEase(");
    expect(body).toContain("morphBox(");
    expect(body).toContain("morphCorners(");
    expect(body).not.toContain("scale("); // shape flies as box geometry, never transform
  });

  it("dismissal re-reads the photo's rect inside the close handler", () => {
    const close = body.indexOf('overlay.addEventListener("click"');
    const reRead = body.indexOf("from.isConnected ? boxOf(from.getBoundingClientRect()) : null");
    expect(close).toBeGreaterThan(-1);
    expect(reRead).toBeGreaterThan(close);
  });

  it("the close leg lands where zoomReturn decides, fading the no-spot modes", () => {
    expect(body).toContain("zoomReturn(origin, cur");
    expect(body).toContain('ret.mode !== "exact"');
    expect(body).toMatch(/mode !== "exact"\) img\.style\.opacity/);
  });

  it("the thread photo hides under the copy and is handed back byte-clean", () => {
    const hide = body.indexOf('from.style.opacity = "0"');
    const reveal = body.indexOf('from.style.removeProperty("opacity")');
    expect(hide).toBeGreaterThan(-1);
    expect(reveal).toBeGreaterThan(hide);
    expect(body).toContain('if (!from.getAttribute("style")) from.removeAttribute("style")');
  });

  it("the reveal and the overlay teardown share one task (no doubled frame)", () => {
    const reveal = body.indexOf('from.style.removeProperty("opacity")');
    const gone = body.indexOf("overlay.remove()", reveal);
    expect(gone).toBeGreaterThan(reveal);
  });

  it("the landed frame paints before the settle swap (the morph's guard)", () => {
    expect(body).toContain("requestAnimationFrame(settle)");
  });

  it("the copy is cut by the thread's own box, the photo's own cutter", () => {
    expect(body).toContain('from.closest(".thread")');
    expect(body).toContain("clipper.getBoundingClientRect()");
    expect(body).toContain("zoomClipInset(");
    expect(body).toMatch(/img\.style\.clipPath = `inset\(/);
  });

  it("the launch frame carries its cut: freeze writes it before the first frame", () => {
    expect(body).toMatch(/const freeze = \(b: MorphBox, radius: number, clip: MorphBox\)/);
    expect(body).toMatch(/writeClip\(b, clip\);/);
    const freeze = body.indexOf("freeze(fromBox, fromRadius, openFrom)");
    const launch = body.indexOf("fly(fromBox, to");
    expect(freeze).toBeGreaterThan(-1);
    expect(freeze).toBeLessThan(launch);
  });

  it("the cut rides the flight's own beat and ease, frame by frame", () => {
    expect(body).toMatch(/writeClip\(box, morphBox\(cA, cB, p\)\)/);
  });

  it("the open leg starts on the thread's box and opens no further than rest", () => {
    expect(body).toContain(
      "fly(fromBox, to, fromRadius, restRadius, openFrom, zoomClipRest(openFrom, to)",
    );
    expect(body).not.toContain("restRadius, openFrom, screenBox()"); // the too-generous end, gone
  });

  it("the close leg lands back on the thread's box only when a photo is there", () => {
    expect(body).toContain('const clipTo = ret.mode === "exact" ? threadBox() : screenBox();');
    expect(body).toContain("fly(cur, ret.box, curRadius, endRadius, clipFrom, clipTo");
  });

  it("the close starts its cut at the tightest rect, not at the whole screen", () => {
    expect(body).toContain(
      'const clipFrom = ret.mode === "exact" ? zoomClipRest(threadBox(), cur) : screenBox();',
    );
    expect(body).toContain("freeze(cur, curRadius, clipFrom);");
    // like the spot it flies to, the cut is decided at dismissal from what is on
    // screen now — there is no remembered cut left to turn stale
    expect(body).not.toContain("clipNow");
  });

  it("only the copy is ever cut: the backdrop still covers both bars", () => {
    expect(body).not.toContain("back.style.clipPath");
    expect(body).not.toContain("overlay.style.clipPath");
  });

  it("both legs leave rect-delta records on the flight channel", () => {
    expect(body).toContain('phase: "zoom-open"');
    expect(body).toContain('phase: "zoom-close"');
    expect(body).toContain("mode: ret.mode");
    const open = body.indexOf('phase: "zoom-open"');
    const close = body.indexOf('phase: "zoom-close"');
    expect(body.slice(open, close)).toMatch(/dx:.*dy:.*dw:.*dh:/s);
    expect(body.slice(close)).toMatch(/dx:.*dy:.*dw:.*dh:/s);
  });

  it("the landed box stands: the resting size is never handed to the css rule", () => {
    expect(body).toContain("const restBox = ()");
    expect(body).toContain("const to = restBox();");
    expect(body).not.toContain('img.removeAttribute("style")'); // the second source, gone
    expect(body).toContain('back.removeAttribute("style")'); // the backdrop still hands back
  });

  it("a resize while the photo is open re-runs that same one source", () => {
    expect(body).toMatch(/const refit = \(\): void => \{[\s\S]*?restBox\(\)/);
    const arm = body.indexOf('window.addEventListener("resize", refit)');
    const rest = body.indexOf("atRest = true;");
    expect(arm).toBeGreaterThan(-1);
    expect(rest).toBeGreaterThan(arm); // armed before the copy can ever be resting
    expect(body).toContain('window.removeEventListener("resize", refit)');
  });

  // the FIRST click listener is the undecoded copy's plain overlay; the real
  // dismissal is the last one
  const closeAt = body.lastIndexOf('overlay.addEventListener("click"');

  it("the refit re-aims a RESTING copy only: a flight owns its own frames", () => {
    expect(body).toContain("if (!atRest) return;");
    expect(body).toContain("let atRest = false;"); // the copy starts life not resting
    expect(body.slice(closeAt)).toContain("atRest = false;"); // the close takes it back
  });

  it("the resting cut is re-measured with the resting box, and cuts nothing", () => {
    expect(body).toMatch(/const refit[\s\S]*?writeClip\(b, zoomClipRest\(threadBox\(\), b\)\)/);
  });

  it("the close leg reads the landed box, never a second fit of the screen", () => {
    expect(closeAt).toBeGreaterThan(-1);
    const cur = body.indexOf("const cur = boxOf(img.getBoundingClientRect())");
    expect(cur).toBeGreaterThan(closeAt);
    expect(body.slice(closeAt)).not.toContain("zoomFit("); // only zoomReturn decides down there
  });

  it("the landing frame records BOTH resting sizes on the flight channel", () => {
    expect(body).toMatch(/phase: "zoom-rest",[\s\S]*?ih:[\s\S]*?vh:[\s\S]*?cssH:/);
    const settle = body.indexOf("atRest = true;");
    expect(settle).toBeGreaterThan(-1);
    expect(body.indexOf("restDiag(restBox())")).toBeGreaterThan(settle);
  });

  it("every photo tap hands the tapped element to the zoom", () => {
    const calls = src.match(/openLightbox\((?:img\.src|value), img\)/g) ?? [];
    expect(calls.length).toBe(4); // user photos, screenshots, optimistic sends, restored outbox
    expect(src).not.toMatch(/openLightbox\((?:img\.src|value)\)/);
  });
});
