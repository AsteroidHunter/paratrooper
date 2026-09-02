// Pins for the bubble width fit (src/bubblefit.ts, wired in main.ts).
//
// The bug: .msg is a flex item with max-width: 75%, and for text longer than
// one line the browser sizes the box to that cap and wraps INSIDE it — nothing
// then shrinks the box back onto the lines the wrap produced. A sent bubble
// measured 255pt wide with 166pt of ink on its widest line: 56pt of bare
// bubble on the right. One-liners shrink-wrap and were always right.
//
// So the fit's whole risk is the other direction: a cap tighter than the
// widest line re-wraps the text and the bubble GROWS a line, which is worse
// than the dead space ever was. These tests hold the three things that stop
// that — the slack, the height check that hands a bad cap back, and the rule
// that nothing but plain wrapped text is measured at all — plus the loop
// ordering that keeps a batch at two forced layouts, and the main.ts wiring
// (source-pinned, like flight.test.ts: main.ts boots a real shell at import
// and cannot load under node).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUBBLE_FIT_MIN_GAIN_PX,
  BUBBLE_FIT_SCALE_EPSILON,
  BUBBLE_FIT_SLACK_PX,
  bubbleLineWidths,
  bubbleQualifies,
  bubbleTargetWidth,
  fitBubbles,
  fitScale,
} from "../src/bubblefit";
import type { FitBubble } from "../src/bubblefit";

const PAD_L = 16; // .msg padding: 10px 16px
const PAD_R = 16;

// Real rects, dumped out of Chrome for the bubbles below at a 390px thread.
// They are the reason this measurement folds rects onto lines instead of
// taking the widest rect: getClientRects hands back one per text FRAGMENT, a
// soft wrap's hanging space is always its own ~4.4px rect, and a tab splits a
// line into as many pieces as it has stops.
const CHROME = {
  // "Can you check whether the deploy finished and let me know" — 3 lines, 5 rects
  sent: {
    contentLeft: 119.5,
    rects: [
      { top: 28, right: 327.3 },
      { top: 28, right: 331.7 }, // the hanging space at the wrap
      { top: 48, right: 319.1 },
      { top: 48, right: 323.5 },
      { top: 68, right: 159.8 },
    ],
    lines: [212.2, 204, 40.3],
  },
  // "tabs\tand\t  multiple   spaces …" — 3 lines, 9 rects; the first line alone
  // comes back as five, the widest of them only 136.3 of a 217.2px line
  tabs: {
    contentLeft: 28,
    rects: [
      { top: 338, right: 61.2 },
      { top: 338, right: 66.3 },
      { top: 338, right: 94.7 },
      { top: 338, right: 104.5 },
      { top: 338, right: 240.8 },
      { top: 338, right: 245.2 },
      { top: 358, right: 245.7 },
      { top: 358, right: 250.1 },
      { top: 378, right: 257.5 },
    ],
    lines: [217.2, 222.1, 229.5],
  },
};

describe("bubbleLineWidths: rects are fragments, and a line is all of them", () => {
  it("folds a line's fragments back into the one line they drew", () => {
    const got = bubbleLineWidths(CHROME.sent.rects, CHROME.sent.contentLeft, 1);
    expect(got.map((w) => Math.round(w * 10) / 10)).toEqual(CHROME.sent.lines);
  });

  it("survives the line Chrome split into five: the widest RECT is not the line", () => {
    const got = bubbleLineWidths(CHROME.tabs.rects, CHROME.tabs.contentLeft, 1);
    expect(got.map((w) => Math.round(w * 10) / 10)).toEqual(CHROME.tabs.lines);
    // what the old reading would have said about that first line, and why a
    // cap built on it would have re-wrapped the bubble and been thrown away
    const widestFragment = 136.3;
    expect(Math.max(...got)).toBeGreaterThan(widestFragment);
  });

  it("measures from the CONTENT edge, so padding is never counted as ink", () => {
    const one = bubbleLineWidths([{ top: 0, right: 200 }], 100, 1);
    expect(one).toEqual([100]);
  });

  it("divides a running entrance transform back out", () => {
    const scaled = bubbleLineWidths([{ top: 0, right: 188 }], 100, 0.88);
    expect(scaled[0]).toBeCloseTo(100, 5);
  });

  it("keeps rects a hair apart on the same line together", () => {
    // sub-pixel top jitter inside one line box must not read as two lines
    expect(bubbleLineWidths([{ top: 40, right: 300 }, { top: 40.4, right: 260 }], 100, 1))
      .toEqual([200]);
    expect(bubbleLineWidths([{ top: 40, right: 300 }, { top: 60, right: 260 }], 100, 1))
      .toEqual([200, 160]);
  });

  it("cannot under-read the widest line however the fragments are grouped", () => {
    // splitting one line in two leaves the widest group still reaching the
    // line's furthest rect — the number the cap is built from does not move
    const asOne = bubbleLineWidths([{ top: 0, right: 300 }, { top: 0, right: 250 }], 100, 1);
    const asTwo = bubbleLineWidths([{ top: 0, right: 300 }, { top: 9, right: 250 }], 100, 1);
    expect(Math.max(...asOne)).toBe(Math.max(...asTwo));
  });

  it("has nothing to say about a bubble with no rects", () => {
    expect(bubbleLineWidths([], 100, 1)).toEqual([]);
  });
});

