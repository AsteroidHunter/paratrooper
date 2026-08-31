// Photo boxes that stop changing shape, and the one change that is left paying
// its own way.
//
// The failure: scrolling back through photo history moved the whole screen as
// pictures loaded. The thread is an inner scroller and iOS Safari anchors
// nothing inside one, so a box ABOVE the reader's top edge finishing its decode
// and growing pushes every row under it down by that much, and the message he
// is reading walks off where he left it. A frame timer sees none of this: the
// main thread is idle and the frame rate is steady, which is exactly what the
// jank recorder found when it went looking.
//
// So the box is decided once per render, and the single deliberate reshape left
// (a photo that had to guess, meeting its own pixels) hands the scroll back
// exactly what it costs, in the same frame, but only when the change happened
// above what the reader can see. A change he is looking at, or one below him,
// is left alone: correcting that one would BE the jump.
//
// The decisions are pure (src/photofit.ts) and pinned directly below. main.ts
// boots a real shell at import time and cannot load under node, so its wiring
// is held by source pins, the way flight.test.ts, photobox.test.ts and
// tailsettle.test.ts hold theirs.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import {
  FOLD_SLOP_PX,
  GUESS_H,
  GUESS_RATIO,
  GUESS_W,
  STRIP_SLOP_PX,
  learnDims,
  scrollFix,
  servedShape,
  strippedBox,
} from "../src/photofit";
import type { Dims } from "../src/photofit";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/main.ts"), "utf8");
const css = readFileSync(join(here, "../src/styles.css"), "utf8");

function fnBody(name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("\n}", start);
  return src.slice(start, end);
}

// ---------------------------------------------------------------------------
// A thread made of numbers, in the two coordinate spaces the real one uses.
//
// The reader's top edge (`fold`) and a row's rect are viewport pixels, which is
// what getBoundingClientRect hands main.ts. A message's place in the
// conversation is a content coordinate, which is what moves when a box above it
// changes height. onScreen() is the one bridge between them, and it is the
// whole question this file exists to answer: does the thing he is looking at
// stay where it is.
const THREAD_TOP = 60; // the thread's own top edge, under the header

const onScreen = (contentY: number, scrollTop: number): number =>
  THREAD_TOP + contentY - scrollTop;

interface Row {
  top: number; // viewport coordinates, before the change
  height: number;
}

interface Scroller {
  top: number;
  scrollTop: number;
}

// main.ts's keepView, over numbers: the same three reads, the same single
// write, in the same order. A growing box grows DOWNWARD, so the row's top does
// not move and only its height changes. The pins at the bottom of this file
// hold the real one to this shape.
function keepView(t: Scroller, row: Row, following: boolean, change: () => void): number {
  const fold = t.top;
  const before = { bottom: row.top + row.height, height: row.height };
  change();
  const fix = scrollFix(before.bottom, fold, row.height - before.height, following);
  if (fix === 0) return 0;
  t.scrollTop += fix;
  return fix;
}

// his case, with real shapes. A photo the frame carried no size for stands in
// the guessed landscape box; the pixels turn out to be a portrait phone photo.
const GUESSED_H = (GUESS_W * GUESS_H) / GUESS_W; // the box as laid out: 180 tall
const TRUE_H = 320; // 240 wide and portrait, which is what his camera sends
const GROWTH = TRUE_H - GUESSED_H;

