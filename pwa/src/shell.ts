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
//   era, retired 2026-08). The regime NOW (the prevention architecture,
//   research 2026-08-18; Telegram Web Z's vv-sized shell adapted to
//   position:fixed): while the keyboard is provably up the shell box IS the
//   visual viewport — top: vv.offsetTop, height: vv.height, rewritten from
//   fresh numbers on EVERY vv event — and at rest the box is dropped for the
//   measurement-free four-edge pin. One rule serves all three modes: in
//   window-shrink the box equals the pin (top 0, height = the shrunken
//   layout viewport), in the other two it is exactly the correction they
//   always needed; a stale mid-animation number self-heals on the next event
//   instead of being latched around. "Is there a keyboard" stays measured
//   against a BASELINE full-screen height captured while no editor is
//   focused, never innerHeight - vvHeight (that reads 0 in window-shrink
//   mode, and 10 of 14 taps landed there).
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
// - While an editable is focused, a ＋ tap must preventDefault on pointerdown
//   (or the keyboard collapses mid-presentation and the menu anchors to a
//   stale rect); from idle it must NOT (or iOS swallows the next focus tap).

import { holdDiagRecord } from "./hold";
// TEMP DIAGNOSTIC (scroll-jank, scrolljank.ts owns the banner): activity
// stamps for jank attribution; both uses sit inside the probe block at the
// bottom of this file, a two-line span around each stamped job
import { jankSpan } from "./jankledger";
// TEMP DIAGNOSTIC (close-slack, block at the bottom): the tail-gap probe's row
// helpers; pure functions, so the no-DOM-at-import property below still holds
import { laidOutRows, rowName } from "./viewport";

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

