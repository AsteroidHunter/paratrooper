// The compose bar's widening: WHEN the bar's real layout may change, and how
// the close starts from the wide look. The motion itself is the stylesheet's
// (styles.css .cap, the keyboard-up rules on the ＋ and the textarea): from the
// viewport's report the ＋ shrinks and fades, the pill's face piece slides left
// and the text rides with it, all transform and opacity on the keyboard's own
// clock, keyed off the same .kb class the lift reads, so the bar's pieces and
// the bar itself leave on one frame and land on one frame. This module only
// decides two things:
//
//   1. The layout switch (.wide on the form). The wide layout is real: the ＋'s
//      width goes to 0, the pill grows into its slot, the text's right inset
//      absorbs the gain. It changes the focused textarea's box, and 0.3.89
//      showed what changing that box on the focus frame costs: on that build
//      every open put the keyboard up and iOS took it straight back to its
//      accessory strip with the box still focused (plans/compose-expand carries
//      the phone's trail). So the switch waits for three facts, in any order:
//      the shell has PROVEN the keyboard (.kb, the viewport's report, about
//      80ms after the tap), the bar's own transition has ENDED (the face
//      piece's transitionend, or the settle clock if that never fires), and the
//      lift has LANDED (shell.ts watchLiftLanding: the lift wrapper's own
//      transitionend, or the shell's settle clock). At that point the
//      transforms have the pill, the text and the ＋ exactly where the wide
//      layout puts them, so the switch moves no pixel. A keyboard that never
//      proves itself never gets a switch: the transforms just return when the
//      shell's signals lapse, which is the same picture as before.
//
//      The landing is the fact 0.3.129 was missing, and the caret paid for it.
//      Both clocks now start on the same frame, the viewport's report, so in
//      the ordinary open the face piece's transitionend and the lift's landing
//      arrive together and either may be last. They can still come apart: a
//      SECOND report inside the run re-times the lift and only the lift
//      (shell.ts retimeLift), so its landing moves later while the bar's own
//      clock runs on. That is the same shape as the case this gate was built
//      for, when the bar's transitionend arrived about 85ms before the lift
//      stopped and the old two-fact gate switched the focused box's real layout
//      while an ancestor transform was still in flight, with the lift 77 to
//      176px short of its seat (measured frame by frame in both engines). iOS
//      draws the caret from the focused box's layout geometry, not from the
//      page's paint, and a layout change under a
//      running ancestor transform is exactly the frame it re-places it from
//      geometry the lift has not been applied to: the caret lands below the
//      bar for a frame or two, right before the keyboard tops out. Waiting for
//      the landing also subsumes "the keyboard's FINAL height has been
//      reported": every late report re-aims the lift, and a re-aimed lift lands
//      again, later. No clock of this module's stands in for it — a proof
//      implies the shell armed a lift edge, and every armed edge lands.
//   2. The close (flip). The keyboard-up resting state is the wide layout with
//      no transforms, so a close cannot simply transition "back": the return
//      has to START from the wide look drawn in the resting layout. At the
//      shell's down edge the form goes wide -> flip (resting layout, keyboard-up
//      transforms, no transition), that style is flushed, and the class comes
//      off, so the base rules' transitions run from the wide look to rest on
//      the keyboard's clock from the same frame the lift leaves. The classic
//      first-last-invert-play, with the flush doing the invert.
//   3. The caret's hold across the rise. 0.3.131 made the switch wait for the
//      lift to stop and gave the text box a standing compositor layer, and on
//      the phone that took the caret below the bar from every open down to an
//      occasional one — the same place the sign-in card ended up (shell.ts
//      createGateFlight, which carries the mechanism in full). The caret on
//      iOS is a UIKit view placed from a rect the page reported, and the page
//      cannot make that rect fresh while an accelerated transition runs;
//      WebKit freezes the page-side value until the end and fixes the caret up
//      afterwards, a beat later. Nothing the page can do makes it fresh. What
//      it can do is draw no caret from a rect it knows is stale: the sheet
//      paints the caret transparent (styles.css `.compose.nocaret textarea`)
//      and this module says when.
//        On from the shell's up edge, which is the focus tap's own style pass,
//      the same one .focusing lands in — a colour is paint, so this changes no
//      layout and the 0.3.89 rule is untouched. Off one frame after the layout
//      switch, so the caret's FIRST paint is at the final geometry, and then a
//      beat after that frame (CARET_CATCHUP_MS, measured off the owner's own
//      60fps recording for the card: the caret was right from the third frame
//      after a landing). And off at once on every other way a rise can end —
//      the down edge, whether that is a close or a keyboard that never proved
//      itself, a blur, and a form rebuilt under it — so the caret can never
//      stay hidden. Transparent, not display or visibility: the box keeps its
//      focus, its keyboard and its typing, characters typed during the rise
//      land as they always did, and a tap that placed a caret (tapcaret.ts)
//      still placed it.
//        And the release re-places that caret. This is the one thing 0.3.135
//      was missing, and it cost the tap into a box that already held text: on
//      that path, and only that path, the app writes the selection ITSELF
//      (shell.ts focusComposerTap -> setCaret -> setSelectionRange), about a
//      millisecond after this hold lands, so the last selection the engine is
//      handed for the whole session is one made while the caret was
//      transparent. Taking the colour back off the box afterwards did not
//      reach the caret the engine had already issued from it: the box carried
//      the right offset — typed characters landed exactly where the finger
//      had — with nothing drawn, until a second tap made the engine place a
//      caret of its own. So the release restores the colour, flushes it, and
//      writes the selection back exactly where it already is. Nothing moves;
//      the engine simply issues the caret again, this time from a box whose
//      caret has a colour. Measured, both engines: the empty box never writes
//      a selection at all, the box with text writes one at +1.1ms under the
//      hold, and that is the whole difference between the two paths.
//
// Same shape as the shell's other decisions: a pure core with injected
// effects (unit-tested on a plain clock), and one binder that hangs it on the
// DOM.

