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
  SHOT_MAX_WIDTH,
  SMALL_SHOT_PX,
  THUMB_DROP_SCALE,
  THUMB_SLIDE_PX,
  photoBox,
  resizeHonoured,
  smallShotUrl,
  THUMB_MOVE_MIN_PX,
  thumbDrop,
  thumbMoved,
  thumbMoves,
  thumbPark,
  thumbShift,
  thumbSlide,
  trayClose,
  whenDrawn,
} from "../src/photobox";
import type { Drawable, DrawWhy, SmallDrawHost, SmallShot } from "../src/photobox";
import { WAIT_CLASS } from "../src/photolazy";

// A deadline, spelled out here rather than imported, because the app no longer
// names one: both places that show a picked photo can put a placeholder in the
// box instead of holding a frame back, so nothing passes whenDrawn a timer any
// more (the send's old 350ms is the number these use, so the give-up tests below
// still describe the behaviour that WAS shipped). The helper keeps the deadline
// for a caller that genuinely cannot wait, and these hold it to its contract.
const DEADLINE_MS = 350;

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
    const seen = watch(whenDrawn(img, DEADLINE_MS));
    img.read(); // load has fired: the old wait ended HERE, and the frame was blank
    await microtasks();
    vi.advanceTimersByTime(DEADLINE_MS - 1); // still inside the deadline
    await microtasks();
    expect(seen.why).toBeNull();
  });

  it("settles once the pixels are drawn, which is later than the read", async () => {
    const img = new FakeImg();
    const seen = watch(whenDrawn(img, DEADLINE_MS));
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
    const seen = watch(whenDrawn(img, DEADLINE_MS));
    img.read();
    vi.advanceTimersByTime(DEADLINE_MS);
    await microtasks();
    expect(seen.why).toBe("late"); // the send is not held, exactly as before
  });

  it("a photo that never even reads still goes, at the same deadline", async () => {
    const img = new FakeImg();
    const seen = watch(whenDrawn(img, DEADLINE_MS));
    vi.advanceTimersByTime(DEADLINE_MS);
    await microtasks();
    expect(seen.why).toBe("late");
  });

  it("a decode that fails settles instead of hanging until the deadline", async () => {
    const img = new FakeImg();
    const seen = watch(whenDrawn(img, DEADLINE_MS));
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
    const seen = watch(whenDrawn(img, DEADLINE_MS));
    img.read();
    await microtasks();
    expect(seen.why).toBe("load");
  });

  it("a browser with no decode() settles on the read, the old behaviour", async () => {
    const img = new ReadOnlyImg();
    const seen = watch(whenDrawn(img, DEADLINE_MS));
    img.read();
    await microtasks();
    expect(seen.why).toBe("load"); // not "late": it must not wait out the deadline
  });

  it("settles exactly once: a late deadline cannot overwrite a drawn photo", async () => {
    const img = new FakeImg();
    const seen = watch(whenDrawn(img, DEADLINE_MS));
    img.drawn();
    await microtasks();
    expect(seen.why).toBe("drawn");
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(DEADLINE_MS * 10);
    await microtasks();
    expect(seen.why).toBe("drawn");
  });

  it("asks the image to decode once, not once per waiter", async () => {
    const img = new FakeImg();
    watch(whenDrawn(img, DEADLINE_MS));
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
    vi.advanceTimersByTime(DEADLINE_MS * 100);
    await microtasks();
    expect(seen.why).toBeNull(); // nothing has uncovered the square
  });

  it("settles the moment the pixels land, which is what starts the slide", async () => {
    const img = new FakeImg();
    const seen = watch(whenDrawn(img, DRAW_NO_DEADLINE));
    vi.advanceTimersByTime(DEADLINE_MS * 4); // his camera photos all took longer
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

describe("photo send wiring: the seat is taken, and nothing is waited on", () => {
  const send = (): string => fnBody("send");
  const prepare = (): string => fnBody("prepareShot");

  it("the photo is DRAWN, not merely read, before its placeholder comes off", () => {
    expect(prepare()).toContain("whenDrawn(img, DRAW_NO_DEADLINE)");
    // the old wait: a load listener settling the promise. Its absence is the fix.
    expect(prepare()).not.toContain('addEventListener("load"');
  });

  it("the photo is taken from the tray: the element it has been drawing since the pick", () => {
    const take = send().indexOf("files.map(takeShot)");
    const insert = send().indexOf('rowEl(w, "user", "shot"');
    expect(take).toBeGreaterThan(-1);
    expect(take).toBeLessThan(insert);
    expect(fnBody("stagePick")).toContain("prepareShot(url)"); // at pick time, not send time
    expect(fnBody("takeShot")).toContain("return pick.img"); // that element, not a copy of it
  });

  it("the send waits on NOTHING: the tap builds the row on the spot", () => {
    const body = send();
    // The wait that WAS here, and what it bought: the whole task held for up to
    // 350ms on every photo send, missed by every camera photo on device, and
    // then the row went up empty anyway. That gap is the lag he reported
    // between the tray vanishing and the photo appearing.
    expect(body).not.toContain("Promise.all(shots)");
    expect(body).not.toContain("whenDrawn");
    const awaits = (body.match(/\bawait\b[^\n]*/g) ?? []).map((s) => s.trim());
    expect(awaits).toHaveLength(2);
    expect(awaits[0]).toContain("requestAnimationFrame"); // the composer collapse's own paint
    expect(awaits[1]).toContain("transmit("); // the network, behind the bubble
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
    // read at insert time off the element the tray has been loading, so the seat
    // needs only the file's READ, never its slower decode
    expect(send).toContain("naturalSize(img)");
    expect(fnBody("naturalSize")).toContain("img.naturalWidth > 0 && img.naturalHeight > 0");
  });

  it("a size that never arrives falls back to a re-pin on load, unchanged", () => {
    const send = fnBody("send");
    const fallback = send.indexOf("img.onload");
    expect(fallback).toBeGreaterThan(-1);
    expect(send.slice(fallback)).toContain("if (followTail) scrollToBottom(true)");
    // and nothing invented a size to stand in for the one that never came
    expect(send).not.toMatch(/img\.width = \d/);
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

// --- one decode, shared -------------------------------------------------------
// The defect underneath both of the slow ones. The tray made an img for its
// thumbnail and send() made a SECOND img over the same blob url for the bubble,
// and both called decode() on the same twelve megapixels at the same moment. On
// device that pair fought each other: one copy came back "drawn" after 3654ms
// while its twin, decoding identical bytes beside it, ran out of patience at
// 350ms and handed the send an element with no pixels in it.

describe("one decode per picked photo: the tray's element IS the thread's", () => {
  it("exactly one wait exists in the whole app, and prepareShot owns it", () => {
    expect(src.match(/whenDrawn\(/g)).toHaveLength(1);
    expect(fnBody("prepareShot")).toContain("whenDrawn(img, DRAW_NO_DEADLINE)");
  });

  it("only prepareShot makes a photo element for a picked file", () => {
    expect(fnBody("prepareShot")).toContain('document.createElement("img")');
    // nobody else does, so there is no second element to start a second decode
    expect(fnBody("stagePick")).not.toContain('document.createElement("img")');
    expect(fnBody("send")).not.toContain('document.createElement("img")');
    expect(fnBody("takeShot")).not.toContain('document.createElement("img")');
  });

  it("the tray and the send hold the same node, not two over one url", () => {
    expect(src).toContain("img: HTMLImageElement; // the ONE drawn photo");
    expect(fnBody("stagePick")).toContain("const img = shot.img");
    expect(fnBody("stagePick")).toContain("const pick: Pick = { url, wrap, img }");
    expect(fnBody("takeShot")).toContain("return pick.img");
    // the Pick no longer carries a promise of some other element
    expect(src).not.toContain("shot: Promise<HTMLImageElement>");
  });

  it("the tray JOINS that one wait rather than starting a second", () => {
    expect(fnBody("stagePick")).toContain("shot.drawn.then");
    expect(fnBody("stagePick")).not.toContain("whenDrawn");
  });

  it("an unstaged file still gets exactly one, made the same way", () => {
    expect(fnBody("takeShot")).toContain("prepareShot(URL.createObjectURL(file)).img");
  });
});

// --- the sent bubble's placeholder --------------------------------------------
// What let the send's wait go. A row built before its pixels arrive used to be
// nothing at all — a correctly sized empty frame — so the send had to choose
// between holding the tap and showing a blank. It shows the same grey face and
// ring the tray's waiting square wears instead, which is the same mark every
// history photo wears before it loads, so there is no third vocabulary here.
//
// A history photo now paints its own blurred colours over that face when the
// server sent it a blurhash (blurhash.ts). A photo picked off this phone has no
// hash, since nothing has encoded it yet, so a sent row writes no --blur and
// this grey is exactly what it still wears. That is why the face below is
// checked as a colour underneath an image layer rather than as a bare
// background: the layer is what a hash fills in, and the colour is what stands
// when there is none.

describe("the sent row carries the placeholder until the pixels are there", () => {
  it("the element wears the mark from the frame it is made, before any wait", () => {
    const prepare = fnBody("prepareShot");
    const mark = prepare.indexOf("img.classList.add(WAIT_CLASS)");
    const wait = prepare.indexOf("whenDrawn(img");
    expect(mark).toBeGreaterThan(-1);
    expect(mark).toBeLessThan(wait); // on before anything can settle: no bare frame exists
    expect(WAIT_CLASS).toBe("waiting"); // photolazy.ts's own class, not a second one
    expect(src).toContain('import { WAIT_CLASS, createPhotoQueue, nearMargin } from "./photolazy"');
  });

  it("the mark comes off when the pixels land, wherever the element is standing", () => {
    const prepare = fnBody("prepareShot");
    const drawn = prepare.indexOf("whenDrawn(img, DRAW_NO_DEADLINE).then");
    const clear = prepare.indexOf("img.classList.remove(WAIT_CLASS)");
    expect(drawn).toBeGreaterThan(-1);
    expect(drawn).toBeLessThan(clear);
    // NOT gated on the photo still being in the tray: a bubble built before the
    // pixels arrived is the whole case this exists for
    expect(prepare).not.toContain("picks.get(file)");
  });

  it("the stylesheet paints it inside a sent row exactly as inside a history one", () => {
    expect(css).toMatch(/\.msg\.shot:has\(img\.waiting\)::before \{[^}]*background-color: var\(--received\)/);
    expect(css).toMatch(/\.msg\.shot:has\(img\.waiting\)::after \{[^}]*animation: oldspin/);
    // a sent photo has no blurhash to paint, so the image layer resolves to
    // none and the grey below it is the whole face, exactly as before
    expect(css).toMatch(/\.msg\.shot:has\(img\.waiting\)::before \{[^}]*background-image: var\(--blur, none\)/);
    // the same two layers the tray's own square has always worn
    expect(css).toMatch(/\.pthumb\.undrawn::before \{[^}]*background: var\(--received\)/);
    expect(css).toMatch(/\.pthumb\.undrawn::after \{[^}]*animation: oldspin/);
  });

  it("it costs the seat nothing: pseudo-elements over a box the photo already sized", () => {
    expect(css).toMatch(/\.msg\.shot:has\(img\.waiting\) \{ position: relative; \}/);
    // the reserved box is still the only thing sizing the row
    expect(fnBody("send")).toContain("photoBox(nat[0], nat[1], rowW)");
    expect(css).not.toMatch(/\.msg\.shot:has\(img\.waiting\)::before \{[^}]*height: \d/);
  });

  it("a mark that says coming cannot be read as the photo itself", () => {
    // a ring that turns, over a face in the thread's own not-mine grey: the two
    // marks a bare box could never make
    expect(css).toMatch(/@keyframes oldspin \{ to \{ transform: rotate\(360deg\); \} \}/);
    expect(css).toMatch(/--received: #e9e9eb;/);
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
    const wait = stage().indexOf("shot.drawn.then");
    expect(seat).toBeGreaterThan(-1);
    expect(wait).toBeGreaterThan(-1);
    expect(seat).toBeLessThan(wait);
    // and nothing in the stylesheet takes that seat away again while it waits
    expect(css).not.toMatch(/\.pthumb\.undrawn\s*\{\s*display:\s*none/);
  });

  it("the tray opens on the files it holds, never on their pixels", () => {
    expect(fnBody("showPending")).toContain("const open = pendingFiles.length > 0");
    expect(fnBody("showPending")).toContain('open ? "flex" : "none"');
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

  it("nothing anywhere carries a deadline: no timer ever uncovers an empty box", () => {
    expect(src).toContain("DRAW_NO_DEADLINE");
    // one wait, and it is the patient kind (photobox.ts: neither the tray nor
    // the send holds a frame back any more, so neither needs to give up)
    expect(src.match(/whenDrawn\([^)]*\)/g)).toEqual(["whenDrawn(img, DRAW_NO_DEADLINE)"]);
  });

  it("the reveal waits for the full pixels, and the slide for whichever came first", () => {
    // the reveal is still the FULL decode's alone: taking .undrawn off is what
    // uncovers the one drawn element, and the send morph reads that same flag
    const wait = stage().indexOf("shot.drawn.then");
    const reveal = stage().indexOf('wrap.classList.remove("undrawn")');
    expect(wait).toBeGreaterThan(-1);
    expect(wait).toBeLessThan(reveal);
    // the entrance belongs to the first picture the square gets, and plays once
    expect(stage()).toContain("let filled = false");
    expect(stage().slice(reveal)).toContain("if (!filled) {");
    expect(stage().match(/wrap\.animate\(thumbSlide\(\)/g)).toHaveLength(2);
    expect(stage()).toContain("{ duration: FLIGHT_MS, easing: FLIGHT_EASE }"); // the app's own beat
  });

  it("the pick-show record survives, still carrying how long the square waited", () => {
    expect(stage()).toContain('phase: "pick-show"');
    expect(stage()).toContain("ms: Math.round(performance.now() - staged)");
  });

  it("the pixels' own clock rides shot-dims, whichever box they land in", () => {
    // pick-show is gated on the square still being in the tray, so a photo the
    // send outran would otherwise report nothing at all — the very case the
    // shared decode makes ordinary
    const prepare = fnBody("prepareShot");
    expect(prepare).toContain('phase: "shot-dims"');
    expect(prepare).toContain("ms: Math.round(performance.now() - started)");
    expect(prepare).toContain('seat: img.closest(".msg") ? "thread" : "tray"');
  });

  it("a photo that never decodes still sends AND still previews", () => {
    // sends: nothing is waited on, and the row wears the placeholder meanwhile
    expect(fnBody("send")).not.toContain("await Promise.all");
    expect(fnBody("prepareShot")).toContain("img.classList.add(WAIT_CLASS)");
    expect(fnBody("send")).toContain("img.onload"); // and re-pins if a size lands later
    // previews: the seat, its placeholder and the removal ✕ are all on screen
    // from the tap, none of them behind the wait
    const stageBody = stage();
    const wait = stageBody.indexOf("shot.drawn.then");
    expect(stageBody.indexOf("wrap.append(img, x)")).toBeLessThan(wait);
    expect(stageBody.indexOf("box.appendChild(wrap)")).toBeLessThan(wait);
    expect(stageBody).toContain('x.className = "pthumb-x"');
  });
});

// --- the small version, first -------------------------------------------------
// The square is 64px and it was waiting for twelve megapixels. On device the
// whole wait was 2.8 to 3.6 seconds, of which the app's own work was 29 to 103
// milliseconds and the rest was the decode. A small version is asked for beside
// the full one now, and the square wears that until the real pixels land.

describe("smallShotUrl: a picture for the square, without the full decode", () => {
  const FILE = new Blob([new Uint8Array(8)], { type: "image/jpeg" });

  const shot = (width: number, height: number) => {
    const closed = { count: 0 };
    return {
      shot: { width, height, close: (): void => void closed.count++ },
      closed,
    };
  };

  const host = (
    bitmap: (blob: Blob, edge: number) => Promise<SmallShot>,
    paint: (s: SmallShot) => string | null = () => "data:image/jpeg;base64,AA",
  ): SmallDrawHost => ({ bitmap, paint });

  it("hands back what the surface painted, so the square has a picture to wear", async () => {
    const url = await smallShotUrl(
      FILE,
      host(async () => shot(256, 192).shot, () => "data:image/jpeg;base64,ZZ"),
    );
    expect(url).toBe("data:image/jpeg;base64,ZZ");
  });

  it("asks the engine for a width, which is the whole point of the route", async () => {
    let asked = -1;
    await smallShotUrl(FILE, host(async (_b, edge) => {
      asked = edge;
      return shot(edge, 100).shot;
    }));
    expect(asked).toBe(SMALL_SHOT_PX);
  });

  it("the width asked for is bigger than the square, so a 3x screen stays sharp", () => {
    expect(SMALL_SHOT_PX).toBeGreaterThanOrEqual(64 * 3);
    // and still a fraction of a camera photo: this is a preview, not a copy
    expect(SMALL_SHOT_PX).toBeLessThanOrEqual(512);
  });

  it("never waits on the full decode: nothing here touches the img or its promise", async () => {
    // the only thing awaited is the engine's own small read of the FILE
    let handedTheFile = false;
    await smallShotUrl(FILE, host(async (blob) => {
      handedTheFile = blob === FILE;
      return shot(256, 192).shot;
    }));
    expect(handedTheFile).toBe(true);
    // and the module the square's wait lives in is not consulted at all
    const body = readFileSync(join(here, "../src/photobox.ts"), "utf8");
    const fn = body.slice(body.indexOf("export async function smallShotUrl"));
    expect(fn.slice(0, fn.indexOf("\n}"))).not.toContain("whenDrawn");
  });

  it("hands the pixels back afterwards, painted or not", async () => {
    const made = shot(256, 192);
    await smallShotUrl(FILE, host(async () => made.shot));
    expect(made.closed.count).toBe(1);
    const refused = shot(256, 192);
    await smallShotUrl(FILE, host(async () => refused.shot, () => null));
    expect(refused.closed.count).toBe(1);
  });

  it("an engine with no such call at all simply makes nothing", async () => {
    expect(await smallShotUrl(FILE, null)).toBeNull();
  });

  it("a refusal is quiet: the full decode still owns the square", async () => {
    const rejected = await smallShotUrl(FILE, host(() => Promise.reject(new Error("no"))));
    expect(rejected).toBeNull();
    const threw = await smallShotUrl(FILE, host(async () => shot(256, 192).shot, () => {
      throw new Error("no surface");
    }));
    expect(threw).toBeNull();
  });

  it("an empty url counts as nothing, never as a picture", async () => {
    expect(await smallShotUrl(FILE, host(async () => shot(256, 192).shot, () => ""))).toBeNull();
  });
});

describe("resizeHonoured: catching an engine that read the whole picture anyway", () => {
  it("a picture no wider than the width asked for was resized on the way", () => {
    expect(resizeHonoured({ width: 256, height: 192 }, 256)).toBe(true);
    expect(resizeHonoured({ width: 120, height: 90 }, 256)).toBe(true); // already small
  });

  it("a picture wider than that means the resize was ignored", () => {
    // twelve megapixels handed back whole: two full decodes racing, which is the
    // exact failure the one-element rule was written to end
    expect(resizeHonoured({ width: 4032, height: 3024 }, 256)).toBe(false);
  });
});

describe("the small version's wiring in main.ts", () => {
  const stage = (): string => fnBody("stagePick");

  it("is asked for before the full-size element exists, so it is not queued behind it", () => {
    const small = stage().indexOf("const small = smallShotUrl(file, smallDrawHost())");
    const prepare = stage().indexOf("const shot = prepareShot(url)");
    expect(small).toBeGreaterThan(-1);
    expect(small).toBeLessThan(prepare);
  });

  it("the square is filled from it without joining the full decode's wait", () => {
    const body = stage();
    const join = body.indexOf("void small.then(");
    const wait = body.indexOf("void shot.drawn.then(");
    expect(join).toBeGreaterThan(-1);
    expect(join).toBeLessThan(wait); // and it is not nested inside it
    const branch = body.slice(join, wait);
    expect(branch).toContain('wrap.style.backgroundImage = `url("${picture}")`');
    expect(branch).toContain('wrap.classList.add("preview")');
    expect(branch).not.toContain("shot.drawn");
    expect(branch).not.toContain("whenDrawn");
  });

  it("it paints the square's BACKGROUND, never the one element the send carries", () => {
    const body = stage();
    const branch = body.slice(body.indexOf("void small.then("), body.indexOf("void shot.drawn"));
    // the img keeps its full-size blob url and its own natural size
    expect(branch).not.toContain("img.src");
    expect(branch).not.toContain("img.width");
    expect(body).toContain("const shot = prepareShot(url)"); // still the one full decode
    expect(src.match(/whenDrawn\([^)]*\)/g)).toEqual(["whenDrawn(img, DRAW_NO_DEADLINE)"]);
  });

  it("the send morph still stands down on a photo whose true shape is unknown", () => {
    // .undrawn is the morph's own gate and it comes off on the FULL pixels, so a
    // square wearing only the small version cannot let the morph fly
    const arm = fnBody("armShotMorph");
    expect(arm).toContain('if (pick.wrap.classList.contains("undrawn")) return stand("undrawn")');
    expect(arm).toContain("const nat = naturalSize(pick.img)");
    expect(arm).toContain('if (!nat) return stand("nodims")');
    // and nothing in the small branch touches that gate
    const body = stage();
    const branch = body.slice(body.indexOf("void small.then("), body.indexOf("void shot.drawn"));
    expect(branch).not.toContain("undrawn");
    // the flag really is only ever cleared by the full decode
    expect(src.match(/classList\.remove\("undrawn"\)/g)).toHaveLength(1);
    const drawn = body.slice(body.indexOf("void shot.drawn"));
    expect(drawn).toContain('wrap.classList.remove("undrawn")');
  });

  it("the morph flies the full-size element's pixels, never the small version's", () => {
    expect(fnBody("armShotMorph")).toContain("copy.src = pick.img.src");
  });

  it("nothing waits on a clock: the small version lands when it lands", () => {
    expect(fnBody("smallDrawHost")).not.toContain("setTimeout");
    const body = stage();
    expect(body.slice(body.indexOf("void small.then("))).not.toContain("setTimeout");
  });

  it("an engine that ignored the width is not asked again, and is never painted", () => {
    const host = fnBody("smallDrawHost");
    expect(host).toContain('if (smallDrawOff || typeof createImageBitmap !== "function") return null');
    expect(host).toContain("resizeWidth: edge");
    // and the small read honours the file's own rotation, or the square would
    // wear a sideways picture and snap upright when the real pixels landed
    expect(host).toContain('imageOrientation: "from-image"');
    // the size is checked BEFORE anything is drawn, so a full-size picture never
    // reaches this thread's canvas
    const paint = host.slice(host.indexOf("paint:"));
    expect(paint.indexOf("resizeHonoured")).toBeLessThan(paint.indexOf("document.createElement"));
    expect(paint).toContain("smallDrawOff = true");
  });

  it("the square's own clock says when the seat stopped being empty", () => {
    const body = stage();
    const branch = body.slice(body.indexOf("void small.then("), body.indexOf("void shot.drawn"));
    expect(branch).toContain('phase: "pick-preview"');
    expect(branch).toContain("ms: Math.round(performance.now() - staged)");
  });

  it("the stylesheet puts the picture on the seat and takes the spinner off it", () => {
    expect(css).toMatch(/\.pthumb\.preview \{[^}]*background-size: cover;/);
    expect(css).toMatch(/\.pthumb\.preview::before,\s*\n\.pthumb\.preview::after \{ content: none; \}/);
    // it must stand AFTER .undrawn or it loses the tie and the ring stays on
    expect(css.indexOf(".pthumb.undrawn::after")).toBeLessThan(css.indexOf(".pthumb.preview"));
    // and it must not disturb the seat: the 64px box still comes from the img
    expect(css).not.toMatch(/\.pthumb\.preview \{[^}]*\bwidth:/);
  });

  it("a square wearing only the small version is dropped without a wait, like any other", () => {
    // the ✕ path reads the staging list, never the pixels
    expect(fnBody("dismissPick")).not.toContain("drawn");
    expect(fnBody("dismissPick")).not.toContain("preview");
  });
});

// --- the picked photo's exit --------------------------------------------------

describe("thumbDrop: the dismissed square shrinks and fades where it stands", () => {
  it("starts at rest and ends invisible", () => {
    const [from, to] = thumbDrop();
    expect(from.opacity).toBe(1);
    expect(from.transform).toBe("none");
    expect(to.opacity).toBe(0);
  });

  it("shrinks, and only a little: a square sucked to nothing would be a new snap", () => {
    const [, to] = thumbDrop();
    expect(to.transform).toBe(`scale(${THUMB_DROP_SCALE})`);
    expect(THUMB_DROP_SCALE).toBeLessThan(1);
    expect(THUMB_DROP_SCALE).toBeGreaterThanOrEqual(0.7);
  });

  it("is the entrance answered in kind: a fade and a transform, nothing else", () => {
    for (const f of thumbDrop()) {
      expect(Object.keys(f).sort()).toEqual(["opacity", "transform"]);
    }
    // and it ends where the entrance begins, invisible, so the pair reads as one idea
    expect(thumbDrop()[1].opacity).toBe(thumbSlide()[0].opacity);
  });
});

describe("trayClose: the strip eases its own height down instead of switching off", () => {
  const OPEN_H = 70.4; // a one-line strip: the 64px square plus its 0.4rem top padding
  const PAD = 6.4;

  it("travels from the height it was measured at to nothing", () => {
    const [from, to] = trayClose(OPEN_H, PAD);
    expect(from.height).toBe("70.4px");
    expect(to.height).toBe("0px");
  });

  it("takes the top padding with it, or the last 6px snap after the rest has eased", () => {
    // everything here is border-box, so height:0 alone still leaves the strip
    // its padding tall — a small snap at the end of a smooth close
    expect(css).toMatch(/\* \{ box-sizing: border-box; \}/);
    const [from, to] = trayClose(OPEN_H, PAD);
    expect(from.paddingTop).toBe("6.4px");
    expect(to.paddingTop).toBe("0px");
  });

  it("is measured, never assumed: a wrapped two-line strip closes from its own height", () => {
    expect(trayClose(OPEN_H * 2, PAD)[0].height).toBe("140.8px");
    expect(css).toMatch(/\.pending \{[^}]*flex-wrap: wrap;/); // why a constant could not be right
  });

  it("moves the box and nothing else: no fade standing in for the height", () => {
    for (const f of trayClose(OPEN_H, PAD)) {
      expect(Object.keys(f).sort()).toEqual(["height", "paddingTop"]);
    }
  });
});

// The ✕, before and after. It used to splice the file out and call renderPending,
// which deleted the thumbnail and switched the strip off inside the same frame:
// "the element that holds the photo does disappear but it is sudden".
describe("cancel wiring: the square drops while the strip eases down under it", () => {
  const dismiss = (): string => fnBody("dismissPick");

  it("the tap decides everything; only the teardown waits for the motion", () => {
    const stage = fnBody("stagePick");
    const splice = stage.indexOf("pendingFiles.splice(at, 1)");
    const refresh = stage.indexOf("refreshSend()");
    const hand = stage.indexOf("dismissPick(file, pick)");
    expect(splice).toBeGreaterThan(-1);
    expect(splice).toBeLessThan(refresh);
    expect(refresh).toBeLessThan(hand);
    // a send fired mid-close cannot pick the dismissed photo back up
    expect(stage.slice(splice, hand)).not.toContain("renderPending()");
  });

  it("both halves ride ONE beat, and it is the app's own", () => {
    expect(dismiss()).toContain("duration: FLIGHT_MS");
    expect(dismiss()).toContain("easing: FLIGHT_EASE");
    // one options object for both, so the square and the strip cannot drift apart
    expect(dismiss().match(/duration: FLIGHT_MS/g)).toHaveLength(1);
    expect(dismiss()).toContain("pick.wrap.animate(thumbDrop(), beat)");
    expect(dismiss()).toContain("box.animate(trayClose(box.offsetHeight, padTop), beat)");
  });

  it("the strip's height is measured off the strip, padding included", () => {
    expect(dismiss()).toContain("box.offsetHeight");
    expect(dismiss()).toContain("parseFloat(getComputedStyle(box).paddingTop)");
  });

  it("the strip closes only when the square leaving is the last one in it", () => {
    expect(dismiss()).toContain("pendingFiles.length === 0");
  });

  it("the box is switched off only once its height has actually gone", () => {
    const body = dismiss();
    const teardown = body.indexOf("pick.wrap.remove()");
    const hide = body.indexOf("showPending()");
    expect(teardown).toBeGreaterThan(-1);
    expect(teardown).toBeLessThan(hide);
    // hung off the drop finishing, not off the tap
    expect(body).toContain('drop.addEventListener("finish", gone)');
    expect(body).toContain('drop.addEventListener("cancel", gone)');
    expect(body).toContain('fill: "forwards"'); // nothing springs back between the two
  });

  it("the square leaves the ledger on the tap, so nothing else can claim it", () => {
    const body = dismiss();
    const forget = body.indexOf("picks.delete(file)");
    expect(forget).toBeGreaterThan(-1);
    expect(forget).toBeLessThan(body.indexOf("animate(")); // before either motion starts
    // renderPending's prune can no longer reach a square that is already leaving
    expect(fnBody("renderPending")).toContain("if (pendingFiles.includes(file)) continue");
    // and the drawing wait reads the same absence and drops its reveal
    expect(fnBody("stagePick")).toContain("if (picks.get(file) !== pick) return");
  });

  it("a pick landing mid-close calls the close off rather than fighting it", () => {
    const show = fnBody("showPending");
    expect(show).toContain("trayClosing?.cancel()");
    expect(show).toContain('box.classList.remove("closing")');
  });

  it("the shrinking square is clipped only while the strip is moving", () => {
    expect(css).toMatch(/\.pending\.closing \{ overflow: hidden; \}/);
    // at rest the ✕ hangs outside its square, so a permanent clip would shave it
    expect(css).toMatch(/\.pthumb-x \{[^}]*top: -6px;/);
    expect(css).not.toMatch(/\.pending \{[^}]*overflow: hidden/);
  });

  it("the thread re-pins itself frame by frame; nothing here writes a scroll", () => {
    // the thread BOX resizing is the signal, and threadObserver already answers
    // it; a hand-written pin in here would be a second opinion on the same
    // frames, which is what a jump is made of
    expect(dismiss()).not.toContain("scrollToBottom");
    expect(src).toContain("if (followTail) scrollToBottom(true);");
  });
});

// The send's own close. It used to be renderPending's prune: thumbnail gone
// and strip switched off inside the tap's frame, so the photo vanished an
// instant before its strip and an emptied strip sat over the compose bar for
// a beat. The send closes like the ✕ now (same two motions, same one beat),
// with two send-only differences, each pinned below: the strip leaves the
// LAYOUT on the tap so its easing height cannot resize the thread under the
// flight, and the squares keep painting their photo after the send takes the
// img element into the bubble.
describe("send teardown: the strip closes on the beat with its squares aboard", () => {
  const dismiss = (): string => fnBody("dismissSent");

  it("the send routes the tray through dismissSent, never the instant prune", () => {
    const send = fnBody("send");
    expect(send).toContain("dismissSent()");
    expect(send).not.toContain("renderPending()");
    // and the plain teardown survives for a send with nothing staged
    expect(dismiss()).toContain("renderPending()");
  });

  it("both halves ride the one beat, and it is the app's own", () => {
    const body = dismiss();
    expect(body).toContain("duration: FLIGHT_MS");
    expect(body).toContain("easing: FLIGHT_EASE");
    // one options object for both, so the squares and the strip cannot drift apart
    expect(body.match(/duration: FLIGHT_MS/g)).toHaveLength(1);
    expect(body).toContain("box.animate(trayClose(rect.height, padTop), beat)");
    expect(body).toContain("pick.wrap.animate(thumbDrop(), beat)");
    expect(body).toContain('fill: "forwards"');
  });

  it("the strip leaves the flex column on the tap, so the close resizes nothing", () => {
    // an in-flow height animation resizes the thread every frame, and the
    // threadObserver re-pin then lands on a scrollHeight the flight's
    // translate has inflated: the exact mid-flight drag send()'s two-rAF wait
    // exists to prevent. Fixed at its own rect, the strip hands the thread its
    // room in one hop with the old display:none timing, and the close is pure
    // paint over a thread that never resizes under the flight.
    const body = dismiss();
    const fix = body.indexOf('box.style.position = "fixed"');
    const anim = body.indexOf("box.animate(");
    expect(fix).toBeGreaterThan(-1);
    expect(fix).toBeLessThan(anim);
    // bottom-anchored, so the top edge glides down the way the in-flow close
    // moves — against the lift wrapper's box, which is a fixed descendant's
    // containing block because the wrapper carries a transform (styles.css
    // .lift), never against the viewport
    expect(body).toContain('const home = (box.closest(".lift") ?? app).getBoundingClientRect()');
    expect(body).toContain("home.bottom - rect.bottom");
    expect(body).toContain("rect.left - home.left");
    expect(body).not.toContain("window.innerHeight");
  });

  it("the squares leave the ledger on the tap, and the teardown owns them", () => {
    const body = dismiss();
    const forget = body.indexOf("picks.clear()");
    expect(forget).toBeGreaterThan(-1);
    expect(forget).toBeLessThan(body.indexOf("animate(")); // before either motion starts
    expect(body).toContain('drop.addEventListener("finish", gone)');
    expect(body).toContain('drop.addEventListener("cancel", gone)');
  });

  it("a drawn square keeps its photo; a waiting one keeps its mark", () => {
    // the img is the one drawn element and the send takes it (takeShot), so
    // the square paints the same blob as its own background for the close; a
    // square still under .undrawn keeps the grey face and ring instead, and
    // never asks the engine to paint pixels that do not exist yet
    const body = dismiss();
    expect(body).toContain('classList.contains("undrawn")');
    expect(body).toContain("pick.wrap.style.backgroundImage");
    expect(body).toContain("pick.img.src");
    expect(body).toContain('pick.wrap.classList.add("sent")');
  });

  it("the sent square is its own 64px box: the img left, the seat must not", () => {
    expect(css).toMatch(/\.pthumb\.sent \{[^}]*\bwidth: 64px;[^}]*\bheight: 64px;/);
    expect(css).toMatch(/\.pthumb\.sent \{[^}]*background-size: cover;/);
    expect(css).toMatch(/\.pthumb\.sent \{[^}]*border-radius: 12px;/);
  });

  it("the box is switched off only once its height has actually gone", () => {
    const body = dismiss();
    const anim = body.indexOf("box.animate(");
    const hide = body.indexOf("showPending()");
    expect(anim).toBeGreaterThan(-1);
    expect(anim).toBeLessThan(hide);
    expect(body).toContain('closing.addEventListener("finish", done)');
    expect(body).toContain('closing.addEventListener("cancel", done)');
  });

  it("no url is revoked here: takeShot blanked them and the thread reads them", () => {
    expect(dismiss()).not.toContain("revokeObjectURL");
  });

  it("a reopen mid-close puts the strip back in the flow, not just back on", () => {
    const show = fnBody("showPending");
    const unfix = show.indexOf('box.removeAttribute("style")');
    const display = show.indexOf("box.style.display = open");
    expect(unfix).toBeGreaterThan(-1);
    expect(unfix).toBeLessThan(display);
  });

  it("adds no wait to the send: the close is armed and left behind", () => {
    expect(dismiss()).not.toMatch(/\bawait\b/);
  });
});

// The send freeze. Seating a still-decoding img in the thread let WebKit
// decode it synchronously at the next paint, and a 12MP camera photo held the
// main thread 220-240ms in the middle of the flight: the attach doing pixel
// work, not the network. decoding="async" takes that work off the paint; the
// reserved seat and the waiting mark already cover the box until whenDrawn
// settles, so nothing visible changes except that the freeze is gone.
describe("the attach never blocks on undecoded pixels", () => {
  it("the one picked-photo element is marked for async decode at birth", () => {
    const prepare = fnBody("prepareShot");
    const mark = prepare.indexOf('img.decoding = "async"');
    const source = prepare.indexOf("img.src = url");
    expect(mark).toBeGreaterThan(-1);
    expect(mark).toBeLessThan(source); // marked before any bytes can arrive
  });

  it("the seat and the placeholder still stand while the pixels cook", () => {
    // the pair is what makes the async decode invisible: the bubble is full
    // size from the insert and plainly says a photo is coming
    expect(fnBody("send")).toContain("photoBox(nat[0], nat[1], rowW)");
    expect(fnBody("prepareShot")).toContain("img.classList.add(WAIT_CLASS)");
  });
});

// The gap a cancelled square leaves. The fault it replaces was two halves of
// one thing: a square that only faded kept its whole seat, so the row held a
// hole with nothing moving in it for the rest of the beat, and the neighbours
// then arrived in a single frame when the teardown finally removed it.
describe("closing the gap a cancelled square leaves", () => {
  it("parks the leaving square exactly where it was standing, in the strip's own frame", () => {
    // a square at 100,700 on screen, in a strip whose corner is at 12,690
    const park = thumbPark(
      { left: 100, top: 700, width: 64, height: 64 },
      { left: 12, top: 690 },
    );
    expect(park).toEqual({ left: 88, top: 10, width: 64, height: 64 });
  });

  it("pairs each survivor's old place against its new one", () => {
    const before = [{ left: 12, top: 10 }, { left: 84, top: 10 }, { left: 156, top: 10 }];
    const after = [{ left: 12, top: 10 }, { left: 84, top: 10 }, { left: 84, top: 10 }];
    expect(thumbMoves(before, after)).toEqual([
      { dx: 0, dy: 0 },
      { dx: 0, dy: 0 },
      { dx: 72, dy: 0 },
    ]);
  });

  it("a square pulled up onto the line above carries both directions", () => {
    // the strip wraps, so losing one square can lift another a whole row
    const moves = thumbMoves([{ left: 12, top: 82 }], [{ left: 156, top: 10 }]);
    expect(moves).toEqual([{ dx: -144, dy: 72 }]);
  });

  it("everything left of the gap has not moved, and is not animated", () => {
    expect(THUMB_MOVE_MIN_PX).toBe(0.5);
    expect(thumbMoved({ dx: 0, dy: 0 })).toBe(false);
    expect(thumbMoved({ dx: 0.4, dy: -0.4 })).toBe(false); // sub-pixel rounding is not a move
    expect(thumbMoved({ dx: 72, dy: 0 })).toBe(true);
    expect(thumbMoved({ dx: 0, dy: -72 })).toBe(true);
  });

  it("starts each survivor where it was standing and releases it to its own place", () => {
    expect(thumbShift({ dx: 72, dy: 0 })).toEqual([
      { transform: "translate(72px, 0px)" },
      { transform: "none" },
    ]);
  });
});

describe("closeGap wiring: the seat goes back on the tap, not at the end", () => {
  const gap = (): string => fnBody("closeGap");

  it("the leaving square is taken out of the flow BEFORE the strip is re-read", () => {
    // parking against a strip rect read before the reflow would drop the
    // picture a whole line at the instant it is still fully opaque
    const body = gap();
    const leaves = body.indexOf('wrap.classList.add("leaving")');
    const strip = body.indexOf("box.getBoundingClientRect()");
    expect(leaves).toBeGreaterThan(-1);
    expect(strip).toBeGreaterThan(leaves);
  });

  it("reads the survivors before it, and again after it, in that order", () => {
    const body = gap();
    const before = body.indexOf("const before = others.map(seat)");
    const leaves = body.indexOf('wrap.classList.add("leaving")');
    const after = body.indexOf("const after = others.map(seat)");
    expect(before).toBeGreaterThan(-1);
    expect(before).toBeLessThan(leaves);
    expect(after).toBeGreaterThan(leaves);
  });

  it("takes any slide still running off first, so translates cannot stack", () => {
    const body = gap();
    const cancel = body.indexOf("slide.cancel()");
    const before = body.indexOf("const before = others.map(seat)");
    expect(cancel).toBeGreaterThan(-1);
    expect(cancel).toBeLessThan(before);
  });

  it("rides the same beat the leaving square does, and animates only what moved", () => {
    const body = gap();
    expect(body).toContain("if (!thumbMoved(move)) return");
    expect(body).toContain("others[i].animate(thumbShift(move), beat)");
  });

  it("only runs while other squares are staged; the last one still closes the strip", () => {
    const dismiss = fnBody("dismissPick");
    expect(dismiss).toContain("const last = pendingFiles.length === 0;");
    expect(dismiss).toContain("if (box && !last) closeGap(box, pick.wrap, beat);");
    expect(dismiss).toContain("if (box && last) {"); // the strip's own height, unchanged
    // and the settle that used to hop the conversation stays gone
    expect(dismiss).not.toContain('settleTail("drawer-close")');
  });

  it("the parked square is out of the flow and deaf to taps", () => {
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../src/styles.css"),
      "utf8",
    );
    const leaving = /\.pthumb\.leaving\s*{([^}]*)}/.exec(css)?.[1] ?? "";
    expect(leaving).toMatch(/position:\s*absolute/);
    expect(leaving).toMatch(/pointer-events:\s*none/);
    // the frame it is parked in: without this the square would be placed
    // against the page rather than against the strip
    const pending = /\.pending\s*{([^}]*)}/.exec(css)?.[1] ?? "";
    expect(pending).toMatch(/position:\s*relative/);
  });
});
