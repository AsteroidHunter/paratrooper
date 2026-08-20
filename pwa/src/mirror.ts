// The compose box's ruler: measuring the height the text needs WITHOUT ever
// shrinking the live box.
//
// The device bug this exists for. autosize() used to measure the way nearly
// every autogrow textarea on the web does: collapse the live box to its
// rows="1" intrinsic (39px, the number styles.css independently encodes as
// --field-h), read scrollHeight while it sits collapsed, write the height
// back. But the compose bar and the thread split ONE fixed flex column (#app
// is the fixed column, .thread is flex:1), so for the length of that
// measurement the thread was 39px-worth taller and its maximum scroll offset
// was that much LOWER. Reading scrollHeight forces the layout synchronously,
// WebKit pulls the thread's offset down into the smaller range that is left,
// and writing the height back does not push it back up (Safari has no scroll
// anchoring to do that for us). The keystroke that grew a line took a repair
// branch and looked fine. The very next keystroke, which changed no height at
// all, took no branch at all (viewport.ts answers "none" when the height is
// unchanged) and left the clamp standing: the thread jumped up by exactly the
// height the box had lost, and the message above went out of sight. One
// keystroke after every new line, and only ever one keystroke after.
//
// So the measuring moves off the live box onto a twin: a second textarea
// parked off-screen inside the same pill, holding the same text at the same
// width in the same type with the same wrapping. The twin is what gets
// measured, and the live box only ever receives its final height. The live
// box's height never dips, so the thread's maximum never dips, so there is
// nothing for the engine to clamp.
//
// Fidelity is the whole risk here. A twin that disagrees with the live box by
// one pixel sizes the box wrong on EVERY keystroke, which would be a worse bug
// than the one it replaces. Two independent things keep the two equal, and
// each one covers the other's blind spot:
//
//   1. The twin is a real <textarea> inside .field next to the live one, so
//      every rule that styles the live box selects the twin too: the base
//      .compose textarea rule, and the #app.kb / #app.focusing padding widen
//      that runs while the keyboard is up. Nothing is restated here, so
//      nothing can drift when the CSS changes.
//   2. On top of that, the properties that decide where a line breaks are
//      copied off the LIVE element's own getComputedStyle before every
//      measurement (MIRROR_PROPS below). That picks up whatever the shared
//      cascade would miss: an inline style, a padding caught mid-transition,
//      a future rule the twin's place in the DOM does not happen to match.
//
// The twin is taken out of the pill's flex flow (position:absolute), so the
// live box's own width is untouched by its presence, and the twin's width is
// then written from the live box's measured border box, which is the one thing
// flex was giving it that the cascade cannot.

/** the slice of a computed style this module reads, so the tests need no DOM */
export interface StyleSource {
  getPropertyValue(prop: string): string;
}

/** the slice of the off-screen twin: it takes styles and text, it gives a height */
export interface Twin {
  value: string;
  scrollHeight: number;
  style: { setProperty(prop: string, value: string): void };
}

/** the slice of the live compose box: measured, then written, never collapsed */
export interface LiveBox {
  value: string;
  offsetHeight: number;
  scrollHeight: number;
  style: { height: string };
}

/** the slice of the thread: its position is saved and put back, nothing else */
export interface ScrollBox {
  scrollTop: number;
}

// Everything that can move a line break or change a line's height. Named, not
// valued: the values always come from the live element, so a CSS edit lands on
// the twin the same frame it lands on the box. A property this engine does not
// know reads back as "" and setProperty("") removes it, which leaves the
// cascade's own value in place, so an unknown name here is harmless.
export const MIRROR_PROPS: readonly string[] = [
  // the box the text has to fit inside
  "box-sizing",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  // border style comes along because a copied width renders as 0 without it
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-top-style",
  "border-right-style",
  "border-bottom-style",
  "border-left-style",
  // the type, which is what a line of text measures
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-stretch",
  "font-size-adjust",
  "font-variant-caps",
  "font-variant-ligatures",
  "font-variant-numeric",
  "font-kerning",
  "font-optical-sizing",
  "font-feature-settings",
  "font-variation-settings",
  "letter-spacing",
  "word-spacing",
  "line-height",
  "text-indent",
  "text-transform",
  "text-rendering",
  "-webkit-text-size-adjust",
  // where the lines are allowed to break
  "white-space",
  "word-break",
  "overflow-wrap",
  "line-break",
  "hyphens",
  "tab-size",
  "text-wrap",
  // which axis "height" even means, and which way the lines run
  "writing-mode",
  "direction",
];

