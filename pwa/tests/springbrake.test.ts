// Pins for the braked stop (springscroll.ts), from the owner's phone recording
// of the live 0.3.149 build beside Messages itself (ScreenRecording_09-12-2026
// 20-42-26_1). His report was that every sudden stop shifts everything down at
// once. Tracking bubble edges frame by frame in both halves of that recording:
// of the 13 braked stops this build returns cleanly from, 12 PEAK LATER than
// the first frame a 30 fps record can see and they carry 37.9 to 101.8 CSS px;
// of the 6 Messages gives, 0 peak later, and they carry 30.4 to 60.9, biggest
// on the first frame and falling 0.56 a frame from there. A return that arrives
// late is not a melt, it is a beat and a lurch.
//
// Two things made it late, and one made it big:
//   - the frame the braking finger landed on was still driven, because the
//     phone hands the position over a frame after the motion it describes and a
//     budget of zero does not refuse a reading stamped this very frame;
//   - a travelling finger bridged the whole speed WINDOW, three frames of it,
//     so a finger settling as it landed kept the dead coast's speed alive;
//   - and the settle itself released the parked vertex, which handed the
//     profile to the new finger while the lag was still at a coast's value.
//
// Also pinned here: the profile's level must not step as the vertex crosses a
// row's centre. It never could while the vertex was a fixed point in the
// content, but a wheel's vertex is the viewport's middle and crosses a centre
// on most frames, and the step was every visible row jumping 29 px at once.
import { describe, expect, it } from "vitest";
import { TUNING, createSpringField, profileFor } from "../src/springscroll";
import type { SpringField, SpringRow } from "../src/springscroll";

const FRAME = 1000 / 60;
const CLIENT_H = 700;
const THREAD_TOP = 0;
const THUMB = 525;
const START = 4000;

function makeThread(n = 200): SpringRow[] {
  const rows: SpringRow[] = [];
  let top = 0;
  for (let i = 0; i < n; i++) {
    rows.push({ top, height: 40 + (i % 4) * 22 });
    top += 40 + (i % 4) * 22 + (i % 3 === 0 ? 14 : 6);
  }
  return rows;
}

interface Run {
  f: SpringField;
  rows: SpringRow[];
  now: number;
  scrollTop: number;
}

/** a flick of `speed` px/ms toward older, the finger lifting into a coast, and
    `coastMs` of that coast run off. `deliverLate` reproduces the phone's own
    delivery: the position the field is allowed to read lags the real one by a
    frame, so the frame after a stop still carries fresh motion. */
function flickAndCoast(speed: number, coastMs: number, deliverLate = true): Run {
  const rows = makeThread();
  const f = createSpringField();
  f.measure(rows);
  f.begin(CLIENT_H, THREAD_TOP, THUMB, true);
  const r: Run = { f, rows, now: 0, scrollTop: START };
  let reported = r.scrollTop;
  f.frame(r.now, reported);
  let fingerY = THUMB;
  for (let k = 0; k < 10; k++) {
    r.now += FRAME;
    const step = speed * FRAME;
    const was = r.scrollTop;
    r.scrollTop -= step;
    fingerY += step;
    f.anchor(fingerY);
    reported = deliverLate ? was : r.scrollTop;
    f.frame(r.now, reported);
  }
  f.lift();
  const frames = Math.round(coastMs / FRAME);
  let v = speed;
  for (let k = 0; k < frames; k++) {
    r.now += FRAME;
    const was = r.scrollTop;
    r.scrollTop -= v * FRAME;
    v *= Math.pow(0.998, FRAME);
    reported = deliverLate ? was : r.scrollTop;
    f.frame(r.now, reported);
  }
  return r;
}

/** the rows on screen now, and what each is displaced by */
function onScreen(r: Run): Map<number, number> {
  const d = r.f.displacements();
  const out = new Map<number, number>();
  r.rows.forEach((row, i) => {
    if (row.top + row.height < r.scrollTop || row.top > r.scrollTop + CLIENT_H) return;
    out.set(i, d.get(i) ?? 0);
  });
  return out;
}

/** the middle row's displacement, frame by frame, after a finger lands at
    `catchY` and holds there, settling by `settle` px on alternate frames */
