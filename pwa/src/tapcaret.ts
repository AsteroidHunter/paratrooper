// Which character the finger landed on, so the app can place a caret the
// engine was refused the chance to place.
//
// Why this exists. shell.ts takes the composer's focusing tap over and does
// the focus itself, because focus({ preventScroll: true }) is the only refusal
// iOS honours for the caret reveal that shoves the whole page, and a tap can
// never carry that flag. The cost of refusing the engine's tap is the CARET:
// the engine places one from its own hit test and a refused tap places none,
// so the take-over could only ever be offered to a box where there was no
// caret to lose, an empty one. This module is what pays that cost, so a box
// with a half written message in it can be taken over too.
//
// Why the height ruler could not be read for this. mirror.ts already parks a
// twin beside the live box holding the same text at the same width in the same
// type, and it would be the obvious thing to measure. It cannot be: the twin
// is a <textarea> and its text is fed to it as `.value`, so the element has no
// child nodes at all, and even given some the text a form control renders
// lives in the engine's own internal tree, which a Range cannot address and
// which reports no client rects. That is the same wall the caret-from-point
// reads hit. So the measurement happens on a second twin, a plain <div>, whose
// text IS addressable, dressed from the SAME property list mirror.ts dresses
// its ruler from, so a stylesheet edit lands on both or on neither.
//
// What makes the answer exact rather than a guess. The div carries the live
// box's own computed values for everything that decides where a line breaks
// (MIRROR_PROPS), at the live box's own border box width, with the same
// padding and the same box sizing, so it breaks its lines in exactly the same
// places. Its characters are then real laid out text, and one Range per
// character gives the rect the engine itself drew that character in. The tap
// point is carried across by the difference between the two border boxes, plus
// whatever the live box has scrolled away under its five line cap, so the
// point lands in the ruler where it landed in the box.
//
// What happens when it cannot be measured. Every failure returns null: no pill
// to hang the twin in, a live box with no laid out width, a text longer than
// one gesture should spend scanning, a run of characters that reported no
// rects at all. Null is not an offset and is never treated as one. shell.ts
// reads it as "leave this tap to the engine" and the composer keeps exactly
// the behaviour it had before this module existed, shove and all. A caret is
// only ever placed from a rect that was actually measured.

import { MIRROR_OVERRIDES, MIRROR_PROPS, type StyleSource } from "./mirror";

/** the slice of an element this module dresses: it only ever writes properties */
export interface StyleTarget {
  setProperty(prop: string, value: string): void;
}

/**
 * The properties that move text ACROSS a line rather than down the page.
 * mirror.ts does not copy these because a ruler that only answers with a
 * height does not care which end of the line the words sit at. A ruler that
 * answers with a character does, so they are copied on top of its list.
 */
export const CARET_PROPS: readonly string[] = ["text-align", "text-align-last", "text-justify"];

/**
 * What a textarea gets from the engine's own stylesheet and a bare div does
 * not. Written FIRST, under the copies, so the copies are what normally
 * decide; this is only what is left standing if a copy comes back empty.
 * Nothing selects a plain div parked in the pill, so where the height twin
 * could fall back on a textarea's own defaults, this one would fall back on
 * the initial values, and the initial value of white-space collapses a return
 * into a space, which would put every offset after the first line wrong.
 */
export const CARET_BASE: readonly (readonly [string, string])[] = [
  ["white-space", "pre-wrap"],
  ["overflow-wrap", "break-word"],
];

/**
 * On top of mirror.ts's ruler overrides. The height twin is a textarea and
 * already lays out as a block; a div could be handed something else by a rule
 * that happens to match it, and an inline or flex ruler would wrap nothing
 * like the box it is standing in for.
 */
export const CARET_OVERRIDES: readonly (readonly [string, string])[] = [["display", "block"]];

/**
 * Dress the caret ruler: the textarea defaults a div has to be told about, the
 * live box's own wrapping properties over them, the ones that place text along
 * a line, the overrides that make it a ruler instead of a second composer, and
 * last the width the whole measurement rests on.
 */
export function dressCaretMirror(twin: StyleTarget, live: StyleSource, widthPx: number): void {
  for (const [prop, value] of CARET_BASE) twin.setProperty(prop, value);
  for (const prop of [...MIRROR_PROPS, ...CARET_PROPS]) {
    const value = live.getPropertyValue(prop);
    // an empty read is a property this engine does not know by that name, and
    // writing it back empty REMOVES the declaration. On the height twin that
    // is harmless. Here it would wipe the baseline above, so it is skipped.
    if (value) twin.setProperty(prop, value);
  }
  for (const [prop, value] of MIRROR_OVERRIDES) twin.setProperty(prop, value);
  for (const [prop, value] of CARET_OVERRIDES) twin.setProperty(prop, value);
  // same border box plus the same padding copied above is the same content
  // width, and the same content width is the same line breaks
  twin.setProperty("width", `${widthPx}px`);
}

