// Springy transcript, second build — the bubbles lag the scroll by their
// distance from the finger, the gaps open while the finger moves, and a beat
// after the scroll stops the rows visibly fall back into their seats. The effect
// Messages has carried since iOS 7 (WWDC 2013 session 217 "Exploring Scroll
// Views": one UIAttachmentBehavior per visible cell, the cell's centre shifted
// by the scroll delta scaled by a "scroll resistance" that grows with the
// cell's distance from the touch; Ash Furrow's ASHSpringyCollectionView is the
// open derivation: length 0, damping 0.8, frequency 1 Hz, resistance =
// distance/1500, the shift clamped to the delta, springs only near the visible
// rect).
//
// Why the first build was invisible (the numbers are in the wiki agent notes):
// it capped every row at 10px, so at any real finger speed all far rows sat on
// the cap and the field flattened into a uniform 9px block shift — the widest
// gap opened 4px at a crawl and ONE pixel at a fling — and its critically
// damped 1.4 Hz spring returned that 9px at 0.7px per frame, over before the
// eye registered a fall. This build keeps what was right there (compositor-only
// `translate`, seats read once per gesture, only near-viewport rows, the
// hold-off through every app-owned motion) and rebuilds the physics:
//
//   - ONE spring, not one per row. Every row's springs are identical and driven
//     in proportion, so their responses are proportional: the field holds a
//     single reference lag D (the lag of a row exactly RESISTANCE_DIVISOR px
//     from the finger) and each row shows resistance * D. Capping or relaxing D
//     moves the whole profile in proportion, so the near-to-far gradient — the
//     opening gaps — is never flattened, which is exactly what the per-row cap
//     did. Furrow's per-cell springs are the same linear system; this is the
//     closed form of it.
//   - Driven per animation frame from the scroll position, not from scroll
//     events: each frame injects the frame's scroll delta into D and relaxes it
//     on the spring, so a steady drag holds a speed-proportional lag
//     (2*zeta*speed/omega at resistance 1) and the stretch builds with finger
//     speed and with distance from the finger.
//   - Underdamped, Furrow's 0.8 at 1 Hz: a slow, visible settle with a hint
//     (1.5%) of overshoot, never a snap.
//   - A beat. When the scroll position stops changing (the finger stopped on
//     the glass, or momentum ran out) the springs hold for a moment and then let
//     go from rest, so the fall reads as "a beat, then the rows drop back".
//   - Rows never overlap, by geometry: on the compressing side (the rows ahead of
//     the finger's motion, which close up as the far ones lag) each pair may
//     close at most GAP_CLOSE_MAX of its own rest gap. The bound is derived from
//     the seats the gesture measured, so a tight continuation pair keeps its
//     room while a stamp gap can bunch further. The stretching side (behind the
//     finger) only ever opens, so it needs no overlap bound — only a plain
//     ceiling on D so a hard fling stops growing the stretch.
//
// Sign, checked against the owner's description: after scrolling toward older
// messages (scrollTop falling) D is negative, the rows sit above their seats and
// fall DOWN into place; after scrolling toward newer, they sit below and spring
// UP. Pure and DOM-free: geometry, a scroll position and an anchor in, a
// per-row displacement map out. main.ts owns the reads, the writes and the rAF.

