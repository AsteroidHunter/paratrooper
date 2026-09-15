// What "Ripple from the finger" must actually do, driven through the same call
// sequence the page runs (playground.ts's step): the field is framed, then its
// lag, phase, vertex and window are read off it, then the ripple is framed with
// them. Nothing here restates the implementation; every assertion is a claim
// about what a reader sees - which bubble moves first, whether any of them cross,
// whether the thread ever finishes - and the ones that matter most are held
// against the shipped field over the very same frames.

import { describe, expect, it } from "vitest";
import { createTunedSpringField, defaultFieldTunables } from "../src/springfield";
import type { FieldTunables } from "../src/springfield";
import { createRipple, defaultRippleTuning, rippleDelay, rippleFraction } from "../src/ripple";
import type { RippleTuning } from "../src/ripple";
import type { SpringRow } from "../src/vendor/springscroll";
import { FRAME_MS, makeRows } from "./harness";

interface Reading {
  t: number;
  scroll: number;
  lag: number;
  phase: string;
  state: string;
  /** the ripple's placement for this frame */
  disp: Map<number, number>;
  /** the shipped field's own placement for the same frame */
  base: Map<number, number>;
  lo: number;
  hi: number;
}

interface RippleHarnessOptions {
  rows?: SpringRow[];
  clientH?: number;
  threadTop?: number;
  tune?: Partial<RippleTuning>;
  field?: Partial<FieldTunables>;
  scroll?: number;
}

/** the page's step(), minus the DOM: field first, ripple fed off it */
function rippleHarness(opts: RippleHarnessOptions = {}) {
  const rows = opts.rows ?? makeRows(140);
  const clientH = opts.clientH ?? 844;
  const threadTop = opts.threadTop ?? 0;
  const tune: RippleTuning = { ...defaultRippleTuning(), ...opts.tune };
  const fieldT: FieldTunables = { ...defaultFieldTunables(), ...opts.field };

  const field = createTunedSpringField(() => fieldT);
  const ripple = createRipple();
  field.measure(rows);

  let now = 0;
  let scroll = opts.scroll ?? 3000;
  const log: Reading[] = [];

  function frame(dScroll = 0, fingerY?: number, dt = FRAME_MS): Reading {
    now += dt;
    scroll += dScroll;
    if (fingerY !== undefined) field.anchor(fingerY);
    field.frame(now, scroll);
    const win = field.window();
    const base = field.displacements();
    const disp = ripple.frame({
      nowMs: now,
      dt,
      fieldLag: field.lag(),
      phase: field.phase(),
      vertexY: field.vertex(),
      scrollTop: scroll,
      clientH,
      rows,
      lo: win ? win.lo : 0,
      hi: win ? win.hi : -1,
      tune,
      field: fieldT,
    });
    const r: Reading = {
      t: now,
      scroll,
      lag: field.lag(),
      phase: field.phase(),
      state: ripple.state(),
      disp,
      base,
      lo: win ? win.lo : 0,
      hi: win ? win.hi : -1,
    };
    log.push(r);
    return r;
  }

  return {
    rows,
    clientH,
    field,
    ripple,
    tune,
    fieldT,
    log,
    get scroll() {
      return scroll;
    },
    begin(fingerY: number | null, fingerDown: boolean): void {
      field.begin(clientH, threadTop, fingerY, fingerDown);
    },
    lift(): void {
      field.lift();
    },
    frame,
    drag(speed: number, ms: number, fingerStart: number): number {
      let finger = fingerStart;
      const n = Math.round(ms / FRAME_MS);
      for (let i = 0; i < n; i++) {
        finger -= speed * FRAME_MS;
        frame(speed * FRAME_MS, finger);
      }
      return finger;
    },
    holdStill(ms: number, finger: number): void {
      const n = Math.round(ms / FRAME_MS);
      for (let i = 0; i < n; i++) frame(0, finger);
    },
    centre(i: number): number {
      return rows[i].top + rows[i].height / 2;
    },
    visible(): number[] {
      const out: number[] = [];
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].top + rows[i].height < scroll) continue;
        if (rows[i].top > scroll + clientH) break;
        out.push(i);
      }
      return out;
    },
  };
}

type RippleHarness = ReturnType<typeof rippleHarness>;

const SPEED = 1.5; // px/ms of scrollTop: a firm, ordinary drag