// The handful of properties the twin must NOT share with the live box, because
// they are what make it a ruler instead of a second control. Applied after the
// copies above, so they win.
export const MIRROR_OVERRIDES: readonly (readonly [string, string])[] = [
  // out of .field's flex flow entirely: the live box is the pill's only flex
  // item before and after, so its own width is exactly what it always was
  ["position", "absolute"],
  ["top", "0"],
  ["left", "0"],
  // hidden, not display:none, which would stop it laying out and reporting
  ["visibility", "hidden"],
  ["pointer-events", "none"],
  // the rows="1" intrinsic, so scrollHeight reports what the TEXT needs rather
  // than whatever height the box happens to be holding
  ["height", "auto"],
  ["min-height", "0"],
  // the five-line cap belongs on the live box; the ruler answers uncapped and
  // the caller does the capping
  ["max-height", "none"],
  // a scrollbar on the ruler would narrow its wrap width and make it lie. The
  // live box only ever scrolls past the cap, where the exact number no longer
  // matters because the cap has already won.
  ["overflow", "hidden"],
  // the ruler must answer with the numbers of this frame, never a tween
  ["transition", "none"],
  ["animation", "none"],
  ["transform", "none"],
  ["resize", "none"],
];

/**
 * Dress the twin so it wraps text exactly as the live box does: the live box's
 * own computed values for everything that moves a line break, then the ruler
 * overrides, then the width, which is the measurement's whole premise.
 */
export function dressMirror(twin: Twin, live: StyleSource, widthPx: number): void {
  for (const prop of MIRROR_PROPS) twin.style.setProperty(prop, live.getPropertyValue(prop));
  for (const [prop, value] of MIRROR_OVERRIDES) twin.style.setProperty(prop, value);
  // same border box + the same padding copied above = the same content width,
  // and the same content width is the same line breaks
  twin.style.setProperty("width", `${widthPx}px`);
}

/** what one fit did, for the caller's compensation decision and the trail */
export interface Fit {
  /** the box's height before the write: the honest pre-resize number */
  oldHeight: number;
  /** the box's height after it */
  newHeight: number;
  /** the thread's position before anything was measured: the one to defend */
  scrollBefore: number;
  /**
   * the thread's position read the instant the height landed, before the
   * restore. Measured on the twin this equals scrollBefore every single time,
   * which is exactly what makes the restore a guard rather than a patch. The
   * trail logs it as stM, so a device session says which happened instead of
   * leaving us to argue about it.
   */
  scrollMid: number;
}

/**
 * Size the compose box to its text and leave the thread where it was.
 *
 * With a twin the live box never shrinks during the measurement, so the
 * thread's maximum scroll offset never dips and the engine has nothing to
 * clamp. Without one (no twin could be attached, or it could not be measured)
 * this falls back to the old collapse-and-read, because a correctly sized box
 * matters more than a still thread, and the restore below repairs most of what
 * the collapse costs.
 *
 * The save and restore runs either way. It is the same guard shell.ts puts
 * around its own forced reflow, and it does a second job: the caller's give-up
 * branch used to feed an already-clamped scrollTop into giveUpTarget and so
 * land low by exactly the clamp, and keep-position used to call a clamped
 * position "the stable reading position" and leave it there. Both read an
 * honest number now.
 */
export function fitComposeBox(
  box: LiveBox,
  twin: Twin | null,
  thread: ScrollBox,
  maxHeight: number,
): Fit {
  const oldHeight = box.offsetHeight;
  const scrollBefore = thread.scrollTop;
  let need: number;
  if (twin) {
    twin.value = box.value;
    need = twin.scrollHeight;
  } else {
    box.style.height = "auto";
    need = box.scrollHeight;
  }
  // exact fit = nothing to scroll-bounce. The box is borderless (the .field
  // wrapper carries the glass), so scrollHeight IS the full border-box need.
  box.style.height = `${Math.min(need, maxHeight)}px`;
  // this read is itself a forced layout, so it sees whatever clamp the write
  // above caused, which is the point of taking it here
  const scrollMid = thread.scrollTop;
  // only when it actually moved: writing a scrollTop it already holds fires no
  // scroll event, but not writing at all is the clearer statement that on the
  // twin path there is nothing to put back
  if (scrollMid !== scrollBefore) thread.scrollTop = scrollBefore;
  return { oldHeight, newHeight: box.offsetHeight, scrollBefore, scrollMid };
}

// The live twin, kept between keystrokes: building one per keystroke would
// throw away the browser's own style work every time. It is re-made whenever
// it is no longer sitting beside the live box, which is what a shell teardown
// and rebuild (log out, log back in) leaves behind.
let twinEl: HTMLTextAreaElement | null = null;

/**
 * The twin for this compose box, attached and dressed, or null when there is
 * nothing faithful to measure on (no pill to hang it in, or a live box with no
 * laid-out width, where a wrap width would be a guess). A null sends the
 * caller down the collapse path rather than letting it size the box off a
 * ruler that cannot be trusted.
 */
export function composeMirror(box: HTMLTextAreaElement): HTMLTextAreaElement | null {
  const field = box.parentElement;
  if (!field) return null;
  const width = box.getBoundingClientRect().width;
  if (!(width > 0)) return null;
  if (!twinEl || twinEl.parentElement !== field) {
    twinEl = document.createElement("textarea");
    // the same intrinsic the live box measures from, read off the live box
    // rather than written down again
    twinEl.rows = box.rows;
    twinEl.tabIndex = -1;
    twinEl.setAttribute("aria-hidden", "true");
    twinEl.dataset.mirror = "compose"; // so a devtools reader knows what it is
    field.appendChild(twinEl);
  }
  dressMirror(twinEl, getComputedStyle(box), width);
  return twinEl;
}
