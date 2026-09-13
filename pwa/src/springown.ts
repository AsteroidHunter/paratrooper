// Whose motion a thread scroll event is — the reader's, or the app's own write.
//
// The springy transcript is armed by a GESTURE and frozen by the hold-off, and
// the freeze drops the arm. So when the hold-off lets go part way through a
// motion there is no gesture left for the pump to serve, and the rest of that
// motion runs rigid. A finger still on the glass answers "whose motion is
// this?" by itself. A coast has no finger, and this module is what stands in
// for one.
//
// It exists because the question is genuinely hard to get right. A scroll event
// carries no author: the engine fires the same event for a finger's momentum,
// for a `scrollTop` the app just wrote, and for one the platform restored. The
// app writes this scroller from a dozen places (the bottom pin, the tail
// settle, the keep-view fix, the lift padding, the history pins, the profile
// reconcile's correction, the rides), and several of those write on EVERY FRAME
// of a box animation — a cadence identical to a coast's. Take those for the
// reader's travel and the rows are thrown across the screen with no finger and
// no momentum anywhere near them, which is the whole failure this module is
// here to make impossible.
//
// The evidence it uses, and why each part is needed:
//
//   THE ERA. A gesture on the thread opens it and it stays open only while
//   there is fresh evidence that the motion that gesture began is still
//   running. It is a single clock (see springMotionLive): a gesture act stamps
//   it, and so does a scroll event credited to the reader, but ONLY while the
//   era is already live — a credited event cannot open an era of its own, or a
//   restore by the platform with no gesture behind it would read as travel. An
//   era therefore closes itself SPRING_RUN_GAP_MS after the reader's last act,
//   on every engine, with no timer to schedule and no event that has to arrive
//   for it to lapse. That matters: a tap, a sideways swipe that scrolls
//   nothing, a still hold, a pointer press with no drag — all of them end with
//   a gesture and no scroll after it, and an era that needed a scroll event to
//   close it would stay open for the rest of the session.
//
//   THE RUN. A thread that is still moving delivers scroll events about every
//   frame. One isolated write does not. So a re-open also asks that the
//   PREVIOUS scroll event was inside the same gap, which is what tells a coast
//   from a single pin.
//
//   THE APP'S OWN WRITE. The run test alone cannot tell a coast from a burst of
//   the app's writes, because a burst has exactly the same cadence and each
//   write also stamps the run. So the app stamps its own writes and an event
//   inside that gap is never credited to the reader: it neither re-opens the
//   gesture nor keeps the era alive. This is deliberately SEPARATE from the
//   app's other write clock (main.ts's appWroteAt, which resume.ts's
//   appOwnsScroll reads): that one credits only the resume ride, on purpose,
//   because the chevron's ride must stay outside it for the follow flip to
//   work. For the springs there is no such distinction — every write of the
//   app's is the app's.
//
// WHAT DECLARING A WRITE DOES NOT DO. It refuses the write's scroll event
// CREDIT: the event cannot open a gesture, keep an era alive, or take a coast
// back. It says nothing to a field that is ALREADY armed, because an armed
// field reads the position off the scroller itself on its next frame and never
// asks this module anything. So a write that slides content under a still
// reader has a second obligation: carry the field's reference across the jump
// (main.ts springReseat) so the correction is not read as one frame of travel.
// The two are different questions and both have to be answered where the write
// moves content rather than the view — the profile reconcile, the older-page
// drain, the replay pin, the keep-view fix and the lift padding all do both.
// The writes that move the VIEW to a new end (the bottom pin, the tail settle,
// the rides) have no reference to carry and declare themselves only.
//
// The cost is stated plainly, and it is bigger than "writes delay recovery".
// While the app is writing this scroller at frame cadence, a genuine coast
// crossing the same window cannot be told from those writes by anything here,
// and the springs stay handed back rather than guessing. With ONE constant
// serving both windows, that hand-back does not end by itself: credit is first
// allowed again SPRING_RUN_GAP_MS after the last write, and by then the era
// needs a stamp newer than SPRING_RUN_GAP_MS ago, which only a credited event
// or a gesture could have left. So a single app write inside an UNARMED coast
// ends that coast's eligibility until the reader's next gesture act — not until
// the writes stop. The same arithmetic ends it after a main-thread stall longer
// than SPRING_RUN_GAP_MS, with no write involved at all. Both fail toward no
// springs, which is the safe direction, and springown.test.ts holds them as the
// stated cost rather than as a recovery guarantee. An ARMED field is untouched
// by either: this module gates the take-back only.

