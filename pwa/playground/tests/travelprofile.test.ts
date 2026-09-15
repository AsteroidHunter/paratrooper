// The travelling settle's chain against the baseline's own profileFor.
//
// The settle rewrote one piece of geometry rather than reusing it. profileFor
// computes each pair's change of gap from the lag and walks them into a chain in
// one pass; the settle needs those two halves separately, because the release
// has to act BETWEEN them - driveTargets hands out the per-pair changes, and
// chainProfile walks whatever changes it is given. Everything else is meant to
// be the same code doing the same thing: the chain started at the vertex, the
// soft strain bound on each pair, the blended level, the ceiling, the floor.
//
// The way to show that is not to read the two files side by side. It is to feed
// the split version the case it was split out of - one lag, driven straight
// through - and require the untouched function's output exactly. Anything that
// drifted in the copy shows up here, and so does any drift in the claim that
// the travelling mode's DRIVE is the shipped field's drive.

import { describe, expect, it } from "vitest";
import { TUNING, profileFor } from "../src/vendor/springscroll";
import type { SpringRow } from "../src/vendor/springscroll";
import { chainProfile, chainSpan, clampChange, driveTargets } from "../src/travelsettle";
import { makeRows } from "./harness";

/** a thread of varied pitch, and one of uniform tight pitch */
const VARIED = makeRows(140);
const TIGHT: SpringRow[] = Array.from({ length: 120 }, (_, i) => ({ top: i * 46, height: 42 }));
/** bubbles already touching: every closing allowance is zero */
const TOUCHING: SpringRow[] = Array.from({ length: 60 }, (_, i) => ({ top: i * 42, height: 42 }));

/** the settle's driven path, end to end: exactly what its frame() runs */
function driven(
  rows: readonly SpringRow[],
  lo: number,
  hi: number,
  anchorY: number,
  L: number,
  opts?: { divisor?: number; gapMin?: number; strain?: number },
): Map<number, number> {
  const divisor = opts?.divisor ?? TUNING.RESISTANCE_DIVISOR;
  const gapMin = opts?.gapMin ?? TUNING.GAP_MIN_PX;
  const strain = opts?.strain ?? TUNING.GAP_STRAIN_PX;
  const span = chainSpan({
    rows,
    lo,
    hi,
    anchorY,
    divisor,
    resistanceMax: TUNING.RESISTANCE_MAX,
    // driven, nothing is delayed, so the delay gradient is empty and the walk's
    // bounds are the amplitude's alone - which is what profileFor uses
    extraLoY: anchorY,
    extraHiY: anchorY,
  });
  const want = driveTargets({
    rows,
    span,
    anchorY,
    L,
    divisor,
    resistanceMax: TUNING.RESISTANCE_MAX,
    gapMin,
    strain,
  });
  return chainProfile({
    rows,
    lo,
    hi,
    span,
    gapOf: (i) => want.gaps.get(i) ?? 0,
    level: want.level,
    ceiling: want.ceiling,
    gapMin,
  });
}

function sameProfile(
  rows: readonly SpringRow[],
  lo: number,
  hi: number,
  anchorY: number,
  L: number,
  opts?: { divisor?: number; gapMin?: number; strain?: number },
): void {
  const divisor = opts?.divisor ?? TUNING.RESISTANCE_DIVISOR;
  const gapMin = opts?.gapMin ?? TUNING.GAP_MIN_PX;
  const strain = opts?.strain ?? TUNING.GAP_STRAIN_PX;
  const want = profileFor(rows, lo, hi, anchorY, L, divisor, TUNING.RESISTANCE_MAX, gapMin, strain);
  const got = driven(rows, lo, hi, anchorY, L, opts);
  expect([...got.keys()].sort((a, b) => a - b)).toEqual([...want.keys()].sort((a, b) => a - b));
  for (const [i, dy] of want) expect(got.get(i)).toBeCloseTo(dy, 9);
}

