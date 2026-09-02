// The iOS shell boundary: keyboard geometry, focus lifecycle, and file-picker
// sessions live HERE and nowhere else. Same discipline as the thread's event
// store: the world is the truth, the DOM is a projection, and every signal —
// whichever ones iOS deigns to fire, in whatever order — converges through one
// reconcile(). No handler owns choreography, so a skipped, duplicated, or
// stale event cannot strand shell state.
//
// iOS facts this module encodes (each cost a bug round; pinned in tests/):
// - iOS 26 presents the keyboard in THREE modes, apparently at random per tap
//   (device-proven, 2026-07-25 and 2026-07-30):
//     * overlay        — the layout viewport stays full height, only the
//                        visual viewport shrinks.
//     * window-shrink  — `innerHeight` shrinks WITH the visual viewport.
//     * shrink-AND-pan — innerHeight shrinks AND iOS slides the layout
//                        viewport up (vv.offsetTop ~362), carrying a
//                        four-edge-pinned shell's header off the screen.
//   The old regime chose a correction per mode off an innerHeight comparison
//   that transiently lies mid-animation, so the choice was latched per
//   session — and the modes still fought iOS mid-typing (the kb-vv counter
//   era, retired 2026-08). The regime after it sized the shell box FROM the
//   visual viewport (Telegram Web Z's vv-sized shell adapted to
//   position:fixed): height = vv.height while the keyboard was up, the full
//   screen again at the close, first glided, then held until the viewport
//   agreed, then stepped, with an overhang correction watching afterwards. It
//   was retired on 2026-09-02, after a recording of thirty-four closes read
//   frame by frame against the trail showed why no version of it could be
//   smooth: while the keyboard animates, the thread's scroll offset is the UI
//   process's to set, not the page's. A box that changes height at a keyboard
//   edge moves the end of the scroll range, the page then has to rewrite the
//   offset, and iOS either drops that write for the whole animation (the
//   messages freeze at the old offset, white opens under them, and the offset
//   handed back at the end is the snap) or applies it on the first frame (the
//   whole list jumps before the keyboard has moved). Holding, gliding, stepping
//   and correcting only chose between those two.
//   The regime NOW: the shell box never changes height at a keyboard edge.
//   While the keyboard is provably up the box is top: vv.offsetTop (the
//   shrink-and-pan correction, rewritten from fresh numbers on every vv event)
//   and height: the BASELINE full-screen height; at rest the vars are dropped
//   for the measurement-free four-edge pin, whose geometry the box already sits
//   on. What moves is a TRANSFORM: the message list, the photo drawer and the
//   compose bar sit in one wrapper (main.ts .lift, clipped by .liftclip at the
//   header's bottom edge) that translates up by the keyboard's inset less the
//   home-indicator gap the bar hugs the keyboard by, as a compositor transition
//   on the system keyboard's own clock and curve (styles.css --kb-anim). The
//   thread's box and its scroll offset are the same numbers with the keyboard
//   up or down, so there is nothing for the phone to drop or hand back, and the
//   close's transition starts at the focus loss, the moment the app learns of
//   it, 6 to 13ms before the viewport reports (device trail 2026-09-01). One
//   rule serves all three modes: an explicit baseline height keeps the shell
//   full-size when innerHeight shrinks, so the lifted bar lands at the bottom
//   of the visible area in overlay, window-shrink and shrink-and-pan alike.
//   "Is there a keyboard" stays measured against that baseline, captured while
//   no editor is focused, never innerHeight - vvHeight (that reads 0 in
//   window-shrink mode, and 10 of 14 taps landed there). The top of the lifted
//   list disappears under the header inside the clip, so once the open lands
//   the thread is given that much top padding with the scroll moved by the same
//   amount in the same frame, and it is taken back the same way once the close
//   lands (main.ts setLiftPad): never at an edge, where a scroll write is the
//   very thing this regime refuses.
// - Corrections run at CLOSE, never mid-typing (Telegram never fights the
//   keyboard): a window.scrollTo(0,0) conditional on displacement being
//   actually stuck — iOS 26 can leave vv.offsetTop nonzero after dismissal
//   (Apple forums 800125) and reports late values, so the pass re-reads and
//   retries once — plus the iOS 17/18 standalone stuck-small-viewport heal:
//   one display-none reflow when innerHeight stays short of the baseline
//   after the close settles (dev.to cederhook). ONE narrow exception exists
//   mid-typing, and it is not a correction of tracked state but a refusal to
//   track: the typing-time shove clear (shoveVerdict below) — the deploy-log
//   proof that "track everything" faithfully turned iOS's caret-reveal scroll
//   into a visible step per grown line, 412px piled up by close (2026-08-18).
//   That same caret-reveal scroll has a second way in, riding the keyboard's
//   own resize at an EDGE, where the shove decision does not apply. It is
//   refused in the same spirit and by the same standard: the edge writes the
//   fresh height and holds its top (edgeBoxTop below, 2026-08-21).
// - That caret-reveal scroll has a THIRD way in, the focusing tap itself, and
//   it is the only one no correction can reach: iOS paints the reveal through
//   part of the keyboard animation, before the app is given a turn at all
//   (about two opens in ten, 412px of document scroll under a 362px pan). The
//   one refusal the engine honours is preventScroll on the focus call, and it
//   never grants a tap that flag, so the app takes the focusing tap over and
//   makes the call itself. Only where a hand-made focus cannot lose the caret,
//   though: a box that does not already hold focus AND is either empty or has
//   just told the app which character the finger landed on (composerTapVerdict
//   below, measured by tapcaret.ts).
// - Dismissing the picker menu only LOOKS instant: WKFileUploadPanel keeps
//   tearing down natively for another ~0.5–2s, and a files.click() forwarded
//   inside that window is silently DROPPED by WebKit — the dead-＋-tap bug.
//   Deferring the click to the teardown signal does NOT work: shipped as
//   v0.1.16 and graded 0/7 on device, because the teardown's own trailing
//   window-refocus lands 1–3ms later and tears the fresh session straight
//   back down. The fix that works with WebKit instead of against it is to
//   present a BRAND-NEW input element inside the tap's own gesture — the
//   stale element is what the dying panel is bound to (widely-reported iOS
//   workaround). Trailing signals from the old session are then ignored by a
//   guard window, since a real dismissal cannot arrive that fast.
//   And the input's own cancel/change events fire at the DISMISSING TAP, not
//   at the teardown's end, so treating either as the session's end re-armed
//   the bar inside the dead window: the un-greyed ＋ invited a tap whose
//   anchor credit was already spoiled, and the menu opened centred on the
//   screen (the 2026-08-26 screenshot). The session therefore counts as over
//   only when attention comes back (the window refocus family below) or when
//   the expiry backstop fires; the input's events merely settle it.
// - While an editable is focused, a ＋ tap must preventDefault on pointerdown
//   (its own focus grab would otherwise collapse the keyboard mid-presentation);
//   from idle it must NOT (or iOS swallows the next focus tap). This bullet used
//   to add "and the menu anchors to a stale rect". That was the DEAD theory and
//   it is disproved: WebKit never sends the file input's rect to the UI process,
//   so no layout of ours, fresh or stale, can place the menu. Where the menu
//   opens is settled by the hit-test credit for the last physical touch and by
//   nothing else (plusClickVerdict below carries the live rule).

import { holdDiagRecord } from "./hold";
// TEMP DIAGNOSTIC (scroll-jank, scrolljank.ts owns the banner): activity
// stamps for jank attribution; both uses sit inside the probe block at the
// bottom of this file, a two-line span around each stamped job
// TEMP DIAGNOSTIC (pick-timing, picktiming.ts owns the banner): the pick
// clock's zero. One call, at the top of the change listener in bindInputSignals
import { pickTimingStart } from "./picktiming";
// the character under a focusing tap, so a composer holding text can be taken
// over too instead of being left to the engine and its shove
import { caretOffsetAt } from "./tapcaret";

// --- pure decision core (unit-tested; no DOM, no iOS) --------------------------

export interface World {
  editorFocused: boolean; // textarea or non-file input holds focus
  fileFocused: boolean; // focus parked on the picker's file input
  baseline: number; // full-screen visual-viewport height, no keyboard
  vvHeight: number;
  vvTop: number;
}

export interface ShellTarget {
  kb: boolean; // keyboard provably up: size the shell from the visual viewport
  vvTop: number;
  vvHeight: number;
}

// a real keyboard shrinks the viewport by hundreds of px; smaller deltas are
// iOS 26's stale-viewport lie or a focus pan, and must read as "no keyboard"
export const MIN_KEYBOARD_PX = 100;

export function keyboardInset(baseline: number, vvHeight: number): number {
  const delta = baseline - vvHeight;
  return delta >= MIN_KEYBOARD_PX ? delta : 0;
}

export function computeShell(w: World): ShellTarget {
  return {
    kb: w.editorFocused && keyboardInset(w.baseline, w.vvHeight) > 0,
    vvTop: w.vvTop,
    vvHeight: w.vvHeight,
  };
}

// The shell box while the keyboard is up, and through the close's own settle
// window. top = vv.offsetTop translates a fixed shell into the visible region
// when iOS slides the layout viewport (shrink-and-pan); the height is the
// learned full-screen BASELINE and never the viewport's own. In the two modes
// where innerHeight shrinks with the keyboard a four-edge pin would shrink the
// shell with it, and the lift (styles.css .lift) needs the shell to stay
// full-size so the bar it carries lands exactly at the keyboard's top edge;
// in overlay mode the baseline and the pin are the same number anyway. The
// box therefore never changes size at a keyboard edge, which is the whole of
// the design (the header): a box that changed size moved the end of the
// thread's scroll range and made the page rewrite an offset the phone was not
// taking writes for. At rest there is no box: the four-edge pin needs no
// measurement, so cold-start height misreports can't touch it, and since the
// box is written at the pin's own geometry the drop back moves nothing. It
// stays through the close's window because the pin has no height to hand the
// close to, and because in shrink-and-pan the top must stand until iOS un-pans.
export function shellBox(
  t: ShellTarget,
  baseline: number,
  lifting: boolean,
): { top: number; height: number } | null {
  return t.kb || lifting ? { top: t.vvTop, height: baseline } : null;
}

// The keyboard's inset as the lift is driven by it: the learned baseline less
// the viewport, filtered through the same threshold "is there a keyboard" is,
// and 0 the moment the keyboard is no longer provably up. It is the one number
// the shell writes for the lift (--kb-inset); styles.css turns it into the
// translate, less the gap the bar hugs the keyboard by, which is the
// difference between the home-indicator clearance and the keyboard-time gap,
// both of them CSS lengths the engine resolves. The close therefore reads 0
// here at the focus loss, before the viewport has reported anything, and that
// is what starts the close's transition 6 to 13ms ahead of the report.
export function liftInset(t: ShellTarget, baseline: number): number {
  return t.kb ? keyboardInset(baseline, t.vvHeight) : 0;
}

