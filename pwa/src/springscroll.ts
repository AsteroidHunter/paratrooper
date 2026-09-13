// Springy transcript, third build — measured from Messages itself, not from a
// description. The owner recorded his iPhone Messages transcript being dragged,
// flung, stopped and caught (62 s, 3500 frames, 1125x2436 at 3x); the bubbles
// were tracked frame by frame and a lag model fitted to every gesture (the
// numbers are in the wiki agent notes). What the transcript actually does:
//
//   - Each bubble trails the scroll by a fraction of the scroll's motion that
//     grows linearly with its distance from the finger: resistance =
//     distance / RESISTANCE_DIVISOR, capped at 1. The profile is a symmetric V
//     with its vertex on the finger, so gaps open on the trailing side and
//     close on the leading side (a 102 px timestamp gap closed to 64 in the
//     recording). Beyond the divisor the lag saturates: two far rows keep their
//     gap. Fitted divisor 430–500 CSS px (1300–1500 device px); 500 here.
//   - The trailing is a FIRST-ORDER lag, not a spring: one time constant of
//     about 45 ms (steady-state stretch 47 ms x speed, return 36–45 ms). Under a
//     steady drag the stretch is speed x tau x resistance — at 1 px/ms a row
//     400 px from the finger sits 36 px behind — and it is there within a few
//     frames of the finger starting to move.
//   - When the content stops, the return starts on the very next frame (a third
//     of the displacement is gone one frame after the stop), is 63% done at
//     45 ms, 90% at 105 ms, and never overshoots. No beat, no hold: a finger
//     that pauses on the glass lets the stretch melt the same way.
//   - A fling holds nothing: through the coast the lag tracks the decaying
//     speed (measured x ≈ speed x tau x resistance frame after frame), so by
//     the time the coast ends the lag is a few px and there is nothing left to
//     fall. The anchor stays where the finger lifted.
//   - Bubbles only translate (heights unchanged to the pixel while moving).
//   - The same profile carries through the rubber-band bounce at the ends of
//     the thread; an inner scroller in iOS Safari does not expose that
//     overscroll in scrollTop, so the bounce is the one part not replicated.
//
// Why the second build (0.3.123) read as wrong against this: a 1 Hz spring with
// a ~200 ms build, a 150 ms frozen beat after the stop, a return that was only
// half done 400 ms after the stop and crossed the seat with an overshoot near
// 800 ms (the real return is 90% done in 105 ms), and a fling that froze the
// full stretch through a one-to-two-second coast and dropped it in one fall at
// the end (the real stretch is gone with the speed). Its half-of-gap compression
// cap was a shape the recording does not have: the leading side closes linearly
// with speed (to 63% of rest at the speeds recorded, 3.3 px on the tightest
// pairs) with nothing but touching to stop it, so the cap is now a 2 px floor.
//
// Kept from the earlier builds: one shared reference lag L (the lag of a row
// exactly RESISTANCE_DIVISOR px from the finger; each row shows resistance x L,
// so the near-to-far gradient is exact and a row entering the window takes its
// place in the profile with no kink), the translate longhand written by main.ts
// (never the peek's transform), seats read once per gesture, participation
// only near the viewport, a compress guard walked outward from the finger so
// rows can never overlap, and the hold-off through every motion the app owns.
//
// Changed after the owner reported jitter on slow scrolls on the live build
// (0.3.131) and his own scroll-jank records were read (gestures 2 to 5 of
// 2026-09-07): the frames were all there — 59.3 to 59.9 a second, at most one
// two-frame hitch in a 19.6 s gesture — but scroll events, and with them the
// scrollTop a frame is allowed to read, arrived at only 31 to 39 a second while
// the thread moved. So on about one frame in four the position had not changed
// and the lag, driven by that frame's delta, dipped 31%, then overshot on the
// frame the delta landed double. The rows were placed off a pulsing lag while
// the compositor scrolled underneath them smoothly, which is the shimmer.
// The lag is now driven by the speed of the last 50 ms of readings that MOVED
// (VELOCITY_WINDOW_MS), held across a delivery gap and dropped to zero once the
// position has stood still longer than a gap could last (VELOCITY_HOLD_MS).
// Every number the recording pinned is untouched: relaxLag is the same solution
// and a steady speed still settles at speed x tau, because the drive was always
// dS/dt and only the estimate of dS/dt changed.
//
// Changed again after the owner reported that braking a fast scroll by touching
// the screen threw the bubbles around: the anchor was taken by the new finger
// the instant it landed, so the whole V re-centred in one frame while the lag
// was still at a fling's value, and every row moved at once — 70 px on the
// worst row, 45 px of it purely the vertex moving, some rows up and some down.
// The recording says the opposite. On all four cleanly tracked caught coasts
// (t = 2.077, 6.265, 27.948 and 51.823 s; the fifth, at 17.530 s, is a seat
// bookkeeping jump in the tracker, not motion on screen), the stretch melts in
// place on the ORDINARY return curve, exp(-t/tau) frame for frame; the bubble
// sitting at the vertex does not move by a pixel through the whole return
// (0 px over 200 ms while a far bubble travelled 27); nothing jumps (worst
// single-frame move 3 to 4.3 CSS px on stretches of 11 and 27 CSS px); and no
// bubble's displacement ever grows. So a catch is not a special case at all: it
// is the ordinary return, and the only thing to fix was the vertex teleporting.
// A finger landing on a stretched thread now parks its anchor and the old
// vertex stands, until the scroll moves again under that finger (a new drag,
// whose stretch is the new finger's) or the lag reaches rest (nothing left to
// place). Both are the spring's own state, so no timer and no new dynamics.
//
// Changed again after the owner reported three things on the phone build
// (0.3.147) and sent a recording of them (ScreenRecording_09-12-2026 14-46-26_1;
// 34 s, 30 fps, 444x960): frame drops and far too much white space on a gentle
// upward scroll, the rows above his finger coming to a halt about half a second
// after the rows below it when he stopped a scroll, and every bubble seeming to
// go its own way — some pairs squeezing shut while others opened at the same
// moment. Three causes, all of them here, all of them measured both in the
// recording and in a driven browser on the real module:
//
//   - A STOPPED RUN THREW ITS HISTORY AWAY. The moment the budget called a
//     still scrollTop a stop, the speed window was emptied as well as read as
//     zero, so the next fresh position had only itself and one still frame to be
//     a speed over. On a lumpy delivery that is a double step read as double the
//     speed, and the lag jumped past its steady value: measured at 4.54 px where
//     the speed says 3.60, rippling 2.41 px. The window is now kept until the
//     scroll has really been still for the whole of it. What the budget decides
//     — that this frame is driven with nothing — is untouched, so the return
//     still starts on the very frame the scroll stops.
//   - THE STRETCH WENT INTO THE GAPS. Space is stretched uniformly but bubbles
//     are rigid, and the distance that counts is centre to centre, so a tall
//     bubble's whole height is charged to the small gap beside it: a 110 px
//     pitch at an ordinary flick's speed put 23 px of white space into a 4 px
//     gap, while pairs on the other side of the finger were driven flat onto the
//     2 px floor. Both sides now pass through one soft strain bound
//     (GAP_STRAIN_PX, softStrain): unchanged under half of it, eased onto it
//     above. The hard clamp that used to hold the closing side is gone with it,
//     and with the clamp goes the staggered landing — a clamped row's place was
//     set by its neighbours' geometry rather than by the lag, so it stood still
//     while the lag melted and only rejoined the return when the pure profile
//     fell back under the clamp, each pair at its own moment.
//   - THE VERTEX SAWED THROUGH THE THREAD. The profile's vertex was a SCREEN
//     position turned into content every frame, and the two streams it was made
//     of disagree: after the finger lifts there is no clientY left at all, so
//     the vertex stood still while the content flew past it under momentum, and
//     during the drag scrollTop and clientY are out of phase by up to a frame of
//     travel. Every row the vertex passed reversed its share of the lag, so rows
//     moved in opposite directions in the same frame and one gap could open from
//     11 px to 22 px and then be squeezed to 1 px inside 400 ms of a single
//     scroll (measured in the recording). The vertex is now read ONCE, on the
//     gesture's first frame, and rides the thread from there. A wheel, which has
//     no finger, keeps the viewport's middle as before.
//
// What was diagnosed but NOT changed: the budget still asks whether the finger
// moved on this exact frame, and if a phone ever repeats a clientY between two
// frames that reads as a stop and dips the lag. It is reproducible here (a 2 px
// quantised finger at 0.08 px/ms) and in a driven browser whose touch dispatch
// is sparser than a phone's, but the owner's recording shows no sign of it — the
// residual field's frame-to-frame autocorrelation is positive in every gesture
// (0.04 to 0.61), where an alternating drive would make it negative — and a
// recording at 30 fps cannot resolve a 60 Hz alternation either way. Bridging it
// costs a frame of the measured return, so it waits for a device trace.
//
// Sign: scrollTop rising (toward newer, content moving up the screen) leaves
// L positive and the rows displaced DOWN behind the motion; falling (toward
// older) leaves them displaced UP. Both return toward the seat from the next
// frame. Pure and DOM-free: geometry, a scroll position and an anchor in, a
// per-row displacement map out. main.ts owns the reads, the writes and the rAF.

