// The travelling settle: the experimental half of this playground.
//
// WHY THIS WAS REBUILT
//
// The first version was a DELAY LINE on one shared signal: every row read the
// same scalar S, only at a different point along it, row i showing resistance_i
// x S(t - delay(i)). It was measured to complete in the right order and it was
// rejected on sight, by the owner and then by an independent browser review.
// Both of the reasons are structural, not tuning:
//
//   - A DELAY IS A NO-OP AT THE MOMENT IT MATTERS. Under a steady drag S is
//     constant, so a delayed copy of it is the same number: at the instant of
//     the stop the two modes drew the same picture. Driven from the harness at
//     an ordinary 1 px/ms, every visible row's stretch agreed with the baseline
//     to about 0.05 px; the reviewer's smooth-cadence browser run agreed to
//     0.06 px (18.98 px against 18.92 px). Everything the mode did happened
//     afterwards, in the tail, as a slower fade of a shape that was already
//     familiar.
//   - THE TAIL REPEATED AN ORDER THE BASELINE ALREADY HAD. In the baseline
//     every row melts on the same exp(-t/tau), and a row's stretch grows with
//     its distance from the finger, so the near rows reach the clear threshold
//     first anyway. The harness measures the baseline's own visible band
//     clearing at 0, 67, 83, 100, 117, 133, 150 ms going up from the finger.
//     The delay line turned that into 0, 67, 100, 133, 150, 183, 217, 250 ms:
//     the same sequence, stretched. No new event, just more lag.
//
// On top of that the delayed read was CADENCE SENSITIVE, which is the one thing
// a delay line cannot avoid: it replays whatever the signal did, jitter and
// all, a fixed time later. With scroll readings arriving every 33 ms the
// reviewer measured the travelling stretch at 3.93 px where the baseline had
// 11.35 px, because the far rows were reading a value from before the lag had
// built. The mode was quietly weakest exactly where it advertised itself.
//
// WHAT IT DOES NOW: THE STOP POSE, RELEASED IN ORDER
//
// There is no signal with delays hung off it. There are two regimes:
//
//   while the scroll is DRIVEN   the profile IS the baseline's, recomputed from
//                                the field's live lag every frame. The two
//                                modes draw the same picture frame for frame,
//                                so the drag feels like the shipped app and the
//                                pose at the stop is the shipped app's pose, to
//                                the last digit. Nothing is delayed, so nothing
//                                is suppressed, and a jumpy delivery cadence is
//                                shown exactly as the baseline shows it and no
//                                worse.
//   at the STOP                  the pose is LATCHED - every row's displacement
//                                as it stands - and each row is given a RELEASE
//                                TIME from how far it sits above the wave's
//                                origin. Until its turn comes a row holds what
//                                it had; at its turn its share of the pose
//                                decays on a damped spring seeded with the
//                                baseline's own slope, -x/tau. The rows are
//                                then re-chained, so what reaches the screen is
//                                still a chain of bounded changes of gap.
//
// WHY THE POSE AND NOT THE LAG. The old version delayed the reference LAG,
// which is a number every row multiplies by its own resistance. Two rows a
// pitch apart differ in resistance by pitch/divisor - about 16% - so delaying
// the lag moves them by almost the same fraction of almost the same amount, and
// the ordering lands in the last few percent of a few pixels. Latching the POSE
// and releasing that gives each row a full-sized thing of its own to let go of.
//
// WHY IT IS RE-CHAINED AND HARD-BOUNDED. Ask the rows for the requested motion
// directly and the geometry refuses: "the row nearest the finger arrives while
// the rows above it are still out of place" means, on the side the drag is
// compressing, that the near row must close toward the row above it, and those
// pairs are already sitting on their compression floor (measured: four of the
// six pairs above the finger in an ordinary drag are pinned at exactly 2 px of
// closing). So the released pose is passed back through the same pair bounds
// the baseline uses - hard-clamped, not re-softened, because the latched pose
// came through softStrain already and passing it through twice would move the
// stop pose. Every pair is inside its bound at the stop and can only be asked
// for less as the release runs, so the clamp binds only where the request was
// impossible anyway, and there it compresses the ordering instead of tearing
// the thread.
//
// WHAT THE READER SEES. Rows below the front have arrived and are still. Rows
// above it are holding their stretch. In between, one row after another lets
// go. The scene stops being one column sliding home on one curve.
//
// WHERE IT IS HONESTLY WEAK. When a long coast has carried the vertex hundreds
// of px off the top, every visible row is past the resistance divisor and the
// baseline pose is FLAT: one number added to all of them, with no relative
// structure anywhere. An ordered release then has to create the structure it
// shows, and what THIS design may create is bounded by the pair allowances it
// releases through - about 2 px on a continuation pair. The ordering survives
// and the harness measures it compressed; the tests pin that rather than hiding
// it.
//
// That bound belongs to this implementation and to the pose it releases, not to
// the problem. It follows from two choices: that the mode's drive is the
// shipped profile exactly, and that the release is re-chained through the
// baseline's own per-pair bounds. A different experimental motion - one that
// does not start from the shipped pose, or that gives each row state of its own
// rather than a share of one profile - is not ruled out by anything here, and
// is not ruled out by the brief either. It would be a different mode with a
// different argument, and it would have to earn the drive-time fidelity this
// one gets for free.
//
// WHAT IS KEPT FROM THE BASELINE, UNCHANGED
//
//   - the profile chain itself: started at the VERTEX and walked outward so a
//     row entering the window cannot shift the thread; each neighbour placed by
//     its change of gap through softStrain; the closing allowance the smaller
//     of the strain bound and the room down to gapMin; the level blended
//     between the two rows the vertex lies between so it is continuous as the
//     vertex crosses a centre. vendor/springscroll.ts argues every one of them.
//   - STOP DETECTION IS NOT REIMPLEMENTED. Which frame counts as the stop is
//     the hardest measured part of the baseline, and this module does not
//     second-guess any of it: it reads the field's own phase(). "driving" and
//     "coasting" are driven, anything else is the release. The stop lands on
//     exactly the frame the shipped app lands it on.
//   - THE HAND-OVER. A pair's release starts with the velocity the baseline
//     return would have at that instant, -x/tau, so a pair that is let go
//     immediately leaves its stop pose along the baseline's own curve.
//   - THE HAND-BACK. A new gesture catching a settle finds the springs and the
//     baseline's wanted values apart; the difference is taken as an offset and
//     decayed out over HANDBACK_TAU_MS rather than stepped away.

