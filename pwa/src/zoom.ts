// Photo-zoom motion math: the pure halves of the lightbox open/close flight
// (main.ts openLightbox drives the DOM). Opening grows the tapped photo from
// its bubble box to the fitted full-screen box; closing returns it to the
// photo's rect AS IT IS at dismissal — the thread may have scrolled or gained
// rows while zoomed, so where to land is a decision, not a memory. Both legs
// ride the send-flight beat and ease (shift.ts): one motion vocabulary, no
// overshoot ever.

import type { MorphBox } from "./shift";

// The resting fit: 96% of the viewport's width, 92% of its height, intrinsic
// ratio kept, never upscaled past natural size. This is the ONLY source of the
// resting size: the open leg lands on the box it returns and main.ts keeps
// that box written, rather than dropping the inline geometry onto the css
// max-width 96vw / max-height 92vh rule and letting a second measurement of the
// screen decide. The two agree across the width and need not across the height
// (innerHeight follows the keyboard and iOS misreports it; vh does not), and a
// portrait photo is exactly the one whose fit flips from the width term to the
// height term when they part, so it alone changed size on the landing frame
// while landscape never did.
export const ZOOM_MAX_VW = 0.96;
export const ZOOM_MAX_VH = 0.92;

export function zoomFit(natW: number, natH: number, viewW: number, viewH: number): MorphBox {
  const fit = Math.min((viewW * ZOOM_MAX_VW) / natW, (viewH * ZOOM_MAX_VH) / natH, 1);
  const width = natW * fit;
  const height = natH * fit;
  return { left: (viewW - width) / 2, top: (viewH - height) / 2, width, height };
}

// Where the close leg lands. exact: the photo's current rect is at least
// partly on screen — fly the copy back onto it, wherever it is now. edge: the
// thread scrolled the spot clear off vertically — the full flight to a far
// coordinate would read as a violent throw, so the copy shrinks toward the
// spot's direction and exits across that edge while the caller fades it.
// fade: the photo's row is gone entirely (a retract while zoomed) — no
// direction exists, so the copy shrinks in place and dissolves.

export type ZoomReturnMode = "exact" | "edge" | "fade";

export interface ZoomReturn {
  mode: ZoomReturnMode;
  box: MorphBox;
}

export const ZOOM_EDGE_SCALE = 0.3; // the departing copy's size as it crosses the edge
export const ZOOM_FADE_SCALE = 0.6; // the orphaned copy's size as it dissolves

function shrunk(b: MorphBox, s: number, cx: number, cy: number): MorphBox {
  const width = b.width * s;
  const height = b.height * s;
  return { left: cx - width / 2, top: cy - height / 2, width, height };
}

export function zoomReturn(
  origin: MorphBox | null,
  current: MorphBox,
  viewW: number,
  viewH: number,
): ZoomReturn {
  if (!origin) {
    const cx = current.left + current.width / 2;
    const cy = current.top + current.height / 2;
    return { mode: "fade", box: shrunk(current, ZOOM_FADE_SCALE, cx, cy) };
  }
  if (origin.top < viewH && origin.top + origin.height > 0) {
    return { mode: "exact", box: origin };
  }
  // the exit keeps the spot's horizontal line (clamped on screen) and ends
  // centered ON the offending edge — half out as the fade completes, so the
  // departure reads as motion back into the thread, not a teleport
  const width = current.width * ZOOM_EDGE_SCALE;
  const cx = Math.min(Math.max(origin.left + origin.width / 2, width / 2), viewW - width / 2);
  const up = origin.top + origin.height <= 0;
  return { mode: "edge", box: shrunk(current, ZOOM_EDGE_SCALE, cx, up ? 0 : viewH) };
}

// --- what hides the copy while it is airborne ---------------------------------
// The thread is its own scrolling box and paints nothing outside it, so a photo
// sitting partly behind the top bar or the compose bar is simply cut off at
// that box's edge (the bars do not paint over it — the compose bar has no panel
// at all, and the top bar's lower half is see-through). The flying copy is a
// sheet above everything, so unless it is cut the same way it paints straight
// across whichever bar it overlaps. main.ts cuts it with a rect that rides the
// flight: the thread's own box at the thread end, and at the open end the
// tightest rect the resting zoom actually needs (zoomClipRest below), so the
// frame that lands is cut exactly like the photo it hands back to.
// Edges come back as the four css inset() lengths, measured inward from the
// flying box and never negative: an image paints nothing past its own box, so a
// negative edge would be the same picture as no cut at all.

export interface ZoomInset {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export function zoomClipInset(box: MorphBox, clip: MorphBox): ZoomInset {
  const over = (v: number): number => (v > 0 ? v : 0);
  return {
    top: over(clip.top - box.top),
    right: over(box.left + box.width - (clip.left + clip.width)),
    bottom: over(box.top + box.height - (clip.top + clip.height)),
    left: over(clip.left - box.left),
  };
}

export function zoomClipCuts(i: ZoomInset): boolean {
  return i.top > 0 || i.right > 0 || i.bottom > 0 || i.left > 0;
}

// The cut's OPEN end: the tightest rect that still hides nothing of the copy
// where it is resting. It used to be the whole screen, on the true but far too
// generous reasoning that a resting zoom may cover both bars and so must not be
// cut at all. The cut travels with the flight on the flight's own ease, so a
// close that starts its cut at the whole screen only arrives at the thread's box
// on the very last frame, while the copy's own edge crosses the bar's edge long
// before that — and the band of photo between the two is exactly the paint on
// the bars the close was showing.
//
// The union of the thread's box and the resting box is the smallest rect that
// cannot cut the resting frame, and it answers both shapes:
//   - a photo whose resting fit lands inside the thread's box: the union IS the
//     thread's box, so the copy is cut at the bar's edge from the first frame of
//     the close and no band can ever appear;
//   - a tall capture whose resting fit genuinely covers the bars: the union
//     reaches past them by exactly as much as the resting frame already does,
//     then shrinks to the thread's box, so no frame reveals more bar than the
//     frame before it, which is the property that matters.
export function zoomClipRest(thread: MorphBox, box: MorphBox): MorphBox {
  const left = Math.min(thread.left, box.left);
  const top = Math.min(thread.top, box.top);
  const right = Math.max(thread.left + thread.width, box.left + box.width);
  const bottom = Math.max(thread.top + thread.height, box.top + box.height);
  return { left, top, width: right - left, height: bottom - top };
}
