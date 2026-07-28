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
//     * window-shrink — `innerHeight` shrinks WITH the visual viewport. The
//                      four-edge pin is then already exact; writing our own
//                      top/height moves the shell off-screen.
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
  // innerHeight still shrunk with the keyboard = window-shrink mode = the
  // four-edge pin already matches the visible area; correcting it would be
  // the bug, not the fix.
  const trackViewport = kb && keyboardInset(w.innerHeight, w.vvHeight) > 0;
  return { kb, trackViewport, vvTop: w.vvTop, vvHeight: w.vvHeight };
}

// ＋ pointerdown: should the tap preserve existing focus? Yes while an editor
// is up (keep the keyboard) or while focus is parked on the file input (a
// prevented tap still delivers its click — device-proven — so the picker
// re-presents instead of the tap dying as a blur). Never from idle.
export function preservesFocus(w: World): boolean {
  return w.editorFocused || w.fileFocused;
}

// Experiment (v0.1.21): the dismissing tap is the LAST real touch before
// WKFileUploadPanel's teardown reclaims first responder (~0.5–1s later) and
// collapses a keyboard the user never dismissed (device-proven 2026-07-28:
// the keyboard SURVIVES presentation and dies at teardown-complete, ~25–40ms
// after the window refocus). iOS grants keyboards only to a focus change made
// inside a real touch — so this tap is the only moment the page can re-assert
// ownership. Cycle blur()+focus() synchronously in the dismissing tap's own
// handler and let the taplog grade whether the teardown still snatches it.
// Only when: the tap actually dismissed a session ("settled"), an editor is
// focused, the keyboard is provably up, and the tap is NOT on the editor
// itself (a tap there is iOS's own natural focus path — injecting a blur
// mid-tap could drop the very keyboard we're defending).
export function shouldCycleFocus(
  settled: boolean,
  editorFocused: boolean,
  targetEditable: boolean,
  kb: boolean,
): boolean {
  return settled && editorFocused && !targetEditable && kb;
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

// THE one writer of shell presentation: two mode classes plus two measurements.
// styles.css owns what they mean (.kb collapses --pad-b, .kb-vv consumes the
// vars to override the four-edge pin).
function applyShell(t: ShellTarget): void {
  if (!appEl) return;
  const wasKb = appEl.classList.contains("kb");
  const wasTracking = appEl.classList.contains("kb-vv");
  if (t.kb !== wasKb) slog("shell.kb", t.kb ? `on h=${t.vvHeight} base=${baseline}` : "off");
  appEl.classList.toggle("kb", t.kb);

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
  applyShell({ ...t, trackViewport: t.kb && tracking });
}

const picker = createPickerLifecycle({
  present: (fresh: boolean) => {
    if (fresh) swapFileInput();
    slog("shell.present", fresh ? "files.click() [fresh]" : "files.click()");
    fileEl?.click();
  },
  dismiss: () => {
    slog("shell.settle", "blur files"); // logged BEFORE blur: act= shows parked state
    fileEl?.blur(); // parked focus is the tap-swallower; clear it on every path
    reconcile();
  },
});

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
    if (picker.teardownComplete() === "completed") releaseParkedEditor();
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
  // ~0.5s before the refocus signal), so this one only settles — plus, while
  // it is the one real touch available, the v0.1.21 focus-cycle experiment.
  document.addEventListener(
    "pointerdown",
    (e) => {
      const settled = picker.settle() === "settled";
      const active = document.activeElement;
      const cycle = shouldCycleFocus(
        settled,
        isEditable(active),
        isEditable(e.target),
        computeShell(readWorld()).kb,
      );
      if (!cycle) return;
      const tgt = e.target instanceof HTMLElement ? e.target.tagName.toLowerCase() : "?";
      slog("shell.cycle", `blur+focus tgt=${tgt}`);
      (active as HTMLElement).blur();
      (active as HTMLElement).focus();
    },
    true,
  );
}

// wire the compose ＋ button and file input; called per renderChat because the
// re-render recreates both elements. `pick` fires when files are chosen — it is
// re-attached to each fresh input, so the app's handler survives the swaps.
export function bindPicker(input: HTMLInputElement, button: HTMLElement, pick: () => void): void {
  fileEl = input;
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
    slog("shell.＋click", picker.open());
  });
}

// the current file input — it is replaced on fresh presents, so callers must
// never cache the element they were handed at bind time
export function currentFileInput(): HTMLInputElement | null {
  return fileEl;
}
