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
// the end (the real stretch is gone with the speed). The 50%-of-gap compression
// cap was also tighter than the real transcript, which closes gaps to a third.
//
// Kept from the earlier builds: one shared reference lag L (the lag of a row
// exactly RESISTANCE_DIVISOR px from the finger; each row shows resistance x L,
// so the near-to-far gradient is exact and a row entering the window takes its
// place in the profile with no kink), the translate longhand written by main.ts
// (never the peek's transform), seats read once per gesture, participation
// only near the viewport, a compress guard walked outward from the finger so
// rows can never overlap, and the hold-off through every motion the app owns.
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
 * The row profile for a reference lag L: each row trails by resistance x L,
 * then the compress guard walks outward from the row under the finger and lets
 * no pair on the closing side come nearer than GAP_MIN_PX (or its own rest gap
 * if that is smaller). The opening side is the pure profile. Pure; exported so
 * the guard is unit-testable on its own. `lo..hi` is the inclusive index range
 * of the participating rows, `anchorY` the finger in content space.
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
): Map<number, number> {
  const out = new Map<number, number>();
  if (L === 0 || lo > hi) return out;
  const raw = (i: number): number =>
    resistanceFor(rows[i].top + rows[i].height / 2 - anchorY, divisor, resistanceMax) * L;
  // how far the pair (i, i+1) may close: down to the floor, never past its rest gap
  const room = (i: number): number => {
    const gap = rows[i + 1].top - (rows[i].top + rows[i].height);
    return Math.max(0, gap - gapMin);
  };
  // the split: the first participating row whose centre is at or past the finger
  let split = hi;
  for (let i = lo; i <= hi; i++) {
    if (rows[i].top + rows[i].height / 2 >= anchorY) {
      split = i;
      break;
    }
  }
  // under a hundredth of a pixel a row is not written at all, so the walk
  // snaps such values to zero before a neighbour is placed against them: the
  // guard then holds exactly for what reaches the screen
  const snap = (v: number): number => (Math.abs(v) < 0.01 ? 0 : v);
  const d = new Array<number>(hi - lo + 1);
  d[split - lo] = snap(raw(split));
  // upward: the row above may come no closer to the row below it than the floor
  for (let i = split - 1; i >= lo; i--) {
    const below = d[i + 1 - lo];
    d[i - lo] = snap(Math.min(raw(i), below + room(i)));
  }
  // downward: the row below may come no closer to the row above it
  for (let i = split + 1; i <= hi; i++) {
    const above = d[i - 1 - lo];
    d[i - lo] = snap(Math.max(raw(i), above - room(i - 1)));
  }
  for (let i = lo; i <= hi; i++) {
    const dy = d[i - lo];
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
  buffer?: number;
} = {}): SpringField {
  const tau = opts.tau ?? TUNING.LAG_TAU_MS;
  const divisor = opts.divisor ?? TUNING.RESISTANCE_DIVISOR;
  const resistanceMax = opts.resistanceMax ?? TUNING.RESISTANCE_MAX;
  const stretchCap = opts.stretchCap ?? TUNING.STRETCH_CAP_PX;
  const gapMin = opts.gapMin ?? TUNING.GAP_MIN_PX;
  const buffer = opts.buffer ?? TUNING.PARTICIPATION_BUFFER_PX;

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

  function measure(next: readonly SpringRow[]): void {
    rows = next;
  }

  function begin(ch: number, top: number, anchorY: number | null, fingerDown: boolean): void {
    clientH = ch;
    threadTop = top;
    anchorScreenY = anchorY;
    held = fingerDown;
    if (!isArmed) {
      // a fresh gesture: the next frame is a baseline, so no delta from before
      // it is ever injected. A gesture already live (a wheel's next tick, a
      // finger catching a coasting thread) keeps its reference: its frames have
      // been reading the position all along
      lastScrollTop = null;
      lastFrameMs = null;
    }
    isArmed = true;
    // a fresh gesture or a grab of a coasting thread drives; a grab mid-return
    // keeps returning until the finger actually moves the scroll
    if (phaseNow === "idle" || phaseNow === "coasting") phaseNow = "driving";
  }

  function anchor(screenY: number): void {
    anchorScreenY = screenY;
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
    if (lastFrameMs === null || lastScrollTop === null) {
      lastFrameMs = nowMs;
      lastScrollTop = scrollTop;
      return; // a clock and position reading only
    }
    const dt = Math.max(nowMs - lastFrameMs, 0);
    lastFrameMs = nowMs;
    const delta = scrollTop - lastScrollTop;
    lastScrollTop = scrollTop;
    // the frame's motion goes in and the lag relaxes over the frame, exactly:
    // a moving scroll holds L near speed x tau, a still one lets it melt
    L = clamp(relaxLag(L, delta, dt, tau), -stretchCap, stretchCap);
    if (delta !== 0) phaseNow = held ? "driving" : "coasting";
    else if (atRest(L)) settle();
    else phaseNow = "settling";
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
    const anchorY =
      anchorScreenY === null ? scrollNow + clientH / 2 : scrollNow + (anchorScreenY - threadTop);
    return profileFor(rows, first, last, anchorY, L, divisor, resistanceMax, gapMin);
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
    displacements,
    active,
    armed,
    phase,
    lag,
    freeze,
    reset,
  };
}
