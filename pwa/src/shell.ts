// The iOS shell boundary: keyboard geometry, focus lifecycle, and file-picker
// sessions live HERE and nowhere else. Same discipline as the thread's event
// store: the world is the truth, the DOM is a projection, and every signal —
// whichever ones iOS deigns to fire, in whatever order — converges through one
// reconcile(). No handler owns choreography, so a skipped, duplicated, or
// stale event cannot strand shell state.
//
// iOS facts this module encodes (each cost a bug round; pinned in tests/):
// - The layout viewport never resizes for the keyboard (WebKit has no
//   interactive-widget support); the visual viewport is the only honest
//   measurement, and only while an editor is provably focused — iOS 26
//   reports stale height/offsetTop after dismissal (webkit bug 297779), so
//   sub-keyboard deltas read as "no keyboard" (a real one costs hundreds of px).
// - The picker flow can park system focus on the invisible file input, and
//   `cancel` is NOT guaranteed on dismissal (iOS 26 drops it when the
//   three-option menu is swiped away; cf. the WebKit 26.2 "upload button
//   stops working" fix). Parked focus makes iOS consume the next tap as a
//   blur — the every-second-＋-tap-dead bug. So picker cleanup is a race —
//   cancel / change / window-refocus / visibility / next page tap, first
//   signal wins, settle runs exactly once — never a bet on one event.
// - While an editable is focused, a ＋ tap must preventDefault on pointerdown
//   (or the keyboard collapses mid-presentation and the menu anchors to a
//   stale rect); from idle it must NOT (or iOS swallows the next focus tap).

// --- pure decision core (unit-tested; no DOM, no iOS) --------------------------

export interface World {
  editorFocused: boolean; // textarea or non-file input holds focus
  fileFocused: boolean; // focus parked on the picker's file input
  innerHeight: number;
  vvHeight: number;
  vvTop: number;
}

export interface ShellTarget {
  kb: boolean; // keyboard provably up: track the visual viewport
  vvTop: number;
  vvHeight: number;
}

// a real keyboard shrinks the viewport by hundreds of px; smaller deltas are
// iOS 26's stale-viewport lie or a focus pan, and must read as "no keyboard"
export const MIN_KEYBOARD_PX = 100;

export function keyboardInset(innerHeight: number, vvHeight: number): number {
  const delta = innerHeight - vvHeight;
  return delta >= MIN_KEYBOARD_PX ? delta : 0;
}

export function computeShell(w: World): ShellTarget {
  return {
    kb: w.editorFocused && keyboardInset(w.innerHeight, w.vvHeight) > 0,
    vvTop: w.vvTop,
    vvHeight: w.vvHeight,
  };
}

// ＋ pointerdown: should the tap preserve existing focus? Yes while an editor
// is up (keep the keyboard) or while focus is parked on the file input (a
// prevented tap still delivers its click — device-proven — so the picker
// re-presents instead of the tap dying as a blur). Never from idle.
export function preservesFocus(w: World): boolean {
  return w.editorFocused || w.fileFocused;
}

// Picker lifecycle: open() presents, settle() cleans up EXACTLY once no matter
// how many completion signals arrive or which one comes first. Effects are
// injected so the once-semantics are testable.
export function createPickerLifecycle(effects: { present: () => void; dismiss: () => void }) {
  let open = false;
  const settle = (): void => {
    if (!open) return;
    open = false;
    effects.dismiss();
  };
  return {
    isOpen: () => open,
    settle,
    open(): void {
      settle(); // reaching ＋ again means any stale session's UI is gone
      open = true;
      effects.present();
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
let fileEl: HTMLInputElement | null = null; // rebound on every renderChat

function readWorld(): World {
  const a = document.activeElement;
  const vv = window.visualViewport;
  return {
    editorFocused: isEditable(a),
    fileFocused: fileEl !== null && a === fileEl,
    innerHeight: window.innerHeight,
    vvHeight: vv?.height ?? window.innerHeight,
    vvTop: vv?.offsetTop ?? 0,
  };
}

// THE one writer of shell presentation: a mode class plus two measurements.
// styles.css owns what they mean (#app.kb consumes the vars, collapses --pad-b).
function applyShell(t: ShellTarget): void {
  if (!appEl) return;
  const was = appEl.classList.contains("kb");
  if (t.kb !== was) slog("shell.kb", t.kb ? `on top=${t.vvTop} h=${t.vvHeight}` : "off");
  if (t.kb) {
    appEl.style.setProperty("--vv-top", `${t.vvTop}px`);
    appEl.style.setProperty("--vv-height", `${t.vvHeight}px`);
    appEl.classList.add("kb");
  } else {
    appEl.classList.remove("kb");
    appEl.style.removeProperty("--vv-top");
    appEl.style.removeProperty("--vv-height");
    if (was) window.scrollTo(0, 0); // clear the keyboard's layout-viewport pan
  }
}

export function reconcile(): void {
  applyShell(computeShell(readWorld()));
}

const picker = createPickerLifecycle({
  present: () => {
    slog("shell.present", "files.click()");
    fileEl?.click();
  },
  dismiss: () => {
    slog("shell.settle", "blur files"); // logged BEFORE blur: act= shows parked state
    fileEl?.blur(); // parked focus is the tap-swallower; clear it on every path
    reconcile();
  },
});

export function initShell(el: HTMLElement): void {
  appEl = el;
  document.addEventListener("focusin", reconcile);
  // one frame's grace on focusout: focus may be hopping between editables
  document.addEventListener("focusout", () => requestAnimationFrame(reconcile));
  window.visualViewport?.addEventListener("resize", reconcile);
  window.visualViewport?.addEventListener("scroll", reconcile);
  // picker-completion racers. Page-level and permanent (they survive renderChat
  // re-renders); each means "any native picker UI is gone". settle() no-ops
  // unless a session is actually open.
  window.addEventListener("focus", () => {
    picker.settle();
    reconcile();
  });
  window.addEventListener("pageshow", () => {
    picker.settle();
    reconcile();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      picker.settle();
      reconcile();
    }
  });
  // a tap landing in OUR page also means native UI is gone; settling in the
  // capture phase un-parks focus before the tap's default handling can be
  // consumed by the blur
  document.addEventListener("pointerdown", picker.settle, true);
}

// wire the compose ＋ button and file input; called per renderChat because the
// re-render recreates both elements
export function bindPicker(input: HTMLInputElement, button: HTMLElement): void {
  fileEl = input;
  button.addEventListener("pointerdown", (e) => {
    const w = readWorld();
    const preserve = preservesFocus(w);
    slog(
      "shell.＋pd",
      `editor=${w.editorFocused ? 1 : 0} file=${w.fileFocused ? 1 : 0}` +
        ` open=${picker.isOpen() ? 1 : 0} preventDefault=${preserve ? 1 : 0}`,
    );
    if (preserve) e.preventDefault();
  });
  button.addEventListener("click", () => {
    slog("shell.＋click", picker.isOpen() ? "stale session still open" : "");
    picker.open();
  });
  input.addEventListener("cancel", picker.settle);
  input.addEventListener("change", picker.settle);
}
