// Opening a gesture on the field, and the one rule the wheel needs that a
// finger does not.
//
// THE DEFECT THIS EXISTS FOR. Independent browser review measured genuine wheel
// input moving scrollTop 480 px and producing exactly 0 px of row displacement,
// in both modes and both directions, across four runs. The field was armed the
// whole time and its reference lag never left 0.00. The cause is a sequencing
// livelock between three things that are each correct on their own:
//
//   - a gesture's FIRST frame is a baseline only. The field deliberately takes
//     a clock and a position and returns, so no travel from before the gesture
//     can be injected as a frame of scrolling.
//   - a gesture with NO FINGER on the glass is disarmed the moment it sees a
//     frame with no motion while the lag is still at rest: speedOver needs two
//     readings that MOVED, a lone baseline is not two, so the speed reads zero,
//     the lag is at rest, and the field settles and drops the gesture. With a
//     finger that cannot happen - settle() keeps the arm while held - which is
//     why the drag and the touch paths were never affected.
//   - a wheel re-arms on every tick, and re-arming a DROPPED gesture throws the
//     sample run away and starts the baseline over.
//
// A desktop delivers scroll updates to the main thread at roughly half the
// frame rate, so one frame in two has no motion in it. Those three rules then
// lock: baseline, quiet frame, disarm, re-arm, baseline, quiet frame. The field
// never holds two moved readings at once, so it never measures a speed, so the
// lag never leaves zero. It is stable rather than intermittent, which is why
// every one of the reviewer's runs measured exactly 0 px.
//
// THE FIX, and what it deliberately does not do. Nothing in the field changes:
// the physics, the stop detection and the disarm rule are all the shipped ones,
// and the finger paths are untouched down to the frame. What changes is what
// the WIRING hands a no-finger gesture at the moment it opens. Instead of
// burning the first animation frame on a baseline, the gesture is opened with
// the readings the pump has already taken - the two most recent, if they are
// recent enough to be the same motion - so a field re-opened in the middle of a
// scroll that is still moving starts with the speed that scroll actually has.
// It cannot inject travel from before the gesture by more than the one frame it
// replays, and it only replays at all when that frame is inside REPLAY_WINDOW_MS.

import type { SpringEngine } from "./engine";

/** one position the pump read, and when */
export interface ScrollReading {
  t: number;
  s: number;
}

/**
 * How recently the pump must have read a position for it to count as part of
 * the motion a gesture is opening into, rather than as history. Three frames at
 * 60 Hz: long enough to bridge the half-rate delivery a desktop gives, short
 * enough that a scroll from a second ago can never be replayed as live travel.
 */
export const REPLAY_WINDOW_MS = 100;

/**
 * How long after a wheel tick or a pointer press a bare scroll event still
 * belongs to that gesture. The app's own USER_SCROLL_INTENT_MS (viewport.ts).
 */
export const GESTURE_INTENT_MS = 600;

export type GestureOpen = "kept" | "seeded" | "baselined";

export interface OpenGestureInput {
  clientH: number;
  threadTop: number;
  /** the finger's screen-Y, or null for a wheel (the viewport's centre) */
  anchorScreenY: number | null;
  fingerDown: boolean;
  nowMs: number;
  /** the scroll position as it stands, end-spring overscroll included */
  scrollTop: number;
  /** the positions the pump has read, oldest first; only the last two are used */
  recent: readonly ScrollReading[];
}

/**
 * Open (or re-open) a gesture on the field.
 *
 *   "kept"       the gesture was already live, or a finger owns it: the field's
 *                own timing stands, untouched.
 *   "seeded"     a fresh no-finger gesture, opened with the two most recent
 *                readings so it starts with a real speed.
 *   "baselined"  a fresh no-finger gesture with nothing recent to replay: a
 *                single baseline at the current position, which is what the
 *                field would have taken on its next frame anyway.
 */
export function openGesture(field: SpringEngine, g: OpenGestureInput): GestureOpen {
  const fresh = !field.armed();
  field.begin(g.clientH, g.threadTop, g.anchorScreenY, g.fingerDown);
  // A finger keeps the shipped timing exactly. It cannot hit the livelock
  // above - settle() holds the arm while a finger is down - and its first
  // frame's baseline is part of what the return curve was measured against.
  if (!fresh || g.fingerDown) return "kept";
  const n = g.recent.length;
  if (n >= 2) {
    const last = g.recent[n - 1];
    const prev = g.recent[n - 2];
    if (last.t > prev.t && last.s !== prev.s && g.nowMs - last.t <= REPLAY_WINDOW_MS) {
      field.frame(prev.t, prev.s); // the baseline, at where the motion was
      field.frame(last.t, last.s); // and one real frame of it
      return "seeded";
    }
  }
  field.frame(g.nowMs, g.scrollTop);
  return "baselined";
}

/**
 * Should a bare scroll event re-open a gesture the field has dropped?
 *
 * main.ts has springown.ts for this question, because in the real app the
 * answer turns on whose motion it is: the hold-off can open and close inside a
 * coast the reader threw, and an app write must never be read as a drag. This
 * tool has no app-owned motions and writes the scroller only from its own
 * scripted gestures, so the question collapses to: was there a real gesture
 * recently, and is there no finger already holding one open.
 */
export function takesScrollBack(state: {
  armed: boolean;
  fingerDown: boolean;
  nowMs: number;
  lastGestureAt: number;
}): boolean {
  if (state.armed || state.fingerDown) return false;
  return state.nowMs - state.lastGestureAt < GESTURE_INTENT_MS;
}