import { TUNING, resistanceFor, softStrain } from "./vendor/springscroll";
import type { SpringPhase, SpringRow } from "./vendor/springscroll";
import type { FieldTunables } from "./springfield";

/** where the settle wave starts */
export type WaveOrigin =
  /** the profile's own vertex - the finger - held inside the visible band */
  | "finger"
  /** the bottom of the visible band, whatever the finger did */
  | "bottom";

/** the experimental tunables: everything the travelling settle reads */
export interface TravelTuning {
  /** ms of extra release delay per px of distance ABOVE the wave origin. 0
      releases every pair at once, which is the baseline's ordering. */
  upDelayPerPx: number;
  /** the same per px BELOW the origin, as a fraction of the upward figure.
      0 = everything under the finger lets go at once; 1 = symmetric. */
  downDelayRatio: number;
  /** ceiling on any one pair's delay, ms. Bounds the whole settle's length
      however long the thread is and however far the vertex has ridden off. */
  maxDelayMs: number;
  /** which row the wave starts from */
  origin: WaveOrigin;
  /** one pair's own return: ms for a critically damped release to be ~90%
      done. Exact at bounce = 1, approximate either side of it. */
  returnMs: number;
  /** the damping ratio. 1 = critically damped, the fastest return that does not
      cross the seat. Below 1 a released pair springs past rest and back. */
  bounce: number;
}

