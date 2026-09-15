// What the travelling settle must actually do, driven through the same call
// sequence the page runs (tests/harness.ts). Nothing here restates the
// implementation back at itself: every assertion is a claim about behaviour on
// screen - which bubble moves first, whether any of them fight each other,
// whether the thread ever finishes - and several of them are paired with a
// control run that must NOT show the effect.

import { describe, expect, it } from "vitest";
import {
  dampedStep,
  delayForCentre,
  defaultTravelTuning,
  waveOriginY,
} from "../src/travelsettle";
import type { TravelTuning } from "../src/travelsettle";
import type { FieldTunables } from "../src/springfield";
import { FRAME_MS, harness, peaks } from "./harness";
import type { Harness, Reading } from "./harness";

const SPEED = 1.5; // px/ms of scrollTop: a firm, ordinary drag

interface StopRun {
  h: Harness;
  stopIdx: number;
  stopT: number;
  vertexY: number;
  peak: Map<number, number>;
}

/**
 * A 1:1 drag in one direction, then the finger stops travelling but stays on
 * the glass. That is the braked stop the whole effect is tuned on, and the
 * field's own rule is what decides which frame it lands on.
 */
function driveAndStop(opts: {
  dir: 1 | -1;
  tune?: Partial<TravelTuning>;
  field?: Partial<FieldTunables>;
  driveMs?: number;
  holdMs?: number;
  speed?: number;
}): StopRun {
  const speed = opts.speed ?? SPEED;
  const driveMs = opts.driveMs ?? 220;
  const h = harness({ tune: opts.tune, field: opts.field });
  const finger0 = opts.dir === 1 ? 700 : 150;
  h.begin(finger0, true);
  h.frame(0, finger0); // the gesture's first frame is a baseline reading
  const fingerEnd = h.drag(opts.dir * speed, driveMs, finger0);
  const stopIdx = h.log.length;
  const stopT = h.log[stopIdx - 1].t;
  const vertexY = h.field.vertex();
  h.holdStill(opts.holdMs ?? 1400, fingerEnd);
  return { h, stopIdx, stopT, vertexY, peak: peaks(h.log, stopIdx - 3) };
}

/** the log entry closest to `ms` after the stop */
function at(run: StopRun, ms: number): Reading {
  const want = run.stopT + ms;
  let best = run.h.log[run.stopIdx];
  for (const r of run.h.log) if (Math.abs(r.t - want) < Math.abs(best.t - want)) best = r;
  return best;
}

/**
 * How much of each row's stretch is still on screen at `ms` after the stop, for
 * the rows that had a stretch worth looking at, ordered by how far ABOVE the
 * vertex they sit. This is the measurement the whole feature is about: walking
 * up the thread, the numbers should rise.
 *
 * Only rows the reader can SEE are counted. The field writes a band 400 px
 * wider than the viewport each way so a row takes its place in the profile
 * before it arrives, and those off-screen rows enter and leave that band as the
 * thread moves - a row that leaves it drops out of the map carrying whatever it
 * had, which is not motion anybody sees and would otherwise be measured as if
 * it were.
 */
function remainingAbove(
  run: StopRun,
  ms: number,
  minPeak = 1.5,
  which: "trav" | "base" = "trav",
): { d: number; left: number }[] {
  const frame = at(run, ms);
  const map = which === "trav" ? frame.disp : frame.base;
  const out: { d: number; left: number }[] = [];
  for (const i of run.h.visible()) {
    const pk = run.peak.get(i) ?? 0;
    if (pk < minPeak) continue;
    const centre = run.h.centre(i);
    if (centre >= run.vertexY) continue; // below the vertex: a different arm of the wave
    out.push({ d: run.vertexY - centre, left: Math.abs(map.get(i) ?? 0) / pk });
  }
  return out.sort((a, b) => a.d - b.d);
}

/** the difference between the most and least finished row of a ladder */
function ladderSpread(l: { left: number }[]): number {
  return Math.max(...l.map((x) => x.left)) - Math.min(...l.map((x) => x.left));
}

/**
 * The rows on screen AT a given scroll position, which is not the same question
 * as the rows on screen at the end of a run.
 *
 * The field writes a band 400 px wider than the viewport each way precisely so
 * that a row can take up its share of the lag - which it does in one frame,
 * in the shipped field too - while it is still off screen. Measuring a
 * single-frame step over rows that are visible LATER therefore counts exactly
 * the entry the buffer exists to hide, and counts it as if a reader had seen
 * it. Every step measurement below asks about the frame it is on.
 */
function visibleAt(h: Harness, scroll: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < h.rows.length; i++) {
    if (h.rows[i].top + h.rows[i].height < scroll) continue;
    if (h.rows[i].top > scroll + h.clientH) break;
    out.push(i);
  }
  return out;
}

