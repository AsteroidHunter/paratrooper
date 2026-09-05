// The reply's arrival: the typing dots' own bubble becomes the message.
//
// Two faults are held here, both measured frame by frame against this
// stylesheet in a real engine (Chromium and WebKit, scroll anchoring off,
// 2026-09-04). The numbers below are those measurements, not estimates.
//
//   THE DROP. hideTyping ran BEFORE the reply was built, so the settle it
//   fires corrected a thread that had lost the dots' 40px (a 32px bubble, its
//   6px top margin, the thread's 2px gap) and had not yet gained the message.
//   The first painted frame after that task sat 40.00px lower — measured, in
//   both engines, for a one-line reply and a long one alike — and the tail
//   ride then had to climb back through it. Ordering, not arithmetic: the
//   settle was right about the content it could see.
//
//   THE SECOND MOTION. The dots vanished and a separate bubble arrived
//   carrying pop-in, which changes no layout height and no scroll range.
//
// With the morph the same measurement reads +0.00px on the first painted
// frame, the tail box grows 32 -> 42.94 (one line) or 32 -> 180.56 (a long
// reply) and never shrinks by a single pixel on the way, the thread keeps the
// same number of flex children throughout, and ONE .msg element carries the
// whole transition.
//
// The pure half is testable directly. The wiring lives in main.ts, which boots
// a real shell at import time and cannot load under node, so those pins read
// the source — the same split flight.test.ts and tailsettle.test.ts use.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ARRIVE_MS,
  arriveBox,
  arrivalMorphs,
  arrivalOffered,
  arrivalShape,
  dotsAlpha,
  inkAlpha,
} from "../src/arrival";
import { FLIGHT_MS } from "../src/shift";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/main.ts"), "utf8");
const sheet = readFileSync(join(here, "../src/styles.css"), "utf8");
const arrival = readFileSync(join(here, "../src/arrival.ts"), "utf8");

function fnBody(name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("\n}", start);
  return src.slice(start, end);
}

// the boxes as the engines measured them, at 390px of viewport
const DOTS = { width: 62, height: 32, margin: 6 };
const ONE_LINE = { width: 169.89, height: 42.94, margin: 10 };
const LONG = { width: 267, height: 180.56, margin: 10 };
const RUN = { width: 169.89, height: 42.94, margin: 2 }; // a continuation: 2px, not 10

describe("the box the morph travels", () => {
  it("starts on the dots' own box and ends on the message's, exactly", () => {
    expect(arriveBox(DOTS, ONE_LINE, 0)).toEqual(DOTS);
    expect(arriveBox(DOTS, ONE_LINE, 1)).toEqual(ONE_LINE);
  });

  it("the height only ever grows: no frame gives back what an earlier one took", () => {
    // the whole point. A shrink anywhere in here is the drop by another route.
    for (const to of [ONE_LINE, LONG, RUN]) {
      let last = -Infinity;
      for (let i = 0; i <= 100; i++) {
        const h = arriveBox(DOTS, to, i / 100).height;
        expect(h).toBeGreaterThanOrEqual(last);
        last = h;
      }
      expect(last).toBe(to.height);
    }
  });

  it("a run continuation's margin travels DOWN and the box still nets a growth", () => {
    // decorate() gives a reply that continues a run 2px of row margin against
    // the dots' 6px, so 4px of this morph moves the wrong way. The height it
    // moves inside is larger than that at every point, which is why the
    // measured first frame is +0.00 and not +4.
    let last = -Infinity;
    for (let i = 0; i <= 100; i++) {
      const b = arriveBox(DOTS, RUN, i / 100);
      const total = b.height + b.margin;
      expect(total).toBeGreaterThanOrEqual(last);
      last = total;
    }
    expect(last).toBe(RUN.height + RUN.margin);
  });

  it("the width travels too, so the box opens in both directions like Messages", () => {
    expect(arriveBox(DOTS, LONG, 0.5).width).toBeCloseTo((62 + 267) / 2, 6);
  });
});