describe("scrollFix: what a resize above the reader costs, and who pays it", () => {
  it("hands back exactly the height a box above the fold gained", () => {
    expect(scrollFix(-1020, THREAD_TOP, GROWTH, false)).toBe(GROWTH);
  });

  it("hands back exactly the height a box above the fold LOST, sign and all", () => {
    expect(scrollFix(-1020, THREAD_TOP, -GROWTH, false)).toBe(-GROWTH);
  });

  it("writes nothing for a box below the fold: it disturbs nothing on screen", () => {
    expect(scrollFix(580, THREAD_TOP, GROWTH, false)).toBe(0);
  });

  it("writes nothing for a box straddling the fold: the growth is all below it", () => {
    // top edge above the reader, bottom edge below: an image grows downward, so
    // every pixel it gains lands under his top edge and nothing above it moved
    expect(scrollFix(THREAD_TOP + 200, THREAD_TOP, GROWTH, false)).toBe(0);
  });

  it("counts a box ending exactly on the fold as above it", () => {
    expect(scrollFix(THREAD_TOP, THREAD_TOP, GROWTH, false)).toBe(GROWTH);
  });

  it("counts a box ending a fraction of a pixel inside the view as above it", () => {
    // a sliver nobody can see is still enough to send every row below it
    // walking, which is the entire failure
    expect(scrollFix(THREAD_TOP + FOLD_SLOP_PX, THREAD_TOP, GROWTH, false)).toBe(GROWTH);
    expect(scrollFix(THREAD_TOP + FOLD_SLOP_PX + 0.5, THREAD_TOP, GROWTH, false)).toBe(0);
  });

  it("writes nothing when nothing changed shape", () => {
    expect(scrollFix(-1020, THREAD_TOP, 0, false)).toBe(0);
  });

  it("writes nothing while the view is following the end of the conversation", () => {
    // the tail settle already puts the scroll on the fresh end of the range on
    // every geometry change; a second correction here would be counted twice
    expect(scrollFix(-1020, THREAD_TOP, GROWTH, true)).toBe(0);
  });

  it("writes nothing off an unmeasurable rect", () => {
    expect(scrollFix(NaN, THREAD_TOP, GROWTH, false)).toBe(0);
    expect(scrollFix(-1020, NaN, GROWTH, false)).toBe(0);
    expect(scrollFix(-1020, THREAD_TOP, NaN, false)).toBe(0);
  });
});

describe("a photo four screens back finishing its decode", () => {
  // the reader is up in the history with a message on screen he is reading
  const MARKER = 3000; // that message's place in the conversation
  const START = 2000; // where the scroll is

  it("moves the message he is reading by zero pixels", () => {
    const t: Scroller = { top: THREAD_TOP, scrollTop: START };
    const row: Row = { top: -1200, height: GUESSED_H }; // well above his top edge
    const was = onScreen(MARKER, t.scrollTop);

    const fix = keepView(t, row, false, () => {
      row.height = TRUE_H; // the guessed box takes the photo's own shape
    });

    // the photo grew, so everything under it, the marker included, sits that
    // much further down the conversation than it did
    expect(fix).toBe(GROWTH);
    expect(t.scrollTop).toBe(START + GROWTH);
    expect(onScreen(MARKER + GROWTH, t.scrollTop)).toBe(was);
  });

  it("is the jump itself when nothing compensates", () => {
    // the same frame with the correction taken out: this is what his phone did
    const uncorrected = onScreen(MARKER + GROWTH, START);
    expect(uncorrected - onScreen(MARKER, START)).toBe(GROWTH);
  });

  it("leaves the scroll alone when the photo is on screen below him", () => {
    const t: Scroller = { top: THREAD_TOP, scrollTop: START };
    const row: Row = { top: 400, height: GUESSED_H }; // in view, under his top edge
    const above = 1500; // a message above the photo, which cannot move at all
    const was = onScreen(above, t.scrollTop);

    const fix = keepView(t, row, false, () => {
      row.height = TRUE_H;
    });

    expect(fix).toBe(0);
    expect(t.scrollTop).toBe(START); // untouched: a write here WOULD be the jump
    expect(onScreen(above, t.scrollTop)).toBe(was);
  });

  it("leaves the scroll to the tail settle while the view follows the end", () => {
    const t: Scroller = { top: THREAD_TOP, scrollTop: START };
    const row: Row = { top: -1200, height: GUESSED_H };
    const fix = keepView(t, row, true, () => {
      row.height = TRUE_H;
    });
    expect(fix).toBe(0);
    expect(t.scrollTop).toBe(START);
  });

  it("hands back the height a failed photo takes with it", () => {
    // the box gives way to a one-line chip, which on old history is hundreds of
    // pixels leaving the thread in one frame
    const t: Scroller = { top: THREAD_TOP, scrollTop: START };
    const row: Row = { top: -1200, height: 400 };
    const fix = keepView(t, row, false, () => {
      row.height = 22; // the chip
    });
    expect(fix).toBe(-378);
    expect(t.scrollTop).toBe(START - 378);
  });
});

