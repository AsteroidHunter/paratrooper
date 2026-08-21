// The sent photo's reserved seat: unit tests for the box math and the pixel
// wait (photobox.ts), and source pins for the DOM wiring in send() and the
// picked-photo tray (main.ts), which lives in the layer that boots a real shell
// at import time and cannot load under node, the same split flight.test.ts and
// zoom.test.ts use.
//
// What the math tests hold is the whole point of the change: the height
// reserved BEFORE the photo's pixels arrive is the height the photo actually
// renders at. .msg.shot img carries `height: auto`, so a decoded photo's height
// is its used width divided by its own aspect ratio; renderedHeight below is
// that rule, written out independently of photoBox. Reserve == render means the
// row cannot grow after the send pins the thread, which is what left a landing
// photo as a thin top sliver under the compose bar.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DRAW_NO_DEADLINE,
  SHOT_DRAW_MS,
  SHOT_MAX_WIDTH,
  THUMB_SLIDE_PX,
  photoBox,
  thumbSlide,
  whenDrawn,
} from "../src/photobox";
import type { Drawable, DrawWhy } from "../src/photobox";

// what CSS `height: auto` gives a replaced element once its own size is known
function renderedHeight(natW: number, natH: number, usedW: number): number {
  return usedW * (natH / natW);
}

const ROW = 358; // a 390pt phone thread: 390 minus the .thread 1rem side padding

describe("photoBox: the seat reserved before the pixels land", () => {
  it("a tall portrait reserves the exact height it will render at", () => {
    const [natW, natH] = [1170, 2532]; // full-height phone screenshot
    const box = photoBox(natW, natH, ROW);
    expect(box.width).toBeCloseTo(ROW * SHOT_MAX_WIDTH, 10);
    expect(box.height).toBeCloseTo(renderedHeight(natW, natH, box.width), 10);
    expect(box.height).toBeGreaterThan(500); // a seat, not the sliver the bug left
  });

  it("a wide landscape reserves the exact height it will render at", () => {
    const [natW, natH] = [4032, 3024]; // 4:3 phone camera photo
    const box = photoBox(natW, natH, ROW);
    expect(box.width).toBeCloseTo(ROW * SHOT_MAX_WIDTH, 10);
    expect(box.height).toBeCloseTo(renderedHeight(natW, natH, box.width), 10);
    expect(box.height).toBeCloseTo((ROW * SHOT_MAX_WIDTH * 3) / 4, 10);
  });

  it("reserve equals render across shapes, orientations and row widths", () => {
    const shapes: [number, number][] = [
      [1170, 2532], [4032, 3024], [3024, 4032], [200, 3000], [3000, 200], [100, 120],
    ];
    for (const rowW of [320, 358, 430, 820]) {
      for (const [natW, natH] of shapes) {
        const box = photoBox(natW, natH, rowW);
        expect(box.height).toBeCloseTo(renderedHeight(natW, natH, box.width), 10);
      }
    }
  });

  it("caps at the bubble's 75% share of the row, ratio kept", () => {
    const box = photoBox(4000, 2000, ROW);
    expect(box.width).toBeCloseTo(268.5, 10);
    expect(box.height).toBeCloseTo(134.25, 10);
  });

  it("never upscales a photo smaller than the cap", () => {
    const box = photoBox(120, 90, ROW);
    expect(box.width).toBe(120);
    expect(box.height).toBe(90);
  });

  it("an unmeasurable row falls back to natural width, never a zero box", () => {
    const box = photoBox(1170, 2532, 0);
    expect(box.width).toBe(1170);
    expect(box.height).toBe(2532);
  });

  it("an unknown size reserves nothing at all (the caller's fallback branch)", () => {
    expect(photoBox(0, 0, ROW)).toEqual({ width: 0, height: 0 });
    expect(photoBox(Number.NaN, 100, ROW)).toEqual({ width: 0, height: 0 });
  });
});