/** How long a gap between two scroll events still reads as ONE motion.
 *
 *  A drag and its momentum deliver an event about every frame, so anything
 *  inside this is the same motion still running and anything outside it is an
 *  isolated write. It is the same length of silence main.ts's own rest debounce
 *  already calls the end of a glide, and it is chosen to agree with it. It is
 *  also how long an app write keeps the credit for the event it fires: a
 *  write's scroll event arrives in the same frame or the next one, well inside
 *  this. */
export const SPRING_RUN_GAP_MS = 100;

/** What the wiring knows at the moment a thread scroll event arrives. Every
 *  field is a plain reading main.ts already holds; nothing here touches the
 *  DOM, the clock, or the field's physics. */
export interface SpringScrollRun {
  /** ms since the app's last scroll write to this scroller (Infinity if none) */
  sinceAppWriteMs: number;
  /** ms since the PREVIOUS scroll event on this scroller (Infinity at rest) */
  sinceScrollMs: number;
  /** ms since the last evidence the reader's own motion was live: his last
   *  gesture act on the thread, or the last scroll event credited to him
   *  inside a live era (Infinity when no era is open) */
  sinceMotionMs: number;
  /** the field already has a gesture: there is nothing to take back */
  armed: boolean;
  /** a finger is on the thread right now — that path re-opens on the finger
   *  itself, at the position it is actually at, and does not come through here */
  fingerDown: boolean;
}

/** This scroll event is the app's own write landing, not the reader's motion.
 *  Credit it to the reader and a burst of the app's writes becomes his travel. */
export function springScrollIsAppWrite(sinceAppWriteMs: number): boolean {
  return sinceAppWriteMs < SPRING_RUN_GAP_MS;
}

/** The reader's motion is still running: there is evidence of it inside the run
 *  gap. This is the era's whole lifetime — it needs no closer to lapse, and a
 *  coast of any length keeps it alive by delivering events. */
export function springMotionLive(sinceMotionMs: number): boolean {
  return sinceMotionMs < SPRING_RUN_GAP_MS;
}

/** A scroll event may be credited to the reader's own motion: it is not the
 *  app's write, and there is a live era for it to belong to. Only a credited
 *  event keeps an era alive; nothing here can open one. */
export function springCreditsReader(r: {
  sinceAppWriteMs: number;
  sinceMotionMs: number;
}): boolean {
  return !springScrollIsAppWrite(r.sinceAppWriteMs) && springMotionLive(r.sinceMotionMs);
}

/** Take the gesture back on a coast the reader threw.
 *
 *  Every term is a veto, and each one names a way this could otherwise be the
 *  app's own motion drawn as his:
 *    armed       — a gesture is already open; re-opening would reset its baseline
 *    fingerDown  — the finger path owns this, on the position it is at
 *    era + run   — this event continues a motion a gesture of his began
 *    app write   — this event is one the app just asked for
 *
 *  The caller re-opens with a FRESH baseline, so neither the travel that passed
 *  while the springs read zero nor the write that woke this event can be read
 *  as a frame of scrolling. */
export function springTakesCoastBack(r: SpringScrollRun): boolean {
  if (r.armed || r.fingerDown) return false;
  if (!springCreditsReader(r)) return false;
  return r.sinceScrollMs < SPRING_RUN_GAP_MS;
}