// The box top at a keyboard edge, and the one case where the freshest number
// iOS published is not the truth (the whole-app yank, device trail 2026-08-21).
//
// When iOS presents the keyboard by SHRINKING the window instead of overlaying
// it, the document is left holding real scrollable overflow: innerHeight reads
// 400 against an 812 screen, so there are 412px for iOS to spend scrolling the
// WINDOW to reveal the caret. A reveal that rides the SAME event as the
// keyboard's own resize hands the edge a vv.offsetTop that describes a
// displacement about to be taken back again. The very next event's shove clear
// zeroes the scroll, and because the clear hands applyShell the APPLIED numbers
// the shell keeps standing at that large top until some later event rewrites
// it. The glide window is still open, so it does not snap: the whole app, from
// the very top, rides down to the large value and back. The trail states it in
// two lines, on both the old build and the new one: edge open with sy 412,
// vvTop 362, box top 362, then box top 0 twenty-four ms later, with a shove
// clear in between.
//
// So an edge fired on a scrolled window takes the keyboard's HEIGHT from the
// fresh read, which is the genuine geometry change the edge exists to track,
// and leaves the TOP standing where it already is. Nothing is written to fight
// iOS and nothing is guessed: the existing shove clear zeroes the scroll on the
// very next event, and the event after that publishes an honest offsetTop which
// the still-open glide animates to. An unscrolled window returns the fresh
// number untouched, so the shrink-and-pan correction the top exists for is
// exactly as it was.
//
// The two shapes this was chosen over, both replayed headless in WebKit and
// Chromium against the device script:
//   * clear the scroll at the edge, re-read offsetTop, size from the re-read.
//     It only works if iOS republishes the viewport inside the same task as the
//     scrollTo, and the trail says it does not: the un-panned offsetTop arrived
//     as its own event 24ms later. Replayed with that latency the yank came
//     back at full size, so it would have shipped and done nothing.
//   * top = max(0, vvTop - scrollY). It fixes the trail's own numbers only
//     because 412 is larger than 362 and the subtraction underflows into the
//     clamp. It treats the window scroll and the pan as one displacement, which
//     those same two numbers deny, and with a smaller reveal sitting on top of
//     a real pan (vvTop 362, scrollY 100) it writes 262, a number that was
//     never true of anything, and the shell travels to it and then on to 362.
export function edgeBoxTop(vvTop: number, scrollY: number, lastTop: number | null): number {
  return scrollY === 0 ? vvTop : (lastTop ?? 0);
}

// Close-time correction: displacement still on the books once the keyboard
// is gone. A window scroll is always displacement (nothing legitimate ever
// scrolls the window under the fixed shell); a leftover pan past 1px is the
// iOS 26 stuck-offsetTop regression (sub-pixel residue is measurement noise).
export function closeCorrectionNeeded(x: number, y: number, vvTop: number): boolean {
  return x !== 0 || y !== 0 || vvTop > 1;
}

// Mid-typing shove vs layout truth (the growth-step hole, typing test
// 2026-08-18): each composer line GROWTH makes iOS scroll the page one step
// to reveal the caret — the event batch reports window.scrollY nonzero and a
// vv.offsetTop jump with vv.height untouched (observed 362 -> 412) — and a
// shell that faithfully tracks that jump renders the shove as a sudden
// visible step, 412px piled up by close. While the keyboard is up and STEADY,
// a scroll-sourced offsetTop move is displacement, not geometry: clear it
// (window.scrollTo(0,0), same frame) and leave the shell box unwritten.
// Geometry the keyboard actually changed (vv.height moved: the rise, the
// close, an accessory bar) keeps being tracked, and the open/close edges
// never reach this decision.
//
// The guard on the fight is a BUDGET PER KEYSTROKE, not a delay. The retired
// kb-vv counter had no bound at all and re-fought the same scroll forever; the
// 500ms re-shove window that replaced it bounded the loop by time, which meant
// a second shove arriving while he was still typing the same line was let
// through on purpose, so roughly every other shove stuck and the error piled up
// line by line (his report: "after three to five lines the protection stops
// working"). Now every keystroke re-opens the budget (keystrokeStarted below),
// so the ordinary one-shove-per-key case is ALWAYS corrected on its own frame,
// and only a phone that re-shoves MAX_SHOVE_CLEARS times inside a single
// keystroke is yielded to (tracked, then cleaned up at close) so the two sides
// cannot loop.
export const MAX_SHOVE_CLEARS = 3;

export type ShoveVerdict = "track" | "clear" | "yield";

export function shoveVerdict(
  kbWasUp: boolean,
  kbStillUp: boolean,
  scrollX: number,
  scrollY: number,
  heightChanged: boolean,
  clearsThisKeystroke: number,
): ShoveVerdict {
  if (!kbWasUp || !kbStillUp) return "track"; // the edges are the shell's own business
  if (heightChanged) return "track"; // the keyboard/viewport truly moved
  if (scrollX === 0 && scrollY === 0) return "track"; // no scroll source: a pan is truth
  return clearsThisKeystroke < MAX_SHOVE_CLEARS ? "clear" : "yield";
}

// iOS 17/18 standalone stuck-small-viewport: after the keyboard closes the
// window can stay shrunken for good. Past this threshold below the learned
// full-screen baseline, one display-none reflow on the shell root heals it.
export const HEAL_THRESHOLD_PX = 4;

export function healNeeded(baseline: number, innerHeight: number): boolean {
  return baseline - innerHeight > HEAL_THRESHOLD_PX;
}

// ＋ pointerdown: should the tap preserve existing focus? Yes while an editor
// is up (keep the keyboard) or while focus is parked on the file input (a
// prevented tap still delivers its click — device-proven — so the picker
// re-presents instead of the tap dying as a blur). Never from idle.
export function preservesFocus(w: World): boolean {
  return w.editorFocused || w.fileFocused;
}

// The composer's FOCUSING tap, and the one thing iOS does with it that the app
// cannot undo afterwards.
//
// When WebKit hands a text box focus from a tap it also runs its caret reveal:
// the UI process centres the focused box in the band above the keyboard, and
// for a composer at the bottom of an 812 tall document that clamps to the whole
// 412px there is to give (812 minus the 400 band). It is painted through part
// of the keyboard animation, before any script runs, so the shove clear above
// cannot get in front of it and stays what it is, a backstop. Roughly two
// keyboard opens in ten arrived shoved this way, and that is WITH the
// composer's focus blink already in place (styles.css, one opacity-0 frame at
// focus): this is a second lock on the same door rather than a replacement,
// and the blink stays because it also covers the per-keystroke reveals, which
// no focus call can reach.
//
// focus({ preventScroll: true }) is the one prevention the engine honours: the
// flag rides the focused element information into the UI process and the reveal
// returns on it before computing any geometry (WebKit bug 236584, Safari 15.5).
// A tap can never carry the flag, because the engine's own tap path focuses
// with default options, so the only way to get it onto the focusing tap is to
// refuse the engine's focus and do the focusing here.
//
// What that costs is everything else the engine's focus tap does, and the part
// that matters is the CARET: a refused tap places none, so the box would open
// with the caret wherever a scripted focus leaves it rather than where the
// finger landed. So the take-over is offered to exactly two kinds of tap, and
// the second one has to buy its way in:
//   - the box must not already hold focus. The reveal rides the focusing tap
//     alone, so a tap inside a focused box is left completely alone, and with
//     it every caret move, long press and selection drag.
//   - an EMPTY box is taken over outright. It has exactly one caret position,
//     so focusing it by hand lands the caret exactly where the tap would have.
//   - a box HOLDING TEXT is taken over only when the offset under the finger
//     was actually measured (tapcaret.ts, a laid out ruler and one rect per
//     character), and the caret is put there straight after the focus. When
//     that measurement cannot be made the tap goes back to the engine
//     untouched, shove and all, because a caret that jumps to the end of a
//     half written message would be a worse bug than the one this fixes. No
//     offset is ever assumed, defaulted, or rounded in from nothing: the
//     measurement answers with a character or it answers with nothing.
//   - the tap must be the primary button, so a right or middle click keeps
//     whatever the platform does with it.
// Nothing that focuses the composer without a tap reaches this decision, so a
// hardware keyboard and assistive technology are untouched by it.
export type ComposerTapVerdict = "intercept" | "caret" | "focused" | "text" | "aux";

export function composerTapVerdict(
  alreadyFocused: boolean,
  empty: boolean,
  primary: boolean,
  caretKnown: boolean,
): ComposerTapVerdict {
  if (!primary) return "aux";
  if (alreadyFocused) return "focused";
  if (empty) return "intercept";
  return caretKnown ? "caret" : "text";
}

// Tap-time choreography signal (the pop-then-expand fix): .kb latches only
// after the viewport provably shrinks, so keying the ＋-collapse/editor-widen
// off it starts the bar's move a whole keyboard-rise late — the bar pops
// AFTER the keyboard has landed instead of expanding while it rises. The
// focusing signal turns on synchronously with editor focus (styles.css keys
// the same choreography off .focusing as off .kb) and hands over to .kb the
// moment the keyboard proves itself; when no shrink follows inside
// FOCUSING_MAX_MS (hardware keyboard, or iOS declining to present) it lapses
// so the bar never sticks mid-state. Pure, so the lifecycle tests run on a
// plain clock.
export const FOCUSING_MAX_MS = 1000;

export function focusingActive(
  editorFocused: boolean,
  kb: boolean,
  sinceFocusMs: number,
): boolean {
  return editorFocused && !kb && sinceFocusMs < FOCUSING_MAX_MS;
}

// The system keyboard's animation, as the lift plays it. Apple reports 0.25s
// on keyboardAnimationDurationUserInfoKey, and styles.css --kb-anim carries
// that duration with the curve (the sources are cited there). A page gets no
// frames of the keyboard's motion, so the lift's transition plays the
// platform's curve on its own, and the settle window below OUTLASTS it: through
// the window the numeric box stays applied (the four-edge pin has no height to
// write, and in shrink-and-pan the top must stand until iOS un-pans), and at
// its end reconcile drops the vars, landing on the pin the box already sits on.
// The lift element's own transitionend closes the window early and exactly
// (liftLanded); this clock is the backstop for a transition that never fires
// one, such as an element rebuilt mid-flight.
export const KB_ANIM_MS = 250;
export const LIFT_SETTLE_MS = KB_ANIM_MS + 200;

// The teardown window cannot be shortened, survived, or recovered from (three
// shipped mechanisms and the v0.1.21 focus-cycle all falsified on device), so
// the bar WAITS it out visibly. The VISUAL off-state (styles.css `.settling`)
// runs for the whole picker session — from the ＋ tap that opens it through
// teardown-complete — so the bar never blinks off/on after a dismissal; it
// went off with the opening tap and fades back in when the cleanup ends. The
// TAP HOLD below is narrower: only during teardown, when a page tap is even
// possible — preventDefault on the capture path, so no focus change raises a
// keyboard the teardown's window-blur would kill mid-rise, and no ＋ click
// reaches the zone where WebKit silently drops it. Only the two
// picker-adjacent controls wait; the send button and the thread stay live.
export function holdsBarTap(
  tearing: boolean,
  targetEditable: boolean,
  targetPlus: boolean,
): boolean {
  return tearing && (targetEditable || targetPlus);
}

// The ＋ click's gate, deciding off the tap's own DOWN as well as the phase
// at click time. iOS places the picker menu centred on whatever element its
// own hit test credited the LAST PHYSICAL TOUCH to; the credit is fixed at
// the touch, and no JS after the fact can re-aim it (WebKit source, pinned in
// an earlier session). The plus stays hit-testable through the whole
// teardown, but a touch landing inside the window is HELD (holdsBarTap
// preventDefaults it), and teardown-complete (the refocus signal) can slip in
// between that touch and its click. A click-time phase check alone then let
// the comeback tap present: touch begun under the hold, click arriving right
// as the bar re-enables, menu centred on the full-width element the engine
// last credited, 64pt in from each screen edge on his 2026-08-26 screenshot,
// instead of on the ＋. So a tap whose down was held is swallowed whole,
// whatever the phase says by click time; the user's NEXT tap is credited to
// the ＋ and opens anchored there.
export type PlusClickVerdict = "open" | "tearing" | "held";

export function plusClickVerdict(tearing: boolean, downHeld: boolean): PlusClickVerdict {
  if (tearing) return "tearing";
  return downHeld ? "held" : "open";
}