describe("learnDims: a size measured once is a size never guessed again", () => {
  const dims: Dims = [240, 320];

  it("fills the slot of a frame that carried no sizes at all", () => {
    expect(learnDims(undefined, 1, 0, dims)).toEqual([[240, 320]]);
  });

  it("fills only its own slot, index aligned with the attachments", () => {
    expect(learnDims(undefined, 3, 1, dims)).toEqual([null, [240, 320], null]);
  });

  it("fills a null slot: a photo with pixels in front of it knows better", () => {
    // null is the server saying it could not measure the preview, and until now
    // it meant this photo guessed its box on every render, forever
    expect(learnDims([null, null], 2, 0, dims)).toEqual([[240, 320], null]);
  });

  it("keeps every size the frame already had", () => {
    expect(learnDims([[10, 20], null], 2, 1, dims)).toEqual([[10, 20], [240, 320]]);
  });

  it("never overwrites a slot that already holds a size", () => {
    // that photo laid out from a real size and never guessed; its box is not
    // this file's business
    expect(learnDims([[10, 20]], 1, 0, dims)).toBeNull();
  });

  it("copies the size rather than storing the caller's array", () => {
    const live: Dims = [240, 320];
    const out = learnDims(undefined, 1, 0, live)!;
    live[0] = 1;
    expect(out[0]).toEqual([240, 320]);
  });

  it("refuses an index the frame has no attachment for", () => {
    expect(learnDims(undefined, 1, 1, dims)).toBeNull();
    expect(learnDims(undefined, 0, 0, dims)).toBeNull();
    expect(learnDims(undefined, 1, -1, dims)).toBeNull();
  });

  it("refuses a size that is not a size", () => {
    expect(learnDims(undefined, 1, 0, [0, 320])).toBeNull();
    expect(learnDims(undefined, 1, 0, [240, 0])).toBeNull();
    expect(learnDims(undefined, 1, 0, [-1, 320])).toBeNull();
  });
});

// TEMP DIAGNOSTIC (served-shape): remove with the photofit.ts section and the
// main.ts block these pin.
//
// The one assumption the whole file rests on, put where it can be checked. A
// photo laid out from the size its frame carries is supposed to be laid out at
// the shape its own pixels are, and the eyewitness account is of that branch
// standing photos up from landscape into portrait as they land. It could: the
// attributes resolve to `aspect-ratio: auto W/H`, which hands the box to the
// image's own ratio at load. So the question is only ever whether the bytes
// that arrive are the size the frame promised, and these are its four answers.
describe("servedShape: the picture that arrived against the size promised", () => {
  it("says nothing at all when the pixels are exactly what was promised", () => {
    // the expected answer, and the reason a quiet trail can be read as one:
    // a record per agreeing photo would be a whole history of noise saying yes
    expect(servedShape([3024, 4032], [3024, 4032])).toBeNull();
    expect(servedShape([1, 1], [1, 1])).toBeNull();
  });

  it("catches the transposition: told landscape, served the portrait picture", () => {
    // exactly what he describes — a wide box that stands up as the photo lands
    const off = servedShape([4032, 3024], [3024, 4032])!;
    expect(off.swap).toBe(1);
    expect(off.r).toBeCloseTo(1.778, 3); // 4:3 told over 3:4 served
  });

  it("reads a mismatch that is no transposition as a ratio, not a flag", () => {
    // a 4:3 frame served a 16:9 picture reshapes the box just as silently, and
    // the flag alone would call it agreement
    const off = servedShape([4032, 3024], [4032, 2268])!;
    expect(off.swap).toBe(0);
    expect(off.r).toBeCloseTo(0.75, 3);
  });

  it("counts the same shape at another size as a mismatch, and says so with 1", () => {
    // this one cannot reshape anything, and the pair of numbers says which it
    // is: a ratio of 1 with the sizes disagreeing is a scale, not a shape
    const off = servedShape([3024, 4032], [1512, 2016])!;
    expect(off.swap).toBe(0);
    expect(off.r).toBe(1);
  });

  it("says nothing about a pair it cannot compare", () => {
    // a picture that never decoded has no shape, so its box was never wrong
    expect(servedShape([3024, 4032], [0, 0])).toBeNull();
    expect(servedShape([0, 0], [3024, 4032])).toBeNull();
    expect(servedShape([3024, 4032], [Number.NaN, 4032])).toBeNull();
  });
});