// The shell box while the keyboard is up IS the visual viewport. top =
// vv.offsetTop translates a fixed shell into the visible region when iOS
// slides the layout viewport; height ends it at the keyboard's top edge —
// the Telegram Web Z height+pageTop invariant (shell bottom = keyboard top)
// expressed for position:fixed. At rest there is no box: the four-edge pin
// needs no measurement, so cold-start height misreports can't touch it.
export function shellBox(t: ShellTarget): { top: number; height: number } | null {
  return t.kb ? { top: t.vvTop, height: t.vvHeight } : null;
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

// Keyboard open/close glide: WebKit can publish a keyboard's whole geometry
// change as ONE vv event, and a shell box applied in one write is a jump cut.
// Box writes landing inside this window after a .kb edge animate (styles.css
// #app.gliding, 0.2s ease-out); outside it — every mid-typing write — they
// stay instant, so an active-growth frame never smears.
export const GLIDE_SETTLE_MS = 450;

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
// the .kb class as applied; its edges (and only they) open the glide window
let appliedKb = false;
// box writes animate until this deadline — the kb-edge settle window
let glideUntil = 0;
let glideTimer: ReturnType<typeof setTimeout> | null = null;
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

// a .kb edge opens the glide window: box writes inside it animate (styles.css
// #app.gliding), so the keyboard's rise and close read as motion even when
// WebKit publishes the whole geometry change as one event. The timer
// re-converges once the window ends — reconcile drops .gliding (and a close
// glide's numeric rest box) through the one writer; a stale or duplicate fire
// reconciles an already-converged state, harmlessly.
function armGlide(edge: "open" | "close"): void {
  glideUntil = performance.now() + GLIDE_SETTLE_MS;
  holdDiagRecord("kb-glide", { edge });
  if (glideTimer) clearTimeout(glideTimer);
  glideTimer = setTimeout(() => {
    glideTimer = null;
    reconcile();
  }, GLIDE_SETTLE_MS + 20);
}

// THE one writer of shell presentation: four mode classes plus the measured
// box. styles.css owns what they mean (.kb collapses --pad-b and vanishes the
// ＋; .focusing runs that same bar choreography from the focus tap itself;
// .kb/.gliding size the shell from --shell-top/--shell-h and .gliding alone
// carries their transition AND the matching one on everything --pad-b moves,
// so the shell's bottom edge and the bar's bottom gap are armed by the single
// class recalculation below and cannot travel on separate clocks; .settling
// greys the bar for the whole picker session). Every vv event lands here, so
// the box is always the freshest numbers iOS has published — no latch,
// nothing to retract.
function applyShell(t: ShellTarget, settling: boolean): void {
  if (!appEl) return;
  // TEMP DIAGNOSTIC (kb-edge, block at the bottom): this call is the edge, so
  // the box written further down is the edge's own target rather than a
  // mid-session resize
  const atEdge = t.kb !== appliedKb;
  // TEMP DIAGNOSTIC (kb-fall, block at the bottom): the last frame with the
  // keyboard still up, sampled on the close edge and BEFORE the class toggle
  // below collapses --pad-b — after it, the comparison the bug turns on is gone
  if (!t.kb && appliedKb) fallEdge();
  if (t.kb && !appliedKb) riseEdge(); // TEMP DIAGNOSTIC (kb-rise): the same, mirrored
  if (t.kb !== appliedKb) {
    appliedKb = t.kb;
    armGlide(t.kb ? "open" : "close");
  }
  const gliding = performance.now() < glideUntil;
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
  appEl.classList.toggle("gliding", gliding);
  appEl.classList.toggle("focusing", focusing);

  const box = shellBox(t);
  if (box) {
    const top = Math.round(box.top);
    const height = Math.round(box.height);
    if (top !== appliedTop || height !== appliedHeight) {
      if (gliding && appliedTop === null && appliedHeight === null) {
        // entering from the four-edge pin, a glide has no numeric FROM value
        // (the pin's height is `auto`, which no transition interpolates):
        // seed the pin's own geometry and commit it with a reflow so the
        // real write below animates from rest instead of snapping
        appEl.style.setProperty("--shell-top", "0px");
        appEl.style.setProperty("--shell-h", `${Math.round(baseline)}px`);
        void appEl.offsetHeight;
        edgeSeeded = true; // TEMP DIAGNOSTIC (kb-edge): this edge paid for that reflow
      }
      appliedTop = top;
      appliedHeight = height;
      appEl.style.setProperty("--shell-top", `${box.top}px`);
      appEl.style.setProperty("--shell-h", `${box.height}px`);
      // the device's read-back for every shell resize the keyboard causes
      recordShellSize(top, height, gliding, atEdge);
    }
  } else if (appliedTop !== null || appliedHeight !== null) {
    if (gliding) {
      // the close glide: ride a numeric box home to the pin's geometry (the
      // pin itself cannot animate); armGlide's timer drops it below once the
      // window ends, landing on the measurement-free pin as before
      const restH = Math.round(baseline);
      if (appliedTop !== 0 || appliedHeight !== restH) {
        appliedTop = 0;
        appliedHeight = restH;
        appEl.style.setProperty("--shell-top", "0px");
        appEl.style.setProperty("--shell-h", `${restH}px`);
        recordShellSize(0, restH, gliding, atEdge);
      }
    } else {
      const wasTop = appliedTop;
      const wasH = appliedHeight;
      appliedTop = null;
      appliedHeight = null;
      appEl.style.removeProperty("--shell-top");
      appEl.style.removeProperty("--shell-h");
      // TEMP DIAGNOSTIC (shell-pin, block at the bottom): the numeric box is
      // gone and the four-edge pin takes over. If the ride home had not landed
      // exactly on the pin's own geometry this is the frame it snaps, and
      // nothing else in the trail marks the moment.
      recordShellPin(wasTop, wasH);
    }
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
  // TEMP DIAGNOSTIC (close-slack, block at the bottom): the band after the last
  // message, timed out over the seconds the owner reports it healing in
  startCloseSlack();
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
  const t = computeShell(readWorld());
  const wasUp = kbUp;
  kbUp = t.kb;
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
    const heightChanged = appliedHeight === null || Math.round(t.vvHeight) !== appliedHeight;
    const verdict = shoveVerdict(wasUp, t.kb, x, y, heightChanged, shoveClears);
    // TEMP DIAGNOSTIC (kb-rise, block at the bottom): en on both records below
    // is the edge counter the kb-edge record carries as n, so a clear names the
    // open it landed inside and frames, edge summary and clears join on one
    // timeline. It goes when that block goes.
    if (verdict === "clear" && appliedTop !== null && appliedHeight !== null) {
      shoveClears += 1;
      window.scrollTo(0, 0);
      target = { kb: t.kb, vvTop: appliedTop, vvHeight: appliedHeight };
      holdDiagRecord("kb-shove", { act: "clear", n: shoveClears, en: edgeRun, x, y, top: Math.round(t.vvTop) });
    } else if (verdict === "yield") {
      holdDiagRecord("kb-shove", { act: "yield", n: shoveClears, en: edgeRun, x, y, top: Math.round(t.vvTop) });
    }
    // The edges stay the shell's own business, and they still resize with the
    // viewport: only the TOP an edge writes is held back, and only when the
    // window is scrolled under it (edgeBoxTop owns the whole reason). This can
    // never overlap the verdict above, because shoveVerdict returns "track" at
    // both edges by design, and it can never touch the close edge, which writes
    // no box at all. scrollX plays no part: a sideways scroll cannot inflate
    // offsetTop.
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
    // TEMP DIAGNOSTIC (pick-anchor, block at the bottom): the two rects, read
    // after the click that presented so the read cannot alter what iOS anchored to
    pickAnchorRecord(fresh);
    reconcile(); // the settling visual starts NOW, inside the opening tap
  },
  dismiss: () => {
    fileEl?.blur(); // parked focus is the tap-swallower; clear it on every path
    armTeardownExpiry();
    reconcile();
  },
});

