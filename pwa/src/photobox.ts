// Photo-bubble box math: the seat a photo takes in the thread, worked out from
// the file's own pixels before a single one of them is drawn (main.ts does the
// DOM half, in send()). A photo row that enters the thread unsized is zero tall
// until it decodes, so the pin that follows the insert lands on a bubble that
// has not grown yet; the decode then grows the row downward and the photo comes
// to rest as a thin top sliver under the compose bar. Reserving this box first
// and pinning after is the fix.
//
// The box mirrors the stylesheet exactly: .msg caps a bubble at 75% of its row,
// and .msg.shot img is max-width 100% with height auto, so a photo's used width
// is its own width capped by the bubble's share of the row, and its height
// follows from the aspect ratio. Never upscaled: a photo narrower than the cap
// keeps its own size, which is what max-width alone would leave it at.

export const SHOT_MAX_WIDTH = 0.75; // .msg max-width in styles.css

export interface PhotoBox {
  width: number;
  height: number;
}

export function photoBox(natW: number, natH: number, rowW: number): PhotoBox {
  if (!(natW > 0) || !(natH > 0)) return { width: 0, height: 0 };
  // a row that cannot be measured (a thread with no layout yet) must never
  // collapse the photo to nothing: fall back to its natural width, which the
  // stylesheet's max-width still caps on its own
  const cap = rowW > 0 ? rowW * SHOT_MAX_WIDTH : natW;
  const width = Math.min(natW, cap);
  return { width, height: (width * natH) / natW };
}
