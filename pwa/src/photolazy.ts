// History photos load when the reader comes near them, never all at once.
//
// Every photo in a replayed thread used to get its source the moment its row
// was built, so a thread with a hundred photos in it opened a hundred thumb
// fetches in one breath. They queue behind each other on the one connection
// the phone gives the app, and the photo the reader is actually looking at
// waits behind photos that are twenty screens away. The url is PARKED here
// instead: the row is built, its box is reserved exactly as before, and the
// source goes on only when the wiring in main.ts says the reader has come
// within one screen of it (nearMargin below is that screen).
//
// Same shape as bootgate.ts and downbtn.ts: a pure ledger, unit tested with no
// DOM, under a thin wiring in main.ts. The ledger measures nothing and watches
// nothing itself. It is handed a photo to park, it is told when one has come
// near, and it answers whether that release actually put a source on the wire.
// The proximity signal is the caller's business: main.ts uses an
// IntersectionObserver rooted on the thread, which is its own scrolling box
// rather than the window.
//
// A browser with no IntersectionObserver has no proximity signal to give, so
// createPhotoQueue(null) parks nothing and every photo loads the moment its
// row is built. That is exactly the behaviour this file replaces, which is the
// right thing for a browser that cannot tell us where the reader is.

/** the reach, in screens of the thread's own height, on both sides of the view */
export const NEAR_SCREENS = 1;

/** a floor for the reach, so a thread that cannot be measured still reads ahead */
export const NEAR_MIN_PX = 400;

/** on the photo while its pixels are still missing: the grey box and its ring */
export const WAIT_CLASS = "waiting";

/**
 * How far beyond the thread's box a photo counts as near, in px. One screen of
 * lead time means a photo starts loading about a screen before it reaches the
 * eye, in either direction, which is what keeps an ordinary scroll up from
 * leaving a wall of grey boxes behind it.
 */
export function nearMargin(viewportH: number): number {
  return Math.max(Math.round(viewportH * NEAR_SCREENS), NEAR_MIN_PX);
}

/** the slice of an image element this ledger touches, so the tests need no DOM */
export interface Photo {
  src: string;
  classList: { add(c: string): void; remove(c: string): void };
}

export interface PhotoQueue<T extends Photo> {
  /** a history photo entered the thread: its url parks, its box waits */
  hold(img: T, src: string): void;
  /** the reader came near: the parked url goes on. True when it just did */
  release(img: T): boolean;
  /** the pixels landed, or the fetch failed: the grey box comes off */
  arrived(img: T): void;
  /** a fresh shell: the old thread's parked photos are gone with its DOM */
  reset(): void;
  /** photos still parked (the tests read this; nothing in the app does) */
  holding(): number;
}

export function createPhotoQueue<T extends Photo>(
  watch: ((img: T) => void) | null,
): PhotoQueue<T> {
  const parked = new Map<T, string>();
  return {
    hold(img: T, src: string): void {
      if (!src) return;
      img.classList.add(WAIT_CLASS); // grey from the first frame, loaded or not
      if (!watch) {
        img.src = src; // no proximity signal in this browser: load it now
        return;
      }
      parked.set(img, src);
      watch(img);
    },
    release(img: T): boolean {
      const src = parked.get(img);
      if (src === undefined) return false; // already released, or never parked
      parked.delete(img);
      img.src = src;
      return true;
    },
    arrived(img: T): void {
      parked.delete(img);
      img.classList.remove(WAIT_CLASS);
    },
    reset(): void {
      parked.clear();
    },
    holding: () => parked.size,
  };
}