export function defaultTravelTuning(): TravelTuning {
  return {
    // 0.45 ms/px carries the front across a phone's visible band above the
    // finger (400-600 px) in 180-270 ms: slow enough that the releases are
    // separate events, fast enough that the thread is never left hanging.
    upDelayPerPx: 0.45,
    downDelayRatio: 0.35,
    maxDelayMs: 220,
    origin: "finger",
    // one pair's OWN release, left at the baseline's measured return. Seeded
    // with the baseline's slope it then tracks exp(-t/tau) closely (40% left at
    // 40 ms, against the baseline's 41%), so a pair that is released at the
    // stop goes home exactly as the shipped app sends it home. The whole
    // difference between the modes is WHEN each pair is let go, not a slower
    // curve: the effect is bounded by returnMs + maxDelayMs.
    returnMs: 105,
    bounce: 1,
  };
}

/** omega x t at which a critically damped return released from rest is 90%
    done: e^-k (1 + k) = 0.1. Used to turn the return-time control into rad/ms. */
export const RETURN_K = 3.89;

/** the offset between a running spring and the value the field wants is decayed
    out over this, so a gesture catching a settle never steps */
export const HANDBACK_TAU_MS = 90;

/** the wave origin is held this far inside the visible band, so it always names
    a row the reader can actually see settle first */
export const ORIGIN_INSET_PX = 8;

/** a pair is home when its change of gap is under this, px. Well inside the
    baseline's own quarter-pixel rest threshold, because a row's displacement is
    a SUM of these and a long chain of quarter pixels would be visible. */
export const GAP_REST_EPS_PX = 0.02;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * One exact step of a damped harmonic oscillator, x'' = -w^2 x - 2 z w x'.
 *
 * The closed-form solution over dt, in all three damping regimes, so the result
 * does not depend on the frame rate and cannot blow up: a 200 ms stalled frame
 * lands exactly where twelve 16.7 ms frames would, and a tab returning from the
 * background finds the spring at rest rather than somewhere impossible. This is
 * the same discipline the baseline's relaxLag uses for the first-order lag.
 *
 * `dt` ms, `omega` rad/ms, `zeta` dimensionless.
 */
export function dampedStep(
  x: number,
  v: number,
  dt: number,
  omega: number,
  zeta: number,
): { x: number; v: number } {
  if (!(dt > 0) || !(omega > 0)) return { x, v };
  const wt = omega * dt;
  if (Math.abs(zeta - 1) < 1e-4) {
    // critical: x = e^-wt (x0 + (v0 + w x0) t)
    const e = Math.exp(-wt);
    const b = v + omega * x;
    return { x: e * (x + b * dt), v: e * (v - omega * b * dt) };
  }
  if (zeta < 1) {
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    const e = Math.exp(-zeta * wt);
    const c = Math.cos(wd * dt);
    const s = Math.sin(wd * dt);
    const b = (v + zeta * omega * x) / wd;
    return {
      x: e * (x * c + b * s),
      v: e * (v * c - ((omega * omega * x + zeta * omega * v) / wd) * s),
    };
  }
  // overdamped: two real roots
  const r = omega * Math.sqrt(zeta * zeta - 1);
  const r1 = -zeta * omega + r;
  const r2 = -zeta * omega - r;
  const c1 = (v - r2 * x) / (r1 - r2);
  const c2 = x - c1;
  const e1 = Math.exp(r1 * dt);
  const e2 = Math.exp(r2 * dt);
  return { x: c1 * e1 + c2 * e2, v: c1 * r1 * e1 + c2 * r2 * e2 };
}

/**
 * The release delay carried by something sitting at `centreY`, for a wave
 * starting at `originY` (both in the scroller's content space, so both ride the
 * thread together and a given pair's delay does not change as the thread
 * scrolls under it).
 *
 * Above the origin it grows at the full rate; below it at `downDelayRatio` of
 * it. Both are capped, which is what keeps a settle bounded when the vertex has
 * ridden a thousand px off the top of the screen.
 */