// ---- every tunable, in one place ---------------------------------------------
export const TUNING = {
  /** px of distance from the finger per unit of resistance (Furrow: 1500). The
      amplitude knob: smaller = the far rows lag more for the same drag. */
  RESISTANCE_DIVISOR: 1500,
  /** resistance never exceeds 1: a row never lags by more than the scroll
      itself, so it can never move the wrong way on screen (Furrow's clamp). */
  RESISTANCE_MAX: 1,
  /** the spring's undamped natural frequency (Furrow/WWDC: 1 Hz) */
  FREQUENCY_HZ: 1.0,
  /** damping ratio (Furrow: 0.8; 1 is critical). 0.8 settles with a 1.5%
      overshoot — a settle, not a snap and not a bounce. */
  DAMPING_RATIO: 0.8,
  /** the scroll position must sit still this long before the springs count as
      released (a slow finger can skip a frame or two; this is longer) */
  STOP_QUIET_MS: 50,
  /** then the rows hold their stretch this long before letting go — the beat */
  RELEASE_BEAT_MS: 100,
  /** the fraction of any pair's rest gap that may close on the compressing
      side. 0.5: a 4px continuation gap keeps 2px, a 12px sender gap keeps 6px.
      Rows can never touch, whatever the drag. */
  GAP_CLOSE_MAX: 0.5,
  /** ceiling on the reference lag D, px: a hard fling stops stretching here.
      Not an overlap bound (the stretching side cannot overlap) — the steady
      lag a 1.2 px/ms drag would reach, so ordinary drags never touch it and
      only a fling does. */
  STRETCH_CAP_PX: 300,
  /** rows with any part within this many px of the viewport participate. A
      row entering the field takes its lag beyond this band, and a row leaving
      it drops its (guard-bounded, tens of px) compression there, so the band is
      wider than any compression the guard can allow: both happen off screen. */
  PARTICIPATION_BUFFER_PX: 200,
  /** a stalled tab's frame can hand back a huge dt; clamp it */
  DT_MAX_MS: 48,
  /** home: under this lag and this slow, everything clears. A quarter pixel —
      under the DOM's own half-pixel rounding, so the clear is never seen, and
      it ends the sub-pixel tail of the settle instead of pumping it for a
      second more. */
  REST_EPS_PX: 0.25,
  REST_EPS_V: 0.01, // px/ms
} as const;

/** omega = 2*pi*f, per millisecond (the whole app clocks in ms) */
export const SPRING_OMEGA = (2 * Math.PI * TUNING.FREQUENCY_HZ) / 1000;

/** the steady lag of the reference row per px/ms of scroll speed: 2*zeta/omega */
export const LAG_PER_SPEED_MS = (2 * TUNING.DAMPING_RATIO) / SPRING_OMEGA;

/** clamp helper (kept local; the app has no shared one) */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * The scroll resistance for a row at `distance` px from the finger: grows with
 * distance, saturates at RESISTANCE_MAX. (Furrow: `(|dx|+|dy|)/1500`, clamped.)
 */
export function resistanceFor(
  distance: number,
  divisor: number = TUNING.RESISTANCE_DIVISOR,
  max: number = TUNING.RESISTANCE_MAX,
): number {
  return clamp(Math.abs(distance) / divisor, 0, max);
}

export interface SpringState {
  d: number; // displacement from seat, px
  v: number; // velocity, px/ms
}

/**
 * Relax one spring toward rest over `dt` ms: the exact solution of
 * x'' + 2*zeta*omega*x' + omega^2*x = 0. Underdamped (zeta < 1, the shipped
 * 0.8) it swings through rest once by a small fraction and settles; at zeta = 1
 * it is the critical form. Closed form, so a long frame cannot blow it up.
 */
export function relax(
  state: SpringState,
  dt: number,
  omega: number = SPRING_OMEGA,
  zeta: number = TUNING.DAMPING_RATIO,
): SpringState {
  if (dt <= 0) return state;
  const t = Math.min(dt, TUNING.DT_MAX_MS);
  const { d, v } = state;
  if (zeta < 1) {
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    const e = Math.exp(-zeta * omega * t);
    const c = Math.cos(wd * t);
    const s = Math.sin(wd * t);
    const b = (v + zeta * omega * d) / wd;
    return {
      d: e * (d * c + b * s),
      v: e * (v * c - ((omega * omega * d + zeta * omega * v) / wd) * s),
    };
  }
  // critical damping (zeta >= 1 is treated as 1): x(t) = (d + (v + omega d) t) e^(-omega t)
  const e = Math.exp(-omega * t);
  const base = v + omega * d;
  return { d: (d + base * t) * e, v: (v - omega * base * t) * e };
}

/** home: under the rest thresholds, so the wiring may clear the transforms */
export function atRest(state: SpringState): boolean {
  return Math.abs(state.d) < TUNING.REST_EPS_PX && Math.abs(state.v) < TUNING.REST_EPS_V;
}

/** one row's geometry, in the scroller's own content space (offsetTop/height) */
export interface SpringRow {
  top: number;
  height: number;
}

