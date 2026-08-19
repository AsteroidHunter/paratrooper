// Compose-bar resize compensation — the decision half, DOM-free.
//
// The thread and the compose bar split the fixed shell's height, so any bar
// resize (a wrapped/entered line while typing, the collapse on send) moves
// the thread's BOTTOM edge while the content inside keeps its coordinates.
// Left alone, the browser holds scrollTop, the view slips off the last
// bubble, and the frame-late ResizeObserver re-pin lands AFTER paint — that
// one-frame slip-then-snap was the visible bounce (and mid-history there was
// no compensation at all). The wiring in main.ts (autosize) measures the bar
// before/after the height write and asks HERE what to do with the thread,
// synchronously in the same frame, before anything paints:
//
//   resized at the tail   -> pin-bottom: re-anchor the bottom edge so the
//                            last reply stays exactly in view (grow AND
//                            shrink — the send collapse rides this too)
//   resized mid-history   -> keep-position: a bottom-edge resize never moves
//                            content coordinates, so an untouched scrollTop
//                            IS the stable reading position — write nothing
//   height unchanged      -> none
//
// Same shape as the hold/splash modules: a pure decision (unit-tested, no
// DOM) beneath a few-line wiring in main.ts.

export type Compensation = "pin-bottom" | "keep-position" | "none";

export function compensationFor(
  oldHeight: number,
  newHeight: number,
  atBottom: boolean,
): Compensation {
  if (newHeight === oldHeight) return "none";
  return atBottom ? "pin-bottom" : "keep-position";
}

// followTail protection while composing — the decision half of the device bug
// where each new composer line slid the view up a little more. Failure shape:
// an iOS caret shove (or our own snap-back / pin write) fires thread scroll
// events that momentarily read "away from the bottom", followTail flips false,
// and every later growth line picks keep-position — the slip compounds until
// whole messages are hidden. While the composer is FOCUSED, only a genuine
// user gesture (finger on the thread, or wheel/pointer within the intent
// window — main.ts tracks the timestamps) may turn following off; any other
// away-reading scroll is a shove or a programmatic write and must not disarm
// the re-pin. Reaching the bottom always resumes following, focused or not,
// and with the composer unfocused nothing changes from the shipped rule.
export const USER_SCROLL_INTENT_MS = 600;

export type FollowFlip = "follow" | "unfollow" | "hold";

export function followFlipDecision(
  nearBottom: boolean,
  composerFocused: boolean,
  userIntent: boolean,
): FollowFlip {
  if (nearBottom) return "follow";
  if (!composerFocused || userIntent) return "unfollow";
  return "hold";
}

// The mid-typing shove doors and the kb-vv counter that lived below are
// retired (2026-08): the shell is sized from the visual viewport for the
// whole keyboard session (shell.ts), the composer's focus blink suppresses
// the caret reveal at the source (styles.css) and is re-armed per grown line
// (autosize's growth blink, main.ts), displacement is corrected once at
// keyboard close, and the one mid-typing decision left — a scroll-sourced
// shove refused rather than tracked, with a yield guard against the old
// counter's loop — lives in shell.ts (shoveVerdict), not here.
