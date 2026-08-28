// A photo's box once it is standing in the thread, and the scroll that must
// not move when that box changes shape.
//
// The thread is an inner scroller, and iOS Safari does not anchor scroll
// position to content: overflow-anchor is unsupported there through current
// versions. So when a box ABOVE the reader's top edge changes height, nothing
// holds the view still. The engine keeps scrollTop, the content under it
// slides by exactly the height that box gained, and the whole screen jumps.
// That is what scrolling through photo history looked like on his phone: not
// a stall, not a dropped frame, but the picture he was reading walking up or
// down the screen every time a photo further back finished loading.
//
// Two rules keep that from happening, and they work as a pair.
//
//   Decide the box ONCE per render. A photo whose frame carries its own size
//   is laid out at that size before a single pixel arrives, and nothing the
//   pixels bring can move it. A photo with no size stands in the guessed box
//   below, which carries an explicit ratio, so the arriving pixels cannot
//   silently reshape it either. The box only ever changes when this app
//   deliberately changes it, in one place, at one moment.
//
//   Hand the pixels back when it does change. A change to a box entirely
//   above the reader's top edge is corrected in the same frame by moving
//   scrollTop the same distance, so the content on screen does not move at
//   all. A change at or below that edge is left alone: nothing above the edge
//   moved, so there is nothing to correct, and a scroll write there would
//   itself be the jump.
//
// And one rule that makes the whole question rarer over time: a size the app
// had to measure from the pixels is written back into the stored frame, so
// the next render of that photo, cold open included, starts at the right box
// and never guesses again.
//
// All three decisions are pure and unit tested with no DOM. main.ts holds the
// reads, the writes and the store, the same split viewport.ts and photolazy.ts
// use.

/** a photo's pixel size, the shape the wire and the cache both carry */
export type Dims = [number, number];

// --- the guessed box ----------------------------------------------------------
// What a photo nothing has ever measured stands in. Unchanged from what has
// always been drawn there, down to the numbers: the point of this file is that
// boxes stop moving, not that they look different.
//
// The ratio is written out explicitly rather than left to the width and height
// below. An explicit ratio is not the natural one, so the arriving pixels have
// no say in this box at all, which is what makes the guess safe to stand in
// and what makes the one deliberate change below measurable: the height read
// before the change is still the guessed height, whatever has decoded by then.

export const GUESS_W = 240;
export const GUESS_H = 180;
export const GUESS_RATIO = "4 / 3";

// --- the scroll a resize has to hand back --------------------------------------
// Anything within a pixel of the reader's top edge counts as above it. A box
// whose bottom sits a fraction of a pixel inside the view is not something a
// reader can see change, but it IS enough to send the uncorrected branch every
// row below it walking up the screen, which is the whole failure.

export const FOLD_SLOP_PX = 1;

/**
 * How far scrollTop has to move so a box changing height leaves the view where
 * it is. Zero means write nothing.
 *
 * @param boxBottom the changing box's bottom edge BEFORE the change
 * @param fold      the top edge of what the reader can see, same coordinates
 * @param delta     the height the box gained, negative when it lost height
 * @param following the view is pinned to the end of the conversation
 *
 * Following the tail returns zero on purpose. The tail settle already puts the
 * scroll on the fresh end of the range every time the geometry moves, and a
 * second correction on top of it would be counted twice.
 */
export function scrollFix(
  boxBottom: number,
  fold: number,
  delta: number,
  following: boolean,
): number {
  if (!Number.isFinite(delta) || delta === 0) return 0;
  if (following) return 0; // the settle owns the scroll here; do not correct twice
  if (!Number.isFinite(boxBottom) || !Number.isFinite(fold)) return 0;
  return boxBottom - FOLD_SLOP_PX <= fold ? delta : 0;
}

// --- remembering a size the app had to measure itself --------------------------
// The stored frame carries one entry per attachment, index aligned, holding
// either that photo's size or null. Null is the server saying it measured the
// preview and could not, and until now it meant this photo guesses its box on
// every render this device will ever do, forever.
//
// A photo that guessed and then decoded knows better than that null: it has
// its own pixels in front of it. So the measured size fills the slot, and the
// frame that comes out is the same shape a frame from the server is. Nothing
// about the record changes, only how often the field is filled in, which is
// why this needs no new cache era and no schema handling of its own.
//
// A slot that already holds a size is never overwritten. That photo rendered
// from a real size and never guessed, and its box is not this file's business.

/**
 * The attachment sizes to store, or null when there is nothing to learn.
 *
 * @param cur   the frame's current sizes, absent on a frame that has none
 * @param count how many attachments the frame carries
 * @param index which attachment was measured
 * @param dims  what it measured
 */
export function learnDims(
  cur: readonly (Dims | null)[] | undefined,
  count: number,
  index: number,
  dims: Dims,
): (Dims | null)[] | null {
  if (!Number.isInteger(index) || index < 0 || index >= count) return null;
  if (!(dims[0] > 0) || !(dims[1] > 0)) return null;
  const out: (Dims | null)[] = [];
  for (let i = 0; i < count; i++) out.push(cur?.[i] ?? null);
  if (out[index]) return null; // already carries a size: it never guessed
  out[index] = [dims[0], dims[1]];
  return out;
}

// --- TEMP DIAGNOSTIC (served-shape) --------------------------------------------
// Every rule above rests on one thing being true: that a photo laid out at the
// size its frame carries is laid out at the shape its own pixels turn out to
// be. If that ever fails, the first rule fails with it — the box IS free to
// change shape after all, and the app neither knows nor corrects it.
//
// It is worth doubting because of how the box is written. Width and height
// attributes under `height: auto` resolve to `aspect-ratio: auto W/H`, and the
// `auto` in that keyword is not decoration: the attribute ratio holds the box
// only UNTIL the image loads, and the image's own natural ratio holds it from
// then on. So bytes of a different shape than the frame promised reshape the
// box silently at load, and the one correction in this file's story is wired to
// the guessing branch alone and never sees it.
//
// The comparison is here rather than at the DOM because it is arithmetic, and
// because arithmetic can be pinned with a test. main.ts holds the reads.
//
// TO REMOVE: this section, checkServedShape and its counters in main.ts, the
// "served-shape" name in the app.py photo digest, and the tests naming them.

/** how the pixels that arrived differ in shape from the size the frame promised */
export interface ServedShape {
  /** told W×H and served H×W: the transposition, the one that stands a box up */
  swap: 0 | 1;
  /** told aspect over served aspect; 1 is the same shape at a different size */
  r: number;
}

/**
 * Null when the served pixels are exactly the size the frame promised, because
 * agreement is what this expects to find and a record per agreeing photo would
 * be a whole history's worth of noise saying nothing.
 *
 * A pair that cannot be compared answers null as well. A zero or a NaN on
 * either side is a picture that never decoded, and its box was never the shape
 * of anything.
 */
export function servedShape(told: Dims, nat: Dims): ServedShape | null {
  const [w, h] = told;
  const [nw, nh] = nat;
  if (!(w > 0) || !(h > 0) || !(nw > 0) || !(nh > 0)) return null;
  if (w === nw && h === nh) return null;
  // the ratio is carried as well as the flag because a mismatch that is not a
  // clean transposition still reshapes the box, and a number says how far
  return {
    swap: w === nh && h === nw ? 1 : 0,
    r: Math.round((w / h / (nw / nh)) * 1000) / 1000,
  };
}