// --- the wait: read is not drawn ----------------------------------------------
// The blank both bugs showed. A real image reports load as soon as the file is
// READ and only paints once its pixels are DRAWN, and on a camera photo those
// are a beat apart; the fake below can be told to do each one separately, so
// "the app went on the read" and "the app went on the draw" are distinguishable
// outcomes rather than a restatement of whichever call the code happens to make.

class FakeImg implements Drawable {
  listeners = new Map<string, (() => void)[]>();
  decodes = 0;
  private finishDecode: (() => void) | null = null;
  private failDecode: (() => void) | null = null;

  decode(): Promise<unknown> {
    this.decodes++;
    return new Promise<void>((res, rej) => {
      this.finishDecode = () => res();
      this.failDecode = () => rej(new Error("EncodingError"));
    });
  }

  addEventListener(type: string, cb: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }

  /** the file is in: every byte read, size known, NOT yet painted */
  read(): void {
    for (const cb of this.listeners.get("load") ?? []) cb();
  }

  /** the pixels are ready to paint: safe to put on screen */
  drawn(): void {
    this.finishDecode?.();
  }

  /** the phone gave up on the pixels */
  broke(): void {
    this.failDecode?.();
  }
}

// an image element from a browser too old to have decode() at all
class ReadOnlyImg extends FakeImg {
  // @ts-expect-error deliberately absent, which is the case under test
  decode = undefined;
}

// what the caller has actually learned so far, so "has not settled yet" is a
// thing a test can assert instead of a thing it waits for
function watch(p: Promise<DrawWhy>): { why: DrawWhy | null } {
  const seen: { why: DrawWhy | null } = { why: null };
  void p.then((w) => {
    seen.why = w;
  });
  return seen;
}

// drains the promise jobs a settle travels through, without letting the clock move
async function microtasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("whenDrawn: nothing shows a photo until the pixels are there", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not settle when the file is merely READ", async () => {
    const img = new FakeImg();
    const seen = watch(whenDrawn(img, SHOT_DRAW_MS));
    img.read(); // load has fired: the old wait ended HERE, and the frame was blank
    await microtasks();
    vi.advanceTimersByTime(SHOT_DRAW_MS - 1); // still inside the deadline
    await microtasks();
    expect(seen.why).toBeNull();
  });

  it("settles once the pixels are drawn, which is later than the read", async () => {
    const img = new FakeImg();
    const seen = watch(whenDrawn(img, SHOT_DRAW_MS));
    img.read();
    vi.advanceTimersByTime(120); // the beat between reading and drawing
    await microtasks();
    expect(seen.why).toBeNull();
    img.drawn();
    await microtasks();
    expect(seen.why).toBe("drawn");
  });

  it("a photo that never draws still goes, at the deadline", async () => {
    const img = new FakeImg();
    const seen = watch(whenDrawn(img, SHOT_DRAW_MS));
    img.read();
    vi.advanceTimersByTime(SHOT_DRAW_MS);
    await microtasks();
    expect(seen.why).toBe("late"); // the send is not held, exactly as before
  });

  it("a photo that never even reads still goes, at the same deadline", async () => {
    const img = new FakeImg();
    const seen = watch(whenDrawn(img, SHOT_DRAW_MS));
    vi.advanceTimersByTime(SHOT_DRAW_MS);
    await microtasks();
    expect(seen.why).toBe("late");
  });

  it("a decode that fails settles instead of hanging until the deadline", async () => {
    const img = new FakeImg();
    const seen = watch(whenDrawn(img, SHOT_DRAW_MS));
    img.broke();
    await microtasks();
    expect(seen.why).toBe("error");
    expect(vi.getTimerCount()).toBe(0); // and the deadline is disarmed behind it
  });

  it("a decode refused outright falls back to the read rather than throwing", async () => {
    const img = new FakeImg();
    img.decode = () => {
      throw new Error("refused");
    };
    const seen = watch(whenDrawn(img, SHOT_DRAW_MS));
    img.read();
    await microtasks();
    expect(seen.why).toBe("load");
  });

  it("a browser with no decode() settles on the read, the old behaviour", async () => {
    const img = new ReadOnlyImg();
    const seen = watch(whenDrawn(img, SHOT_DRAW_MS));
    img.read();
    await microtasks();
    expect(seen.why).toBe("load"); // not "late": it must not wait out the deadline
  });

  it("settles exactly once: a late deadline cannot overwrite a drawn photo", async () => {
    const img = new FakeImg();
    const seen = watch(whenDrawn(img, SHOT_DRAW_MS));
    img.drawn();
    await microtasks();
    expect(seen.why).toBe("drawn");
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(SHOT_DRAW_MS * 10);
    await microtasks();
    expect(seen.why).toBe("drawn");
  });

  it("asks the image to decode once, not once per waiter", async () => {
    const img = new FakeImg();
    watch(whenDrawn(img, SHOT_DRAW_MS));
    img.drawn();
    await microtasks();
    expect(img.decodes).toBe(1);
  });
});

