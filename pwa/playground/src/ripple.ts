// Ripple from the finger: the live field's drive exactly, then a no-hold release
// that runs outward from the finger.
//
// This is the experimental sibling of the travelling settle, and it deliberately
// shares that module's proven machinery: the same chain walked out from the
// vertex, the same soft strain bound on every pair, the same hard-clamped
// re-chain on release, the same hand-back that decays the shown pose back into
// the drive rather than stepping it. Those pieces are imported from travelsettle
// rather than restated, so the guarantees they carry (tests travelprofile and
// travelsettle) carry here too. What is different is small, and it is the whole
// point:
//
//   - THE RELEASE CURVE IS THE FIELD'S OWN. Each row's share of the stop pose
//     melts on exp(-t/tau), the very curve the live field returns on, with no
//     spring of its own. It cannot overshoot and it cannot bounce: the fraction
//     starts at 1 and falls to 0 and never turns around.
//   - THE DELAY IS SYMMETRIC AND CONTINUOUS. A row's release is held back by its
//     distance from the finger, the same rate above the finger as below it, a
//     smooth gradient per pixel and not a step per row, so the wave reads as one
//     connected thing letting go.
//   - THERE IS NO HOLD. The release clock is seeded at the LAST DRIVEN frame, not
//     at the stop frame, so the row under the finger is already on its way home
//     on the very first frame after the stop. The travelling settle seeds it a
//     frame later, which is the pause the owner read as the shift arriving
//     "later".
//
// Everything else - which frame counts as the stop (read from the field's own
// phase, never second-guessed), the walk bounds, the floor guarantee, the
// hand-back at a reversal - is travelsettle's, unchanged.
//
// WHY NO AMPLITUDE TAPER. The brief allows a second slider that makes far rows
// travel less, and it is not here on purpose. A row's stop pose is exactly how
// far it sits from its seat, so making a far row travel less than that would
// leave it short of its seat forever. Far rows already travel more than near
// rows because the field trails them more (a row RESISTANCE_DIVISOR px from the
// finger trails the whole reference lag, a row under the finger trails nothing),
// and near rows already let go first because the delay grows with distance. So
// the ordering the owner asked for is present without a taper, and every row
// still lands exactly on its seat.

import {
  chainProfile,
  chainSpan,
  clampChange,
  driveTargets,
  waveOriginY,
  GAP_REST_EPS_PX,
  HANDBACK_TAU_MS,
} from "./travelsettle";
import type { ChainSpan } from "./travelsettle";
import { TUNING } from "./vendor/springscroll";
import type { SpringPhase, SpringRow } from "./vendor/springscroll";
import type { FieldTunables } from "./springfield";

/** the experimental tunables the ripple reads. One number, plus the field's own
    trail-and-return time, which is where the release curve comes from. */
export interface RippleTuning {
  /** ms of release delay added for every 100 px of distance from the finger. The
      wave speed: higher and the release crawls outward, so far rows hold their
      stretch longer before they let go; lower and the whole thread lets go
      closer together; 0 releases every row at once. */
  waveMsPer100px: number;
}

export function defaultRippleTuning(): RippleTuning {
  // 15 ms per 100 px carries the front across a phone's visible band above the
  // finger (400 to 500 px) in 60 to 75 ms: fast enough that it reads as one
  // connected release rather than a stagger, slow enough that the near rows are
  // visibly ahead of the far ones. Chosen by driving the built page.
  return { waveMsPer100px: 15 };
}

/** the delay never grows past this, ms. Only the on-screen band carries the
    wave, and at any usable wave speed the far edge of that band is well under
    this, so the cap does nothing there. It exists to bound the walk and the wait
    when a long coast has carried the finger's row far off the top. */
export const RIPPLE_MAX_DELAY_MS = 260;

/** ms per px the wave travels, from the plain-language ms-per-100-px control */
function perPxOf(t: RippleTuning): number {
  return Math.max(t.waveMsPer100px, 0) / 100;
}

/**
 * How much of its stop pose a row still holds, `u` ms after its own release
 * time. The field's own return curve, exp(-t/tau), evaluated in closed form from
 * the release time so nothing integrates and nothing drifts: a stalled frame
 * lands where the frames it swallowed would, and two rows released a millisecond
 * apart stay a millisecond apart.
 *
 * It starts at 1 and falls monotonically to 0. There is no seeded slope and no
 * spring, so unlike the travelling settle's release it can neither overshoot nor
 * bounce: a released row goes straight home on the shipped app's own curve.
 */
