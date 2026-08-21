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
//   GREW mid-history      -> give-up: the thread hands back exactly the pixels
//                            the bar just took (scrollTop += the growth), so
//                            the bottom-most line keeps its place on screen
//                            instead of being clipped away under the bar.
//                            This is the "the box eats the last message" fix:
//                            an untouched scrollTop leaves whatever sat at the
//                            bottom edge outside the shrunken box, and with
//                            following off nothing ever pins it back.
//   shrank mid-history    -> keep-position: the box grew back, nothing was
//                            covered, and an untouched scrollTop IS the stable
//                            reading position, so write nothing
//   height unchanged      -> none
//
// Same shape as the hold/splash modules: a pure decision (unit-tested, no
// DOM) beneath a few-line wiring in main.ts.

export type Compensation = "pin-bottom" | "give-up" | "keep-position" | "none";

export function compensationFor(
  oldHeight: number,
  newHeight: number,
  atBottom: boolean,
): Compensation {
  if (newHeight === oldHeight) return "none";
  if (atBottom) return "pin-bottom";
  return newHeight > oldHeight ? "give-up" : "keep-position";
}

// The give-up write, as a number: exactly the height the bar gained, clamped
// to the thread's own range. At the tail this lands on the same value the
// bottom pin does (a shrinking box raises maxScrollTop by the same delta), so
// both arms keep the newest message fully visible and neither one overshoots.
export function giveUpTarget(
  scrollTop: number,
  oldHeight: number,
  newHeight: number,
  maxScrollTop: number,
): number {
  return Math.max(0, Math.min(maxScrollTop, scrollTop + (newHeight - oldHeight)));
}

// The at-bottom verdict, blind to airborne transforms. "Am I at the bottom" is
// asked on every thread scroll event and its answer flips following on and off,
// which in turn decides whether the jump chevron may surface. It was asked of a
// scrollHeight that a send flight INFLATES: the fresh bubble is translated down
// to the compose field and released, CSS counts transformed overflow as
// scrollable area, and so for the flight's whole beat the thread reports a
// bottom sitting the bubble's remaining travel below the one the reader is
// already on. Every send whose bubble travelled more than this window therefore
// read as "away", turned following off, and armed the chevron over a reader who
// had not moved at all — on device six sends split exactly here, the four with
// 213px of travel or more flipping within 30ms and the two shorter ones not at
// all, after which he had to tap the chevron away.
//
// The answer is to subtract the flight, never to widen the window: his travel
// reaches 575px and a window that wide would stop the chevron working. The
// inflation is the part of the translate poking past the thread's own bottom
// padding, which is the subtraction the send-motion recorder (main.ts) has
// always made at the recording site and nothing made at the reading site.
// main.ts reads the live transforms and hands the number in, so the verdict
// stays a live measurement: a real gesture mid-flight still reads honestly.

export const NEAR_BOTTOM_PX = 150; // how close to the end still counts as the bottom

/** how far a translated row hangs past the thread's own bottom padding */
export function flightOverflow(translateY: number, paddingBottom: number): number {
  return Math.max(0, translateY - paddingBottom);
}

export function nearBottomOf(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  overflow = 0,
): boolean {
  return scrollHeight - overflow - scrollTop - clientHeight < NEAR_BOTTOM_PX;
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
// the caret reveal at the source (styles.css) and is re-armed on EVERY
// keystroke while the keyboard is up (autosize, main.ts), displacement is
// corrected once at keyboard close, and the one mid-typing decision left, a
// scroll-sourced shove refused rather than tracked under a per-keystroke
// correction budget, lives in shell.ts (shoveVerdict), not here.
