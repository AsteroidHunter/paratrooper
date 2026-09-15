// Pins for the springy transcript, third build (springscroll.ts): the numbers
// measured off the owner's screen recording of Messages itself (the wiki agent
// notes hold the tables). Each bubble trails the scroll by a first-order lag
// with a ~45 ms time constant, scaled by its distance from the finger over
// 500 px; a steady drag holds speed x tau x resistance of stretch; the return
// starts on the next frame after the stop, is 90% done in ~105 ms and never
// overshoots; a paused finger lets the stretch melt; a fling's lag tracks the
// decaying speed and is gone with it; rows never overlap (a 2 px floor); the
// effect is held at zero while the app owns a motion. The pure field is
// unit-tested directly; the main.ts wiring is source-pinned like
// flight.test.ts / shift.test.ts, because main.ts boots a real shell at import
// and cannot load under node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LAG_PER_SPEED_MS,
  LAG_TAU_MEASURED_MS,
  TUNING,
  atRest,
  createSpringField,
  profileFor,
  relaxLag,
  resistanceFor,
  speedOver,
  windowBounds,
} from "../src/springscroll";
import type { SpringField, SpringRow } from "../src/springscroll";

const src = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const FRAME = 1000 / 60;
const TAU = TUNING.LAG_TAU_MS;

describe("the tunables — measured off the Messages recording, in one place", () => {
  it("is the measured lag: 500 px per unit of resistance, resistance clamped to 1, run at the selected 33 ms", () => {
    expect(TUNING.RESISTANCE_DIVISOR).toBe(500); // fitted 430–500 CSS px
    expect(TUNING.RESISTANCE_MAX).toBe(1);
    // the recording's own fit is untouched and still on the record
    expect(LAG_TAU_MEASURED_MS).toBe(45); // measured 36–47 ms, 45 at the centre
    // and this build runs at the trail and return time it was ASKED for, which
    // is deliberately below that band rather than a new measurement of it
    expect(TUNING.LAG_TAU_MS).toBe(33);
    expect(TUNING.LAG_TAU_MS).toBeLessThan(36);
  });

  it("the steady lag per unit of scroll speed is the time constant itself (a first-order lag, not a spring)", () => {
    expect(LAG_PER_SPEED_MS).toBe(TUNING.LAG_TAU_MS);
    expect(LAG_PER_SPEED_MS).toBeGreaterThan(30);
    expect(LAG_PER_SPEED_MS).toBeLessThan(60);
  });

  it("the overlap guard is a small absolute floor, the ceiling is a sanity bound, and the window is wider than the ceiling", () => {
    expect(TUNING.GAP_MIN_PX).toBeGreaterThan(0);
    expect(TUNING.GAP_MIN_PX).toBeLessThanOrEqual(4); // under the tightest real gap (a continuation, 4px)
    expect(TUNING.STRETCH_CAP_PX).toBeGreaterThanOrEqual(200); // a finger never reaches it: 6.7 px/ms
    expect(TUNING.PARTICIPATION_BUFFER_PX).toBeGreaterThan(TUNING.STRETCH_CAP_PX); // entry and exit happen off screen
  });

  it("carries no beat, no hold and no spring: the second build's knobs are gone", () => {
    const t = TUNING as Record<string, unknown>;
    for (const gone of ["STOP_QUIET_MS", "RELEASE_BEAT_MS", "FREQUENCY_HZ", "DAMPING_RATIO", "GAP_CLOSE_MAX"]) {
      expect(t[gone]).toBeUndefined();
    }
  });
});

describe("resistanceFor — linear in the distance from the finger, saturating at 1", () => {
  it("is zero under the finger and grows linearly with distance", () => {
    expect(resistanceFor(0)).toBe(0);
    expect(resistanceFor(100)).toBeCloseTo(0.2, 9);
    expect(resistanceFor(300)).toBeCloseTo(0.6, 9);
    expect(resistanceFor(450)).toBeCloseTo(0.9, 9);
  });

  it("is symmetric above and below the finger (the measured V)", () => {
    expect(resistanceFor(-300)).toBe(resistanceFor(300));
  });

  it("saturates: rows beyond the divisor trail alike, so two far rows keep their gap", () => {
    expect(resistanceFor(500)).toBe(1);
    expect(resistanceFor(900)).toBe(1);
    expect(resistanceFor(1e9)).toBe(1);
  });
});

describe("relaxLag — the first-order lag, exact for any frame length", () => {
  it("a steady drag settles at exactly speed x tau", () => {
    let L = 0;
    for (let k = 0; k < 60; k++) L = relaxLag(L, 0.5 * FRAME, FRAME); // 0.5 px/ms for a second
    expect(L).toBeCloseTo(0.5 * TAU, 6);
    let fast = 0;
    for (let k = 0; k < 60; k++) fast = relaxLag(fast, 2.0 * FRAME, FRAME);
    expect(fast).toBeCloseTo(2.0 * TAU, 6); // proportional to speed, no cap short of the ceiling
  });

  it("does not depend on the frame rate: one 33 ms frame lands where two 17 ms frames do", () => {
    const one = relaxLag(30, 2 * 0.7 * FRAME, 2 * FRAME);
    const two = relaxLag(relaxLag(30, 0.7 * FRAME, FRAME), 0.7 * FRAME, FRAME);
    expect(one).toBeCloseTo(two, 9);
  });

  it("after a stop it decays as exp(-t/tau): a third gone by the next frame, 63% at tau, 90% at 2.3 tau, never through zero", () => {
    const first = relaxLag(100, 0, FRAME);
    expect(100 - first).toBeCloseTo(100 * (1 - Math.exp(-FRAME / TAU)), 6);
    expect(100 - first).toBeGreaterThan(25); // the recording: 34–36% gone one frame after the stop
    expect(100 - first).toBeLessThan(40);
    expect(relaxLag(100, 0, TAU)).toBeCloseTo(100 * Math.exp(-1), 6);
    expect(relaxLag(100, 0, TAU * Math.log(10))).toBeCloseTo(10, 6);
    let L = 100;
    for (let k = 0; k < 120; k++) {
      L = relaxLag(L, 0, FRAME);
      expect(L).toBeGreaterThan(0); // no overshoot, ever
    }
    expect(L).toBeLessThan(0.25);
  });

  it("a non-positive dt injects the delta whole (no time has passed to relax over)", () => {
    expect(relaxLag(10, 5, 0)).toBe(15);
  });
});

describe("atRest — home is sub-visible", () => {
  it("is true only under a quarter pixel", () => {
    expect(atRest(0.2)).toBe(true);
    expect(atRest(-0.2)).toBe(true);
    expect(atRest(0.3)).toBe(false);
  });
});

describe("windowBounds — only near the viewport", () => {
  it("spans the visible band widened by the buffer each way", () => {
    const [lo, hi] = windowBounds(1000, 800);
    expect(lo).toBe(1000 - TUNING.PARTICIPATION_BUFFER_PX);
    expect(hi).toBe(1000 + 800 + TUNING.PARTICIPATION_BUFFER_PX);
  });
});

// --- a synthetic thread ------------------------------------------------------------
// 40px bubbles; gaps alternate 4px (a continuation) and 12px (a sender change),
// the two real gaps of styles.css. Viewport 700px, the thumb 75% down it: the
// row at the top of the viewport is ~505px from the thumb, past the divisor,
// so it carries the reference lag whole.
function makeThread(n = 80): SpringRow[] {
  const rows: SpringRow[] = [];
  let top = 0;
  for (let i = 0; i < n; i++) {
    rows.push({ top, height: 40 });
    top += 40 + (i % 2 === 0 ? 4 : 12);
  }
  return rows;
}
const CLIENT_H = 700;
const THREAD_TOP = 0;
const THUMB = 525; // screen-Y of the finger
const START = 1500; // scrollTop at the grab

function gapBetween(rows: readonly SpringRow[], i: number): number {
  return rows[i + 1].top - (rows[i].top + rows[i].height);
}

/** the row whose seat sits at the top of the viewport at scrollTop */
function topRowAt(rows: readonly SpringRow[], scrollTop: number): number {
  return rows.findIndex((r) => r.top + r.height > scrollTop);
}

interface Drive {
  f: SpringField;
  rows: SpringRow[];
  now: number;
  scrollTop: number;
  /** where the finger is on the glass now */
  fingerY: number;
  /** the vertex in CONTENT space: the row the gesture was started on. The field
      reads this once, on the gesture's first frame, and it rides the thread from
      there, so under a 1:1 drag it stays under the finger by itself. */
  vertex: number;
}

