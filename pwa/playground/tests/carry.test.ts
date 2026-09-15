// The live-change blend (src/carry.ts).
//
// REGRESSION SUITE. An independent browser run found this one: starting the
// "Drag up, stop" gesture and then dragging the Trail time slider back and
// forth across its track during the gesture drove rendered row offsets to
// +12,834 and -14,018 px, with rows crossing one another. The cause was one
// term: the new correction was computed as (what was on screen) - (what the new
// numbers want) + (the correction already being carried), and what was on
// screen ALREADY included that correction. Every change re-counted it, so a
// slider moved n times multiplied it n times.
//
// The tests below are about the property that was violated, not about the line
// that violated it: whatever the blend does, a run of changes must not be able
// to walk a row away from where the physics puts it.

import { describe, expect, it } from "vitest";
import { CARRY_EPS_PX, CARRY_MAX_PX, CARRY_TAU_MS, createCarry } from "../src/carry";

const FRAME = 1000 / 60;

/** the largest |value| in a map */
function peak(m: Map<number, number>): number {
  let out = 0;
  for (const v of m.values()) out = Math.max(out, Math.abs(v));
  return out;
}

function mapOf(...vals: number[]): Map<number, number> {
  const m = new Map<number, number>();
  vals.forEach((v, i) => {
    if (v !== 0) m.set(i, v);
  });
  return m;
}

describe("the live-change blend", () => {
  it("writes the physics untouched when nothing has changed", () => {
    const c = createCarry();
    const fresh = mapOf(3, -2, 8);
    expect([...c.blend(fresh, FRAME)]).toEqual([...fresh]);
    expect(c.active()).toBe(false);
  });

  it("absorbs a change instead of stepping it, then gives it back", () => {
    const c = createCarry();
    c.blend(mapOf(20, 20, 20), FRAME); // on screen: 20 px
    c.note();
    const first = c.blend(mapOf(0, 0, 0), FRAME); // the new numbers now want zero
    // Unblended that is a 20 px step in one frame. What the frame of the change
    // may actually move is one frame of the melt and no more, which at a 90 ms
    // time constant is under a fifth of it.
    expect(20 - peak(first)).toBeLessThan(20 * 0.2);
    // and it does keep moving: a correction that is merely frozen would be a
    // slider that does nothing
    expect(peak(first)).toBeLessThan(20);
    let out = first;
    for (let i = 0; i < 60; i++) out = c.blend(mapOf(0, 0, 0), FRAME);
    expect(peak(out)).toBeLessThanOrEqual(CARRY_EPS_PX);
    expect(c.active()).toBe(false);
  });

  it("follows the physics while the slider is still moving", () => {
    // the other half of the same rule: a correction taken fresh on every frame
    // must still melt, or the screen freezes at the value it had when the drag
    // began and the tool stops being a tuning tool
    const c = createCarry();
    c.blend(mapOf(40), FRAME);
    let out = new Map<number, number>();
    for (let k = 0; k < 30; k++) {
      c.note();
      out = c.blend(mapOf(0), FRAME); // the new numbers want zero throughout
    }
    expect(peak(out)).toBeLessThan(40 * 0.05); // half a second in, it is there
  });

  it("a change on every frame for a second cannot walk a row away", () => {
    // the browser's reproduction, in one line: the slider is dragged across its
    // track, so the tuning changes on every frame for as long as the drag lasts
    const c = createCarry();
    let out = new Map<number, number>();
    for (let k = 0; k < 90; k++) {
      c.note();
      // the physics keeps asking for the same modest placement throughout
      out = c.blend(mapOf(12, -9, 30, -30), FRAME);
      expect(peak(out)).toBeLessThanOrEqual(30 + CARRY_MAX_PX);
    }
    // once the changes stop it goes home to exactly what the physics wants
    for (let k = 0; k < 120; k++) out = c.blend(mapOf(12, -9, 30, -30), FRAME);
    expect(out.get(0)).toBeCloseTo(12, 6);
    expect(out.get(3)).toBeCloseTo(-30, 6);
  });

  it("a change on every frame while the physics itself swings stays bounded", () => {
    const c = createCarry();
    let worst = 0;
    for (let k = 0; k < 200; k++) {
      c.note();
      const swing = 60 * Math.sin(k / 3); // a reversal under a moving slider
      worst = Math.max(worst, peak(c.blend(mapOf(swing, swing * 0.5, -swing), FRAME)));
    }
    // the physics offers at most 60; anything past 60 plus one bounded
    // correction is the fault this suite exists for
    expect(worst).toBeLessThanOrEqual(60 + CARRY_MAX_PX);
    expect(worst).toBeLessThan(200);
  });

  it("never carries more than the field could place a row at", () => {
    const c = createCarry();
    c.blend(mapOf(250), FRAME);
    c.note();
    c.blend(mapOf(-250), FRAME);
    expect(c.peak()).toBeLessThanOrEqual(CARRY_MAX_PX);
  });

  it("melts on its own time constant", () => {
    const c = createCarry();
    c.blend(mapOf(100), 0);
    c.note();
    c.blend(mapOf(0), 0); // the correction is taken with no time passing
    expect(c.peak()).toBeCloseTo(100, 6);
    c.blend(mapOf(0), CARRY_TAU_MS);
    expect(c.peak()).toBeCloseTo(100 * Math.exp(-1), 4);
  });

  it("a reset drops everything, so a re-measure cannot carry old rows", () => {
    const c = createCarry();
    c.blend(mapOf(40, 40), FRAME);
    c.note();
    c.blend(mapOf(0, 0), FRAME);
    expect(c.active()).toBe(true);
    c.reset();
    expect(c.active()).toBe(false);
    expect([...c.blend(mapOf(5), FRAME)]).toEqual([...mapOf(5)]);
  });

  it("survives a non-finite placement without poisoning the thread", () => {
    const c = createCarry();
    c.blend(new Map([[0, Number.NaN]]), FRAME);
    c.note();
    const out = c.blend(mapOf(7), FRAME);
    for (const v of out.values()) expect(Number.isFinite(v)).toBe(true);
  });
});
