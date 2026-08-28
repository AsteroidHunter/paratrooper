// Pins for the character under a focusing tap (src/tapcaret.ts).
//
// The device bug behind all of it: iOS reveals the caret when it focuses a
// tapped box, which on a bottom composer shoves the whole page by 412px, and
// the only refusal the engine honours is a flag on a focus call the app makes
// itself. Making that call costs the caret the engine would have placed, so
// for a box holding text the app has to place one, and every case below is a
// place it could put the caret WRONG. The owner's line is drawn precisely:
// a character or two out is fine because he can drag the cursor, a caret that
// jumps to the end of his half written message is not.
//
// The stand-in is the load-bearing part of these tests: a layout that takes
// the VISUAL lines a box broke its text into and hands back the rect the
// engine would have drawn each character in. Rects are all the shipped code
// ever sees, so a table of them is the whole world it decides from, and the
// awkward taps become coordinates instead of a phone.
import { describe, expect, it } from "vitest";
import { MIRROR_OVERRIDES, MIRROR_PROPS } from "../src/mirror";
import {
  CARET_PROPS,
  CARET_SCAN_MAX,
  type CharBox,
  TAIL_MARK,
  caretOffsetFrom,
  dressCaretMirror,
  lineAt,
  lineBands,
  pointInMirror,
  scannable,
} from "../src/tapcaret";
import { readFileSync } from "node:fs";

const LEFT = 100; // the ruler's content left edge, in viewport coordinates
const TOP = 200; // the top of its first line
const CHAR_W = 8;
const LINE_H = 23; // 17px type at 1.35, the shipped compose line

interface Laid {
  text: string;
  boxes: CharBox[];
}

/**
 * The lines as the box actually broke them, turned into one rect per
 * character. A line break and the tail marker take no width, the way the
 * engine draws them: a caret-thin sliver at the end of the line they close.
 */
function laid(lines: readonly string[]): Laid {
  const boxes: CharBox[] = [];
  let at = 0;
  lines.forEach((line, row) => {
    const top = TOP + row * LINE_H;
    let x = LEFT;
    for (const ch of line) {
      const w = ch === "\n" || ch === TAIL_MARK ? 0 : CHAR_W;
      boxes.push({ at, left: x, right: x + w, top, bottom: top + LINE_H });
      x += w;
      at += 1;
    }
  });
  return { text: lines.join(""), boxes };
}

/** a point clearly inside the left half of a cell, so no case rides a tie */
const on = (col: number): number => LEFT + col * CHAR_W + 2;
/** the middle of a line's band */
const row = (r: number): number => TOP + r * LINE_H + LINE_H / 2;

/** tap the laid out text; `text` is passed apart where a tail marker is laid out */
function tap(l: Laid, x: number, y: number, text = l.text): number | null {
  return caretOffsetFrom(l.boxes, text, x, y);
}

describe("caretOffsetFrom: the character the finger landed on", () => {
  it("takes the character under the point on a single line", () => {
    const l = laid(["hello world"]);
    expect(tap(l, on(6), row(0))).toBe(6); // the w
    expect(tap(l, on(0), row(0))).toBe(0);
  });

  it("snaps to the nearer edge of the character, the way the engine's own hit test does", () => {
    const l = laid(["hello world"]);
    expect(tap(l, LEFT + 6 * CHAR_W + 1, row(0))).toBe(6); // just inside its left
    expect(tap(l, LEFT + 6 * CHAR_W + 7, row(0))).toBe(7); // nearly its right
  });

  it("a character the engine drew no rect for does not shift the offsets around it", () => {
    // the boxes carry the offset they were measured for, so a hole is a hole
    // rather than everything after it sliding one to the left
    const l = laid(["hello"]);
    l.boxes = l.boxes.filter((b) => b.at !== 2);
    expect(tap(l, on(3), row(0))).toBe(3);
    // and a tap inside the hole itself names the next character it can, which
    // is the one character out the owner said he can live with
    expect(tap(l, LEFT + 2 * CHAR_W + 2, row(0))).toBe(3);
  });

  it("answers null rather than a number when there is nothing measured to answer from", () => {
    // the whole fail-safe: shell.ts reads null as "leave this tap alone", so a
    // ruler that laid nothing out costs the shove and never a wrong caret
    expect(caretOffsetFrom([], "hello world", on(3), row(0))).toBeNull();
  });
});