function grab(rows = makeThread(), scrollTop = START): Drive {
  const f = createSpringField();
  f.measure(rows);
  f.begin(CLIENT_H, THREAD_TOP, THUMB, true);
  const d: Drive = {
    f,
    rows,
    now: 0,
    scrollTop,
    fingerY: THUMB,
    vertex: scrollTop + (THUMB - THREAD_TOP),
  };
  f.frame(d.now, d.scrollTop); // the baseline frame: it seats the vertex
  return d;
}

/** a constant-speed FINGER drag, px/ms; dir -1 = toward older (scrollTop falls,
    so the finger travels DOWN the glass). The finger rides the content and is
    re-anchored every frame, which is what the wiring does on every touchmove —
    a drag in which the scroll moves and the finger does not is not a thing a
    hand can do, and pretending otherwise hid the vertex's own behaviour. */
function drag(d: Drive, speed: number, ms: number, dir: -1 | 1): void {
  const frames = Math.round(ms / FRAME);
  for (let k = 0; k < frames; k++) {
    d.now += FRAME;
    d.scrollTop += dir * speed * FRAME;
    d.fingerY -= dir * speed * FRAME;
    d.f.anchor(d.fingerY);
    d.f.frame(d.now, d.scrollTop);
  }
}

/** the thread carrying on under its own momentum: no finger, so nothing
    re-anchors and the vertex stays on the content the finger left it on */
function coast(d: Drive, speed: number, ms: number, dir: -1 | 1): void {
  const frames = Math.round(ms / FRAME);
  for (let k = 0; k < frames; k++) {
    d.now += FRAME;
    d.scrollTop += dir * speed * FRAME;
    d.f.frame(d.now, d.scrollTop);
  }
}

/** the scroll is still: run frames, returning the per-frame top-row lag */
function stillFrames(d: Drive, ms: number, row: number): number[] {
  const out: number[] = [];
  const frames = Math.round(ms / FRAME);
  for (let k = 0; k < frames; k++) {
    d.now += FRAME;
    d.f.frame(d.now, d.scrollTop);
    out.push(d.f.displacements().get(row) ?? 0);
  }
  return out;
}

function maxAbs(m: Map<number, number>): number {
  return Math.max(0, ...[...m.values()].map(Math.abs));
}

describe("createSpringField — zero at rest", () => {
  it("displaces nothing before any scroll, and a still hold idles at once", () => {
    const d = grab();
    expect(d.f.displacements().size).toBe(0);
    stillFrames(d, 200, 0);
    expect(d.f.active()).toBe(false); // no frames wanted
    expect(d.f.armed()).toBe(true); // but the finger is still down
    expect(d.f.phase()).toBe("idle");
    expect(d.f.displacements().size).toBe(0);
  });

  it("the first frame of a gesture is a baseline: no delta from before it", () => {
    const f = createSpringField();
    f.measure(makeThread());
    f.begin(CLIENT_H, THREAD_TOP, THUMB, true);
    f.frame(0, 2500); // wherever the thread already was
    expect(f.lag()).toBe(0);
    expect(f.displacements().size).toBe(0);
  });

  it("an unarmed frame with a delta (an app write, nobody touching) injects nothing", () => {
    const f = createSpringField();
    f.measure(makeThread());
    f.frame(0, 1000);
    f.frame(FRAME, 1400);
    expect(f.lag()).toBe(0);
    expect(f.active()).toBe(false);
  });
});

describe("createSpringField — the stretch is speed x tau x resistance, there within a few frames", () => {
  it("a steady drag lags the top row by speed x tau: 22.5px at 0.5 px/ms, 45px at 1 px/ms", () => {
    const slow = grab();
    drag(slow, 0.5, 300, -1);
    const fast = grab();
    drag(fast, 1.0, 300, -1);
    const topSlow = Math.abs(slow.f.displacements().get(topRowAt(slow.rows, slow.scrollTop)) ?? 0);
    const topFast = Math.abs(fast.f.displacements().get(topRowAt(fast.rows, fast.scrollTop)) ?? 0);
    expect(topSlow).toBeCloseTo(0.5 * TAU, 0); // 300ms of drag: 99.9% of steady
    expect(topFast).toBeCloseTo(1.0 * TAU, 0);
    expect(topFast / topSlow).toBeCloseTo(2, 2); // proportional to speed
  });

  it("the stretch is there within a few frames, not built over a fraction of a second", () => {
    const d = grab();
    const lags: number[] = [];
    for (let k = 0; k < 12; k++) {
      drag(d, 0.5, FRAME, -1);
      lags.push(Math.abs(d.f.lag()));
    }
    for (let k = 1; k < lags.length; k++) expect(lags[k]).toBeGreaterThan(lags[k - 1]);
    // 100ms in (6 frames): 89% of steady; the second build was near a third
    expect(lags[5]).toBeGreaterThan(0.5 * TAU * 0.85);
    expect(lags[11]).toBeGreaterThan(0.5 * TAU * 0.98);
  });

  it("the profile is a V on the finger: each row trails by distance/500 of the reference lag, saturating beyond 500", () => {
    const d = grab();
    drag(d, 1.0, 300, -1);
    const L = d.f.lag();
    const disp = d.f.displacements();
    const anchorContent = d.vertex;
    let sawSaturated = 0;
    for (const [i, dy] of disp) {
      const dist = Math.abs(d.rows[i].top + d.rows[i].height / 2 - anchorContent);
      if (d.rows[i].top + d.rows[i].height / 2 < anchorContent) {
        // the stretching side (above the finger, scrolling toward older): the pure profile
        expect(dy).toBeCloseTo(resistanceFor(dist) * L, 6);
        if (dist >= TUNING.RESISTANCE_DIVISOR) sawSaturated++;
      }
    }
    expect(sawSaturated).toBeGreaterThan(0);
    // two saturated rows keep their gap; two rows inside the divisor open by spacing x L / 500
    const above = [...disp.keys()]
      .filter((i) => d.rows[i].top + d.rows[i].height / 2 < anchorContent)
      .sort((a, b) => a - b);
    const change = (i: number) => (disp.get(i + 1) ?? 0) - (disp.get(i) ?? 0);
    const far = above.filter((i) => Math.abs(d.rows[i + 1].top + 20 - anchorContent) >= TUNING.RESISTANCE_DIVISOR);
    for (const i of far) expect(change(i)).toBeCloseTo(0, 6);
    const near = above.filter(
      (i) => d.rows[i + 1].top + 20 < anchorContent && Math.abs(d.rows[i].top + 20 - anchorContent) < TUNING.RESISTANCE_DIVISOR - 60,
    ); // both rows above the finger and inside the divisor: no fold, no saturation
    expect(near.length).toBeGreaterThan(3);
    for (const i of near) {
      const spacing = d.rows[i + 1].top + 20 - (d.rows[i].top + 20);
      expect(change(i)).toBeCloseTo((spacing * Math.abs(L)) / TUNING.RESISTANCE_DIVISOR, 6); // opening
    }
  });

  it("the gaps open by a few px each and the far rows by tens: the recording's 0.09 ms/px at 1 px/ms", () => {
    const d = grab();
    drag(d, 1.0, 300, -1);
    const disp = d.f.displacements();
    const anchorContent = d.vertex;
    let widest = 0;
    for (let i = 0; i < d.rows.length - 1; i++) {
      if (!disp.has(i) || !disp.has(i + 1)) continue;
      if (d.rows[i + 1].top + 20 > anchorContent) continue;
      widest = Math.max(widest, (disp.get(i + 1) ?? 0) - (disp.get(i) ?? 0));
    }
    // a 52px spacing (40 + a 12px sender gap) opens by 52 x 45 / 500 = 4.7px
    expect(widest).toBeCloseTo((52 * TAU) / 500, 1);
    expect(Math.abs(disp.get(topRowAt(d.rows, d.scrollTop)) ?? 0)).toBeCloseTo(TAU, 0); // the top row, 45px
  });

  it("only rows near the viewport participate; far rows are exactly zero", () => {
    const d = grab();
    drag(d, 1.0, 300, -1);
    const disp = d.f.displacements();
    const [lo, hi] = windowBounds(d.scrollTop, CLIENT_H);
    for (let i = 0; i < d.rows.length; i++) {
      const r = d.rows[i];
      const inWindow = r.top + r.height >= lo && r.top <= hi;
      if (!inWindow) expect(disp.has(i)).toBe(false);
    }
    expect(disp.size).toBeGreaterThan(10);
    expect(disp.size).toBeLessThanOrEqual(36); // bounded by the window, not the thread
  });

  it("the ceiling: only a fling past STRETCH_CAP_PX / tau reaches it, and no hand goes that fast", () => {
    // the speed whose steady stretch IS the ceiling: 6.7 px/ms at the measured
    // 45 ms, 9.1 px/ms at the 33 ms this build runs
    const reachesCap = TUNING.STRETCH_CAP_PX / TAU;
    expect(reachesCap).toBeGreaterThan(3.0); // past the hardest drag in the recording
    const d = grab();
    drag(d, reachesCap * 1.2, 400, -1);
    expect(Math.abs(d.f.lag())).toBeCloseTo(TUNING.STRETCH_CAP_PX, 6);
    expect(maxAbs(d.f.displacements())).toBeLessThanOrEqual(TUNING.STRETCH_CAP_PX + 1e-9);
    const finger = grab();
    drag(finger, 3.0, 400, -1); // the hardest real finger drag in the recording
    expect(Math.abs(finger.f.lag())).toBeLessThan(TUNING.STRETCH_CAP_PX * 0.5);
  });
});