describe("the crossfade inside the box", () => {
  it("the dots are gone before the text starts: the two never share a frame", () => {
    expect(dotsAlpha(0)).toBe(1);
    let dotsGone = 1;
    for (let i = 0; i <= 1000; i++) {
      const f = i / 1000;
      if (dotsAlpha(f) === 0) { dotsGone = Math.min(dotsGone, f); break; }
    }
    let inkStarts = 1;
    for (let i = 0; i <= 1000; i++) {
      const f = i / 1000;
      if (inkAlpha(f) > 0) { inkStarts = f; break; }
    }
    expect(dotsGone).toBeLessThan(inkStarts);
  });

  it("both ends are clean: full dots at launch, full text at landing", () => {
    expect(dotsAlpha(0)).toBe(1);
    expect(dotsAlpha(1)).toBe(0);
    expect(inkAlpha(0)).toBe(0);
    expect(inkAlpha(1)).toBe(1);
  });

  it("the beat sits between the entrance it replaces and the send's flight", () => {
    expect(ARRIVE_MS).toBeGreaterThan(200); // the pop-in this replaces
    expect(ARRIVE_MS).toBeLessThan(FLIGHT_MS); // the send flight, which travels
  });
});

describe("when the dots' box is taken over at all", () => {
  it("a live agent reply at the tail with dots up takes it", () => {
    expect(arrivalMorphs(true, true, true, "agent", "text")).toBe(true);
    expect(arrivalMorphs(true, true, true, "agent", "error")).toBe(true);
  });

  it("no dots on screen, no tail, or a replay burst: nothing to take over", () => {
    expect(arrivalOffered(false, true, true)).toBe(false);
    expect(arrivalOffered(true, false, true)).toBe(false);
    expect(arrivalOffered(true, true, false)).toBe(false); // suppressAnim: history
  });

  it("a photo, a PR row, your own message and a system line keep the old removal", () => {
    expect(arrivalShape("agent", "shot")).toBe(false);
    expect(arrivalShape("agent", "pr")).toBe(false);
    expect(arrivalShape("user", "text")).toBe(false);
    expect(arrivalShape("system", "line")).toBe(false);
  });
});

describe("the wiring in main.ts", () => {
  const apply = fnBody("applyEvent");

  it("the height NEVER leaves before it returns: the offer precedes the removal", () => {
    // the seam this whole change is about. renderInto is what decides whether
    // there is a bubble to become, so the removal cannot be answered before it.
    const offer = apply.indexOf("offerDots(dots)");
    const render = apply.indexOf("renderInto(wrapper, m)");
    const take = apply.indexOf("takeDotsOffer()");
    const hide = apply.indexOf("hideTyping()");
    expect(offer).toBeGreaterThan(-1);
    expect(offer).toBeLessThan(render);
    expect(render).toBeLessThan(take);
    expect(take).toBeLessThan(hide);
  });

  it("and the removal only runs when nothing grew into them", () => {
    expect(apply).toContain("if (endsDots && !morphing) hideTyping()");
  });

  it("the dots are read before a byte is written, or the start box is a lie", () => {
    const read = apply.indexOf("dotsSeat(dots)");
    expect(read).toBeGreaterThan(-1);
    expect(read).toBeLessThan(apply.indexOf("offerDots(dots)"));
  });

  it("a morph owns the scroll for its beat: no ride is started underneath it", () => {
    expect(apply).toContain("if (morphing && seat) startArrival(wrapper, seat)");
    expect(apply).toContain("else if (followTail) scrollToBottom()");
  });

  it("ONE shape carries it: the dots' own div is handed to the row, never copied", () => {
    const row = fnBody("rowEl");
    expect(row).toContain("const div = offer ?? document.createElement(\"div\")");
    expect(row).toContain("offer.removeAttribute(\"id\")"); // hideTyping must not find it
    // and it wears the morph INSTEAD of the pop, never both
    expect(row).toContain('const entrance = offer ? " arriving" : suppressAnim ? "" : " anim";');
  });

  it("nothing else can pick the offer up: it is closed in the same task it opens", () => {
    // rowEl is shared with the send path and the outbox restore; an offer left
    // standing would be taken by whatever rendered next
    const take = fnBody("takeDotsOffer");
    expect(take).toContain("dotsOffered = null");
    expect(take).toContain("dotsTaken = false");
    expect(apply.indexOf("takeDotsOffer()")).toBeGreaterThan(-1);
  });

  it("the seat is final before the morph measures it, exactly like the send path", () => {
    const start = fnBody("startArrival");
    expect(start).toContain("fitBubblesNow(wrapper)");
    expect(start.indexOf("fitBubblesNow(wrapper)")).toBeLessThan(start.indexOf("runArrival("));
  });

  it("the bottom is re-taken in the same frame as every height that moves it", () => {
    const start = fnBody("startArrival");
    expect(start).toContain("pin: () => {");
    expect(start).toContain("if (followTail) scrollToBottom(true)"); // instant, never a ride
  });

  it("the fit gets its pass back once the box is a plain bubble again", () => {
    expect(fnBody("startArrival")).toContain("scheduleBubbleFit(wrapper)");
  });
});