export function delayForCentre(centreY: number, originY: number, t: TravelTuning): number {
  const per = Math.max(t.upDelayPerPx, 0);
  const cap = Math.max(t.maxDelayMs, 0);
  const d = centreY - originY;
  const raw = d < 0 ? -d * per : d * per * clamp(t.downDelayRatio, 0, 1);
  return Math.min(raw, cap);
}

/**
 * How far either side of the origin the delay is still CHANGING. Past these two
 * content positions every pair carries the capped delay and lets go together,
 * so the chain below can stop walking. Returned as distances, never negative
 * and never infinite.
 */
export function delaySpans(t: TravelTuning): { up: number; down: number } {
  const per = Math.max(t.upDelayPerPx, 0);
  const cap = Math.max(t.maxDelayMs, 0);
  const ratio = clamp(t.downDelayRatio, 0, 1);
  return {
    up: per > 0 ? cap / per : 0,
    down: per * ratio > 0 ? cap / (per * ratio) : 0,
  };
}

/**
 * The wave's origin in content space.
 *
 *   "finger"  the profile's own vertex while it is on the screen; the bottom of
 *             the visible band once it is not.
 *   "bottom"  the bottom of the visible band, always.
 *
 * Why the vertex is not used raw. It is a content position read once per
 * gesture, and a long coast carries it right off the screen; every visible pair
 * is then on the same side of it and past the delay cap, so every delay is
 * equal and the "wave" degenerates into the whole thread letting go at one
 * delayed moment - the one failure this tool is not allowed to ship. Falling
 * back to the bottom edge keeps a visible pair at delay zero.
 *
 * Why the fallback is the BOTTOM and not the nearer edge. The settle is
 * supposed to run UP the thread. With the vertex off the top, the nearer edge
 * is the top, and starting there would run the wave downward: ordered, but
 * backwards. The bottom edge keeps the direction the effect is named for in
 * every case, and when the finger is on the glass - which is every braked stop,
 * the gesture this is tuned on - the finger's own row is the origin anyway.
 *
 * Why an edge is safe here when pinning the VERTEX to the screen is not. The
 * vertex sets AMPLITUDE: pin it to the screen and the thread flows past it, the
 * rows it crosses reverse their share of the lag, and bubbles saw against each
 * other (vendor/springscroll.ts has the measurements). This origin sets only
 * TIMING, it is read only while the profile is being driven, and the settle
 * LATCHES it at the stop - so through the entire release, which is the only
 * moment it can be seen, it is a constant.
 */
export function waveOriginY(
  mode: WaveOrigin,
  vertexY: number,
  scrollTop: number,
  clientH: number,
  inset: number = ORIGIN_INSET_PX,
): number {
  const room = Math.max(clientH / 2 - 1, 0);
  const pad = Math.min(inset, room);
  const top = scrollTop + pad;
  const bottom = scrollTop + Math.max(clientH, 0) - pad;
  const lo = Math.min(top, bottom);
  const hi = Math.max(top, bottom);
  if (mode === "bottom") return hi;
  return vertexY >= lo && vertexY <= hi ? vertexY : hi;
}

/** the bounds of the chain walk, and the row it is started from */
export interface ChainSpan {
  /** the row the chain is levelled on: the first whose centre is at or past the
      vertex, found over the WHOLE row table and not over the window */
  split: number;
  /** inclusive row range the walk covers */
  wLo: number;
  wHi: number;
}

/**
 * Where the chain has to be walked for a given vertex and window.
 *
 * Lifted out of the baseline's profileFor unchanged in substance: the walk
 * covers the rows with a gradient - a divisor either side of the vertex, since
 * past that the pure profile is flat and every pair's change is zero - widened
 * to the participating rows when those touch it. `extraLoY`/`extraHiY` widen it
 * further to wherever the RELEASE DELAY stops changing, because two pairs past
 * the amplitude gradient still differ from each other by their delay.
 */
