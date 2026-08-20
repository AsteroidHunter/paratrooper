// The sent photo's reserved seat: unit tests for the box math (photobox.ts) and
// source pins for the DOM wiring in send() (main.ts), which lives in the layer
// that boots a real shell at import time and cannot load under node, the same
// split flight.test.ts and zoom.test.ts use.
//
// What the math tests hold is the whole point of the change: the height
// reserved BEFORE the photo's pixels arrive is the height the photo actually
// renders at. .msg.shot img carries `height: auto`, so a decoded photo's height
// is its used width divided by its own aspect ratio; renderedHeight below is
// that rule, written out independently of photoBox. Reserve == render means the
// row cannot grow after the send pins the thread, which is what left a landing
// photo as a thin top sliver under the compose bar.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SHOT_MAX_WIDTH, photoBox } from "../src/photobox";

// what CSS `height: auto` gives a replaced element once its own size is known
function renderedHeight(natW: number, natH: number, usedW: number): number {
  return usedW * (natH / natW);
}

const ROW = 358; // a 390pt phone thread: 390 minus the .thread 1rem side padding

describe("photoBox: the seat reserved before the pixels land", () => {
  it("a tall portrait reserves the exact height it will render at", () => {
    const [natW, natH] = [1170, 2532]; // full-height phone screenshot
    const box = photoBox(natW, natH, ROW);
    expect(box.width).toBeCloseTo(ROW * SHOT_MAX_WIDTH, 10);
    expect(box.height).toBeCloseTo(renderedHeight(natW, natH, box.width), 10);
    expect(box.height).toBeGreaterThan(500); // a seat, not the sliver the bug left
  });

  it("a wide landscape reserves the exact height it will render at", () => {
    const [natW, natH] = [4032, 3024]; // 4:3 phone camera photo
    const box = photoBox(natW, natH, ROW);
    expect(box.width).toBeCloseTo(ROW * SHOT_MAX_WIDTH, 10);
    expect(box.height).toBeCloseTo(renderedHeight(natW, natH, box.width), 10);
    expect(box.height).toBeCloseTo((ROW * SHOT_MAX_WIDTH * 3) / 4, 10);
  });

  it("reserve equals render across shapes, orientations and row widths", () => {
    const shapes: [number, number][] = [
      [1170, 2532], [4032, 3024], [3024, 4032], [200, 3000], [3000, 200], [100, 120],
    ];
    for (const rowW of [320, 358, 430, 820]) {
      for (const [natW, natH] of shapes) {
        const box = photoBox(natW, natH, rowW);
        expect(box.height).toBeCloseTo(renderedHeight(natW, natH, box.width), 10);
      }
    }
  });

  it("caps at the bubble's 75% share of the row, ratio kept", () => {
    const box = photoBox(4000, 2000, ROW);
    expect(box.width).toBeCloseTo(268.5, 10);
    expect(box.height).toBeCloseTo(134.25, 10);
  });

  it("never upscales a photo smaller than the cap", () => {
    const box = photoBox(120, 90, ROW);
    expect(box.width).toBe(120);
    expect(box.height).toBe(90);
  });

  it("an unmeasurable row falls back to natural width, never a zero box", () => {
    const box = photoBox(1170, 2532, 0);
    expect(box.width).toBe(1170);
    expect(box.height).toBe(2532);
  });

  it("an unknown size reserves nothing at all (the caller's fallback branch)", () => {
    expect(photoBox(0, 0, ROW)).toEqual({ width: 0, height: 0 });
    expect(photoBox(Number.NaN, 100, ROW)).toEqual({ width: 0, height: 0 });
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

describe("photo send wiring: the seat is taken before the thread pins", () => {
  const send = fnBody("send");

  it("the file's own pixels are read before the row is built", () => {
    const read = send.indexOf("files.map(prepareShot)");
    const insert = send.indexOf('rowEl(w, "user", "shot"');
    expect(read).toBeGreaterThan(-1);
    expect(read).toBeLessThan(insert);
    expect(fnBody("prepareShot")).toContain("img.naturalWidth > 0 && img.naturalHeight > 0");
  });

  it("the read is awaited before anything measures, inserts, pins or flies", () => {
    const wait = send.indexOf("await Promise.all(shots)");
    expect(wait).toBeGreaterThan(-1);
    expect(wait).toBeLessThan(send.indexOf("beginSiblingShift()"));
    expect(wait).toBeLessThan(send.indexOf("localWrapper(\"user\")"));
    expect(wait).toBeLessThan(send.indexOf("scrollToBottom(true)"));
    expect(wait).toBeLessThan(send.indexOf("flyFromField(w, morph)"));
  });

  it("the box is written onto the row before the pin, from ratio and row width", () => {
    const reserve = send.indexOf("photoBox(shot.nat[0], shot.nat[1], rowW)");
    expect(reserve).toBeGreaterThan(-1);
    expect(reserve).toBeLessThan(send.indexOf("scrollToBottom(true)"));
    expect(send).toContain("img.width = shot.nat[0]"); // the ratio height:auto reads
    expect(send).toContain("img.height = shot.nat[1]");
    expect(send).toContain("img.style.width = `${box.width}px`"); // the bubble's share
    expect(send).toContain("threadContentWidth()");
  });

  it("a size that never arrives falls back to a re-pin on load", () => {
    const fallback = send.indexOf("img.onload");
    expect(fallback).toBeGreaterThan(-1);
    expect(send.slice(fallback)).toContain("if (followTail) scrollToBottom(true)");
    expect(fnBody("prepareShot")).toContain("SHOT_DIMS_MS"); // the read is deadlined
  });

  it("both outcomes ride the existing flight trail, no new channel", () => {
    expect(send).toContain('phase: "shot-reserve"');
    expect(fnBody("prepareShot")).toContain('phase: "shot-dims"');
    expect(src).not.toMatch(/holdDiagRecord\("shot/); // the flight channel, not a new one
  });
});
