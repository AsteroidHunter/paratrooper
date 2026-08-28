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

// The bottom geometry moved: where the scroll has to land now.
//
// The scroller's usable range is its content less its box, so anything that
// changes the BOX changes the end of the range. Two of those changes leave a
// band of empty white under the last message, and they are one bug wearing two
// coats:
//
//   the keyboard leaving. While it is up iOS gives the thread a much shorter
//   box, so the end of the range sits far lower in the content; a position
//   that was the end then is past the end once the full box comes back. The
//   device trail measured it: 4329 of content in a 624 box ends at 3705, and
//   the stuck position was 4091, which is that same content less the 238 of
//   box the keyboard had left it.
//
//   the photo drawer collapsing. It hands its own height back to the thread,
//   which lowers the end of the range by exactly the drawer, and the position
//   that was correct while the drawer stood is past the end the moment it goes.
//
// So the rule below is written once for both, and for anything else that moves
// that edge. Following the tail pins to the end computed from the numbers read
// on this frame, never from a target carried over from the old box. Away from
// the tail the position is only CLAMPED: a reader who has deliberately scrolled
// up keeps his place, and is pulled back only when his place no longer exists.
//
// Pure, so the arithmetic is pinned without a DOM, the same split the
// compensation decision above uses; main.ts holds the reads, the write, and the
// signals that call it.

export type SettleMode = "follow" | "clamp";

/** the scroller's three numbers, exactly as the engine reports them */
export interface BottomGeometry {
  sh: number; // scrollHeight
  st: number; // scrollTop
  ch: number; // clientHeight
}

export type TailSettle = {
  mode: SettleMode;
  top: number; // where scrollTop has to be
  over: number; // how far past the end it was, in pixels
  moved: boolean; // whether that is a different place from where it is
};

/** the last position the scroller can hold: content less box, never negative */
export function maxScrollTop(scrollHeight: number, clientHeight: number): number {
  return Math.max(0, scrollHeight - clientHeight);
}

/** how far past its own end the scroller is sitting */
export function tailOverhang(g: BottomGeometry): number {
  return Math.max(0, g.st - maxScrollTop(g.sh, g.ch));
}

// There was a needsSettle() here, asked on every one of the scroller's own
// scroll events, and it is gone on purpose. Sitting past the end is not only
// the fault it was built for: it is also what the engine reports throughout a
// rubber band stretch and as one of our own glides lands, so clamping on it cut
// normal motion and shipped as a regression. Overhang is corrected where it is
// actually created, from the geometry signals, and nothing asks this question
// on a scroll event again.

export function settleBottom(g: BottomGeometry, follow: boolean): TailSettle {
  const max = maxScrollTop(g.sh, g.ch);
  const over = Math.max(0, g.st - max);
  const top = follow ? max : Math.max(0, Math.min(g.st, max));
  return { mode: follow ? "follow" : "clamp", top, over, moved: top !== g.st };
}

// One settle, as the trail carries it: which signal called, what it corrected,
// whether it took a scroll animation down on the way, and how many send flights
// were still in the air when it ran. That last one is what told the failing
// closes from the healthy ones on device, and a flight is also the thing that
// asks for the stale scroll this pass exists to take back, so the two belong on
// the same line. An alias rather than an interface for tailGapFrame's reason,
// so it hands straight to holdDiagRecord's Record without a cast.
export type SettleMark = {
  via: string;
  mode: SettleMode;
  from: number;
  to: number;
  over: number; // the band that would have been left, in pixels
  sh: number;
  ch: number;
  cut: boolean; // an animation the app was running was cancelled by this pass
  air: number; // send flights still airborne
};

export function settleMark(
  via: string,
  g: BottomGeometry,
  plan: TailSettle,
  cut: boolean,
  air = 0,
): SettleMark {
  return {
    via,
    mode: plan.mode,
    from: Math.round(g.st),
    to: Math.round(plan.top),
    over: Math.round(plan.over),
    sh: Math.round(g.sh),
    ch: Math.round(g.ch),
    cut,
    air,
  };
}

// ===================== TEMP DIAGNOSTIC (remove after the tail-gap session) =====================
// The room under the last message, as one number.
//
// Failure shape: after a send he sees the conversation end at its last bubble
// with roughly a screen and a half of nothing between it and the compose bar.
// Two readings taken at that moment disagree with that picture — the document
// held exactly one compose bar, one thread and one mirror, and the at-bottom
// verdict said the thread was already at its end. Both can only be true if the
// thread's content really is taller than its last row, with nothing in the
// difference. Nothing in the app measured that difference, and the census that
// would have come closest fires only on a keyboard close, which is not when he
// sees this.
//
// So: content height, minus the thread's own intentional bottom padding, minus
// the last row's bottom, all in content coordinates. Airborne send rows inflate
// scrollHeight for the length of their flight and are subtracted here for the
// same reason nearBottomOf subtracts them. A gap near zero clears the thread's
// own box and moves the question to the shell; a gap the size of the white
// space is the bug, and `below` then names what is sitting under the message he
// just sent, or reads null when nothing is.
//
// The one thing this reading must never do is measure a wrapper. Every direct
// child of the thread is a .evt grouping shell and styles.css gives those
// display: contents, which means no box at all: zero client rects, a zero-sized
// rect, offsetHeight 0. Geometry taken off one collapses onto the thread's own
// top edge, and the gap that falls out is about one screen tall on ANY thread,
// healthy or not. That is the very symptom under investigation, so a probe
// reading wrappers would answer its own question with a number it invented.
// laidOutRows is the guard: it walks past anything that generates no box.
//
// Readers are injected so the arithmetic is testable without a DOM, the same
// split the kb-fall and dom-census probes use. A reader whose element is gone
// returns NaN and lands as null, never as a zero a reader could mistake for a
// measurement of nothing.