export function rippleFraction(u: number, tau: number): number {
  if (!(u > 0)) return 1;
  return Math.exp(-u / Math.max(tau, 1));
}

/**
 * The release delay carried by something sitting at `centreY`, for a wave
 * starting at `originY` (both content positions, so both ride the thread and a
 * pair's delay does not change as the thread scrolls under it).
 *
 * Symmetric: the same rate above the origin as below it, because the ripple runs
 * outward from the finger in both directions. Capped, which is what keeps the
 * settle bounded when the finger's row has ridden off the screen.
 */
export function rippleDelay(centreY: number, originY: number, perPx: number, cap: number): number {
  const per = Math.max(perPx, 0);
  const d = Math.abs(centreY - originY) * per;
  return Math.min(d, Math.max(cap, 0));
}

/** how far either side of the origin the delay is still changing. Past this the
    delay is the cap and every pair lets go together, so the chain can stop
    walking. Never negative, never infinite. */
export function rippleSpan(perPx: number, cap: number): number {
  const per = Math.max(perPx, 0);
  return per > 0 ? Math.max(cap, 0) / per : 0;
}

/**
 * What the ripple is doing. The same four words the travelling settle uses, so
 * the readout can name either without a branch.
 *
 *   driven    the scroll owns the profile; the picture is the baseline's
 *   holding   the stop has happened and the front has not reached every row
 *   settling  every row is released and the last of them are running home
 *   idle      nothing left anywhere
 */
export type RippleState = "idle" | "driven" | "holding" | "settling";

/** everything one frame of the ripple needs, handed in the way playground.ts
    reads it off the field */
export interface RippleFrame {
  nowMs: number;
  /** ms since the previous frame; 0 or less is treated as no time passing */
  dt: number;
  fieldLag: number;
  phase: SpringPhase;
  vertexY: number;
  scrollTop: number;
  clientH: number;
  rows: readonly SpringRow[];
  lo: number;
  hi: number;
  tune: RippleTuning;
  field: FieldTunables;
}

export interface Ripple {
  frame(f: RippleFrame): Map<number, number>;
  active(): boolean;
  state(): RippleState;
  /** the largest displacement written last frame, px */
  signal(): number;
  /** the origin the wave is currently starting from, content space */
  originY(): number;
  /** how long the nearest and the farthest waiting row still have, ms */
  spread(): { min: number; max: number };
  /** how many rows the front has passed, and how many it has to pass */
  front(): { released: number; total: number };
  reset(): void;
}