describe("bubbleTargetWidth: the box ends where the ink does", () => {
  it("ends a wrapped bubble at its widest line plus its own padding", () => {
    // his measurement: three lines inside a 255pt bubble, 166pt of ink at most
    const target = bubbleTargetWidth([166, 150, 96], PAD_L, PAD_R);
    expect(target).toBe(166 + BUBBLE_FIT_SLACK_PX + PAD_L + PAD_R);
    expect(target!).toBeLessThan(255); // the dead space is what it takes back
  });

  it("takes the WIDEST line, never the last or the first", () => {
    expect(bubbleTargetWidth([80, 200, 40], PAD_L, PAD_R)).toBe(
      bubbleTargetWidth([200, 80, 40], PAD_L, PAD_R),
    );
    expect(bubbleTargetWidth([80, 200, 40], 0, 0)).toBe(200 + BUBBLE_FIT_SLACK_PX);
  });

  it("rounds UP and adds slack, so the measured lines cannot fail to fit back in", () => {
    const target = bubbleTargetWidth([120.4, 99.2], 0, 0)!;
    expect(target).toBeGreaterThanOrEqual(120.4);
    expect(Number.isInteger(target)).toBe(true);
    expect(BUBBLE_FIT_SLACK_PX).toBeGreaterThan(0);
  });

  it("leaves a one-line bubble alone: it already shrink-wrapped", () => {
    expect(bubbleTargetWidth([166], PAD_L, PAD_R)).toBeNull();
    expect(bubbleTargetWidth([], PAD_L, PAD_R)).toBeNull();
  });

  it("declines rather than guesses when a measurement is not a width", () => {
    expect(bubbleTargetWidth([100, Number.NaN], PAD_L, PAD_R)).toBeNull();
    expect(bubbleTargetWidth([100, Number.POSITIVE_INFINITY], PAD_L, PAD_R)).toBeNull();
    expect(bubbleTargetWidth([100, -4], PAD_L, PAD_R)).toBeNull();
    expect(bubbleTargetWidth([0, 0], PAD_L, PAD_R)).toBeNull(); // no ink to end at
    expect(bubbleTargetWidth([100, 90], Number.NaN, PAD_R)).toBeNull();
  });
});

describe("bubbleQualifies: only plain wrapped text is measured", () => {
  it("takes an ordinary sent or received text bubble", () => {
    expect(bubbleQualifies(["msg", "user", "text"], 0)).toBe(true);
    expect(bubbleQualifies(["msg", "agent", "text"], 0)).toBe(true);
    expect(bubbleQualifies(["msg", "agent", "text", "anim"], 0)).toBe(true);
    expect(bubbleQualifies(["msg", "agent", "error"], 0)).toBe(true);
  });

  it("skips anything with an element inside it, whatever its classes say", () => {
    // the line boxes of a range over mixed content are not what this measures
    expect(bubbleQualifies(["msg", "user", "text"], 1)).toBe(false);
    expect(bubbleQualifies(["msg", "agent", "text"], 3)).toBe(false);
  });

  it("skips photos, the typing dots, the PR row and the centered system line", () => {
    expect(bubbleQualifies(["msg", "user", "shot"], 1)).toBe(false);
    expect(bubbleQualifies(["msg", "agent", "typing"], 3)).toBe(false);
    expect(bubbleQualifies(["msg", "agent", "pr"], 2)).toBe(false);
    expect(bubbleQualifies(["msg", "system", "line"], 0)).toBe(false);
    // and by class alone, so the rule survives one of them rendering as text
    expect(bubbleQualifies(["msg", "user", "shot"], 0)).toBe(false);
    expect(bubbleQualifies(["msg", "agent", "pr"], 0)).toBe(false);
  });

  it("is not a bubble at all unless it says .msg", () => {
    expect(bubbleQualifies(["row", "user"], 0)).toBe(false);
    expect(bubbleQualifies(["stamp"], 0)).toBe(false);
  });
});