// The five taps that could each land at the end of the text if they were
// handled carelessly, which is the one outcome ruled out.
describe("caretOffsetFrom: the awkward taps", () => {
  it("a tap on a WRAPPED line reads that line's own characters, not the sentence's", () => {
    const l = laid(["hello ", "world"]); // one sentence, two visual lines
    expect(tap(l, on(0), row(1))).toBe(6); // the w, not the h
    expect(tap(l, on(0), row(0))).toBe(0); // the same x, one line up
    // and its left padding belongs to the line the finger is on
    expect(tap(l, LEFT - 30, row(1))).toBe(6);
  });

  it("a tap PAST THE END of a wrapped line stays on that line, behind the space the wrap ate", () => {
    const l = laid(["hello ", "world"]);
    // the offset after that space is drawn at the start of the NEXT line, so
    // the caret would appear a line below the finger
    expect(tap(l, LEFT + 400, row(0))).toBe(5);
    expect(tap(l, LEFT + 400, row(0))).not.toBe(l.text.length);
  });

  it("a tap PAST THE END of a line closed by a return sits before the return", () => {
    const l = laid(["ab\n", "cd"]); // "ab\ncd"
    expect(tap(l, LEFT + 400, row(0))).toBe(2); // not 3, which draws on line two
    expect(tap(l, LEFT + 400, row(0))).not.toBe(l.text.length);
  });

  it("a tap past the end of the LAST line is the end of the text, because that is where it points", () => {
    const l = laid(["hello ", "world"]);
    expect(tap(l, LEFT + 400, row(1))).toBe(11);
  });

  it("a tap BELOW the last line drops onto that line and is read across it", () => {
    const l = laid(["hello ", "world"]);
    const under = row(1) + 10 * LINE_H; // well under the text, in the box's padding
    expect(tap(l, on(2), under)).toBe(8); // the r of world
    expect(tap(l, on(2), under)).not.toBe(l.text.length); // never the end by default
  });

  it("a tap ABOVE the first line drops onto that line and is read across it", () => {
    const l = laid(["hello ", "world"]);
    expect(tap(l, on(2), TOP - 40)).toBe(2);
  });

  it("a tap in the gap a tall line height leaves between two lines takes the nearer one", () => {
    const l = laid(["hello ", "world"]);
    l.boxes = l.boxes.map((b) => (b.top > TOP ? { ...b, top: b.top + 6 } : b));
    expect(tap(l, on(1), TOP + LINE_H + 5)).toBe(7); // the gap's lower side
    expect(tap(l, on(1), TOP + LINE_H - 5)).toBe(1); // its upper side
  });

  it("a tap in LEADING whitespace lands in the whitespace, and left of it lands at the line's start", () => {
    const l = laid(["   hi"]);
    expect(tap(l, on(1), row(0))).toBe(1);
    expect(tap(l, LEFT - 20, row(0))).toBe(0);
  });

  it("a tap in TRAILING whitespace on the last line keeps the spaces that were typed", () => {
    const l = laid(["hi   "]);
    expect(tap(l, on(3), row(0))).toBe(3);
    // past everything: the end of the text, spaces and all, because they are
    // the user's own and the caret belongs after them
    expect(tap(l, LEFT + 400, row(0))).toBe(5);
  });

  it("an EMPTY line between two returns takes the caret onto itself, from either side", () => {
    const l = laid(["ab\n", "\n", "cd"]); // "ab\n\ncd"
    expect(tap(l, on(0), row(1))).toBe(3); // right of its sliver
    expect(tap(l, LEFT - 20, row(1))).toBe(3); // left of it
  });
});

