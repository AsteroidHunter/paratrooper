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