describe("createSpringField — the sign, against the recording", () => {
  it("after scrolling toward older messages the rows sit above their seats and come DOWN", () => {
    const d = grab();
    drag(d, 0.5, 300, -1); // scrollTop falls: toward older
    const top = topRowAt(d.rows, d.scrollTop);
    const atStop = d.f.displacements().get(top) ?? 0;
    // the drag's own steady stretch: 22.5 px at the measured 45 ms, 16.5 at 33
    const steady = 0.5 * TAU;
    expect(atStop).toBeLessThan(-steady * 0.85); // negative translate: above its seat
    const trail = stillFrames(d, 200, top);
    expect(trail[trail.length - 1]).toBeGreaterThan(atStop); // moving down toward 0
    expect(Math.abs(trail[trail.length - 1])).toBeLessThan(Math.abs(atStop) * 0.02);
  });

  it("after scrolling toward newer messages the rows sit below their seats and come UP", () => {
    const d = grab();
    drag(d, 0.5, 300, 1);
    const disp = d.f.displacements();
    for (const dy of disp.values()) expect(dy).toBeGreaterThan(0); // every displaced row below its seat
    const bottom = [...disp.keys()].sort((a, b) => b - a)[0];
    const atStop = disp.get(bottom)!;
    const trail = stillFrames(d, 200, bottom);
    expect(trail[trail.length - 1]).toBeLessThan(atStop); // moving up toward 0
  });
});

describe("createSpringField — the return: from the next frame, 90% in a tenth of a second, no overshoot", () => {
  it("nothing waits: a third of the displacement is gone one frame after the stop", () => {
    const d = grab();
    drag(d, 0.5, 300, -1);
    const top = topRowAt(d.rows, d.scrollTop);
    const atStop = d.f.displacements().get(top)!;
    const trail = stillFrames(d, 400, top);
    const gone = (v: number) => Math.abs(atStop - v) / Math.abs(atStop);
    expect(gone(trail[0])).toBeGreaterThan(0.25); // the recording: 0.34–0.36
    expect(gone(trail[0])).toBeLessThan(0.40);
    // 63% at tau (frame 3 at 50ms), 90% by 2.3 tau (frame 7 at 117ms)
    expect(gone(trail[2])).toBeGreaterThan(0.6);
    expect(gone(trail[6])).toBeGreaterThan(0.9);
    // and visibly: the fastest frame moves several px on a 22px stretch
    let peak = 0;
    for (let k = 1; k < trail.length; k++) peak = Math.max(peak, Math.abs(trail[k] - trail[k - 1]));
    expect(peak).toBeGreaterThan(3);
  });

  it("never passes the seat, comes to exact rest with no residue, and the frames stop within 400ms", () => {
    const d = grab();
    drag(d, 1.0, 300, -1);
    const top = topRowAt(d.rows, d.scrollTop);
    const atStop = d.f.displacements().get(top)!;
    let frames = 0;
    while (d.f.active() && frames < 300) {
      d.now += FRAME;
      d.f.frame(d.now, d.scrollTop);
      const v = d.f.displacements().get(top) ?? 0;
      expect(Math.sign(v) === -Math.sign(atStop)).toBe(false); // no overshoot, ever
      frames++;
    }
    expect(d.f.active()).toBe(false);
    expect(d.f.lag()).toBe(0);
    expect(d.f.displacements().size).toBe(0);
    expect(frames * FRAME).toBeLessThan(400);
  });

  it("frames stop at rest: a stray frame after the return touches nothing", () => {
    const d = grab();
    drag(d, 0.5, 200, -1);
    stillFrames(d, 600, 0);
    expect(d.f.active()).toBe(false);
    d.f.frame(d.now + FRAME, d.scrollTop);
    expect(d.f.displacements().size).toBe(0);
  });

  it("a finger that pauses mid-drag lets the stretch melt (no hold), and moving again rebuilds it", () => {
    const d = grab();
    drag(d, 0.5, 200, -1);
    const before = Math.abs(d.f.lag());
    stillFrames(d, 100, 0); // the finger holds still on the glass
    expect(d.f.phase()).toBe("settling");
    expect(d.f.armed()).toBe(true); // the finger is still down
    expect(Math.abs(d.f.lag())).toBeLessThan(before * 0.15); // 89% melted in 100ms
    drag(d, 0.5, 100, -1);
    expect(d.f.phase()).toBe("driving");
    expect(Math.abs(d.f.lag())).toBeGreaterThan(before * 0.85); // back at the steady stretch
  });
});

describe("speedOver — the drive speed, from the readings that moved", () => {
  it("is zero until there are two readings to draw a slope through", () => {
    expect(speedOver([], 0)).toBe(0);
    expect(speedOver([{ t: 0, s: 100 }], FRAME)).toBe(0);
  });

  it("is the slope across the whole run, not across the last pair", () => {
    // 3 px over 50 ms is 0.06 px/ms however the 3 px were delivered
    const even = [{ t: 0, s: 100 }, { t: 25, s: 101.5 }, { t: 50, s: 103 }];
    const lumpy = [{ t: 0, s: 100 }, { t: 33, s: 100 }, { t: 50, s: 103 }];
    expect(speedOver(even, 50)).toBeCloseTo(0.06, 9);
    expect(speedOver(lumpy, 50)).toBeCloseTo(0.06, 9); // the lump does not spike it
  });

  it("a run whose newest reading is older than the hold is a stop, not a gap", () => {
    const run = [{ t: 0, s: 100 }, { t: 16, s: 101 }];
    expect(speedOver(run, 30, 28)).toBeCloseTo(1 / 16, 9); // 14 ms stale: still a gap
    expect(speedOver(run, 60, 28)).toBe(0); // 44 ms stale: stopped
    expect(speedOver(run, 20, 0)).toBe(0); // no budget at all: stopped at once
  });
});

describe("createSpringField — the phone delivers scrollTop on three frames in four", () => {
  // What the owner's own scroll-jank records say (2026-09-07, gestures 2 to 5):
  // 59.3 to 59.9 animation frames a second but only 31 to 39 scroll events, and
  // the position handed over quantised to whole device pixels. Driven off one
  // frame's delta the lag pulsed; driven off the run's speed it does not.
  /** a drag whose scrollTop only reaches the frame on `1 in every skip` frames,
      quantised to a device pixel, while the finger travels every frame */
  function sparseDrag(d: Drive, speed: number, ms: number, skip: number): number[] {
    const frames = Math.round(ms / FRAME);
    const Ls: number[] = [];
    let truePos = d.scrollTop;
    let fingerY = THUMB;
    for (let k = 0; k < frames; k++) {
      d.now += FRAME;
      truePos -= speed * FRAME;
      fingerY += speed * FRAME; // the finger rides the content: touchmove every frame
      d.f.anchor(fingerY);
      if (k % skip !== skip - 1) d.scrollTop = Math.round(truePos * 3) / 3; // 3x device px
      d.f.frame(d.now, d.scrollTop);
      Ls.push(d.f.lag());
    }
    return Ls;
  }

  it("a slow drag delivered on three frames in four holds the lag steady, not pulsing", () => {
    const d = grab();
    const Ls = sparseDrag(d, 0.06, 800, 4); // 1 px a frame: the speed he calls slow
    const settled = Ls.slice(20).map(Math.abs);
    const ripple = Math.max(...settled) - Math.min(...settled);
    const ideal = 0.06 * TAU; // 2.7 px
    expect(Math.max(...settled)).toBeLessThan(ideal * 1.1);
    expect(Math.min(...settled)).toBeGreaterThan(ideal * 0.9);
    // the pulse was 1.06 px on a 2.7 px stretch, a 39% swing; the run's speed
    // leaves under a tenth of a device pixel on the owner's 3x screen
    expect(ripple).toBeLessThan(0.05);
  });

  it("the same at a fling's speed, where the pulse was bigger than the stretch itself", () => {
    const d = grab();
    const Ls = sparseDrag(d, 0.24, 600, 4); // 4 px a frame
    const settled = Ls.slice(20).map(Math.abs);
    const ripple = Math.max(...settled) - Math.min(...settled);
    expect(ripple).toBeLessThan(0.2); // was 12.2 px against a 10.8 px steady stretch
  });

  it("a delivery gap is bridged, but a scroll pinned at the end of the thread is not", () => {
    const d = grab();
    sparseDrag(d, 0.06, 400, 4);
    const moving = Math.abs(d.f.lag());
    const ideal = 0.06 * TAU; // 2.7 px at the measured 45 ms, 2.0 at 33
    expect(moving).toBeGreaterThan(ideal * 0.9);
    // the finger keeps travelling but the thread has hit its end: scrollTop
    // stops for good, and the stretch melts anyway within the window
    let fingerY = THUMB + 400;
    for (let k = 0; k < 12; k++) {
      d.now += FRAME;
      fingerY += 1;
      d.f.anchor(fingerY);
      d.f.frame(d.now, d.scrollTop);
    }
    expect(Math.abs(d.f.lag())).toBeLessThan(moving * 0.15);
  });
});

