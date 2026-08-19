// Send-flight motion: the one beat and ease shared by the flying bubble and
// the sibling shift beneath it, plus the shift's decision half (pure, no DOM).
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
// cross its target and bounce back (the old 1.08 spring did exactly that)
export const FLIGHT_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

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
