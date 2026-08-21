// A photo's pixels, before they land: the seat one takes in the thread, the
// wait until it is actually DRAWN, and the entrance the picked-photo preview
// rides in on. main.ts does the DOM half of all three.
//
// --- the seat -----------------------------------------------------------------
// The seat is worked out from the file's own pixels before a single one of them
// is drawn (main.ts does the DOM half, in send()). A photo row that enters the
// thread unsized is zero tall until it decodes, so the pin that follows the
// insert lands on a bubble that has not grown yet; the decode then grows the row
// downward and the photo comes to rest as a thin top sliver under the compose
// bar. Reserving this box first and pinning after is the fix.
//
// The box mirrors the stylesheet exactly: .msg caps a bubble at 75% of its row,
// and .msg.shot img is max-width 100% with height auto, so a photo's used width
// is its own width capped by the bubble's share of the row, and its height
// follows from the aspect ratio. Never upscaled: a photo narrower than the cap
// keeps its own size, which is what max-width alone would leave it at.

export const SHOT_MAX_WIDTH = 0.75; // .msg max-width in styles.css

export interface PhotoBox {
  width: number;
  height: number;
}

export function photoBox(natW: number, natH: number, rowW: number): PhotoBox {
  if (!(natW > 0) || !(natH > 0)) return { width: 0, height: 0 };
  // a row that cannot be measured (a thread with no layout yet) must never
  // collapse the photo to nothing: fall back to its natural width, which the
  // stylesheet's max-width still caps on its own
  const cap = rowW > 0 ? rowW * SHOT_MAX_WIDTH : natW;
  const width = Math.min(natW, cap);
  return { width, height: (width * natH) / natW };
}

// --- the wait: READ is not DRAWN ----------------------------------------------
// Having a photo's size is not the same as having its pixels on screen. An img
// fires load as soon as the file is READ, but the phone still has to turn twelve
// megapixels into something it can paint, and on a camera photo that lands a
// beat later. Both places the app shows a photo used to go on the read or on
// nothing at all: send() built the row when load fired, and the pending tray put
// a thumbnail on screen the moment it made the element. Each showed a correctly
// sized empty frame that filled in a beat afterwards, which is the blank the
// owner reported in both places. Reserving the seat first (above) did not cause
// that blank, but it did make the send's version plain to see: the frame is now
// the right size from the start, so the emptiness has somewhere to sit.
//
// decode() resolves only once the pixels are ready to paint, so it covers the
// read AND the draw, and an element it has resolved for is safe to put on
// screen. That is the one wait both places ride now — ONE wait, on ONE element.
// The tray's thumbnail and the photo the send hands the thread used to be two
// img elements over the same blob url, each running its own decode() at the same
// moment. On a 12MP camera photo that is real work and the two copies slowed
// each other down: a device session drew one of them in 3654ms while its twin,
// decoding the identical bytes alongside it, ran out of patience and gave up.
// There is a single element per picked file now (main.ts prepareShot). It stands
// in the tray while the photo is staged and the send carries that very element
// into the bubble, so the thread paints pixels the tray already has and no
// second decode is ever asked for.
//
// Nothing holds a deadline any more, which is why the default below is to wait
// as long as the pixels take. A deadline belongs to whatever the wait is HOLDING
// BACK, and neither place holds anything back:
//   - the tray's seat and the tray's own opening land on the tap (stagePick),
//     and only the picture inside is still to come;
//   - the sent row is built, pinned and flown the moment ↑ is pressed, wearing
//     the same placeholder the tray's square wears until the pixels turn up.
// The send used to wait 350ms and go on without them, which is exactly the lag
// the owner reported between the tray vanishing and the bubble arriving: his
// camera photos missed that deadline every time, so the tap bought a blank frame
// and a beat of nothing. Giving up on a timer can only ever swap a mark that
// plainly says "coming" for an empty frame that says nothing, which is the one
// frame this whole section exists to prevent. The deadline stays on the helper
// for a caller that genuinely cannot wait; there is no such caller today.

/** a wait with nothing held back behind it: no timer, the pixels take what they take */
export const DRAW_NO_DEADLINE = Number.POSITIVE_INFINITY;

