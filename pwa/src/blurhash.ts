// BlurHash decoder: the ~28-character string the server ships beside a photo,
// read back into the blurred picture it stands for.
//
// The point of the string, and why the server bothers to compute one: a photo
// bubble can wear the real picture's own colours and shape from the frame its
// row is built, instead of the flat grey rectangle it used to sit in while its
// bytes were still on the wire (the trick Signal's attachment pointers carry).
// It costs about 28 bytes on the wire rather than a second round trip, and the
// server hands it over inside the same frame as the photo's size, so the box is
// already reserved for it (main.ts renderUser).
//
// Vendored rather than added to package.json, for the same reason the encoder on
// the server side is vendored: this is a cosine transform over twelve basis
// functions, it is about a hundred lines, it needs nothing outside the language,
// and this repo is headed for a public release where every dependency is a thing
// someone else has to trust. The decode is much the smaller half of the
// algorithm, since the picture's structure was all settled at encode time. The
// published reference implementation (woltapp/blurhash, TypeScript/src/decode.ts
// plus its base83 and sRGB helpers) is transcribed step for step below,
// including its exact rounding and clamping, and the vectors in the tests are
// strings this repo's own server actually produced.
//
// This file is pure and touches no DOM, so the whole of it is pinned by unit
// tests, the same shape as photolazy.ts and bootgate.ts: main.ts carries the
// thin wiring that turns these pixels into something CSS can paint.
//
// One safety note for anything downstream. base83 includes # $ % * + , - . : ;
// = ? @ [ ] ^ _ { | } ~ , so a raw hash is fine in JSON and fine as text, but it
// must never be pasted unquoted into an HTML attribute or a CSS url(). Nothing
// here does: a hash goes in, plain pixel bytes come out, and the only thing that
// reaches the stylesheet is the base64 png main.ts paints from them.

/** the decode size: a hash holds nothing but low frequencies, so 32 square is
 *  everything there is to see in one, and CSS scales it to the reserved box */
export const BLUR_EDGE = 32;

// base83 is blurhash's own alphabet: url-safe, html-safe, and dense enough that
// a 4x3 hash fits in 28 characters
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~";

// character code to digit, so reading a character is one array lookup instead of
// a scan of all 83. -1 for anything that is not in the alphabet at all.
const DIGIT = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) DIGIT[ALPHABET.charCodeAt(i)] = i;

/** the base83 number in [from, to), or -1 when any character is not base83 */
function base83(s: string, from: number, to: number): number {
  let value = 0;
  for (let i = from; i < to; i++) {
    const code = s.charCodeAt(i);
    const digit = code < 128 ? DIGIT[code] : -1;
    if (digit < 0) return -1;
    value = value * 83 + digit;
  }
  return value;
}

function srgbToLinear(value: number): number {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function linearToSrgb(value: number): number {
  const v = Math.max(0, Math.min(1, value));
  return v <= 0.0031308
    ? Math.trunc(v * 12.92 * 255 + 0.5)
    : Math.trunc((1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255 + 0.5);
}

function signPow(value: number, exp: number): number {
  return Math.sign(value) * Math.pow(Math.abs(value), exp);
}

/**
 * RGBA bytes for a blurhash, row by row from the top, four per pixel, which is
 * exactly the buffer a canvas ImageData wants.
 *
 * Null, never a throw, for anything that is not a well-formed hash: absent,
 * empty, the wrong length for the component counts its own first character
 * claims, or carrying a character outside base83. The server sends null for a
 * photo whose stored preview will not decode at all, and a caller handed null
 * back leaves that photo the flat grey face it has always had.
 *
 * The hash carries NO aspect ratio. Its basis functions are normalised over the
 * picture's own width and height, whatever those were, so a decoded pixel's
 * colour depends only on how far across and how far down the picture it sits
 * and never on the shape of the grid it is being decoded into. Asking for a
 * square and letting CSS stretch it therefore throws away nothing a rectangular
 * decode would have kept, which is why callers are free to do the shaping in
 * the stylesheet.
 */
export function decodeBlurhash(
  hash: string | null | undefined,
  width: number = BLUR_EDGE,
  height: number = BLUR_EDGE,
): Uint8ClampedArray | null {
  if (typeof hash !== "string" || hash.length < 6) return null;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return null;

  // the first character carries both component counts, so the string says how
  // long it should be and a truncated one is caught before it is read
  const sizeFlag = base83(hash, 0, 1);
  if (sizeFlag < 0) return null;
  const numX = (sizeFlag % 9) + 1;
  const numY = Math.floor(sizeFlag / 9) + 1;
  if (hash.length !== 4 + 2 * numX * numY) return null;

  // one shared scale for every AC term, quantised into the string by the encoder
  // precisely so the decoder can undo it without being told
  const quantisedMax = base83(hash, 1, 2);
  if (quantisedMax < 0) return null;
  const maximum = (quantisedMax + 1) / 166;

  // the DC term is the picture's average colour, stored as a plain sRGB triple;
  // every AC term is a signed offset from it in linear light
  const dc = base83(hash, 2, 6);
  if (dc < 0) return null;
  const count = numX * numY;
  const colours = new Float64Array(count * 3);
  colours[0] = srgbToLinear(dc >> 16);
  colours[1] = srgbToLinear((dc >> 8) & 255);
  colours[2] = srgbToLinear(dc & 255);
  for (let i = 1; i < count; i++) {
    const value = base83(hash, 4 + i * 2, 6 + i * 2);
    if (value < 0) return null;
    // three channels packed base 19, each one square-rooted around a zero of 9
    // at encode time, so the square here is undoing that
    const c = i * 3;
    colours[c] = signPow((Math.floor(value / 361) - 9) / 9, 2) * maximum;
    colours[c + 1] = signPow(((Math.floor(value / 19) % 19) - 9) / 9, 2) * maximum;
    colours[c + 2] = signPow(((value % 19) - 9) / 9, 2) * maximum;
  }

  // the basis functions depend only on (component, coordinate), so they are
  // computed once here instead of width x height times inside the pixel loop.
  // At 32 square that is 224 cosines rather than about 25 thousand, which is the
  // difference between free and worth thinking about on a phone.
  const cosX = new Float64Array(numX * width);
  for (let i = 0; i < numX; i++) {
    for (let x = 0; x < width; x++) cosX[i * width + x] = Math.cos((Math.PI * i * x) / width);
  }
  const cosY = new Float64Array(numY * height);
  for (let j = 0; j < numY; j++) {
    for (let y = 0; y < height; y++) cosY[j * height + y] = Math.cos((Math.PI * j * y) / height);
  }

  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < numY; j++) {
        const basisY = cosY[j * height + y];
        for (let i = 0; i < numX; i++) {
          const basis = basisY * cosX[i * width + x];
          const c = (i + j * numX) * 3;
          r += colours[c] * basis;
          g += colours[c + 1] * basis;
          b += colours[c + 2] * basis;
        }
      }
      const p = (y * width + x) * 4;
      pixels[p] = linearToSrgb(r);
      pixels[p + 1] = linearToSrgb(g);
      pixels[p + 2] = linearToSrgb(b);
      pixels[p + 3] = 255; // a blurhash is always fully opaque
    }
  }
  return pixels;
}
