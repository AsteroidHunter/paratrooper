// Bubble width fit — a wrapped bubble ends at its longest line, not at the cap.
//
// The dead space he photographed: .msg is a flex item with max-width: 75%, and
// that is the whole of the browser's sizing answer for text that does not fit
// on one line. The box is set to the cap FIRST and the text is wrapped inside
// it afterwards, and nothing ever goes back to shrink the box onto the lines
// the wrap actually produced. A one-line bubble shrink-wraps and looks right;
// the moment a line breaks, whatever the last word could not use is left as
// bare bubble on the right — 255pt of sent bubble with 166pt of ink on its
// widest line, 56pt of nothing, measured on the device. Received bubbles have
// it too; it just reads as less wrong against the left edge.
//
// There is no CSS for this. width: fit-content resolves to the same cap for
// text longer than the cap, and it has to: the wrap depends on the width, so
// the width cannot depend on the wrap. Only a second pass, after the browser
// has laid the lines out, knows where they ended. So: measure the rendered
// line boxes, cap the bubble at the widest of them plus its own padding, and
// the wrap that produced those lines is reproduced inside a box with nothing
// left over.
//
// Two rules keep that honest:
//
//   The cap can never be tighter than the widest line, or the text re-wraps
//   inside the box that was measured from it and the bubble grows a line —
//   the one outcome worse than the dead space. A pixel of slack absorbs
//   sub-pixel rounding, and the pass then CHECKS: it reads the height back
//   after writing the cap, and any bubble that grew is handed its natural
//   width straight back. A fit that did not work costs nothing and leaves no
//   trace.
//
//   Nothing is measured that is not plain wrapped text. A bubble with any
//   element inside it — a photo, the PR row's link and button, the typing
//   dots — is skipped outright rather than reasoned about, because the line
//   boxes of a range over mixed content are not the thing this arithmetic
//   describes. Skipping is always safe; a bubble left alone is exactly the
//   bubble that shipped for weeks.
//
// The pass is written as four separate loops over the batch — clear, read,
// write, verify — and that ordering is the performance of it: the reads all
// happen after all the writes, so a batch of any size costs two forced
// layouts rather than two per bubble. Everything DOM lives behind FitBubble
// so the ordering itself can be tested without a browser (main.ts holds the
// one adapter, which is also where a running entrance animation's transform
// is divided back out of the painted rects).

// One thing about the measurement had to be learned from a browser rather than
// reasoned about: getClientRects does NOT hand back one rect per line. It hands
// back one per text FRAGMENT, and a line is split into several whenever the
// engine's runs are split — every soft wrap ends in its own 4.4px rect for the
// hanging space, and a line containing tabs came back as five. Measured in
// Chrome, one line of a real bubble: a 136px fragment inside a line that was
// really 217px wide. Taking the widest RECT would have capped that bubble at
// two thirds of its own text, which the height check would then have thrown
// away — the fit would have looked like it worked and quietly done nothing on
// half the messages in the thread.
//
// So a line is measured from the content box's left edge to the furthest right
// edge any of its rects reaches. Bubble text is left-aligned and starts at that
// edge on every line, so that distance IS the line, and it cannot come out
// short whichever way the engine chose to split the run.

/** the pixel of slack that absorbs sub-pixel rounding in the measured lines */
export const BUBBLE_FIT_SLACK_PX = 1;

/** below this much dead space there is nothing worth writing a style for */
export const BUBBLE_FIT_MIN_GAIN_PX = 2;

/** a transform this close to 1 is measurement rounding, not an animation */
export const BUBBLE_FIT_SCALE_EPSILON = 0.01;

// Bubbles whose content is not plain wrapped text. The element-child count
// below already excludes every one of them in practice; naming them as well
// says which cases were considered, and keeps the rule true if one of them
// ever renders as bare text.
const SKIP_CLASSES = ["shot", "typing", "pr", "system"];

/**
 * Is this a bubble the fit may touch at all? Plain-text .msg only: anything
 * with an element inside it is somebody else's geometry.
 */
export function bubbleQualifies(
  classes: readonly string[],
  elementChildren: number,
): boolean {
  if (!classes.includes("msg")) return false;
  if (elementChildren > 0) return false;
  return !SKIP_CLASSES.some((c) => classes.includes(c));
}

/** rects on the same line box never differ by this much vertically */
const LINE_TOP_TOLERANCE_PX = 1;

/** as much of one rect from the range as the measurement reads */
export interface InkRect {
  top: number;
  right: number;
}

/**
 * The rendered lines' widths, from the rects of a range over the bubble's text.
 * Everything comes in PAINTED pixels — the rects, and `contentLeft`, which is
 * the painted left edge of the content box — and comes out in layout pixels.
 *
 * Rects are grouped by the line box they sit on, and each line is measured to
 * the furthest right edge in its group. Getting that grouping wrong is
 * deliberately harmless in both directions: splitting one line into two leaves
 * the widest group still reaching that line's furthest rect, and merging two
 * lines into one leaves the widest right edge exactly where it was. Only the
 * COUNT moves, and the count is a guard, not an input to the arithmetic.
 */