function brakeAndWatch(r: Run, catchY: number, settle: number): number[] {
  r.f.begin(CLIENT_H, THREAD_TOP, catchY, true);
  const keys = [...onScreen(r).keys()];
  const mid = keys[keys.length >> 1];
  const out: number[] = [];
  for (let k = 0; k < 14; k++) {
    r.now += FRAME;
    if (settle !== 0) r.f.anchor(catchY + (k % 2 === 0 ? settle : -settle));
    // the scroll is dead: the finger killed the momentum when it landed. The
    // phone still hands over the last frame of it, once.
    r.f.frame(r.now, r.scrollTop);
    out.push(r.f.displacements().get(mid) ?? 0);
  }
  return out;
}

/** the per-frame movement of that row, signed */
function steps(trail: number[]): number[] {
  const out: number[] = [];
  for (let k = 1; k < trail.length; k++) out.push(trail[k] - trail[k - 1]);
  return out;
}

describe("a braked stop returns from the frame the finger lands, not three frames later", () => {
  it("the frame the finger brakes on is driven with nothing, however late the position arrives", () => {
    const r = flickAndCoast(3.1, 400);
    const lagAtCatch = Math.abs(r.f.lag());
    expect(lagAtCatch).toBeGreaterThan(40); // there is a real stretch to return
    r.f.begin(CLIENT_H, THREAD_TOP, 400, true);
    r.now += FRAME;
    r.f.frame(r.now, r.scrollTop); // this frame carries the coast's last step
    // the lag must have MELTED over that frame, not been driven on by it: one
    // frame of exp(-dt/tau) is a fall to 69% of where it was
    expect(Math.abs(r.f.lag())).toBeCloseTo(lagAtCatch * Math.exp(-FRAME / TUNING.LAG_TAU_MS), 3);
    expect(r.f.phase()).not.toBe("driving");
  });

  it("the return's biggest frame is its first: a melt, not a beat and a lurch", () => {
    for (const speed of [1.9, 3.1, 4.2]) {
      const r = flickAndCoast(speed, 400);
      const trail = brakeAndWatch(r, 400, 0);
      const moved = steps(trail).map(Math.abs);
      // it only ever melts
      for (let k = 1; k < trail.length; k++) {
        expect(Math.abs(trail[k])).toBeLessThanOrEqual(Math.abs(trail[k - 1]) + 1e-9);
      }
      // and the first frame of it is the biggest, as an exponential is
      expect(moved[0]).toBeGreaterThan(0.9 * Math.max(...moved));
    }
  });

  it("a finger that settles where it lands brakes exactly as one that does not move at all", () => {
    const still = brakeAndWatch(flickAndCoast(3.1, 400), 400, 0);
    for (const settle of [0.34, 0.9]) {  // a settle, not a journey
      const wobbly = brakeAndWatch(flickAndCoast(3.1, 400), 400, settle);
      wobbly.forEach((v, k) => expect(v).toBeCloseTo(still[k], 6));
    }
    // the settle used to hand the vertex to the new finger and throw the row
    expect(Math.max(...steps(still).map(Math.abs))).toBeLessThan(20);
  });

  it("a finger that really travels still takes the vertex, and only then", () => {
    const r = flickAndCoast(3.1, 400);
    r.f.begin(CLIENT_H, THREAD_TOP, 400, true);
    r.now += FRAME;
    r.f.anchor(400 - TUNING.FINGER_TRAVEL_PX - 1); // a drag, not a settle
    r.scrollTop -= 1.0 * FRAME;
    r.f.frame(r.now, r.scrollTop);
    r.now += FRAME;
    r.f.anchor(400 - 2 * TUNING.FINGER_TRAVEL_PX - 2);
    r.scrollTop -= 1.0 * FRAME;
    r.f.frame(r.now, r.scrollTop);
    expect(r.f.phase()).toBe("driving");
  });

  it("a wheel keeps driving while its own vertex is parked: it has no finger to ask", () => {
    // a wheel parks the vertex mid-settle exactly as a catching finger does, and
    // it has no finger to say whether the scroll is moving, so the clock keeps
    // that case. Braking is a thing only a finger does.
    const rows = makeThread();
    const f = createSpringField();
    f.measure(rows);
    let now = 0;
    let st = START;
    f.begin(CLIENT_H, THREAD_TOP, null, false);
    f.frame(now, st);
    for (let k = 0; k < 8; k++) {
      now += FRAME;
      st -= 1.2 * FRAME;
      f.frame(now, st);
    }
    const built = Math.abs(f.lag());
    expect(built).toBeGreaterThan(20);
    f.begin(CLIENT_H, THREAD_TOP, null, false); // the wheel's next tick: a park
    now += FRAME;
    st -= 1.2 * FRAME;
    f.frame(now, st);
    expect(Math.abs(f.lag())).toBeGreaterThan(built * 0.9); // still driven
    expect(f.phase()).toBe("coasting");
  });

  it("a travelling finger bridges a delivery gap, not a whole speed window", () => {
    // the scroll is pinned (an end of the thread, or a finger that has caught
    // one) while the finger goes on travelling: the drive must give out within
    // a delivery gap, not hold the old speed for the window's three frames
    const r = flickAndCoast(2.4, 200);
    const atCatch = Math.abs(r.f.lag());
    r.f.begin(CLIENT_H, THREAD_TOP, 400, true);
    let y = 400;
    const lags: number[] = [];
    for (let k = 0; k < 6; k++) {
      r.now += FRAME;
      y -= 8; // travelling, and travelling far enough to count
      r.f.anchor(y);
      r.f.frame(r.now, r.scrollTop); // ...but the scroll does not move at all
      lags.push(Math.abs(r.f.lag()));
    }
    // one delivery gap may be bridged; after that the drive is gone and the lag
    // melts on its own. The old window held it for a frame longer, and six
    // frames on that is 0.306 of the lag it caught against 0.215 here.
    for (let k = 1; k < lags.length; k++) expect(lags[k]).toBeLessThan(lags[k - 1]);
    expect(lags[5]).toBeLessThan(atCatch * 0.26);
  });
});