/**
 * The worst single-frame move any VISIBLE row made over a slice of the log, for
 * the travelling settle and for the shipped field over the same frames.
 *
 * The pair is the point. A gesture that reverses at 1.5 px/ms swings the
 * reference lag by tens of px in a frame all by itself, and a row out at
 * saturation follows it; that is the field doing its job, not a jump, and it
 * happens identically in both modes. What has to be shown is that the
 * experimental settle does not ADD to it.
 */
function worstStep(h: Harness, from: number): { travel: number; base: number } {
  let travel = 0;
  let base = 0;
  const seen = h.visible();
  for (let k = Math.max(from, 1); k < h.log.length; k++) {
    for (const i of seen) {
      travel = Math.max(
        travel,
        Math.abs((h.log[k].disp.get(i) ?? 0) - (h.log[k - 1].disp.get(i) ?? 0)),
      );
      base = Math.max(
        base,
        Math.abs((h.log[k].base.get(i) ?? 0) - (h.log[k - 1].base.get(i) ?? 0)),
      );
    }
  }
  return { travel, base };
}

/** ms after the stop at which the last row stopped being placed */
function lastMovingMs(run: StopRun): number {
  for (let k = run.h.log.length - 1; k >= run.stopIdx; k--) {
    if (run.h.log[k].disp.size > 0) return run.h.log[k].t - run.stopT;
  }
  return 0;
}

function converged(h: Harness): boolean {
  const last = h.log[h.log.length - 1];
  return last.disp.size === 0 && !h.settle.active() && h.field.lag() === 0;
}

describe("the settle travels: nearest the finger first, upward in order", () => {
  for (const dir of [1, -1] as const) {
    const name = dir === 1 ? "dragging toward newer" : "dragging toward older";

    it(`${name}: rows further above the finger still hold more of their stretch`, () => {
      const run = driveAndStop({ dir });
      const ladder = remainingAbove(run, 70);
      expect(ladder.length).toBeGreaterThanOrEqual(5);

      // ordered: walking up the thread, no row is further along its return than
      // one below it (a little slack for the strain bound's own curvature)
      for (let k = 1; k < ladder.length; k++) {
        expect(ladder[k].left).toBeGreaterThanOrEqual(ladder[k - 1].left - 0.03);
      }
      // and the spread is a real one, not a rounding difference
      expect(ladder[ladder.length - 1].left - ladder[0].left).toBeGreaterThan(0.35);

      // THE COMPARISON THAT MATTERS, and the one the first version of this
      // tool failed. The baseline melts every row on one exp(-t/tau), so at any
      // instant they are all at the same fraction of their own stretch and the
      // ladder is flat; the near rows only LOOK earlier because they had less to
      // travel. Whatever the travelling settle does has to be visible against
      // that, not against zero.
      // (not exactly flat: the strain bound is not linear in the lag, so a
      // saturated pair melts at a slightly different fraction from a free one)
      const control = remainingAbove(run, 70, 1.5, "base");
      expect(control.length).toBe(ladder.length);
      expect(ladderSpread(control)).toBeLessThan(0.2);
      expect(ladderSpread(ladder) - ladderSpread(control)).toBeGreaterThan(0.2);
      // the row nearest the finger is genuinely on its way home while the rows
      // above it are still holding most of what they had
      expect(ladder[0].left).toBeLessThan(0.7);
      expect(ladder[ladder.length - 1].left).toBeGreaterThan(0.9);

      // AND IN PIXELS, which is what a reader has. The fraction above is a
      // normalised measure and it flatters the baseline: dividing by each row's
      // own peak hides that the baseline has ALREADY taken every row most of
      // the way home by 70 ms while the travelling settle still has the far
      // ones where they stopped. On screen the two scenes are tens of px apart,
      // not a few percent apart, and one row being 4 px from where the other
      // mode puts it is the smallest difference worth calling visible.
      const shot = at(run, 70);
      let biggest = 0;
      for (const i of run.h.visible()) {
        const d = Math.abs((shot.disp.get(i) ?? 0) - (shot.base.get(i) ?? 0));
        if (d > biggest) biggest = d;
      }
      expect(biggest).toBeGreaterThan(4);
    });

    it(`${name}: the same drag with the delay at zero lands them together`, () => {
      // the control. Everything else is identical; only the stagger is off, and
      // with it off the ordering has to collapse.
      const run = driveAndStop({ dir, tune: { upDelayPerPx: 0 } });
      const ladder = remainingAbove(run, 70);
      expect(ladder.length).toBeGreaterThanOrEqual(5);
      const spread = Math.max(...ladder.map((x) => x.left)) - Math.min(...ladder.map((x) => x.left));
      // not zero: the strain bound is not linear in the lag, so a saturated
      // pair melts at a slightly different fraction from a free one. It is a
      // fifth of what the stagger produces.
      expect(spread).toBeLessThan(0.15);
    });

    it(`${name}: every row ends exactly on its seat`, () => {
      const run = driveAndStop({ dir });
      expect(converged(run.h)).toBe(true);
    });
  }

  it("the displacements all carry the scroll's own sign: no row opposes another", () => {
    for (const dir of [1, -1] as const) {
      const run = driveAndStop({ dir });
      for (let k = run.stopIdx; k < run.h.log.length; k++) {
        for (const dy of run.h.log[k].disp.values()) {
          // sign of the lag follows the scroll: rising scrollTop leaves the rows
          // displaced DOWN behind the motion
          if (dir === 1) expect(dy).toBeGreaterThan(-0.011);
          else expect(dy).toBeLessThan(0.011);
        }
      }
    }
  });

  it("a bounce under 1 is what puts rows on opposite sides of their seats", () => {
    // the positive control for the test above: the overshoot is opt-in, it is
    // the one setting that can produce opposing motion, and it does
    const run = driveAndStop({ dir: 1, tune: { bounce: 0.5 } });
    let opposed = false;
    for (let k = run.stopIdx; k < run.h.log.length; k++) {
      for (const dy of run.h.log[k].disp.values()) if (dy < -0.25) opposed = true;
    }
    expect(opposed).toBe(true);
    expect(converged(run.h)).toBe(true); // and it still finishes
  });
});