// Picker lifecycle:
//   presented --settle()--> tearing --teardownComplete()--> idle
// settle() = "the native UI is gone from the screen" (page tap, refocus, …);
// teardownComplete() = "WebKit finished tearing the panel down".
// Only the hand-back signals (the window refocus family in initShell) and
// expireTearing's clock ever drive teardownComplete: the input's own
// cancel/change land at the dismissing tap itself, seconds before WebKit is
// done, and completing there is the centred-menu bug (see the header).
// A ＋ tap during "tearing" presents on a FRESH input inside its own gesture
// rather than queueing — see the header note; the queue-and-replay design
// graded 0/7 on device.
// SETTLE_GUARD_MS protects a just-opened session from the PREVIOUS session's
// trailing teardown signals, which land within a few ms. A real dismissal
// needs the user to see the menu and act, and was never observed faster than
// 430ms.
export const TEARDOWN_MAX_MS = 2500;
export const SETTLE_GUARD_MS = 250;

export function createPickerLifecycle(
  effects: { present: (fresh: boolean) => void; dismiss: () => void },
  now: () => number = () => performance.now(),
) {
  let phase: "idle" | "presented" | "tearing" = "idle";
  let tearStart = 0;
  let presentedAt = 0;
  const present = (fresh: boolean): void => {
    phase = "presented";
    presentedAt = now();
    effects.present(fresh);
  };
  return {
    isOpen: () => phase === "presented",
    isTearing: () => phase === "tearing",
    open(): "presented" | "refreshed" | "represented" {
      if (phase === "tearing") {
        if (now() - tearStart < TEARDOWN_MAX_MS) {
          // WebKit would drop a click on the element the dying panel owns;
          // hand it a new one, still inside this tap's user activation.
          present(true);
          return "refreshed";
        }
        phase = "idle"; // signal never came: nothing was tearing down
      }
      if (phase === "presented") {
        // a ＋ click while a sheet is supposedly showing is impossible (a
        // real sheet swallows page clicks) — that present was dropped.
        // Clean up and re-present inside THIS tap's user gesture.
        effects.dismiss();
        present(true);
        return "represented";
      }
      present(false);
      return "presented";
    },
    settle(): "settled" | "guarded" | "noop" {
      if (phase !== "presented") return "noop";
      // too soon to be a real dismissal: this is the previous session's
      // teardown arriving late. Ignoring it is what keeps the fresh present
      // alive (the v0.1.16 failure mode).
      if (now() - presentedAt < SETTLE_GUARD_MS) return "guarded";
      phase = "tearing";
      tearStart = now();
      effects.dismiss();
      return "settled";
    },
    teardownComplete(): "completed" | "noop" {
      if (phase !== "tearing") return "noop";
      phase = "idle";
      return "completed";
    },
    // the timer backstop's check. Signals normally end the window, but after a
    // DROPPED present (no native session ever existed) none will come, and a
    // held bar must never wait on luck. Pure and time-aware, so a stale or
    // duplicate timer firing is a no-op.
    expireTearing(): "expired" | "noop" {
      if (phase !== "tearing") return "noop";
      if (now() - tearStart < TEARDOWN_MAX_MS) return "noop";
      phase = "idle";
      return "expired";
    },
  };
}

// --- DOM layer: one reader, one writer, everything converges ------------------
// No DOM access at import time — window/document are only touched inside
// functions, so the pure core above imports cleanly in any environment
// (hold.ts's recorder is a pure array push outside the real shell, so its
// import at the top keeps that property).

function isEditable(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && t.matches("textarea, input:not([type='file'])");
}

let appEl: HTMLElement | null = null;
let fileEl: HTMLInputElement | null = null; // replaced on every fresh present
let plusEl: HTMLElement | null = null; // the ＋ button; held during the settling window
let onPick: (() => void) | null = null; // rebound with each fresh input

// The full-screen visual-viewport height, learned while no editor is focused.
// Everything keyboard-related is measured against THIS, never against a live
// innerHeight that iOS mutates mid-animation.
let baseline = 0;
let baselineWidth = 0;
// the shell box as applied (rounded), so an event with unchanged geometry
// writes and records nothing; null = at rest, on the four-edge pin
let appliedTop: number | null = null;
let appliedHeight: number | null = null;
// the viewport height the box was last applied under, so a mid-typing shove
// clear can hand applyShell the applied numbers and change nothing (the box's
// own height is the baseline now, which no viewport event moves)
let appliedVvHeight: number | null = null;
// the keyboard inset as written to --kb-inset: the lift's one driver
let appliedInset = 0;
// the applied keyboard state; the true->false edge is the close, and the
// close is the ONLY moment corrections may run
let kbUp = false;
let closeRetry: ReturnType<typeof setTimeout> | null = null;
// the correction budget (shoveVerdict's guard): how many shove clears this
// keystroke has already spent. Every keystroke resets it, so a keystroke that
// shoves once is always corrected.
let shoveClears = 0;
// when an editor last gained focus — the focusing signal's clock
let focusStartAt = -Infinity;
// the focusing class as applied, so its edges record to the trail once each
let appliedFocusing = false;
// the .kb class as applied; its edges (and only they) open the settle window
let appliedKb = false;
// the lift's settle window: the numeric box stays applied until this deadline,
// which the landing closes early and the clock closes at the latest
let liftUntil = 0;
let liftTimer: ReturnType<typeof setTimeout> | null = null;
let liftRun = 0; // one per edge; a landing belongs to the run that armed it
let liftLandedRun = 0; // the run whose landing has been recorded
let landedLift = NaN; // the translate the last landing read, so a re-aim mid-session lands again
let liftEl: HTMLElement | null = null; // the .lift wrapper, rebuilt by every chat render
let onLiftLanding: ((up: boolean, lift: number) => void) | null = null;
// the app's scroll-write counter (scrollghost.ts), read at the edge and at the
// landing so the kb-lift record can say whether anything wrote inside the
// keyboard's own animation
let readScrollWrites: (() => number) | null = null;
let liftWritesAtEdge = 0;
// "the keyboard is on its way up or already up", as applied: the focus tap's
// own signal ORed with the proven keyboard, so the up edge lands with the tap
// and the down edge only once the screen is really clear again. Watchers hear
// edges only (applyShell runs on every viewport event).
let appliedKeyboard = false;
let onKeyboard: ((up: boolean) => void) | null = null;

// Register the one listener for that edge. The jump chevron uses it: it must
// never be visible while the keyboard is up (downbtn.ts owns the rule).
export function watchKeyboard(cb: (up: boolean) => void): void {
  onKeyboard = cb;
}

// The lift wrapper (main.ts renders it around the thread, the drawer and the
// compose bar, and re-binds it on every render since the render rebuilds it).
// Its transitionend is the one exact signal that the keyboard's motion, as the
// page plays it, is over: the box can drop to the pin and the thread's top
// padding can change, neither of which may happen inside the motion.
export function bindLift(el: HTMLElement): void {
  liftEl = el;
  el.addEventListener("transitionend", (e) => {
    if (e.target !== el || e.propertyName !== "transform") return;
    liftLanded("end");
  });
}

// Register the one listener for a landing. main.ts uses it for the thread's
// reachability padding: `up` says which edge landed and `lift` is how far the
// wrapper is translated now, in px, read from its computed transform rather
// than re-derived from the inset, so the number is the engine's own.
export function watchLiftLanding(cb: (up: boolean, lift: number) => void): void {
  onLiftLanding = cb;
}

// Register the app's scroll-write counter (scrollghost.ts scrollWriteCount);
// unregistered, the landing record simply leaves the count off.
export function watchScrollWrites(read: () => number): void {
  readScrollWrites = read;
}

// the Y translate a computed transform carries; 0 for none. DOMMatrixReadOnly
// parses the matrix() string the engine reports, so no arithmetic of ours.
function matrixY(transform: string): number {
  return transform === "none" ? 0 : new DOMMatrixReadOnly(transform).f;
}

function readWorld(): World {
  const a = document.activeElement;
  const vv = window.visualViewport;
  const vvHeight = vv?.height ?? window.innerHeight;
  const editorFocused = isEditable(a);
  // rotation changes the full-screen height; forget what we learned
  if (window.innerWidth !== baselineWidth) {
    baselineWidth = window.innerWidth;
    baseline = 0;
  }
  // only a keyboard-free frame teaches the baseline, and only upward — a
  // shrunken viewport must never be mistaken for the full screen
  if (!editorFocused) baseline = Math.max(baseline, vvHeight, window.innerHeight);
  if (baseline === 0) baseline = Math.max(vvHeight, window.innerHeight);
  return {
    editorFocused,
    fileFocused: fileEl !== null && a === fileEl,
    baseline,
    vvHeight,
    vvTop: vv?.offsetTop ?? 0,
  };
}

// a .kb edge opens the settle window: the numeric box stays applied through it
// (styles.css #app.lifting), and the lift's own transitionend or, failing that,
// this clock closes it through liftLanded, which re-converges through the one
// writer. A stale or duplicate fire lands an already-landed edge, harmlessly.
function armLift(edge: "open" | "close", inset: number): void {
  liftUntil = performance.now() + LIFT_SETTLE_MS;
  liftRun += 1;
  liftWritesAtEdge = readScrollWrites?.() ?? 0;
  if (liftTimer) clearTimeout(liftTimer);
  liftTimer = setTimeout(() => {
    liftTimer = null;
    liftLanded("clock");
  }, LIFT_SETTLE_MS + 20);
  // TEMP DIAGNOSTIC (kb-lift, block at the bottom): the moment the transition
  // is armed and the inset it is armed with (0 on a close: the lift goes home);
  // the landing is its own record on the same channel
  holdDiagRecord("kb-lift", { edge, via: "arm", inset });
}

// The lift has landed: the transform's transition ended (bindLift), or the
// settle clock ran out on one that never said so. Both close the settle window
// so the next reconcile drops the box to the pin after a close, and both hand
// main.ts the landing for the thread's reachability padding, once per edge —
// or once more mid-session when the keyboard itself changed height (an
// accessory bar), which re-aims the lift and lands it again at a new value.
function liftLanded(via: "end" | "clock"): void {
  // the translate as the engine holds it now: negative while lifted, 0 at rest
  const y = liftEl ? matrixY(getComputedStyle(liftEl).transform) : NaN;
  if (liftLandedRun !== liftRun || (Number.isFinite(y) && y !== landedLift)) {
    liftLandedRun = liftRun;
    landedLift = y;
    // TEMP DIAGNOSTIC (kb-lift, block at the bottom): when the keyboard's
    // motion ended as the page played it, how far the wrapper stands lifted,
    // and whether any scroll write of the app's landed inside the motion, which
    // is the one thing the lift exists to make impossible
    holdDiagRecord("kb-lift", {
      edge: appliedKb ? "open" : "close",
      via,
      ms: px(edgeAge()),
      lift: px(y),
      writes: readScrollWrites ? readScrollWrites() - liftWritesAtEdge : -1,
    });
    onLiftLanding?.(appliedKb, Number.isFinite(y) ? Math.abs(y) : 0);
  }
  // The window closes here for an open, and for a close whose viewport already
  // reads whole and unpanned. A close the phone has not finished reporting
  // keeps the clock instead, so the box's top stands until iOS un-pans the
  // layout viewport (shrink-and-pan) rather than dropping to the pin ahead of
  // it; the clock's own fire closes it regardless.
  const w = readWorld();
  const whole = keyboardInset(w.baseline, w.vvHeight) === 0 && w.vvTop <= 1;
  if (via === "clock" || appliedKb || whole) liftUntil = 0;
  reconcile();
}

