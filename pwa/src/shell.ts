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
// carries their transition; .settling greys the bar for the whole picker
// session). Every vv event lands here, so the box is always the freshest
// numbers iOS has published — no latch, nothing to retract.
function applyShell(t: ShellTarget, settling: boolean): void {
  if (!appEl) return;
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
      }
      appliedTop = top;
      appliedHeight = height;
      appEl.style.setProperty("--shell-top", `${box.top}px`);
      appEl.style.setProperty("--shell-h", `${box.height}px`);
      // the device's read-back for every shell resize the keyboard causes
      holdDiagRecord("shell-size", { top, h: height });
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
        holdDiagRecord("shell-size", { top: 0, h: restH });
      }
    } else {
      appliedTop = null;
      appliedHeight = null;
      appEl.style.removeProperty("--shell-top");
      appEl.style.removeProperty("--shell-h");
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
    if (verdict === "clear" && appliedTop !== null && appliedHeight !== null) {
      shoveClears += 1;
      window.scrollTo(0, 0);
      target = { kb: t.kb, vvTop: appliedTop, vvHeight: appliedHeight };
      holdDiagRecord("kb-shove", { act: "clear", n: shoveClears, x, y, top: Math.round(t.vvTop) });
    } else if (verdict === "yield") {
      holdDiagRecord("kb-shove", { act: "yield", n: shoveClears, x, y, top: Math.round(t.vvTop) });
    }
  }
  // the visual off-state covers the whole session; the tap hold stays
  // teardown-only (see holdsBarTap)
  applyShell(target, picker.isOpen() || picker.isTearing());
  // corrections belong to the close edge alone — mid-typing the shell rides
  // the viewport (except a scroll-sourced shove, refused above) and never
  // rewrites tracked displacement (the retired counter's lesson)
  if (wasUp && !t.kb) keyboardClosed();
}

const picker = createPickerLifecycle({
  present: (fresh: boolean) => {
    if (fresh) swapFileInput();
    fileEl?.click();
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
}

// wire the compose ＋ button and file input; called per renderChat because the
// re-render recreates both elements. `pick` fires when files are chosen — it is
// re-attached to each fresh input, so the app's handler survives the swaps.
export function bindPicker(input: HTMLInputElement, button: HTMLElement, pick: () => void): void {
  fileEl = input;
  plusEl = button;
  onPick = pick;
  bindInputSignals(input);
  button.addEventListener("pointerdown", (e) => {
    if (preservesFocus(readWorld())) e.preventDefault();
  });
  button.addEventListener("click", () => {
    // a held tap still delivers its click (device-proven); during the window it
    // must not reach open(), which would present straight into the dropped-click
    // zone — the falsified fresh-input path, 0/6 on device
    if (picker.isTearing()) return;
    picker.open();
  });
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