import { CARET_CATCHUP_MS, LIFT_SETTLE_MS } from "./shell";

export interface WidenDeps {
  /** put the wide layout on, or take it off without a motion (a reset) */
  setWide(on: boolean): void;
  /** the close's first frame: rest layout + the wide look, flushed, released */
  flip(): void;
  /** paint the caret transparent, or give it back. A colour: no layout, ever. */
  setCaretHidden(on: boolean): void;
  /**
   * Write the box's selection back exactly where it already is, so the engine
   * issues its caret again from the colour the box now has. Only ever called
   * with the colour already restored and flushed, and only on the release: the
   * other ways out of a rise end with no caret to re-place.
   */
  reassertCaret(): void;
  /** a clock: run `fn` after `ms`, and hand back the way to call it off */
  wait(ms: number, fn: () => void): () => void;
  /** the next animation frame, and the way to call it off */
  frame(fn: () => void): () => void;
}

/**
 * The backstop for a transition that never says it ended (an element rebuilt
 * mid-flight, a tab in the background): the shell's own settle window, so the
 * bar and the lift give up on the same clock.
 */
export const WIDEN_SETTLE_MS = LIFT_SETTLE_MS;

/**
 * The beat between the switch's first paint and the caret coming back: the
 * phone's own catch-up, measured for the sign-in card and reused here rather
 * than guessed at a second time (shell.ts owns the number).
 */
export const WIDEN_CARET_MS = CARET_CATCHUP_MS;

export interface WidenState {
  up: boolean;
  proven: boolean;
  ended: boolean;
  landed: boolean;
  wide: boolean;
  hidden: boolean;
}