// THE one writer of shell presentation: four mode classes, the lift's inset
// and the measured box. styles.css owns what they mean (.kb derives the lift
// from --kb-inset and vanishes the ＋; .focusing runs that same bar choreography
// from the focus tap itself; .kb/.lifting size the shell from
// --shell-top/--shell-h; .settling greys the bar for the whole picker
// session). Every vv event lands here, so the box's top is always the freshest
// number iOS has published — no latch, nothing to retract — and the box's
// height is the baseline, which no vv event moves.
function applyShell(t: ShellTarget, settling: boolean): void {
  if (!appEl) return;
  // TEMP DIAGNOSTIC (kb-edge, block at the bottom): this call is the edge, so
  // the box written further down is the edge's own target rather than a
  // mid-session resize
  const atEdge = t.kb !== appliedKb;
  const inset = liftInset(t, baseline);
  // TEMP DIAGNOSTIC (kb-fall, block at the bottom): the last frame with the
  // keyboard still up, sampled on the close edge and BEFORE the class toggle
  // below starts the lift home — after it, the frame the motion is measured
  // against is gone
  if (!t.kb && appliedKb) fallEdge();
  if (t.kb && !appliedKb) riseEdge(); // TEMP DIAGNOSTIC (kb-rise): the same, mirrored
  if (t.kb !== appliedKb) {
    appliedKb = t.kb;
    armLift(t.kb ? "open" : "close", inset);
  }
  const lifting = performance.now() < liftUntil;
  const editorFocused = isEditable(document.activeElement);
  const focusing = focusingActive(editorFocused, t.kb, performance.now() - focusStartAt);
  if (focusing !== appliedFocusing) {
    appliedFocusing = focusing;
    // the off edge names its cause: the keyboard proved itself, the window
    // lapsed with no shrink (hardware keyboard), or focus simply left
    holdDiagRecord("kb-focusing", {
      phase: focusing ? "focus" : t.kb ? "kb" : editorFocused ? "expire" : "blur",
    });
  }
  appEl.classList.toggle("kb", t.kb);
  appEl.classList.toggle("settling", settling);
  appEl.classList.toggle("lifting", lifting);
  appEl.classList.toggle("focusing", focusing);

  // The lift's driver, written in the same style recalculation as the class
  // that reads it, so the transition is armed by the very write that moves the
  // value. A shove clear hands this function the applied numbers and so writes
  // nothing here; a keyboard that changed height mid-session (an accessory
  // bar) re-aims the lift, and the transition retargets from wherever it is.
  if (inset !== appliedInset) {
    appliedInset = inset;
    appEl.style.setProperty("--kb-inset", `${inset}px`);
  }

  // The box: top from the viewport while the keyboard is up and through the
  // close's window, height the baseline throughout, dropped for the pin once
  // the window ends. The height never changes at an edge, so no frame here can
  // move the end of the thread's scroll range (the header owns why).
  const box = shellBox(t, baseline, lifting);
  if (box) {
    const top = Math.round(box.top);
    const height = Math.round(box.height);
    if (top !== appliedTop || height !== appliedHeight) {
      appliedTop = top;
      appliedHeight = height;
      appEl.style.setProperty("--shell-top", `${top}px`);
      appEl.style.setProperty("--shell-h", `${height}px`);
      // the device's read-back for every box write the keyboard causes
      recordShellSize(top, height, atEdge);
    }
    appliedVvHeight = Math.round(t.vvHeight);
  } else if (appliedTop !== null || appliedHeight !== null) {
    const wasTop = appliedTop;
    const wasH = appliedHeight;
    appliedTop = null;
    appliedHeight = null;
    appliedVvHeight = null;
    appEl.style.removeProperty("--shell-top");
    appEl.style.removeProperty("--shell-h");
    // TEMP DIAGNOSTIC (shell-pin, block at the bottom): the numeric box is
    // gone and the four-edge pin takes over. The box was written at the pin's
    // own geometry, so this frame moves nothing; if a baseline had lied, this
    // is the frame it would snap, and nothing else in the trail marks it.
    recordShellPin(wasTop, wasH);
  }

  // last, so a watcher reading geometry sees this frame's box and not the
  // previous one
  const keyboard = t.kb || focusing;
  if (keyboard !== appliedKeyboard) {
    appliedKeyboard = keyboard;
    onKeyboard?.(keyboard);
  }
}

// --- close-time correction + heal: the only fights, and only after close ------
// One conditional pass on the close edge (that event's own numbers) and one
// re-read shortly after: visual-viewport values land late after a close
// (Martijn Hols), iOS 26 can leave offsetTop stuck nonzero (Apple forums
// 800125), and the old unconditional exit-snap was itself a mid-animation
// yank. The retry also carries the stuck-small-viewport heal — by then the
// dismissal animation is over, so a small innerHeight is stuck, not settling.
export const CLOSE_RETRY_MS = 350;

function correctionPass(phase: "close" | "retry"): void {
  const x = Math.round(window.scrollX);
  const y = Math.round(window.scrollY);
  const top = Math.round(window.visualViewport?.offsetTop ?? 0);
  const snap = closeCorrectionNeeded(x, y, top);
  // clears scroll AND pan on the unscrollable document — the same write the
  // old regime used, now conditional and close-only
  if (snap) window.scrollTo(0, 0);
  const heal = phase === "retry" && appEl !== null && healNeeded(baseline, window.innerHeight);
  if (heal && appEl) {
    // display:none forgets descendants' scroll positions; save and restore
    // them around the reflow so the heal can never yank the thread
    const scrolled = Array.from(appEl.querySelectorAll<HTMLElement>("*"))
      .filter((el) => el.scrollTop > 0)
      .map((el) => [el, el.scrollTop] as const);
    appEl.style.display = "none";
    void appEl.offsetHeight; // the forced reflow IS the heal
    appEl.style.display = "";
    for (const [el, st] of scrolled) el.scrollTop = st;
  }
  // TEMP DIAGNOSTIC (dom-census, block at the bottom): what the document really
  // holds at a close, alongside the kb-close record and once per close
  if (phase === "close") censusRecord();
  // every close leaves a record; the retry only when it acted
  if (phase === "close" || snap || heal) {
    holdDiagRecord("kb-close", {
      phase, x, y, top, snap, heal, ih: window.innerHeight, base: Math.round(baseline),
    });
  }
}

function keyboardClosed(): void {
  if (closeRetry) clearTimeout(closeRetry);
  shoveClears = 0; // a new session must not inherit a spent budget
  correctionPass("close");
  startEdgeProbe(); // TEMP DIAGNOSTIC (kb-fall, block at the bottom): the close, frame by frame
  closeRetry = setTimeout(() => {
    closeRetry = null;
    if (kbUp) return; // a new keyboard session owns the geometry now
    correctionPass("retry");
  }, CLOSE_RETRY_MS);
}

// iOS takes the keyboard when the picker's sheet appears and never gives it
// back, but the editor keeps DOM focus the whole session (device-proven: act=
// never leaves the textarea). Focus parked there makes the user's next tap on
// the editor a no-op — no focus change, so iOS has no reason to raise the
// keyboard — and it stays down until some unrelated tap happens to move focus.
// Dropping focus fixes that, but WHEN matters, and both guards below are bugs
// that shipped:
//   - only after teardown COMPLETES. The teardown's own window-blur lands up
//     to ~2s after the dismissing tap and kills a keyboard that is mid-rise,
//     so blurring on the dismissing tap just moved the failure to "pops up,
//     pops straight back down" (v0.1.18).
//   - only while no keyboard is up, or we close one the user already got back.
function releaseParkedEditor(): void {
  const active = document.activeElement;
  if (!isEditable(active)) return;
  if (computeShell(readWorld()).kb) return;
  (active as HTMLElement).blur();
}

// A keystroke re-opens the shove correction budget. Called from the capture
// phase in initShell so a re-rendered composer needs no rebinding, and from
// both beforeinput and keydown so keys that change no text (arrows, delete on
// an empty box) still count: iOS reveals the caret for those too.
function keystrokeStarted(): void {
  shoveClears = 0;
}

export function reconcile(): void {
  const w = readWorld();
  const t = computeShell(w);
  const wasUp = kbUp;
  kbUp = t.kb;
  // TEMP DIAGNOSTIC (kb-edge, block at the bottom): the three reads a close
  // edge cannot reconstruct once it has happened — the world it flipped FROM,
  // how long the phone had been publishing the same viewport height, and the
  // moment a viewport that lied at a close finally tells the truth. Every line
  // below assigns or records; none reads geometry, and none touches the target
  // the rest of this function acts on. It goes when that block goes, along
  // with the world split above (`computeShell(readWorld())` was one line).
  edgeWorldBefore = edgeWorld;
  edgeWorld = w;
  if (w.vvHeight !== vvHeightSeen) {
    vvHeightSeen = w.vvHeight;
    vvHeightAt = performance.now();
  }
  // the wait a stale close opened, closed by the first reading that agrees the
  // screen is whole again. It cannot fire on the close's own evaluation: that
  // one measured an inset, which is what armed it.
  if (staleCloseAt >= 0 && keyboardInset(w.baseline, w.vvHeight) === 0) {
    holdDiagRecord("kb-edge", {
      edge: "late",
      n: staleCloseRun,
      vvLateMs: Math.round(performance.now() - staleCloseAt),
    });
    staleCloseAt = -1;
  }
  // Typing-time shove backstop: while the keyboard is up and steady, a vv
  // move sourced from a window scroll (this same batch's scrollX/Y) is
  // cleared in this same frame and the box is NOT rewritten — the stable
  // target hands applyShell the applied numbers, so the write guard sees no
  // change and nothing moves. Every shove is corrected on the frame it lands,
  // never seen and undone later; scrollTo(0,0) refires scroll once with
  // everything already zero, so a clear cannot loop, and the per-keystroke
  // budget bounds a phone that keeps re-shoving (shoveVerdict owns the whole
  // decision). The record carries the budget spent, so the trail says whether
  // any keystroke needed more than one correction.
  let target = t;
  if (appEl) {
    const x = Math.round(window.scrollX);
    const y = Math.round(window.scrollY);
    const heightChanged =
      appliedVvHeight === null || Math.round(t.vvHeight) !== appliedVvHeight;
    const verdict = shoveVerdict(wasUp, t.kb, x, y, heightChanged, shoveClears);
    // TEMP DIAGNOSTIC (kb-rise, block at the bottom): en on both records below
    // is the edge counter the kb-edge record carries as n, so a clear names the
    // open it landed inside and frames, edge summary and clears join on one
    // timeline. It goes when that block goes.
    if (verdict === "clear" && appliedTop !== null && appliedVvHeight !== null) {
      shoveClears += 1;
      window.scrollTo(0, 0);
      target = { kb: t.kb, vvTop: appliedTop, vvHeight: appliedVvHeight };
      holdDiagRecord("kb-shove", { act: "clear", n: shoveClears, en: edgeRun, x, y, top: Math.round(t.vvTop) });
    } else if (verdict === "yield") {
      holdDiagRecord("kb-shove", { act: "yield", n: shoveClears, en: edgeRun, x, y, top: Math.round(t.vvTop) });
    }
    // The edges stay the shell's own business, and the open still reads the
    // keyboard's height from the fresh viewport for the lift: only the TOP an
    // edge writes is held back, and only when the window is scrolled under it
    // (edgeBoxTop owns the whole reason). This can never overlap the verdict
    // above, because shoveVerdict returns "track" at both edges by design, and
    // it can never touch the close edge, which writes no new box. scrollX plays
    // no part: a sideways scroll cannot inflate offsetTop.
    if (t.kb && wasUp !== t.kb) {
      target = { kb: t.kb, vvTop: edgeBoxTop(t.vvTop, y, appliedTop), vvHeight: t.vvHeight };
    }
  }
  // the visual off-state covers the whole session; the tap hold stays
  // teardown-only (see holdsBarTap)
  applyShell(target, picker.isOpen() || picker.isTearing());
  // corrections belong to the close edge alone — mid-typing the shell rides
  // the viewport (except a scroll-sourced shove, refused above) and never
  // rewrites tracked displacement (the retired counter's lesson)
  if (wasUp && !t.kb) keyboardClosed();
  // TEMP DIAGNOSTIC (kb-rise, block at the bottom): the raise, frame by frame.
  // The open edge has no bookkeeping of its own, since corrections belong to
  // the close alone, so arming the probe is the whole of it. The edge record's
  // `armed` therefore reads applyShell's work here against applyShell plus the
  // correction pass on the close.
  if (!wasUp && t.kb) startEdgeProbe();
}