export interface TailReader {
  sh: () => number; // thread scrollHeight, exactly as the engine reports it
  st: () => number; // thread scrollTop
  ch: () => number; // thread clientHeight
  pad: () => number; // the thread's own bottom padding
  air: () => number; // flight inflation already counted inside sh
  lastBottom: () => number; // the last laid-out row's bottom, content coordinates, transforms stripped
  rows: () => number; // how many rows the thread lays out
  below: () => string | null; // the first laid-out row sitting under the sent message, named
}

/**
 * The rows the thread actually lays out, in document order.
 *
 * A .evt wrapper is display: contents, so it holds no box and its children are
 * the thread's own flex items. Rather than list the row classes, which would
 * quietly miss a kind added later, the walk asks the engine directly: an
 * element with client rects IS a laid-out row, and one without is either a
 * wrapper to look inside or a hidden subtree with nothing to report. Same shape
 * laidOutTail (main.ts) walks for the sibling shift, decided by the engine
 * instead of by a class name.
 */
export function laidOutRows(thread: Element): Element[] {
  const out: Element[] = [];
  const walk = (parent: Element): void => {
    for (const el of Array.from(parent.children)) {
      if (el.getClientRects().length > 0) out.push(el);
      else walk(el); // no box of its own: whatever it groups is the real row
    }
  };
  walk(thread);
  return out;
}

/**
 * An element named the way a reader can act on it: tag, id, every class, and
 * the child it holds. "div.row.agent" on its own does not say whether the room
 * under his last message belongs to a photo, a receipt or the typing dots, and
 * that is the entire question `below` is asked.
 */
export function rowName(el: Element): string {
  const spell = (e: Element): string => {
    const id = e.id ? `#${e.id}` : "";
    const cls = typeof e.className === "string" ? e.className.trim() : "";
    return `${e.tagName.toLowerCase()}${id}${cls ? `.${cls.split(/\s+/).join(".")}` : ""}`;
  };
  const inner = el.firstElementChild;
  return inner ? `${spell(el)} > ${spell(inner)}` : spell(el);
}

// One reading, as the trail carries it. An alias rather than an interface so it
// hands straight to holdDiagRecord's Record<string, unknown> without a cast,
// the same reason edgeFrame's frame is one (shell.ts).
export type TailGap = {
  when: string;
  gap: number | null;
  sh: number | null;
  st: number | null;
  ch: number | null;
  pad: number | null;
  air: number;
  lastB: number | null;
  rows: number;
  below: string | null;
  atB: boolean | null;
  short: boolean | null;
};

const tenth = (n: number): number | null =>
  Number.isFinite(n) ? Math.round(n * 10) / 10 : null;

export function tailGapFrame(when: string, read: TailReader): TailGap {
  const sh = read.sh();
  const st = read.st();
  const ch = read.ch();
  const pad = read.pad();
  const air = Number.isFinite(read.air()) ? read.air() : 0;
  const lastB = read.lastBottom();
  // the empty room: everything the thread can scroll through, less the flight
  // still in the air, less the padding the design puts there on purpose, less
  // where the last message actually ends
  const gap = sh - air - pad - lastB;
  // scrollHeight never drops below clientHeight, so a conversation too short to
  // fill the thread reports room under its last message honestly, for a reason
  // that has nothing to do with the bug: the box is simply bigger than what is
  // in it, and there is no scrolling to be done at all. In `gap` alone that is
  // indistinguishable from his screen and a half of white space, so the frame
  // says which of the two it is looking at.
  const short =
    Number.isFinite(lastB) && Number.isFinite(pad) && Number.isFinite(ch)
      ? lastB + pad < ch
      : null;
  return {
    when,
    gap: tenth(gap),
    sh: tenth(sh),
    st: tenth(st),
    ch: tenth(ch),
    pad: tenth(pad),
    air: tenth(air) ?? 0,
    lastB: tenth(lastB),
    rows: read.rows(),
    below: read.below(),
    atB: Number.isFinite(sh) && Number.isFinite(st) && Number.isFinite(ch)
      ? nearBottomOf(sh, st, ch, air)
      : null,
    short,
  };
}
// =================== END TEMP DIAGNOSTIC (remove after the tail-gap session) ===================

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
