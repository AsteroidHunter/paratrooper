// The swipe-left peek at the message times: which pieces of the thread the
// pull moves, and how they let go of it.
//
// The pull used to move every row in the thread. One custom property on the
// thread (--peek) was read by every row, stamp and label in it, so each finger
// move restyled every element in the thread, repainted every row and, because
// every row carried a transform even at rest, re-layered all of them. In a
// thread a few hundred rows deep (a long scroll back through history) the
// motion rig measured 55 ms frames for the whole drag under its 4x slowdown,
// and the standing transforms cost 25 ms of re-layering on every frame that
// repainted anything at all: the chevron's glide and the reply's arrival too.
//
// So the pull now moves only the pieces on screen, and a margin either side of
// them. It cannot show any other: the drag holds the scroll still (the peek
// takes the touchmove's default), so nothing off screen can come into view
// while the finger is down. The pieces are picked up when the drag is decided,
// carry the transform (.peeked) only while the pull is in play, and put it
// down once the spring back has finished, so a resting thread has no transform
// on any row.

/** what the pull moves; the same list styles.css draws the rail against */
export const PEEK_PIECES = ".row, .stamp, .receipt, .typing, .empty, .sendfail";

/** the spring back: styles.css .thread .peeked, transition: transform 0.25s */
export const PEEK_HOME_MS = 250;

/** a piece as far as the pick-up needs it */
interface Placed {
  getBoundingClientRect(): { top: number; bottom: number };
}

/**
 * The pieces within `margin` of the band from `top` to `bottom` (viewport
 * coordinates, the thread's own box), in document order. The pieces arrive in
 * document order, which in the thread's one flex column is top to bottom, and
 * the walk runs from the newest up: a peek is nearly always at the bottom of
 * the conversation, so it stops after reading about a screen of rects instead
 * of the whole history.
 */
export function piecesInView<T extends Placed>(
  pieces: readonly T[],
  top: number,
  bottom: number,
  margin: number,
): T[] {
  const found: T[] = [];
  for (let i = pieces.length - 1; i >= 0; i--) {
    const r = pieces[i].getBoundingClientRect();
    if (r.bottom < top - margin) break; // above the band, and so is everything before it
    if (r.top <= bottom + margin) found.push(pieces[i]);
  }
  return found.reverse();
}

/** a piece as far as letting go needs it */
interface Held {
  classList: { remove(name: string): void };
  style: { getPropertyValue(name: string): string; removeProperty(name: string): string };
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
}

/**
 * Put the transform down once the pieces are home. Called at the release, when
 * the pieces have just been told 0px and the transition is carrying them
 * there. A piece a newer drag has picked up again (its pull is no longer 0px)
 * is that drag's to put down, and is left alone.
 */
export function releasePeek(
  pieces: readonly Held[],
  later: (fn: () => void, ms: number) => unknown = setTimeout,
): void {
  if (!pieces.length) return;
  later(() => {
    for (const piece of pieces) {
      if (piece.style.getPropertyValue("--peek") !== "0px") continue;
      piece.classList.remove("peeked");
      piece.style.removeProperty("--peek");
      if (!piece.getAttribute("style")) piece.removeAttribute("style");
    }
  }, PEEK_HOME_MS + 50);
}