const picker = createPickerLifecycle({
  present: (fresh: boolean) => {
    if (fresh) swapFileInput();
    fileEl?.click();
    // TEMP DIAGNOSTIC (pick-anchor, block at the bottom): the two rects. The
    // read sits after the click, an order kept from the disproved rect theory
    pickAnchorRecord(fresh);
    reconcile(); // the settling visual starts NOW, inside the opening tap
  },
  dismiss: () => {
    fileEl?.blur(); // parked focus is the tap-swallower; clear it on every path
    armTeardownExpiry();
    reconcile();
  },
});

// The window's end normally arrives as the refocus hand-back, but a dropped
// present produces none, and without a clock the bar would stay held until
// some unrelated signal happened by. expireTearing() carries the real check, so
// this timer can fire stale, duplicated, or into a later session, harmlessly.
// An expiry IS a completion, so it runs the same parked-focus release the
// refocus path runs; the release itself refuses to touch a live keyboard.
function armTeardownExpiry(): void {
  setTimeout(() => {
    if (picker.expireTearing() === "expired") {
      pickEndRecord("expiry"); // TEMP DIAGNOSTIC (pick-anchor, block at the bottom)
      reconcile();
      releaseParkedEditor();
    }
  }, TEARDOWN_MAX_MS + 50);
}

// Replace the file input with a virgin clone. The dying WKFileUploadPanel is
// bound to the old element, and a click on it inside the teardown window is
// dropped; a brand-new element is not bound to anything. Removing the old node
// also drops its listeners, so the old session's late cancel/change cannot
// reach the new one.
function swapFileInput(): void {
  const old = fileEl;
  const parent = old?.parentNode;
  if (!old || !parent) return;
  const next = old.cloneNode(false) as HTMLInputElement;
  next.value = "";
  parent.replaceChild(next, old);
  fileEl = next;
  bindInputSignals(next);
  // A forced layout kept from the DEAD theory that iOS anchors the menu to the
  // input's rendered rect. That theory is disproved: the rect never reaches the
  // UI process, so flushing layout here cannot aim the menu anywhere. The line
  // stays because taking it out is a change only a device can judge, and nothing
  // has shown it to matter either way. Treat it as a candidate for removal, not
  // as a load-bearing line.
  void next.offsetWidth;
}

// The input's own signals only SETTLE the session. Both fire at the
// dismissing tap while the native panel keeps tearing down for seconds, so
// completing here is what un-greyed the bar inside the dead window and
// produced the centred menu (the header's picker bullet). settle()'s dismiss
// effect arms the expiry backstop; completion itself waits for the hand-back
// signals in initShell or for that clock. The pick handler still runs at
// change, since the chosen files are ready the moment the event says so.
function bindInputSignals(input: HTMLInputElement): void {
  const sessionDone = (): void => {
    picker.settle();
    reconcile();
  };
  input.addEventListener("cancel", sessionDone);
  input.addEventListener("change", () => {
    // TEMP DIAGNOSTIC (pick-timing, picktiming.ts owns the banner): zero for the
    // whole pick clock, taken before anything else in this handler runs. This is
    // the app's earliest possible sight of the picker's confirm; everything
    // before it belongs to iOS and is invisible from here. A stamp only: it
    // assigns numbers and returns, so the session and pick paths below run
    // exactly as they did.
    pickTimingStart();
    sessionDone();
    onPick?.();
  });
}

/**
 * The tapped box, as the interception needs it: the facts the verdict is read
 * from and the two effects it has. Injectable for the same reason the picker
 * lifecycle's effects are, so the path an iPhone runs is the path the tests
 * run, minus a DOM.
 */
export interface TapTarget {
  focused: boolean;
  value: string;
  /**
   * The offset under the finger, measured now, or null when it could not be
   * measured at all. A thunk rather than a number because the measurement is
   * the one costly read on this path and most taps never need it.
   */
  caretAt(): number | null;
  focus(options: { preventScroll: boolean }): void;
  setCaret(offset: number): void;
}

/**
 * Do what the verdict says, and say what was done. The order is the whole
 * point: the refusal and the focus are the same turn of the same trusted
 * gesture, with nothing between them, so the keyboard still rises from the
 * user's tap and the reveal never gets a focus to hang itself off.
 *
 * The caret goes in on the far side of the focus, and the record after that.
 * Neither may sit between the tap and the keyboard on the one interaction the
 * whole app turns on: the record is only a name for the path this was focused
 * by, and a selection can only be set on a control that already holds focus.
 * Every step here is synchronous, so all of it is still the tap's own turn.
 */
export function focusComposerTap(
  target: TapTarget,
  primary: boolean,
  prevent: () => void,
): ComposerTapVerdict {
  const empty = target.value.length === 0;
  // The measurement is taken BEFORE the refusal, and only for the one tap
  // whose verdict turns on it: a primary tap into a box that holds text and
  // does not hold focus. Before, because the answer decides whether this tap
  // may be taken over at all; only there, because every other tap already has
  // its verdict and would be paying a layout read for nothing.
  const at = primary && !target.focused && !empty ? target.caretAt() : null;
  const verdict = composerTapVerdict(target.focused, empty, primary, at !== null);
  if (verdict === "intercept" || verdict === "caret") {
    prevent(); // the engine's own focus, and the caret reveal that rides it
    target.focus({ preventScroll: true });
    // after the focus, never between it and the refusal: nothing may come
    // between the tap and the keyboard on the one interaction the app turns on
    if (at !== null) target.setCaret(at);
  }
  // Every focusing tap is on the trail, named by what was decided: `intercept`
  // is the empty box, `caret` is the box holding text, carrying the offset the
  // caret was put at and the length it was put in, and `text` is a tap left to
  // the engine because no offset could be measured. A kb-focusing focus edge
  // with no tap record before it was focused by something that is not a tap; a
  // shove after a `text` record is a shove on a tap this rule deliberately
  // stood aside from; and a caret that lands somewhere wrong is a number in
  // the trail rather than only a thing that was felt.
  if (verdict === "intercept") holdDiagRecord("kb-focusing", { tap: verdict });
  else if (verdict === "caret" || verdict === "text") {
    holdDiagRecord("kb-focusing", { tap: verdict, at, of: target.value.length });
  }
  return verdict;
}

// The DOM half: which event carries the interception, and why that one.
//
// mousedown is the event that grants focus. The engine dispatches it, and only
// if no listener prevented it does it then focus the element under the finger
// and place the caret from that same hit test, so preventing it here stops the
// focus while the focus() call takes its place inside the same gesture. iOS
// only synthesises a mousedown for a gesture it has ALREADY ruled a tap, so a
// scroll, a long press and a selection drag never arrive here at all.
// touchstart was not used: preventing it takes the whole synthetic gesture with
// it. pointerdown was not used either: it fires when the finger lands, before
// the engine has decided what the gesture is.
//
// On the document and in the capture phase, like the keystroke listeners: the
// composer is rebuilt by every chat render, and a listener on the element
// itself would have to be rebound with it. The picker's tap hold sits ahead of
// this on pointerdown, and a prevented pointerdown produces no mousedown at
// all, so a tap held through a picker teardown still never focuses anything.
function composerTapListener(e: MouseEvent): void {
  const t = e.target;
  if (!(t instanceof HTMLTextAreaElement) || t.id !== "text") return;
  focusComposerTap(
    {
      focused: document.activeElement === t,
      value: t.value,
      caretAt: () => caretOffsetAt(t, e.clientX, e.clientY),
      focus: (options) => t.focus(options),
      setCaret: (at) => t.setSelectionRange(at, at),
    },
    e.button === 0,
    () => e.preventDefault(),
  );
}

export function initShell(el: HTMLElement): void {
  appEl = el;
  document.addEventListener("focusin", (e) => {
    if (isEditable(e.target)) {
      focusStartAt = performance.now();
      // a hardware keyboard produces no vv shrink, so the focusing window's
      // lapse must arrive by clock; stale or duplicate fires reconcile an
      // already-converged state, harmlessly
      setTimeout(reconcile, FOCUSING_MAX_MS + 20);
    }
    reconcile();
  });
  // one frame's grace on focusout: focus may be hopping between editables
  document.addEventListener("focusout", () => requestAnimationFrame(reconcile));
  // the composer's focusing tap, focused here with preventScroll instead of by
  // the engine, so iOS never runs the caret reveal that shoves the page
  // (composerTapVerdict owns which taps this may touch)
  document.addEventListener("mousedown", composerTapListener, true);
  // every keystroke in an editable re-opens the shove correction budget
  for (const type of ["beforeinput", "keydown"]) {
    document.addEventListener(
      type,
      (e) => {
        if (isEditable(e.target)) keystrokeStarted();
      },
      true,
    );
  }
  // TEMP DIAGNOSTIC (kb-edge, block at the bottom): stamp each viewport event's
  // own dispatch time BEFORE the handler that acts on it, so an edge record can
  // say how much of its delay was already spent before the app looked at all.
  // Registered first because listeners run in registration order; each one
  // assigns two numbers and touches nothing else.
  window.visualViewport?.addEventListener("resize", markViewportEvent);
  window.visualViewport?.addEventListener("scroll", markViewportEvent);
  window.visualViewport?.addEventListener("resize", reconcile);
  window.visualViewport?.addEventListener("scroll", reconcile);
  window.addEventListener("orientationchange", () => {
    baseline = 0; // relearn the full-screen height for the new orientation
    reconcile();
  });
  // Picker signals, page-level and permanent (they survive renderChat
  // re-renders). Window refocus is the one teardown-complete marker present
  // in every observed trace; the guard window inside settle() keeps it from
  // tearing down a session that opened microseconds earlier. pageshow and
  // visibility-to-visible are the SAME hand-back delivered through other
  // lifecycle paths (a restore from history, a return from another app), so
  // they stay completion signals alongside the refocus; these three and the
  // expiry backstop are now the ONLY completers, since the input's own
  // events land seconds before WebKit is done (bindInputSignals).
  window.addEventListener("focus", () => {
    picker.settle();
    const done = picker.teardownComplete() === "completed";
    if (done) pickEndRecord("focus"); // TEMP DIAGNOSTIC (pick-anchor, block at the bottom)
    reconcile();
    if (done) releaseParkedEditor();
  });
  window.addEventListener("pageshow", () => {
    picker.settle();
    if (picker.teardownComplete() === "completed") {
      pickEndRecord("pageshow"); // TEMP DIAGNOSTIC (pick-anchor, block at the bottom)
    }
    reconcile();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      picker.settle();
      if (picker.teardownComplete() === "completed") {
        pickEndRecord("visible"); // TEMP DIAGNOSTIC (pick-anchor, block at the bottom)
      }
      reconcile();
    }
  });
  // a tap landing in OUR page means the native UI is gone from the screen —
  // but NOT that teardown finished (the dismissing tap itself leaks through
  // ~0.5s before the refocus signal), so it only settles. And from that tap
  // until teardown-complete, ＋/editor taps are held (see holdsBarTap): the
  // settle() runs first, so the dismissing tap itself is already inside the
  // window and cannot focus an editor whose keyboard the teardown would kill.
  document.addEventListener(
    "pointerdown",
    (e) => {
      picker.settle();
      if (holdsBarTap(picker.isTearing(), isEditable(e.target), e.target === plusEl)) {
        e.preventDefault();
      }
    },
    true,
  );
  // TEMP DIAGNOSTIC (safe-area, block at the bottom): the device's own bottom
  // inset, once, so the --pad-b step the edge probe measures on either edge has
  // a fact to sit against
  recordSafeArea();
}