export function chainSpan(opts: {
  rows: readonly SpringRow[];
  lo: number;
  hi: number;
  anchorY: number;
  divisor: number;
  resistanceMax: number;
  extraLoY: number;
  extraHiY: number;
}): ChainSpan {
  const { rows, lo, hi, anchorY, divisor, resistanceMax } = opts;
  const last = rows.length - 1;
  const centre = (i: number): number => rows[i].top + rows[i].height / 2;
  const atOrPast = (y: number): number => {
    let a = 0;
    let b = rows.length;
    while (a < b) {
      const m = (a + b) >> 1;
      if (centre(m) >= y) b = m;
      else a = m + 1;
    }
    return a;
  };
  const bound = (i: number): number => (i < 0 ? 0 : i > last ? last : i);
  const split = bound(atOrPast(anchorY));
  const span = divisor * resistanceMax;
  const gradLo = bound(atOrPast(Math.min(anchorY - span, opts.extraLoY)) - 1);
  const gradHi = bound(atOrPast(Math.max(anchorY + span, opts.extraHiY)));
  return {
    split,
    wLo: hi < gradLo ? gradLo : Math.min(lo, gradLo),
    wHi: lo > gradHi ? gradHi : Math.max(hi, gradHi),
  };
}

/** the change of gap the pair (i, i+1) is allowed: the strain bound opening,
    and never more than the room down to the floor closing. The baseline's own
    rule (vendor/springscroll.ts), applied to the same numbers. */
export function allowedChange(
  rows: readonly SpringRow[],
  i: number,
  change: number,
  gapMin: number,
  strain: number,
): number {
  if (change >= 0) return softStrain(change, strain);
  const gap = rows[i + 1].top - (rows[i].top + rows[i].height);
  return softStrain(change, Math.min(strain, Math.max(0, gap - gapMin)));
}

/**
 * The same bound as a HARD clamp, for the release.
 *
 * softStrain eases a change onto its bound and is not idempotent: passing an
 * already-softened number through it again shrinks it. The latched stop pose is
 * already the baseline's softened chain, so the release has to be bounded by
 * something that leaves values already inside the bound exactly alone - which
 * is what a clamp does and a second softening does not. Everything the release
 * asks for is a fraction of a number that was inside, except where two rows are
 * releasing at different times, and that is the one place this may bite.
 */
export function clampChange(
  rows: readonly SpringRow[],
  i: number,
  change: number,
  gapMin: number,
  strain: number,
): number {
  if (change >= 0) return Math.min(change, strain);
  const gap = rows[i + 1].top - (rows[i].top + rows[i].height);
  const room = Math.min(strain, Math.max(0, gap - gapMin));
  return Math.max(change, -room);
}

/**
 * What the baseline profile wants of every pair in the walk this frame, and of
 * the level the chain is hung from.
 *
 * This is profileFor's own arithmetic, read out one step earlier: where the
 * baseline accumulates `allowed(i, raw(i+1) - raw(i))` as it walks, this
 * returns those per-pair numbers themselves. Feed them straight into
 * chainProfile and the result is profileFor's, to the last bit - which is what
 * makes the travelling mode's DRIVE the shipped field's drive rather than a
 * lookalike, and what tests/travelprofile.test.ts pins.
 */
export function driveTargets(opts: {
  rows: readonly SpringRow[];
  span: ChainSpan;
  anchorY: number;
  L: number;
  divisor: number;
  resistanceMax: number;
  gapMin: number;
  strain: number;
}): { gaps: Map<number, number>; level: number; ceiling: number } {
  const { rows, span, anchorY, L, divisor, resistanceMax, gapMin, strain } = opts;
  const centre = (i: number): number => rows[i].top + rows[i].height / 2;
  const raw = (i: number): number =>
    resistanceFor(centre(i) - anchorY, divisor, resistanceMax) * L;
  const gaps = new Map<number, number>();
  let ceiling = Math.abs(L);
  for (let i = span.wLo; i < span.wHi; i++) {
    gaps.set(i, allowedChange(rows, i, raw(i + 1) - raw(i), gapMin, strain));
  }
  // the level, blended between the two rows the vertex lies between so it is
  // continuous as the vertex crosses a centre (the baseline's own reason: a
  // wheel's vertex crosses one on most frames)
  let level = raw(span.split);
  if (span.split - 1 >= span.wLo && span.split <= span.wHi) {
    const c0 = centre(span.split - 1);
    const c1 = centre(span.split);
    const w = c1 > c0 ? clamp((anchorY - c0) / (c1 - c0), 0, 1) : 1;
    const onPrev = raw(span.split - 1) + (gaps.get(span.split - 1) ?? 0);
    level = onPrev + (raw(span.split) - onPrev) * w;
  }
  if (!(ceiling > 0)) ceiling = 0;
  return { gaps, level, ceiling };
}