/**
 * One character's rect, in the ruler's own coordinates, tagged with the offset
 * it was measured for. Characters the engine gave no rect for are simply
 * absent, so the list can have holes in it and the offsets stay honest.
 */
export interface CharBox {
  at: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** one laid out line: the band it occupies and the run of offsets on it */
export interface CaretLine {
  top: number;
  bottom: number;
  first: number;
  last: number;
}

/**
 * Cut the measured characters into lines.
 *
 * Every rect on one line box shares that line's top and bottom, whatever the
 * glyph inside it is, so a character joins the line whose band its own middle
 * falls in and starts a new one when it does not. The middle rather than the
 * edges, because a line break's rect can come back with no height at all and
 * an edge test would drop it onto a line of its own.
 */
export function lineBands(boxes: readonly CharBox[]): CaretLine[] {
  const lines: CaretLine[] = [];
  for (const b of boxes) {
    const line = lines[lines.length - 1];
    const middle = (b.top + b.bottom) / 2;
    if (line && middle >= line.top && middle < line.bottom) {
      line.top = Math.min(line.top, b.top);
      line.bottom = Math.max(line.bottom, b.bottom);
      line.last = b.at;
    } else {
      lines.push({ top: b.top, bottom: b.bottom, first: b.at, last: b.at });
    }
  }
  return lines;
}

/**
 * The line a tap at this height belongs to. A tap inside a band takes that
 * band; a tap above the first line, below the last, or in the gap a tall line
 * height leaves between two of them takes the NEAREST band. Nearest is what
 * keeps a tap in the box's own padding on the text beside it: the end of
 * everything is only ever reached by a finger that is actually pointing there.
 */
export function lineAt(lines: readonly CaretLine[], y: number): number {
  for (let i = 0; i < lines.length; i++) {
    if (y >= lines[i].top && y < lines[i].bottom) return i;
  }
  let best = 0;
  let nearest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < lines.length; i++) {
    const gap = y < lines[i].top ? lines[i].top - y : y - lines[i].bottom;
    if (gap < nearest) {
      nearest = gap;
      best = i;
    }
  }
  return best;
}

/**
 * Where the caret goes when the finger is past the last character on a line.
 *
 * The offset after that character, with two step-backs, both for the same
 * reason: an offset can be drawn at the start of the NEXT line, a line below
 * the one the finger was on, and this is the one question whose answer is a
 * place on a screen rather than a number.
 *   - the character is a line break. The offset after a break is the first
 *     offset of the next line, so the end of THIS line is before it.
 *   - the line was soft wrapped and ends in the space the wrap ate. That space
 *     hangs past the edge of the line and the offset after it is drawn at the
 *     start of the next one, so the caret steps back over it. Only on a
 *     wrapped line: trailing spaces a person actually typed at the end of the
 *     last line are theirs, and the caret belongs after them.
 */
function lineEnd(line: CaretLine, text: string, wrapped: boolean): number {
  if (text[line.last] === "\n") return line.last;
  let end = line.last + 1;
  while (wrapped && end > line.first && (text[end - 1] === " " || text[end - 1] === "\t")) {
    end -= 1;
  }
  return end;
}

/**
 * Where the caret goes along one line. Left of the line's first character is
 * that line's start, which is what a tap in leading whitespace or in the left
 * padding of a wrapped continuation line gets. Right of its last is that
 * line's end. Inside a character, the nearer of its two edges, which is the
 * boundary the engine's own hit test would have snapped to.
 */
function offsetInLine(
  on: readonly CharBox[],
  line: CaretLine,
  text: string,
  x: number,
  wrapped: boolean,
): number {
  const first = on[0];
  const last = on[on.length - 1];
  if (x <= first.left) return line.first;
  if (x >= last.right) return lineEnd(line, text, wrapped);
  for (const b of on) {
    if (x < b.left) return b.at; // a gap between two rects, not inside either
    if (x < b.right) return x - b.left < b.right - x ? b.at : b.at + 1;
  }
  return lineEnd(line, text, wrapped);
}

/**
 * The offset under a point, given the characters the ruler laid out. Pure, so
 * every awkward tap is a table of rects and a coordinate rather than a phone.
 *
 * Null only when there is nothing measured to answer from. The answer is
 * clamped into the text, so the tail marker the caller lays out past the end
 * of the text (see TAIL_MARK) can hold a trailing empty line open without ever
 * handing back an offset the box does not have.
 */
