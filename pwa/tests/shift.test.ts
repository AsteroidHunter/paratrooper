// Pins for the send-flight polish: the overshooting spring is gone (one clean
// decelerating ease inside the owner's 350-450ms band, shared by the flight
// and the sibling shift), and the white-strip fix is wired in the one order
// that works — measure before insert, cancel the old shift set, pin first,
// transforms second. The pure half (shift.ts) is unit-tested directly; the
// main.ts wiring is source-pinned like flight.test.ts, because main.ts boots
// a real shell at import and cannot load under node.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FLIGHT_EASE, FLIGHT_MS, shiftParticipates } from "../src/shift";

describe("flight motion constants", () => {
  it("the beat sits inside the owner's 350-450ms band", () => {
    expect(FLIGHT_MS).toBeGreaterThanOrEqual(350);
    expect(FLIGHT_MS).toBeLessThanOrEqual(450);
  });

  it("the ease is a cubic-bezier with no overshoot (every y at or below 1)", () => {
    const m = FLIGHT_EASE.match(
      /^cubic-bezier\(\s*([\d.]+)\s*,\s*([\d.-]+)\s*,\s*([\d.]+)\s*,\s*([\d.-]+)\s*\)$/,
    );
    expect(m).not.toBeNull();
    const [, x1, y1, x2, y2] = m!.map(Number);
    expect(y1).toBeLessThanOrEqual(1); // >1 was the spring's bounce
    expect(y2).toBeLessThanOrEqual(1);
    expect(y1).toBeGreaterThanOrEqual(0); // and no anticipation dip either
    expect(y2).toBeGreaterThanOrEqual(0);
    expect(x1).toBeLessThan(x2); // decelerating: fast launch, soft landing
  });
});

describe("shiftParticipates — which preceding elements ride the shift", () => {
  const view = { top: 100, bottom: 800 };

  it("an element that did not move up is out (no gap to close)", () => {
    expect(shiftParticipates(300, 340, 0, view.top, view.bottom)).toBe(false);
    expect(shiftParticipates(300, 340, 0.4, view.top, view.bottom)).toBe(false);
    expect(shiftParticipates(300, 340, -20, view.top, view.bottom)).toBe(false);
  });

  it("a visible element that moved up rides", () => {
    expect(shiftParticipates(600, 640, 48, view.top, view.bottom)).toBe(true);
  });

  it("an element far above the viewport moves invisibly: out", () => {
    // even at its glide start (delta below its new spot) it never enters view
    expect(shiftParticipates(-500, -460, 48, view.top, view.bottom)).toBe(false);
  });

  it("an element just above the top edge whose glide path crosses in rides", () => {
    // new spot above view, but it STARTS delta lower — visible at launch
    expect(shiftParticipates(60, 90, 48, view.top, view.bottom)).toBe(true);
  });

  it("an element below the viewport bottom is out", () => {
    expect(shiftParticipates(900, 940, 48, view.top, view.bottom)).toBe(false);
  });
});

// --- main.ts wiring pins (source-read, like flight.test.ts) -------------------

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

describe("flyFromField uses the shared clean ease", () => {
  const body = fnBody("flyFromField");

  it("animates on FLIGHT_MS / FLIGHT_EASE, spring gone for good", () => {
    expect(body).toContain("duration: FLIGHT_MS, easing: FLIGHT_EASE");
    expect(body).not.toContain("1.08");
    expect(body).not.toContain("450");
  });
});

describe("sibling shift wiring — the order that kills the white strip", () => {
  const send = fnBody("send");
  const begin = fnBody("beginSiblingShift");

  it("send measures before the wrapper exists, pins first, transforms second", () => {
    const measure = send.indexOf("beginSiblingShift()");
    const wrapper = send.indexOf('localWrapper("user")');
    const pin = send.indexOf("scrollToBottom(true)");
    const play = send.indexOf("shift.play(w)");
    const fly = send.indexOf("flyFromField(w)");
    expect(measure).toBeGreaterThan(-1);
    expect(measure).toBeLessThan(wrapper); // before-rects predate the insert
    expect(pin).toBeLessThan(play); // the pin fires first
    expect(play).toBeLessThan(fly); // then the shift, then the flight
  });

  it("before-tops are measured with mid-flight transforms still applied", () => {
    // measure first, cancel second: a second rapid send composes from where
    // the first shift visually is instead of snapping
    const measure = begin.indexOf("getBoundingClientRect()");
    const cancel = begin.indexOf("a.cancel()");
    expect(measure).toBeGreaterThan(-1);
    expect(cancel).toBeGreaterThan(measure);
  });

  it("the new set replaces the registry, so consecutive sends compose cleanly", () => {
    expect(begin).toContain("shiftAnims = []");
    expect(begin).toContain("shiftAnims.push(");
  });

  it("shift rows animate on the flight's own beat and ease", () => {
    expect(begin).toContain("duration: FLIGHT_MS, easing: FLIGHT_EASE");
    expect(begin).toContain("shiftParticipates(");
  });

  it("records the shift start with the measured delta, and the away skip", () => {
    expect(begin).toContain('phase: "shift-start"');
    expect(begin).toMatch(/delta:.*rows/s);
    expect(begin).toContain('phase: "shift-skip"');
  });
});