// ---- every tunable, in one place ---------------------------------------------
export const TUNING = {
  /** CSS px of distance from the finger per unit of resistance. Measured
      430–500 on the phone (1300–1500 device px at 3x). The amplitude knob:
      smaller = the far rows trail more for the same drag. */
  RESISTANCE_DIVISOR: 500,
  /** resistance never exceeds 1: a row never trails by more than the scroll
      itself, and rows further than the divisor from the finger trail alike. */
  RESISTANCE_MAX: 1,
  /** the lag's time constant, ms. Measured 36–47 ms. It sets both the steady
      stretch (speed x tau x resistance) and the return (63% gone at tau, 90%
      at 2.3 tau). The speed knob: larger = a longer, softer return AND a
      bigger stretch for the same drag. */
  LAG_TAU_MS: 45,
  /** the compress guard: no pair on the closing side ever comes closer than
      this many px (a pair whose rest gap is already smaller keeps its rest
      gap). The recording never closed a gap below 3.3 px or below 63% of
      rest; this floor only prevents overlap, it does not shape the effect. */
  GAP_MIN_PX: 2,
  /** the strain bound: the most white space one pair of rows may gain, or
      lose, px. Both sides of the profile pass through it.

      Why a bound is needed at all. The profile stretches SPACE uniformly —
      every 500 px of distance from the finger is worth one reference lag — but
      bubbles are rigid, so all of the stretch between two rows lands in the
      gap between them, and the gap is far smaller than the bubbles. The
      distance that counts is centre to centre, so a tall bubble's own height
      is charged to the little gap beside it: in the owner's transcript a three
      line bubble makes a 110 px pitch, and at the 2.4 px/ms of an ordinary
      flick (reference lag 106 px) that pitch put 23 px of white space into a
      4 px gap — the gap grew nine times over. That is the "expand too much"
      and "too much white space" in his report, and it is why the pairs on the
      other side of the finger were being driven flat onto the 2 px floor.

      The bound is a soft one. Up to half of it the change is passed through
      UNTOUCHED, so everything the Messages recording pins is untouched too: at
      1 px/ms the widest pitch in a transcript of 40 px bubbles opens 4.7 px,
      well inside the linear half, and the profile there is still exactly
      resistance x L. Above the knee a tanh eases the change onto the bound, so
      a saturated pair still gives ground smoothly as the lag melts rather than
      sitting frozen and then letting go — which is what the old hard clamp did
      on the closing side, and is why rows were seen stopping at different
      times. The closing side takes the smaller of this bound and the room down
      to GAP_MIN_PX, so no pair can reach the floor, let alone cross it. */
  GAP_STRAIN_PX: 12,
  /** ceiling on the reference lag L, px: a 6.7 px/ms fling would reach it;
      a finger never does. Only a sanity bound. */
  STRETCH_CAP_PX: 300,
  /** rows with any part within this many px of the viewport participate. A
      row entering the window takes resistance x L at once, so the band must
      exceed the largest lag a row can carry (the ceiling): both the entry and
      the exit happen off screen. */
  PARTICIPATION_BUFFER_PX: 400,
  /** home: under this reference lag everything clears (a quarter pixel, under
      the DOM's own rounding, so the clear is never seen). */
  REST_EPS_PX: 0.25,
  /** how far back the drive speed is measured, ms. One frame's scrollTop delta
      is not a speed on the phone. Measured on the owner's own device (the
      scroll-jank records of 2026-09-07, gestures 2 to 5): animation frames
      arrive at 59.3 to 59.9 a second, but scroll events, and with them the
      scrollTop the main thread is allowed to see, arrive at only 31 to 39 a
      second while the thread is moving — about three frames in four — and the
      position handed over is quantised to whole device pixels. A per-frame
      delta therefore alternates between nothing and a double step, and since
      one frame's delta enters the lag at 84% of its weight, the lag pulses
      with it. Over 50 ms the same motion reads as one steady speed. */
  VELOCITY_WINDOW_MS: 50,
  /** how long a still scrollTop may be read as a delivery gap rather than a
      stop while nothing else says the scroll is moving: just over one frame at
      60 Hz. It is the bound for momentum and for a wheel, where there is no
      finger to ask. Under a finger the finger answers instead (see below), so
      a hold on the glass still melts from the very next frame. */
  VELOCITY_HOLD_MS: 28,
} as const;