describe("createSpringField — a catch keeps the vertex it had", () => {
  // Measured off the owner's Messages recording, on every cleanly tracked
  // caught coast (t = 2.077, 6.265, 27.948 and 51.823 s): the stretch melts in
  // place on the ordinary return curve, the bubble sitting at the vertex does
  // not move by a pixel through the whole return, and the worst single-frame
  // move anywhere is 3 to 4.3 CSS px on stretches of 11 and 27 CSS px. Nothing
  // jumps, and no bubble's displacement ever grows.

  /** a fast drag, a lift, a coast, then a finger landing at `catchY`.
      `vertex` is where the vertex sits in CONTENT space: the finger held it on
      that content when it lifted, and it rides with the thread from there
      rather than standing on the screen row the coast leaves behind. */
  function coastThenCatch(catchY: number): {
    d: Drive;
    before: Map<number, number>;
    vertex: number;
  } {
    const d = grab();
    drag(d, 2.0, 150, -1);
    const vertex = d.vertex; // the content the gesture was started on
    d.f.lift();
    coast(d, 1.8, 100, -1); // the thread coasts
    const before = new Map(d.f.displacements());
    d.f.begin(CLIENT_H, THREAD_TOP, catchY, true);
    d.now += FRAME;
    d.f.frame(d.now, d.scrollTop); // the catch killed the momentum: no new motion
    return { d, before, vertex };
  }

  function worstMove(before: Map<number, number>, after: Map<number, number>): number {
    let worst = 0;
    for (const i of new Set([...before.keys(), ...after.keys()])) {
      worst = Math.max(worst, Math.abs((after.get(i) ?? 0) - (before.get(i) ?? 0)));
    }
    return worst;
  }

  it("catching far from where the finger lifted moves the rows no more than catching on the spot", () => {
    const near = coastThenCatch(THUMB); // the finger lands where the last one left
    const far = coastThenCatch(150); // and 375 px up the screen from it
    const nearWorst = worstMove(near.before, near.d.f.displacements());
    const farWorst = worstMove(far.before, far.d.f.displacements());
    expect(nearWorst).toBeGreaterThan(15); // the return's own first frame, ~31% of the stretch
    // the vertex is what makes these differ, and it must not move: before this
    // was 70 px against 25 px, 45 px of it purely the anchor teleporting
    expect(farWorst).toBeCloseTo(nearWorst, 6);
  });

  it("no row's displacement grows on the catch frame: the profile only melts", () => {
    const { d, before } = coastThenCatch(150);
    const after = d.f.displacements();
    for (const [i, dy] of before) {
      expect(Math.abs(after.get(i) ?? 0)).toBeLessThanOrEqual(Math.abs(dy) + 1e-9);
    }
    expect(before.size).toBeGreaterThan(4);
  });

  it("the row at the old vertex stays put through the whole return, as it does in the recording", () => {
    const { d, vertex } = coastThenCatch(150);
    // the row the OLD finger was on carries almost nothing, and catching
    // elsewhere must not give it any more: in the recording the bubble at the
    // vertex moved 0 px across the whole return while a far one moved 27.
    // The row is found in CONTENT space: the vertex rides with the thread, so
    // after 180 px of coast it is no longer at the screen-Y the finger left.
    const seatRow = topRowAt(d.rows, vertex);
    const farRow = topRowAt(d.rows, d.scrollTop);
    const atCatch = Math.abs(d.f.displacements().get(seatRow) ?? 0);
    const farAtCatch = Math.abs(d.f.displacements().get(farRow) ?? 0);
    // 2.6 px against 56.7: the row spans the vertex, its centre 23 px off it,
    // so it carries 23/500 of the lag and no more. (The far row reads 56.7
    // rather than 78 now because the strain bound trims the profile's total.)
    expect(atCatch).toBeLessThan(0.06 * farAtCatch);
    let prev = atCatch;
    for (let k = 0; k < 12; k++) {
      d.now += FRAME;
      d.f.frame(d.now, d.scrollTop);
      const now = Math.abs(d.f.displacements().get(seatRow) ?? 0);
      expect(now).toBeLessThanOrEqual(prev + 1e-9); // only ever melts, never gains
      prev = now;
    }
    expect(prev).toBeLessThan(0.25);
  });

  it("the new finger takes the vertex the moment its own drag starts", () => {
    const { d } = coastThenCatch(150);
    expect(Math.abs(d.f.lag())).toBeGreaterThan(20); // still melting
    const parked = d.f.displacements();
    d.now += FRAME;
    d.f.anchor(146); // the caught finger travels: this is a drag, not a brake
    d.scrollTop -= 1.0 * FRAME;
    d.f.frame(d.now, d.scrollTop);
    const adopted = d.f.displacements();
    // the vertex has moved to the new finger, so the profile is a different
    // shape now: the row nearest the NEW anchor carries the least
    const newVertexRow = topRowAt(d.rows, d.scrollTop + (146 - THREAD_TOP));
    expect(Math.abs(adopted.get(newVertexRow) ?? 0)).toBeLessThan(
      Math.abs(parked.get(newVertexRow) ?? 0),
    );
    expect(d.f.phase()).toBe("driving");
  });

  it("a finger that lands to BRAKE keeps the parked vertex while the caught scroll runs on", () => {
    // The scroll does not stop in the frame the finger lands: on the phone the
    // coast is still being handed over for a frame or two, and that used to be
    // read as "a new drag has started", so the whole profile re-centred on the
    // new finger anyway. Measured in the browser harness on the build before
    // this one: one row jumped 22 px toward its seat on the catch frame while
    // its neighbour went 7 px the other way. A brake is a finger that has not
    // moved, so the vertex it landed near does not become the vertex.
    const { d } = coastThenCatch(150);
    const parked = new Map(d.f.displacements());
    for (let k = 0; k < 6; k++) {
      d.now += FRAME;
      d.scrollTop -= 0.4 * FRAME; // the caught coast still being handed over
      d.f.anchor(150); // the finger is ON the glass but has not travelled
      d.f.frame(d.now, d.scrollTop);
      const now = d.f.displacements();
      for (const [i, dy] of parked) {
        // nothing re-centres: no row is thrown the other way, and none gains
        expect(Math.abs(now.get(i) ?? 0)).toBeLessThan(Math.abs(dy) + 3);
        expect((now.get(i) ?? 0) * dy).toBeGreaterThanOrEqual(0); // same side of its seat
      }
    }
  });

  it("a grab of a settled thread takes its anchor at once: there is nothing to protect", () => {
    const d = grab();
    drag(d, 0.5, 200, -1);
    stillFrames(d, 400, 0); // home
    expect(d.f.lag()).toBe(0);
    d.f.begin(CLIENT_H, THREAD_TOP, 150, true);
    d.now += FRAME;
    d.f.frame(d.now, d.scrollTop);
    d.now += FRAME;
    d.scrollTop -= 1.0 * FRAME;
    d.f.frame(d.now, d.scrollTop);
    // the fresh gesture's stretch is centred on the new finger from its first frame
    const atNew = topRowAt(d.rows, d.scrollTop + (150 - THREAD_TOP));
    const far = topRowAt(d.rows, d.scrollTop);
    expect(Math.abs(d.f.displacements().get(atNew) ?? 0)).toBeLessThan(
      Math.abs(d.f.displacements().get(far) ?? 0),
    );
  });
});