describe("the profile's level follows the vertex, not the row nearest it", () => {
  it("no row steps as the vertex crosses a row's centre", () => {
    const rows = makeThread();
    const lo = 40;
    const hi = 60;
    const centre = (i: number): number => rows[i].top + rows[i].height / 2;
    for (const L of [30, 60, 120, 200]) {
      let worst = 0;
      let prev: Map<number, number> | null = null;
      for (let d = -30; d <= 30; d += 0.5) {
        const p = profileFor(rows, lo, hi, centre(50) + d, L);
        if (prev) {
          for (let i = lo; i <= hi; i++) {
            worst = Math.max(worst, Math.abs((p.get(i) ?? 0) - (prev.get(i) ?? 0)));
          }
        }
        prev = p;
      }
      // half a px of vertex travel may move a row by about that much and no
      // more; the level used to jump a whole pitch's worth of profile, 29 px
      expect(worst).toBeLessThan(1);
    }
  });

  it("with nothing saturated the profile is still exactly resistance x L", () => {
    const rows = makeThread();
    const anchorY = rows[50].top + rows[50].height / 2 + 3;
    const L = 6; // small enough that no pair reaches the strain bound
    const p = profileFor(rows, 44, 56, anchorY, L);
    for (const [i, dy] of p) {
      const dist = Math.abs(rows[i].top + rows[i].height / 2 - anchorY);
      expect(dy).toBeCloseTo(Math.min(dist / TUNING.RESISTANCE_DIVISOR, 1) * L, 6);
    }
    expect(p.size).toBeGreaterThan(6);
  });

  it("rows keep document order and the floor: no pair is ever driven through another", () => {
    const rows = makeThread();
    for (const L of [-200, -60, 60, 200]) {
      const p = profileFor(rows, 40, 60, rows[50].top + 20, L);
      for (let i = 40; i < 60; i++) {
        const gap = rows[i + 1].top - (rows[i].top + rows[i].height);
        const after = gap + ((p.get(i + 1) ?? 0) - (p.get(i) ?? 0));
        expect(after).toBeGreaterThanOrEqual(Math.min(gap, TUNING.GAP_MIN_PX) - 1e-9);
      }
    }
  });
});