/**
 * The participation window in content space: the visible band [scrollTop,
 * scrollTop + clientHeight] widened by the buffer each way. A row takes part if
 * any of its box lies inside, so a row leaves the window only once it is wholly
 * beyond the buffer — and the stretching side moves rows away from the viewport,
 * so a row dropping its lag at the window's edge is never on screen when it does.
 */
export function windowBounds(
  scrollTop: number,
  clientHeight: number,
  buffer: number = TUNING.PARTICIPATION_BUFFER_PX,
): [number, number] {
  return [scrollTop - buffer, scrollTop + clientHeight + buffer];
}

/**
 * The row profile for a reference lag D: each row lags by resistance * D, then
 * the compress guard walks outward from the row under the finger and lets no
 * pair close by more than GAP_CLOSE_MAX of its rest gap. Pure; exported so the
 * guard is unit-testable on its own. `lo..hi` is the inclusive index range of
 * the participating rows, `anchorY` the finger in content space.
 */
export function profileFor(
  rows: readonly SpringRow[],
  lo: number,
  hi: number,
  anchorY: number,
  D: number,
  divisor: number = TUNING.RESISTANCE_DIVISOR,
  resistanceMax: number = TUNING.RESISTANCE_MAX,
  closeMax: number = TUNING.GAP_CLOSE_MAX,
): Map<number, number> {
  const out = new Map<number, number>();
  if (D === 0 || lo > hi) return out;
  const raw = (i: number): number =>
    resistanceFor(rows[i].top + rows[i].height / 2 - anchorY, divisor, resistanceMax) * D;
  const gapBelow = (i: number): number =>
    Math.max(0, rows[i + 1].top - (rows[i].top + rows[i].height)); // rest gap between i and i+1
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
  // upward: the row above may come no closer to the row below it than closeMax of their gap
  for (let i = split - 1; i >= lo; i--) {
    const below = d[i + 1 - lo];
    d[i - lo] = snap(Math.min(raw(i), below + gapBelow(i) * closeMax));
  }
  // downward: the row below may come no closer to the row above it
  for (let i = split + 1; i <= hi; i++) {
    const above = d[i - 1 - lo];
    d[i - lo] = snap(Math.max(raw(i), above - gapBelow(i - 1) * closeMax));
  }
  for (let i = lo; i <= hi; i++) {
    const dy = d[i - lo];
    if (dy !== 0) out.set(i, dy);
  }
  return out;
}

export type SpringPhase = "idle" | "driving" | "coasting" | "beat" | "settling";

export interface SpringField {
  /** (re)build the row table: once per gesture and on a layout change. The
      spring itself is row-independent, so a re-measure mid-settle never snaps. */
  measure(rows: readonly SpringRow[]): void;
  /** a gesture begins: the finger's screen-Y (null = the viewport centre, for a
      wheel or a pointer), the viewport, and the thread's screen top; the next
      frame is the delta baseline. `held` says a finger is on the glass. */
  begin(clientHeight: number, threadTop: number, anchorScreenY: number | null, held: boolean): void;
  /** the finger moved: the field re-centres on it */
  anchor(screenY: number): void;
  /** the finger left the glass; momentum, if any, is still the gesture */
  lift(): void;
  /** one animation frame: read the scroll position, drive and relax the spring,
      detect the stop, run the beat, settle. */
  frame(nowMs: number, scrollTop: number): void;
  /** index -> displacement px for the rows to move this frame */
  displacements(): Map<number, number>;
  /** frames still needed (any phase but idle): the pump keeps scheduling */
  active(): boolean;
  /** a gesture (or its momentum, or its settle) is live */
  armed(): boolean;
  phase(): SpringPhase;
  /** the reference lag D, px (the lag of a row RESISTANCE_DIVISOR px from the finger) */
  lag(): number;
  /** zero everything now and drop the gesture (the hold-off: an app motion is starting) */
  freeze(): void;
  /** fresh shell: drop all state */
  reset(): void;
}

