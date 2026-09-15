// Springy transcript — the bubbles lag the scroll through their own springs and
// settle back, the effect Messages has carried since iOS 7 (WWDC 2013 session
// 217 "Exploring Scroll Views", and Ash Furrow's ASHSpringyCollectionView
// derived from it: one UIAttachmentBehavior per visible cell, anchored at the
// cell centre, its centre shifted by the scroll delta scaled by a "scroll
// resistance" that grows with the cell's distance from the touch, then the
// animator relaxes it back). Furrow's spring: length 0, damping 0.8, frequency
// 1 Hz, resistance = (|dx|+|dy|)/1500 clamped so the shift never exceeds the
// delta; only cells near the visible rect get a behavior (a -100pt inset).
//
// There is no dynamics engine in a browser, so the springs are integrated here,
// per animation frame, and each row's displacement is applied by the wiring as a
// compositor-only transform (the `translate` longhand, kept off `transform` so
// the swipe-peek's translateX is never clobbered — styles.css). The mapping:
//
//   - The scroller already moves every row by the full scroll delta. To make a
//     row LAG, we displace it back against the travel by delta*resistance, so it
//     appears to have moved less. resistance in [0, RESISTANCE_MAX): ~0 under the
//     finger (the row tracks the scroll), larger far from it (the row trails).
//     That is what opens the gaps during a drag — "the springs stretch out".
//   - Between and after scroll events every displaced row relaxes toward 0 on a
//     critically damped spring (no overshoot by construction, plus a sign-cross
//     snap so a fast inward pass can never cross rest either). That is the settle
//     — "the springs catching up" — heavily damped, gentle, nothing bounces.
//   - The displacement is capped (DISPLACEMENT_CAP_PX) so even a hard fling opens
//     a gap by no more than a modest amount, and rows can never overlap: the
//     farther row of any pair always displaces at least as much and in the same
//     direction, so a gap only ever opens.
//
// Pure and DOM-free, the shape hold.ts / downbtn.ts / viewport.ts use: numbers
// in (row geometry in content/offsetTop space, scroll position, an anchor),
// displacement numbers out. main.ts owns the reads, the transform writes, the
// rAF pump, the gesture arming and the hold-off during the app's own motions
// (a send flight, the arrival morph, a scroll ride, a keyboard lift, a seat
// move, the receipt crossfade), where the effect is frozen at zero so it never
// fights them and the flight's FLIP shift always measures clean seats.

// The spring, by its undamped natural frequency. Furrow/WWDC used 1 Hz; a touch
// stiffer reads less floaty on the web without losing the gentle tail. Critical
// damping settles to ~5% of the throw in about 4.74/omega ms, so 1.4 Hz is a
// ~540ms return — an unmistakable settle that never feels like lag.
export const SPRING_FREQUENCY_HZ = 1.4;

// omega = 2*pi*f, per millisecond (the whole app clocks in ms).
export const SPRING_OMEGA = (2 * Math.PI * SPRING_FREQUENCY_HZ) / 1000;

// How fast the resistance grows with a row's distance from the anchor, in
// pixels of distance per unit of resistance. Furrow's 1500 was in points on a
// taller device; 1400 gives mid-thread rows a subtle, visible lag on a ~390x844
// phone without the far rows ever approaching a full stall.
export const RESISTANCE_DIVISOR = 1400;

// Resistance is held well under 1 (Furrow clamped the shift to the delta, i.e.
// resistance <= 1, to stop a cell moving the wrong way). Half is gentle and, with
// the cap below, makes crossing impossible: the outer row of any pair displaces
// more in the same direction, so gaps only open.
export const RESISTANCE_MAX = 0.5;

// The most any row may ever be displaced from its seat, in px. Caps the stretch
// on a fast fling and, being far under a row's own height (a bubble is ~40px),
// guarantees no overlap. Kept restrained — the owner asked for subtle: a genuinely
// slow drag opens only a few px (the lag is speed-proportional at low speed,
// resistance*speed/omega), and only a brisk drag or a fling reaches this bound.
export const DISPLACEMENT_CAP_PX = 10;

// Rows within this many px of the viewport participate; everything further out
// holds zero displacement and costs nothing (Furrow's -100pt visible-rect inset).
export const PARTICIPATION_BUFFER_PX = 120;

