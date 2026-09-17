// The install face typing itself out — the schedule, with no DOM in it.
//
// Opened in a browser tab, the sign-in screen is a run of messages from
// Paratrooper telling you how to put it on the home screen. It does not arrive
// as a finished page: the head is there, the chat's own typing dots sit where
// the first message will be, and a second later that message grows out of
// them. Then the dots come up again under it, hold, and become the second
// message; and so on down the run, five times, the way five short lines arrive
// from a person who is typing each one — dots, message, dots, message. Then
// the line under them fades in.
//
// That is a clock and an order, and neither of those is a DOM problem, so
// neither of them lives in main.ts. This module answers one question — at what
// millisecond does each piece appear, and how does it appear when it does —
// and hands back the whole reveal as a list. main.ts arms one timer per step
// and plays it. The same shape as the rest of the app: a pure core with a thin
// wiring over it, so the cadence can be read, argued with and tested without a
// browser anywhere near it.
//
// THE NUMBERS. The lead is a full second because the dots are the app saying
// something is coming, and a second is about how long a held breath is; under
// it the dots read as a flicker on the way to the content, over it they read
// as a wait. The cadence is the gap from one message landing to the next
// landing: nine tenths of a second, which is long enough for each line to be
// read as it lands before the next one arrives. It was four tenths, and at
// that pace the owner saw the five land as one flurry rather than five
// messages — the run has to be read, not watched, so each message gets its
// own beat. Inside that beat the dots have to be seen: the message lands, a
// short settle passes so its box has finished growing (the morph takes 280ms,
// arrival.ts ARRIVE_MS, and the settle is just past that), the dots come up
// under it, and they hold for the rest of the beat before they become the next
// message — six tenths of the nine, so the dots are the greater part of every
// gap and the run reads as typed rather than as dealt. The close is the
// cadence's own beat again, so the line under the messages reads as the end of
// the same run rather than as a sixth message that came early. All of them are
// named here and nowhere else, so the pace is one number to move.
//
// REDUCED MOTION. The app has no reduced-motion handling anywhere else, on
// instruction (styles.css says so where the bubble entrance is declared). This
// screen is the exception the owner asked for, and it is answered here rather
// than in the sheet: with the phone asking for less motion the schedule
// collapses to a single instant, every step at zero with no entrance on any of
// them, and there are no dots at all — dots that never blink are not an
// indicator, they are a box that flashes.

/** the dots alone, before the first message takes their box */
export const REVEAL_LEAD_MS = 1000;
/** one message landing to the next landing */
export const REVEAL_CADENCE_MS = 900;
/**
 * a message landing to the dots coming up under it for the next one: just past
 * the morph's own 280ms, so the box has stopped growing before the dots appear
 */
export const REVEAL_SETTLE_MS = 300;
/**
 * the dots' hold under a landed message before they become the next one — the
 * rest of the cadence once the settle is taken out of it, and so the greater
 * part of every gap. Derived, not chosen twice: the cadence is the beat the
 * owner approved, and the settle is the morph's, so this is what is left.
 */
export const REVEAL_HOLD_MS = REVEAL_CADENCE_MS - REVEAL_SETTLE_MS;
/** the last message to the line under the run: the cadence's own beat again */
export const REVEAL_CLOSE_MS = 900;

/** which piece of the face a step is about */
export type RevealPart = "dots" | "message" | "statement";

/**
 * How the piece appears when its moment comes.
 *
 * "morph" is the chat's reply arrival: the dots' own box grows into the
 * message with the dots fading out inside it (arrival.ts). Every message wears
 * it, because every message is preceded by the dots and so has a box to take
 * over — the same entrance an incoming reply has in the chat, and the only
 * entrance a message on this face has. "fade" is the closing line's, and
 * "none" is the piece simply being there — which is what the dots do
 * (Messages' indicator has no entrance either) and what everything does under
 * reduced motion.
 */
export type RevealEntrance = "morph" | "fade" | "none";

export interface RevealStep {
  /** milliseconds from the start of the reveal */
  at: number;
  part: RevealPart;
  /**
   * which message, 0-based. For the dots it is the message they come up FOR —
   * the row they sit in and the one they become; -1 for the closing line.
   */
  index: number;
  /** the last bubble of the run, and so the one carrying the tail */
  tail: boolean;
  entrance: RevealEntrance;
}

/**
 * The whole reveal, in the order it plays, for a run of `count` messages.
 *
 * Every step carries its own moment rather than a delay from the one before,
 * so the caller arms one timer per step against a single start and a step that
 * runs late cannot push the rest of the run along behind it.
 */
export function revealSteps(count: number, reduced = false): RevealStep[] {
  const steps: RevealStep[] = [];
  for (let i = 0; i < count; i++) {
    const lands = REVEAL_LEAD_MS + i * REVEAL_CADENCE_MS;
    // the dots come up before every message and hold until it takes their
    // box: the lead's whole second before the first, and the hold before each
    // of the rest. The first pair is the reveal's first frame, not a step that
    // waits for one. Under reduced motion they do not happen at all.
    if (!reduced) {
      steps.push({
        at: lands - (i === 0 ? REVEAL_LEAD_MS : REVEAL_HOLD_MS),
        part: "dots",
        index: i,
        tail: false,
        entrance: "none",
      });
    }
    steps.push({
      at: reduced ? 0 : lands,
      part: "message",
      index: i,
      // the run's tail hangs under its last bubble and nowhere else, which is
      // the chat's rule (runs.ts) rather than a decision taken again here
      tail: i === count - 1,
      entrance: reduced ? "none" : "morph",
    });
  }
  const lastMessage = count > 0 ? REVEAL_LEAD_MS + (count - 1) * REVEAL_CADENCE_MS : 0;
  steps.push({
    at: reduced || count === 0 ? 0 : lastMessage + REVEAL_CLOSE_MS,
    part: "statement",
    index: -1,
    tail: false,
    entrance: reduced ? "none" : "fade",
  });
  return steps;
}
