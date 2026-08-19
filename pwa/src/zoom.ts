// Photo-zoom motion math: the pure halves of the lightbox open/close flight
// (main.ts openLightbox drives the DOM). Opening grows the tapped photo from
// its bubble box to the fitted full-screen box; closing returns it to the
// photo's rect AS IT IS at dismissal — the thread may have scrolled or gained
// rows while zoomed, so where to land is a decision, not a memory. Both legs
// ride the send-flight beat and ease (shift.ts): one motion vocabulary, no
// overshoot ever.

import type { MorphBox } from "./shift";

// the resting fit, mirrored from styles.css (.lightbox img): max-width 96vw,
// max-height 92vh, intrinsic ratio kept, never upscaled past natural size.
// Computed here so the open leg can land on the exact box the grid layout
// takes over afterward — the handover moves nothing.
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