export function createRipple(): Ripple {
  let st: RippleState = "idle";
  /** the pose at the stop: what each walked row was showing, px */
  const pose = new Map<number, number>();
  /** when each of those rows lets go, absolute ms */
  const releaseAt = new Map<number, number>();
  /** the pair offsets a hand-back is still decaying out */
  const handback = new Map<number, number>();
  // a hand-back carries three things, not just the gaps: the LEVEL the chain
  // hangs from (the row under the vertex) and the CEILING (the reference lag)
  // both pass through zero at a reversal, and replacing them outright drops the
  // thread in one frame. travelsettle measured that and carries all three; so
  // does this.
  let handbackLevel = 0;
  let handbackCeiling = 0;
  let latched: { span: ChainSpan; ceiling: number } | null = null;
  let originNow = 0;
  // the clock of the last DRIVEN frame. The release is seeded here, not at the
  // stop frame, so the row under the finger is already moving on the first frame
  // after the stop rather than one frame later.
  let lastDrivenMs = 0;
  let lastSpread = { min: 0, max: 0 };
  let lastFront = { released: 0, total: 0 };
  let lastSignal = 0;
  /** the pair values the last driven frame carried, so a stop can latch a pose
      and a hand-back can measure what it is coming back from */
  let drivenGaps = new Map<number, number>();
  let drivenLevel = 0;
  let drivenCeiling = 0;

  function reset(): void {
    st = "idle";
    pose.clear();
    releaseAt.clear();
    handback.clear();
    handbackLevel = 0;
    handbackCeiling = 0;
    latched = null;
    lastSpread = { min: 0, max: 0 };
    lastFront = { released: 0, total: 0 };
    lastSignal = 0;
    drivenGaps = new Map();
    drivenLevel = 0;
    drivenCeiling = 0;
  }

  /** the walk this frame's geometry asks for, widened to wherever the delay is
      still changing so two pairs past the amplitude gradient still differ */
  function spanFor(f: RippleFrame): ChainSpan {
    const span = rippleSpan(perPxOf(f.tune), RIPPLE_MAX_DELAY_MS);
    return chainSpan({
      rows: f.rows,
      lo: f.lo,
      hi: f.hi,
      anchorY: f.vertexY,
      divisor: f.field.divisor,
      resistanceMax: f.field.resistanceMax,
      extraLoY: originNow - span,
      extraHiY: originNow + span,
    });
  }

  /**
   * The stop: latch the pose and hand every row its release time.
   *
   * The pose is the chain walked out from the vertex with the values the last
   * driven frame carried, so the first frame of the release starts from exactly
   * the picture the last driven frame drew. The release times are measured from
   * `lastDrivenMs`, which is what makes the vertex move on that first frame.
   */
  function release(f: RippleFrame, span: ChainSpan): void {
    latched = { span, ceiling: drivenCeiling };
    pose.clear();
    releaseAt.clear();
    handback.clear();
    const centre = (i: number): number => f.rows[i].top + f.rows[i].height / 2;
    let acc = drivenLevel;
    pose.set(span.split, acc);
    for (let i = span.split - 1; i >= span.wLo; i--) {
      acc -= drivenGaps.get(i) ?? 0;
      pose.set(i, acc);
    }
    acc = drivenLevel;
    for (let i = span.split + 1; i <= span.wHi; i++) {
      acc += drivenGaps.get(i - 1) ?? 0;
      pose.set(i, acc);
    }
    const per = perPxOf(f.tune);
    for (const i of pose.keys()) {
      releaseAt.set(i, lastDrivenMs + rippleDelay(centre(i), originNow, per, RIPPLE_MAX_DELAY_MS));
    }
    st = "holding";
  }

  function frame(f: RippleFrame): Map<number, number> {
    const driven = f.phase === "driving" || f.phase === "coasting";
    const dt = f.dt > 0 ? f.dt : 0;

    if (driven) {
      // the origin follows the vertex (held inside the visible band) while the
      // thread is driven; at the stop it is frozen with everything else so the
      // ordering cannot shuffle while the release plays out
      originNow = waveOriginY("finger", f.vertexY, f.scrollTop, f.clientH);
      lastDrivenMs = f.nowMs;
      const wasReleasing = st === "holding" || st === "settling";
      if (f.lo > f.hi || f.rows.length === 0) {
        st = "driven";
        latched = null;
        lastSpread = { min: 0, max: 0 };
        lastFront = { released: 0, total: 0 };
        lastSignal = 0;
        return new Map();
      }
      const span = spanFor(f);
      const want = driveTargets({
        rows: f.rows,
        span,
        anchorY: f.vertexY,
        L: f.fieldLag,
        divisor: f.field.divisor,
        resistanceMax: f.field.resistanceMax,
        gapMin: f.field.gapMin,
        strain: f.field.strain,
      });
      // THE HAND-BACK. A gesture catching a release finds the pose on screen and
      // the pose the baseline now wants some distance apart. Stepping between
      // them would snap the thread, so the whole difference is taken once - the
      // gaps, the level they hang from, and the headroom the ceiling has to
      // leave them - and decayed out from there on one clock.
      if (wasReleasing) {
        const shown = releasedGaps(f, latched);
        handback.clear();
        for (const [i, target] of want.gaps) {
          const off = (shown.get(i) ?? 0) - target;
          if (Math.abs(off) >= GAP_REST_EPS_PX) handback.set(i, off);
        }
        handbackLevel = shownAt(f, span.split) - want.level;
        handbackCeiling = lastSignal;
      }
      const decay = dt > 0 ? Math.exp(-dt / HANDBACK_TAU_MS) : 1;
      for (const [i, off] of [...handback]) {
        const next = off * decay;
        if (Math.abs(next) < GAP_REST_EPS_PX) handback.delete(i);
        else handback.set(i, next);
      }
      handbackLevel *= decay;
      if (Math.abs(handbackLevel) < GAP_REST_EPS_PX) handbackLevel = 0;
      handbackCeiling *= decay;
      if (handbackCeiling < TUNING.REST_EPS_PX) handbackCeiling = 0;

      drivenGaps = new Map(want.gaps);
      for (const [i, off] of handback) {
        if (drivenGaps.has(i)) drivenGaps.set(i, (drivenGaps.get(i) as number) + off);
      }
      drivenLevel = want.level + handbackLevel;
      drivenCeiling = Math.max(want.ceiling, handbackCeiling);
      st = "driven";
      latched = null;
      lastSpread = { min: 0, max: 0 };
      lastFront = { released: want.gaps.size, total: want.gaps.size };
      return place(f, span, (i) => drivenGaps.get(i) ?? 0, drivenLevel, drivenCeiling);
    }

    if (st === "driven") {
      if (f.lo > f.hi || f.rows.length === 0 || drivenGaps.size === 0) {
        reset();
        return new Map();
      }
      release(f, spanFor(f));
    }

    if (st === "idle" || latched === null) {
      lastSpread = { min: 0, max: 0 };
      lastFront = { released: 0, total: 0 };
      lastSignal = 0;
      return new Map();
    }

    let released = 0;
    let dmin = Infinity;
    let dmax = 0;
    for (const at of releaseAt.values()) {
      const wait = Math.max(at - f.nowMs, 0);
      if (wait <= 0) released += 1;
      if (wait < dmin) dmin = wait;
      if (wait > dmax) dmax = wait;
    }
    lastFront = { released, total: releaseAt.size };
    lastSpread = { min: Number.isFinite(dmin) ? dmin : 0, max: dmax };
    st = released >= releaseAt.size ? "settling" : "holding";

    const gaps = releasedGaps(f, latched);
    const out = place(
      f,
      latched.span,
      (i) => gaps.get(i) ?? 0,
      held(f, latched.span.split),
      latched.ceiling,
    );
    // over when nothing on screen is off its seat by as much as the field's own
    // rest threshold. A row's own share can be under it while the chain that sums
    // them is not, so the screen is what is asked.
    if (lastSignal < TUNING.REST_EPS_PX && released >= releaseAt.size) {
      reset();
      return new Map();
    }
    return out;
  }

  /** what row i is showing under the latched pose, for any index; outside the
      latched walk the chain carries its boundary constant */
  function shownAt(f: RippleFrame, i: number): number {
    if (latched === null) return 0;
    const { wLo, wHi } = latched.span;
    return held(f, i < wLo ? wLo : i > wHi ? wHi : i);
  }

  /** what row i still holds of its stop pose this frame */
  function held(f: RippleFrame, i: number): number {
    const p = pose.get(i);
    if (p === undefined) return 0;
    const at = releaseAt.get(i) ?? f.nowMs;
    return p * rippleFraction(f.nowMs - at, f.field.tau);
  }

  /** the pairs of a released pose, each put back through the same bound the
      baseline uses - hard, because the pose it came from was softened once
      already */
  function releasedGaps(f: RippleFrame, lat: { span: ChainSpan } | null): Map<number, number> {
    const out = new Map<number, number>();
    if (lat === null) return out;
    for (let i = lat.span.wLo; i < lat.span.wHi; i++) {
      out.set(
        i,
        clampChange(f.rows, i, held(f, i + 1) - held(f, i), f.field.gapMin, f.field.strain),
      );
    }
    return out;
  }

  /** walk the chain and remember what the screen was given */
  function place(
    f: RippleFrame,
    span: ChainSpan,
    gapOf: (i: number) => number,
    level: number,
    ceiling: number,
  ): Map<number, number> {
    const out = chainProfile({
      rows: f.rows,
      lo: f.lo,
      hi: f.hi,
      span,
      gapOf,
      level,
      ceiling,
      gapMin: f.field.gapMin,
    });
    lastSignal = 0;
    for (const dy of out.values()) {
      const m = Math.abs(dy);
      if (m > lastSignal) lastSignal = m;
    }
    return out;
  }

  return {
    frame,
    active: () => st !== "idle",
    state: () => st,
    signal: () => lastSignal,
    originY: () => originNow,
    spread: () => lastSpread,
    front: () => lastFront,
    reset,
  };
}