interface StopRun {
  h: RippleHarness;
  stopIdx: number;
  stopT: number;
  vertexY: number;
  peak: Map<number, number>;
}

/** the peak |displacement| each row reached from `from` to the end of the log */
function peaks(log: readonly Reading[], from: number): Map<number, number> {
  const out = new Map<number, number>();
  for (let k = from; k < log.length; k++) {
    for (const [i, dy] of log[k].disp) {
      const m = Math.abs(dy);
      if (m > (out.get(i) ?? 0)) out.set(i, m);
    }
  }
  return out;
}

/** a 1:1 drag one way, then the finger stops travelling but stays on the glass:
    the braked stop the whole effect is tuned on */
function driveAndStop(opts: {
  dir: 1 | -1;
  tune?: Partial<RippleTuning>;
  field?: Partial<FieldTunables>;
  driveMs?: number;
  holdMs?: number;
  speed?: number;
}): StopRun {
  const speed = opts.speed ?? SPEED;
  const driveMs = opts.driveMs ?? 220;
  // the ripple ships defaulting its trail and return to 33 ms, which is what the
  // live app runs; drive it there unless a case asks otherwise
  const h = rippleHarness({ tune: opts.tune, field: { tau: 33, ...opts.field } });
  const finger0 = opts.dir === 1 ? 700 : 150;
  h.begin(finger0, true);
  h.frame(0, finger0); // the gesture's first frame is a baseline reading
  const fingerEnd = h.drag(opts.dir * speed, driveMs, finger0);
  const stopIdx = h.log.length; // the first frame of the hold
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
 * the rows worth looking at, ordered by how far ABOVE the vertex they sit.
 * Walking up the thread the numbers should rise: the near rows are further home.
 */
function remainingAbove(
  run: StopRun,
  ms: number,
  minPeak = 1.5,
  which: "ripple" | "base" = "ripple",
): { d: number; left: number }[] {
  const frame = at(run, ms);
  const map = which === "ripple" ? frame.disp : frame.base;
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

function ladderSpread(l: { left: number }[]): number {
  return Math.max(...l.map((x) => x.left)) - Math.min(...l.map((x) => x.left));
}

/** the worst single-frame move any visible row made over a slice, for the ripple
    and for the shipped field over the same frames */
function worstStep(h: RippleHarness, from: number): { travel: number; base: number } {
  let travel = 0;
  let base = 0;
  const seen = h.visible();
  for (let k = Math.max(from, 1); k < h.log.length; k++) {
    for (const i of seen) {
      travel = Math.max(travel, Math.abs((h.log[k].disp.get(i) ?? 0) - (h.log[k - 1].disp.get(i) ?? 0)));
      base = Math.max(base, Math.abs((h.log[k].base.get(i) ?? 0) - (h.log[k - 1].base.get(i) ?? 0)));
    }
  }
  return { travel, base };
}

function converged(h: RippleHarness): boolean {
  const last = h.log[h.log.length - 1];
  return last.disp.size === 0 && !h.ripple.active() && h.field.lag() === 0;
}

describe("the delay and the release curve on their own", () => {
  it("the delay grows the same rate both ways and stops at the cap", () => {
    expect(rippleDelay(1000, 1000, 0.15, 260)).toBe(0);
    expect(rippleDelay(900, 1000, 0.15, 260)).toBeCloseTo(100 * 0.15, 10);
    // below the finger grows at the SAME rate as above it: the ripple is
    // symmetric, unlike the travelling settle
    expect(rippleDelay(1100, 1000, 0.15, 260)).toBeCloseTo(100 * 0.15, 10);
    expect(rippleDelay(900, 1000, 0.15, 260)).toBeCloseTo(rippleDelay(1100, 1000, 0.15, 260), 10);
    // and it caps
    expect(rippleDelay(-100000, 1000, 0.15, 260)).toBe(260);
    expect(rippleDelay(100000, 1000, 0.15, 260)).toBe(260);
  });

  it("the release curve is the field's own exp(-t/tau): starts at 1, only falls", () => {
    expect(rippleFraction(0, 33)).toBe(1);
    expect(rippleFraction(-5, 33)).toBe(1); // before its turn it holds
    expect(rippleFraction(33, 33)).toBeCloseTo(Math.exp(-1), 10);
    let last = 1;
    for (let u = 0; u <= 400; u += FRAME_MS) {
      const f = rippleFraction(u, 33);
      expect(f).toBeLessThanOrEqual(last + 1e-12); // never grows: no overshoot
      expect(f).toBeGreaterThanOrEqual(0);
      last = f;
    }
    expect(rippleFraction(400, 33)).toBeLessThan(0.01);
  });
});

describe("while the scroll is driven the ripple IS the live baseline", () => {
  // the property the whole option rests on: the drag feels like the shipped app
  // to the last digit, and the ripple can only differ AFTER the stop
  function drag(deliver: (i: number) => number, opts?: RippleHarnessOptions, frames = 40) {
    const h = rippleHarness(opts);
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

  for (const tau of [33, 45, 20]) {
    it(`a continuously driven drag draws the baseline's picture, to the bit (tau ${tau})`, () => {
      const h = drag(SMOOTH, { field: { tau } });
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
  }
});

describe("the stop: no hold, and a ripple out from the finger", () => {
  for (const dir of [1, -1] as const) {
    const name = dir === 1 ? "dragging toward newer" : "dragging toward older";

    it(`${name}: the rows under the finger are already moving on the first frame`, () => {
      const run = driveAndStop({ dir });
      const first = run.h.log[run.stopIdx]; // the very first frame of the hold
      const lastDriven = run.h.log[run.stopIdx - 1];
      expect(first.phase === "settling" || first.phase === "coasting").toBe(true);

      // a near-vertex row that carried real stretch has ALREADY left its stop
      // pose on this first frame: there is no hold anywhere near the finger
      const near = run.h
        .visible()
        .filter((i) => (run.peak.get(i) ?? 0) >= 3)
        .map((i) => ({ i, d: Math.abs(run.h.centre(i) - run.vertexY) }))
        .sort((a, b) => a.d - b.d)[0];
      expect(near, "a stretched row near the finger").toBeTruthy();
      const before = Math.abs(lastDriven.disp.get(near.i) ?? 0);
      const after = Math.abs(first.disp.get(near.i) ?? 0);
      expect(after).toBeLessThan(before - 0.3); // it moved home, on frame one

      // and the far rows are NOT: they are still holding most of what they had,
      // which is the whole difference from the baseline that drops them together
      const farLeft = remainingAbove(run, run.h.log[run.stopIdx].t - run.stopT, 3);
      expect(farLeft.length).toBeGreaterThanOrEqual(4);
      expect(farLeft[farLeft.length - 1].left).toBeGreaterThan(0.85);
    });

    it(`${name}: walking up from the finger, each row holds more of its stretch`, () => {
      const run = driveAndStop({ dir });
      const ladder = remainingAbove(run, 50);
      expect(ladder.length).toBeGreaterThanOrEqual(5);
      // ordered: no row is further along its return than one nearer the finger
      // (a little slack for the strain bound's own curvature)
      for (let k = 1; k < ladder.length; k++) {
        expect(ladder[k].left).toBeGreaterThanOrEqual(ladder[k - 1].left - 0.03);
      }
      // and the spread is a real one, not a rounding difference
      expect(ladderSpread(ladder)).toBeGreaterThan(0.45);
      expect(ladder[0].left).toBeLessThan(0.5);
      expect(ladder[ladder.length - 1].left).toBeGreaterThan(0.8);

      // THE COMPARISON THAT MATTERS. The baseline melts every row on one
      // exp(-t/tau), so its ladder is nearly flat; the ripple's is not.
      const control = remainingAbove(run, 50, 1.5, "base");
      expect(ladderSpread(control)).toBeLessThan(0.2);
      expect(ladderSpread(ladder) - ladderSpread(control)).toBeGreaterThan(0.3);

      // and in pixels, which is what a reader has: the two scenes are tens of px
      // apart, not a few percent
      const shot = at(run, 50);
      let biggest = 0;
      for (const i of run.h.visible()) {
        const d = Math.abs((shot.disp.get(i) ?? 0) - (shot.base.get(i) ?? 0));
        if (d > biggest) biggest = d;
      }
      expect(biggest).toBeGreaterThan(4);
    });

    it(`${name}: every row ends exactly on its seat`, () => {
      const run = driveAndStop({ dir });
      expect(converged(run.h)).toBe(true);
    });
  }

  it("wave speed at zero lands the whole thread together, like the baseline", () => {
    // the control: everything else identical, only the stagger off, and with it
    // off the ordering has to collapse onto the baseline's near-flat ladder
    for (const dir of [1, -1] as const) {
      const run = driveAndStop({ dir, tune: { waveMsPer100px: 0 } });
      const ladder = remainingAbove(run, 33);
      expect(ladder.length).toBeGreaterThanOrEqual(5);
      expect(ladderSpread(ladder)).toBeLessThan(0.15);
      expect(converged(run.h)).toBe(true);
    }
  });

  it("no row ever opposes another: every displacement carries the scroll's sign", () => {
    for (const dir of [1, -1] as const) {
      const run = driveAndStop({ dir });
      for (let k = run.stopIdx; k < run.h.log.length; k++) {
        for (const dy of run.h.log[k].disp.values()) {
          // no overshoot and no bounce: the release only ever melts toward the
          // seat, so nothing crosses to the far side of it
          if (dir === 1) expect(dy).toBeGreaterThan(-0.011);
          else expect(dy).toBeLessThan(0.011);
        }
      }
    }
  });
});

describe("bubbles keep document order and never touch", () => {
  it("at any wave speed, either direction, no pair closes past the floor", () => {
    for (const tune of [
      {},
      { waveMsPer100px: 0 },
      { waveMsPer100px: 60 },
      { waveMsPer100px: 30 },
    ]) {
      for (const dir of [1, -1] as const) {
        const run = driveAndStop({ dir, tune, speed: 3, holdMs: 1800 });
        for (const frame of run.h.log) {
          const disp = frame.disp;
          for (let i = frame.lo; i + 1 <= frame.hi; i++) {
            const a = run.h.rows[i];
            const b = run.h.rows[i + 1];
            const rest = b.top - (a.top + a.height);
            const now = b.top + (disp.get(i + 1) ?? 0) - (a.top + a.height + (disp.get(i) ?? 0));
            expect(now).toBeGreaterThan(Math.min(rest, run.h.fieldT.gapMin) - 0.02);
          }
        }
      }
    }
  });
});

describe("the ripple is not over until the delayed rows are", () => {
  for (const dir of [1, -1] as const) {
    it(`${dir === 1 ? "up" : "down"}: no row is cut off part way home`, () => {
      const run = driveAndStop({ dir, speed: 0.6, driveMs: 360, holdMs: 2000 });
      let cliff = 0;
      for (let k = run.stopIdx; k < run.h.log.length; k++) {
        for (const i of run.h.visible()) {
          const now = Math.abs(run.h.log[k].disp.get(i) ?? 0);
          const prev = Math.abs(run.h.log[k - 1].disp.get(i) ?? 0);
          if (now === 0 && prev > cliff) cliff = prev;
        }
      }
      // the map may only drop a row once it is under the DOM's own rounding
      expect(cliff).toBeLessThan(0.5);
    });
  }

  it("keeps asking for frames while rows up the thread are still waiting", () => {
    const run = driveAndStop({ dir: -1, speed: 0.6, driveMs: 360, tune: { waveMsPer100px: 40 }, holdMs: 2000 });
    let restIdx = -1;
    for (let k = run.stopIdx; k < run.h.log.length; k++) {
      if (run.h.log[k].lag === 0) {
        restIdx = k;
        break;
      }
    }
    expect(restIdx).toBeGreaterThan(run.stopIdx);
    // the field's own lag is home, but rows up the thread are still holding
    expect(run.h.log[restIdx].disp.size).toBeGreaterThan(0);
    expect(run.h.log[restIdx].state).toBe("holding");
    expect(converged(run.h)).toBe(true);
  });
});

describe("interruptions hand back without a jump", () => {
  it("a finger landing mid-ripple does not throw the rows", () => {
    const h = rippleHarness();
    h.begin(700, true);
    h.frame(0, 700);
    h.drag(SPEED, 220, 700);
    h.lift();
    for (let i = 0; i < 12; i++) h.frame(SPEED * FRAME_MS * 0.7); // the coast
    const before = h.log.length;
    h.begin(420, true); // a finger lands, and holds
    h.holdStill(900, 420);
    const w = worstStep(h, before);
    // no worse than the shipped field over the very same frames
    expect(w.travel).toBeLessThanOrEqual(w.base * 1.35 + 1);
    expect(converged(h)).toBe(true);
  });

  it("a reversal that interrupts a RELEASE does not drop the pose in one frame", () => {
    // the sharp case travelsettle was hardened against: drag, hold long enough
    // that the release is under way but not finished, then reverse on alternate
    // frames the way a browser delivers it
    for (const dir of [1, -1] as const) {
      const h = rippleHarness();
      const finger0 = dir === 1 ? 675 : 170;
      h.begin(finger0, true);
      h.frame(0, finger0);
      const turn = h.drag(dir * SPEED, 16 * FRAME_MS, finger0);
      h.holdStill(70, turn); // the release starts, and is not finished
      const before = h.log.length;
      let finger = turn;
      for (let k = 0; k < 20; k++) {
        const step = k % 2 === 0 ? -dir * SPEED * FRAME_MS * 2 : 0;
        finger -= step;
        h.frame(step, finger);
      }
      h.holdStill(1200, finger);

      // the release really was interrupted: rows were still off their seats
      let carried = 0;
      for (const dy of h.log[before - 1].disp.values()) carried = Math.max(carried, Math.abs(dy));
      expect(carried, `${dir}: nothing was being held`).toBeGreaterThan(4);

      // the hand-back frame itself, the single frame the drive takes the thread
      // back: a row moves by about what the shipped field moved it by, not the
      // whole chain re-landing in 16.7 ms
      let hand = -1;
      for (let k = before; k < h.log.length; k++) {
        const was = h.log[k - 1].state;
        if (h.log[k].state === "driven" && (was === "holding" || was === "settling")) {
          hand = k;
          break;
        }
      }
      expect(hand, `${dir}: the release was never handed back`).toBeGreaterThan(0);

      // over every frame of the reversal, and on the hand-back frame in
      // particular, the ripple does not ADD to the field's own large steps
      const w = worstStep(h, before);
      expect(
        w.travel,
        `${dir}: all ${w.travel.toFixed(2)} vs base ${w.base.toFixed(2)}`,
      ).toBeLessThanOrEqual(w.base * 1.35 + 1);
      expect(converged(h)).toBe(true);
    }
  });
});

describe("the ripple stays finite and lands, across the parameter range", () => {
  const cases: { name: string; tune?: Partial<RippleTuning>; field?: Partial<FieldTunables> }[] = [
    { name: "no stagger", tune: { waveMsPer100px: 0 } },
    { name: "fastest wave", tune: { waveMsPer100px: 60 } },
    { name: "shortest trail time", field: { tau: 10 } },
    { name: "longest trail time", field: { tau: 140 } },
    { name: "shortest reach", field: { divisor: 120 } },
    { name: "longest reach", field: { divisor: 1200 } },
    { name: "tightest strain bound", field: { strain: 2 } },
    { name: "loosest strain bound", field: { strain: 40 } },
  ];
  for (const c of cases) {
    it(`${c.name}: finite the whole way and home at the end`, () => {
      const run = driveAndStop({ dir: 1, tune: c.tune, field: c.field, holdMs: 3000 });
      for (const r of run.h.log) {
        for (const dy of r.disp.values()) expect(Number.isFinite(dy)).toBe(true);
      }
      expect(converged(run.h)).toBe(true);
    });
  }

  it("a long coast that carries the finger off screen still stays ordered and lands", () => {
    const h = rippleHarness({ scroll: 600 });
    h.begin(700, true);
    h.frame(0, 700);
    let finger = 700;
    for (let i = 0; i < Math.round(1200 / FRAME_MS); i++) {
      finger = finger > 60 ? finger - 4 : 700;
      h.frame(2 * FRAME_MS, finger);
    }
    const vertexY = h.field.vertex();
    expect(vertexY).toBeLessThan(h.scroll - 1000); // really gone off the top
    const stopIdx = h.log.length;
    const stopT = h.log[stopIdx - 1].t;
    h.holdStill(1600, finger);
    const run: StopRun = { h, stopIdx, stopT, vertexY, peak: peaks(h.log, stopIdx - 3) };
    // the wave falls back to the bottom edge and runs up from there
    const frame = at(run, 40);
    const visible = h.visible().filter((i) => (run.peak.get(i) ?? 0) >= 1.5);
    expect(visible.length).toBeGreaterThanOrEqual(5);
    const left = visible.map((i) => ({
      y: h.centre(i),
      left: Math.abs(frame.disp.get(i) ?? 0) / (run.peak.get(i) as number),
    }));
    expect(left[left.length - 1].left).toBeLessThan(left[0].left + 0.02); // bottom no less home than top
    expect(converged(h)).toBe(true);
  });
});