/** the steady lag of the reference row per px/ms of scroll speed: tau itself */
export const LAG_PER_SPEED_MS = TUNING.LAG_TAU_MS;

/** clamp helper (kept local; the app has no shared one) */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * The scroll resistance for a row at `distance` px from the finger: grows
 * linearly with distance, saturates at RESISTANCE_MAX. Measured linear (a
 * power of 0.75 or 1.25 fits the recording worse than 1).
 */
export function resistanceFor(
  distance: number,
  divisor: number = TUNING.RESISTANCE_DIVISOR,
  max: number = TUNING.RESISTANCE_MAX,
): number {
  return clamp(Math.abs(distance) / divisor, 0, max);
}

/**
 * Advance the reference lag over one frame: the scroll moved `dS` px in `dt`
 * ms. The exact solution of L' = v - L/tau for a constant v = dS/dt over the
 * frame, so the result does not depend on the frame rate: a 33 ms frame lands
 * where two 16.7 ms frames do, a steady drag settles at exactly speed x tau,
 * and after a stop L decays as exp(-t/tau) with no overshoot.
 */
export function relaxLag(L: number, dS: number, dt: number, tau: number = TUNING.LAG_TAU_MS): number {
  if (dt <= 0) return L + dS;
  const e = Math.exp(-dt / tau);
  return L * e + dS * (tau / dt) * (1 - e);
}

/** home: under the rest threshold, so the wiring may clear the transforms */
export function atRest(L: number): boolean {
  return Math.abs(L) < TUNING.REST_EPS_PX;
}