// --- the owner's three, 2026-09-12 -------------------------------------------
// From ScreenRecording_09-12-2026 14-46-26_1 and from the same gestures driven
// in a real browser on this module. The three complaints and the three things
// that must stay true now.
describe("the transcript moves as one thing", () => {
  /** a thread with a real transcript's mix of bubble heights: the tall ones are
      what put a whole bubble's height of stretch into the gap beside them */
  function mixedThread(n = 900): SpringRow[] {
    const rows: SpringRow[] = [];
    let top = 0;
    let s = 7;
    const rnd = (): number => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < n; i++) {
      const height = 40 + Math.floor(rnd() * 4) * 36; // 40 to 148 px
      rows.push({ top, height });
      top += height + (rnd() < 0.6 ? 4 : 12);
    }
    return rows;
  }

  /** a flick, a lift, and a coast; the state is left mid-coast */
  function flickAndCoast(rows: SpringRow[], coastMs: number): Drive {
    const d = grab(rows, 20000);
    d.fingerY = 140; // a flick toward older starts high on the glass
    d.f.begin(CLIENT_H, THREAD_TOP, d.fingerY, true);
    d.vertex = d.scrollTop + (d.fingerY - THREAD_TOP);
    d.f.frame(d.now, d.scrollTop);
    drag(d, 1.9, 200, -1);
    d.f.lift();
    coast(d, 1.9, coastMs, -1);
    return d;
  }

  it("no row's displacement GROWS while the lag melts: the vertex rides the thread, it does not saw through it", () => {
    // The vertex used to be a screen position, so under momentum the content
    // flowed past it and every row it passed grew away from its seat while the
    // rest were coming home. Measured in the browser harness on the build before
    // this one: 21 frames of a single fling had some row growing while the lag
    // fell, the worst by 5.5 px, and on the caught coast 15.5 px.
    const d = flickAndCoast(mixedThread(), 200);
    let prev = new Map(d.f.displacements());
    let prevLag = Math.abs(d.f.lag());
    let worstGrowth = 0;
    for (let k = 0; k < 90; k++) {
      d.now += FRAME;
      d.scrollTop -= Math.max(0, 1.9 - k * 0.05) * FRAME; // the coast running down
      d.f.frame(d.now, d.scrollTop);
      const now = d.f.displacements();
      const lag = Math.abs(d.f.lag());
      if (lag < prevLag - 0.05) {
        for (const [i, dy] of prev) {
          const grew = Math.abs(now.get(i) ?? 0) - Math.abs(dy);
          worstGrowth = Math.max(worstGrowth, grew);
        }
      }
      prev = new Map(now);
      prevLag = lag;
    }
    expect(worstGrowth).toBeLessThan(0.05);
  });

  it("a braked coast lands every row together, not the ones near the finger first", () => {
    // "when I stop a scroll using my finger, the bubbles above the finger stop
    // after the bubbles at the bottom ... the stuff above seems to take half an
    // extra second to come to a halt". On the build before this one the same
    // brake left the rows stopping over a 200 ms spread, travelling anywhere
    // from 5 px to 86 px.
    const rows = mixedThread();
    const d = flickAndCoast(rows, 300);
    d.f.begin(CLIENT_H, THREAD_TOP, 640, true); // the braking finger lands low
    const onScreen = [...d.f.displacements().keys()].filter(
      (i) => rows[i].top + rows[i].height > d.scrollTop && rows[i].top < d.scrollTop + CLIENT_H,
    );
    expect(onScreen.length).toBeGreaterThan(4);
    let prev = new Map(d.f.displacements());
    const stopAt = new Map<number, number>();
    const travel = new Map<number, number>();
    for (let k = 1; k <= 42; k++) {
      d.now += FRAME;
      d.f.anchor(640); // the finger is braking: it does not travel
      d.f.frame(d.now, d.scrollTop); // and the scroller is stopped dead
      const now = d.f.displacements();
      for (const i of onScreen) {
        const moved = Math.abs((now.get(i) ?? 0) - (prev.get(i) ?? 0));
        travel.set(i, (travel.get(i) ?? 0) + moved);
        if (moved > 0.25) stopAt.set(i, k * FRAME);
      }
      prev = new Map(now);
    }
    const stops = onScreen.map((i) => stopAt.get(i) ?? 0);
    const spread = Math.max(...stops) - Math.min(...stops);
    expect(spread).toBeLessThan(2 * FRAME); // was 200 ms; the rows land together
    // and none of them is thrown further than the worst row was before
    expect(Math.max(...onScreen.map((i) => travel.get(i) ?? 0))).toBeLessThan(86);
    expect(Math.max(...stops)).toBeLessThan(400); // it is still over inside 400 ms
  });

  it("one pair never gains more white space than the strain bound, whatever the bubbles around it", () => {
    // the owner's "too much white space": a tall bubble's whole height was
    // charged to the small gap beside it, 23 px into a 4 px gap on an ordinary
    // flick, measured in the browser harness on the build before this one
    const rows = mixedThread();
    const d = flickAndCoast(rows, 100);
    let worst = 0;
    for (let k = 0; k < 60; k++) {
      d.now += FRAME;
      d.scrollTop -= 1.9 * FRAME;
      d.f.frame(d.now, d.scrollTop);
      const disp = d.f.displacements();
      for (const i of disp.keys()) {
        if (!disp.has(i + 1)) continue;
        worst = Math.max(worst, (disp.get(i + 1) ?? 0) - (disp.get(i) ?? 0));
      }
    }
    expect(worst).toBeGreaterThan(4); // the effect is still plainly there
    expect(worst).toBeLessThanOrEqual(TUNING.GAP_STRAIN_PX);
  });

  it("the participation window chooses which rows are written and nothing else", () => {
    // The profile is a chain of per-pair changes now, so where the chain STARTS
    // sets every row's place. It starts at the vertex, found over the whole row
    // table; if it were started at a window edge instead, every visible row
    // would shift the moment a row entered or left off screen. The same rows,
    // the same lag and the same vertex must give the same numbers whatever the
    // window happens to be.
    const rows = mixedThread(200);
    for (const anchorY of [400, 4000, 12000, -3000, 40000]) {
      for (const L of [-106, -30, 12, 80]) {
        const wide = profileFor(rows, 20, 120, anchorY, L);
        for (const [a, b] of [
          [21, 121],
          [30, 110],
          [19, 119],
          [45, 90],
        ]) {
          const narrow = profileFor(rows, a, b, anchorY, L);
          for (const [i, dy] of narrow) {
            if (i < 20 || i > 120) continue;
            expect(dy).toBeCloseTo(wide.get(i) ?? 0, 9);
          }
        }
      }
    }
  });

  it("a one-frame delivery gap does not throw the speed window away, so the lag does not jump past its steady value", () => {
    // The run used to be emptied the moment the budget called a still frame a
    // stop, so the next fresh position had only itself and a still frame to be a
    // speed over and a lumpy delivery's double step read as double the speed.
    const d = grab();
    let truth = d.scrollTop;
    const speed = 0.5;
    const Ls: number[] = [];
    for (let k = 0; k < 90; k++) {
      d.now += FRAME;
      truth -= speed * FRAME;
      d.fingerY += speed * FRAME;
      // the finger's reported position is quantised to 2 px, so it repeats on
      // some frames; the scroll position reaches the frame on 3 frames in 4
      d.f.anchor(Math.round(d.fingerY / 2) * 2);
      if (k % 4 !== 3) d.scrollTop = Math.round(truth * 3) / 3;
      d.f.frame(d.now, d.scrollTop);
      Ls.push(Math.abs(d.f.lag()));
    }
    const settled = Ls.slice(30);
    const ideal = speed * TAU;
    // the mean sits on the steady stretch rather than above it
    const mean = settled.reduce((a, b) => a + b, 0) / settled.length;
    expect(mean).toBeGreaterThan(ideal * 0.9);
    expect(mean).toBeLessThan(ideal * 1.05); // it used to run 26% high
  });
});

