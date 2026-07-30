// The iOS shell boundary: keyboard geometry, focus lifecycle, and file-picker
// sessions live HERE and nowhere else. Same discipline as the thread's event
// store: the world is the truth, the DOM is a projection, and every signal —
// whichever ones iOS deigns to fire, in whatever order — converges through one
// reconcile(). No handler owns choreography, so a skipped, duplicated, or
// stale event cannot strand shell state.
//
// iOS facts this module encodes (each cost a bug round; pinned in tests/):
// - iOS 26 presents the keyboard in TWO modes, apparently at random per tap
//   (device-proven, taplog 2026-07-25):
//     * overlay      — the layout viewport stays full height, only the visual
//                      viewport shrinks. The shell must track the visual
//                      viewport or the compose bar sits under the keyboard.
//     * window-shrink — `innerHeight` shrinks WITH the visual viewport. With
//                      no pan the four-edge pin is then already exact; writing
//                      our own top/height moves the shell off-screen.
//     * shrink-AND-pan — (taplog 2026-07-30) innerHeight shrinks AND iOS slides
//                      the page up (vv.offsetTop ~362): the pin anchors to a
//                      page whose top is above the screen, hiding the header.
//                      A nonzero pan therefore forces the viewport override
//                      regardless of innerHeight.
//   So "is there a keyboard" must NOT be derived from innerHeight - vvHeight
//   (that reads 0 in window-shrink mode, and 10 of 14 taps landed there).
//   It is measured against a BASELINE full-screen height captured while no
//   editor is focused. innerHeight decides only whether we must correct the
//   layout viewport, and that decision is LATCHED for the keyboard session —
//   innerHeight transiently lies mid-animation, which used to flip the shell
//   on/off/on inside 30ms (and once flipped it off for 2.3s).
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

// --- pure decision core (unit-tested; no DOM, no iOS) --------------------------

export interface World {
  editorFocused: boolean; // textarea or non-file input holds focus
  fileFocused: boolean; // focus parked on the picker's file input
  baseline: number; // full-screen visual-viewport height, no keyboard
  innerHeight: number;
  vvHeight: number;
  vvTop: number;
}

export interface ShellTarget {
  kb: boolean; // keyboard provably up: collapse the home-indicator clearance
  trackViewport: boolean; // AND the layout viewport needs correcting (overlay mode)
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
  const kb = w.editorFocused && keyboardInset(w.baseline, w.vvHeight) > 0;
  // The layout viewport needs correcting when the visible area is not where
  // the four-edge pin thinks it is. Two device-proven triggers:
  //   - overlay mode: innerHeight stayed tall while the viewport shrank
  //   - shrink-AND-pan (taplog 2026-07-30): innerHeight shrank to match the
  //     viewport — which used to read as "pin already exact" — but iOS ALSO
  //     slid the page up (vvTop 362), leaving the app's header above the
  //     screen for the whole keyboard session. Any nonzero pan means the pin
  //     is wrong, no matter what innerHeight claims.
  // True window-shrink with no pan (vvTop 0) still correctly reads false —
  // writing top/height there was the historical off-screen bug.
  const trackViewport =
    kb && (keyboardInset(w.innerHeight, w.vvHeight) > 0 || w.vvTop > 0);
  return { kb, trackViewport, vvTop: w.vvTop, vvHeight: w.vvHeight };
}

// ＋ pointerdown: should the tap preserve existing focus? Yes while an editor
// is up (keep the keyboard) or while focus is parked on the file input (a
// prevented tap still delivers its click — device-proven — so the picker
// re-presents instead of the tap dying as a blur). Never from idle.
export function preservesFocus(w: World): boolean {
  return w.editorFocused || w.fileFocused;
}

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
// functions, so the pure core above imports cleanly in any environment.

// TEMPORARY (bug/plustap): decision-point logging into taplog.ts's panel.
// Raw events are taplog's job; these lines record what the shell DECIDED
// (preventDefault or not, click forwarded, settle executed). No-op unless
// wired, so tests and the pure core stay inert.
let slog: (ev: string, detail?: string) => void = () => {};
export function setShellLogger(fn: (ev: string, detail?: string) => void): void {
  slog = fn;
}

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
// latched for the keyboard session: innerHeight lies transiently, and letting
// it retract the shell mid-animation is what made the bar jump
let tracking = false;

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
    innerHeight: window.innerHeight,
    vvHeight,
    vvTop: vv?.offsetTop ?? 0,
  };
}