describe("while the scroll is driven the two modes are the same picture", () => {
  // This is the property the first version did NOT have, and the reason it was
  // both invisible at the stop and worse than the baseline on sparse input. It
  // delayed the shared lag, so under a changing signal - which is every real
  // drag - the rows read something the baseline never showed, and an
  // independent browser run measured the travelling stretch at 3.93 px where
  // the baseline had 11.35 px on 33 ms scroll delivery.
  //
  // Now the driven profile is recomputed from the live lag, so the two maps
  // agree to the bit on every driven frame however the positions arrive. The
  // settle can only differ AFTER the stop, which is where it was asked for.
  function drag(deliver: (i: number) => number, frames = 40) {
    const h = harness();
    const finger0 = 700;
    h.begin(finger0, true);
    h.frame(0, finger0);
    let finger = finger0;
    for (let i = 0; i < frames; i++) {
      const step = deliver(i);
      finger -= step;
      h.frame(step, finger);
    }
    return h;
  }

  const SMOOTH = () => 1.2 * FRAME_MS;
  const HALF_RATE = (i: number) => (i % 2 === 0 ? 2.4 * FRAME_MS : 0);
  const RAGGED = (i: number) => [1.4, 0, 0, 3.6, 0.6, 0, 2.2, 1.0][i % 8] * FRAME_MS;

  it("a continuously driven drag draws the baseline's picture, to the bit", () => {
    const h = drag(SMOOTH);
    let checked = 0;
    for (const r of h.log) {
      if (r.phase !== "driving" && r.phase !== "coasting") continue;
      checked += 1;
      expect([...r.disp.keys()].sort((a, b) => a - b)).toEqual(
        [...r.base.keys()].sort((a, b) => a - b),
      );
      for (const [k, dy] of r.base) expect(r.disp.get(k), `row ${k}`).toBeCloseTo(dy, 9);
    }
    expect(checked).toBeGreaterThan(30);
  });

  // SPARSE DELIVERY IS NOT THE SAME QUESTION, and this is the honest answer to
  // it. When the browser hands the main thread a position on alternate frames,
  // the SHIPPED field itself flips between driving and settling every frame -
  // that is the pulsing the reviewer measured on Baseline, 7 to 10 px on one
  // visible row - and the settle is not free to ignore it: a frame the field
  // calls settling is a frame the release has to start on, or the stop would
  // not land where the shipped app lands it. So the two are NOT bit-identical
  // on a stuttering drag. What matters is the direction of the difference, and
  // it is the opposite of version one's.
  for (const [label, deliver] of [
    ["half rate", HALF_RATE],
    ["ragged", RAGGED],
  ] as const) {
    it(`${label} delivery does not cost the stretch version one lost`, () => {
      const h = drag(deliver);
      const vis = h.visible();
      const peak = (m: Map<number, number>): number =>
        vis.reduce((a, i) => Math.max(a, Math.abs(m.get(i) ?? 0)), 0);
      // The baseline PULSES here: its own peak rises on a frame that carried a
      // position and falls on a frame that did not, which is the field's stop
      // rule doing exactly what it was measured to do. So the comparison is
      // against the top of that pulse over the last stretch of the drag, not
      // against whichever frame the drag happened to end on.
      const tail = h.log.slice(-12);
      const baseTop = Math.max(...tail.map((r) => peak(r.base)));
      const baseLow = Math.min(...tail.map((r) => peak(r.base)));
      const travTop = Math.max(...tail.map((r) => peak(r.disp)));
      const travLow = Math.min(...tail.map((r) => peak(r.disp)));
      // the old delay line reached 3.93 px where the baseline had 11.35 px on
      // 33 ms delivery, because the far rows were reading a value from before
      // the lag had built. Nothing reads the past any more: the stretch reaches
      // the top of the baseline's own pulse and does not go past it.
      expect(travTop).toBeGreaterThan(baseTop * 0.95);
      expect(travTop).toBeLessThan(baseTop * 1.02);
      // and it sits nearer the top of that pulse than the bottom, because a
      // frame the field called a stop is a frame the release has barely begun
      expect(baseTop - baseLow).toBeGreaterThan(1);
      expect(travTop - travLow).toBeLessThan((baseTop - baseLow) * 0.75);
    });

    it(`${label} delivery does not pulse worse than the baseline does`, () => {
      const h = drag(deliver);
      const vis = h.visible();
      let travel = 0;
      let base = 0;
      for (let k = 1; k < h.log.length; k++) {
        for (const i of vis) {
          travel = Math.max(
            travel,
            Math.abs((h.log[k].disp.get(i) ?? 0) - (h.log[k - 1].disp.get(i) ?? 0)),
          );
          base = Math.max(
            base,
            Math.abs((h.log[k].base.get(i) ?? 0) - (h.log[k - 1].base.get(i) ?? 0)),
          );
        }
      }
      // the settle holds a row through a frame the field called a stop, so its
      // worst single-frame move is SMALLER than the field's own, not larger
      expect(travel).toBeLessThanOrEqual(base + 0.01);
    });
  }
});