describe("createSpringField — a fling: the lag tracks the decaying speed and is gone with it", () => {
  it("lift mid-drag coasts; through the coast the lag follows speed x tau; at the end there is nothing left to fall", () => {
    const d = grab();
    drag(d, 2.0, 150, -1);
    d.f.lift();
    expect(d.f.phase()).toBe("coasting");
    expect(d.f.armed()).toBe(true);
    // iOS-style deceleration: v *= 0.998 per ms, until it is a crawl
    let v = 2.0;
    let ms = 0;
    while (v > 0.05) {
      d.now += FRAME;
      ms += FRAME;
      d.scrollTop -= v * FRAME;
      d.f.frame(d.now, d.scrollTop);
      if (ms > 100) {
        // the lag rides a little above speed x tau while the speed falls (it remembers the faster frames)
        expect(Math.abs(d.f.lag())).toBeGreaterThan(v * TAU * 0.95);
        expect(Math.abs(d.f.lag())).toBeLessThan(v * TAU * 1.15);
      }
      v *= Math.pow(0.998, FRAME);
    }
    expect(ms).toBeGreaterThan(1500); // the coast itself lasts well over a second
    const top = topRowAt(d.rows, d.scrollTop);
    const atStop = Math.abs(d.f.displacements().get(top) ?? 0);
    expect(atStop).toBeLessThan(5); // the recording: a few px left when a coast ends
    stillFrames(d, 400, top);
    expect(d.f.active()).toBe(false);
    expect(d.f.armed()).toBe(false); // nothing left: the gesture is over
  });

  it("a caught fling: the content stops dead under the finger and the full stretch returns from that frame", () => {
    const d = grab();
    drag(d, 2.0, 150, -1);
    d.f.lift();
    coast(d, 1.8, 100, -1); // coasting
    d.f.begin(CLIENT_H, THREAD_TOP, THUMB, true); // the catch
    const top = topRowAt(d.rows, d.scrollTop);
    const held = Math.abs(d.f.displacements().get(top) ?? 0);
    // 1.8 px/ms x tau at the top of the viewport: 81 px at the measured 45 ms,
    // 59 px at the 33 ms this build runs
    expect(held).toBeGreaterThan(1.8 * TAU * 0.85);
    const trail = stillFrames(d, 200, top);
    expect(Math.abs(trail[0])).toBeLessThan(held * 0.75); // moving on the very next frame
    expect(Math.abs(trail[trail.length - 1])).toBeLessThan(held * 0.02);
  });

  it("a lift with nothing stretched drops the gesture at once", () => {
    const d = grab();
    stillFrames(d, 100, 0);
    d.f.lift();
    expect(d.f.armed()).toBe(false);
    expect(d.f.active()).toBe(false);
  });

  it("a finger catching a coasting thread keeps the lag and drives from there", () => {
    const d = grab();
    drag(d, 1.5, 150, -1);
    d.f.lift();
    coast(d, 1.0, 100, -1); // coasting
    const held = d.f.lag();
    d.f.begin(CLIENT_H, THREAD_TOP, THUMB, true); // the grab
    expect(d.f.lag()).toBe(held);
    expect(d.f.phase()).toBe("driving");
    d.f.frame(d.now + FRAME, d.scrollTop); // a live gesture keeps its baseline: no jump
    expect(Math.abs(d.f.lag())).toBeLessThan(Math.abs(held)); // a still frame: it melts, no step
    expect(Math.abs(d.f.lag())).toBeGreaterThan(Math.abs(held) * 0.6);
  });

  it("a grab mid-return keeps the return going until the finger moves", () => {
    const d = grab();
    drag(d, 1.0, 200, -1);
    stillFrames(d, 50, 0); // stopped, returning
    expect(d.f.phase()).toBe("settling");
    const mid = d.f.lag();
    d.f.begin(CLIENT_H, THREAD_TOP, THUMB, true);
    expect(d.f.phase()).toBe("settling");
    expect(d.f.lag()).toBe(mid);
    stillFrames(d, 50, 0);
    expect(Math.abs(d.f.lag())).toBeLessThan(Math.abs(mid)); // still returning
    drag(d, 0.5, 50, -1);
    expect(d.f.phase()).toBe("driving");
  });
});

describe("createSpringField — rows never overlap", () => {
  // Every pair inside the participation window keeps at least the floor (or
  // its own rest gap if that is smaller), and every row on screen keeps
  // document order. (At the window's far edge the last participating row
  // carries its lag while the row beyond carries none; that pair sits beyond
  // the buffer, which is wider than any lag, so no row on screen ever meets one.)
  const check = (d: Drive) => {
    const { rows, scrollTop } = d;
    const disp = d.f.displacements();
    const [lo, hi] = windowBounds(scrollTop, CLIENT_H);
    const inWindow = (i: number) => rows[i].top + rows[i].height >= lo && rows[i].top <= hi;
    const onScreen = (i: number) => {
      const top = rows[i].top + (disp.get(i) ?? 0);
      return top + rows[i].height > scrollTop && top < scrollTop + CLIENT_H;
    };
    let tightest = Infinity;
    for (let i = 0; i < rows.length - 1; i++) {
      const a = rows[i].top + (disp.get(i) ?? 0);
      const b = rows[i + 1].top + (disp.get(i + 1) ?? 0);
      if (onScreen(i) || onScreen(i + 1)) expect(b).toBeGreaterThan(a); // document order kept
      if (!inWindow(i) || !inWindow(i + 1)) continue;
      const gap = b - (a + rows[i].height);
      expect(gap).toBeGreaterThanOrEqual(Math.min(gapBetween(rows, i), TUNING.GAP_MIN_PX) - 1e-6);
      tightest = Math.min(tightest, gap);
    }
    return tightest;
  };

  it("through a hard fling and its return, both directions, every frame", () => {
    for (const dir of [-1, 1] as const) {
      const d = grab();
      for (let k = 0; k < 12; k++) {
        drag(d, 3.0, FRAME, dir);
        check(d);
      }
      d.f.lift();
      let v = 3.0;
      while (v > 0.05) {
        d.now += FRAME;
        d.scrollTop += dir * v * FRAME;
        d.f.frame(d.now, d.scrollTop);
        check(d);
        v *= Math.pow(0.998, FRAME);
      }
      let frames = 0;
      while (d.f.active() && frames < 400) {
        d.now += FRAME;
        d.f.frame(d.now, d.scrollTop);
        check(d);
        frames++;
      }
    }
  });

  it("the compressing side closes up to the floor and no further: the guard binds on a hard drag", () => {
    const d = grab();
    // toward newer: the finger travels UP the glass and the rows above it bunch.
    // 120 ms at 3 px/ms is 360 px of travel — a hard flick that a hand can
    // actually make on a 700 px viewport, so the finger (and the vertex it put
    // on the content) is still on the glass at the end of it.
    drag(d, 3.0, 120, 1);
    const disp = d.f.displacements();
    let closedSome = false;
    for (let i = 0; i < d.rows.length - 1; i++) {
      if (!disp.has(i) || !disp.has(i + 1)) continue;
      const change = (disp.get(i + 1) ?? 0) - (disp.get(i) ?? 0);
      if (change < -1) closedSome = true;
    }
    expect(closedSome).toBe(true);
    // softStrain stays strictly INSIDE its allowance, so the tightest pair comes
    // arbitrarily close to the floor without ever reaching it, and HOW close
    // depends on how far past the knee the lag drives it — which is a function
    // of the trail and return time. Both halves are pinned, and the first of
    // them is the load-bearing one: rows keep document order.
    const tightest = check(d);
    expect(tightest).toBeGreaterThan(TUNING.GAP_MIN_PX); // never reaches it, let alone crosses
    expect(tightest).toBeCloseTo(TUNING.GAP_MIN_PX, 5); // and sits on it to a millionth of a px
  });

  it("an ordinary drag closes the gaps ahead of the finger by a fraction, well clear of the floor", () => {
    const d = grab();
    drag(d, 0.5, 300, 1);
    // Each pair just above the thumb closes by its own pitch x L / 500, where L
    // is the drag's steady stretch (0.5 px/ms x tau) and the pitches in this
    // thread are 44 px (a 4 px continuation gap) and 52 px (a 12 px sender gap).
    // That is 2.0–2.3 px at the measured 45 ms and 1.5–1.7 px at the 33 ms this
    // build runs. Every close is inside the strain bound's linear half, so the
    // profile there is exactly resistance x L and the bracket can be exact.
    const steady = 0.5 * TAU;
    expect(check(d)).toBeGreaterThan(TUNING.GAP_MIN_PX);
    const disp = d.f.displacements();
    const anchorContent = d.vertex;
    const closes: number[] = [];
    for (let i = 0; i < d.rows.length - 1; i++) {
      if (!disp.has(i) || !disp.has(i + 1)) continue;
      if (d.rows[i + 1].top + 20 > anchorContent) continue;
      if (Math.abs(d.rows[i].top + 20 - anchorContent) > 300) continue;
      closes.push((disp.get(i) ?? 0) - (disp.get(i + 1) ?? 0));
    }
    expect(closes.length).toBeGreaterThan(3);
    for (const c of closes) {
      expect(c).toBeGreaterThan((44 * steady) / 500 * 0.95);
      expect(c).toBeLessThan((52 * steady) / 500 * 1.05);
    }
  });
});