describe("fitScale: a bubble mid-entrance is measured in layout pixels", () => {
  it("divides out the pop-in's live scale", () => {
    // .msg.anim runs scale(0.88); rects answer painted, offsetWidth answers laid out
    expect(fitScale(220, 250)).toBeCloseTo(0.88, 5);
  });

  it("treats offsetWidth's own rounding as no transform at all", () => {
    expect(fitScale(255.4, 255)).toBe(1);
    expect(fitScale(254.6, 255)).toBe(1);
    expect(BUBBLE_FIT_SCALE_EPSILON).toBeGreaterThan(0);
  });

  it("never returns a scale that could divide a width into nonsense", () => {
    expect(fitScale(0, 250)).toBe(1);
    expect(fitScale(250, 0)).toBe(1);
    expect(fitScale(Number.NaN, 250)).toBe(1);
  });
});

// A bubble the pass can actually operate: it re-wraps when capped below its
// widest line, exactly as the browser would, so a cap that was measured wrong
// grows the box and the pass has something real to catch.
class FakeBubble implements FitBubble {
  classes_: string[];
  kids: number;
  padL = PAD_L;
  padR = PAD_R;
  /** the widths of the words/segments this bubble's text is made of */
  private segments: number[];
  /** the widest box the stylesheet allows (the 75% cap) */
  private ceiling: number;
  private capped: number | null = null;
  readonly caps: Array<number | null> = [];
  lineHeight = 22;

  constructor(segments: number[], ceiling: number, classes = ["msg", "user", "text"], kids = 0) {
    this.segments = segments;
    this.ceiling = ceiling;
    this.classes_ = classes;
    this.kids = kids;
  }

  /** greedy line breaking at the box's inner width — the browser's own rule */
  private layout(): number[] {
    const inner = Math.min(this.capped ?? this.ceiling, this.ceiling) - this.padL - this.padR;
    const rows: number[] = [];
    let cur = 0;
    for (const seg of this.segments) {
      if (cur > 0 && cur + seg > inner) {
        rows.push(cur);
        cur = 0;
      }
      cur += seg;
    }
    if (cur > 0) rows.push(cur);
    return rows;
  }

  classes(): readonly string[] {
    return this.classes_;
  }
  children(): number {
    return this.kids;
  }
  lines(): readonly number[] {
    return this.layout();
  }
  padding(): readonly [number, number] {
    return [this.padL, this.padR];
  }
  width(): number {
    const rows = this.layout();
    const natural = Math.max(...rows) + this.padL + this.padR;
    // a shrink-wrapping flex item: min(content, cap, the explicit max-width)
    return Math.min(rows.length > 1 ? this.ceiling : natural, this.capped ?? Infinity);
  }
  height(): number {
    return this.layout().length * this.lineHeight;
  }
  cap(px: number | null): void {
    this.capped = px;
    this.caps.push(px);
  }
}