// A stalled tab's frame can hand back a huge dt; clamp it so the closed form
// cannot teleport a spring (downbtn.ts GLIDE_DT_MAX makes the same guard).
export const DT_MAX_MS = 48;

// At rest: under this much displacement and this slow, the row is home and the
// wiring clears its transform. Sub-visible, so the clear is never seen.
export const REST_EPS_PX = 0.05;
export const REST_EPS_V = 0.02; // px/ms

/** clamp helper (kept local; the app has no shared one) */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * The scroll resistance for a row at `distance` px from the anchor: it grows
 * with distance and saturates at RESISTANCE_MAX, so rows near the finger keep up
 * and rows far from it lag. (Furrow: `(|dx|+|dy|)/1500`, clamped.)
 */
export function resistanceFor(
  distance: number,
  divisor: number = RESISTANCE_DIVISOR,
  max: number = RESISTANCE_MAX,
): number {
  return clamp(Math.abs(distance) / divisor, 0, max);
}

/**
 * Inject one scroll delta into a row's displacement: it lags against the travel
 * by `delta*resistance`, capped. Position only — the delta is a displacement, not
 * an impulse; the relax below owns the velocity.
 */
export function injectDisplacement(
  displacement: number,
  resistance: number,
  delta: number,
  cap: number = DISPLACEMENT_CAP_PX,
): number {
  return clamp(displacement + resistance * delta, -cap, cap);
}

export interface SpringState {
  d: number; // displacement from seat, px
  v: number; // velocity, px/ms
}

/**
 * Relax one spring toward rest over `dt` ms — the exact critically damped
 * solution of x'' = -omega^2 x - 2*omega x' (zeta = 1): x(t) = (d + (v +
 * omega*d) t) e^(-omega t), so it returns to zero with no overshoot from a
 * position offset. The sign-cross snap is belt-and-braces: should a large inward
 * velocity ever carry a spring past rest, it lands exactly on zero instead
 * (downbtn.ts snaps its glide the same way). So "no overshoot" holds for ANY
 * state, not only a pure position offset.
 */
export function relax(
  state: SpringState,
  dt: number,
  omega: number = SPRING_OMEGA,
): SpringState {
  if (dt <= 0) return state;
  const step = Math.min(dt, DT_MAX_MS);
  const e = Math.exp(-omega * step);
  const base = state.v + omega * state.d;
  const d = (state.d + base * step) * e;
  const v = (state.v - omega * base * step) * e;
  // never cross rest: an overdamped/critical spring approached from one side
  // stays on that side, and this makes it true even under a stalled-frame dt
  if ((state.d > 0 && d < 0) || (state.d < 0 && d > 0)) return { d: 0, v: 0 };
  return { d, v };
}

/** home: under the rest thresholds, so the wiring may clear the transform */
export function atRest(state: SpringState): boolean {
  return Math.abs(state.d) < REST_EPS_PX && Math.abs(state.v) < REST_EPS_V;
}

/** one row's geometry, in the scroller's own content space (offsetTop/height) */
export interface SpringRow {
  top: number;
  height: number;
}

/**
 * The participation window in content space. A row visible at the top of the
 * thread sits at offsetTop == scrollTop and one at the bottom at scrollTop +
 * clientHeight, so the visible band is [scrollTop, scrollTop + clientHeight];
 * the buffer widens it a little each way so rows never pop in at the edges.
 */
export function windowBounds(
  scrollTop: number,
  clientHeight: number,
  buffer: number = PARTICIPATION_BUFFER_PX,
): [number, number] {
  return [scrollTop - buffer, scrollTop + clientHeight + buffer];
}

export interface SpringField {
  /** rebuild the row table on a layout change; keeps the state of rows whose
      seat did not move (a re-grab mid-settle), zeroes the rest */
  measure(rows: readonly SpringRow[]): void;
  /** set the delta reference without injecting — for the app's own scroll writes
      and for idle, so the next real drag reads a correct delta */
  rebase(scrollTop: number): void;
  /** a user-driven scroll: inject the delta into every participating row, scaled
      by its resistance from the anchor (a screen-Y touch point, or null for the
      viewport centre during momentum) */
  scroll(
    scrollTop: number,
    clientHeight: number,
    threadTop: number,
    anchorScreenY: number | null,
  ): void;
  /** relax every active spring over the frame */
  frame(nowMs: number): void;
  /** index -> displacement px, only rows not yet at rest */
  displacements(): Map<number, number>;
  /** any spring still moving: the pump keeps scheduling frames while true */
  active(): boolean;
  /** zero everything now (the hold-off: an app motion is starting/running) */
  freeze(): void;
  /** fresh shell: drop all state */
  reset(): void;
}