// A message ending in a return leaves a line the eye can see and the layout
// cannot: the return itself sits on the line above, so nothing is laid out on
// the last one. The tail marker is what holds it open.
describe("caretOffsetFrom: the tail marker and the end of the text", () => {
  it("a trailing return keeps its empty last line, and a tap there is the end of the text", () => {
    const l = laid(["ab\n", TAIL_MARK]);
    expect(tap(l, on(0), row(1), "ab\n")).toBe(3);
    expect(tap(l, LEFT - 20, row(1), "ab\n")).toBe(3);
  });

  it("without the marker that same tap misses the line entirely, which is why it is laid out", () => {
    const l = laid(["ab\n"]);
    expect(tap(l, on(0), row(1))).toBe(0); // nothing down there to land on
  });

  it("the marker can never hand back an offset the box does not have", () => {
    const l = laid(["ab", TAIL_MARK]); // the marker wrapping onto its own line
    expect(tap(l, LEFT + 400, row(1), "ab")).toBe(2);
  });

  it("the answer is clamped into the text however the rects were laid out", () => {
    const l = laid(["abc"]);
    expect(tap(l, LEFT + 999, row(0))).toBe(3);
    expect(tap(l, LEFT - 999, row(0))).toBe(0);
  });
});

describe("lineBands: cutting the measured characters into lines", () => {
  it("characters sharing a band are one line, and a wrap starts the next", () => {
    expect(lineBands(laid(["hello ", "world"]).boxes)).toEqual([
      { top: TOP, bottom: TOP + LINE_H, first: 0, last: 5 },
      { top: TOP + LINE_H, bottom: TOP + 2 * LINE_H, first: 6, last: 10 },
    ]);
  });

  it("a rect with no height joins the line it sits in instead of becoming one", () => {
    // a line break can come back measured this way, and a line of its own
    // would put a whole extra line under the finger
    const boxes: CharBox[] = [
      { at: 0, left: LEFT, right: LEFT + CHAR_W, top: TOP, bottom: TOP + LINE_H },
      { at: 1, left: LEFT + CHAR_W, right: LEFT + CHAR_W, top: TOP, bottom: TOP },
    ];
    expect(lineBands(boxes)).toEqual([{ top: TOP, bottom: TOP + LINE_H, first: 0, last: 1 }]);
  });

  it("nothing measured is no lines at all, which is the null the caller needs", () => {
    expect(lineBands([])).toEqual([]);
  });
});

describe("lineAt: which line a height belongs to", () => {
  const lines = lineBands(laid(["hello ", "world"]).boxes);

  it("a height inside a band takes that band", () => {
    expect(lineAt(lines, row(0))).toBe(0);
    expect(lineAt(lines, row(1))).toBe(1);
  });

  it("a band's own top belongs to it, so a boundary falls to the lower line", () => {
    expect(lineAt(lines, TOP + LINE_H)).toBe(1);
  });

  it("above everything and below everything both take the nearest line, never the last by default", () => {
    expect(lineAt(lines, TOP - 500)).toBe(0);
    expect(lineAt(lines, TOP + 500)).toBe(1);
  });
});

describe("pointInMirror: carrying the tap from the live box into the ruler", () => {
  it("the same offset inside the same border box is the same place in the text", () => {
    const at = pointInMirror({ left: 20, top: 700 }, { left: 20, top: 40 }, zero(), 34, 712);
    expect(at).toEqual({ x: 34, y: 52 });
  });

  it("the scroll the box is holding under its five line cap is added back on", () => {
    // the part no screenshot would show: the box scrolls, the ruler never
    // does, so the text under the finger sits that much further down the ruler
    const at = pointInMirror({ left: 20, top: 700 }, { left: 20, top: 40 }, { left: 0, top: 46 }, 34, 712);
    expect(at.y).toBe(98);
  });

  function zero(): { left: number; top: number } {
    return { left: 0, top: 0 };
  }
});

describe("scannable: the cap on what one gesture will measure", () => {
  it("an ordinary message is scanned", () => {
    expect(scannable(0)).toBe(true);
    expect(scannable(240)).toBe(true);
    expect(scannable(CARET_SCAN_MAX)).toBe(true);
  });

  it("a pasted essay is not, and goes back to the engine rather than holding the keyboard up", () => {
    expect(scannable(CARET_SCAN_MAX + 1)).toBe(false);
  });
});

