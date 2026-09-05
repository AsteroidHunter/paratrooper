// The reply's arrival — the dots' own bubble BECOMES the message.
//
// Two faults this replaces, both measured frame by frame against the real
// stylesheet with scroll anchoring off (desktop Chrome hides the first one
// outright: it anchors an inner scroller and silently restores the offset,
// which iOS Safari does not do for one, the same thing photofit.ts learned).
//
// THE DROP. applyEvent removed the dots BEFORE it built the reply, and the
// dots leaving is one of the three named content shrinks, so settleContent
// corrected the scroll for a thread that had lost the dots' 40px (a 32px
// bubble, its 6px top margin, the thread's 2px gap) and had not yet gained the
// message's height. The correction was right about the content it could see;
// the ORDER was wrong. The first frame after that task painted the whole
// conversation 40px lower, and the tail ride then had to climb back through
// those 40px plus the whole new bubble. He saw a yank down and up, about half
// a second of it. Writing the scroll a second time cannot fix that — the fix
// is that the height must never leave.
//
// THE SECOND MOTION. The dots vanished and a separate bubble arrived carrying
// its own entrance (pop-in: 200ms, a grow from 88%, an 8px rise, a fade). That
// entrance changes no layout height and no scroll range, so it is paint only,
// and it finished about 60% of the way through the ride. Two motions where
// Messages plays one.
//
// So: ONE BOX, from the first dot to the last word. The dots' bubble is never
// removed, which is what makes the height question go away rather than get
// answered — it grows from the dots' box to the message's box while the dots
// fade out inside it and the text fades in. He watched Messages on his own
// phone and asked for exactly this.
//
// Deliberately NOT a second element crossfaded underneath the first. He
// rejected that outright, and he is right: two boxes that fail to line up show
// a seam or a flicker at the join, and a morph whose whole claim is that
// nothing is replaced cannot afford to be caught replacing something.
//
// Deliberately NOT the send path's flight either, which was suggested and
// pushed back on. That machinery measures from one hard-coded seat — the
// compose field — and flies a fixed-position shell in the body precisely so
// the thread's scroller cannot clip it. Nothing here leaves the thread and
// nothing here travels: the box is already sitting in its seat, and only its
// SIZE changes. Aiming a flight the other way would mean inventing an origin
// for it to fly from, and its shell would then be a second box laid over the
// first, which is the seam again by another route.

import { barTextAlpha, bubbleTextAlpha, flightEase } from "./shift";

// The beat. Between the 200ms entrance it replaces and the send flight's
// 400ms, and for a stated reason rather than a taste: this does MORE than the
// entrance did, because it moves real layout rather than painting over it, and
// LESS than the flight does, because the flight crosses the screen and this
// crosses a few dozen pixels. A tenth of a second either side of it reads as
// either a flinch or a wait. The ease is the app's one curve, shared with the
// flight, so the two directions of the same conversation move alike.
export const ARRIVE_MS = 280;

// The crossfade is the send morph's, by name and unchanged. It is the same
// problem — two different layouts inside one box, which must never paint
// together at half strength — with the same answer, and it rides the clock
// rather than the eased curve, or the ease-out would finish both fades almost
// at launch. shift.ts owns the two numbers.
export const dotsAlpha = barTextAlpha;
export const inkAlpha = bubbleTextAlpha;

/** what the morph interpolates: the bubble's own box, and its row's top margin */
export interface ArriveBox {
  width: number;
  height: number;
  /** the row's margin-top — the dots carry 6px of their own, a row carries 10 (2 in a run) */
  margin: number;
}

/**
 * The box at eased fraction `e`. Real geometry, never a transform scale: a
 * scaled bubble stretches its own corner circles and its glyphs, and the
 * corners are the one part of this shape the eye is actually tracking. The
 * same reasoning shift.ts's morphBox is written on.
 */
export function arriveBox(from: ArriveBox, to: ArriveBox, e: number): ArriveBox {
  const mix = (a: number, b: number): number => a + (b - a) * e;
  return {
    width: mix(from.width, to.width),
    height: mix(from.height, to.height),
    margin: mix(from.margin, to.margin),
  };
}

// Whether a morph happens is two questions asked in two different places, so
// it is two functions. applyEvent knows the frame: are there dots on screen,
// is this the tail, is this session live rather than replaying history. Only
// the renderers know the bubble: an internal marker draws none at all, and a
// photo or a PR row draws one this cannot grow into.

/** the frame's half: is a morph even on the table for this apply? */
export function arrivalOffered(hasDots: boolean, isTail: boolean, live: boolean): boolean {
  return hasDots && isTail && live;
}

/**
 * The bubble's half: is this a shape the dots' box can become?
 *
 * Plain agent text, and the error bubble that is the same box in another
 * colour. A photo's seat is reserved at its own size before the row lands
 * (main.ts reserveShot) and a PR row is not one box but a bubble with a link
 * and a button inside it, so neither is a shape one small grey box grows into.
 * Both keep the old removal, which is still exactly right for them.
 */