// The ＋'s two tap handlers: the shield prevents the pointerdown's focus grab
// under preservesFocus's rule and stamps the down-time phase, and the click
// refuses to reach open() for any tap the engine did not credit to the ＋
// (plusClickVerdict carries the whole rule).
let plusDownHeld = false; // the ＋ tap's own pointerdown phase, remembered to its click

function pickerTapShield(e: Event): void {
  // the capture-path hold has already run (document capture precedes this
  // target listener), so isTearing() here is the phase the hold decided on
  plusDownHeld = picker.isTearing();
  if (preservesFocus(readWorld())) e.preventDefault();
}

function pickerTapOpen(): void {
  const verdict = plusClickVerdict(picker.isTearing(), plusDownHeld);
  plusDownHeld = false; // one gesture, one verdict; a pointerless click reads a clean flag
  // Every guard-window tap is swallowed whole, both swallow verdicts alike.
  // A held tap still delivers its click (device-proven), but presenting from
  // it cannot work twice over: the click lands in the zone where WebKit
  // drops it (the falsified fresh-input path, 0/6 on device), and the
  // engine's anchor credit for the touch never went to the plus, so a
  // deferred present would centre the menu off the button (the shipped
  // defer-to-signal design graded 0/7). The user's next tap, once the bar
  // visibly re-arms at true completion, opens anchored on the plus.
  if (verdict !== "open") {
    // TEMP DIAGNOSTIC (pick-anchor, block at the bottom): the swallowed tap;
    // `held` tells it apart from the presents on the same channel
    holdDiagRecord("pick-anchor", { held: true, upMs: Math.round(performance.now()) });
    return;
  }
  picker.open();
}

// wire the compose ＋ button and file input; called per renderChat because the
// re-render recreates both elements. `pick` fires when files are chosen — it is
// re-attached to each fresh input, so the app's handler survives the swaps.
export function bindPicker(input: HTMLInputElement, button: HTMLElement, pick: () => void): void {
  fileEl = input;
  plusEl = button;
  onPick = pick;
  bindInputSignals(input);
  button.addEventListener("pointerdown", pickerTapShield);
  button.addEventListener("click", pickerTapOpen);
}

// The in-pill ↑ send button gets the same pointerdown shield as the ＋: its
// default focus grab is what collapsed the keyboard on every send. Prevented
// only while an editor (or the parked file input) holds focus — never from
// idle, per preservesFocus — and a prevented tap still delivers its click
// (device-proven above), so the form submit fires exactly as before. The send
// button stays OUT of holdsBarTap: it rides through the picker's settling
// window untouched (pinned).
export function bindSendShield(button: HTMLElement): void {
  button.addEventListener("pointerdown", (e) => {
    if (preservesFocus(readWorld())) e.preventDefault();
  });
}

// the current file input — it is replaced on fresh presents, so callers must
// never cache the element they were handed at bind time
export function currentFileInput(): HTMLInputElement | null {
  return fileEl;
}

// ===================== TEMP DIAGNOSTIC (remove after the keyboard-fall session) =====================
// Recorders for the open device bugs, riding the same trail as the rest of the
// probe (hold.ts's ring buffer, POSTed to /api/debug/holddiag and digested into
// the deploy logs by web/app.py). Every one of them READS: no class, style,
// scroll position or lasting node is written anywhere below, so the app behaves
// exactly as it did without them.
//
//   kb-fall     : the close, frame by frame. It has now answered the question
//   kb-rise       it was built for: --pad-b DID step from its keyboard value
//                 (0.5rem) to its full safe-area value in one frame while the
//                 shell had not moved at all (padB 8.5 then 34 with shellH
//                 still 400, pillBot 391.5 then 366), so the pill hopped up by
//                 the inset while everything around it slid. styles.css puts
//                 every reader of --pad-b on the shell's own glide clock, and
//                 the trail now shows padB easing across the frames in step
//                 with shellH. What it left uncovered was everything else: the
//                 RAISE was never sampled at all (only the close ran a probe),
//                 and neither edge recorded the shell's rendered TOP, which is
//                 the coordinate the shrink-and-pan mode moves by hundreds of
//                 pixels. Both edges now run ONE probe through one record
//                 builder, so the two motions are comparable line for line;
//                 only the channel name differs. shell-size samples once per
//                 viewport event, which is far too slow to catch either shape.
//                 Every frame also carries sy and vvTop now: a shoved open
//                 moved BOTH displacement sources (window scroll 412 with the
//                 viewport offset at 362 or 412) while the frames recorded
//                 neither, and the edge summary's one read can land before the
//                 shove does (one open read sx 0 sy 0 with its own clear ten
//                 ms later). And the raise keeps sampling to RISE_TRACE_MS on
//                 a timed stop, thinned past the dense head (riseKeeps),
//                 because that late shove and its correction land after the
//                 glide settles, where the old budget had already stopped; the
//                 close keeps its unchanged budget, since every observed shove
//                 rode an open.
//   kb-edge     : one record per keyboard edge, and the reason this session
//                 exists. The close trail says the bar's first painted frame
//                 lands 6 to 45ms after the edge, so its first visible move is
//                 0 to 141px of a 386px trip, and that the app's own
//                 bookkeeping for the edge took 1-3ms on the four closes that
//                 started gently and 8-12ms on the twenty-four that stalled.
//                 Both of those were FITTED out of timestamps a millisecond
//                 apart. This record states them: when the viewport event that
//                 carried the edge was dispatched, when the edge was detected,
//                 when the app finished the edge's bookkeeping, when the first
//                 frame started, when the probe read inside it, and how far
//                 each of the three moving quantities had actually travelled by
//                 then. Plus the numbers the edge decided on (viewport, window
//                 scroll, the box it wrote), because the double box write on
//                 the raise (top 412, then top 0 sixteen ms later, with a
//                 shove clear alongside) is an edge that fired on a
//                 scroll-displaced viewport and tracked it, and nothing records
//                 a tracked shove: shoveVerdict returns "track" at the edges by
//                 design and writes no kb-shove. That is what this record was
//                 built to catch, and it caught it; edgeBoxTop refuses it now,
//                 so a `sy` far from 0 with `boxTop` 0 on the same line is the
//                 refusal working rather than the bug repeating.
//                 The CLOSE now carries four more fields, for the white band
//                 that shows under the compose bar for about a second before
//                 the shell snaps to full height (closeMark and closeCause own
//                 the reasons). `cause` names which of the two inputs flipped
//                 the decision — the editor losing focus, the viewport growing
//                 back, or both in one evaluation — which `src` never could,
//                 since it names the event the evaluation arrived on and read
//                 "other" on six of eight production closes. `vvStale` says
//                 whether the viewport was STILL reporting a keyboard-sized
//                 screen at the instant the app decided the keyboard was gone
//                 (true on five of those six), with `vvBase` beside the head's
//                 own `vvH` so the subtraction is on the line. `vvHeldMs` is
//                 how long the viewport had been publishing that same number,
//                 which under a true `vvStale` is the upper bound on how long
//                 the band could have been up. And a stale close leaves one
//                 follow-up line on this channel, `edge: "late"` with the
//                 close's own `n` and a `vvLateMs`: how long after the edge
//                 the viewport finally admitted the full screen. It is a
//                 separate record rather than a delayed one because the edge
//                 record must not wait on the very viewport it is accusing.
//                 A close writes no new box at its own edge now (the box it
//                 has is the baseline-height one the open wrote, and the lift
//                 goes home instead), so its boxTop and boxH read null; the
//                 `inset` beside vvH is what the viewport still claimed at
//                 that instant, and the kb-lift records carry the motion.
//   shell-pin   : the one frame the shell leaves its numeric box for the
//                 four-edge pin, at the end of the lift's settle window. The
//                 box is written at the pin's own geometry (the baseline), so
//                 the frame moves nothing unless the baseline lied, and this
//                 is the one record that would say so.
//   pick-anchor : the file input's rect against the ＋ button's at the instant
//                 the picker presents. The pair was recorded to test the
//                 theory that iOS anchors WKFileUploadPanel to the INPUT's
//                 rendered rect. That theory is DEAD: WebKit never sends the
//                 rect to the UI process at all, and the panel opens centred
//                 on whatever element the hit test credited the last physical
//                 touch to, so a gap between these two rects explains
//                 nothing. The channel still earns its place through the
//                 other two records on it. A record carrying `held: true`
//                 instead of rects is a guard-window tap the ＋ click
//                 swallowed (plusClickVerdict): no present happened, so
//                 there are no rects to compare. And a record
//                 carrying `end` is a session's completion, named by the one
//                 signal that delivered it (focus, pageshow, visible or
//                 expiry), so a trail states whether real dismissals ride
//                 the refocus hand-back or fall to the backstop clock.
//   dom-census  : how many #app / .compose / .bar / .thread / mirror twins the
//                 document holds at each close. A screenshot showed what
//                 looked like two compose bars; a census that always reads 1
//                 turns "the phone composited a stale paint" from an
//                 inference into a measurement, and a 2 falsifies it outright.
//
// Plus one boot record, safe-area, carrying env(safe-area-inset-bottom) in
// pixels: the step size the frame probe is looking for is then a device fact
// rather than arithmetic over two records.
//
// The frame loop is the one part with a way to disturb what it measures, so it
// is read-only by construction: element lookups and the live computed style
// are resolved ONCE at the edge, the per-frame body only reads, one rect per
// element per frame serves every field taken off it, and kb-fall/kb-rise are
// deliberately left out of hold.ts's post-now list so thirty frames cannot
// churn thirty POST timers. A read pass inside rAF with no interleaved write
// forces at most the one style/layout the glide's animated top/height was
// going to need on that frame anyway.
//
//   kb-lift     : the lift's arm and landing, one record each per edge. The
//                 arm carries the inset the transition was armed with (0 on a
//                 close) and lands on the same frame as the edge record; the
//                 landing carries how the window closed (the transform's own
//                 transitionend, or the settle clock), how long after the edge,
//                 how far the wrapper stands lifted by the engine's own
//                 computed transform, and how many scroll writes the app made
//                 between the two — the number that has to read 0 for the
//                 design to be doing what it claims. The frames above carry
//                 the same translate per frame as `lift`, so the motion itself
//                 is on the trail beside the pill and thread edges it moves.
//
// TO REMOVE: delete this block plus the call sites above marked TEMP
// DIAGNOSTIC (the atEdge flag and the two edge samples in applyShell, the
// shell-size and shell-pin records in the same function, the kb-lift records in
// armLift and liftLanded along with the write counter they read
// (watchScrollWrites, liftWritesAtEdge), the census in correctionPass, the
// probe start in keyboardClosed and the mirror one in reconcile, reconcile's
// world/height/late-close stamp block along with the world split at its top —
// `const w = readWorld()` goes back to being `computeShell(readWorld())` — the
// en field on reconcile's two kb-shove records, the anchor record in the
// picker's present effect plus the held swallow's record in pickerTapOpen, the
// four pickEndRecord calls (the three hand-back handlers in initShell and the
// expiry backstop), the two markViewportEvent listeners and the safe-area probe
// in initShell), the watchFollowTail and watchScrollWrites wiring in main.ts,
// "pick-anchor", "kb-edge" and "kb-lift" in hold.ts's post-now list, and the
// kb-fall/kb-rise/kb-edge/kb-lift/shell-pin/dom-census/pick-anchor/safe-area
// names in web/app.py's digest filters.