// --- the wait with nothing behind it ------------------------------------------
// The tray's own wait. Its seat and the tray's opening are already on screen, so
// there is nothing for a deadline to release: settling "late" there would only
// uncover an empty square. A deadline this caller cannot express by hand —
// setTimeout takes a long, so an Infinity handed to it straight arrives as zero
// and fires on the very next tick, which is why the arming is guarded.

describe("whenDrawn with no deadline: it waits as long as the pixels take", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("arms no timer at all", () => {
    watch(whenDrawn(new FakeImg(), DRAW_NO_DEADLINE));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never settles late, however far past the send's deadline the clock runs", async () => {
    const img = new FakeImg();
    const seen = watch(whenDrawn(img, DRAW_NO_DEADLINE));
    img.read(); // the bytes are in; the 12MP decode is still running
    vi.advanceTimersByTime(SHOT_DRAW_MS * 100);
    await microtasks();
    expect(seen.why).toBeNull(); // nothing has uncovered the square
  });

  it("settles the moment the pixels land, which is what starts the slide", async () => {
    const img = new FakeImg();
    const seen = watch(whenDrawn(img, DRAW_NO_DEADLINE));
    vi.advanceTimersByTime(SHOT_DRAW_MS * 4); // his camera photos all took longer
    await microtasks();
    expect(seen.why).toBeNull();
    img.drawn();
    await microtasks();
    expect(seen.why).toBe("drawn");
  });

  it("a decode that fails still settles, so the square is never stuck waiting", async () => {
    const img = new FakeImg();
    const seen = watch(whenDrawn(img, DRAW_NO_DEADLINE));
    img.broke();
    await microtasks();
    expect(seen.why).toBe("error");
  });

  it("a browser with no decode() settles on the read, not on nothing", async () => {
    const img = new ReadOnlyImg();
    const seen = watch(whenDrawn(img, DRAW_NO_DEADLINE));
    img.read();
    await microtasks();
    expect(seen.why).toBe("load");
  });
});

// --- the picked photo's entrance ----------------------------------------------

