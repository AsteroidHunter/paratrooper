// The picked photos' send flight: the pure geometry behind main.ts
// armShotMorph. A text send has the bar morph and shift.ts holds its math; a
// photo send now has this one, built from the same parts. Real box
// interpolation on the shared beat and ease, never transform scale, and no
// bubble face of any kind behind the picture at any point.
//
// The flight is two legs on one clock.
//
// GATHER. More than one picked photo means more than one square waiting in the
// strip, laid out in a wrapping row. They cluster into a single bundle first,
// and only then does the bundle travel. Regrouping while the whole group is
// also crossing the screen is not something an eye can follow: it reads as the
// photos scattering rather than as an arrangement changing. Doing it first
// makes the regroup a move of its own, and what leaves the strip afterwards is
// one object. A single photo has no arrangement to change, so it gets no
// gather at all (gatherMsFor) and simply travels.
//
// CARRY. The bundle travels into the seats the thread has already reserved
// for it, growing as it goes. Its path is an L and not a diagonal: straight up
// out of the strip first, then across into the seats. The corner between the
// two legs is rounded rather than square (elbowPath, SHOT_BEND), because an
// object that has to come to a stop in order to turn reads as a machine doing
// two moves, and the send is meant to read as one hand carrying something to
// its place. Both ends are live rects, so the caller re-reads the seats every
// frame the way the bar morph does. The L belongs to this flight alone: the
// bar morph a text send rides shares the beat, the ease and the box
// arithmetic, and none of the corner below.
//
// THE CROP. A strip thumbnail is a hard 64px square filled with object-fit:
// cover, so it shows the middle of the photo and nothing else, while the sent
// photo is its own true shape. The picture is therefore never squeezed to fit
// the square: it is painted at the size its cover crop needs (coverBox) and
// cut down to the square, and that cut opens over the carry until it reaches
// the whole photo. The lightbox already solves this exact problem when a
// thread photo grows into a full screen frame, and the cut arithmetic is
// shared with it (zoom.ts zoomClipInset).

import type { MorphBox } from "./shift";

// About four tenths of the carry. The shared ease is an ease-out that spends
// most of a beat's travel in its first third, so a gather much shorter than
// this is over before the eye has found it, while one much longer stops being
// a preamble and becomes the send. Kept under half the carry either way, so
// the beat that actually delivers the photos is always the longer of the two.
export const GATHER_MS = 160;

// The deck's shoulder. Landing every square on exactly one box would hide all
// but the top photo, and the bundle would read as a single picture rather than
// as several travelling together. Three pixels of each square showing past the
// one in front says "several" and is far too little to read as a spread.
export const DECK_STEP_PX = 3;

/** the beat a photo flight spends gathering, which a lone photo does not spend */
export function gatherMsFor(count: number): number {
  return count > 1 ? GATHER_MS : 0;
}

// The box the whole photo would fill so that its middle exactly covers the
// square it is cropped into: css object-fit: cover with the default centred
// position, written out as arithmetic. The larger of the two ratios is the one
// that covers, and the overflow hangs equally off both sides, which is why the
// offsets are halves.
export function coverBox(square: MorphBox, natW: number, natH: number): MorphBox {
  if (!(natW > 0) || !(natH > 0)) {
    return { left: square.left, top: square.top, width: square.width, height: square.height };
  }
  const scale = Math.max(square.width / natW, square.height / natH);
  const width = natW * scale;
  const height = natH * scale;
  return {
    left: square.left + (square.width - width) / 2,
    top: square.top + (square.height - height) / 2,
    width,
    height,
  };
}

// Where the squares cluster. The bundle sits on the middle of the picked
// squares rather than on the first or the last of them, so every square moves
// toward the group and none of them has to cross the whole strip to reach it;
// on a strip of three that centre is roughly under the seat the photos are
// about to fly to, so the carry that follows is close to a straight rise.
// Each seat keeps its own square's size, and the deck steps down and right
// with the index while the caller paints the first photo on top, which is the
// order the thread stacks them in.
export function bundleSeats(
  squares: readonly MorphBox[],
  step: number = DECK_STEP_PX,
): MorphBox[] {
  const n = squares.length;
  if (n === 0) return [];
  let cx = 0;
  let cy = 0;
  for (const s of squares) {
    cx += s.left + s.width / 2;
    cy += s.top + s.height / 2;
  }
  cx /= n;
  cy /= n;
  return squares.map((s, i) => {
    const off = (i - (n - 1) / 2) * step;
    return {
      left: cx + off - s.width / 2,
      top: cy + off - s.height / 2,
      width: s.width,
      height: s.height,
    };
  });
}