/**
 * Frames one edge probe samples, on either edge: about 0.5s at 60fps. The
 * budget has to OUTLIVE the motion it is measuring, and the motion is longer
 * than the 0.25s transition: the shell holds its numeric box for the whole of
 * LIFT_SETTLE_MS and drops it for the four-edge pin about 470ms after the
 * edge at the latest, so a probe that stops at eighteen frames cannot see
 * whether the drop moved anything. The first eighteen frames are unchanged, so
 * trails recorded either side of this read against each other.
 */
export const EDGE_FRAMES = 30;

/**
 * The raise keeps sampling until about this long after its edge. The shove
 * this trace hunts can land AFTER the glide settles: one open read sx 0 sy 0
 * at its edge while its own shove clear proved the displacement fired ten ms
 * later, so a run that stops with the motion can miss the yank and its
 * correction entirely. The close keeps the plain EDGE_FRAMES window: every
 * observed shove rode an open.
 */
export const RISE_TRACE_MS = 1500;

/**
 * Callback cap on the raise's run, a backstop behind the timed stop: about
 * 180 callbacks cover the window at 120Hz, so the cap can only bite if the
 * clock misbehaves.
 */
export const RISE_FRAME_CAP = 200;

/** past the dense head the raise records every this-many callbacks */
export const RISE_TAIL_EVERY = 2;

/**
 * Whether callback i of a raise run records a frame: the first EDGE_FRAMES
 * record every callback, exactly the frames the old budget recorded, so old
 * and new trails read against each other; the tail then thins to every other
 * callback. The tail is there to place a late shove and its correction, which
 * are steps of hundreds of pixels, so half rate still names their frames and
 * a raise stays near sixty records instead of ninety against hold.ts's
 * six-hundred-event ring.
 */
export function riseKeeps(i: number): boolean {
  return i < EDGE_FRAMES || (i - EDGE_FRAMES) % RISE_TAIL_EVERY === 0;
}

/** a viewport-event stamp older than this cannot be the event that carried an edge */
export const EVT_FRESH_MS = 100;

/** what the census counts, and the label each count carries in the record */
export const CENSUS_SELECTORS: Record<string, string> = {
  app: "#app",
  compose: ".compose",
  bar: ".bar",
  thread: ".thread",
  mirror: "textarea[data-mirror='compose']",
};

// One frame of a keyboard edge, as the trail carries it, and the same shape on
// the raise and on the close, because two motions recorded through two builders
// could only be compared by trusting the builders. An alias rather than an
// interface so it hands straight to holdDiagRecord's Record<string, unknown>
// without a cast — only object literal types carry the implicit index
// signature that assignment needs.
//
// ms is when the probe READ, on the edge's own clock. fts is when the browser
// started the frame that read belongs to, on the same clock, and the two are
// not the same question: the gap between consecutive fts values is the frame
// spacing the compositor actually kept, while ms - fts is how much main-thread
// work sat between the frame starting and the probe getting to run. A close
// whose ms values are 33ms apart is a dropped frame if fts moved with them and
// a starved callback if it did not, and the trail could not tell those apart.
//
// sy and vvTop are the two displacement sources a shove moves: the window
// scroll and the visual viewport's own offset. The edge summary samples them
// once, at the edge, and that read can land before the shove does, so they
// ride every frame; both are plain reads of state the engine already
// computed, so neither can force a layout.
export type EdgeFrame = {
  ms: number;
  fts?: number;
  padB: number | null;
  shellH: number | null;
  shellTop: number | null;
  pillBot: number | null;
  thBot: number | null;
  st: number | null;
  sy: number | null;
  vvTop: number | null;
  lift: number | null;
  ft?: boolean;
};

/** the geometry reads a frame needs, injectable so the shape can be pinned */
export interface EdgeReader {
  padB(): number; // the RESOLVED --pad-b, in px
  shellH(): number;
  shellTop(): number; // the shell's rendered top: what shrink-and-pan moves
  pillBot(): number;
  thBot(): number;
  st(): number;
  sy(): number; // window.scrollY: one displacement source of a shove
  vvTop(): number; // visualViewport.offsetTop: the other one
  lift(): number; // the lift wrapper's live translateY: the motion itself, per frame
  fts(): number | undefined; // absent on the edge sample, which is not in a frame
  ft(): boolean | undefined; // absent when nothing registered a follow reader
}

/** the three clocks a start-of-motion stall is read from, all on the edge's own */
export interface EdgeTiming {
  armed: number; // the edge -> the app finished the edge's bookkeeping
  frame: number; // the edge -> the first probe frame's own start
  read: number; // the edge -> the read inside that frame
}

/** a rect, narrowed to what the anchor record needs */
export interface AnchorRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

// one decimal of a pixel: enough to see a sub-pixel glide step, short enough
// that a whole close still reads as one log line. A missing element reads null
// rather than a sentinel number no one could tell from a coordinate.
function px(n: number): number | null {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

/** assemble one frame's record; pure, so a test pins the field names */
export function edgeFrame(ms: number, r: EdgeReader): EdgeFrame {
  const frame: EdgeFrame = {
    ms: Math.round(ms),
    padB: px(r.padB()),
    shellH: px(r.shellH()),
    shellTop: px(r.shellTop()),
    pillBot: px(r.pillBot()),
    thBot: px(r.thBot()),
    st: px(r.st()),
    sy: px(r.sy()),
    vvTop: px(r.vvTop()),
    lift: px(r.lift()),
  };
  const fts = r.fts();
  if (fts !== undefined) frame.fts = Math.round(fts);
  const ft = r.ft();
  if (ft !== undefined) frame.ft = ft;
  return frame;
}

/**
 * The edge record: the head gathered at the edge itself (which edge, what the
 * viewport and the window scroll said, what box the shell was told to go to)
 * joined to the three clocks and to how far the three moving quantities had
 * really travelled by the first frame. dTop/dH/dPad are the stall in pixels,
 * already subtracted, so nobody has to fit a curve to find it: a raise or a
 * close that started gently reads a few px, one that held still and then
 * jumped reads a third of its trip.
 *
 * Pure and taking both frames rather than reaching for module state, so the
 * subtraction and the field names are pinned directly.
 */
export function edgeMark(
  head: Record<string, unknown>,
  timing: EdgeTiming,
  at0: EdgeFrame,
  at1: EdgeFrame,
): Record<string, unknown> {
  const moved = (a: number | null, b: number | null): number | null =>
    a === null || b === null ? null : px(a - b);
  return {
    ...head,
    armed: px(timing.armed),
    frame: px(timing.frame),
    read: px(timing.read),
    dTop: moved(at1.shellTop, at0.shellTop),
    dH: moved(at1.shellH, at0.shellH),
    dPad: moved(at1.padB, at0.padB),
  };
}

/**
 * Which of the two inputs flipped the close, read from the two worlds the edge
 * straddles instead of guessed afterwards. "Is there a keyboard" is an AND —
 * an editor holds focus, AND the viewport is short of the learned baseline by
 * MIN_KEYBOARD_PX — so the close fires on whichever input flips FIRST, and the
 * record's existing `src` cannot say which: it names the event the evaluation
 * arrived on ("resize", "other"), and "other" only means no fresh viewport
 * event was in flight. Six of eight closes in a production trail read "other".
 *
 * "unknown" covers a close with no earlier world to compare against and one
 * where neither input moved. Neither should reach here, and folding them into
 * a real answer would put a number in the log that nothing measured.
 */
export type CloseCause = "focus" | "viewport" | "both" | "unknown";

export function closeCause(before: World | null, after: World): CloseCause {
  if (!before) return "unknown";
  const blurred = before.editorFocused && !after.editorFocused;
  const grew =
    keyboardInset(before.baseline, before.vvHeight) > 0 &&
    keyboardInset(after.baseline, after.vvHeight) === 0;
  if (blurred && grew) return "both";
  if (blurred) return "focus";
  return grew ? "viewport" : "unknown";
}

/**
 * The white band, stated in numbers. The report is a shell left standing at
 * keyboard height for about a second after the keyboard has visibly gone —
 * white showing between the compose bar and the bottom of the screen — and
 * then a snap to full height that reads as the whole view dropping. A trail of
 * eight closes said six were learned from focus rather than from the viewport
 * growing back, and that in five of those the viewport was STILL publishing
 * the keyboard-sized height at the instant the app acted. So the phone's own
 * number was stale and the app had been standing short for a period nothing
 * recorded.
 *
 * vvStale is that instant as a fact rather than a subtraction the reader has
 * to do; vvBase is the learned full-screen height it was decided against,
 * sitting beside the vvH the head already carries; vvHeldMs is how long the
 * viewport had been publishing the same number, which when vvStale is true is
 * the upper bound on how long the band could have been on screen. -1 there
 * means no height change has been seen yet, never a viewport that just moved.
 *
 * Close edges only. The open record is untouched, so raises recorded either
 * side of this build still read against each other.
 */
export function closeMark(
  before: World | null,
  after: World,
  heldMs: number,
): Record<string, unknown> {
  return {
    cause: closeCause(before, after),
    vvBase: Math.round(after.baseline),
    vvStale: keyboardInset(after.baseline, after.vvHeight) > 0,
    vvHeldMs: Math.round(heldMs),
  };
}

/**
 * A box write, as the trail carries it. top/h are exactly what the session
 * before this one was read in, so old and new trails still line up. The rest is
 * what that session could not tell: `glide` says whether the write ANIMATED or
 * landed in one frame, `edge` says it is the edge's own first write rather than
 * a mid-session resize, and `ems` places it on the edge's clock. Together they
 * turn "the box was written twice on the raise" into "written twice, seventeen
 * ms apart, both inside the glide window", which is the difference between a
 * harmless correction and a shell told to slide 412px and then re-aimed.
 */
export function sizeRecord(
  top: number,
  h: number,
  edge: boolean,
  ems: number,
): Record<string, unknown> {
  return { top, h, edge, ems: px(ems) };
}

/** the box the shell held at the instant it went back to the four-edge pin */
export function pinRecord(
  top: number | null,
  h: number | null,
  ems: number,
): Record<string, unknown> {
  return { top, h, ems: px(ems) };
}

/**
 * The anchor record's fields, spelled so a deploy log names which rect is
 * which without the code in front of the reader: file* is the invisible input,
 * plus* is the ＋ the user aimed at, and dx/dy is the gap between them, already
 * subtracted. The gap was recorded to test the theory that iOS anchors the
 * panel to the input's rendered rect. That theory is DEAD, since the rect never
 * reaches the UI process, so these numbers cannot explain a centred menu.
 */
export function anchorFrame(
  file: AnchorRect,
  plus: AnchorRect,
  fresh: boolean,
  upMs: number,
): Record<string, unknown> {
  return {
    fileLeft: px(file.left), fileTop: px(file.top),
    fileW: px(file.width), fileH: px(file.height),
    plusLeft: px(plus.left), plusTop: px(plus.top),
    plusW: px(plus.width), plusH: px(plus.height),
    dx: px(file.left - plus.left), dy: px(file.top - plus.top),
    fresh, upMs: Math.round(upMs),
  };
}

/** count each census selector in a document; pure, so a test can hand it one */
export function domCensus(
  root: { querySelectorAll(sel: string): { length: number } },
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const name of Object.keys(CENSUS_SELECTORS)) {
    counts[name] = root.querySelectorAll(CENSUS_SELECTORS[name]).length;
  }
  return counts;
}

/**
 * Run exactly `budget` frames through `raf`, then stop. Split out from the DOM
 * reader so a test can pump it on a fake clock and prove the loop ends on its
 * budget instead of rescheduling itself for the life of the session. `done`,
 * when given, is asked after each frame and ends the run early: the raise's
 * long tail stops on the clock, not on a count, so its budget is only a
 * backstop.
 */
