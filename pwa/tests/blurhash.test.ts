// The blurred picture a photo wears before its pixels land (src/blurhash.ts).
//
// The claim this suite has to make good on is not "it returned some bytes". A
// placeholder that decodes to the wrong colours is worse than the grey box it
// replaced, because grey plainly says "coming" and a wrong picture quietly
// claims to be the photo. So every hash below is a string this repo's OWN
// server produced, run through the vendored encoder in web/blurhash.py, and the
// expectations are about the picture that went in: a sky over a ground decodes
// blue on top and brown underneath, a flat colour decodes back to that colour,
// a green-left magenta-right split comes back green on the left.
//
// The golden pixel values were additionally cross-checked, byte for byte, against
// the official npm blurhash package's own decode() at five different decode
// sizes. Vendoring is only worth it if it agrees with the thing it replaces.
//
// The other half is the fallback. The server sends a null blurhash for exactly
// one case, a stored preview whose bytes will not decode at all, and that photo
// must keep the flat grey face it has always had. In the app that is two
// pieces: this module answering null, and the stylesheet's own
// var(--blur, none) standing the grey up when main.ts consequently writes no
// --blur. Both are pinned below, the second by reading the stylesheet, because
// the grey is the thing that has to survive and neither piece proves it alone.
//
// Pure module, no DOM: the canvas step that turns these bytes into a data uri
// is four lines of wiring in main.ts and is proved in a browser instead.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BLUR_EDGE, decodeBlurhash } from "../src/blurhash";

// Strings the server actually produced. Each name says what the encoder was
// shown, so a failure below reads as "the sky came out brown" rather than as a
// number that moved.
const PHOTO = "L{EDSkj^fQoft:a~fQofRPWWfQj?"; // a real 1200x1600 photo through the whole thumbnail pipeline
const SKY_OVER_GROUND = "L^DJ-#kCfQkCcbflfQflbcfRfQfR"; // rgb(110,160,220) over rgb(120,85,45)
const SOLID_RED = "L7M^z|]TfQ]T|wo1fQo1fQfQfQfQ"; // rgb(200,30,30), every pixel
const GREEN_LEFT_MAGENTA_RIGHT = "LtHBPt3[Sv+kofX4a{jbfQfQfQfQ"; // rgb(40,170,60) | rgb(200,60,190)
const FLAT_ONE_COMPONENT = "009k7l"; // 1x1 components: a DC term and nothing else
const THREE_BY_TWO = "B72QoVTXWol^a3a|"; // 3x2 components, so 16 characters rather than 28

type Rgb = [number, number, number];

/** one pixel's rgb out of the packed rgba buffer */
function pixel(px: Uint8ClampedArray, w: number, x: number, y: number): Rgb {
  const p = (y * w + x) * 4;
  return [px[p], px[p + 1], px[p + 2]];
}