describe("profileFor — the strain bound, on its own", () => {
  const rows = makeThread(20);
  it("with a zero rest gap a pair can never close at all", () => {
    const tight: SpringRow[] = [
      { top: 0, height: 40 },
      { top: 40, height: 40 }, // touching seats
      { top: 84, height: 40 },
    ];
    const p = profileFor(tight, 0, 2, 200, 300); // finger far below, L > 0: the rows above close toward it
    expect((p.get(1) ?? 0) - (p.get(0) ?? 0)).toBeGreaterThanOrEqual(-1e-9);
  });

  it("a pair closes toward the floor and never reaches it, however hard the lag pulls", () => {
    const pair: SpringRow[] = [
      { top: 0, height: 40 },
      { top: 52, height: 40 }, // a 12px sender gap
      { top: 104, height: 40 },
    ];
    // the bound is approached, not met: softStrain is strictly inside its
    // allowance, which is what keeps a squeezed pair melting with the lag
    // instead of sitting frozen on a clamp and then letting go
    const hard = profileFor(pair, 0, 2, 124, 300); // finger at the bottom row, a huge L
    const gap = (p: Map<number, number>): number =>
      pair[1].top + (p.get(1) ?? 0) - (pair[0].top + (p.get(0) ?? 0) + 40);
    expect(gap(hard)).toBeGreaterThan(TUNING.GAP_MIN_PX);
    expect(gap(hard)).toBeLessThan(TUNING.GAP_MIN_PX + 0.01);
    // and it is still a strictly rising function of the lag down there: half the
    // pull leaves the pair measurably wider, so the melt is seen frame by frame
    expect(gap(profileFor(pair, 0, 2, 124, 150))).toBeGreaterThan(gap(hard));
  });

  it("the stretching side is the pure resistance profile below the strain bound", () => {
    const anchor = rows[15].top + 20;
    // 40px rows on 44 and 52px pitches: at L = -50 the widest pair wants 5.2px,
    // inside the bound's linear half, so the profile is exactly resistance x L
    const p = profileFor(rows, 0, 19, anchor, -50);
    for (let i = 0; i < 15; i++) {
      const r = resistanceFor(rows[i].top + 20 - anchor);
      expect(p.get(i) ?? 0).toBeCloseTo(-50 * r, 6);
    }
  });

  it("above the bound the stretching side eases onto it: a tall bubble's height stops pouring into the gap", () => {
    // one three-line bubble and its neighbour, the shape that made the owner's
    // 4px gap grow ninefold: a 110px pitch charged the whole bubble height to
    // the gap beside it
    const tall: SpringRow[] = [
      { top: 0, height: 40 },
      { top: 44, height: 150 }, // a tall bubble: 110px of pitch to its neighbour
      { top: 198, height: 40 },
    ];
    const anchor = 320; // below the three, inside the divisor: no saturation
    const p = profileFor(tall, 0, 2, anchor, -106); // a flick's reference lag
    const open = (p.get(1) ?? 0) - (p.get(0) ?? 0); // the pair opens by this much
    const raw = ((tall[1].top + 75 - (tall[0].top + 20)) * 106) / TUNING.RESISTANCE_DIVISOR;
    expect(raw).toBeGreaterThan(20); // what the pure profile wanted: 21.0px
    expect(open).toBeLessThan(TUNING.GAP_STRAIN_PX);
    expect(open).toBeGreaterThan(TUNING.GAP_STRAIN_PX * 0.75); // eased on, not cut off
  });

  it("returns nothing for L = 0 and nothing outside lo..hi", () => {
    expect(profileFor(rows, 0, 19, 500, 0).size).toBe(0);
    const p = profileFor(rows, 5, 9, 500, -100);
    for (const i of p.keys()) {
      expect(i).toBeGreaterThanOrEqual(5);
      expect(i).toBeLessThanOrEqual(9);
    }
  });
});

describe("createSpringField — freeze is the hold-off, measure never snaps", () => {
  it("freeze zeroes everything, clears the gesture and stops wanting frames", () => {
    const d = grab();
    drag(d, 1.0, 200, -1);
    expect(d.f.active()).toBe(true);
    d.f.freeze();
    expect(d.f.active()).toBe(false);
    expect(d.f.armed()).toBe(false);
    expect(d.f.lag()).toBe(0);
    expect(d.f.displacements().size).toBe(0);
    d.f.frame(d.now + FRAME, d.scrollTop - 300); // an app ride after the freeze
    expect(d.f.lag()).toBe(0);
  });

  it("a re-measure mid-return with the same seats changes nothing", () => {
    const d = grab();
    drag(d, 0.5, 300, -1);
    const before = [...d.f.displacements().entries()];
    d.f.measure(d.rows.map((r) => ({ ...r })));
    const after = d.f.displacements();
    for (const [i, dy] of before) expect(after.get(i)).toBeCloseTo(dy, 9);
  });

  it("a re-measure with moved seats keeps the lag and re-derives the rows from the new seats", () => {
    const d = grab();
    drag(d, 0.5, 300, -1);
    const lag = d.f.lag();
    d.f.measure(d.rows.map((r) => ({ top: r.top + 100, height: r.height })));
    expect(d.f.lag()).toBe(lag);
    expect(d.f.displacements().size).toBeGreaterThan(0);
  });
});

// --- the wiring, source-pinned (main.ts boots a shell at import) ----------------
describe("main.ts wiring — held off through every motion the app owns", () => {
  const blocked = src.slice(
    src.indexOf("function springBlocked()"),
    src.indexOf("}", src.indexOf("function springBlocked()") + 400),
  );

  it("springBlocked reads every app-owned motion", () => {
    for (const signal of [
      "flightsUp > 0", // a send flight
      "airborneRows.size", // its rows
      "arrival !== null", // the arrival morph
      "glide !== null", // a scroll ride (jump)
      "glideRaf !== 0",
      "landingHold", // the resume ride
      "resumeWindowOpen()", // the resume window
      "shiftAnims.length", // a seat move / the receipt crossfade (beginSiblingShift)
      'app.classList.contains("kb")', // the keyboard lift
    ]) {
      expect(blocked).toContain(signal);
    }
  });

  it("a finished sibling shift releases the hold-off: every animation drops out of the registry it reads", () => {
    // the registry was only ever emptied at the start of the NEXT shift, so the
    // receipt shift at boot on any thread with a sent message kept
    // springBlocked() true for the life of the thread and the spring never
    // armed (the message-tail finding)
    const begin = src.slice(src.indexOf("function beginSiblingShift()"), src.indexOf("function localWrapper("));
    expect(blocked).toContain("shiftAnims.length > 0");
    expect(begin).toContain("shiftAnims.push(anim)");
    expect(begin).toContain("anim.finished.then(() => dropShiftAnim(shiftAnims, anim), () => {})");
    expect(src).toMatch(/import \{[^}]*dropShiftAnim[^}]*\} from "\.\/shift"/);
  });

  it("the FLIP shift freezes the springs before it measures a single rect", () => {
    const shift = src.slice(
      src.indexOf("function beginSiblingShift()"),
      src.indexOf("const before = new Map", src.indexOf("function beginSiblingShift()")),
    );
    expect(shift).toContain("springFreeze();");
  });

  it("the pump freezes the moment a blocked state appears mid-gesture", () => {
    const pump = src.slice(src.indexOf("function springPump()"), src.indexOf("function springFreeze"));
    expect(pump).toContain("if (springBlocked())");
    expect(pump).toContain("springFreeze();");
  });
});

describe("main.ts wiring — driven per frame from the scroll position, not from scroll events", () => {
  it("the pump reads scrollTop each frame and hands it to the field", () => {
    const pump = src.slice(src.indexOf("function springPump()"), src.indexOf("function springFreeze"));
    expect(pump).toContain("requestAnimationFrame(step)");
    // the position the field reads is scrollTop plus the end model's overscroll,
    // which is exactly zero away from the two ends (endspring.test.ts owns it)
    expect(pump).toContain("const st = t.scrollTop + endSpring.frame(now, t.scrollTop");
    expect(pump).toContain("springField.frame(now, st)");
    expect(pump).toContain("springRaf = requestAnimationFrame(step)");
  });

  it("the scroll event is a wake-up only: it drives nothing and writes no scroll", () => {
    const handler = src.slice(src.indexOf("function springHandleScroll()"), src.indexOf("function armSpring"));
    expect(handler).toContain("if (springBlocked())");
    expect(handler).toContain("springFreeze()");
    expect(handler).toContain("if (springField.armed()) springPump()");
    expect(handler).not.toContain("springField.frame(");
    expect(handler).not.toContain("springField.begin(");
    const at = src.indexOf('thread.addEventListener("scroll"');
    const body = src.slice(at, src.indexOf("if (hasScrollend)", at));
    expect(body).toContain("springHandleScroll();");
    expect(body).not.toMatch(/scrollTop\s*=/); // the effect is transform-only
  });

  it("touch events own the gesture: start with the finger as anchor, move re-anchors, end lifts", () => {
    expect(src).toContain("armSpring(e.touches[0].clientY, true)"); // touchstart
    expect(src).toContain("springFinger(e.touches[0].clientY)"); // touchmove
    const end = src.slice(src.indexOf("const endPeek = () =>"), src.indexOf('thread.addEventListener("touchend", endPeek)'));
    expect(end).toContain("liftSpring();"); // touchend and touchcancel both run endPeek
    expect(src).toContain("armSpring(null, false)"); // a wheel anchors on the centre
    expect(src).toContain('if (e.pointerType !== "touch") armSpring(e.clientY, false)');
  });

  it("the finger's lift hands the field to its momentum rather than disarming it", () => {
    const lift = src.slice(src.indexOf("function liftSpring()"), src.indexOf("}", src.indexOf("function liftSpring()")));
    expect(lift).toContain("springField.lift()");
    expect(src).not.toContain("disarmSpring"); // v1's quiet-timer disarm is gone: the field owns its end
  });
});