/**
 * Place the rows from a chain of per-pair gaps.
 *
 * `gapOf(i)` is the pair (i, i+1)'s change of gap: displacement(i+1) minus
 * displacement(i). The walk starts at `span.split`, carrying `level`, and every
 * other row in the walk is that row plus the gaps between them. Outside the
 * walk every pair is identical, so the chain carries a constant - exactly as
 * the baseline's does.
 *
 * `ceiling` is the baseline's cap: no row trails by more than the reference lag
 * itself. It only ever moves a row TOWARD the vertex's side, so it can narrow a
 * pair's change of gap but never widen one past its allowance. The pass after
 * it is the one guard the chain does not already give: `hold` is the single
 * step that moves a row without asking its neighbour, and with a clamp able to
 * bite one end of a pair and not the other, this walks outward from the vertex
 * and gives back any px a clamp took out of a pair - never closing a gap that
 * was already tighter than the floor at rest.
 */
export function chainProfile(opts: {
  rows: readonly SpringRow[];
  /** inclusive index range of the rows to WRITE (the participation window) */
  lo: number;
  hi: number;
  span: ChainSpan;
  gapOf: (i: number) => number;
  level: number;
  ceiling: number;
  gapMin: number;
}): Map<number, number> {
  const { rows, lo, hi, span, gapOf, level, ceiling, gapMin } = opts;
  const out = new Map<number, number>();
  if (lo > hi || rows.length === 0) return out;
  const { split, wLo, wHi } = span;

  const d = new Map<number, number>();
  let acc = 0;
  d.set(split, acc);
  for (let i = split - 1; i >= wLo; i--) {
    acc -= gapOf(i);
    d.set(i, acc);
  }
  acc = 0;
  for (let i = split + 1; i <= wHi; i++) {
    acc += gapOf(i - 1);
    d.set(i, acc);
  }

  const snap = (v: number): number => (Math.abs(v) < 0.01 ? 0 : v);
  const hold = (v: number): number => (v > ceiling ? ceiling : v < -ceiling ? -ceiling : v);
  const above = (d.get(wLo) as number) ?? 0;
  const below = (d.get(wHi) as number) ?? 0;
  const placed: number[] = [];
  for (let i = lo; i <= hi; i++) {
    const rel = d.has(i) ? (d.get(i) as number) : i < wLo ? above : below;
    placed[i - lo] = hold(rel + level);
  }
  const floorFor = (i: number): number =>
    Math.min(gapMin, rows[i + 1].top - (rows[i].top + rows[i].height));
  for (let i = Math.max(split, lo) + 1; i <= hi; i++) {
    if (i - 1 < lo) continue;
    const gap =
      rows[i].top + placed[i - lo] - (rows[i - 1].top + rows[i - 1].height + placed[i - 1 - lo]);
    const floor = floorFor(i - 1);
    if (gap < floor) placed[i - lo] += floor - gap;
  }
  for (let i = Math.min(split, hi) - 1; i >= lo; i--) {
    if (i + 1 > hi) continue;
    const gap =
      rows[i + 1].top + placed[i + 1 - lo] - (rows[i].top + rows[i].height + placed[i - lo]);
    const floor = floorFor(i);
    if (gap < floor) placed[i - lo] -= floor - gap;
  }
  for (let i = lo; i <= hi; i++) {
    const dy = snap(placed[i - lo]);
    if (dy !== 0) out.set(i, dy);
  }
  return out;
}

