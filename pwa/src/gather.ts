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
// CARRY. The bundle rises into the seats the thread has already reserved for
// it, growing as it goes: one movement, rising and settling together, not a
// rise followed by a slide. Both ends are live rects, so the caller re-reads
// the seats every frame the way the bar morph does.
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