describe("fitBubbles: the pass, end to end", () => {
  it("takes the dead space off a wrapping bubble and re-wraps nothing", () => {
    // 8 segments of 45 in a 255 box (223 inner): 4 per line, widest line 180
    const b = new FakeBubble(Array(8).fill(45), 255);
    expect(b.height()).toBe(44); // two lines before
    expect(fitBubbles([b])).toBe(1);
    expect(b.width()).toBe(180 + BUBBLE_FIT_SLACK_PX + PAD_L + PAD_R);
    expect(b.width()).toBeLessThan(255); // the dead space is gone
    expect(b.height()).toBe(44); // and the wrap is byte for byte the same
  });

  it("leaves a one-line bubble exactly as the stylesheet drew it", () => {
    const b = new FakeBubble([40, 40], 255);
    expect(fitBubbles([b])).toBe(0);
    expect(b.height()).toBe(22);
    expect(b.caps.filter((c) => c !== null)).toEqual([]); // nothing was ever written
  });

  it("writes nothing for a bubble whose lines already reach the cap", () => {
    const b = new FakeBubble(Array(8).fill(55.75), 255); // 4 x 55.75 = 223 = the inner width
    expect(fitBubbles([b])).toBe(0);
    expect(b.caps.filter((c) => c !== null)).toEqual([]);
    expect(BUBBLE_FIT_MIN_GAIN_PX).toBeGreaterThan(0);
  });

  it("hands the natural width straight back when a cap re-wrapped the text", () => {
    const b = new FakeBubble(Array(8).fill(45), 255);
    // the measurement lies: report lines narrower than they really are
    b.lines = () => [100, 90];
    expect(fitBubbles([b])).toBe(0);
    expect(b.caps[b.caps.length - 1]).toBeNull(); // the bad cap was given back
    expect(b.height()).toBe(44); // and the bubble did not keep the extra line
  });

  it("skips a photo row and the typing dots without measuring them", () => {
    const shot = new FakeBubble(Array(8).fill(45), 255, ["msg", "user", "shot"], 1);
    const dots = new FakeBubble(Array(8).fill(45), 255, ["msg", "agent", "typing"], 3);
    expect(fitBubbles([shot, dots])).toBe(0);
    expect(shot.caps).toEqual([]); // not even the clearing write
    expect(dots.caps).toEqual([]);
  });

  it("clears every cap before measuring, so a refit re-derives from the new width", () => {
    const b = new FakeBubble(Array(8).fill(45), 255);
    fitBubbles([b]);
    const first = b.width();
    b.caps.length = 0;
    fitBubbles([b]); // the same bubble, a second time
    expect(b.caps[0]).toBeNull(); // cleared first: measured against the stylesheet
    expect(b.width()).toBe(first); // and lands on the same answer, not a creeping one
  });

  it("a narrower viewport refits to the narrower answer, not to the old cap", () => {
    const b = new FakeBubble(Array(8).fill(45), 255);
    fitBubbles([b]);
    expect(b.width()).toBe(180 + BUBBLE_FIT_SLACK_PX + PAD_L + PAD_R);
    (b as unknown as { ceiling: number }).ceiling = 160; // rotation: 128 inner, 2 per line
    fitBubbles([b]);
    expect(b.width()).toBe(90 + BUBBLE_FIT_SLACK_PX + PAD_L + PAD_R);
  });

  it("ends his measured bubble where its ink ends", () => {
    // the reported case, straight off the device: a sent bubble 255pt wide
    // with 166pt on its widest line and 56pt of nothing after it
    const target = bubbleTargetWidth([166, 150, 96], PAD_L, PAD_R)!;
    expect(255 - target).toBeGreaterThan(50); // the dead space, essentially all of it
    expect(target).toBeGreaterThan(166 + PAD_L + PAD_R); // and the ink still fits
  });

  it("batches: every read happens after every write of its phase", () => {
    // the ordering IS the performance — two forced layouts for the batch, not
    // two per bubble. Recorded as the interleaving of clears, reads and caps.
    const trace: string[] = [];
    const make = (n: number): FitBubble => {
      const b = new FakeBubble(Array(8).fill(45), 255);
      const lines = b.lines.bind(b);
      const height = b.height.bind(b);
      const width = b.width.bind(b);
      const cap = b.cap.bind(b);
      return {
        classes: () => b.classes(),
        children: () => b.children(),
        padding: () => b.padding(),
        lines: () => {
          trace.push(`read${n}`);
          return lines();
        },
        height: () => {
          trace.push(`read${n}`);
          return height();
        },
        width: () => {
          trace.push(`read${n}`);
          return width();
        },
        cap: (px) => {
          trace.push(px === null ? `clear${n}` : `cap${n}`);
          cap(px);
        },
      };
    };
    fitBubbles([make(1), make(2), make(3)]);
    const phases = trace.join(" ");
    // every clear lands before the first measurement, and every cap before the
    // first verification read after it
    expect(phases.indexOf("clear3")).toBeLessThan(phases.indexOf("read1"));
    expect(phases.indexOf("cap3")).toBeLessThan(phases.lastIndexOf("read1"));
    // and no clear/cap ever sits between two reads of the same phase
    const runs = trace.map((t) => t.replace(/\d+$/, ""));
    expect(runs.join(",")).toBe(
      ["clear", "clear", "clear", ...Array(9).fill("read"), "cap", "cap", "cap", "read", "read", "read"].join(","),
    );
  });
});