describe("dressCaretMirror: a ruler that wraps exactly as the live box does", () => {
  function dressed(width = 317, live: (p: string) => string = (p) => `live(${p})`) {
    const writes: [string, string][] = [];
    dressCaretMirror(
      { setProperty: (p, v) => void writes.push([p, v]) },
      { getPropertyValue: live },
      width,
    );
    return writes;
  }

  it("carries the live box's own value for everything that moves a line break", () => {
    const writes = dressed();
    for (const prop of MIRROR_PROPS) expect(writes).toContainEqual([prop, `live(${prop})`]);
  });

  it("carries the ones that place text ALONG a line, which a height ruler never needed", () => {
    // a right aligned or centred box would put every character somewhere else
    expect(CARET_PROPS).toContain("text-align");
    const writes = dressed();
    for (const prop of CARET_PROPS) expect(writes).toContainEqual([prop, `live(${prop})`]);
  });

  it("the ruler overrides land after the copies, so they win", () => {
    const writes = dressed();
    const lastCopy = Math.max(
      ...[...MIRROR_PROPS, ...CARET_PROPS].map((p) => writes.findIndex((w) => w[0] === p)),
    );
    for (const [prop] of MIRROR_OVERRIDES) {
      expect(writes.findIndex((w) => w[0] === prop)).toBeGreaterThan(lastCopy);
    }
  });

  it("it lays out as a block, whatever a future rule would have made a bare div", () => {
    expect(dressed()).toContainEqual(["display", "block"]);
  });

  it("the width goes on last and is the live box's own border box", () => {
    const writes = dressed(317);
    expect(writes[writes.length - 1]).toEqual(["width", "317px"]);
  });

  it("a property this engine cannot name leaves the textarea default standing, not wiped", () => {
    // writing a property back empty REMOVES it, and a bare div's initial
    // white-space collapses a return into a space, which would put every
    // offset after the first line one line out
    const writes = dressed(317, () => "");
    expect(writes).toContainEqual(["white-space", "pre-wrap"]);
    expect(writes.filter((w) => w[0] === "white-space")).toHaveLength(1);
    expect(writes.some((w) => w[1] === "")).toBe(false);
  });

  it("the baseline goes UNDER the copies, so the live box still decides when it can answer", () => {
    const writes = dressed();
    expect(writes.filter((w) => w[0] === "white-space")).toEqual([
      ["white-space", "pre-wrap"],
      ["white-space", "live(white-space)"],
    ]);
  });
});

// Wiring pins: the parts that only exist because this runs inside the one
// gesture the keyboard rises from, and because a wrong answer is worse than
// no answer.
describe("wiring: what the ruler may and may not do", () => {
  const src = readFileSync(new URL("../src/tapcaret.ts", import.meta.url), "utf8");
  const reader = src.match(/export function caretOffsetAt[\s\S]*?\n\}/)?.[0] ?? "";

  it("no clock and no wait anywhere: the measurement is the tap's own turn", () => {
    expect(src).not.toMatch(/setTimeout|setInterval|requestAnimationFrame|await |\.then\(/);
  });

  it("every way out of the measurement is a null, never a number stood in for one", () => {
    expect(reader).not.toBe("");
    expect(reader.match(/return null;/g)?.length).toBeGreaterThanOrEqual(3);
    expect(reader).not.toMatch(/return \d|\?\? \d|\|\| \d/);
  });

  it("the wrapping properties come from the height ruler's list, never restated here", () => {
    // one list, so a stylesheet edit lands on both twins or on neither. The
    // two names in CARET_BASE are the deliberate exception, and they are a
    // floor under the copies rather than a second copy of them.
    expect(src).toMatch(/import \{[^}]*MIRROR_PROPS[^}]*\} from "\.\/mirror";/s);
    for (const prop of ["font-family", "font-size", "padding-left", "line-height"]) {
      expect(src).not.toContain(`"${prop}"`);
    }
  });

  it("the ruler is a div and is named apart from the height twin the census counts", () => {
    // the census selector is textarea[data-mirror='compose'], and a second
    // twin answering to it would read as a duplicated compose bar
    expect(src).toContain('document.createElement("div")');
    expect(src).toContain('caretEl.dataset.mirror = "caret"');
  });

  it("it measures the ruler and never writes to the box it is measuring for", () => {
    expect(reader).not.toMatch(/box\.(value|selectionStart|selectionEnd|scrollTop)\s*=/);
  });
});
