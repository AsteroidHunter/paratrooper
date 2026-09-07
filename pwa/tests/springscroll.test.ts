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
  TUNING,
  atRest,
  createSpringField,
  profileFor,
  relaxLag,
  resistanceFor,
  windowBounds,
} from "../src/springscroll";
import type { SpringField, SpringRow } from "../src/springscroll";

const src = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const FRAME = 1000 / 60;
const TAU = TUNING.LAG_TAU_MS;

describe("the tunables — measured off the Messages recording, in one place", () => {
  it("is the measured lag: 500 px per unit of resistance, a 45 ms time constant, resistance clamped to 1", () => {
    expect(TUNING.RESISTANCE_DIVISOR).toBe(500); // fitted 430–500 CSS px
    expect(TUNING.LAG_TAU_MS).toBe(45); // measured 36–47 ms
    expect(TUNING.RESISTANCE_MAX).toBe(1);
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
}

function grab(rows = makeThread(), scrollTop = START): Drive {
  const f = createSpringField();
  f.measure(rows);
  f.begin(CLIENT_H, THREAD_TOP, THUMB, true);
  const d: Drive = { f, rows, now: 0, scrollTop };
  f.frame(d.now, d.scrollTop); // the baseline frame
  return d;
}

/** a constant-speed drag, px/ms; dir -1 = toward older (scrollTop falls) */
function drag(d: Drive, speed: number, ms: number, dir: -1 | 1): void {
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
    const anchorContent = d.scrollTop + THUMB;
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
    const anchorContent = d.scrollTop + THUMB;
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

  it("the ceiling: only a 6.7 px/ms fling reaches STRETCH_CAP_PX of reference lag", () => {
    const d = grab();
    drag(d, 8.0, 400, -1);
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
    expect(atStop).toBeLessThan(-20); // negative translate: above its seat
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
    drag(d, 1.8, 100, -1); // coasting
    d.f.begin(CLIENT_H, THREAD_TOP, THUMB, true); // the catch
    const top = topRowAt(d.rows, d.scrollTop);
    const held = Math.abs(d.f.displacements().get(top) ?? 0);
    expect(held).toBeGreaterThan(70); // 1.8 px/ms x 45 = 81px at the top of the viewport
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
    drag(d, 1.0, 100, -1); // coasting
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
    drag(d, 3.0, 300, 1); // toward newer: the rows above the thumb bunch (135px of reference lag)
    const disp = d.f.displacements();
    let closedSome = false;
    for (let i = 0; i < d.rows.length - 1; i++) {
      if (!disp.has(i) || !disp.has(i + 1)) continue;
      const change = (disp.get(i + 1) ?? 0) - (disp.get(i) ?? 0);
      if (change < -1) closedSome = true;
    }
    expect(closedSome).toBe(true);
    expect(check(d)).toBeCloseTo(TUNING.GAP_MIN_PX, 6); // the tightest pair sits exactly on the floor
  });

  it("an ordinary drag closes the gaps ahead of the finger by a fraction, well clear of the floor", () => {
    const d = grab();
    drag(d, 0.5, 300, 1);
    // the 12px sender gaps just above the thumb close by ~spacing x 22.5 / 500 = 2.3px
    expect(check(d)).toBeGreaterThan(TUNING.GAP_MIN_PX);
    const disp = d.f.displacements();
    const anchorContent = d.scrollTop + THUMB;
    const closes: number[] = [];
    for (let i = 0; i < d.rows.length - 1; i++) {
      if (!disp.has(i) || !disp.has(i + 1)) continue;
      if (d.rows[i + 1].top + 20 > anchorContent) continue;
      if (Math.abs(d.rows[i].top + 20 - anchorContent) > 300) continue;
      closes.push((disp.get(i) ?? 0) - (disp.get(i + 1) ?? 0));
    }
    expect(closes.length).toBeGreaterThan(3);
    for (const c of closes) {
      expect(c).toBeGreaterThan(1.5);
      expect(c).toBeLessThan(5);
    }
  });
});

describe("profileFor — the guard, on its own", () => {
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

  it("a pair closes down to the floor exactly, never past it", () => {
    const pair: SpringRow[] = [
      { top: 0, height: 40 },
      { top: 52, height: 40 }, // a 12px sender gap
      { top: 104, height: 40 },
    ];
    const p = profileFor(pair, 0, 2, 124, 300); // finger at the bottom row, a huge L
    const gap = pair[1].top + (p.get(1) ?? 0) - (pair[0].top + (p.get(0) ?? 0) + 40);
    expect(gap).toBeCloseTo(TUNING.GAP_MIN_PX, 9);
  });

  it("the stretching side is the pure resistance profile, untouched by the guard", () => {
    const anchor = rows[15].top + 20;
    const p = profileFor(rows, 0, 19, anchor, -200);
    for (let i = 0; i < 15; i++) {
      const r = resistanceFor(rows[i].top + 20 - anchor);
      expect(p.get(i) ?? 0).toBeCloseTo(-200 * r, 6);
    }
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
    expect(pump).toContain("springField.frame(now, t.scrollTop)");
    expect(pump).toContain("if (springField.active()) springRaf = requestAnimationFrame(step)");
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
    expect(apply).toContain("el.style.translate = `0 ${dy.toFixed(2)}px`");
    expect(apply).toContain('el.style.removeProperty("translate")');
    expect(apply).not.toContain("style.transform"); // never the peek's property
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