// --- the main.ts wiring -------------------------------------------------------

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/main.ts"),
  "utf8",
);

function fnBody(name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `missing ${name}`).toBeGreaterThan(-1);
  const end = src.indexOf("\n}", start);
  return src.slice(start, end);
}

describe("main.ts wiring: where the fit runs", () => {
  it("every render site queues its bubbles for the pass", () => {
    expect(fnBody("applyEvent")).toContain("scheduleBubbleFit(wrapper)");
    expect(fnBody("rerender")).toContain("scheduleBubbleFit(w)");
    expect(fnBody("localBubble")).toContain("scheduleBubbleFit(w)");
    expect(fnBody("restoreOutbox")).toContain("scheduleBubbleFit(w)");
  });

  it("the queue drains in ONE frame, and drops bubbles that left the DOM", () => {
    const sched = fnBody("scheduleBubbleFit");
    expect(sched).toContain("fitQueue.add(el)");
    expect(sched).toContain("if (fitFrame"); // a second queue in the same frame adds no frame
    expect(sched).toContain("requestAnimationFrame");
    expect(fnBody("runBubbleFits")).toContain("el.isConnected");
  });

  it("the send fits SYNCHRONOUSLY, before the morph measures the seat", () => {
    const send = fnBody("send");
    const fit = send.indexOf("fitBubblesNow(w)");
    expect(fit).toBeGreaterThan(-1);
    expect(fit).toBeGreaterThan(send.indexOf('rowEl(w, "user", "text"')); // after the text
    expect(fit).toBeLessThan(send.indexOf("flyFromField(")); // and before the launch
    expect(fit).toBeLessThan(send.indexOf("scrollToBottom(true); // instant pin first"));
  });

  it("a width change refits everything; a height change refits nothing", () => {
    // the thread's box moves on every frame of the keyboard's edges and the
    // drawer's ease, and none of that changes a wrap — only a rotation or a
    // resize may queue the whole thread
    const start = src.indexOf("const threadWidthObserver =");
    expect(start).toBeGreaterThan(-1);
    const wiring = src.slice(start, src.indexOf("\n\n", start));
    expect(wiring).toContain("clientWidth");
    expect(wiring).toContain("if (w === lastThreadWidth) return;");
    expect(wiring).toContain("scheduleBubbleFit(");
    // and it stays OFF the settle's own per-frame path, which is untouched
    expect(src).toContain('new ResizeObserver(() => settleTail("box", true))');
    expect(src).toContain("threadWidthObserver?.observe(thread)"); // rebound per shell
  });

  it("the rects are folded onto lines, from the content edge, unscaled", () => {
    const target = fnBody("fitTarget");
    expect(target).toContain("range.selectNodeContents(el)");
    expect(target).toContain("fitScale(box.width, el.offsetWidth)");
    // the three arguments that make the reading right: the fragments, the
    // content box's own left edge, and the live scale to divide back out
    expect(target).toContain(
      "bubbleLineWidths(range.getClientRects(), box.left + padOf(el)[0] * k, k)",
    );
    // the cap is a max-width: it can narrow a bubble and can never widen one
    expect(target).toContain('el.style.removeProperty("max-width")');
    expect(target).toContain('el.style.setProperty("max-width"');
    expect(target).not.toContain("style.width"); // never an explicit width
  });

  it("the bubble geometry it fits is still the stylesheet's own", () => {
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../src/styles.css"),
      "utf8",
    );
    const msg = css.slice(css.indexOf(".msg {"), css.indexOf("}", css.indexOf(".msg {")));
    expect(msg).toContain("max-width: 75%"); // the cap the fit exists to trim back from
    expect(msg).toContain("padding: 10px 16px"); // the inset the target width adds back
    expect(css).toContain(".row.user { justify-content: flex-end; }"); // sent stays right
  });
});