describe("main.ts wiring — compositor-only, geometry once per gesture", () => {
  it("the effect is applied as the translate longhand and cleared at rest", () => {
    const apply = src.slice(src.indexOf("function applySpring()"), src.indexOf("function springPump"));
    expect(apply).toContain("el.style.translate = px");
    expect(apply).toContain('el.style.removeProperty("translate")');
    expect(apply).not.toContain("style.transform"); // never the peek's property
  });

  it("a write whose value has not changed is skipped, and the value is still sub-pixel", () => {
    const apply = src.slice(src.indexOf("function applySpring()"), src.indexOf("function springPump"));
    expect(apply).toContain("`0 ${dy.toFixed(2)}px`"); // sub-pixel: never snapped to a device pixel
    expect(apply).toContain("if (springWritten.get(i) === px) continue");
    expect(apply).toContain("springWritten.delete(i)"); // a cleared row forgets its value
    // the map is dropped wherever the row table is, so a fresh element at an old
    // index is never skipped on the strength of the old element's value
    const measure = src.slice(src.indexOf("function measureSpring()"), src.indexOf("function applySpring"));
    expect(measure).toContain("springWritten = new Map()");
    expect(src).toContain("springWritten = new Map<number, string>();");
  });

  it("the frame loop reads no layout; seats are read at the grab, and again only when content changed", () => {
    const pump = src.slice(src.indexOf("function springPump()"), src.indexOf("function springFreeze"));
    expect(pump).not.toContain("offsetTop");
    expect(pump).not.toContain("getBoundingClientRect");
    expect(pump).toContain("if (springDirty) measureSpring()");
    const measure = src.slice(src.indexOf("function measureSpring()"), src.indexOf("function applySpring"));
    expect(measure).toContain("el.offsetTop");
    const arm = src.slice(src.indexOf("function armSpring("), src.indexOf("function springFinger"));
    expect(arm).toContain("if (springDirty || !springField.armed()) measureSpring()");
    expect(arm).toContain("springField.begin(springClientH, springThreadTop, touchY, fingerDown)");
  });

  it("content changes mark the seats stale and the fresh shell resets the field", () => {
    expect(src).toContain("springDirty = true; // rows may have moved seats");
    expect(src).toContain("springField.reset();");
  });
});

// --- a page of older messages landing above the viewport ---------------------
// The bug the owner recorded twice: at the spinner ("shifts the viewport down
// ... super janky") and at the tail ("the messages above suddenly compress down
// and then move up"). drainOlder inserts a page ABOVE the reader and pins the
// view by adding the inserted height to scrollTop, so the row under his finger
// does not move a pixel — but the field's next frame read that write as one
// frame of scroll the size of the whole page.
//
// Measured on the built app (headless Chromium, a real 1200-message thread and
// the real history paging): at the frame the page landed, scrollTop jumped
// +3460 px and the reference lag went to +300.00 px — its ceiling — throwing
// every visible row down and relaxing over the next 300 ms at exp(-dt/45).
// Measured on the phone recording (ScreenRecording 09-07-2026 15-34-23, three
// page landings at 3.30 / 6.17 / 9.27 s): the rows jumped down 107–220 device
// px, by DIFFERENT amounts (a spread of 46–119 device px: a stretch, not a
// scroll), and came back to within 1–5 device px with a per-frame ratio of
// 0.68–0.70, which is exp(-16.7/45), this lag's own time constant.
describe("reseat — a pinned insert is not a scroll", () => {
  it("the frame after the pin reads no motion, however big the page was", () => {
    const d = grab();
    drag(d, 0.6, 200, -1); // reading up into history
    const before = d.f.lag();
    // the page lands: 3460 px of content above the viewport, the pin adds it to
    // scrollTop, and the springs are told the row did not move
    d.scrollTop += 3460;
    d.f.reseat(3460);
    d.now += FRAME;
    d.f.frame(d.now, d.scrollTop);
    // the lag simply carries on relaxing from where it was: no injection at all
    expect(d.f.lag()).toBeCloseTo(relaxLag(before, 0, FRAME), 6);
    expect(Math.abs(d.f.lag())).toBeLessThan(Math.abs(before));
  });

  it("without it the same pin saturates the lag at its ceiling", () => {
    const d = grab();
    drag(d, 0.6, 200, -1);
    d.scrollTop += 3460;
    d.now += FRAME;
    d.f.frame(d.now, d.scrollTop);
    expect(d.f.lag()).toBe(TUNING.STRETCH_CAP_PX); // +300: every row thrown down
  });

  it("carries the speed window too, so the next frames are not driven by the jump either", () => {
    const d = grab();
    drag(d, 0.6, 200, -1);
    d.scrollTop += 2000;
    d.f.reseat(2000);
    for (let k = 0; k < 8; k++) {
      d.now += FRAME;
      d.f.frame(d.now, d.scrollTop);
      expect(Math.abs(d.f.lag())).toBeLessThan(30); // the drag's own stretch, melting
    }
  });

  it("a still thread stays exactly still across the pin", () => {
    const d = grab();
    for (let k = 0; k < 20; k++) {
      d.now += FRAME;
      d.f.frame(d.now, d.scrollTop);
    }
    d.scrollTop += 5000;
    d.f.reseat(5000);
    d.now += FRAME;
    d.f.frame(d.now, d.scrollTop);
    expect(d.f.lag()).toBe(0);
    expect(d.f.displacements().size).toBe(0);
  });

  it("zero and a non-finite shift are no-ops", () => {
    const d = grab();
    drag(d, 0.6, 100, -1);
    const L = d.f.lag();
    d.f.reseat(0);
    d.f.reseat(Number.NaN);
    d.now += FRAME;
    d.f.frame(d.now, d.scrollTop);
    expect(d.f.lag()).toBeCloseTo(relaxLag(L, 0, FRAME), 6);
  });
});

describe("main.ts wiring — the pinned inserts tell the springs", () => {
  it("the older-page drain reseats the springs right after its pin", () => {
    const drain = src.slice(src.indexOf("function drainOlder()"), src.indexOf("// the boundary gate"));
    expect(drain).toContain("t.scrollTop = prevScroll + (t.scrollHeight - prevHeight)");
    expect(drain).toContain("springReseat(t.scrollTop - prevScroll)");
  });

  it("the reconnect replay's identical pin does the same", () => {
    const replay = src.slice(src.indexOf("function applyReplay("), src.indexOf("// A truly fresh open"));
    expect(replay).toContain("if (!isTail) springReseat(t.scrollTop - prevScroll)");
  });

  it("the profile reconcile's own correction is announced, and the tail's pin is not", () => {
    // the third write of this shape: the board artifacts appearing or leaving
    // above the fold, compensated so the reader's row stays put. What the
    // interaction costs when it is NOT announced is measured in
    // profilescroll.test.ts; this is the inventory of the sites that announce.
    const fn = src.slice(
      src.indexOf("function reconcileProfileArtifacts("),
      src.indexOf("// finished-reply hold"),
    );
    expect(fn).toContain("const prevScroll = t.scrollTop");
    expect(fn).toContain("springReseat(t.scrollTop - prevScroll)");
    // the tail branch stays with the shared bottom pin: told once, or not at all
    expect(fn.slice(0, fn.indexOf("else if"))).not.toContain("springReseat");
  });

  it("the helper carries both references and hands the end model's band to the field", () => {
    const fn = src.slice(src.indexOf("function springReseat("), src.indexOf("// The scroll handler's one line"));
    expect(fn).toContain("const band = endSpring.over()");
    expect(fn).toContain("endSpring.reseat(dy)");
    expect(fn).toContain("springField.reseat(dy - band)");
  });
});