/** one reading of the scroll position: the frame it was taken on and where it
    was. Only readings that MOVED are kept; a frame that repeats the last
    position said nothing about the speed. */
export interface ScrollSample {
  t: number;
  s: number;
}

/**
 * The speed to drive the lag with, px/ms, from a trailing run of readings that
 * moved (oldest first, newest last) and the current frame's clock.
 *
 * Two rules, and both of them exist because the phone does not hand the main
 * thread a fresh scroll position every frame:
 *
 *   - the slope is taken across the whole run, not across the last frame, so
 *     the same motion delivered in a lump reads as the steady speed it was;
 *     the run is windowed by the caller, which is what bounds the smoothing.
 *   - a run whose newest reading is older than `holdMs` is a stop, not a gap:
 *     the speed is zero and the lag decays from that frame. Under the hold the
 *     last speed stands, so a single frame with no fresh position — the common
 *     case, one frame in four — neither dips the lag nor moves the rows.
 *
 * Fewer than two readings is not a speed: zero, and the next moved reading
 * gives the first real one.
 */
export function speedOver(
  samples: readonly ScrollSample[],
  now: number,
  holdMs: number = TUNING.VELOCITY_HOLD_MS,
): number {
  const n = samples.length;
  if (n < 2) return 0;
  const last = samples[n - 1];
  if (now - last.t > holdMs) return 0;
  const dt = last.t - samples[0].t;
  if (dt <= 0) return 0;
  return (last.s - samples[0].s) / dt;
}

/**
 * One pair's change of gap, eased onto `allow`. Identity up to half the
 * allowance, then a tanh onto it; odd, continuous in value and slope, strictly
 * inside the allowance for every finite input, and strictly increasing — so the
 * pair's gap is a smooth rising function of the reference lag, and melts back
 * with it instead of holding a clamped value and then letting go.
 *
 * `allow <= 0` is a pair with no room at all (seats already touching): it
 * cannot move relative to its neighbour, so it does not.
 */
export function softStrain(change: number, allow: number): number {
  if (!(allow > 0)) return 0;
  const knee = allow / 2;
  const m = Math.abs(change);
  if (m <= knee) return change;
  const eased = knee + knee * Math.tanh((m - knee) / knee);
  return change < 0 ? -eased : eased;
}

/** one row's geometry, in the scroller's own content space (offsetTop/height) */
export interface SpringRow {
  top: number;
  height: number;
}

/**
 * The participation window in content space: the visible band [scrollTop,
 * scrollTop + clientHeight] widened by the buffer each way. A row takes part if
 * any of its box lies inside.
 */
export function windowBounds(
  scrollTop: number,
  clientHeight: number,
  buffer: number = TUNING.PARTICIPATION_BUFFER_PX,
): [number, number] {
  return [scrollTop - buffer, scrollTop + clientHeight + buffer];
}

/**
 * The row profile for a reference lag L. Each row wants to trail by
 * resistance x L; the walk starts at the row under the finger and places each
 * neighbour by the CHANGE OF GAP that wants, passed through the strain bound
 * (softStrain). Under half the bound the change is the pure profile's, so the
 * measured shape is exactly what it was; above it the pair eases onto the
 * bound instead of pouring a tall bubble's whole height into a 4 px gap.
 *
 * Both sides go through the same law, which is the difference from the build
 * before: the closing side used to be a hard min/max against the 2 px floor, and
 * a clamped row's place was then set by the geometry of its neighbours rather
 * than by the lag — so it held still while the lag melted and only rejoined the
 * return once the pure profile fell back under the clamp, each pair at its own
 * moment. That is the "stop motion at different times" in the owner's report.
 * A soft bound is a strictly rising function of the lag, so every row's
 * displacement melts with it and the whole profile lands together.
 *
 * The closing allowance is the smaller of the strain bound and the room down to
 * GAP_MIN_PX, and softStrain stays strictly inside its allowance, so no pair
 * ever reaches the floor and none can cross it: rows keep document order.
 *
 * Pure; exported so the bound is unit-testable on its own. `lo..hi` is the
 * inclusive index range of the participating rows, `anchorY` the finger in
 * content space.
 */