export function bubbleLineWidths(
  rects: ArrayLike<InkRect>,
  contentLeft: number,
  scale: number,
): number[] {
  const tops: number[] = [];
  const widths: number[] = [];
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const reach = (r.right - contentLeft) / scale;
    let line = tops.findIndex((t) => Math.abs(t - r.top) < LINE_TOP_TOLERANCE_PX);
    if (line < 0) {
      line = tops.length;
      tops.push(r.top);
      widths.push(0);
    }
    if (reach > widths[line]) widths[line] = reach;
  }
  return widths;
}

/**
 * The border-box width that ends the bubble at its longest rendered line.
 * Null when there is nothing to fit: a single line box already shrink-wraps,
 * and an unmeasurable one is not something to guess at.
 */
export function bubbleTargetWidth(
  lineRectWidths: readonly number[],
  paddingLeft: number,
  paddingRight: number,
): number | null {
  if (lineRectWidths.length < 2) return null; // one line: the browser already fits it
  let widest = 0;
  for (const w of lineRectWidths) {
    if (!Number.isFinite(w) || w < 0) return null;
    if (w > widest) widest = w;
  }
  if (widest <= 0) return null; // an empty bubble has no ink to end at
  const pad = paddingLeft + paddingRight;
  if (!Number.isFinite(pad) || pad < 0) return null;
  return Math.ceil(widest) + BUBBLE_FIT_SLACK_PX + pad;
}

/**
 * The scale an entrance animation is currently drawing the bubble at, so the
 * painted rects can be divided back into layout pixels. Range rects answer in
 * painted coordinates and .msg.anim runs a scale(0.88) pop, so a bubble
 * measured on its first frame reads 12% narrow and would re-wrap. Anything
 * within the epsilon is treated as no transform at all: offsetWidth is a
 * rounded integer, and dividing by its own rounding error is worse than not
 * dividing.
 */
export function fitScale(paintedWidth: number, layoutWidth: number): number {
  if (!(paintedWidth > 0) || !(layoutWidth > 0)) return 1;
  const s = paintedWidth / layoutWidth;
  if (!Number.isFinite(s) || s <= 0) return 1;
  return Math.abs(s - 1) < BUBBLE_FIT_SCALE_EPSILON ? 1 : s;
}

/** one bubble, as much of an element as the pass needs to see */
export interface FitBubble {
  /** every class on it, for the skip rule */
  classes(): readonly string[];
  /** element children — anything above zero and the bubble is left alone */
  children(): number;
  /** the widths of its rendered line boxes, in LAYOUT pixels */
  lines(): readonly number[];
  /** its horizontal padding, [left, right] */
  padding(): readonly [number, number];
  /** its laid-out border-box width */
  width(): number;
  /** its laid-out height — the number a mis-sized cap would grow */
  height(): number;
  /** write the explicit cap, or null to hand the natural width back */
  cap(px: number | null): void;
}

/**
 * Fit a batch. Returns how many bubbles ended up capped, which is what the
 * tests read and what a caller could log. Reads and writes are kept in
 * separate loops on purpose (see the header): two forced layouts per batch,
 * whatever its size.
 */
export function fitBubbles(bubbles: Iterable<FitBubble>): number {
  const live: FitBubble[] = [];
  for (const b of bubbles) {
    if (bubbleQualifies(b.classes(), b.children())) live.push(b);
  }
  if (!live.length) return 0;

  // 1. writes only — every candidate back to its natural width, so what the
  //    next loop measures is the layout the stylesheet alone would produce
  //    (a re-fit at a new viewport width measuring through the OLD cap would
  //    just keep re-deriving it)
  for (const b of live) b.cap(null);

  // 2. reads only — one layout serves the whole batch
  const plan: Array<{ b: FitBubble; width: number; height: number }> = [];
  for (const b of live) {
    const [padLeft, padRight] = b.padding();
    const target = bubbleTargetWidth(b.lines(), padLeft, padRight);
    if (target === null) continue;
    if (b.width() - target < BUBBLE_FIT_MIN_GAIN_PX) continue; // no dead space to take
    plan.push({ b, width: target, height: b.height() });
  }
  if (!plan.length) return 0;

  // 3. writes only
  for (const p of plan) p.b.cap(p.width);

  // 4. reads only — a cap that re-wrapped the text grew the bubble, and that
  //    bubble gets its natural width back rather than a second guess
  let fitted = 0;
  for (const p of plan) {
    if (p.b.height() > p.height) p.b.cap(null);
    else fitted += 1;
  }
  return fitted;
}