/**
 * What the settle is doing.
 *
 *   driven    the scroll owns the profile; the picture is the baseline's
 *   holding   the stop has happened and the front has not reached every row:
 *             some have been released, some are still holding their stretch
 *   settling  every row has been released and the last of them are running home
 *   idle      nothing left anywhere
 *
 * "holding" is a state and not a detail. It is the only window in which the
 * effect can be seen, and it is exactly as long as the delay spread; treating
 * the first release as the whole settle is what cut the old version's delayed
 * rows off in the middle of their return.
 */
export type SettleState = "idle" | "driven" | "holding" | "settling";

/** everything one frame of the travelling settle needs */
export interface TravelFrame {
  nowMs: number;
  /** ms since the previous frame; 0 or less is treated as no time passing */
  dt: number;
  /** the field's reference lag and phase this frame */
  fieldLag: number;
  phase: SpringPhase;
  /** the profile's vertex, the scroll position and the viewport, all as the
      field read them this frame (the end-spring's overscroll included) */
  vertexY: number;
  scrollTop: number;
  clientH: number;
  rows: readonly SpringRow[];
  lo: number;
  hi: number;
  tune: TravelTuning;
  field: FieldTunables;
}

export interface TravellingSettle {
  /** advance one frame and return index -> displacement px */
  frame(f: TravelFrame): Map<number, number>;
  /** the settle still has somewhere to go: the pump must keep asking */
  active(): boolean;
  state(): SettleState;
  /** the largest displacement written last frame, px */
  signal(): number;
  /** the origin the wave is currently starting from, content space */
  originY(): number;
  /** how long the next and the last row in the walk still have to wait, ms */
  spread(): { min: number; max: number };
  /** how many rows the front has passed, and how many it has to pass */
  front(): { released: number; total: number };
  /** drop everything: a thread swap, a reset */
  reset(): void;
}

/**
 * How much of its stop value a row still holds, `u` ms after its own release
 * time.
 *
 * ONE function of time for every row, not one spring per row: each row differs
 * only in when its clock starts, so the closed form can be evaluated from the
 * release time directly. Nothing is integrated frame to frame, so nothing can
 * drift, a stalled frame lands exactly where the frames it swallowed would, and
 * two rows released a millisecond apart are a millisecond apart and not a
 * rounding error apart.
 *
 * It starts at 1 with slope -1/tau, which is the baseline's own return slope
 * scaled out of the displacement: a row released the instant the scroll stops
 * leaves its seat along exactly the curve the shipped app uses.
 */
export function releaseFraction(u: number, tau: number, returnMs: number, bounce: number): number {
  if (!(u > 0)) return 1;
  const omega = RETURN_K / Math.max(returnMs, 8);
  const zeta = clamp(bounce, 0.15, 3);
  return dampedStep(1, -1 / Math.max(tau, 1), u, omega, zeta).x;
}

