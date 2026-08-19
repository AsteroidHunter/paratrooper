// The photo-zoom flight: unit tests for the pure math (zoom.ts) and source
// pins for the DOM wiring (main.ts openLightbox), which lives in the layer
// that boots a real shell at import time and cannot load under node — the
// same split flight.test.ts uses. What the pins hold: the copy launches from
// the tapped photo's measured rect, dismissal re-reads the photo's rect at
// that moment (never the open-time memory), the off-screen and gone-row
// fallbacks exist, the thread photo hides under the copy and is handed back
// byte-clean, and both legs leave rect-delta records on the flight channel.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ZOOM_EDGE_SCALE,
  ZOOM_FADE_SCALE,
  ZOOM_MAX_VH,
  ZOOM_MAX_VW,
  zoomFit,
  zoomReturn,
} from "../src/zoom";

describe("zoomFit — the fitted centered box the grid layout will take over", () => {
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

  it("both legs leave rect-delta records on the flight channel", () => {
    expect(body).toContain('phase: "zoom-open"');
    expect(body).toContain('phase: "zoom-close"');
    expect(body).toContain("mode: ret.mode");
    const open = body.indexOf('phase: "zoom-open"');
    const close = body.indexOf('phase: "zoom-close"');
    expect(body.slice(open, close)).toMatch(/dx:.*dy:.*dw:.*dh:/s);
    expect(body.slice(close)).toMatch(/dx:.*dy:.*dw:.*dh:/s);
  });

  it("every photo tap hands the tapped element to the zoom", () => {
    const calls = src.match(/openLightbox\((?:img\.src|value), img\)/g) ?? [];
    expect(calls.length).toBe(4); // user photos, screenshots, optimistic sends, restored outbox
    expect(src).not.toMatch(/openLightbox\((?:img\.src|value)\)/);
  });
});
