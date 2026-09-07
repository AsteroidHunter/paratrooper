// The compose bar's widening: WHEN the bar's real layout may change, and how
// the close starts from the wide look. The motion itself is the stylesheet's
// (styles.css .cap, the keyboard-up rules on the ＋ and the textarea): from the
// focus tap the ＋ shrinks and fades, the pill's face piece slides left and the
// text rides with it, all transform and opacity on the keyboard's own clock,
// keyed off the same .focusing/.kb classes the lift reads. This module only
// decides two things:
//
//   1. The layout switch (.wide on the form). The wide layout is real: the ＋'s
//      width goes to 0, the pill grows into its slot, the text's right inset
//      absorbs the gain. It changes the focused textarea's box, and 0.3.89
//      showed what changing that box on the focus frame costs: on that build
//      every open put the keyboard up and iOS took it straight back to its
//      accessory strip with the box still focused (plans/compose-expand carries
//      the phone's trail). So the switch waits for two facts, in either order:
//      the shell has PROVEN the keyboard (.kb, the viewport's report, about
//      80ms after the tap) and the bar's own transition has ENDED (the face
//      piece's transitionend, or the settle clock if that never fires). At that
//      point the transforms have the pill, the text and the ＋ exactly where
//      the wide layout puts them, so the switch moves no pixel. A keyboard that
//      never proves itself never gets a switch: the transforms just return when
//      the shell's signals lapse, which is the same picture as before.
//   2. The close (flip). The keyboard-up resting state is the wide layout with
//      no transforms, so a close cannot simply transition "back": the return
//      has to START from the wide look drawn in the resting layout. At the
//      shell's down edge the form goes wide -> flip (resting layout, keyboard-up
//      transforms, no transition), that style is flushed, and the class comes
//      off, so the base rules' transitions run from the wide look to rest on
//      the keyboard's clock from the same frame the lift leaves. The classic
//      first-last-invert-play, with the flush doing the invert.
//
// Same shape as the shell's other decisions: a pure core with injected
// effects (unit-tested on a plain clock), and one binder that hangs it on the
// DOM.

import { LIFT_SETTLE_MS } from "./shell";

export interface WidenDeps {
  /** put the wide layout on, or take it off without a motion (a reset) */
  setWide(on: boolean): void;
  /** the close's first frame: rest layout + the wide look, flushed, released */
  flip(): void;
  /** a clock: run `fn` after `ms`, and hand back the way to call it off */
  wait(ms: number, fn: () => void): () => void;
}

/**
 * The backstop for a transition that never says it ended (an element rebuilt
 * mid-flight, a tab in the background): the shell's own settle window, so the
 * bar and the lift give up on the same clock.
 */
export const WIDEN_SETTLE_MS = LIFT_SETTLE_MS;

export interface WidenState {
  up: boolean;
  proven: boolean;
  ended: boolean;
  wide: boolean;
}

export function createWiden(deps: WidenDeps) {
  let up = false; // the shell's keyboard signal: the tap's own .focusing OR .kb
  let proven = false; // the shell's .kb: the viewport reported a keyboard
  let ended = false; // the bar's own transition has finished, or the clock gave up
  let wide = false; // the layout as applied
  let callOff: (() => void) | null = null;

  const dropClock = (): void => {
    callOff?.();
    callOff = null;
  };

  // the one rule: wide when, and only when, all three facts are in
  const settle = (): void => {
    if (up && proven && ended && !wide) {
      wide = true;
      deps.setWide(true);
    }
  };

  return {
    /** the shell's keyboard edge (watchKeyboard): up at the tap, down at the close */
    keyboard(isUp: boolean): void {
      if (isUp === up) return;
      up = isUp;
      dropClock();
      if (isUp) {
        ended = false;
        callOff = deps.wait(WIDEN_SETTLE_MS, () => {
          callOff = null;
          ended = true;
          settle();
        });
        return;
      }
      // the close. From the wide layout it is the flip; from a rise that never
      // reached the layout (unproven, or still moving) the sheet's own
      // transitions take the bar home and there is nothing to switch.
      if (wide) {
        wide = false;
        deps.flip();
      }
    },
    /** the shell's .kb edge (watchKeyboardProven) */
    proven(isProven: boolean): void {
      proven = isProven;
      settle();
    },
    /** the face piece's own transitionend for its transform, from the binder */
    ended(): void {
      ended = true;
      settle();
    },
    /** a fresh form (renderChat rebuilds the bar): nothing is wide, nothing is pending */
    reset(): void {
      dropClock();
      up = false;
      proven = false;
      ended = false;
      wide = false;
    },
    state(): WidenState {
      return { up, proven, ended, wide };
    },
  };
}

export type Widen = ReturnType<typeof createWiden>;

/** the two class names the sheet reads, written once */
export const WIDE_CLASS = "wide";
export const FLIP_CLASS = "flip";

/**
 * The effects on the live form. `lookup` rather than an element: renderChat
 * rebuilds the bar, and a decision made against a form that has since been
 * replaced must land on the one on screen. The flush is the invert step: with
 * .flip on, one computed read of each moving piece makes that state the
 * before-change style, so taking the class off starts the transitions from
 * the wide look rather than from rest. Three reads, one per piece, so no
 * engine's partial style update can leave one of them unflushed.
 */
export const FLIP_PIECES: readonly string[] = [".cap", "textarea", ".attach"];

export function composeWidenDeps(
  lookup: () => HTMLElement | null,
  // the one computed read that makes the flip state the before-change style;
  // injectable so the sequence is testable where there is no engine
  flush: (el: HTMLElement) => void = (el) => void getComputedStyle(el).transform,
): WidenDeps {
  return {
    setWide: (on) => lookup()?.classList.toggle(WIDE_CLASS, on),
    flip: () => {
      const form = lookup();
      if (!form) return;
      form.classList.remove(WIDE_CLASS);
      form.classList.add(FLIP_CLASS);
      for (const sel of FLIP_PIECES) {
        const el = form.querySelector<HTMLElement>(sel);
        if (el) flush(el);
      }
      form.classList.remove(FLIP_CLASS);
    },
    wait: (ms, fn) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
  };
}

/**
 * Hang the core on a freshly rendered bar: the face piece's transitionend is
 * the "ended" fact (its transform only — the visibility entry ends too, and is
 * not the motion), and a rebuilt form starts from nothing.
 */
export function bindWiden(form: HTMLElement, widen: Widen): void {
  widen.reset();
  const cap = form.querySelector<HTMLElement>(".cap");
  cap?.addEventListener("transitionend", (e) => {
    if (e.target !== cap || e.propertyName !== "transform") return;
    widen.ended();
  });
}