export function createSpringField(opts: {
  omega?: number;
  zeta?: number;
  divisor?: number;
  resistanceMax?: number;
  stretchCap?: number;
  closeMax?: number;
  buffer?: number;
  stopQuietMs?: number;
  releaseBeatMs?: number;
} = {}): SpringField {
  const omega = opts.omega ?? SPRING_OMEGA;
  const zeta = opts.zeta ?? TUNING.DAMPING_RATIO;
  const divisor = opts.divisor ?? TUNING.RESISTANCE_DIVISOR;
  const resistanceMax = opts.resistanceMax ?? TUNING.RESISTANCE_MAX;
  const stretchCap = opts.stretchCap ?? TUNING.STRETCH_CAP_PX;
  const closeMax = opts.closeMax ?? TUNING.GAP_CLOSE_MAX;
  const buffer = opts.buffer ?? TUNING.PARTICIPATION_BUFFER_PX;
  const stopQuietMs = opts.stopQuietMs ?? TUNING.STOP_QUIET_MS;
  const releaseBeatMs = opts.releaseBeatMs ?? TUNING.RELEASE_BEAT_MS;

  let rows: readonly SpringRow[] = [];
  let D = 0; // the reference lag, px
  let V = 0; // its velocity, px/ms
  let phaseNow: SpringPhase = "idle";
  let isArmed = false;
  let held = false;
  let clientH = 0;
  let threadTop = 0;
  let anchorScreenY: number | null = null;
  let scrollNow = 0;
  let lastScrollTop: number | null = null;
  let lastFrameMs: number | null = null;
  let stillSince: number | null = null;
  let beatSince = 0;

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
    stillSince = null;
    // a fresh gesture or a grab of a coasting thread drives; a grab mid-beat or
    // mid-settle keeps that phase (the fall in progress continues) until the
    // finger actually moves the scroll, which flips it to driving
    if (phaseNow === "idle" || phaseNow === "coasting") phaseNow = "driving";
  }

  function anchor(screenY: number): void {
    anchorScreenY = screenY;
  }

  function lift(): void {
    held = false;
    if (phaseNow === "idle") isArmed = false; // a still hold: nothing to settle
    // the finger is gone mid-drag: the thread coasts on its own momentum and
    // the rows ride it with their stretch held, to fall when it stops
    else if (phaseNow === "driving") phaseNow = "coasting";
  }

  function settle(): void {
    D = 0;
    V = 0;
    phaseNow = "idle";
    stillSince = null;
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
    const dt = Math.min(Math.max(nowMs - lastFrameMs, 0), TUNING.DT_MAX_MS);
    lastFrameMs = nowMs;
    const delta = scrollTop - lastScrollTop;
    lastScrollTop = scrollTop;
    if (delta !== 0) {
      stillSince = null;
      if (phaseNow === "coasting") {
        // momentum: the rows ride the coast with the stretch they had at the
        // lift — no injection, no relax — and fall when it stops
        return;
      }
      // the scroll moved under a finger (or a wheel): inject the frame's delta
      // (a row at resistance r lags by r*delta of it) and keep driving
      phaseNow = "driving";
      D = clamp(D + delta, -stretchCap, stretchCap);
    } else if (phaseNow === "driving" || phaseNow === "coasting") {
      // still. The spring's pull is dropped so nothing creeps: a finger that
      // pauses holds the stretch where it is, and after STOP_QUIET_MS the scroll
      // counts as stopped — the beat, then the release from rest
      if (D === 0) {
        settle(); // nothing stretched: a still hold or a lift with nothing to drop
        return;
      }
      if (stillSince === null) stillSince = nowMs;
      V = 0;
      if (nowMs - stillSince >= stopQuietMs) {
        phaseNow = "beat";
        beatSince = nowMs;
      }
      return;
    }
    if (phaseNow === "beat") {
      if (nowMs - beatSince >= releaseBeatMs) phaseNow = "settling";
      else return; // held: nothing moves
    }
    if (dt > 0) {
      const next = relax({ d: D, v: V }, dt, omega, zeta);
      D = clamp(next.d, -stretchCap, stretchCap);
      V = next.v;
    }
    if (atRest({ d: D, v: V })) settle();
  }

  function displacements(): Map<number, number> {
    if (D === 0 || rows.length === 0) return new Map();
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
    return profileFor(rows, first, last, anchorY, D, divisor, resistanceMax, closeMax);
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
    return D;
  }

  function freeze(): void {
    D = 0;
    V = 0;
    phaseNow = "idle";
    isArmed = false;
    held = false;
    stillSince = null;
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