describe("the wave still travels when the finger's row has gone", () => {
  // This is the hard case, and the tool is honest about it rather than tuned
  // around it. Past the resistance divisor every row saturates, so the profile
  // is ONE number added to all of them and the amplitude carries no shape at
  // all. The stagger then has to produce the whole of the ordering by itself,
  // and what it is allowed to produce is bounded by the gaps: bubbles are rigid,
  // two of them can only differ by as much as the space between them, and a run
  // of bubbles is 4 px apart. So the wave survives - the near rows still lead -
  // but it is compressed, and within THIS design (the shipped pose, released
  // through the baseline's own pair bounds) the sliders cannot uncompress it.
  // Named here so a regression that silently removes it fails.
  it("a long drag carries the vertex off screen and the settle stays ordered", () => {
    // 1200 ms at 2 px/ms puts the vertex 2400 px above the viewport. Every
    // visible row is then past the resistance divisor, so the profile is flat:
    // one number added to all of them. Without an origin that stays on screen
    // this is exactly the delayed common slide the tool must not ship.
    const h = harness({ tune: {}, scroll: 600 });
    h.begin(700, true);
    h.frame(0, 700);
    // the finger cannot travel 2400 px, so it is re-planted as a drag that
    // keeps going: what matters is that scrollTop travels and the vertex does
    // not
    let finger = 700;
    for (let i = 0; i < Math.round(1200 / FRAME_MS); i++) {
      finger = finger > 60 ? finger - 4 : 700;
      h.frame(2 * FRAME_MS, finger);
    }
    const vertexY = h.field.vertex();
    expect(vertexY).toBeLessThan(h.scroll - 1000); // really gone off the top

    const stopIdx = h.log.length;
    const stopT = h.log[stopIdx - 1].t;
    h.holdStill(1400, finger);
    const peak = peaks(h.log, stopIdx - 3);
    const run: StopRun = { h, stopIdx, stopT, vertexY, peak };

    // the wave now starts at the bottom edge of the band and runs up it
    const frame = at(run, 70);
    const visible = h.visible().filter((i) => (peak.get(i) ?? 0) >= 1.5);
    expect(visible.length).toBeGreaterThanOrEqual(5);
    const left = visible.map((i) => ({
      y: h.centre(i),
      left: Math.abs(frame.disp.get(i) ?? 0) / (peak.get(i) as number),
    }));
    const bottom = left[left.length - 1];
    const top = left[0];
    expect(bottom.left).toBeLessThan(top.left - 0.1); // the bottom is further home
    // ... and with the gaps as the only source of ordering it IS compressed:
    // the same measurement with the vertex on screen clears 0.35
    expect(bottom.left).toBeGreaterThan(0.4);
    expect(converged(h)).toBe(true);
  });

  it("the delay cap bounds how long the whole settle can last", () => {
    // at the default 0.3 ms/px a 40 ms cap stops the delay growing 133 px above
    // the origin and a 160 ms cap 533 px above it, so both bind inside one
    // viewport and the difference between them is the cap's own doing
    const short = driveAndStop({ dir: 1, tune: { maxDelayMs: 40 }, holdMs: 2600 });
    const long = driveAndStop({ dir: 1, tune: { maxDelayMs: 160 }, holdMs: 2600 });
    expect(lastMovingMs(short)).toBeLessThan(lastMovingMs(long) - 40);
    // the cap is what it says it is: nothing is still moving more than the cap
    // plus a generous return after the stop
    const r = defaultTravelTuning().returnMs;
    expect(lastMovingMs(short)).toBeLessThan(40 + 8 * r);
    expect(lastMovingMs(long)).toBeLessThan(160 + 8 * r);
  });

  it("bubbles keep document order and never touch, at any stagger", () => {
    // The geometric guarantee, and the reason the ordering is bounded rather
    // than free. Ordering two bubbles costs space BETWEEN them, and a run of
    // bubbles is 4 px apart: at a steep enough delay, neighbours are asked to
    // differ by tens of px through a 4 px gap. The chain refuses - every pair's
    // change of gap is passed through a bound that stays strictly inside the
    // room down to the floor - so the far rows are carried along by their
    // neighbours instead of passing through them. Turning the delay past that
    // point buys ordering that the geometry will not sell.
    for (const tune of [
      {},
      { upDelayPerPx: 1, maxDelayMs: 400 },
      { upDelayPerPx: 1, downDelayRatio: 1, maxDelayMs: 400 },
      { bounce: 0.4, upDelayPerPx: 0.8 },
    ]) {
      for (const dir of [1, -1] as const) {
        const run = driveAndStop({ dir, tune, speed: 3, holdMs: 1800 });
        for (const frame of run.h.log) {
          const disp = frame.disp;
          // only pairs the effect actually places. A pair straddling the edge
          // of the participation window has one row placed and one not, by
          // design: the window is 400 px wider than the viewport each way so
          // that entry and exit both happen off screen.
          for (let i = frame.lo; i + 1 <= frame.hi; i++) {
            const a = run.h.rows[i];
            const b = run.h.rows[i + 1];
            const rest = b.top - (a.top + a.height);
            const now = b.top + (disp.get(i + 1) ?? 0) - (a.top + a.height + (disp.get(i) ?? 0));
            // never closer than the floor, and a pair already tighter than the
            // floor at rest keeps its rest gap
            expect(now).toBeGreaterThan(Math.min(rest, run.h.fieldT.gapMin) - 0.02);
          }
        }
      }
    }
  });
});

