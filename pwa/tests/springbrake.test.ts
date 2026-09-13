// Pins for the braked stop (springscroll.ts): a finger landing on a stretched
// thread to stop it, and what the field does from that frame on.
//
// Everything here is SYNTHETIC. The field is driven through the sequence the
// wiring calls it with — begin / anchor / frame / lift — over generated rows; no
// device, no browser, no recording. `deliverLate` models the worst case for a
// braked stop: the position the field is allowed to read is one frame stale, so
// the frame the finger lands on still carries the coast's own motion. It is an
// adversarial assumption about delivery, not a measurement of one.
//
// THE OBSERVATION BOUNDARY MATTERS. The first frame of a return is the step
// from the displacement standing BEFORE the catch into the first post-catch
// frame, so every trail here starts at the pre-catch value. Starting it one
// frame later hides exactly the frame these pins are about.
//
// What the change does, and what it does not:
//   - the frame the braking finger lands on is driven with nothing, so the
//     reference lag falls by exp(-dt/tau) from that frame and on every frame
//     after it, and the rows move on that frame instead of standing still for
//     one and then lurching;
//   - a travelling finger bridges a delivery gap, not the whole speed window;
//   - a settle where the finger landed is not a drag, so it cannot hand the
//     profile's vertex over mid-return, while a slow creep past
//     FINGER_TRAVEL_PX still can;
//   - it does NOT make the biggest frame ON SCREEN the first one at every
//     speed. Past the strain bound the visible profile is concave in the lag,
//     so a large lag is already saturated when the melt begins and the biggest
//     single-frame row movement lands a frame or two in. No row's displacement
//     grows at any speed; only the peak sits later. See the concavity note in
//     springscroll.ts.
//
// Also pinned here: the profile's level must not step as the vertex crosses a
// row's centre. It never could while the vertex was a fixed point in the
// content, but a wheel's vertex is the viewport's middle and crosses a centre
// on most frames, and the step was every visible row jumping at once.
import { describe, expect, it } from "vitest";
import { TUNING, createSpringField, profileFor } from "../src/springscroll";
import type { SpringField, SpringRow } from "../src/springscroll";

const FRAME = 1000 / 60;
const CLIENT_H = 700;
const THREAD_TOP = 0;
const THUMB = 525;
const START = 4000;
/** one frame of the lag's own decay, with nothing driving it */
const MELT = Math.exp(-FRAME / TUNING.LAG_TAU_MS);

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
    `coastMs` of that coast run off. `deliverLate` holds the position the field
    may read one frame behind the real one, so the frame after a stop still
    carries fresh motion: the case a braking frame has to survive. */
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

interface Braked {
  /** the middle row's displacement, PRE-CATCH first and then frame by frame */
  row: number[];
  /** the size of the reference lag on those same frames */
  lag: number[];
}

/** a finger lands at `catchY` and holds there, settling by `settle` px on
    alternate frames. Observation starts one reading before the catch, so
    steps(b.row)[0] is the movement of the return's FIRST frame. */
function brakeAndWatch(r: Run, catchY: number, settle: number): Braked {
  const keys = [...onScreen(r).keys()];
  const mid = keys[keys.length >> 1];
  const b: Braked = { row: [r.f.displacements().get(mid) ?? 0], lag: [Math.abs(r.f.lag())] };
  r.f.begin(CLIENT_H, THREAD_TOP, catchY, true);
  for (let k = 0; k < 14; k++) {
    r.now += FRAME;
    if (settle !== 0) r.f.anchor(catchY + (k % 2 === 0 ? settle : -settle));
    // the scroll is dead: the finger killed the momentum when it landed. The
    // delivery still hands the last frame of it over, once.
    r.f.frame(r.now, r.scrollTop);
    b.row.push(r.f.displacements().get(mid) ?? 0);
    b.lag.push(Math.abs(r.f.lag()));
  }
  return b;
}

/** the per-frame movement of that row, signed */
function steps(trail: number[]): number[] {
  const out: number[] = [];
  for (let k = 1; k < trail.length; k++) out.push(trail[k] - trail[k - 1]);
  return out;
}