export function profileFor(
  rows: readonly SpringRow[],
  lo: number,
  hi: number,
  anchorY: number,
  L: number,
  divisor: number = TUNING.RESISTANCE_DIVISOR,
  resistanceMax: number = TUNING.RESISTANCE_MAX,
  gapMin: number = TUNING.GAP_MIN_PX,
  strain: number = TUNING.GAP_STRAIN_PX,
): Map<number, number> {
  const out = new Map<number, number>();
  if (L === 0 || lo > hi) return out;
  const raw = (i: number): number =>
    resistanceFor(rows[i].top + rows[i].height / 2 - anchorY, divisor, resistanceMax) * L;
  /** the change of gap the pair (i, i+1) is allowed: the strain bound opening,
      and never more than the room down to the floor closing */
  const allowed = (i: number, change: number): number => {
    if (change >= 0) return softStrain(change, strain);
    const gap = rows[i + 1].top - (rows[i].top + rows[i].height);
    return softStrain(change, Math.min(strain, Math.max(0, gap - gapMin)));
  };
  const centre = (i: number): number => rows[i].top + rows[i].height / 2;
  const last = rows.length - 1;
  /** the first row whose centre is at or past `y` (rows are in document order,
      so centres rise); `rows.length` if there is none */
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

  // A chain of changes has to be started somewhere, and where it is started sets
  // every other row's place — so it is started at the VERTEX, found over the
  // whole row table and not over the participating range. Starting it at a
  // window edge instead (which is what falls out if only lo..hi is looked at)
  // makes the whole profile shift the moment a row enters or leaves there:
  // measured at 3 px of every visible row jumping on one frame, and 13 px when
  // the vertex crossed the edge. The window must choose which rows are WRITTEN
  // and nothing else.
  const split = bound(atOrPast(anchorY));
  // Beyond `span` from the vertex the pure profile is flat, so every pair's
  // change there is zero and the chain carries a constant. That bounds the walk:
  // it never has to cross the thousands of rows a long coast can put between the
  // vertex and the viewport.
  const span = divisor * resistanceMax;
  const gradLo = bound(atOrPast(anchorY - span) - 1);
  const gradHi = bound(atOrPast(anchorY + span));

  const snap = (v: number): number => (Math.abs(v) < 0.01 ? 0 : v);
  // No row ever trails by more than the reference lag itself (RESISTANCE_MAX).
  // The chain can try to: a pair straddling the vertex whose rest gap is tighter
  // than it wants to close is held apart by its allowance, and that offset used
  // to be carried out to every row beyond it. Taking it back here costs nothing
  // — the cap only ever moves a row TOWARD the vertex's side, which can only
  // narrow a pair's change of gap, never widen one past its allowance.
  const ceiling = Math.abs(L);
  const hold = (v: number): number => (v > ceiling ? ceiling : v < -ceiling ? -ceiling : v);
  // the walk covers the rows with a gradient, widened to the participating rows
  // when those touch it; when they do not, every one of them is past the
  // gradient and carries the same constant, so only the gradient is walked
  const wLo = hi < gradLo ? gradLo : Math.min(lo, gradLo);
  const wHi = lo > gradHi ? gradHi : Math.max(hi, gradHi);
  const d = new Map<number, number>();
  let acc = snap(raw(split));
  d.set(split, acc);
  // upward from the vertex: each pair takes its allowed change of gap
  for (let i = split - 1; i >= wLo; i--) {
    acc = snap(hold(acc - allowed(i, raw(i + 1) - raw(i))));
    d.set(i, acc);
  }
  // downward from the vertex: the same law, walked the other way
  acc = d.get(split) as number;
  for (let i = split + 1; i <= wHi; i++) {
    acc = snap(hold(acc + allowed(i - 1, raw(i) - raw(i - 1))));
    d.set(i, acc);
  }
  // rows past the gradient carry the chain's total on their side
  const above = d.get(wLo) as number;
  const below = d.get(wHi) as number;
  for (let i = lo; i <= hi; i++) {
    const dy = d.has(i) ? (d.get(i) as number) : i < wLo ? above : below;
    if (dy !== 0) out.set(i, dy);
  }
  return out;
}

export type SpringPhase = "idle" | "driving" | "coasting" | "settling";

export interface SpringField {
  /** (re)build the row table: once per gesture and on a layout change. The lag
      itself is row-independent, so a re-measure mid-settle never snaps. */
  measure(rows: readonly SpringRow[]): void;
  /** a gesture begins: the finger's screen-Y (null = the viewport centre, for a
      wheel or a pointer), the viewport, and the thread's screen top; the next
      frame is the delta baseline. `held` says a finger is on the glass. */
  begin(clientHeight: number, threadTop: number, anchorScreenY: number | null, held: boolean): void;
  /** the finger moved: the field re-centres on it */
  anchor(screenY: number): void;
  /** the finger left the glass; momentum, if any, is still the gesture. The
      anchor stays where the finger lifted. */
  lift(): void;
  /** one animation frame: read the scroll position, advance the lag */
  frame(nowMs: number, scrollTop: number): void;
  /**
   * The scroll position moved by `dy` for a reason that is NOT scrolling: a page
   * of older messages was inserted above the viewport and the app pinned the
   * view by adding the inserted height to `scrollTop`, so the row under the
   * finger did not move by a pixel. Left alone the next frame reads that write
   * as one frame of scroll the size of the whole page — thousands of px — and
   * the lag saturates at its ceiling. Carry the reference AND every reading in
   * the speed window across the jump instead, so the frame after the pin
   * measures the motion that really happened, which is none. The lag itself is
   * untouched: a stretch already on screen keeps relaxing exactly as it was.
   */
  reseat(dy: number): void;
  /** index -> displacement px for the rows to move this frame */
  displacements(): Map<number, number>;
  /** frames still needed (any phase but idle): the pump keeps scheduling */
  active(): boolean;
  /** a gesture (or its momentum, or its return) is live */
  armed(): boolean;
  phase(): SpringPhase;
  /** the reference lag L, px (the lag of a row RESISTANCE_DIVISOR px from the finger) */
  lag(): number;
  /** zero everything now and drop the gesture (the hold-off: an app motion is starting) */
  freeze(): void;
  /** fresh shell: drop all state */
  reset(): void;
}