/** why the wait ended: drawn and safe to show, or one of the three give-ups */
export type DrawWhy = "drawn" | "load" | "error" | "late";

/** the slice of an image element the wait touches, so the tests need no DOM */
export interface Drawable {
  decode?(): Promise<unknown>;
  addEventListener(type: string, listener: () => void, opts?: { once: boolean }): void;
}

export function whenDrawn(img: Drawable, deadlineMs: number = DRAW_NO_DEADLINE): Promise<DrawWhy> {
  return new Promise<DrawWhy>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const settle = (why: DrawWhy): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(why);
    };
    // armed before the decode is asked for, so nothing below can outlive it. A
    // non-finite deadline arms nothing: setTimeout takes a long, so Infinity
    // arrives there as zero and would fire on the spot, which is the exact
    // opposite of what a caller asking to wait indefinitely means.
    if (Number.isFinite(deadlineMs)) timer = setTimeout(() => settle("late"), deadlineMs);
    let drawing: Promise<unknown> | undefined;
    try {
      drawing = img.decode?.();
    } catch {
      drawing = undefined; // refused outright: fall through to the read
    }
    if (drawing) {
      drawing.then(() => settle("drawn"), () => settle("error"));
      return;
    }
    // no decode() in this browser: settle on the read, which is the behaviour
    // this replaces, rather than waiting out the deadline every single time
    img.addEventListener("load", () => settle("load"), { once: true });
    img.addEventListener("error", () => settle("error"), { once: true });
  });
}

// --- the picked photo's entrance ----------------------------------------------
// The preview used to simply be there. It travels in now, from the left and only
// a little: the owner asked for the direction, not for a journey, and said
// plainly it must not read as coming out of the ＋ button, so the distance is
// short enough to have no visible origin. The beat and ease are the send
// flight's (shift.ts), because the tray should move the way the rest of the app
// moves rather than in a curve of its own.
//
// What moves is the SQUARE, and it moves when the picture lands in it. The seat
// went up on the tap wearing a placeholder, so this animation never slides an
// empty frame, and it never plays in the same frame as the tray opening from
// nothing — an 18px hop is invisible beside a whole strip appearing, which is
// what made the first version of this look like no motion at all. It fades up
// as it travels, from pixels it already has.

export const THUMB_SLIDE_PX = 18; // a short hop beside the 64px thumbnail it moves

export function thumbSlide(): Keyframe[] {
  return [
    { opacity: 0, transform: `translateX(-${THUMB_SLIDE_PX}px)` },
    { opacity: 1, transform: "none" },
  ];
}

// --- the picked photo's exit ---------------------------------------------------
// The ✕ used to delete the thumbnail and switch the tray off in the same frame,
// which is the snap the owner reported: it disappears, but it is sudden. A
// removal leaves the way the pick arrived now, on the send flight's own beat and
// ease (shift.ts) — the same clock the entrance above rides, so a square that
// slid in does not answer some other curve on the way out.
//
// Two motions, started together and finishing together, so the removal reads as
// one. The SQUARE shrinks and fades where it stands; the STRIP eases its own
// height down underneath it, so the compose bar rides the closing edge instead
// of jumping to meet it. The strip's half plays only when the square leaving is
// the last one in the tray: with others still staged the strip's height does not
// change and there is nothing to ease.
//
// The height is MEASURED and passed in, never written down here, because the
// strip wraps — more thumbnails than fit on a line make it two lines tall, and a
// number in this file could only ever be right about one of those. The top
// padding travels with it: everything in this app is border-box, so `height: 0`
// on its own still leaves the strip its padding tall, and those last few pixels
// would then vanish in one frame after all the rest had eased away, which is the
// snap in miniature.

export const THUMB_DROP_SCALE = 0.8; // ~13px off the 64px square: a shrink, not a collapse

export function thumbDrop(): Keyframe[] {
  return [
    { opacity: 1, transform: "none" },
    { opacity: 0, transform: `scale(${THUMB_DROP_SCALE})` },
  ];
}

export function trayClose(heightPx: number, padTopPx: number): Keyframe[] {
  return [
    { height: `${heightPx}px`, paddingTop: `${padTopPx}px` },
    { height: "0px", paddingTop: "0px" },
  ];
}