describe("the settle is not over until the delayed rows are", () => {
  // REGRESSION, found by an independent browser run, not here: a held
  // drag-down stop cleared every row about 114 ms after the stop while three
  // visible bubbles were still 5.68, 4.15 and 2.80 px off their seats and the
  // scroll had not moved a pixel. The shared signal had reached rest, and the
  // settle treated that as the whole effect being over - but rows up the thread
  // are reading what that signal held up to maxDelay ms EARLIER, which is the
  // entire point of the mechanism. They were cut off mid-return and snapped
  // home in one frame.
  for (const dir of [1, -1] as const) {
    it(`${dir === 1 ? "up" : "down"}: no row is cut off part way home`, () => {
      const run = driveAndStop({ dir, speed: 0.45, driveMs: 400, holdMs: 2000 });
      let cliff = 0;
      for (let k = run.stopIdx; k < run.h.log.length; k++) {
        for (const i of run.h.visible()) {
          const now = Math.abs(run.h.log[k].disp.get(i) ?? 0);
          const prev = Math.abs(run.h.log[k - 1].disp.get(i) ?? 0);
          // a row that was placed and is now not placed at all has been cleared,
          // and the px it was carrying when that happened is the cliff
          if (now === 0 && prev > cliff) cliff = prev;
        }
      }
      // the map may only drop a row once it is under the DOM's own rounding,
      // which is what the field's rest threshold means
      expect(cliff).toBeLessThan(0.5);
    });
  }

  it("keeps asking for frames while rows up the thread are still waiting", () => {
    const run = driveAndStop({ dir: -1, speed: 0.45, driveMs: 400, holdMs: 2000 });
    // the field's own reference lag reaches rest one return after the stop; the
    // rows the front has not reached are still holding everything they had, and
    // treating the field's rest as the effect's rest is what cut them off in
    // version one
    let restIdx = -1;
    for (let k = run.stopIdx; k < run.h.log.length; k++) {
      if (run.h.log[k].lag === 0) {
        restIdx = k;
        break;
      }
    }
    expect(restIdx).toBeGreaterThan(run.stopIdx);
    expect(run.h.log[restIdx].disp.size).toBeGreaterThan(0); // still placing rows
    // "holding" is the state's own word for "the front has not reached every
    // row yet", so this is the model saying it has rows left to release
    expect(run.h.log[restIdx].state).toBe("holding");
    // ... and it really does end
    expect(converged(run.h)).toBe(true);
    expect(run.h.log[run.h.log.length - 1].state).toBe("idle");
  });

  it("the whole settle lasts about as long as the delay it is spreading", () => {
    const none = driveAndStop({ dir: 1, speed: 0.45, tune: { maxDelayMs: 0 }, holdMs: 2000 });
    const some = driveAndStop({ dir: 1, speed: 0.45, tune: { maxDelayMs: 200 }, holdMs: 2000 });
    expect(lastMovingMs(some)).toBeGreaterThan(lastMovingMs(none) + 60);
  });
});