export type ShotLegName = "gather" | "carry";

export interface ShotLeg {
  /** which of the two legs this moment belongs to */
  leg: ShotLegName;
  /** how far through that leg, before any easing, always inside 0 to 1 */
  f: number;
  /** the carry has reached its end and the flight is over */
  done: boolean;
}

// One clock, read into a leg and a fraction of that leg. The ease is applied by
// the caller to f, so each leg gets the whole curve rather than a slice of one
// curve stretched over both: the gather decelerates into the bundle and the
// carry decelerates into the seat, which is what makes them read as two
// deliberate moves instead of one interrupted one. A gather of zero (the lone
// photo) is skipped outright, so the first frame is already carrying.
export function shotLeg(elapsed: number, gatherMs: number, carryMs: number): ShotLeg {
  if (gatherMs > 0 && elapsed < gatherMs) {
    return { leg: "gather", f: elapsed > 0 ? elapsed / gatherMs : 0, done: false };
  }
  if (!(carryMs > 0)) return { leg: "carry", f: 1, done: true };
  const raw = (elapsed - gatherMs) / carryMs;
  const f = raw > 1 ? 1 : raw > 0 ? raw : 0;
  return { leg: "carry", f, done: f >= 1 };
}

// --- the carry's corner ------------------------------------------------------

// How much of the carry the two legs share, which is the only number that
// says how round the corner is. Zero is a true right angle: the rise finishes
// before the run begins, so the object has to stop dead to turn, and a frame
// by frame reading of a square corner shows the speed falling to a tenth of
// its peak at the turn, which is exactly the stop an eye reads as mechanical.
// One puts both legs on the whole carry, which makes them the same motion
// again and hands back the diagonal this replaced. In between, the run starts
// while the rise is still finishing, and the overlap is the curve. At this
// value a little over half the height is a dead straight rise and a little
// over half the width is a dead straight run, with the turn in the middle of
// each: unmistakably an L, and never a bowed diagonal. Turn it down for a
// sharper corner, up for a softer one.
export const SHOT_BEND = 0.3;

export interface ElbowPath {
  /** how far through the rise, which leads, always inside 0 to 1 */
  up: number;
  /** how far through the run, which follows, always inside 0 to 1 */
  across: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// Smoothstep, flat at both ends of a leg and steepest in its middle. Flat
// ends are the whole point: the leg that is finishing and the leg that is
// starting both pass through the overlap at a speed that is easing to or from
// nothing, so neither one steps, and the join is a curve rather than a cut
// corner. Straight ramps would blend just as well in time and still leave two
// creases in the path, which is a chamfer and not a rounding.
const smoothLeg = (u: number): number => u * u * (3 - 2 * u);

// The two legs, read off the one progress the carry already runs on. Their
// windows are symmetric about the middle of that progress: the rise owns the
// first (1 + bend) / 2 of it and the run owns the last, so the legs are the
// same length and overlap by exactly the bend. Nothing here starts a second
// clock or lays a second curve over the shared ease. The progress handed in
// is already eased, and all this says is which axis has spent how much of it.
export function elbowPath(p: number, bend: number = SHOT_BEND): ElbowPath {
  const leg = (1 + clamp01(bend)) / 2; // never under a half, so neither divisor can vanish
  return {
    up: smoothLeg(clamp01(p / leg)),
    // measured back from the landing rather than forward from where the run
    // opens, so both ends stay exact whatever number the bend is set to
    across: smoothLeg(clamp01((p - 1) / leg + 1)),
  };
}

// One frame's box on that L. The SIZE stays on the shared progress, so the
// photo grows over the whole travel instead of doing all its growing on one
// leg: cramming the growth into the rise would land the picture at full size
// with a slide still to come, and cramming it into the run would hold a
// thumbnail up the whole way. Only the box's MIDDLE is split between the two
// legs, and it has to be the middle rather than the left and top edges: a box
// pinned by its left edge while it grows drifts its middle sideways, which
// would put horizontal motion inside the leg that is supposed to be straight
// up. Growing about the middle is what keeps the rise honest. Feeding both
// legs the shared progress gives back exactly morphBox, so the diagonal is
// still in here as the bend's own limit.
export function elbowBox(
  from: MorphBox,
  to: MorphBox,
  p: number,
  at: ElbowPath,
): MorphBox {
  const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
  const width = mix(from.width, to.width, p);
  const height = mix(from.height, to.height, p);
  const cx = mix(from.left + from.width / 2, to.left + to.width / 2, at.across);
  const cy = mix(from.top + from.height / 2, to.top + to.height / 2, at.up);
  return { left: cx - width / 2, top: cy - height / 2, width, height };
}