// main.ts's own branch, as a value: which box a stored frame renders in
interface PhotoFrame {
  seq: number;
  attachments: string[];
  attachment_dims?: (Dims | null)[];
}

const seatOf = (f: PhotoFrame, i = 0): "known" | "guess" =>
  f.attachment_dims?.[i] ? "known" : "guess";

describe("the learned size reaches the next cold open", () => {
  async function freshCache() {
    globalThis.indexedDB = new IDBFactory();
    vi.resetModules();
    return import("../src/threadcache");
  }

  beforeEach(() => {
    vi.resetModules();
  });

  it("round-trips through the cold-open record and renders known next time", async () => {
    const cache = await freshCache();
    // the frame as it arrives with no size: the synthesized ACK a send writes,
    // or a preview the server could not measure
    const frame: PhotoFrame = { seq: 7, attachments: ["k"] };
    expect(seatOf(frame)).toBe("guess");

    // the pixels land, the app measures them, the store frame gains the size
    const learned = learnDims(frame.attachment_dims, frame.attachments.length, 0, [240, 320]);
    const stored: PhotoFrame = { ...frame, attachment_dims: learned! };

    // and the cold-open snapshot is copied straight out of the store
    await cache.put({ id: "default", lastSeq: 7, frames: [stored] });
    const back = await cache.get<PhotoFrame>("default");

    expect(back!.frames[0].attachment_dims).toEqual([[240, 320]]);
    expect(seatOf(back!.frames[0])).toBe("known"); // the next render does not guess
  });

  it("crosses no schema era: a client size and a server size are one shape", async () => {
    const cache = await freshCache();
    // bumping the era for this would throw away every cached thread on the
    // device to store a field that was already in it
    expect(cache.SCHEMA_VERSION).toBe(2);
    const served: PhotoFrame = { seq: 1, attachments: ["k"], attachment_dims: [[240, 320]] };
    const learnedFrame: PhotoFrame = {
      seq: 2,
      attachments: ["k"],
      attachment_dims: learnDims(undefined, 1, 0, [240, 320])!,
    };
    await cache.put({ id: "default", lastSeq: 2, frames: [served, learnedFrame] });
    const back = await cache.get<PhotoFrame>("default");
    expect(back!.frames).toHaveLength(2); // neither was dropped on read
    expect(back!.frames[0].attachment_dims).toEqual(back!.frames[1].attachment_dims);
  });
});

// ---------------------------------------------------------------------------
// The wiring, held to the source.