export function createSpringField(opts: {
  tau?: number;
  divisor?: number;
  resistanceMax?: number;
  stretchCap?: number;
  gapMin?: number;
  strain?: number;
  buffer?: number;
  velocityWindow?: number;
  velocityHold?: number;
} = {}): SpringField {
  const tau = opts.tau ?? TUNING.LAG_TAU_MS;
  const divisor = opts.divisor ?? TUNING.RESISTANCE_DIVISOR;
  const resistanceMax = opts.resistanceMax ?? TUNING.RESISTANCE_MAX;
  const stretchCap = opts.stretchCap ?? TUNING.STRETCH_CAP_PX;
  const gapMin = opts.gapMin ?? TUNING.GAP_MIN_PX;
  const strain = opts.strain ?? TUNING.GAP_STRAIN_PX;
  const buffer = opts.buffer ?? TUNING.PARTICIPATION_BUFFER_PX;
  const velWindow = opts.velocityWindow ?? TUNING.VELOCITY_WINDOW_MS;
  const velHold = opts.velocityHold ?? TUNING.VELOCITY_HOLD_MS;

  let rows: readonly SpringRow[] = [];
  let L = 0; // the reference lag, px
  let phaseNow: SpringPhase = "idle";
  let isArmed = false;
  let held = false;
  let clientH = 0;
  let threadTop = 0;
  let anchorScreenY: number | null = null;
  let scrollNow = 0;
  let lastScrollTop: number | null = null;
  let lastFrameMs: number | null = null;
  // the trailing run of readings that MOVED, oldest first, windowed to
  // velWindow. Never longer than a handful of entries: at 60 Hz a 50 ms window
  // holds three or four.
  let samples: ScrollSample[] = [];
  let lastAnchorSeen: number | null = null; // the anchor as of the previous frame
  let anchorMovedAt = -Infinity; // the last frame on which the finger's screen-Y changed
  // a finger that has landed on a stretched thread but has not been given the
  // profile's vertex yet, and whether one is waiting (null is a real anchor
  // value, the viewport centre, so the flag carries the state, not the value)
  let pendingAnchorY: number | null = null;
  let vertexParked = false;
  let parkedFingerMoved = false; // the landed finger has since travelled: a real drag
  // THE VERTEX IS A CONTENT POSITION: the row the gesture was started on. It is
  // read once, on the gesture's first frame, and then rides the thread.
  //
  // It used to be a SCREEN position, turned into content every frame as
  // scrollTop + (clientY - threadTop). That is two separately delivered streams
  // subtracted from each other, and it went wrong in both of the ways they can
  // disagree:
  //
  //   - After the finger lifts there is no clientY left to follow, so the screen
  //     position stood still while the content flew past it under momentum. The
  //     vertex sawed through the thread at the full coast speed and every row it
  //     passed reversed its share of the lag, growing while it receded and
  //     shrinking while it approached. That is rows moving in OPPOSITE
  //     directions in the same frame, and a gap opening wide and then being
  //     squeezed flat inside one gesture: in the owner's recording one gap goes
  //     11 px -> 22 px -> 1 px in 400 ms of a single scroll.
  //   - During the drag the two streams are not in phase. scrollTop reaches the
  //     main thread on about three frames in four (this file's own measurement)
  //     while touchmove reaches it on every frame, so their difference jitters by
  //     up to a whole frame of travel. At a flick's speed that is 40 px of vertex
  //     wobble a frame, and every row wobbles by that over the divisor times the
  //     lag: 8.5 px, back and forth, measured on a row in the browser harness.
  //
  // A finger dragging 1:1 keeps the row it grabbed under itself anyway, so
  // re-deriving the vertex every frame was never adding anything to follow — only
  // the noise of the two clocks. Read once, it cannot wobble and it cannot saw.
  let anchorContentY: number | null = null;
  let vertexNeedsSeat = false; // the vertex has been given a screen-Y but no content yet

  function measure(next: readonly SpringRow[]): void {
    rows = next;
  }

  /** the vertex in content space for this scroll position */
  function vertexAt(scrollTop: number): number {
    // no finger at all (a wheel, a pointer): the viewport's own middle, as before
    if (anchorScreenY === null) return scrollTop + clientH / 2;
    // the content the gesture was started on (or, before its first frame has
    // read a position, where the screen says that is)
    return anchorContentY ?? scrollTop + (anchorScreenY - threadTop);
  }

  /** put the vertex on the content under its screen-Y, once */
  function seatVertex(scrollTop: number): void {
    if (anchorScreenY === null || !vertexNeedsSeat) return;
    anchorContentY = scrollTop + (anchorScreenY - threadTop);
    vertexNeedsSeat = false;
  }

  function begin(ch: number, top: number, anchorY: number | null, fingerDown: boolean): void {
    clientH = ch;
    threadTop = top;
    // A finger landing on a thread that still carries stretch does NOT take the
    // profile's vertex. Measured off the owner's Messages recording, on all four
    // cleanly tracked caught coasts: the stretch melts in place on the ordinary
    // return curve, the bubble sitting at the vertex does not move by a pixel
    // through the whole return, and nothing jumps (worst single-frame move 3 to
    // 4.3 CSS px, on stretches of 11 and 27 CSS px). Moving the vertex would
    // move every row at once, because each row's share is its distance from the
    // vertex. So the new touch point waits, and the vertex it would replace
    // stands until the finger's own drag starts (a new drag, whose stretch does
    // belong to the new finger) or the lag reaches rest (nothing left to place,
    // so the swap cannot be seen). Both are the spring's own state; neither is a
    // timer.
    //
    // "The scroll moved again" used to be enough to hand the vertex over, and on
    // the phone that fires immediately: a finger landing to BRAKE a coast does
    // not stop the scroller in the same frame, so the park was released on the
    // very first frame after the catch and the whole profile re-centred anyway —
    // measured in the browser harness at 22 px of jump on one row while its
    // neighbour went 7 px the other way. A finger that lands and holds still is
    // braking, not dragging, so the scroll moving under it says nothing; what
    // says a drag has started is the FINGER moving. Under a wheel there is no
    // finger to ask and the old rule stands.
    if (isArmed && !atRest(L)) {
      pendingAnchorY = anchorY;
      vertexParked = true;
      parkedFingerMoved = false;
    } else {
      anchorScreenY = anchorY;
      anchorContentY = null; // the gesture's first frame seats it on the content
      vertexNeedsSeat = anchorY !== null;
      pendingAnchorY = null;
      vertexParked = false;
      parkedFingerMoved = false;
    }
    held = fingerDown;
    if (!isArmed) {
      // a fresh gesture: the next frame is a baseline, so no delta from before
      // it is ever injected. A gesture already live (a wheel's next tick, a
      // finger catching a coasting thread) keeps its reference: its frames have
      // been reading the position all along
      lastScrollTop = null;
      lastFrameMs = null;
      samples = [];
    }
    isArmed = true;
    // the finger LANDING somewhere is not the finger travelling: a catch moves
    // the anchor across the screen in one step, and reading that as travel
    // would bridge the speed of the coast the catch just killed. Only a
    // touchmove, frame to frame, counts (see the budget in frame()).
    lastAnchorSeen = anchorScreenY;
    anchorMovedAt = -Infinity;
    // a fresh gesture or a grab of a coasting thread drives; a grab mid-return
    // keeps returning until the finger actually moves the scroll
    if (phaseNow === "idle" || phaseNow === "coasting") phaseNow = "driving";
  }

  function anchor(screenY: number): void {
    // while the vertex is parked the finger may travel all it likes: what it
    // updates is the anchor waiting to be adopted, not the one in use, so the
    // melting profile keeps the shape it had when the finger landed. That it
    // travelled at all is the one thing worth remembering: it is what tells a
    // drag from a brake when the park is asked to release.
    if (vertexParked) {
      if (screenY !== pendingAnchorY) parkedFingerMoved = true;
      pendingAnchorY = screenY;
    } else anchorScreenY = screenY;
  }

  function lift(): void {
    held = false;
    if (phaseNow === "idle") isArmed = false; // a still hold: nothing to return
    // the finger is gone mid-drag: the thread coasts on its own momentum and
    // the lag keeps tracking the speed, from the anchor where the finger lifted
    else if (phaseNow === "driving") phaseNow = "coasting";
  }

  function settle(): void {
    L = 0;
    phaseNow = "idle";
    if (!held) isArmed = false;
  }

  function frame(nowMs: number, scrollTop: number): void {
    scrollNow = scrollTop;
    if (!isArmed) return;
    // did the finger move since the previous frame? The wiring re-anchors on
    // every touchmove, and touchmove is NOT gated by the compositor's scroll
    // sync: it arrives every frame while a finger drags. So it is the one
    // honest answer to the question a still scrollTop cannot settle.
    if (anchorScreenY !== lastAnchorSeen) {
      if (lastAnchorSeen !== null) anchorMovedAt = nowMs;
      lastAnchorSeen = anchorScreenY;
    }
    seatVertex(scrollTop); // once per gesture, on the content the finger landed on
    if (lastFrameMs === null || lastScrollTop === null) {
      lastFrameMs = nowMs;
      lastScrollTop = scrollTop;
      samples = [{ t: nowMs, s: scrollTop }];
      return; // a clock and position reading only
    }
    const prevFrameMs = lastFrameMs;
    const dt = Math.max(nowMs - lastFrameMs, 0);
    lastFrameMs = nowMs;
    const delta = scrollTop - lastScrollTop;
    lastScrollTop = scrollTop;
    // How long a scrollTop that has not moved may still be read as a delivery
    // gap. Under a finger the finger decides: a finger that moved on THIS frame
    // is a scroll still moving, so the gap is bridged (out to velWindow, which
    // also ends the bridge if the scroll is pinned at an end of the thread while
    // the finger keeps pulling); the first frame the finger does not move is a
    // stop, budget zero, and the stretch melts from that very frame exactly as
    // the recording does. Nothing is granted a grace period here, which is why
    // the return keeps its measured shape: touchmove arrives every frame while a
    // finger drags, so "moved this frame" is a live signal, not a stale one.
    // With no finger — momentum, a wheel — the clock decides instead.
    const fingerTravelling = held && anchorMovedAt > prevFrameMs;
    const budget = held ? (fingerTravelling ? velWindow : 0) : velHold;
    if (delta !== 0) {
      // a fresh position: it joins the run, and the run keeps only the window
      samples.push({ t: nowMs, s: scrollTop });
      while (samples.length > 2 && nowMs - samples[0].t > velWindow) samples.shift();
    } else if (samples.length > 0 && nowMs - samples[samples.length - 1].t > velWindow) {
      // the scroll really has stopped: the run is spent, and a single reading
      // restamped each still frame keeps the restart's first speed honest.
      //
      // This waits for the whole window, not for `budget`. The budget's job is
      // to decide what this frame is DRIVEN with, and speedOver already reads a
      // stale run as a stop, so the melt still begins on the budget's own frame.
      // Throwing the readings away at the same moment did a second thing that
      // was never wanted: the next fresh position then had only itself and one
      // still frame to be a speed over, so a lumpy delivery's double step read
      // as double the speed and the lag jumped past its steady value. Measured
      // on a drag whose reported finger position repeats between frames (a 2 px
      // quantisation at 0.08 px/ms), the reference lag sat at 4.54 px where the
      // speed says 3.60 and rippled 2.41 px; keeping the run holds it at 3.60.
      samples = [{ t: nowMs, s: scrollTop }];
    }
    // the speed the run carries goes in and the lag relaxes over the frame,
    // exactly: a moving scroll holds L near speed x tau, a stopped one lets it
    // melt. Driving on the RUN's speed rather than this frame's delta is what
    // keeps a frame with no fresh position from dipping the lag — the pulse the
    // owner saw as jitter on slow scrolls (see VELOCITY_WINDOW_MS).
    const v = speedOver(samples, nowMs, budget);
    L = clamp(relaxLag(L, v * dt, dt, tau), -stretchCap, stretchCap);
    if (v !== 0) phaseNow = held ? "driving" : "coasting";
    else if (atRest(L)) settle();
    else phaseNow = "settling";
    // the parked vertex is adopted once the new finger's own drag has started
    // (the finger travelling AND the scroll moving with it: that is a new drag
    // and its stretch is the new finger's), or once the lag is home and no row
    // is placed off the vertex at all. With no finger — a wheel's next tick —
    // the scroll moving is the whole of the answer, as it was.
    if (vertexParked && ((delta !== 0 && (!held || parkedFingerMoved)) || atRest(L))) {
      anchorScreenY = pendingAnchorY;
      pendingAnchorY = null;
      vertexParked = false;
      parkedFingerMoved = false;
      lastAnchorSeen = anchorScreenY; // the adoption itself is not finger travel
      // the adopted vertex is the new finger's, on the content it is over now
      anchorContentY = null;
      vertexNeedsSeat = anchorScreenY !== null;
      seatVertex(scrollTop);
    }
  }

  function reseat(dy: number): void {
    if (dy === 0 || !Number.isFinite(dy)) return;
    if (lastScrollTop !== null) lastScrollTop += dy;
    samples = samples.map((s) => ({ t: s.t, s: s.s + dy }));
    // the inserted page went in ABOVE the viewport, so every row's content
    // coordinate moved down by dy — including the one the vertex is sitting on
    if (anchorContentY !== null) anchorContentY += dy;
  }

  function displacements(): Map<number, number> {
    if (L === 0 || rows.length === 0) return new Map();
    const [lo, hi] = windowBounds(scrollNow, clientH, buffer);
    // the participating span: rows with any part inside the window (rows are in
    // document order, so this is one contiguous run)
    let first = -1;
    let last = -1;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.top + r.height < lo) continue;
      if (r.top > hi) break;
      if (first < 0) first = i;
      last = i;
    }
    if (first < 0) return new Map();
    return profileFor(
      rows, first, last, vertexAt(scrollNow), L, divisor, resistanceMax, gapMin, strain,
    );
  }

  function active(): boolean {
    return phaseNow !== "idle";
  }

  function armed(): boolean {
    return isArmed;
  }

  function phase(): SpringPhase {
    return phaseNow;
  }

  function lag(): number {
    return L;
  }

  function freeze(): void {
    L = 0;
    phaseNow = "idle";
    isArmed = false;
    held = false;
    lastScrollTop = null;
    lastFrameMs = null;
    samples = [];
    lastAnchorSeen = null;
    anchorMovedAt = -Infinity;
    pendingAnchorY = null;
    vertexParked = false;
    parkedFingerMoved = false;
    anchorContentY = null;
    vertexNeedsSeat = false;
  }

  function reset(): void {
    freeze();
    rows = [];
    anchorScreenY = null;
  }

  return {
    measure,
    begin,
    anchor,
    lift,
    frame,
    reseat,
    displacements,
    active,
    armed,
    phase,
    lag,
    freeze,
    reset,
  };
}