export function createTravellingSettle(): TravellingSettle {
  let st: SettleState = "idle";
  /** the pose at the stop: what each walked row was showing, px */
  const pose = new Map<number, number>();
  /** when each of those rows lets go, absolute ms */
  const releaseAt = new Map<number, number>();
  /** the pair offsets a hand-back is still decaying out */
  const handback = new Map<number, number>();
  /**
   * The rest of what a hand-back has to carry, and the reason this is not just
   * the gaps.
   *
   * A chain of gaps says how the rows sit RELATIVE to each other. Two more
   * things decide where that chain lands on screen: the LEVEL it hangs from -
   * the displacement of the row under the vertex - and the CEILING, which is
   * the reference lag itself. Hand the gaps back and replace those two outright
   * and the thread drops in a single frame, because at the moment a reversal
   * resumes the drive the lag is passing through zero: the level goes to
   * nothing and the ceiling clamps every row to nearly nothing on the same
   * frame, then lets go again as the lag rebuilds.
   *
   * An independent browser run measured exactly that: one visible row falling
   * 11.33 px in one 16.7 ms frame with scrollTop unmoved, against 6.31 px for
   * the largest still-scroll step the shipped field made over the same window,
   * and then moving back OUT to +4.59, which is a clamp releasing rather than a
   * spring returning. So both travel with the gaps, and both decay on the same
   * clock.
   */
  let handbackLevel = 0;
  let handbackCeiling = 0;
  let latched: { span: ChainSpan; ceiling: number } | null = null;
  let originNow = 0;
  let lastSpread = { min: 0, max: 0 };
  let lastFront = { released: 0, total: 0 };
  let lastSignal = 0;
  /** the pair values the last DRIVEN frame carried, so a stop can latch a pose
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

  /** the walk this frame's geometry asks for */
  function spanFor(f: TravelFrame): ChainSpan {
    const spans = delaySpans(f.tune);
    return chainSpan({
      rows: f.rows,
      lo: f.lo,
      hi: f.hi,
      anchorY: f.vertexY,
      divisor: f.field.divisor,
      resistanceMax: f.field.resistanceMax,
      extraLoY: originNow - spans.up,
      extraHiY: originNow + spans.down,
    });
  }

  /**
   * The stop: latch the pose and hand every row its release time.
   *
   * The pose is the CHAIN, walked out from the vertex with the values the last
   * driven frame carried - the same numbers chainProfile was about to place, so
   * the first frame of the release starts from exactly the picture the last
   * driven frame drew.
   */
  function release(f: TravelFrame, span: ChainSpan): void {
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
    for (const i of pose.keys()) {
      releaseAt.set(i, f.nowMs + delayForCentre(centre(i), originNow, f.tune));
    }
    st = "holding";
  }

  function frame(f: TravelFrame): Map<number, number> {
    const driven = f.phase === "driving" || f.phase === "coasting";
    const dt = f.dt > 0 ? f.dt : 0;

    if (driven) {
      // the origin follows the vertex (held inside the visible band) for as
      // long as the thread is driven; at the stop it is frozen with everything
      // else, so the ordering cannot shuffle while the settle plays out
      originNow = waveOriginY(f.tune.origin, f.vertexY, f.scrollTop, f.clientH);
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
      // THE HAND-BACK. A gesture catching a release finds the POSE on screen and
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
        // what the screen was actually given last frame. The ceiling may not
        // fall below it while the pose above is still being decayed out, or the
        // clamp takes in one frame what the decay is there to spread.
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
    // The effect is over when nothing on SCREEN is off its seat by as much as
    // the baseline's own rest threshold. Each row's own share can be under it
    // while the chain that sums them is not, so the screen is what is asked.
    if (lastSignal < TUNING.REST_EPS_PX && released >= releaseAt.size) {
      reset();
      return new Map();
    }
    return out;
  }

  /**
   * What row i is SHOWING under the latched pose, for any index.
   *
   * The walk the release was latched with and the walk the resuming drive wants
   * need not start on the same row, so the level being handed back has to be
   * read at the NEW walk's own split. Outside the latched walk the chain carries
   * its boundary constant, which is what clamping the index into the walk
   * gives.
   */
  function shownAt(f: TravelFrame, i: number): number {
    if (latched === null) return 0;
    const { wLo, wHi } = latched.span;
    return held(f, i < wLo ? wLo : i > wHi ? wHi : i);
  }

  /** what row i still holds of its stop pose this frame */
  function held(f: TravelFrame, i: number): number {
    const p = pose.get(i);
    if (p === undefined) return 0;
    const at = releaseAt.get(i) ?? f.nowMs;
    return p * releaseFraction(f.nowMs - at, f.field.tau, f.tune.returnMs, f.tune.bounce);
  }

  /**
   * The pairs of a released pose.
   *
   * Two neighbours releasing at different times want to move apart by more than
   * their own gap can give, so every pair is put back through the SAME bound the
   * baseline uses - hard, because the pose it came from was softened once
   * already. At the stop every pair is inside its bound and this changes
   * nothing; as the release runs it binds only where the ordering asked for room
   * the thread does not have.
   */
  function releasedGaps(f: TravelFrame, lat: { span: ChainSpan } | null): Map<number, number> {
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
    f: TravelFrame,
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