describe("the box is decided once per render", () => {
  const render = (): string => fnBody("renderUser");

  it("lays a photo that HAS a size out at that size, and DECLARES that shape", () => {
    // The two writes still have to OPEN the branch, but this no longer demands
    // they be the last thing in it: a counter reporting that this branch was
    // taken lives here too, and pinning the closing brace next to them made a
    // record that writes nothing read as a layout change.
    const src = render();
    expect(src).toContain("if (dims) {\n      img.width = dims[0];\n      img.height = dims[1];\n");
    // and the ratio, written out, from the same two numbers. This branch used to
    // forbid itself any style at all, on the reading that the arriving pixels
    // are the pixels the server measured and so the box could not move. The
    // pixels were never what moved it: until the reader comes near, this img has
    // NO source (photolazy.ts), and WebKit takes an unsourced img's natural
    // ratio from its alt text's box — one wide strip, whatever picture is
    // coming — which `aspect-ratio: auto W/H`, all the attributes above ever
    // were, quietly yields to. A declared ratio has no `auto` to yield with.
    const known = src.slice(src.indexOf("if (dims) {"), src.indexOf("} else {"));
    expect(known).toContain("img.style.aspectRatio = `${dims[0]} / ${dims[1]}`");
    // it is the size on the attributes and nothing invented: same two numbers,
    // same order, so the box declared is the box promised
    expect(known).not.toContain("GUESS");
    // and that is the ONLY thing it may write. The crop the guessed box wears
    // belongs to a box that was invented; a photo laid out at its own size is
    // the shape of its own pixels and has nothing to crop.
    expect(known).not.toContain("objectFit");
    expect(known.match(/img\.style/g)).toHaveLength(1);
  });

  it("keeps the alt text the strip came from: the box was the bug, not the word", () => {
    // an img with no source and no alt reserves nothing to read out loud either.
    // The fix is the ratio outranking the alt box, not the alt going away.
    expect(render()).toContain('img.alt = "photo"');
  });

  it("pins an EXPLICIT ratio on the box it has to guess", () => {
    // an explicit ratio is not the natural one, so nothing that decodes later
    // has any say in this box either: it holds until the app changes it
    const guess = render();
    expect(guess).toContain("img.width = GUESS_W");
    expect(guess).toContain("img.height = GUESS_H");
    expect(guess).toContain("img.style.aspectRatio = GUESS_RATIO");
    expect(GUESS_RATIO).toBe("4 / 3");
    expect([GUESS_W, GUESS_H]).toEqual([240, 180]); // the box that has always been drawn
  });

  it("remembers which branch it took, so the load knows whether it guessed", () => {
    expect(render()).toContain("const guessed = !dims");
    expect(render()).toContain("if (guessed) adoptPhotoBox(img, div, m.seq, i)");
  });

  it("leaves the stylesheet reading the box off the attributes", () => {
    expect(css).toContain(".msg.shot img { max-width: 100%; height: auto;");
  });
});

describe("adoptPhotoBox: the one reshape, and the last guess", () => {
  const adopt = (): string => fnBody("adoptPhotoBox");

  it("measures the photo's own pixels and gives up on a photo that has none", () => {
    // a photo whose bytes never decode keeps the guess, which is the only thing
    // standing between it and a zero tall row
    expect(adopt()).toContain("const nat = naturalSize(img)");
    expect(adopt()).toContain("if (!nat) return");
  });

  it("makes the change inside keepView, so the scroll is paid in the same frame", () => {
    expect(adopt()).toContain("keepView(row, () => {");
    const body = adopt();
    expect(body.indexOf("keepView(row")).toBeLessThan(body.indexOf("img.width = nat[0]"));
  });

  it("puts the box back on the photo's own ratio", () => {
    expect(adopt()).toContain('img.style.aspectRatio = ""');
    expect(adopt()).toContain('img.style.objectFit = ""');
    expect(adopt()).toContain("img.width = nat[0]");
    expect(adopt()).toContain("img.height = nat[1]");
  });

  it("never leaves a declared ratio standing next to a size it was not made for", () => {
    // both branches of the render now DECLARE a ratio beside the attributes, and
    // this is the one place a box's numbers ever change afterwards. So the rule
    // the declaration lives by is pinned here: the old ratio comes off before
    // the new size goes on, in the same write, and what takes over is the
    // photo's own decoded shape — which is the size being written, measured off
    // it. No frame holds a stale ratio and a fresh size together.
    const body = adopt();
    expect(body.indexOf('img.style.aspectRatio = ""')).toBeLessThan(
      body.indexOf("img.width = nat[0]"),
    );
    expect(body.indexOf("keepView(row")).toBeLessThan(
      body.indexOf('img.style.aspectRatio = ""'),
    );
    // and it is the size it just measured that lands, so the shape the box ends
    // up in is the shape the pixels are: nothing to declare and nothing to fight
    expect(body).toContain("const nat = naturalSize(img)");
  });

  it("is the only place a DECLARED box is ever re-sized", () => {
    // If anything else re-sized one, the ratio declared beside those attributes
    // would outrank the new numbers and hold the old shape — the failure this
    // fix exists to end, pointed the other way. So every size write in the app
    // is accounted for here: two of them stand beside a declaration (the two
    // branches of the render), one clears the declaration in the same write
    // (adopt, above), and the other two are on elements that carry no
    // declaration at all — the board preview, sized off its own png header, and
    // a sent photo's seat, sized off pixels already decoded.
    const writes = src
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^img\.(width|height) = /.test(l))
      .sort();
    expect(writes).toEqual([
      "img.height = GUESS_H;",
      "img.height = dims[1];",
      "img.height = dims[1];",
      "img.height = nat[1];",
      "img.height = nat[1];",
      "img.width = GUESS_W;",
      "img.width = dims[0];",
      "img.width = dims[0];",
      "img.width = nat[0];",
      "img.width = nat[0];",
    ]);
  });

  it("writes the size down, so this is the last render that ever guesses", () => {
    expect(adopt()).toContain("learnPhotoDims(seq, index, nat)");
  });
});