export function createSpringField(opts: {
  omega?: number;
  divisor?: number;
  resistanceMax?: number;
  cap?: number;
  buffer?: number;
} = {}): SpringField {
  const omega = opts.omega ?? SPRING_OMEGA;
  const divisor = opts.divisor ?? RESISTANCE_DIVISOR;
  const resistanceMax = opts.resistanceMax ?? RESISTANCE_MAX;
  const cap = opts.cap ?? DISPLACEMENT_CAP_PX;
  const buffer = opts.buffer ?? PARTICIPATION_BUFFER_PX;

  let rows: readonly SpringRow[] = [];
  let d: number[] = [];
  let v: number[] = [];
  const activeIndices = new Set<number>();
  let lastScrollTop: number | null = null;
  let lastFrameMs: number | null = null;

  function measure(next: readonly SpringRow[]): void {
    const nd = new Array<number>(next.length).fill(0);
    const nv = new Array<number>(next.length).fill(0);
    // carry a surviving row's spring across a re-measure so a re-grab mid-settle
    // does not snap: same index, same seat top within half a pixel
    for (let i = 0; i < next.length; i++) {
      const was = rows[i];
      if (was && Math.abs(was.top - next[i].top) < 0.5) {
        nd[i] = d[i] ?? 0;
        nv[i] = v[i] ?? 0;
      }
    }
    rows = next;
    d = nd;
    v = nv;
    activeIndices.clear();
    for (let i = 0; i < next.length; i++) {
      if (!atRest({ d: nd[i], v: nv[i] })) activeIndices.add(i);
    }
  }

  function rebase(scrollTop: number): void {
    lastScrollTop = scrollTop;
  }

  function scroll(
    scrollTop: number,
    clientHeight: number,
    threadTop: number,
    anchorScreenY: number | null,
  ): void {
    if (lastScrollTop === null) {
      lastScrollTop = scrollTop;
      return; // first reading of a gesture: a baseline, no delta yet
    }
    const delta = scrollTop - lastScrollTop;
    lastScrollTop = scrollTop;
    if (delta === 0 || rows.length === 0) return;
    // the anchor in content space: a finger at screen-Y maps to scrollTop +
    // (screenY - threadTop); momentum with no finger uses the viewport centre
    const anchorContentY =
      anchorScreenY === null
        ? scrollTop + clientHeight / 2
        : scrollTop + (anchorScreenY - threadTop);
    const [lo, hi] = windowBounds(scrollTop, clientHeight, buffer);
    for (let i = 0; i < rows.length; i++) {
      const center = rows[i].top + rows[i].height / 2;
      if (center < lo || center > hi) continue; // far out: costs nothing
      const resistance = resistanceFor(center - anchorContentY, divisor, resistanceMax);
      const nd = injectDisplacement(d[i], resistance, delta, cap);
      if (nd !== d[i]) {
        d[i] = nd;
        activeIndices.add(i);
      }
    }
  }

  function frame(nowMs: number): void {
    if (lastFrameMs === null) {
      lastFrameMs = nowMs;
      return; // the first frame is only a clock reading
    }
    const dt = nowMs - lastFrameMs;
    lastFrameMs = nowMs;
    if (dt <= 0) return;
    for (const i of [...activeIndices]) {
      const next = relax({ d: d[i], v: v[i] }, dt, omega);
      if (atRest(next)) {
        d[i] = 0;
        v[i] = 0;
        activeIndices.delete(i);
      } else {
        d[i] = next.d;
        v[i] = next.v;
      }
    }
  }

  function displacements(): Map<number, number> {
    const out = new Map<number, number>();
    for (const i of activeIndices) out.set(i, d[i]);
    return out;
  }

  function active(): boolean {
    return activeIndices.size > 0;
  }

  function freeze(): void {
    for (const i of activeIndices) {
      d[i] = 0;
      v[i] = 0;
    }
    activeIndices.clear();
    lastFrameMs = null;
  }

  function reset(): void {
    rows = [];
    d = [];
    v = [];
    activeIndices.clear();
    lastScrollTop = null;
    lastFrameMs = null;
  }

  return { measure, rebase, scroll, frame, displacements, active, freeze, reset };
}
