// Pins for the springy transcript, second build (springscroll.ts): the bubbles
// lag the scroll by tens of pixels at an ordinary drag, the lag holds through a
// fling, and a beat after the scroll stops they fall back over a perceptible
// settle with a hint of overshoot; rows never overlap (a gap-derived guard);
// the sign matches the owner's description; the whole effect is held at zero
// while the app owns a motion. The pure field is unit-tested directly; the
// main.ts wiring is source-pinned like flight.test.ts / shift.test.ts, because
// main.ts boots a real shell at import and cannot load under node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LAG_PER_SPEED_MS,
  SPRING_OMEGA,
  TUNING,
  atRest,
  createSpringField,
  profileFor,
  relax,
  resistanceFor,
  windowBounds,
} from "../src/springscroll";
import type { SpringField, SpringRow, SpringState } from "../src/springscroll";

const src = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const FRAME = 1000 / 60;

describe("the tunables — Furrow's spring, in one place", () => {
  it("is the iOS 7 spring: 1 Hz, damping 0.8, resistance distance/1500 clamped to 1", () => {
    expect(TUNING.FREQUENCY_HZ).toBe(1.0);
    expect(TUNING.DAMPING_RATIO).toBe(0.8);
    expect(TUNING.RESISTANCE_DIVISOR).toBe(1500);
    expect(TUNING.RESISTANCE_MAX).toBe(1);
  });

  it("holds a beat between the stop and the fall, in the fraction-of-a-second band", () => {
    const hold = TUNING.STOP_QUIET_MS + TUNING.RELEASE_BEAT_MS;
    expect(hold).toBeGreaterThanOrEqual(100);
    expect(hold).toBeLessThanOrEqual(250);
  });

  it("the overlap guard is a fraction of each pair's own gap, and the stretch ceiling is high", () => {
    expect(TUNING.GAP_CLOSE_MAX).toBeGreaterThan(0);
    expect(TUNING.GAP_CLOSE_MAX).toBeLessThan(1);
    expect(TUNING.STRETCH_CAP_PX).toBeGreaterThanOrEqual(200); // v1's 10px is what killed it
  });

  it("the steady lag per unit of scroll speed is 2*zeta/omega (about a quarter second)", () => {
    expect(SPRING_OMEGA).toBeCloseTo((2 * Math.PI) / 1000, 9);
    expect(LAG_PER_SPEED_MS).toBeCloseTo((2 * 0.8) / SPRING_OMEGA, 9);
    expect(LAG_PER_SPEED_MS).toBeGreaterThan(200);
    expect(LAG_PER_SPEED_MS).toBeLessThan(300);
  });
});

describe("resistanceFor — grows with distance from the finger, never past 1", () => {
  it("is zero under the finger and grows with distance", () => {
    expect(resistanceFor(0)).toBe(0);
    expect(resistanceFor(200)).toBeGreaterThan(resistanceFor(50));
    expect(resistanceFor(400)).toBeGreaterThan(resistanceFor(200));
    expect(resistanceFor(300)).toBeCloseTo(0.2, 9); // 300/1500
  });

  it("is symmetric above and below the finger", () => {
    expect(resistanceFor(-300)).toBe(resistanceFor(300));
  });

  it("clamps at 1: a row never lags by more than the scroll itself", () => {
    expect(resistanceFor(1e9)).toBe(1);
  });
});

