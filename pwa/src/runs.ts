// Runs and the bubble tail: which bubble in a thread carries Messages' tail,
// and the tail's own measured shape.
//
// THE RULE, read off the owner's own Messages thread (the screen recording of
// 2026-09-06 in paratrooper-internal, an RCS thread on a 3x display; every
// frame it holds was read at full resolution). Consecutive bubbles from one
// sender form a run; the tail sits on the run's LAST bubble and on no other.
// Earlier bubbles in a run are fully rounded on all four corners: there is no
// squared corner anywhere, and the tailed bubble's own corner is the same full
// round with the tail hung underneath it. A run ends when the other side
// speaks, when a gap stamp is inserted (the attachment bubble above
// "Wed, Aug 19 at 1:16 PM" carries a tail), when a system line intervenes,
// when the sender pauses (a "Wait" bubble, a photo and a "Test" bubble from
// the same sender each carry one, separated by a wider gap), and at the end of
// the thread. Photos follow the same rule as text: of two sent photos in a
// row, the first has a plain rounded corner and only the second the tail.
//
// This module is the pure half: a fold over the rows in thread order that
// says, for each, whether it continues the run above it (the tight 4px seat)
// and whether it ends its run (the tail). decorate() in main.ts is the wiring:
// it reads the rows off the DOM in order, hands them here, and writes the two
// classes back. Derived from the ordered rows every time, never tracked, so a
// history page landing above, an out-of-order insert, a failed send dropping
// to the end or a bubble being removed all come out right by construction.
//
// THE SHAPE, measured on the same frames at the sub-pixel (coverage-weighted)
// edge, in css px with the bubble's corner radius 18 (the text bubbles' corner
// profile fits a circle of radius 54 device px to within a pixel at every
// depth; photos the same). Relative to the bubble's bottom corner on the
// sender's side, inset measured back from that side's edge and depth measured
// down from the bottom edge:
//
//   - the bubble's own corner is the plain 18px circle down to about 3.5px
//     above the bottom edge (inset 7.7), where the tail's outer edge leaves it;
//   - that edge then straightens into a near-vertical neck at inset 9.3, from
//     about 1px above the bottom edge to 1.5px below it;
//   - below the neck it flares back out to the tip, whose lowest point is
//     6.3px under the bottom edge at inset 8.3, a rounded point about 1.5px
//     wide (the received tail: 6.0px, the same to the tenth);
//   - the underside rises from the tip back to the bottom edge along a
//     concave curve, reaching it at inset 21-22 with a short fillet;
//   - the tail never protrudes past the bubble's side edge: the tip sits 7.7px
//     INSIDE it. (This is the current Messages tail, not the older iOS 7
//     drawing that curls outward past the edge.)
//
// So the tail lives in a box 24px wide and 25px tall hung on the corner: its
// far edge on the bubble's side edge, its top 18px above the bubble's bottom
// (where the corner circle begins) and its bottom 7px below it. TAIL_PATH is
// the fill inside that box. It is not only the tail: it overlaps the bubble's
// own corner by a margin (the polygon that closes it runs through the bubble's
// interior), so the two paints share no antialiased seam, and every edge the
// eye can see is drawn by exactly one of them. styles.css carries the same
// path as a mask data URI; runs.test.ts pins the two copies to each other.

/** two bubbles from one sender inside this many ms are one run */
export const RUN_GAP_MS = 60_000;

/** the bubble's corner radius in css px: text and photo alike, all four corners */
export const BUBBLE_RADIUS = 18;

/** the tail box: its width, its height, and how far its bottom hangs under the bubble */
export const TAIL_W = 24;
export const TAIL_H = 25;
export const TAIL_DROP = 7;

/** where inside the box the bubble's bottom edge runs (TAIL_H - TAIL_DROP) */
export const TAIL_EDGE_Y = TAIL_H - TAIL_DROP;