/** the average rgb of a horizontal band, which is how a picture reads at a glance */
function band(px: Uint8ClampedArray, w: number, h: number, from: number, to: number): Rgb {
  let r = 0;
  let g = 0;
  let b = 0;
  for (let y = from; y < to; y++) {
    for (let x = 0; x < w; x++) {
      const [pr, pg, pb] = pixel(px, w, x, y);
      r += pr;
      g += pg;
      b += pb;
    }
  }
  const n = (to - from) * w;
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/** the average rgb of a vertical band */
function column(px: Uint8ClampedArray, w: number, h: number, from: number, to: number): Rgb {
  let r = 0;
  let g = 0;
  let b = 0;
  for (let y = 0; y < h; y++) {
    for (let x = from; x < to; x++) {
      const [pr, pg, pb] = pixel(px, w, x, y);
      r += pr;
      g += pg;
      b += pb;
    }
  }
  const n = (to - from) * h;
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/** the decode, with the guard that a null here would fail every colour check below silently */
function decoded(hash: string, w = BLUR_EDGE, h = BLUR_EDGE): Uint8ClampedArray {
  const px = decodeBlurhash(hash, w, h);
  expect(px).not.toBeNull();
  return px!;
}

describe("a real photo's hash decodes to the photo's own colours", () => {
  it("puts the sky at the top and the ground at the bottom", () => {
    const px = decoded(PHOTO);
    const [tr, tg, tb] = band(px, BLUR_EDGE, BLUR_EDGE, 0, 11);
    const [br, bg, bb] = band(px, BLUR_EDGE, BLUR_EDGE, 21, BLUR_EDGE);
    // sky: blue is the strongest channel and the whole band is bright
    expect(tb).toBeGreaterThan(tg);
    expect(tg).toBeGreaterThan(tr);
    expect(tb).toBeGreaterThan(200);
    // ground: red is the strongest channel and the whole band is dark
    expect(br).toBeGreaterThan(bg);
    expect(bg).toBeGreaterThan(bb);
    expect(br).toBeLessThan(150);
    // and the two halves are plainly different pictures, not one average colour
    expect(tb - bb).toBeGreaterThan(100);
  });

  it("decodes the exact bytes the official decoder does", () => {
    // golden values, cross-checked against npm blurhash@2.0.5 decode() on this
    // same string at 32x32 (and at four other sizes, byte for byte)
    const px = decoded(PHOTO);
    expect(pixel(px, BLUR_EDGE, 0, 0)).toEqual([131, 176, 249]);
    expect(pixel(px, BLUR_EDGE, 31, 0)).toEqual([115, 155, 219]);
    expect(pixel(px, BLUR_EDGE, 16, 16)).toEqual([137, 161, 193]);
    expect(pixel(px, BLUR_EDGE, 31, 31)).toEqual([88, 0, 0]);
  });

  it("hands back one opaque rgba pixel per pixel of the box asked for", () => {
    const px = decoded(PHOTO, 20, 14);
    expect(px).toBeInstanceOf(Uint8ClampedArray);
    expect(px.length).toBe(20 * 14 * 4);
    for (let i = 3; i < px.length; i += 4) expect(px[i]).toBe(255);
  });
});

describe("the colours are the ones the encoder was shown", () => {
  it("a sky over a ground comes back blue over brown", () => {
    const px = decoded(SKY_OVER_GROUND);
    const [tr, tg, tb] = band(px, BLUR_EDGE, BLUR_EDGE, 0, 11); // source rgb(110,160,220)
    const [br, bg, bb] = band(px, BLUR_EDGE, BLUR_EDGE, 21, BLUR_EDGE); // source rgb(120,85,45)
    expect(Math.abs(tr - 110)).toBeLessThan(25);
    expect(Math.abs(tg - 160)).toBeLessThan(25);
    expect(Math.abs(tb - 220)).toBeLessThan(25);
    expect(Math.abs(br - 120)).toBeLessThan(25);
    expect(Math.abs(bg - 85)).toBeLessThan(35);
    expect(Math.abs(bb - 45)).toBeLessThan(35);
  });

  it("a flat colour comes back as that colour everywhere", () => {
    const px = decoded(SOLID_RED); // source rgb(200,30,30)
    for (let y = 0; y < BLUR_EDGE; y += 7) {
      for (let x = 0; x < BLUR_EDGE; x += 7) {
        const [r, g, b] = pixel(px, BLUR_EDGE, x, y);
        expect(Math.abs(r - 200)).toBeLessThan(30);
        expect(g).toBeLessThan(60);
        expect(b).toBeLessThan(60);
      }
    }
  });

  it("a left/right split comes back split left and right, not top and bottom", () => {
    const px = decoded(GREEN_LEFT_MAGENTA_RIGHT);
    const [lr, lg, lb] = column(px, BLUR_EDGE, BLUR_EDGE, 0, 11); // source rgb(40,170,60)
    const [rr, rg, rb] = column(px, BLUR_EDGE, BLUR_EDGE, 21, BLUR_EDGE); // source rgb(200,60,190)
    expect(lg).toBeGreaterThan(lr + 100); // green dominates on the left
    expect(lg).toBeGreaterThan(lb + 100);
    expect(rr).toBeGreaterThan(rg + 100); // magenta on the right
    expect(rb).toBeGreaterThan(rg + 100);
    // the halves differ across, and the top and bottom bands do not differ down
    const [t] = band(px, BLUR_EDGE, BLUR_EDGE, 0, 11);
    const [b] = band(px, BLUR_EDGE, BLUR_EDGE, 21, BLUR_EDGE);
    expect(Math.abs(t - b)).toBeLessThan(20);
  });

  it("a hash with no AC terms at all is one flat colour", () => {
    const px = decoded(FLAT_ONE_COMPONENT, 4, 4);
    const first = pixel(px, 4, 0, 0);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) expect(pixel(px, 4, x, y)).toEqual(first);
    }
  });
});

describe("the hash carries no shape of its own", () => {
  // The reason main.ts is allowed to decode a square and let CSS stretch it
  // over a portrait or landscape box: a pixel's colour is a function of how far
  // across and down the picture it sits, and of nothing else. Same fraction of
  // the way down two differently shaped decodes, same colour, exactly.
  it("a row's colour depends only on how far down the picture it is", () => {
    const short = decoded(PHOTO, 32, 24);
    const tall = decoded(PHOTO, 32, 32);
    expect(pixel(short, 32, 5, 12)).toEqual(pixel(tall, 32, 5, 16)); // both halfway down
    expect(pixel(short, 32, 5, 6)).toEqual(pixel(tall, 32, 5, 8)); // both a quarter down
    expect(pixel(short, 32, 5, 0)).toEqual(pixel(tall, 32, 5, 0)); // both the top edge
  });

  it("a column's colour depends only on how far across the picture it is", () => {
    const narrow = decoded(PHOTO, 16, 32);
    const wide = decoded(PHOTO, 32, 32);
    expect(pixel(narrow, 16, 8, 3)).toEqual(pixel(wide, 32, 16, 3)); // both halfway across
    expect(pixel(narrow, 16, 4, 3)).toEqual(pixel(wide, 32, 8, 3)); // both a quarter across
  });
});