// TEMP DIAGNOSTIC (served-shape): remove with the main.ts block these pin.
describe("checkServedShape: the other branch's pixels, finally looked at", () => {
  const check = (): string => fnBody("checkServedShape");
  const render = (): string => fnBody("renderUser");

  it("runs on the load of the photo that did NOT guess", () => {
    // the branch every measurement so far says his history is made of, and the
    // one nothing has ever compared against its own pixels
    const load = render().slice(render().indexOf("img.onload"));
    expect(load).toContain("else if (dims) checkServedShape(img, m.seq, i, dims)");
    // and it runs on its own; the guessing branch keeps its correction alone
    expect(check()).not.toContain("adoptPhotoBox");
  });

  it("asks photofit whether there is anything to report, and reports only that", () => {
    expect(check()).toContain("const off = servedShape(told, nat)");
    expect(check()).toContain("if (!off) return");
    // silence is the finding when they agree, so nothing may be written above
    // the question: the record has to sit under that early return
    const body = check();
    expect(body.indexOf("if (!off) return")).toBeLessThan(
      body.indexOf('holdDiagRecord("served-shape"'),
    );
  });

  it("carries what the argument needs: told, served, transposed, and the ratio", () => {
    const body = check();
    expect(body).toContain("seq,\n    i: index,");
    expect(body).toContain("w: told[0]");
    expect(body).toContain("h: told[1]");
    expect(body).toContain("nw: nat[0]");
    expect(body).toContain("nh: nat[1]");
    expect(body).toContain("swap: off.swap");
    expect(body).toContain("r: off.r");
    expect(body).toContain("n: servedOff"); // how many distinct photos are wrong
  });

  it("records once per photo, so a scroll cannot bury its own evidence", () => {
    // the same key the two neighbouring marks dedupe on, and the same rule:
    // a re-render of a photo already looked at writes nothing at all
    const body = check();
    expect(body).toContain("const mark = `${seq}:${index}`");
    expect(body).toContain("if (servedSeen.has(mark)) return");
    expect(body).toContain("servedSeen.add(mark)");
    expect(body.indexOf("if (servedSeen.has(mark)) return")).toBeLessThan(
      body.indexOf('holdDiagRecord("served-shape"'),
    );
    expect(src).toContain("const servedSeen = new Set<string>()");
  });

  it("counts what it CHECKED on the record that always fires", () => {
    // zero mismatches has to be told apart from zero photos looked at, and the
    // mismatch record cannot do it: it is the record that is missing. So the
    // running count rides sized-box, which fires for every photo of this kind
    // whether or not anything later disagrees.
    expect(render()).toContain("ck: servedSeen.size");
    const known = render().slice(render().indexOf("if (dims) {"), render().indexOf("} else {"));
    expect(known).toContain('holdDiagRecord("sized-box"');
    expect(known).toContain("ck: servedSeen.size");
    // and a photo with no pixels to read is not a photo that was checked
    expect(check()).toContain("if (!nat) return");
    expect(check().indexOf("if (!nat) return")).toBeLessThan(
      check().indexOf("servedSeen.add(mark)"),
    );
  });

  it("observes only: two properties the image already knows, and no layout", () => {
    const body = check();
    expect(body).toContain("const nat = naturalSize(img)");
    expect(body).not.toContain("getBoundingClientRect");
    expect(body).not.toContain("offsetHeight");
    expect(body).not.toContain("keepView");
    expect(body).not.toContain("img.style");
    expect(body).not.toMatch(/img\.(width|height) =/);
  });
});