describe("the timeout case is untouched: dots that led nowhere still settle", () => {
  const hide = fnBody("hideTyping");

  it("still removes and still settles, in that order", () => {
    expect(hide).toContain("dots.remove()");
    expect(hide.indexOf("dots.remove()")).toBeLessThan(hide.indexOf('settleContent("typing")'));
  });

  it("still the only three content settles the app has", () => {
    const names = [...src.matchAll(/settleContent\("([a-z]+)"\)/g)].map((m) => m[1]);
    expect(names.sort()).toEqual(["delete", "retract", "typing"]);
  });

  it("the morph adds no compensating scroll write of its own", () => {
    // the fix is the ordering. A settle here would be papering over it, and
    // would also be the one thing that cancels a ride mid-morph.
    expect(fnBody("startArrival")).not.toContain("settleContent");
    expect(fnBody("startArrival")).not.toContain("settleTail");
    expect(arrival).not.toContain("scrollTop");
  });
});

describe("the stylesheet", () => {
  it("no reduced-motion rule is left for an incoming bubble, or anywhere", () => {
    expect(sheet).not.toContain("prefers-reduced-motion");
  });

  it("the pop-in itself is still there for a bubble born in its own seat", () => {
    expect(sheet).toContain(".msg.anim { animation: pop-in");
  });

  it("the morphing box is clipped and positioned, so nothing re-wraps or steps", () => {
    expect(sheet).toContain(".msg.arriving { position: relative; overflow: hidden; }");
    expect(sheet).toContain(".msg.arriving > .arrive-ink { display: block; }");
  });

  it("the dots' inset is stated once and read by both boxes", () => {
    expect(sheet).toContain(".typing, .msg.arriving { --dots-pad-x: 14px; --dots-pad-y: 12px; }");
    expect(sheet).toContain("padding: var(--dots-pad-y) var(--dots-pad-x)");
    expect(sheet).toMatch(/\.msg\.arriving > \.arrive-dots \{[^}]*left: var\(--dots-pad-x\)/);
  });

  it("only the LIVE dots blink; inside a morph the wave is stopped", () => {
    expect(sheet).toContain(".typing span, .arrive-dots span {");
    expect(sheet).toContain(".typing span { animation: blink 1.2s infinite both; }");
    // the blink belongs to .typing alone, so a morphing dot holds what it was
    // caught at rather than restarting the wave under the reader's eye
    expect(sheet).not.toMatch(/\.arrive-dots span[^{]*\{[^}]*animation:/);
  });
});