export function arrivalShape(role: string, cls: string): boolean {
  return role === "agent" && (cls === "text" || cls === "error");
}

/** both halves, for the one caller that holds both and for reading the rule whole */
export function arrivalMorphs(
  hasDots: boolean,
  isTail: boolean,
  live: boolean,
  role: string,
  cls: string,
): boolean {
  return arrivalOffered(hasDots, isTail, live) && arrivalShape(role, cls);
}

/** what the morph needs from main.ts, so the arithmetic above can be read without one */
export interface ArrivalPorts {
  /** the thread re-takes its own bottom, instantly, in THIS frame */
  pin(): void;
  /** the morph is over and the bubble is an ordinary bubble again */
  done(): void;
}

/** a running morph, so a caller can cut it short if the bubble stops existing */
export interface Arrival {
  cancel(): void;
}

/**
 * The dots as they stood at the handover, read before anything is written.
 *
 * `lit` is each dot's opacity at that instant, and the blink stops there. It
 * is deliberately frozen rather than carried on: the blink is the agent still
 * composing, and by the time this runs it has finished, so the honest thing is
 * for the wave to stop the moment the message exists. Freezing at the value
 * already on screen is also the only version with nothing to jump from — the
 * blink's own restart phase would flick a dot from 0.3 to 1 at exactly the
 * frame the eye is on it.
 */
export interface DotsSeat {
  box: ArriveBox;
  lit: readonly number[];
}

/**
 * Grow `bubble` from the dots' box to its own, with the dots fading out inside
 * it and `text` fading in.
 *
 * The element is ALREADY the message: main.ts handed the dots' own div to
 * rowEl, so by the time this runs the box is sitting in its final seat with
 * its final content, its width fit, and its run-continuation margin decided.
 * `seat` is the dots' box as it stood a moment before the handover.
 *
 * The start box is written synchronously, before this returns, so the first
 * paint of the new seat is the DOTS' size and not the message's — a frame of
 * the finished box would be the pop this exists to remove.
 *
 * The text is laid out at the width it will END at, inside a layer the growing
 * box uncovers. That is what stops the words re-wrapping line by line as the
 * box widens: the wrap the reader finally reads is the only one ever drawn.
 */
export function runArrival(
  row: HTMLElement,
  bubble: HTMLElement,
  text: string,
  seat: DotsSeat,
  ports: ArrivalPorts,
): Arrival {
  const from = seat.box;
  const rect = bubble.getBoundingClientRect();
  const style = getComputedStyle(bubble);
  const to: ArriveBox = {
    width: rect.width,
    height: rect.height,
    margin: parseFloat(getComputedStyle(row).marginTop) || 0,
  };
  const inner =
    to.width - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);

  const ink = document.createElement("span");
  ink.className = "arrive-ink";
  ink.style.width = `${Math.max(0, inner)}px`;
  ink.style.opacity = "0";
  ink.textContent = text;
  const veil = document.createElement("span");
  veil.className = "arrive-dots";
  for (const lit of seat.lit) {
    const dot = document.createElement("span");
    dot.style.opacity = String(lit);
    veil.appendChild(dot);
  }
  bubble.replaceChildren(ink, veil);

  const put = (e: number, f: number): void => {
    const box = arriveBox(from, to, e);
    bubble.style.width = `${box.width}px`;
    bubble.style.height = `${box.height}px`;
    row.style.marginTop = `${box.margin}px`;
    veil.style.opacity = String(dotsAlpha(f));
    ink.style.opacity = String(inkAlpha(f));
  };

  let raf = 0;
  let ended = false;
  const land = (): void => {
    if (ended) return;
    ended = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    // handed back exactly as renderAgentText would have left it: one text
    // node, no layer, no inline geometry, nothing of the morph still on it.
    // The fit's max-width is the stylesheet's business and stays.
    bubble.classList.remove("arriving");
    bubble.style.removeProperty("width");
    bubble.style.removeProperty("height");
    row.style.removeProperty("margin-top");
    // an emptied style attribute is still an attribute: a bubble handed back
    // with one is not the bubble renderAgentText would have left, and the fit
    // writes its own max-width onto whatever is there
    if (!bubble.getAttribute("style")) bubble.removeAttribute("style");
    if (!row.getAttribute("style")) row.removeAttribute("style");
    bubble.textContent = text;
    ports.done();
  };

  const t0 = performance.now();
  const step = (now: number): void => {
    raf = 0;
    if (!bubble.isConnected) return land(); // a replay took the seat mid-morph
    const f = Math.min((now - t0) / ARRIVE_MS, 1);
    // The curve is solved numerically for this loop, the same way the send
    // morph solves its own: a declarative animation cannot be driven alongside
    // a scroll write that has to land in the SAME frame as the height it is
    // answering for, so the box is written by hand and takes the browser's
    // bezier from shift.ts rather than from the stylesheet.
    put(flightEase(f), f);
    ports.pin();
    if (f >= 1) return land();
    raf = requestAnimationFrame(step);
  };

  put(0, 0); // the start box, before anything paints
  raf = requestAnimationFrame(step);
  return { cancel: land };
}
