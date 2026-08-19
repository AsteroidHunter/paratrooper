// Send-flight motion: the one beat and ease shared by the flying bar-morph and
// the sibling shift beneath it, plus the pure halves of both — the shift's
// decision math and the morph's box/crossfade math (no DOM).
//
// The flight was a spring (cubic-bezier with a >1 control point) — the owner's
// verdict: the bounce is wrong. One clean decelerating ease now, no overshoot,
// and the SAME curve drives the preceding rows' FLIP shift, so the gap under
// the older content closes exactly as the bubble arrives — the two motions
// read as one.
//
// The white strip it kills: on a pinned send the instant bottom pin teleports
// the older content up by the new bubble's height while the bubble itself is
// still translated down at the compose field, leaving a bare band between the
// older content and the field for the whole flight. Shifting the preceding
// rows from their pre-insert position to their new one over the flight's own
// beat means the strip never exists in any frame.

export const FLIGHT_MS = 400; // inside the owner's 350-450ms band

// ease-out only: both y control points at/below 1, so the curve can never
// cross its target and bounce back (the old 1.08 spring did exactly that).
// One set of control points feeds BOTH forms of the curve: the CSS string the
// shift/enter animations hand the browser, and the solved function the morph
// evaluates per rAF frame — same numbers by construction, one motion.
export const FLIGHT_EASE_POINTS = [0.22, 1, 0.36, 1] as const;

export const FLIGHT_EASE = `cubic-bezier(${FLIGHT_EASE_POINTS.join(", ")})`;

// The curve, solved numerically for the morph's rAF loop (main.ts
// armFieldMorph): a declarative animation cannot re-aim at a seat that moves
// mid-flight, so the shell drives its own frames and needs the browser's
// bezier here. Bisection on the bezier's x — monotone for control x in
// [0, 1] — then the matching y.
export function flightEase(f: number): number {
  if (f <= 0) return 0;
  if (f >= 1) return 1;
  const [x1, y1, x2, y2] = FLIGHT_EASE_POINTS;
  const at = (a: number, b: number, t: number): number =>
    3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
  let lo = 0;
  let hi = 1;
  let t = f;
  for (let i = 0; i < 32; i++) {
    const x = at(x1, x2, t);
    if (Math.abs(x - f) < 1e-6) break;
    if (x < f) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }
  return at(y1, y2, t);
}

// --- the morph's pure math (armFieldMorph drives the DOM half) ---------------
// The flying element is the BAR: a shell that starts as the typing box's rect
// and pill and compresses into the bubble's rect and corners while it rises.
// Interpolated as real box geometry, never transform scale — scale distorts
// the corner circles and stretches the glyphs, which is the dishonesty the
// morph exists to replace.

export interface MorphBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function morphBox(bar: MorphBox, seat: MorphBox, p: number): MorphBox {
  const mix = (a: number, b: number): number => a + (b - a) * p;
  return {
    left: mix(bar.left, seat.left),
    top: mix(bar.top, seat.top),
    width: mix(bar.width, seat.width),
    height: mix(bar.height, seat.height),
  };
}

// the bar is a uniform pill; the seat keeps iMessage's per-corner shape
// (18/18/4/18, or the run variants), so each corner travels on its own
export function morphCorners(bar: number, seat: readonly number[], p: number): number[] {
  return seat.map((c) => bar + (c - bar) * p);
}

// The text crossfade, in flight-TIME fractions (the box uses the eased curve;
// the fades ride the clock, or the ease-out would finish them almost at
// launch). The bar's as-typed text is gone early, the bubble's laid-out text
// arrives only as the shell settles: the two layouts never paint together,
// which is what hides the multi-line rewrap — no frame shows an in-between
// wrap because no frame shows text mid-morph. The accent face is solid before
// the bubble text starts, so the white text never lands on glass.
export const MORPH_TEXT_OUT = 0.35; // bar text fully faded, fraction of FLIGHT_MS
export const MORPH_TEXT_IN = 0.6; // bubble text starts here, full at landing

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export function barTextAlpha(f: number): number {
  return clamp01(1 - f / MORPH_TEXT_OUT);
}

export function bubbleTextAlpha(f: number): number {
  return clamp01((f - MORPH_TEXT_IN) / (1 - MORPH_TEXT_IN));
}

export function accentAlpha(f: number): number {
  return clamp01(f / MORPH_TEXT_IN);
}

// Which preceding elements ride the shift. Per-element FLIP: delta is how far
// the insert+pin moved THIS element up (its before-top minus after-top, the
// before measured with any mid-flight transform still applied, so a second
// send composes from wherever the first shift visually is). Only elements
// whose glide path — from delta below their new spot up to the spot itself —
// crosses the visible thread box are worth animating; everything else moves
// invisibly off-screen.
export function shiftParticipates(
  topAfter: number,
  bottomAfter: number,
  delta: number,
  viewTop: number,
  viewBottom: number,
): boolean {
  if (delta <= 0.5) return false; // did not move up: no gap to close
  return bottomAfter + delta > viewTop && topAfter < viewBottom;
}

// Elements BORN with the send have no before-rect for the FLIP to glide from —
// the gap stamp decorate() creates above the new bubble is the every-send case
// for the owner (his sends sit hours apart, so each one crosses the stamp
// threshold), and it materialized at full size while every neighbour animated.
// Newborns enter instead: fade up from a small rise on the shared beat, so the
// whole send reads as one motion. The flying bubble's own rows are excluded —
// the flight owns their entrance, and a second treatment would fight it.
export const ENTER_RISE_PX = 10; // kin to the pop-in's 8px, inside the 8-12 band

export function newbornEnter(seenAtMeasure: boolean, carriesFlight: boolean): boolean {
  return !seenAtMeasure && !carriesFlight;
}