export function pumpFrames(
  budget: number,
  onFrame: (i: number) => void,
  raf: (cb: () => void) => void,
  done?: () => boolean,
): void {
  if (budget <= 0) return;
  let i = 0;
  const step = (): void => {
    onFrame(i);
    i += 1;
    if (i < budget && !done?.()) raf(step);
  };
  raf(step);
}

// main.ts owns followTail; this side only reads it, registered the same way
// the keyboard edge is (watchKeyboard above). Unregistered, the ft field is
// simply left off the record and the trail's own followtail marks carry it.
let readFollowTail: (() => boolean) | null = null;

export function watchFollowTail(read: () => boolean): void {
  readFollowTail = read;
}

// resolved once at the edge and reused for the whole run: a querySelector per
// frame would be work the probe does not need, and the elements cannot be
// replaced mid-edge (only a re-render swaps them, and an edge never renders)
let edgeStyle: CSSStyleDeclaration | null = null; // .compose's live computed style
let edgePill: Element | null = null;
let edgeThread: HTMLElement | null = null;
let edgeT0 = 0;
let edgeRun = 0; // a newer edge inside the window owns the frames from there on
let edgeChannel = "kb-fall"; // which of the two trails this run is writing
let edgeZero: EdgeFrame | null = null; // the ms 0 sample: the deltas' FROM value
let edgeHead: Record<string, unknown> | null = null; // this edge's record, half built
let edgeLiftStyle: CSSStyleDeclaration | null = null; // .lift's live computed style
let edgeVvAt = -1; // the last viewport event's own dispatch time
let edgeVvSrc = "other";
// The two worlds a close edge is read from. Kept as a pair advanced together
// in reconcile rather than assigned around applyShell, so a nested reconcile
// shifts both or neither and an edge can never be handed itself as its own
// "before".
let edgeWorld: World | null = null;
let edgeWorldBefore: World | null = null;
// The viewport's own honesty clock: the last height the app looked at and when
// that value first appeared. Any change counts, keyboard or not — a viewport
// that republished ANYTHING was not stuck — and 0 means none has been seen.
let vvHeightSeen = -1;
let vvHeightAt = 0;
// A close that fired while the viewport was still short stays armed until the
// viewport finally reports the full screen; that wait is the follow-up record.
// -1 is disarmed, and every edge disarms, so a wait can never be credited to
// the wrong close.
let staleCloseAt = -1;
let staleCloseRun = 0;

// Stamped by a listener registered ahead of the one that acts on the event
// (initShell), so an edge knows which event carried it and when the browser
// dispatched it. Two assignments; it reads no geometry and writes nothing else.
function markViewportEvent(e: Event): void {
  edgeVvAt = e.timeStamp;
  edgeVvSrc = e.type;
}

/** ms since the last keyboard edge; -1 before there has been one */
function edgeAge(): number {
  return edgeT0 === 0 ? -1 : performance.now() - edgeT0;
}

// One rect per element, taken before any of the readers run, so every field
// lifted off the same element costs one measurement rather than one each.
function edgeSample(ms: number, fts: number | undefined): EdgeFrame {
  const shell = appEl?.getBoundingClientRect();
  const pill = edgePill?.getBoundingClientRect();
  const thread = edgeThread?.getBoundingClientRect();
  const frame = edgeFrame(ms, {
    // .compose's padding-bottom IS var(--pad-b), and it is the only reachable
    // form of that value in pixels: an unregistered custom property computes
    // to its own token stream (the max()/env() text), so only a property the
    // engine has actually used reports a resolved length. That is also why
    // styles.css transitions the used property rather than the variable, and
    // why this read reports the ANIMATED value mid-glide: the two facts are
    // the same fact.
    padB: () => (edgeStyle ? parseFloat(edgeStyle.paddingBottom) : NaN),
    shellH: () => shell?.height ?? NaN,
    shellTop: () => shell?.top ?? NaN,
    pillBot: () => pill?.bottom ?? NaN,
    thBot: () => thread?.bottom ?? NaN,
    st: () => edgeThread?.scrollTop ?? NaN,
    // the two displacement sources of a shove, already computed by the
    // engine, so neither read can force a layout
    sy: () => window.scrollY,
    vvTop: () => window.visualViewport?.offsetTop ?? NaN,
    // the lift's live translate, off the computed style resolved at the edge:
    // the transition's own frame-by-frame value, which is the motion itself
    lift: () => (edgeLiftStyle ? matrixY(edgeLiftStyle.transform) : NaN),
    fts: () => fts,
    ft: () => readFollowTail?.(),
  });
  holdDiagRecord(edgeChannel, frame);
  return frame;
}

// The last frame before the edge. Called from applyShell on the .kb edge and
// BEFORE the class is toggled, because that class is what moves --pad-b: once
// it is toggled a computed read already reports the stepped value, and the
// before/against/after comparison the motion is read from is gone. This is the
// frame every rAF sample of the run is measured against.
function edgeStart(kind: "open" | "close"): void {
  if (!appEl || typeof document === "undefined") return;
  const compose = document.querySelector(".compose");
  edgeStyle = compose ? getComputedStyle(compose) : null;
  edgePill = document.querySelector(".compose .field");
  edgeThread = document.getElementById("thread");
  edgeLiftStyle = liftEl ? getComputedStyle(liftEl) : null;
  edgeChannel = kind === "open" ? "kb-rise" : "kb-fall";
  edgeT0 = performance.now();
  edgeRun += 1;
  const vv = window.visualViewport;
  const since = edgeT0 - edgeVvAt;
  // a stale stamp would read as a fast dispatch and quietly invent a fact; an
  // edge reached from focusin or a timer says so instead
  const fresh = edgeVvAt >= 0 && since >= 0 && since < EVT_FRESH_MS;
  // the white-band facts, and only on the close: which input flipped it,
  // whether the viewport was still short when it did, and how long that number
  // had already been standing (closeMark carries the whole reason)
  const close =
    kind === "close" && edgeWorld
      ? closeMark(edgeWorldBefore, edgeWorld, vvHeightAt === 0 ? -1 : edgeT0 - vvHeightAt)
      : null;
  // a close that lied gets a wait to close out; every other edge cancels one
  staleCloseAt = close?.vvStale === true ? edgeT0 : -1;
  staleCloseRun = edgeRun;
  edgeHead = {
    edge: kind,
    n: edgeRun,
    src: fresh ? edgeVvSrc : "other",
    evt: fresh ? px(since) : -1,
    // the window scroll the edge fired on. A displaced viewport tracked at an
    // edge is the double box write, and shoveVerdict writes no record for it:
    // the edges always track, by design.
    sx: Math.round(window.scrollX),
    sy: Math.round(window.scrollY),
    vvTop: Math.round(vv?.offsetTop ?? 0),
    vvH: Math.round(vv?.height ?? 0),
    // directly after vvH, so the height and the baseline it was judged against
    // sit side by side and the subtraction is on the line rather than in the
    // reader's head
    ...(close ?? {}),
    // the inset the viewport reads at the edge, which on an open is the lift's
    // target and on a close is what it is coming home from (the viewport is
    // still publishing it: closeMark's vvStale above says so)
    inset: Math.round(keyboardInset(baseline, vv?.height ?? baseline)),
    // how much of the keyboard's rise had already happened: styles.css starts
    // the ＋ collapse and the pill widen from the focus tap (.focusing) and the
    // shell's own glide only from this edge, so this is how far apart the two
    // halves of the raise were started
    foc: Number.isFinite(focusStartAt) ? Math.round(edgeT0 - focusStartAt) : -1,
    boxTop: null,
    boxH: null,
  };
  edgeZero = edgeSample(0, undefined); // ms 0 is always the pre-edge frame
}

function fallEdge(): void {
  edgeStart("close");
}

function riseEdge(): void {
  edgeStart("open");
}

// the box the edge's own write aimed at, kept on the edge record so one line
// says where the shell was told to go as well as where it got to
function recordShellSize(top: number, h: number, edge: boolean): void {
  if (edge && edgeHead) {
    edgeHead.boxTop = top;
    edgeHead.boxH = h;
  }
  holdDiagRecord("shell-size", sizeRecord(top, h, edge, edgeAge()));
}

function recordShellPin(top: number | null, h: number | null): void {
  holdDiagRecord("shell-pin", pinRecord(top, h, edgeAge()));
}

function startEdgeProbe(): void {
  if (!appEl || typeof requestAnimationFrame !== "function") return;
  const run = edgeRun;
  const t0 = edgeT0;
  // the raise runs the long window (see RISE_TRACE_MS); the close keeps the
  // plain EDGE_FRAMES budget it always had
  const rise = edgeChannel === "kb-rise";
  // the app has finished this edge's bookkeeping: on the close that is
  // applyShell plus the correction pass, on the raise applyShell alone
  const armed = performance.now() - edgeT0;
  let fts = -1; // the running frame's own start, handed over by the rAF callback
  pumpFrames(
    rise ? RISE_FRAME_CAP : EDGE_FRAMES,
    (i) => {
      if (run !== edgeRun) return; // a newer edge is recording; leave its trail clean
      // the raise's tail thins through the one predicate; the dense head and
      // the whole close record every callback, exactly as before
      if (!riseKeeps(i)) return;
      const read = performance.now() - edgeT0;
      const started = fts >= 0 ? fts - edgeT0 : undefined;
      const frame = edgeSample(read, started);
      if (i === 0 && edgeHead && edgeZero) {
        holdDiagRecord(
          "kb-edge",
          edgeMark(edgeHead, { armed, frame: started ?? read, read }, edgeZero, frame),
        );
        edgeHead = null; // one record per edge, whatever else the run does
      }
    },
    (cb) => {
      requestAnimationFrame((ts) => {
        fts = ts;
        cb();
      });
    },
    // the raise stops on the clock; a superseded run stops rescheduling too,
    // instead of pumping empty callbacks to its cap
    rise ? () => run !== edgeRun || performance.now() - t0 >= RISE_TRACE_MS : undefined,
  );
}

function pickAnchorRecord(fresh: boolean): void {
  if (!fileEl || !plusEl) return;
  holdDiagRecord(
    "pick-anchor",
    anchorFrame(
      fileEl.getBoundingClientRect(),
      plusEl.getBoundingClientRect(),
      fresh,
      performance.now(), // ms since the page began loading = how long the app has run
    ),
  );
}

// which signal COMPLETED a picker session, on the same channel as the
// presents. The guard change moved completion off the input's own events, so
// the trail must say what really ends sessions on device: the refocus
// hand-back, one of its page-level siblings, or the expiry backstop.
function pickEndRecord(signal: string): void {
  holdDiagRecord("pick-anchor", { end: signal, upMs: Math.round(performance.now()) });
}

function censusRecord(): void {
  if (typeof document === "undefined") return;
  holdDiagRecord("dom-census", domCensus(document));
}

// The device's own env(safe-area-inset-bottom), in pixels. There is no way to
// read an inset except to let the engine use it, so a throwaway box sized by
// the inset alone is measured and dropped in the same run: absolutely
// positioned inside the fixed shell and parked far off-screen, so it joins no
// flow, overlaps nothing, and is gone before anything can paint it. Runs at
// the end of initShell, when the shell is still empty and a forced layout
// costs nothing.
function recordSafeArea(): void {
  if (!appEl || typeof document === "undefined") return;
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:absolute;top:-9999px;left:-9999px;width:0;visibility:hidden;" +
    "pointer-events:none;height:env(safe-area-inset-bottom, 0px)";
  appEl.appendChild(probe);
  const insetB = probe.getBoundingClientRect().height;
  probe.remove();
  holdDiagRecord("safe-area", { insetB: px(insetB) });
}
// =================== END TEMP DIAGNOSTIC (remove after the keyboard-fall session) ===================