describe("thumbSlide: the preview comes in from the left and settles", () => {
  it("starts displaced to the LEFT and ends home", () => {
    const [from, to] = thumbSlide();
    expect(String(from.transform)).toMatch(/^translateX\(-\d/); // negative x: left of its seat
    expect(to.transform).toBe("none");
  });

  it("travels a short way, with no origin to read as the ＋ button", () => {
    expect(THUMB_SLIDE_PX).toBeGreaterThan(0);
    expect(THUMB_SLIDE_PX).toBeLessThanOrEqual(24); // under half the 64px thumbnail
  });

  it("moves and fades only: nothing here grows the photo out of nothing", () => {
    const frames = thumbSlide();
    expect(frames.map((f) => f.opacity)).toEqual([0, 1]);
    for (const f of frames) {
      expect(Object.keys(f).sort()).toEqual(["opacity", "transform"]);
      expect(String(f.transform)).not.toMatch(/scale/);
    }
  });
});

// --- source pins on the main.ts wiring ----------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/main.ts"), "utf8");
const css = readFileSync(join(here, "../src/styles.css"), "utf8");

// read inside each test, never at describe level: a pin for a function that does
// not exist yet must fail as its own test, not take the whole file down with it
function fnBody(name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("\n}", start);
  return src.slice(start, end);
}

describe("photo send wiring: the seat is taken before the thread pins", () => {
  const send = (): string => fnBody("send");
  const prepare = (): string => fnBody("prepareShot");

  it("the photo is DRAWN, not merely read, before the row is built", () => {
    expect(prepare()).toContain("whenDrawn(img, SHOT_DRAW_MS)");
    // the old wait: a load listener settling the promise. Its absence is the fix.
    expect(prepare()).not.toContain('addEventListener("load"');
  });

  it("the drawn photo is taken from the tray, prepared when it was picked", () => {
    const take = send().indexOf("files.map(takeShot)");
    const insert = send().indexOf('rowEl(w, "user", "shot"');
    expect(take).toBeGreaterThan(-1);
    expect(take).toBeLessThan(insert);
    expect(fnBody("stagePick")).toContain("prepareShot(url)"); // at pick time, not send time
  });

  it("the wait is awaited before anything measures, inserts, pins or flies", () => {
    const send = fnBody("send");
    const wait = send.indexOf("await Promise.all(shots)");
    expect(wait).toBeGreaterThan(-1);
    expect(wait).toBeLessThan(send.indexOf("beginSiblingShift()"));
    expect(wait).toBeLessThan(send.indexOf("localWrapper(\"user\")"));
    expect(wait).toBeLessThan(send.indexOf("div.appendChild(img)"));
    expect(wait).toBeLessThan(send.indexOf("scrollToBottom(true)"));
    expect(wait).toBeLessThan(send.indexOf("flyFromField(w, morph)"));
  });

  it("the box is written onto the row before the pin, from ratio and row width", () => {
    const send = fnBody("send");
    const reserve = send.indexOf("photoBox(nat[0], nat[1], rowW)");
    expect(reserve).toBeGreaterThan(-1);
    expect(reserve).toBeLessThan(send.indexOf("scrollToBottom(true)"));
    expect(send).toContain("img.width = nat[0]"); // the ratio height:auto reads
    expect(send).toContain("img.height = nat[1]");
    expect(send).toContain("img.style.width = `${box.width}px`"); // the bubble's share
    expect(send).toContain("threadContentWidth()");
    // read at insert time, so a photo that outran its deadline and has since
    // drawn still gets its exact seat
    expect(send).toContain("naturalSize(img)");
    expect(fnBody("naturalSize")).toContain("img.naturalWidth > 0 && img.naturalHeight > 0");
  });

  it("a size that never arrives falls back to a re-pin on load", () => {
    const send = fnBody("send");
    const fallback = send.indexOf("img.onload");
    expect(fallback).toBeGreaterThan(-1);
    expect(send.slice(fallback)).toContain("if (followTail) scrollToBottom(true)");
    expect(prepare()).toContain("SHOT_DRAW_MS"); // the wait is deadlined
  });

  it("the send never revokes a url the thread has started reading from", () => {
    expect(fnBody("takeShot")).toContain('pick.url = ""');
    expect(fnBody("renderPending")).toContain("if (pick.url) URL.revokeObjectURL(pick.url)");
  });

  it("both outcomes ride the existing flight trail, no new channel", () => {
    expect(send()).toContain('phase: "shot-reserve"');
    expect(prepare()).toContain('phase: "shot-dims"');
    expect(src).not.toMatch(/holdDiagRecord\("shot/); // the flight channel, not a new one
  });
});

// The tray's own seat, split from its pixels. Gating BOTH on the decode is what
// left the strip and the thumbnail arriving a beat after the tap: on device every
// 12MP camera photo missed the 350ms deadline and was revealed undrawn, while the
// one screenshot came back "drawn" and felt instant. The seat is the tap's own
// feedback and owes the pixels nothing; only the picture inside waits.
describe("picked-photo preview wiring: the seat lands on the tap, the picture later", () => {
  const stage = (): string => fnBody("stagePick");

  it("the square is in the tray before anything is waited on", () => {
    const seat = stage().indexOf("box.appendChild(wrap)");
    const wait = stage().indexOf("whenDrawn(img");
    expect(seat).toBeGreaterThan(-1);
    expect(wait).toBeGreaterThan(-1);
    expect(seat).toBeLessThan(wait);
    // and nothing in the stylesheet takes that seat away again while it waits
    expect(css).not.toMatch(/\.pthumb\.undrawn\s*\{\s*display:\s*none/);
  });

  it("the tray opens on the files it holds, never on their pixels", () => {
    expect(fnBody("showPending")).toContain('pendingFiles.length > 0 ? "flex" : "none"');
    expect(fnBody("showPending")).not.toContain("shown"); // the pixel test WAS the defect
    // the old tray rebuilt itself blank on every change
    expect(fnBody("renderPending")).not.toContain('box.innerHTML = ""');
    // and the tap's own render is what opens it, not the wait's continuation
    expect(fnBody("renderPending")).toContain("showPending()");
    expect(stage()).not.toContain("showPending()");
  });

  it("only the IMG is gated, by opacity, so the reserved box keeps its space", () => {
    expect(stage()).toContain('wrap.className = "pthumb undrawn"');
    expect(css).toMatch(/\.pthumb\.undrawn img \{ opacity: 0; \}/);
    // the 64px square is written on the img itself and gated on nothing
    expect(css).toMatch(/\.pthumb img \{[^}]*\bwidth: 64px;[^}]*\bheight: 64px;/);
  });

  it("the waiting square wears the thread's own placeholder, not a bare frame", () => {
    // the same grey face and shared ring .msg.shot img.waiting uses
    expect(css).toMatch(/\.pthumb\.undrawn::before \{[^}]*background: var\(--received\)/);
    expect(css).toMatch(/\.pthumb\.undrawn::after \{[^}]*animation: oldspin/);
  });

  it("the wait carries no deadline: no timer ever uncovers an empty square", () => {
    expect(stage()).toContain("whenDrawn(img, DRAW_NO_DEADLINE)");
    expect(stage()).not.toContain("whenDrawn(img, SHOT_DRAW_MS)"); // the send's deadline, not this one
    expect(src).toContain("DRAW_NO_DEADLINE");
  });

  it("the reveal and the slide both wait for the pixels, in that order", () => {
    const wait = stage().indexOf("whenDrawn(img, DRAW_NO_DEADLINE).then");
    const reveal = stage().indexOf('wrap.classList.remove("undrawn")');
    const slide = stage().indexOf("wrap.animate(thumbSlide()");
    expect(wait).toBeGreaterThan(-1);
    expect(wait).toBeLessThan(reveal);
    expect(reveal).toBeLessThan(slide);
    expect(stage()).toContain("{ duration: FLIGHT_MS, easing: FLIGHT_EASE }"); // the app's own beat
  });

  it("the pick-show record survives, now carrying how long the pixels took", () => {
    expect(stage()).toContain('phase: "pick-show"');
    expect(stage()).toContain("ms: Math.round(performance.now() - staged)");
  });

  it("a photo that never decodes still sends AND still previews", () => {
    // sends: the SEND's wait keeps its deadline, so the row goes without pixels
    expect(fnBody("prepareShot")).toContain("whenDrawn(img, SHOT_DRAW_MS)");
    expect(fnBody("send")).toContain("await Promise.all(shots)");
    expect(fnBody("send")).toContain("img.onload"); // and re-pins if they land later
    // previews: the seat, its placeholder and the removal ✕ are all on screen
    // from the tap, none of them behind the wait
    const stageBody = stage();
    const wait = stageBody.indexOf("whenDrawn(img");
    expect(stageBody.indexOf("wrap.append(img, x)")).toBeLessThan(wait);
    expect(stageBody.indexOf("box.appendChild(wrap)")).toBeLessThan(wait);
    expect(stageBody).toContain('x.className = "pthumb-x"');
  });
});