export function createWiden(deps: WidenDeps) {
  let up = false; // the shell's keyboard signal: the tap's own .focusing OR .kb
  let proven = false; // the shell's .kb: the viewport reported a keyboard
  let ended = false; // the bar's own transition has finished, or the clock gave up
  let landed = false; // the lift's transform has stopped moving (shell.ts's landing)
  let wide = false; // the layout as applied
  let hidden = false; // the caret's hold, as the sheet was last told
  let callOff: (() => void) | null = null;
  let caretOff: (() => void) | null = null; // the release's frame, then its beat

  const dropClock = (): void => {
    callOff?.();
    callOff = null;
  };

  // the release, pending: one frame, then the beat. Called off by anything
  // that ends the rise before it runs.
  const dropRelease = (): void => {
    caretOff?.();
    caretOff = null;
  };

  const setHidden = (v: boolean): void => {
    if (v === hidden) return;
    hidden = v;
    deps.setCaretHidden(v);
  };

  /** the caret is the box's again, now, whatever the rise was doing */
  const show = (): void => {
    dropRelease();
    setHidden(false);
  };

  // the one rule: wide when, and only when, all four facts are in
  const settle = (): void => {
    if (up && proven && ended && landed && !wide) {
      wide = true;
      deps.setWide(true);
      // one frame, so the switch has painted and the caret's first appearance
      // is at the final geometry; then the phone's catch-up beat
      dropRelease();
      caretOff = deps.frame(() => {
        caretOff = deps.wait(WIDEN_CARET_MS, () => {
          caretOff = null;
          setHidden(false);
          // and in the same step, never on a clock of its own: the colour is
          // back, so the caret the engine was handed under the hold is
          // re-issued from it. On a box the app never wrote a selection into
          // this is the same two numbers written again and nothing happens.
          deps.reassertCaret();
        });
      });
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
        landed = false;
        // the caret goes here, in the rise's own style pass: from this frame
        // to the switch the page's caret rect is the pre-lift one and every
        // draw from it is wrong
        setHidden(true);
        // the backstop is the BAR's transition only. The landing has the
        // shell's own clock behind it and must not be guessed at here: a
        // report slower than this window (the trail's slowest genuine one was
        // 319ms) re-aims the lift, and a clock that called the landing in
        // would put the switch back inside the motion.
        callOff = deps.wait(WIDEN_SETTLE_MS, () => {
          callOff = null;
          ended = true;
          settle();
          // Nothing has reported a keyboard in the whole of this window, so
          // there is very likely no keyboard coming (a hardware one, or iOS
          // declining to present) and no switch to wait for. The shell's own
          // down edge is a second away (FOCUSING_MAX_MS) and a second with no
          // cursor in a focused box is worse than the flicker this holds off,
          // so the caret comes back here. Every genuine report in the trail
          // arrived long inside this window: median 80ms, nine in ten under
          // 151ms, the slowest 319ms. A report later than that lands with the
          // caret already back and the switch may flicker once — on a path
          // already outside everything that has ever been measured.
          if (!wide && !proven) show();
        });
        return;
      }
      // The down edge, and it is BOTH ends of the rise: a close from the wide
      // layout, and a rise the keyboard never answered, whose transforms the
      // sheet is already taking home. Either way the hold is over, before the
      // flip's flush so the two are one style pass.
      show();
      // From the wide layout the close is the flip; from a rise that never
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
    /**
     * The lift's landing (shell.ts watchLiftLanding), for the UP edge only: the
     * lift wrapper's own transitionend, or the shell's settle clock behind it.
     * The close's landing is not the rise's and switches nothing. A keyboard
     * that changes height mid-session lands the lift again; the switch has
     * already happened by then and this writes nothing.
     */
    landed(isUp: boolean): void {
      if (!isUp) return;
      landed = true;
      settle();
    },
    /**
     * The box lost focus (the binder's focusout). An unfocused box draws no
     * caret, so there is nothing left to hold, and the hold must not sit on a
     * box waiting for a switch that a blurred rise will never reach. The
     * shell's down edge follows and does the rest.
     */
    blurred(): void {
      show();
    },
    /** a fresh form (renderChat rebuilds the bar): nothing is wide, nothing is pending */
    reset(): void {
      dropClock();
      show(); // the hold belonged to the form that has gone; the new one starts clear
      up = false;
      proven = false;
      ended = false;
      landed = false;
      wide = false;
    },
    state(): WidenState {
      return { up, proven, ended, landed, wide, hidden };
    },
  };
}

export type Widen = ReturnType<typeof createWiden>;

/** the three class names the sheet reads, written once */
export const WIDE_CLASS = "wide";
export const FLIP_CLASS = "flip";
export const NOCARET_CLASS = "nocaret";

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
    setCaretHidden: (on) => lookup()?.classList.toggle(NOCARET_CLASS, on),
    reassertCaret: () => {
      const box = lookup()?.querySelector<HTMLTextAreaElement>("textarea");
      // not a guard against timing: an unfocused box has no caret to issue,
      // and a selection write into one would mean nothing
      if (!box || box.ownerDocument.activeElement !== box) return;
      const { selectionStart: from, selectionEnd: to, selectionDirection: way } = box;
      if (from === null || to === null) return;
      // one computed read on the box, which is the same flush the close's
      // invert uses: it settles the class removal above into the engine's
      // style before the selection write below, so the caret is issued from
      // this frame's colour rather than the hold's
      flush(box);
      // the same two numbers and the same direction: the selection does not
      // move, the engine just draws it again
      box.setSelectionRange(from, to, way ?? undefined);
    },
    wait: (ms, fn) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
    frame: (fn) => {
      const id = requestAnimationFrame(fn);
      return () => cancelAnimationFrame(id);
    },
  };
}

/**
 * Hang the core on a freshly rendered bar: the face piece's transitionend is
 * the "ended" fact (its transform only — the visibility entry ends too, and is
 * not the motion), a focusout gives the caret straight back, and a rebuilt form
 * starts from nothing.
 */
export function bindWiden(form: HTMLElement, widen: Widen): void {
  widen.reset();
  const cap = form.querySelector<HTMLElement>(".cap");
  cap?.addEventListener("transitionend", (e) => {
    if (e.target !== cap || e.propertyName !== "transform") return;
    widen.ended();
  });
  // focusout, not blur: blur does not bubble, and the bar is what is bound.
  // The shell's down edge follows within its focusing window and finishes the
  // rise; this is only so the hold cannot outlive the focus it was taken for.
  form.addEventListener("focusout", () => widen.blurred());
}