describe("interruptions", () => {
  it("a finger landing mid-settle does not throw the rows", () => {
    // the catch: a coast, then a finger lands on a stretched thread and holds
    // still. The field parks the vertex for this; the settle's own hand-back
    // decays the difference rather than stepping it.
    const h = harness();
    h.begin(700, true);
    h.frame(0, 700);
    const finger = h.drag(SPEED, 220, 700);
    h.lift();
    for (let i = 0; i < 12; i++) h.frame(SPEED * FRAME_MS * 0.7); // the coast
    const before = h.log.length;
    h.begin(420, true); // a finger lands, and holds
    h.holdStill(900, 420);
    expect(finger).toBeLessThan(700); // the drag really did travel
    const w = worstStep(h, before);
    // no worse than the shipped field over the very same frames, and not by a
    // rounding margin either: the catch is the gesture the vertex park was
    // added for, and the settle rides that park rather than fighting it
    expect(w.travel).toBeLessThanOrEqual(w.base * 1.35 + 1);
    expect(converged(h)).toBe(true);
  });

  it("a reversal mid-drag crosses zero without anything jumping", () => {
    const h = harness();
    h.begin(430, true);
    h.frame(0, 430);
    const turn = h.drag(SPEED, 200, 430);
    const before = h.log.length;
    h.drag(-SPEED, 200, turn);
    h.holdStill(1400, turn + SPEED * 200);
    let up = false;
    let down = false;
    for (let k = before; k < h.log.length; k++) {
      for (const dy of h.log[k].disp.values()) {
        if (dy > 0.5) up = true;
        if (dy < -0.5) down = true;
      }
    }
    expect(up && down).toBe(true); // the lag really did change sign
    const w = worstStep(h, before);
    expect(w.travel).toBeLessThanOrEqual(w.base * 1.35 + 1);
    expect(converged(h)).toBe(true);
  });

  it("a reversal that interrupts a RELEASE does not drop the pose in one frame", () => {
    // REGRESSION, found by an independent browser run and not here. The exact
    // gesture: drag, hold long enough that the release is under way but not
    // finished, then reverse. The reviewer measured one visible row falling
    // 11.33 px in a single 16.7 ms frame (+13.74 to +2.41) while scrollTop had
    // not moved, against 6.31 px for the largest still-scroll step Baseline
    // made over the same window - and then the same row moving back OUT to
    // +4.59, which is the signature of a clamp being applied and then released
    // rather than of a spring.
    //
    // The cause was that the hand-back preserved the per-pair GAPS and nothing
    // else. The whole chain hangs off the level of the row under the vertex,
    // and the ceiling is the reference lag itself; at a reversal the lag passes
    // through zero, so replacing both outright took the level to nothing and
    // clamped every row to nearly nothing on the same frame. The shown POSE has
    // to be what is handed back, not just the gaps between its rows.
    for (const dir of [1, -1] as const) {
      const h = harness();
      const finger0 = dir === 1 ? 675 : 170; // 80% / 20% of the band
      h.begin(finger0, true);
      h.frame(0, finger0);
      const turn = h.drag(dir * SPEED, 16 * FRAME_MS, finger0);
      h.holdStill(85, turn); // the release starts, and is not finished
      const before = h.log.length;
      // the reversal, delivered on alternate frames the way a browser delivers
      // it. The gaps matter: the frames the fall was measured on are the ones
      // where scrollTop did NOT move, and a run that moves the scroll on every
      // frame cannot show them.
      let finger = turn;
      for (let k = 0; k < 20; k++) {
        const step = k % 2 === 0 ? -dir * SPEED * FRAME_MS * 2 : 0;
        finger -= step;
        h.frame(step, finger);
      }
      h.holdStill(1200, finger);

      // the release really was interrupted: rows were still off their seats
      // when the drive came back
      let carried = 0;
      for (const dy of h.log[before - 1].disp.values()) carried = Math.max(carried, Math.abs(dy));
      expect(carried, `${dir}: nothing was being held`).toBeGreaterThan(5);

      // ON A FRAME WHERE THE SCROLL DID NOT MOVE, which is the reviewer's own
      // measurement and the sharp one: nothing the reader did moved the thread,
      // so whatever a row does on such a frame is the model's doing alone.
      let stillTravel = 0;
      let stillBase = 0;
      let stillFrames = 0;
      for (let k = before; k < h.log.length; k++) {
        if (h.log[k].scroll !== h.log[k - 1].scroll) continue;
        stillFrames += 1;
        for (const i of visibleAt(h, h.log[k].scroll)) {
          stillTravel = Math.max(
            stillTravel,
            Math.abs((h.log[k].disp.get(i) ?? 0) - (h.log[k - 1].disp.get(i) ?? 0)),
          );
          stillBase = Math.max(
            stillBase,
            Math.abs((h.log[k].base.get(i) ?? 0) - (h.log[k - 1].base.get(i) ?? 0)),
          );
        }
      }
      expect(stillFrames).toBeGreaterThan(8);
      expect(
        stillTravel,
        `${dir}: still ${stillTravel.toFixed(2)} vs base ${stillBase.toFixed(2)}`,
      ).toBeLessThanOrEqual(stillBase * 1.35 + 1);

      // THE HAND-BACK FRAME ITSELF, which is the sharp one: the single frame on
      // which the release stops owning the thread and the drive takes it back.
      // If the shown pose is preserved that frame is continuous and a row moves
      // by about what the shipped field moved it by; if it is not, the whole
      // chain re-lands somewhere else in 16.7 ms, which is the fall that was
      // measured in the browser.
      let hand = -1;
      for (let k = before; k < h.log.length; k++) {
        const was = h.log[k - 1].state;
        if (h.log[k].state === "driven" && (was === "holding" || was === "settling")) {
          hand = k;
          break;
        }
      }
      expect(hand, `${dir}: the release was never handed back`).toBeGreaterThan(0);
      // WHAT THIS CAUGHT, so a later reader knows what "handed back" buys. With
      // the level and the ceiling replaced outright rather than carried, the
      // rows holding the most pose all landed on the SAME number in one frame -
      // 30.54, 42.54, 53.29 and 58.95 px every one of them onto 6.63, which was
      // the reference lag at that instant. Several rows arriving at one
      // identical value is a clamp, not a spring, and the worst on-screen row
      // fell 52.31 px against the shipped field's 17.20 over the same frame.
      // Carrying both takes that to 16.61 against 13.90.
      let handTravel = 0;
      let handBase = 0;
      for (const i of visibleAt(h, h.log[hand].scroll)) {
        handTravel = Math.max(
          handTravel,
          Math.abs((h.log[hand].disp.get(i) ?? 0) - (h.log[hand - 1].disp.get(i) ?? 0)),
        );
        handBase = Math.max(
          handBase,
          Math.abs((h.log[hand].base.get(i) ?? 0) - (h.log[hand - 1].base.get(i) ?? 0)),
        );
      }
      expect(
        handTravel,
        `${dir}: hand-back ${handTravel.toFixed(2)} vs base ${handBase.toFixed(2)}`,
      ).toBeLessThanOrEqual(handBase * 1.35 + 1);

      // and over every frame of the reversal, moving or not. The shipped field
      // takes its own large steps through a reversal - the reference lag swings
      // tens of px by itself - so the claim is not that the settle is smooth,
      // it is that the settle does not ADD much to it.
      const w = worstStep(h, before);
      expect(w.travel, `${dir}: all ${w.travel.toFixed(2)} vs base ${w.base.toFixed(2)}`)
        .toBeLessThanOrEqual(w.base * 1.35 + 1);
      expect(converged(h)).toBe(true);
    }
  });

  it("a new drag started mid-settle takes the thread back and still lands", () => {
    const run = driveAndStop({ dir: 1, driveMs: 220, holdMs: 120 });
    const h = run.h;
    h.lift();
    h.begin(600, true);
    h.frame(0, 600);
    h.drag(-SPEED, 200, 600);
    h.holdStill(1600, 600 + SPEED * 200);
    expect(converged(h)).toBe(true);
  });
});