// TEMP DIAGNOSTIC (photo-strip): remove with the photofit.ts section and the
// main.ts block these pin.
//
// The bug the declared ratio ends, written down as arithmetic so the record
// that watches for its return can be tested without an engine that has it: a
// parked photo has no source, WebKit sizes an unsourced img from its ALT TEXT's
// box (the word "photo", about 49 by 24), and `aspect-ratio: auto W/H` yields to
// a natural ratio wherever it finds one. Every seat came out the same wide
// strip, whatever picture was coming.
describe("strippedBox: the seat against the shape it was promised", () => {
  it("says nothing about a box that is the shape it was told to be", () => {
    // the expected answer on every engine now, and the reason silence reads as
    // the fix holding rather than as nothing having been looked at
    expect(strippedBox(240, 320, 3024, 4032)).toBe(false); // portrait, seated right
    expect(strippedBox(320, 240, 4032, 3024)).toBe(false); // landscape, seated right
    expect(strippedBox(240, 240, 1000, 1000)).toBe(false);
  });

  it("catches the strip: a portrait photo's seat drawn as the alt text's box", () => {
    // his case, in the numbers WebKit actually produced — a 3024x4032 photo
    // whose reserved box came out at the alt word's own 49:24, then sprang to
    // 320 tall when the picture arrived
    expect(strippedBox(240, 117, 3024, 4032)).toBe(true);
    // and the springing itself, as a height: the seat owed 320 and held 117
    expect(320 - 117).toBeGreaterThan(200); // the shove, per photo, down the page
  });

  it("forgives the slop a fractional layout number costs, and nothing beyond it", () => {
    // the promised height is arithmetic on two integers; the rendered one is
    // whatever the engine's own subpixel rounding made of the row's width
    expect(strippedBox(240, 320 + STRIP_SLOP_PX, 3024, 4032)).toBe(false);
    expect(strippedBox(240, 320 - STRIP_SLOP_PX, 3024, 4032)).toBe(false);
    expect(strippedBox(240, 320 + STRIP_SLOP_PX + 0.01, 3024, 4032)).toBe(true);
    expect(STRIP_SLOP_PX).toBe(2);
  });

  it("says nothing about a box it cannot compare", () => {
    // a row not yet laid out has no shape to be wrong, and a photo that was
    // never given a size was never promised one
    expect(strippedBox(0, 0, 3024, 4032)).toBe(false);
    expect(strippedBox(240, 320, 0, 0)).toBe(false);
    expect(strippedBox(Number.NaN, 320, 3024, 4032)).toBe(false);
    expect(strippedBox(240, 320, 3024, Number.NaN)).toBe(false);
  });
});

// TEMP DIAGNOSTIC (photo-strip): remove with the main.ts block these pin.
describe("checkPhotoStrip: the seat read in the last frame it is alone", () => {
  const check = (): string => fnBody("checkPhotoStrip");
  const watch = (): string => fnBody("watchPhotos");

  it("runs at the release, BEFORE the source goes on", () => {
    // afterwards the box is whatever the picture makes it, and the reading says
    // nothing about what was reserved
    const body = watch();
    expect(body).toContain("checkPhotoStrip(img);");
    expect(body.indexOf("checkPhotoStrip(img)")).toBeLessThan(
      body.indexOf("photoQueue.release(img)"),
    );
    // and photolazy.ts is what puts the source on, in that same next statement
    expect(readFileSync(join(here, "../src/photolazy.ts"), "utf8")).toContain("img.src = src;");
  });

  it("holds the box to the ATTRIBUTES, not to the two getters that lie", () => {
    // img.width and img.height answer with the RENDERED box once the element is
    // in the page, which is the very number this is checking — read through
    // them, a strip agrees with itself perfectly
    const body = check();
    expect(body).toContain('Number(img.getAttribute("width"))');
    expect(body).toContain('Number(img.getAttribute("height"))');
    const code = body.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(code).not.toMatch(/img\.width\b/);
    expect(code).not.toMatch(/img\.height\b/);
  });

  it("reads the geometry once, and writes nothing after it", () => {
    const body = check();
    expect(body.match(/getBoundingClientRect/g)).toHaveLength(1);
    expect(body).not.toContain("img.style");
    expect(body).not.toContain("keepView");
    expect(body).not.toContain("scrollTop");
  });

  it("asks photofit whether there is anything to report, and reports only that", () => {
    // silence is the finding when the seat is right, so nothing may be written
    // above the question
    const body = check();
    expect(body).toContain("if (!strippedBox(box.width, box.height, toldW, toldH)) return");
    expect(body.indexOf("if (!strippedBox(")).toBeLessThan(
      body.indexOf('holdDiagRecord("photo-strip"'),
    );
    // a photo that was never given a size is not a photo that was seated wrong,
    // and it costs no layout read to say so
    expect(body).toContain("if (!(toldW > 0) || !(toldH > 0)) return");
    expect(body.indexOf("if (!(toldW > 0)")).toBeLessThan(body.indexOf("getBoundingClientRect"));
  });

  it("carries the box that stands and the box that was promised, and no more", () => {
    const body = check();
    expect(body).toContain("rw: Math.round(box.width)");
    expect(body).toContain("rh: Math.round(box.height)");
    expect(body).toContain("toldW,");
    expect(body).toContain("toldH,");
  });
});