describe("the first character says how long the string should be", () => {
  it("reads 4x3 components out of the 28-character hash the server sends", () => {
    expect(PHOTO).toHaveLength(1 + 1 + 4 + 2 * (4 * 3 - 1));
    expect(decodeBlurhash(PHOTO, 4, 4)).not.toBeNull();
  });

  it("reads other component counts too", () => {
    expect(THREE_BY_TWO).toHaveLength(1 + 1 + 4 + 2 * (3 * 2 - 1));
    expect(decodeBlurhash(THREE_BY_TWO, 4, 4)).not.toBeNull();
    expect(FLAT_ONE_COMPONENT).toHaveLength(6);
    expect(decodeBlurhash(FLAT_ONE_COMPONENT, 4, 4)).not.toBeNull();
  });

  it("refuses a string whose length does not match the count it declares", () => {
    expect(decodeBlurhash(PHOTO.slice(0, 27))).toBeNull(); // one character short
    expect(decodeBlurhash(`${PHOTO}f`)).toBeNull(); // one character long
    expect(decodeBlurhash(THREE_BY_TWO.slice(0, 15))).toBeNull();
  });
});

describe("a photo with no usable blurhash falls back to the grey box", () => {
  // Every one of these has to answer null rather than throw or guess. The
  // server's own null is the first case and the only one it means to send; the
  // rest are the app refusing to break on a frame it did not expect.
  it("answers null for the null the server sends for an undecodable preview", () => {
    expect(decodeBlurhash(null)).toBeNull();
  });

  it("answers null for a frame that carries no blurhashes at all", () => {
    const frame: { attachment_blurhashes?: (string | null)[] } = {};
    expect(decodeBlurhash(frame.attachment_blurhashes?.[0])).toBeNull();
    expect(decodeBlurhash(undefined)).toBeNull();
    expect(decodeBlurhash("")).toBeNull();
  });

  it("answers null for anything too short to be a hash", () => {
    for (const s of ["L", "L{", "L{ED", "L{EDS"]) expect(decodeBlurhash(s)).toBeNull();
  });

  it("answers null for a character that is not in base83", () => {
    // base83 leaves out exactly these, and a string carrying one is not a hash
    for (const bad of ['"', "'", "\\", "/", "(", ")", "<", ">", "!", "&", "é"]) {
      expect(decodeBlurhash(bad + PHOTO.slice(1))).toBeNull();
      expect(decodeBlurhash(PHOTO.slice(0, 14) + bad + PHOTO.slice(15))).toBeNull();
    }
  });

  it("answers null for something that is not a string at all", () => {
    for (const junk of [0, 1, [], {}, true]) {
      expect(decodeBlurhash(junk as unknown as string)).toBeNull();
    }
  });

  it("answers null for a box with no pixels in it", () => {
    for (const [w, h] of [[0, 32], [32, 0], [-4, 4], [4, -4], [1.5, 4], [4, Number.NaN]]) {
      expect(decodeBlurhash(PHOTO, w, h)).toBeNull();
    }
  });

  it("still has a grey face in the stylesheet for main.ts to fall back to", () => {
    // The other half of the fallback, and the half a decoder test cannot see: a
    // null above means main.ts writes no --blur on the row, so the waiting
    // face's background-image resolves to none and the flat --received colour
    // underneath it is what paints. If that var() ever loses its none fallback,
    // or the colour stops being a colour, an undecodable photo goes blank
    // instead of grey and nothing else in this repo would notice.
    const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");
    const rule = /\.msg\.shot:has\(img\.waiting\)::before\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/background-color:\s*var\(--received\)/);
    expect(rule![1]).toMatch(/background-image:\s*var\(--blur,\s*none\)/);
  });
});

describe("the decode is small enough to run on the render path", () => {
  it("decodes to 32 square by default, which is all a hash holds", () => {
    expect(BLUR_EDGE).toBe(32);
    expect(decoded(PHOTO).length).toBe(BLUR_EDGE * BLUR_EDGE * 4);
  });

  it("costs a fraction of a millisecond, so a thread of photos is free", () => {
    const started = performance.now();
    for (let i = 0; i < 200; i++) decodeBlurhash(PHOTO, BLUR_EDGE, BLUR_EDGE);
    const each = (performance.now() - started) / 200;
    // measured around 0.12ms; the bar is loose because CI machines are not this
    // one, and the point is the order of magnitude, not the number
    expect(each).toBeLessThan(5);
  });
});