export function caretOffsetFrom(
  boxes: readonly CharBox[],
  text: string,
  x: number,
  y: number,
): number | null {
  const lines = lineBands(boxes);
  if (lines.length === 0) return null;
  const i = lineAt(lines, y);
  const line = lines[i];
  const on = boxes.filter((b) => b.at >= line.first && b.at <= line.last);
  if (on.length === 0) return null;
  const wrapped = i < lines.length - 1;
  return Math.max(0, Math.min(text.length, offsetInLine(on, line, text, x, wrapped)));
}

/**
 * Laid out past the end of the text so a message ENDING in a line break still
 * has that last empty line to tap on: the break itself sits on the line above
 * it, so without a character after it the line the eye sees is not in the
 * layout at all. Zero width, so it can neither widen a line nor wrap onto one
 * of its own, and every offset it produces is clamped back to the end of the
 * real text.
 */
export const TAIL_MARK = "\u200b";

/**
 * The longest text this will scan. One Range per character is cheap once the
 * layout is clean, but it runs inside the one gesture the keyboard rises from,
 * and an unbounded scan there is a latency nobody can predict. Past the cap
 * the answer is null and the tap goes back to the engine, which places the
 * caret itself: a pasted essay keeps the behaviour it always had.
 */
export const CARET_SCAN_MAX = 4000;

/** whether a text of this length may be scanned inside the gesture */
export function scannable(length: number): boolean {
  return length <= CARET_SCAN_MAX;
}

/**
 * A viewport point, carried from the live box into the ruler.
 *
 * The two elements are the same border box with the same padding inside it, so
 * the same offset from the top left corner is the same place in the text. The
 * scroll is the part that is easy to forget and impossible to notice from a
 * screenshot: the live box caps at five lines and scrolls under that cap, the
 * ruler is uncapped and never scrolls, so a tap on a scrolled box points at
 * text that sits further down the ruler by exactly what the box scrolled away.
 */
export function pointInMirror(
  live: { left: number; top: number },
  seat: { left: number; top: number },
  scroll: { left: number; top: number },
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  return {
    x: seat.left + (clientX - live.left) + scroll.left,
    y: seat.top + (clientY - live.top) + scroll.top,
  };
}

// The measuring twin, kept between taps for the same reason the height ruler
// is: building and styling one per tap throws away the browser's style work
// every time. Re-made whenever it is no longer beside the live box, which is
// what a shell teardown and rebuild leaves behind.
let caretEl: HTMLDivElement | null = null;

/**
 * The caret ruler for this compose box, attached and dressed, or null when
 * there is nothing faithful to measure on: no pill to hang it in, or a live
 * box with no laid out width, where the wrap width would be a guess.
 */
export function caretMirror(box: HTMLTextAreaElement): HTMLDivElement | null {
  const field = box.parentElement;
  if (!field) return null;
  const width = box.getBoundingClientRect().width;
  if (!(width > 0)) return null;
  if (!caretEl || caretEl.parentElement !== field) {
    caretEl = document.createElement("div");
    caretEl.setAttribute("aria-hidden", "true");
    // named apart from the height ruler so a devtools reader and the dom
    // census can tell the two twins from each other
    caretEl.dataset.mirror = "caret";
    field.appendChild(caretEl);
  }
  dressCaretMirror(caretEl.style, getComputedStyle(box), width);
  return caretEl;
}

/**
 * One rect per character of the ruler's text, skipping any the engine did not
 * draw. The first rect of each range, never the bounding one: a range over a
 * line break can report a rect on each side of it, and the one that counts is
 * the one on the line the break ends.
 */
function charBoxes(node: Node, count: number): CharBox[] {
  const range = document.createRange();
  const boxes: CharBox[] = [];
  for (let at = 0; at < count; at++) {
    range.setStart(node, at);
    range.setEnd(node, at + 1);
    const rect = range.getClientRects()[0];
    // a rect with no height is not a line box, so it cannot place a caret
    if (!rect || !(rect.height > 0)) continue;
    boxes.push({ at, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
  }
  return boxes;
}

/**
 * The offset in the compose box under a tap, or null when it could not be
 * measured. Synchronous and read only against the live box: it writes the
 * ruler and reads the ruler, and never touches the box it is measuring for.
 */
export function caretOffsetAt(
  box: HTMLTextAreaElement,
  clientX: number,
  clientY: number,
): number | null {
  const text = box.value;
  if (!scannable(text.length)) return null;
  const twin = caretMirror(box);
  if (!twin) return null;
  twin.textContent = text + TAIL_MARK;
  const node = twin.firstChild;
  if (!node) return null;
  const at = pointInMirror(
    box.getBoundingClientRect(),
    twin.getBoundingClientRect(),
    { left: box.scrollLeft, top: box.scrollTop },
    clientX,
    clientY,
  );
  return caretOffsetFrom(charBoxes(node, text.length + TAIL_MARK.length), text, at.x, at.y);
}