describe("the parameter limits hold", () => {
  const knobs: { name: string; tune: Partial<TravelTuning> }[] = [
    { name: "no stagger", tune: { upDelayPerPx: 0 } },
    { name: "maximum stagger", tune: { upDelayPerPx: 1, maxDelayMs: 400 } },
    { name: "no cap", tune: { maxDelayMs: 0 } },
    { name: "symmetric wave", tune: { downDelayRatio: 1 } },
    { name: "no downward wave", tune: { downDelayRatio: 0 } },
    { name: "fastest return", tune: { returnMs: 40 } },
    { name: "slowest return", tune: { returnMs: 500 } },
    { name: "loosest bounce", tune: { bounce: 0.4 } },
    { name: "overdamped", tune: { bounce: 1.5 } },
    { name: "wave from the screen bottom", tune: { origin: "bottom" } },
  ];
  for (const k of knobs) {
    it(`${k.name}: finite the whole way and home at the end`, () => {
      const run = driveAndStop({ dir: 1, tune: k.tune, holdMs: 4000 });
      for (const r of run.h.log) {
        for (const dy of r.disp.values()) expect(Number.isFinite(dy)).toBe(true);
      }
      expect(converged(run.h)).toBe(true);
    });
  }

  const fields: { name: string; field: Partial<FieldTunables> }[] = [
    { name: "shortest trail time", field: { tau: 10 } },
    { name: "longest trail time", field: { tau: 140 } },
    { name: "shortest reach", field: { divisor: 120 } },
    { name: "longest reach", field: { divisor: 1200 } },
    { name: "tightest strain bound", field: { strain: 2 } },
    { name: "loosest strain bound", field: { strain: 40 } },
  ];
  for (const k of fields) {
    it(`${k.name}: finite the whole way and home at the end`, () => {
      const run = driveAndStop({ dir: 1, field: k.field, holdMs: 4000 });
      for (const r of run.h.log) {
        for (const dy of r.disp.values()) expect(Number.isFinite(dy)).toBe(true);
      }
      expect(converged(run.h)).toBe(true);
    });
  }
});