/**
 * The fill, in the box's own 24x25 coordinates, drawn for a SENT bubble (the
 * tail on the right; x = 24 is the bubble's right edge, y = 18 its bottom).
 * The received tail is this path mirrored about x = 12.
 *
 *   M0 16 V18 H2            the bottom edge, from inside the bubble to inset 22
 *   C5 18 11.8 22.6 14.8 24.3   the underside: concave, down to the tip's inner side
 *   Q15.6 24.9 16.4 23.9    the rounded tip, lowest at about (15.6, 24.5)
 *   C16.5 22.4 14.65 20.5 14.65 19   the outer edge rising into the neck
 *   V17.6                   the neck: near-vertical at inset 9.35
 *   C14.65 16.3 16.2 14.7 17.6 13.5  the neck curving out to rejoin the corner circle
 *   L12 10 H0 Z             the closing run, all of it inside the bubble
 */
export const TAIL_PATH =
  "M0 16V18H2C5 18 11.8 22.6 14.8 24.3Q15.6 24.9 16.4 23.9C16.5 22.4 14.65 20.5 14.65 19V17.6C14.65 16.3 16.2 14.7 17.6 13.5L12 10H0Z";

/** the mask image for one side: an inline svg of the path, the received one mirrored */
export function tailMask(side: "user" | "agent"): string {
  const flip = side === "agent" ? " transform='matrix(-1 0 0 1 24 0)'" : "";
  return (
    `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${TAIL_W} ${TAIL_H}'%3E` +
    `%3Cpath${flip} d='${TAIL_PATH}'/%3E%3C/svg%3E")`
  );
}

/**
 * Put the two masks on the document as --tail-user and --tail-agent, where
 * styles.css reads them (.msg.tail::after, .morphtail). Written from here
 * rather than spelled in the stylesheet so the path has one home, and so the
 * served stylesheet carries no url() at all: the page must fetch nothing
 * before its first paint, and that rule is checked as plain bytes
 * (firstpaint.test.ts). A data URI fetches nothing either, but it reads as
 * one, and nothing about the tail needs to exist before the app is running.
 */
export function installTailMasks(root: { style: { setProperty(name: string, value: string): void } }): void {
  root.style.setProperty("--tail-user", tailMask("user"));
  root.style.setProperty("--tail-agent", tailMask("agent"));
}

/** what the fold reads off each row, in thread order */
export interface RunRow {
  /** "user" | "agent" for a bubble; "system" (or anything else) for a line that is not one */
  role: string;
  /** the row's time, ms */
  at: number;
  /** a gap stamp stands directly above this row */
  stamped: boolean;
}

/** what the fold decides for each row */
export interface RunMark {
  /** continues the run above it: the tight seat, no tail on the bubble above */
  cont: boolean;
  /** ends its run: carries the tail */
  tail: boolean;
}

/** a row that draws a bubble at all; system lines never carry a tail or continue a run */
export function isBubble(role: string): boolean {
  return role === "user" || role === "agent";
}

/**
 * Does `row` continue the run of `prev` (the bubble directly above it, or
 * null when a system line stands between)? Same sender, inside RUN_GAP_MS,
 * and no stamp between them.
 */
export function continues(prev: RunRow | null, row: RunRow): boolean {
  return (
    prev !== null &&
    isBubble(row.role) &&
    row.role === prev.role &&
    row.at - prev.at < RUN_GAP_MS &&
    !row.stamped
  );
}

/**
 * The fold. A bubble carries the tail exactly when the row after it does not
 * continue its run; the last bubble of the thread always does.
 */
export function markRuns(rows: readonly RunRow[]): RunMark[] {
  const marks: RunMark[] = rows.map(() => ({ cont: false, tail: false }));
  let prev: RunRow | null = null;
  let prevIdx = -1;
  rows.forEach((row, i) => {
    const cont = continues(prev, row);
    marks[i].cont = cont;
    if (prevIdx >= 0) marks[prevIdx].tail = !cont;
    if (isBubble(row.role)) {
      marks[i].tail = true; // the end of the thread, until a row below says otherwise
      prev = row;
      prevIdx = i;
    } else {
      prev = null; // a system line breaks the run on both sides
      prevIdx = -1;
    }
  });
  return marks;
}
