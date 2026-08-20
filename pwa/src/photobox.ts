// A photo's pixels, before they land: the seat one takes in the thread, the
// deadlined wait until it is actually DRAWN, and the entrance the picked-photo
// preview rides in on. main.ts does the DOM half of all three.
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
// screen. That is the one wait both places ride now.
//
// It is deadlined exactly as the size read was, and by the same number: instant
// feedback outranks a perfect first frame, so a photo that decodes slowly, or
// not at all, still goes and still previews — falling back to the old behaviour
// of filling itself in whenever it can.

/** how long anything waits on a photo's own pixels before going ahead without them */
export const SHOT_DRAW_MS = 350;

/** why the wait ended: drawn and safe to show, or one of the three give-ups */
export type DrawWhy = "drawn" | "load" | "error" | "late";

/** the slice of an image element the wait touches, so the tests need no DOM */
export interface Drawable {
  decode?(): Promise<unknown>;
  addEventListener(type: string, listener: () => void, opts?: { once: boolean }): void;
}

export function whenDrawn(img: Drawable, deadlineMs: number = SHOT_DRAW_MS): Promise<DrawWhy> {
  return new Promise<DrawWhy>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const settle = (why: DrawWhy): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(why);
    };
    // armed before the decode is asked for, so nothing below can outlive it
    timer = setTimeout(() => settle("late"), deadlineMs);
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
// moves rather than in a curve of its own. It fades up as it travels, from
// pixels it already has: whenDrawn holds the thumbnail off screen until then,
// so nothing here ever slides an empty frame in.

export const THUMB_SLIDE_PX = 18; // a short hop beside the 64px thumbnail it moves

export function thumbSlide(): Keyframe[] {
  return [
    { opacity: 0, transform: `translateX(-${THUMB_SLIDE_PX}px)` },
    { opacity: 1, transform: "none" },
  ];
}