describe("the return spring itself", () => {
  it("does not depend on the frame rate", () => {
    const omega = 3.89 / 105;
    const one = dampedStep(40, -40 / 45, 100, omega, 1);
    let step = { x: 40, v: -40 / 45 };
    for (let i = 0; i < 40; i++) step = dampedStep(step.x, step.v, 2.5, omega, 1);
    expect(step.x).toBeCloseTo(one.x, 9);
    expect(step.v).toBeCloseTo(one.v, 9);
  });

  it("critically damped, seeded the way the settle seeds it, never crosses the seat", () => {
    const omega = 3.89 / 105;
    let s = { x: 40, v: -40 / 45 };
    let last = s.x;
    for (let i = 0; i < 400; i++) {
      s = dampedStep(s.x, s.v, FRAME_MS, omega, 1);
      expect(s.x).toBeGreaterThanOrEqual(-1e-9);
      expect(s.x).toBeLessThanOrEqual(last + 1e-9); // and never grows
      last = s.x;
    }
    expect(s.x).toBeLessThan(0.01);
  });

  it("is stable across a stalled frame", () => {
    for (const zeta of [0.4, 1, 1.5]) {
      const s = dampedStep(40, -1, 5000, 3.89 / 105, zeta);
      expect(Number.isFinite(s.x)).toBe(true);
      expect(Math.abs(s.x)).toBeLessThan(1e-6);
    }
  });

  it("an underdamped return overshoots and an overdamped one does not", () => {
    const run = (zeta: number): number => {
      let s = { x: 40, v: -40 / 45 };
      let min = 40;
      for (let i = 0; i < 400; i++) {
        s = dampedStep(s.x, s.v, FRAME_MS, 3.89 / 105, zeta);
        min = Math.min(min, s.x);
      }
      return min;
    };
    expect(run(0.5)).toBeLessThan(-0.5);
    expect(run(1.5)).toBeGreaterThan(-1e-9);
  });
});

describe("the delay and the wave origin", () => {
  const t = defaultTravelTuning();

  it("grows upward, grows more slowly downward, and stops at the cap", () => {
    expect(delayForCentre(1000, 1000, t)).toBe(0);
    expect(delayForCentre(900, 1000, t)).toBeCloseTo(100 * t.upDelayPerPx, 10);
    expect(delayForCentre(1100, 1000, t)).toBeCloseTo(100 * t.upDelayPerPx * t.downDelayRatio, 10);
    expect(delayForCentre(-100000, 1000, t)).toBe(t.maxDelayMs);
    expect(delayForCentre(100000, 1000, t)).toBe(t.maxDelayMs);
  });

  it("the origin is the finger while it is on screen", () => {
    expect(waveOriginY("finger", 1400, 1000, 844)).toBe(1400);
  });

  it("the origin falls back to the bottom edge once the finger's row is gone", () => {
    const bottom = 1000 + 844 - 8;
    expect(waveOriginY("finger", 200, 1000, 844)).toBe(bottom); // vertex off the top
    expect(waveOriginY("finger", 9000, 1000, 844)).toBe(bottom); // and off the bottom
    expect(waveOriginY("bottom", 1400, 1000, 844)).toBe(bottom); // forced
  });

  it("survives a viewport with no room in it", () => {
    expect(Number.isFinite(waveOriginY("finger", 10, 0, 0))).toBe(true);
    expect(Number.isFinite(waveOriginY("bottom", 10, 0, 4))).toBe(true);
  });
});