describe("while the scroll is driven the travelling mode IS the baseline", () => {
  it("across lags, both signs, and a vertex walked down the thread", () => {
    for (const L of [-300, -106, -67, -12, -0.3, 0.3, 12, 67, 106, 300]) {
      for (const anchorY of [0, 700, 2000, 3457, 5000, 8000, 12000]) {
        for (const [lo, hi] of [
          [0, 139],
          [20, 60],
          [0, 4],
          [130, 139],
          [57, 57],
        ] as const) {
          sameProfile(VARIED, lo, hi, anchorY, L);
        }
      }
    }
  });

  it("on a uniform thread, where every pair is tight enough to bind", () => {
    for (const L of [-120, -40, 40, 120]) {
      for (const anchorY of [200, 1800, 3000, 5400]) sameProfile(TIGHT, 10, 90, anchorY, L);
    }
  });

  it("on bubbles that are already touching, where no pair may close at all", () => {
    for (const L of [-90, -8, 8, 90]) {
      for (const anchorY of [0, 900, 2520]) sameProfile(TOUCHING, 0, 59, anchorY, L);
    }
  });

  it("at the ends of every tunable's range", () => {
    for (const divisor of [120, 500, 1200, 1600]) {
      for (const strain of [2, 12, 40]) {
        for (const gapMin of [0, 2]) {
          sameProfile(VARIED, 30, 80, 3000, 80, { divisor, strain, gapMin });
          sameProfile(VARIED, 30, 80, 3000, -80, { divisor, strain, gapMin });
        }
      }
    }
  });

  it("a zero lag places nothing, in both", () => {
    expect(driven(VARIED, 0, 139, 3000, 0).size).toBe(0);
    expect(profileFor(VARIED, 0, 139, 3000, 0).size).toBe(0);
  });

  it("an empty or inverted range places nothing", () => {
    expect(driven(VARIED, 40, 20, 3000, 60).size).toBe(0);
    expect(chainProfile({
      rows: [],
      lo: 0,
      hi: 0,
      span: { split: 0, wLo: 0, wHi: 0 },
      gapOf: () => 0,
      level: 10,
      ceiling: 10,
      gapMin: 2,
    }).size).toBe(0);
  });
});

describe("the released chain keeps the guarantees the chain is there for", () => {
  /** a release that has reached the bottom of the thread and not the top: the
      shape the front actually makes, at its steepest */
  const released = (rows: readonly SpringRow[], top: number, bottom: number) => (i: number) => {
    const c = rows[i].top + rows[i].height / 2;
    const w = Math.min(Math.max((c - rows[0].top) / (rows[rows.length - 1].top - rows[0].top), 0), 1);
    return top + (bottom - top) * w;
  };

  for (const [name, rows] of [
    ["varied pitch", VARIED],
    ["uniform tight pitch", TIGHT],
    ["already touching", TOUCHING],
  ] as const) {
    it(`${name}: no pair ever closes past the floor, at any front`, () => {
      for (const [top, bottom] of [
        [120, 0],
        [0, 120],
        [-120, 0],
        [80, -80],
        [300, -300],
      ] as const) {
        const lo = 0;
        const hi = rows.length - 1;
        const held = released(rows, top, bottom);
        const span: ReturnType<typeof chainSpan> = {
          split: Math.floor(rows.length / 2),
          wLo: lo,
          wHi: hi,
        };
        const got = chainProfile({
          rows,
          lo,
          hi,
          span,
          gapOf: (i) =>
            clampChange(rows, i, held(i + 1) - held(i), TUNING.GAP_MIN_PX, TUNING.GAP_STRAIN_PX),
          level: held(span.split),
          ceiling: 300,
          gapMin: TUNING.GAP_MIN_PX,
        });
        for (let i = 0; i + 1 <= hi; i++) {
          const a = rows[i];
          const b = rows[i + 1];
          const rest = b.top - (a.top + a.height);
          const now = b.top + (got.get(i + 1) ?? 0) - (a.top + a.height + (got.get(i) ?? 0));
          expect(now).toBeGreaterThan(Math.min(rest, TUNING.GAP_MIN_PX) - 0.02);
        }
      }
    });
  }

  it("a front that has reached every row alike is the constant case again", () => {
    sameProfile(VARIED, 20, 90, 3000, 55);
  });

  it("the hard clamp leaves anything already inside the bound alone", () => {
    // this is why the release uses a clamp and not a second softStrain: the
    // latched pose came through softStrain once, and softening it again would
    // move the stop pose the two modes are supposed to share
    for (const rows of [VARIED, TIGHT, TOUCHING]) {
      for (let i = 0; i + 1 < rows.length; i += 7) {
        const rest = rows[i + 1].top - (rows[i].top + rows[i].height);
        const room = Math.min(TUNING.GAP_STRAIN_PX, Math.max(0, rest - TUNING.GAP_MIN_PX));
        for (const v of [0, 0.5, room * 0.5, room, -room, -room * 0.5]) {
          expect(clampChange(rows, i, v, TUNING.GAP_MIN_PX, TUNING.GAP_STRAIN_PX)).toBeCloseTo(v, 9);
        }
        // and past it, it stops exactly on the bound
        expect(clampChange(rows, i, -room - 50, TUNING.GAP_MIN_PX, TUNING.GAP_STRAIN_PX)).toBeCloseTo(-room, 9);
        expect(clampChange(rows, i, 500, TUNING.GAP_MIN_PX, TUNING.GAP_STRAIN_PX)).toBeCloseTo(TUNING.GAP_STRAIN_PX, 9);
      }
    }
  });
});