// The window's end normally arrives as a signal (refocus/cancel/change), but a
// dropped present produces none — without a clock the bar would stay held until
// some unrelated signal happened by. expireTearing() carries the real check, so
// this timer can fire stale, duplicated, or into a later session, harmlessly.
function armTeardownExpiry(): void {
  setTimeout(() => {
    if (picker.expireTearing() === "expired") {
      reconcile();
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
  void next.offsetWidth; // flush layout: iOS anchors the menu to the rendered rect
}

// the input's own signals end the session AND mark teardown finished
function bindInputSignals(input: HTMLInputElement): void {
  const sessionDone = (): void => {
    picker.settle();
    const done = picker.teardownComplete() === "completed";
    reconcile(); // the settling window ends HERE; the bar must un-grey now
    if (done) releaseParkedEditor();
  };
  input.addEventListener("cancel", sessionDone);
  input.addEventListener("change", () => {
    sessionDone();
    onPick?.();
  });
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
  // tearing down a session that opened microseconds earlier.
  window.addEventListener("focus", () => {
    picker.settle();
    const done = picker.teardownComplete() === "completed";
    reconcile();
    if (done) releaseParkedEditor();
  });
  window.addEventListener("pageshow", () => {
    picker.settle();
    picker.teardownComplete();
    reconcile();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      picker.settle();
      picker.teardownComplete();
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
  // a held tap still delivers its click (device-proven); during the window it
  // must not reach open(), which would present straight into the dropped-click
  // zone — the falsified fresh-input path, 0/6 on device
  if (verdict === "tearing") return;
  if (verdict === "held") {
    // TEMP DIAGNOSTIC (pick-anchor, block at the bottom): the comeback tap,
    // swallowed; `held` tells it apart from the presents on the same channel
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
//   shell-pin   : the one frame the shell leaves its numeric box for the
//                 four-edge pin, at the end of the glide's settle window. The
//                 pin cannot be animated, so if the ride home had not landed
//                 exactly on the pin's geometry this is where it snaps, about
//                 470ms after the close edge. Nothing recorded that moment, and
//                 an eighteen-frame probe stopped before it.
//   pick-anchor : the file input's rect against the ＋ button's at the instant
//                 the picker presents. iOS anchors WKFileUploadPanel to the
//                 INPUT's rendered rect, and .filepick is parked invisibly on
//                 top of the ＋ precisely so the two agree; a panel opening
//                 off to the right means on that tap they did not. A record
//                 carrying `held: true` instead of rects is a comeback tap
//                 the ＋ click swallowed (plusClickVerdict): no present
//                 happened, so there are no rects to compare.
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
// TO REMOVE: delete this block plus the call sites above marked TEMP
// DIAGNOSTIC (the atEdge flag, the two edge samples and the seeding-reflow mark
// in applyShell, the shell-size and shell-pin records in the same function, the
// census in correctionPass, the probe start in keyboardClosed and the mirror
// one in reconcile, the en field on reconcile's two kb-shove records, the
// anchor record in the picker's present effect plus the
// held swallow's record in pickerTapOpen, the two
// markViewportEvent listeners and the safe-area probe in initShell), the
// watchFollowTail wiring in main.ts, "pick-anchor" and "kb-edge" in hold.ts's
// post-now list, and the kb-fall/kb-rise/kb-edge/shell-pin/dom-census/
// pick-anchor/safe-area names in web/app.py's digest filters.

/**
 * Frames one edge probe samples, on either edge: about 0.5s at 60fps. The
 * budget has to OUTLIVE the motion it is measuring, and the motion is longer
 * than the 0.2s transition: the shell holds its numeric box for the whole of
 * GLIDE_SETTLE_MS and drops it for the four-edge pin about 470ms after the
 * edge, so a probe that stops at eighteen frames cannot see whether the ride
 * home landed on the pin or snapped onto it. The first eighteen frames are
 * unchanged, so trails recorded either side of this read against each other.
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
  glide: boolean,
  edge: boolean,
  ems: number,
): Record<string, unknown> {
  return { top, h, glide, edge, ems: px(ems) };
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
 * which without the code in front of the reader: file* is the invisible input
 * iOS actually anchors to, plus* is the ＋ the user aimed at, and dx/dy is the
 * gap between them — the whole question, already subtracted.
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
let edgeSeeded = false; // the edge's box write had to seed the pin's geometry
let edgeVvAt = -1; // the last viewport event's own dispatch time
let edgeVvSrc = "other";

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
  edgeChannel = kind === "open" ? "kb-rise" : "kb-fall";
  edgeSeeded = false;
  edgeT0 = performance.now();
  edgeRun += 1;
  const vv = window.visualViewport;
  const since = edgeT0 - edgeVvAt;
  // a stale stamp would read as a fast dispatch and quietly invent a fact; an
  // edge reached from focusin or a timer says so instead
  const fresh = edgeVvAt >= 0 && since >= 0 && since < EVT_FRESH_MS;
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
function recordShellSize(top: number, h: number, glide: boolean, edge: boolean): void {
  if (edge && edgeHead) {
    edgeHead.boxTop = top;
    edgeHead.boxH = h;
  }
  holdDiagRecord("shell-size", sizeRecord(top, h, glide, edge, edgeAge()));
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
        edgeHead.seed = edgeSeeded; // the seeding reflow, if any, has happened by now
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

// ===================== TEMP DIAGNOSTIC (remove after the close-slack session) =====================
// The transient band after a keyboard close. On some closes roughly 386 to
// 402px of genuinely empty content height sits inside the thread past the last
// message: he stares at white, no chevron surfaces, and the state heals within
// seconds, on its own or at the first small touch. Every close-time record so
// far reads the thread's bottom and its scrollTop but never its scrollHeight
// or clientHeight, which is why the carrier has evaded capture: the trail can
// say the view moved and still cannot say WHICH box held the extra height or
// WHEN it gave it back.
//
// This channel states both, one record per close. A sample lands at the close
// itself (after the same bookkeeping the kb-fall probe waits for), at each of
// CLOSE_SLACK_AT_MS after it, and once at the first user signal (pointer,
// touch or wheel, whichever lands first, marked with its type and delay) plus
// a settle read TOUCH_FOLLOW_MS later, so a heal the touch causes shows as a
// before/after pair on the same timeline. Each sample carries the scroller's
// own three numbers, the thread element's rendered height, where the last row
// really ends in content coordinates, the slack past it already subtracted,
// the lowest edge any row reaches with transforms left in (the engine counts
// transformed overflow into scrollHeight, so a row still riding a translate is
// exactly the kind of carrier that number names), and every height-carrying
// piece the scroller's layout actually has: the thread's own paddings, the
// shell box mid-glide, and the bar/pending/compose heights that share the
// shell with the thread, compose's resolved --pad-b included, since that
// padding is the one keyboard-compensation value in this layout (the thread
// holds no spacer element; its children are only the rows the renderers make).
// A changing candidate identifies itself across the samples; steady ones rule
// themselves out.
//
// Reads only, kb-fall's discipline: element lookups and live computed styles
// are resolved once at the close, every sample takes one rect per element, and
// nothing below writes a class, a style, a scroll position or a node, so seven
// samples cannot disturb the heal they are timing. The samples of one close
// batch into ONE record (a touch pair landing after the four-second record
// ships as a second record joined by the run number), so a whole close costs
// the digest one line's slot, not seven.
//
// TO REMOVE, every call site: delete this block; delete the startCloseSlack()
// call and its comment in keyboardClosed; delete the laidOutRows/rowName
// import and its comment at the top of this file; delete "close-slack" (the
// condition and its comment paragraph) from hold.ts's post-now list; delete
// the "holddiag slack" digest line in web/app.py and the close-slack test in
// tests/test_holddiag.py; delete the close-slack describes in
// tests/shelldiag.test.ts. Nothing else refers to any of it.

/**
 * When the timed samples land, ms after the close. The ladder has to outlive
 * the motion it measures, and here the motion is the HEAL: the owner reports
 * it within seconds, so the last rung sits at four, and a band still standing
 * there is one only the touch pair below will explain.
 */
export const CLOSE_SLACK_AT_MS = [250, 500, 1000, 2000, 4000] as const;

/**
 * The second half of the touch pair: one read inside the first user signal's
 * own dispatch, before anything it causes can run, and one this much later.
 * If the touch is what collapses the band, the two straddle the collapse.
 */
export const TOUCH_FOLLOW_MS = 150;

/** the geometry reads one sample needs, injectable so the shape can be pinned */
export interface SlackReader {
  sh(): number; // thread scrollHeight: the number the band inflates
  ch(): number;
  st(): number;
  thH(): number; // the thread element's own rendered height
  lastB(): number; // last laid-out row's bottom, content coords, transforms stripped
  maxB(): number; // the lowest edge ANY row reaches, transforms left in
  low(): string | null; // the row at maxB, named the way tail-gap names one
  rows(): number;
  padT(): number; // the thread's own paddings: the box's intentional height
  padB(): number;
  appT(): number; // the shell box, mid-glide at the early samples
  appH(): number;
  barH(): number; // what shares the shell's height with the thread
  pendH(): number;
  compH(): number;
  cpb(): number; // .compose's resolved --pad-b: the keyboard-compensation padding
}

// One sample, as the trail carries it. An alias for EdgeFrame's reason: only
// object literal types hand to holdDiagRecord's Record without a cast. src
// rides the touch samples alone, kb only when the keyboard is back up by the
// time a sample fires, low only when some row really reaches past the last
// one's floor.
export type SlackSample = {
  ms: number;
  src?: string;
  kb?: boolean;
  sh: number | null;
  ch: number | null;
  st: number | null;
  thH: number | null;
  slack: number | null;
  lastB: number | null;
  maxB: number | null;
  low?: string | null;
  rows: number;
  padT: number | null;
  padB: number | null;
  appT: number | null;
  appH: number | null;
  barH: number | null;
  pendH: number | null;
  compH: number | null;
  cpb: number | null;
};

// one decimal of a pixel; a missing element reads null, never a sentinel. Its
// own copy of viewport.ts's tenth, so this block deletes alone.
const slackTenth = (n: number): number | null =>
  Number.isFinite(n) ? Math.round(n * 10) / 10 : null;

/** assemble one sample; pure, so a test pins the fields and the gating */
export function slackSample(
  ms: number,
  src: string | null,
  kb: boolean,
  r: SlackReader,
): SlackSample {
  const sh = r.sh();
  const lastB = r.lastB();
  const maxB = r.maxB();
  const s: SlackSample = {
    ms: Math.round(ms),
    sh: slackTenth(sh),
    ch: slackTenth(r.ch()),
    st: slackTenth(r.st()),
    thH: slackTenth(r.thH()),
    // the question, already subtracted: content height past the last message.
    // The thread's own bottom padding stays inside it on purpose, so a healthy
    // close reads a steady dozen px (padB says exactly how many) and a sick
    // one reads the band, and the two cannot be confused by an off-by-padding.
    slack: Number.isFinite(sh) && Number.isFinite(lastB) ? slackTenth(sh - lastB) : null,
    lastB: slackTenth(lastB),
    maxB: slackTenth(maxB),
    rows: r.rows(),
    padT: slackTenth(r.padT()),
    padB: slackTenth(r.padB()),
    appT: slackTenth(r.appT()),
    appH: slackTenth(r.appH()),
    barH: slackTenth(r.barH()),
    pendH: slackTenth(r.pendH()),
    compH: slackTenth(r.compH()),
    cpb: slackTenth(r.cpb()),
  };
  if (src !== null) s.src = src;
  if (kb) s.kb = true;
  // the carrier's name earns its slot only when some row reaches past the last
  // one's floor by more than a pixel; when the floors agree the band holds no
  // row at all, and that absence is itself the finding
  if (Number.isFinite(maxB) && Number.isFinite(lastB) && maxB > lastB + 1) s.low = r.low();
  return s;
}

/** one record per close; the run number joins a late touch pair to its timeline */
export function slackRecord(
  n: number,
  samples: SlackSample[],
  cut: boolean,
): Record<string, unknown> {
  return cut ? { n, cut: true, samples } : { n, samples };
}

// resolved once per close, the edge probe's own economy: only renderChat swaps
// these elements, and a render never happens mid-close
let slackThread: HTMLElement | null = null;
let slackThreadStyle: CSSStyleDeclaration | null = null; // live computed style
let slackComposeEl: Element | null = null;
let slackComposeStyle: CSSStyleDeclaration | null = null;
let slackBarEl: Element | null = null;
let slackPendEl: Element | null = null;
let slackRun = 0; // which close's timeline is being written
let slackT0 = 0;
let slackSamples: SlackSample[] = [];
let slackSent = 0; // samples already shipped, so a late touch ships only its pair
let slackTimers: ReturnType<typeof setTimeout>[] = [];
let slackTouchSpent = false; // one pair per close: the FIRST touch is the question
let slackListenersOn = false;

// One sample of the run. Reads only: rects, scroll numbers and computed
// styles, no element lookup (those were resolved at the close) and no write of
// any kind. One rect per element serves every field taken off it.
function slackRead(src: string | null): void {
  const t = slackThread;
  if (!t || !t.isConnected) return; // shell torn down mid-run
  const jankT0 = performance.now(); // TEMP DIAGNOSTIC (scroll-jank): this read burst is a prime suspect, so it stamps itself
  const ms = performance.now() - slackT0;
  const tRect = t.getBoundingClientRect();
  const appRect = appEl?.getBoundingClientRect();
  const barRect = slackBarEl?.getBoundingClientRect();
  const pendRect = slackPendEl?.getBoundingClientRect();
  const compRect = slackComposeEl?.getBoundingClientRect();
  // re-walked per sample because content can land mid-run; the walk itself
  // reads client rects and nothing else (laidOutRows, viewport.ts)
  const rows = laidOutRows(t).filter((el): el is HTMLElement => el instanceof HTMLElement);
  const last = rows.length > 0 ? rows[rows.length - 1] : null;
  // the last row's bottom in content coordinates, running translates stripped
  // the way the tail-gap probe strips them (seatBottom, main.ts): the floor is
  // layout truth, not a row mid-flight
  let lastB = NaN;
  if (last) {
    let top = last.getBoundingClientRect().top;
    for (let el: HTMLElement | null = last; el && el !== t; el = el.parentElement) {
      const tr = getComputedStyle(el).transform;
      if (tr !== "none") top -= new DOMMatrixReadOnly(tr).f;
    }
    lastB = top - tRect.top + t.scrollTop + last.offsetHeight;
  }
  // and the lowest edge any row reaches with transforms LEFT IN: scrollHeight
  // counts transformed overflow, so a row still riding a translate past the
  // content edge is a carrier only this reading can expose
  let maxB = NaN;
  let lowRow: HTMLElement | null = null;
  for (const row of rows) {
    const b = row.getBoundingClientRect().bottom - tRect.top + t.scrollTop;
    if (!(b <= maxB)) {
      // NaN compares false against everything, so the first row always seats
      maxB = b;
      lowRow = row;
    }
  }
  slackSamples.push(
    slackSample(ms, src, kbUp, {
      sh: () => t.scrollHeight,
      ch: () => t.clientHeight,
      st: () => t.scrollTop,
      thH: () => tRect.height,
      lastB: () => lastB,
      maxB: () => maxB,
      low: () => (lowRow ? rowName(lowRow) : null),
      rows: () => rows.length,
      padT: () => (slackThreadStyle ? parseFloat(slackThreadStyle.paddingTop) : NaN),
      padB: () => (slackThreadStyle ? parseFloat(slackThreadStyle.paddingBottom) : NaN),
      appT: () => appRect?.top ?? NaN,
      appH: () => appRect?.height ?? NaN,
      barH: () => barRect?.height ?? NaN,
      pendH: () => pendRect?.height ?? NaN,
      compH: () => compRect?.height ?? NaN,
      cpb: () => (slackComposeStyle ? parseFloat(slackComposeStyle.paddingBottom) : NaN),
    }),
  );
  jankSpan("slack-read", jankT0); // TEMP DIAGNOSTIC (scroll-jank): end of the read burst
}

// ships everything not yet shipped; a run cut short by the next close still
// leaves its partial timeline in the trail, marked so
function emitCloseSlack(cut: boolean): void {
  const fresh = slackSamples.slice(slackSent);
  if (fresh.length === 0) return;
  slackSent = slackSamples.length;
  const jankT0 = performance.now(); // TEMP DIAGNOSTIC (scroll-jank): the record build and push, spanned
  holdDiagRecord("close-slack", slackRecord(slackRun, fresh, cut));
  jankSpan("slack-emit", jankT0); // TEMP DIAGNOSTIC (scroll-jank)
}

// the touch half: one read inside the first user signal's own dispatch, before
// any handler the signal reaches can move anything, and the settle read after
function slackTouch(e: Event): void {
  if (slackRun === 0 || slackTouchSpent) return;
  slackTouchSpent = true;
  slackRead(e.type);
  slackTimers.push(
    setTimeout(() => {
      slackRead("touch-settle");
      // the timed record has already shipped: the pair goes as its own record,
      // and the shared run number joins the two lines into one timeline
      if (slackSent > 0) emitCloseSlack(false);
    }, TOUCH_FOLLOW_MS),
  );
}

// The close hook: the same close signal the kb-fall probe starts from
// (keyboardClosed), after the same bookkeeping, so ms 0 describes the frame
// the correction pass left behind.
function startCloseSlack(): void {
  if (!appEl || typeof document === "undefined") return;
  emitCloseSlack(true); // a run this close cuts short still ships what it holds
  while (slackTimers.length) clearTimeout(slackTimers.pop());
  slackThread = document.getElementById("thread");
  slackThreadStyle = slackThread ? getComputedStyle(slackThread) : null;
  slackComposeEl = document.querySelector(".compose");
  slackComposeStyle = slackComposeEl ? getComputedStyle(slackComposeEl) : null;
  slackBarEl = document.querySelector(".bar");
  slackPendEl = document.getElementById("pending");
  slackRun += 1;
  slackT0 = performance.now();
  slackSamples = [];
  slackSent = 0;
  slackTouchSpent = false;
  if (!slackListenersOn) {
    slackListenersOn = true;
    // the first USER signal, not the first scroll event: the close's own
    // re-pin fires thread scrolls within milliseconds and would spend the shot
    // on itself, while a user scroll on iOS begins with a touch and on desktop
    // with a wheel, so these three cover "touch or scroll" honestly. Passive
    // and capture-phase: they read before anything handles the gesture, and
    // they can never delay or alter it.
    for (const type of ["pointerdown", "touchstart", "wheel"]) {
      document.addEventListener(type, slackTouch, { capture: true, passive: true });
    }
  }
  slackRead(null); // ms 0: the close's own frame
  for (const at of CLOSE_SLACK_AT_MS) {
    slackTimers.push(
      setTimeout(() => {
        slackRead(null);
        if (at === CLOSE_SLACK_AT_MS[CLOSE_SLACK_AT_MS.length - 1]) emitCloseSlack(false);
      }, at),
    );
  }
}
// =================== END TEMP DIAGNOSTIC (remove after the close-slack session) ===================