describe("keepView: read, change, read, one write", () => {
  const keep = (): string => fnBody("keepView");

  it("takes the reader's top edge off the thread itself", () => {
    expect(keep()).toContain("const fold = t.getBoundingClientRect().top");
  });

  it("reads the box either side of the change, with no paint in between", () => {
    const body = keep();
    const first = body.indexOf("const before = row.getBoundingClientRect()");
    expect(first).toBeGreaterThan(-1);
    // the first change() in the body belongs to the no-thread escape above it
    const call = body.indexOf("change();", first);
    const second = body.indexOf("row.getBoundingClientRect().height - before.height");
    expect(call).toBeGreaterThan(-1);
    expect(first).toBeLessThan(call);
    expect(call).toBeLessThan(second);
  });

  it("asks photofit what the change costs, and hands back exactly that", () => {
    expect(keep()).toContain(
      "scrollFix(before.bottom, fold, row.getBoundingClientRect().height - before.height,",
    );
    expect(keep()).toContain("followTail)");
    expect(keep()).toContain("if (fix === 0) return");
    expect(keep()).toContain("t.scrollTop += fix");
  });

  it("runs the change even with no thread to correct", () => {
    expect(keep()).toContain("if (!t) {\n    change();\n    return;\n  }");
  });
});

describe("learnPhotoDims: the store is the truth the next render reads", () => {
  const learn = (): string => fnBody("learnPhotoDims");

  it("repairs the stored frame rather than the element on screen", () => {
    expect(learn()).toContain("const cur = store.get(seq)");
    expect(learn()).toContain("store.set(seq, { ...cur, attachment_dims: next })");
  });

  it("asks photofit whether there is anything to learn", () => {
    expect(learn()).toContain(
      'learnDims(cur.attachment_dims, (cur.attachments ?? []).length, index, dims)',
    );
    expect(learn()).toContain("if (!next) return false");
  });

  it("sends the repaired frame to the cold-open snapshot", () => {
    expect(learn()).toContain("cacheWrites.bump()");
    // and the snapshot is the store, copied out whole
    expect(fnBody("writeThreadCache")).toContain("frames: seqs.map((s) => store.get(s)!)");
  });
});

describe("a photo that never arrives", () => {
  it("swaps its box for the chip through keepView", () => {
    const render = fnBody("renderUser");
    const err = render.slice(render.indexOf("img.onerror"));
    expect(err).toContain("keepView(div, () => {");
    expect(err).toContain('div.classList.replace("shot", "text")');
    expect(err).toContain("img.remove()");
  });
});

describe("the tail settle keeps its own job", () => {
  it("still owns the scroll while the view follows the end", () => {
    // keepView answers zero there (pinned above), and these are untouched
    expect(fnBody("settleTail")).toContain("const plan = settleBottom(g, followTail)");
    expect(fnBody("renderUser")).toContain("if (followTail) scrollToBottom(true)");
  });

  it("orders the reshape before the tail pin, so the pin reads the final height", () => {
    const render = fnBody("renderUser");
    const load = render.slice(render.indexOf("img.onload"));
    expect(load.indexOf("adoptPhotoBox")).toBeLessThan(load.indexOf("scrollToBottom(true)"));
  });
});