// THE one writer of shell presentation: three mode classes plus two
// measurements. styles.css owns what they mean (.kb collapses --pad-b AND
// vanishes the ＋, .kb-vv consumes the vars to override the four-edge pin,
// .settling greys the bar for the whole picker session).
function applyShell(t: ShellTarget, settling: boolean): void {
  if (!appEl) return;
  const wasKb = appEl.classList.contains("kb");
  const wasTracking = appEl.classList.contains("kb-vv");
  const wasSettling = appEl.classList.contains("settling");
  if (t.kb !== wasKb) slog("shell.kb", t.kb ? `on h=${t.vvHeight} base=${baseline}` : "off");
  appEl.classList.toggle("kb", t.kb);
  if (settling !== wasSettling) slog("shell.settling", settling ? "on" : "off");
  appEl.classList.toggle("settling", settling);

  if (t.trackViewport !== wasTracking) {
    slog("shell.track", t.trackViewport ? `on top=${t.vvTop} h=${t.vvHeight}` : "off");
  }
  if (t.trackViewport) {
    appEl.style.setProperty("--vv-top", `${t.vvTop}px`);
    appEl.style.setProperty("--vv-height", `${t.vvHeight}px`);
    appEl.classList.add("kb-vv");
  } else {
    appEl.classList.remove("kb-vv");
    appEl.style.removeProperty("--vv-top");
    appEl.style.removeProperty("--vv-height");
    // only the tracked mode pans the layout viewport, so only leaving IT
    // needs the pan cleared. Firing this on every kb flip is what yanked the
    // page mid-animation.
    if (wasTracking) window.scrollTo(0, 0);
  }
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

export function reconcile(): void {
  const w = readWorld();
  const t = computeShell(w);
  // latch: once this keyboard session needs the viewport override it keeps it
  // until the keyboard actually leaves, so a transient innerHeight lie cannot
  // retract the shell mid-animation
  if (!t.kb) tracking = false;
  else if (t.trackViewport) tracking = true;
  // the visual off-state covers the whole session; the tap hold stays
  // teardown-only (see holdsBarTap)
  applyShell({ ...t, trackViewport: t.kb && tracking }, picker.isOpen() || picker.isTearing());
}

const picker = createPickerLifecycle({
  present: (fresh: boolean) => {
    if (fresh) swapFileInput();
    slog("shell.present", fresh ? "files.click() [fresh]" : "files.click()");
    fileEl?.click();
    reconcile(); // the settling visual starts NOW, inside the opening tap
  },
  dismiss: () => {
    slog("shell.settle", "blur files"); // logged BEFORE blur: act= shows parked state
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
      slog("shell.teardown", "expired");
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
  document.addEventListener("focusin", reconcile);
  // one frame's grace on focusout: focus may be hopping between editables
  document.addEventListener("focusout", () => requestAnimationFrame(reconcile));
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
        const tgt = e.target instanceof HTMLElement ? e.target.tagName.toLowerCase() : "?";
        slog("shell.hold", `tgt=${tgt}`);
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
    const w = readWorld();
    const preserve = preservesFocus(w);
    slog(
      "shell.＋pd",
      `editor=${w.editorFocused ? 1 : 0} file=${w.fileFocused ? 1 : 0}` +
        ` open=${picker.isOpen() ? 1 : 0} tear=${picker.isTearing() ? 1 : 0}` +
        ` preventDefault=${preserve ? 1 : 0}`,
    );
    if (preserve) e.preventDefault();
  });
  button.addEventListener("click", () => {
    // a held tap still delivers its click (device-proven); during the window it
    // must not reach open(), which would present straight into the dropped-click
    // zone — the falsified fresh-input path, 0/6 on device
    if (picker.isTearing()) {
      slog("shell.＋click", "held");
      return;
    }
    slog("shell.＋click", picker.open());
  });
}

// the current file input — it is replaced on fresh presents, so callers must
// never cache the element they were handed at bind time
export function currentFileInput(): HTMLInputElement | null {
  return fileEl;
}