describe("a braked stop returns from the frame the finger lands, not frames later", () => {
  it("the frame the finger brakes on is driven with nothing, however late the position arrives", () => {
    const r = flickAndCoast(3.1, 400);
    const lagAtCatch = Math.abs(r.f.lag());
    expect(lagAtCatch).toBeGreaterThan(40); // there is a real stretch to return
    r.f.begin(CLIENT_H, THREAD_TOP, 400, true);
    r.now += FRAME;
    r.f.frame(r.now, r.scrollTop); // this frame carries the coast's last step
    // the lag must have MELTED over that frame, not been driven on by it: one
    // frame of exp(-dt/tau) is a fall to 69% of where it was
    expect(Math.abs(r.f.lag())).toBeCloseTo(lagAtCatch * MELT, 3);
    expect(r.f.phase()).not.toBe("driving");
  });

  it("the lag melts by exactly one frame of decay on every frame from the catch", () => {
    for (const speed of [1.9, 3.1, 4.2]) {
      const b = brakeAndWatch(flickAndCoast(speed, 400), 400, 0);
      for (let k = 1; k < b.lag.length; k++) {
        const want = b.lag[k - 1] * MELT;
        if (want < TUNING.REST_EPS_PX) break; // home: the field clears itself
        expect(b.lag[k]).toBeCloseTo(want, 9);
      }
    }
  });

  it("the rows melt with it: nothing grows, and the first frame is not a frozen one", () => {
    // the fix is that the return STARTS on the braking frame. It is not that
    // the first frame is the biggest: past the strain bound the visible profile
    // is concave in the lag, so at 3.1 and 4.2 px/ms the largest single-frame
    // row movement is measured on the SECOND frame (and past about 5 px/ms on
    // the third). What the first frame may not be is empty.
    for (const speed of [1.9, 3.1, 4.2]) {
      const b = brakeAndWatch(flickAndCoast(speed, 400), 400, 0);
      // it only ever melts
      for (let k = 1; k < b.row.length; k++) {
        expect(Math.abs(b.row[k])).toBeLessThanOrEqual(Math.abs(b.row[k - 1]) + 1e-9);
      }
      const moved = steps(b.row).map(Math.abs);
      const peak = Math.max(...moved);
      // the return's first frame carries a real part of its largest frame
      // (measured 0.68 to 1.00 of it here; a driven braking frame leaves 0.1)
      expect(moved[0]).toBeGreaterThan(0.5 * peak);
      // and the peak is inside the first two frames at these speeds
      expect(moved.indexOf(peak)).toBeLessThanOrEqual(1);
    }
  });

  it("a finger that settles where it lands brakes exactly as one that does not move at all", () => {
    const still = brakeAndWatch(flickAndCoast(3.1, 400), 400, 0);
    for (const settle of [0.34, 0.9, TUNING.FINGER_TRAVEL_PX - 0.1]) { // a settle, not a journey
      const wobbly = brakeAndWatch(flickAndCoast(3.1, 400), 400, settle);
      wobbly.row.forEach((v, k) => expect(v).toBeCloseTo(still.row[k], 6));
    }
    // the settle used to hand the vertex to the new finger and throw the row
    expect(Math.max(...steps(still.row).map(Math.abs))).toBeLessThan(20);
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

  it("the travel is counted from where the finger landed, so a creep becomes a drag", () => {
    // no single step is anywhere near FINGER_TRAVEL_PX: comparing one reading
    // with the one before it would call this a hold for ever
    const r = flickAndCoast(3.1, 400);
    r.f.begin(CLIENT_H, THREAD_TOP, 400, true);
    const crept: string[] = [];
    let y = 400;
    for (let k = 0; k < 8; k++) {
      r.now += FRAME;
      y -= TUNING.FINGER_TRAVEL_PX / 4;
      r.f.anchor(y);
      r.scrollTop -= TUNING.FINGER_TRAVEL_PX / 4;
      r.f.frame(r.now, r.scrollTop);
      crept.push(r.f.phase());
    }
    // braking while it is still inside the threshold, driving once it is past
    expect(crept[0]).toBe("settling");
    expect(crept[2]).toBe("settling");
    expect(crept[3]).toBe("driving");
    expect(crept[7]).toBe("driving");
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
    // melts on its own
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
      // more; the level used to jump a whole pitch's worth of profile
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
    // Exact for these tables. The level is applied before the per-row rounding
    // in `snap`, so a pair already sitting ON the floor can end up inside it by
    // as much as that rounding (up to 0.0099 px) when one row of the pair
    // rounds to zero and the other does not. No sampled case inverts a pair.
    // What that undershoot looks like on a screen is not measured anywhere: it
    // is a bound on the number, not a claim about a paint.
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