describe("relax — the settle: slow, visible, a hint of overshoot", () => {
  it("is underdamped: swings through rest once by a small fraction, then settles", () => {
    let s: SpringState = { d: 100, v: 0 };
    let minD = 100;
    let t = 0;
    while (t < 3000) {
      s = relax(s, FRAME);
      t += FRAME;
      minD = Math.min(minD, s.d);
    }
    expect(minD).toBeLessThan(0); // it does cross: a settle, not a critical creep
    expect(-minD).toBeLessThan(2); // by under 2% — a hint, never a bounce
    expect(-minD).toBeCloseTo(100 * Math.exp((-0.8 * Math.PI) / Math.sqrt(1 - 0.64)), 0);
    expect(Math.abs(s.d)).toBeLessThan(0.25);
  });

  it("takes a perceptible time from rest: half back near 200ms, 90% near 450ms, through the seat near 660ms", () => {
    let s: SpringState = { d: 100, v: 0 };
    let t = 0;
    let t50: number | null = null;
    let t90: number | null = null;
    let cross: number | null = null;
    while (t < 2000 && cross === null) {
      s = relax(s, FRAME);
      t += FRAME;
      if (t50 === null && s.d <= 50) t50 = t;
      if (t90 === null && s.d <= 10) t90 = t;
      if (s.d <= 0) cross = t;
    }
    expect(t50).toBeGreaterThan(150);
    expect(t50).toBeLessThan(300);
    expect(t90).toBeGreaterThan(350);
    expect(t90).toBeLessThan(550);
    expect(cross).toBeGreaterThan(600);
    expect(cross).toBeLessThan(750);
  });

  it("starts slowly from rest (the quadratic start that reads as the beat's tail)", () => {
    const s = relax({ d: 100, v: 0 }, 50);
    expect(100 - s.d).toBeLessThan(5); // under 5% moved in the first 50ms
  });

  it("is the exact closed form: a long frame lands where many short ones do", () => {
    let a: SpringState = { d: 40, v: -0.1 };
    for (let i = 0; i < 4; i++) a = relax(a, 12);
    const b = relax({ d: 40, v: -0.1 }, 48);
    expect(a.d).toBeCloseTo(b.d, 6);
    expect(a.v).toBeCloseTo(b.v, 6);
  });

  it("clamps a stalled frame's dt and does nothing on a non-positive one", () => {
    const s: SpringState = { d: 5, v: 1 };
    expect(relax(s, 0)).toBe(s);
    expect(relax(s, -10)).toBe(s);
    expect(relax(s, 100000).d).toBeCloseTo(relax(s, TUNING.DT_MAX_MS).d, 9);
  });

  it("at damping 1 it is the critical form and never crosses rest", () => {
    let s: SpringState = { d: 100, v: 0 };
    for (let i = 0; i < 300; i++) {
      s = relax(s, FRAME, SPRING_OMEGA, 1);
      expect(s.d).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("atRest — home is sub-visible", () => {
  it("is true only under both thresholds", () => {
    expect(atRest({ d: 0, v: 0 })).toBe(true);
    expect(atRest({ d: TUNING.REST_EPS_PX / 2, v: TUNING.REST_EPS_V / 2 })).toBe(true);
    expect(atRest({ d: 1, v: 0 })).toBe(false);
    expect(atRest({ d: 0, v: 1 })).toBe(false);
    expect(TUNING.REST_EPS_PX).toBeLessThanOrEqual(0.5); // under the DOM's own rounding
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
// the two real gaps of styles.css. Viewport 700px, the thumb 75% down it.
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
function stillFrames(d: Drive, ms: number, topRow: number): number[] {
  const out: number[] = [];
  const frames = Math.round(ms / FRAME);
  for (let k = 0; k < frames; k++) {
    d.now += FRAME;
    d.f.frame(d.now, d.scrollTop);
    out.push(d.f.displacements().get(topRow) ?? 0);
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

describe("createSpringField — the stretch builds with speed and distance, by tens of pixels", () => {
  it("an ordinary drag lags the top row by tens of pixels, a faster one by more", () => {
    const slow = grab();
    drag(slow, 0.5, 300, -1);
    const fast = grab();
    drag(fast, 1.0, 300, -1);
    const topSlow = Math.abs(slow.f.displacements().get(topRowAt(slow.rows, slow.scrollTop)) ?? 0);
    const topFast = Math.abs(fast.f.displacements().get(topRowAt(fast.rows, fast.scrollTop)) ?? 0);
    expect(topSlow).toBeGreaterThan(25); // v1 capped this at 10
    expect(topFast).toBeGreaterThan(50);
    expect(topFast).toBeGreaterThan(topSlow * 1.5);
  });

  it("the stretch builds over the drag rather than appearing at once", () => {
    const d = grab();
    const lags: number[] = [];
    for (let k = 0; k < 18; k++) {
      drag(d, 0.5, FRAME, -1);
      lags.push(Math.abs(d.f.lag()));
    }
    for (let k = 1; k < lags.length; k++) expect(lags[k]).toBeGreaterThan(lags[k - 1]);
    expect(lags[5]).toBeLessThan(lags[17] * 0.75); // a third of the way in, well under the end
  });

  it("farther-from-finger rows lag more, so the gaps open, and near rows keep up", () => {
    const d = grab();
    drag(d, 0.5, 300, -1);
    const disp = d.f.displacements();
    const anchorContent = d.scrollTop + THUMB;
    const above = [...disp.entries()]
      .filter(([i]) => d.rows[i].top + d.rows[i].height / 2 < anchorContent)
      .sort((a, b) => d.rows[a[0]].top - d.rows[b[0]].top); // top of screen first
    expect(above.length).toBeGreaterThan(5);
    for (let k = 1; k < above.length; k++) {
      expect(Math.abs(above[k][1])).toBeLessThanOrEqual(Math.abs(above[k - 1][1]) + 1e-9);
    }
    // the widest gap, at the top, opened by several px; the row under the thumb hardly moved
    const opened = Math.abs(above[0][1]) - Math.abs(above[1][1]);
    expect(opened).toBeGreaterThan(2);
    const nearest = above[above.length - 1];
    expect(Math.abs(nearest[1])).toBeLessThan(5);
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
    expect(disp.size).toBeLessThanOrEqual(28); // bounded by the window, not the thread
  });

  it("the stretch ceiling: a long hard drag stops at STRETCH_CAP_PX of reference lag", () => {
    const d = grab();
    drag(d, 3.0, 800, -1);
    expect(Math.abs(d.f.lag())).toBeLessThanOrEqual(TUNING.STRETCH_CAP_PX + 1e-9);
    // each frame clamps and then relaxes by one frame's pull, so the displayed
    // ceiling sits a few percent under the cap
    expect(Math.abs(d.f.lag())).toBeGreaterThan(TUNING.STRETCH_CAP_PX * 0.9);
    expect(maxAbs(d.f.displacements())).toBeLessThanOrEqual(TUNING.STRETCH_CAP_PX + 1e-9);
  });
});

describe("createSpringField — the sign, against the owner's description", () => {
  it("after scrolling toward older messages the rows sit above their seats and fall DOWN", () => {
    const d = grab();
    drag(d, 0.5, 300, -1); // scrollTop falls: toward older
    const top = topRowAt(d.rows, d.scrollTop);
    const atStop = d.f.displacements().get(top) ?? 0;
    expect(atStop).toBeLessThan(-20); // negative translate: above its seat
    const trail = stillFrames(d, 700, top);
    expect(trail[trail.length - 1]).toBeGreaterThan(atStop); // moving down toward 0
    expect(Math.abs(trail[trail.length - 1])).toBeLessThan(Math.abs(atStop) * 0.2);
  });

  it("after scrolling toward newer messages the rows sit below their seats and spring UP", () => {
    const d = grab();
    drag(d, 0.5, 300, 1);
    const disp = d.f.displacements();
    // every displaced row is below its seat (positive translate)
    for (const dy of disp.values()) expect(dy).toBeGreaterThan(0);
    const bottom = [...disp.keys()].sort((a, b) => b - a)[0];
    const atStop = disp.get(bottom)!;
    const trail = stillFrames(d, 700, bottom);
    expect(trail[trail.length - 1]).toBeLessThan(atStop); // moving up toward 0
  });
});

describe("createSpringField — a beat, then a visible fall", () => {
  it("after the finger stops, nothing moves for the hold, then the rows fall", () => {
    const d = grab();
    drag(d, 0.5, 300, -1);
    const top = topRowAt(d.rows, d.scrollTop);
    const atStop = d.f.displacements().get(top)!;
    const hold = TUNING.STOP_QUIET_MS + TUNING.RELEASE_BEAT_MS;
    const trail = stillFrames(d, 1200, top);
    // the hold: identical displacement frame after frame
    const heldFrames = Math.floor(hold / FRAME);
    for (let k = 0; k < heldFrames; k++) expect(trail[k]).toBeCloseTo(atStop, 6);
    // the first pixel of return arrives after the hold and within a third of a second
    const firstPx = trail.findIndex((v) => Math.abs(atStop - v) >= 1);
    const firstPxMs = (firstPx + 1) * FRAME;
    expect(firstPxMs).toBeGreaterThan(hold);
    expect(firstPxMs).toBeLessThan(300);
    // the settle shape after the stop: half back near 400ms, 90% by 700ms
    const closed = (v: number) => Math.abs(atStop - v) / Math.abs(atStop);
    const t50 = (trail.findIndex((v) => closed(v) >= 0.5) + 1) * FRAME;
    const t90 = (trail.findIndex((v) => closed(v) >= 0.9) + 1) * FRAME;
    expect(t50).toBeGreaterThan(300);
    expect(t50).toBeLessThan(500);
    expect(t90).toBeGreaterThan(550);
    expect(t90).toBeLessThan(800);
    // and it moves visibly: the fastest frame is over a pixel
    let peak = 0;
    for (let k = 1; k < trail.length; k++) peak = Math.max(peak, Math.abs(trail[k] - trail[k - 1]));
    expect(peak).toBeGreaterThan(1);
  });

  it("the fall passes the seat by a small overshoot and comes to exact rest with no residue", () => {
    const d = grab();
    drag(d, 1.0, 300, -1);
    const top = topRowAt(d.rows, d.scrollTop);
    const atStop = d.f.displacements().get(top)!;
    let overshoot = 0;
    let frames = 0;
    while (d.f.active() && frames < 300) {
      d.now += FRAME;
      d.f.frame(d.now, d.scrollTop);
      const v = d.f.displacements().get(top) ?? 0;
      if (Math.sign(v) === -Math.sign(atStop)) overshoot = Math.max(overshoot, Math.abs(v));
      frames++;
    }
    expect(overshoot).toBeGreaterThan(0); // a hint
    expect(overshoot).toBeLessThan(Math.abs(atStop) * 0.03); // never a bounce
    expect(d.f.active()).toBe(false);
    expect(d.f.lag()).toBe(0);
    expect(d.f.displacements().size).toBe(0);
    expect(frames * FRAME).toBeLessThan(2000); // frames stop once everything is home
  });

  it("frames stop at rest: a stray frame after the settle touches nothing", () => {
    const d = grab();
    drag(d, 0.5, 200, -1);
    stillFrames(d, 2500, 0);
    expect(d.f.active()).toBe(false);
    d.f.frame(d.now + FRAME, d.scrollTop);
    expect(d.f.displacements().size).toBe(0);
  });

  it("a finger that pauses mid-drag holds the stretch (no creep) and moving again keeps driving", () => {
    const d = grab();
    drag(d, 0.5, 200, -1);
    const before = d.f.lag();
    stillFrames(d, FRAME * 2, 0); // two still frames: under the quiet window
    expect(d.f.lag()).toBe(before);
    expect(d.f.phase()).toBe("driving");
    drag(d, 0.5, 100, -1);
    expect(Math.abs(d.f.lag())).toBeGreaterThan(Math.abs(before));
  });
});

describe("createSpringField — a fling: the lag rides the momentum and falls when it stops", () => {
  it("lift mid-drag coasts; the coast changes nothing; the stop brings the beat and the fall", () => {
    const d = grab();
    drag(d, 2.0, 150, -1);
    const atLift = d.f.lag();
    d.f.lift();
    expect(d.f.phase()).toBe("coasting");
    expect(d.f.armed()).toBe(true);
    // iOS-style deceleration: v *= 0.998 per ms, until it is a crawl
    let v = 2.0;
    while (v > 0.05) {
      d.now += FRAME;
      d.scrollTop -= v * FRAME;
      d.f.frame(d.now, d.scrollTop);
      expect(d.f.lag()).toBe(atLift); // held, exactly
      v *= Math.pow(0.998, FRAME);
    }
    const top = topRowAt(d.rows, d.scrollTop);
    const atStop = d.f.displacements().get(top)!;
    expect(Math.abs(atStop)).toBeGreaterThan(60); // the fall is from the fling's full stretch
    const trail = stillFrames(d, 1000, top);
    const hold = TUNING.STOP_QUIET_MS + TUNING.RELEASE_BEAT_MS;
    for (let k = 0; k < Math.floor(hold / FRAME); k++) expect(trail[k]).toBeCloseTo(atStop, 6);
    expect(Math.abs(trail[trail.length - 1])).toBeLessThan(Math.abs(atStop) * 0.05);
    stillFrames(d, 1500, top);
    expect(d.f.active()).toBe(false);
    expect(d.f.armed()).toBe(false); // nothing left: the gesture is over
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
    expect(d.f.lag()).toBe(held);
  });

  it("a grab mid-settle keeps the fall in progress until the finger moves", () => {
    const d = grab();
    drag(d, 1.0, 200, -1);
    stillFrames(d, 400, 0); // stopped, beat done, settling
    expect(d.f.phase()).toBe("settling");
    const mid = d.f.lag();
    d.f.begin(CLIENT_H, THREAD_TOP, THUMB, true);
    expect(d.f.phase()).toBe("settling");
    expect(d.f.lag()).toBe(mid);
    stillFrames(d, 100, 0);
    expect(Math.abs(d.f.lag())).toBeLessThan(Math.abs(mid)); // still falling
    drag(d, 0.5, 50, -1);
    expect(d.f.phase()).toBe("driving");
  });
});

describe("createSpringField — rows never overlap", () => {
  // Every pair inside the participation window keeps at least (1 - GAP_CLOSE_MAX)
  // of its rest gap, and every row on screen keeps document order. (At the
  // window's far edge the last participating row carries its lag while the row
  // beyond carries none; that pair sits beyond the buffer, which is wider than
  // any displacement toward it, so no row on screen can ever meet one.)
  const check = (d: Drive) => {
    const { rows, scrollTop } = d;
    const disp = d.f.displacements();
    const [lo, hi] = windowBounds(scrollTop, CLIENT_H);
    const inWindow = (i: number) => rows[i].top + rows[i].height >= lo && rows[i].top <= hi;
    const onScreen = (i: number) => {
      const top = rows[i].top + (disp.get(i) ?? 0);
      return top + rows[i].height > scrollTop && top < scrollTop + CLIENT_H;
    };
    for (let i = 0; i < rows.length - 1; i++) {
      const a = rows[i].top + (disp.get(i) ?? 0);
      const b = rows[i + 1].top + (disp.get(i + 1) ?? 0);
      if (onScreen(i) || onScreen(i + 1)) expect(b).toBeGreaterThan(a); // document order kept
      if (!inWindow(i) || !inWindow(i + 1)) continue;
      const gap = b - (a + rows[i].height);
      // the guard: no pair closes by more than GAP_CLOSE_MAX of its own rest gap
      expect(gap).toBeGreaterThanOrEqual(gapBetween(rows, i) * (1 - TUNING.GAP_CLOSE_MAX) - 1e-6);
    }
  };

  it("through a hard fling and its settle, both directions, every frame", () => {
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

  it("the compressing side does close up — visibly, but only to the guard", () => {
    const d = grab();
    drag(d, 1.0, 300, 1); // toward newer: the rows above the thumb bunch
    const disp = d.f.displacements();
    let closedSome = false;
    for (let i = 0; i < d.rows.length - 1; i++) {
      if (!disp.has(i) || !disp.has(i + 1)) continue;
      const change = (disp.get(i + 1) ?? 0) - (disp.get(i) ?? 0);
      if (change < -1) closedSome = true;
    }
    expect(closedSome).toBe(true);
    check(d);
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
    const p = profileFor(tight, 0, 2, 200, 300); // finger far below: everything compresses upward...
    // rows above the finger with D > 0 close toward it; the touching pair may not close
    expect((p.get(1) ?? 0) - (p.get(0) ?? 0)).toBeGreaterThanOrEqual(-1e-9);
  });

  it("the stretching side is the pure resistance profile, uncapped by the guard", () => {
    const anchor = rows[15].top + 20;
    const p = profileFor(rows, 0, 19, anchor, -200);
    for (let i = 0; i < 15; i++) {
      const r = resistanceFor(rows[i].top + 20 - anchor);
      expect(p.get(i) ?? 0).toBeCloseTo(-200 * r, 6);
    }
  });

  it("returns nothing for D = 0 and nothing outside lo..hi", () => {
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

  it("a re-measure mid-settle with the same seats changes nothing", () => {
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
