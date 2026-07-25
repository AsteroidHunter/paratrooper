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
// - Dismissing the picker menu only LOOKS instant: WKFileUploadPanel keeps
//   tearing down natively for another ~0.5–2s (swipe dismissals are slowest),
//   and a files.click() forwarded inside that window is silently DROPPED by
//   WebKit — the dead-＋-tap bug. Device-proven via taplog (2026-07-24): every
//   dead tap forwarded its click before the previous teardown's window-refocus
//   signal; every working tap came after. The old parked-focus theory was
//   falsified the same day — focus never parks on the file input. `cancel`
//   fires late or not at all (when it comes, it is always the LAST signal),
//   so teardown completion rides whichever signal lands first (window
//   refocus / cancel / change), and a too-early ＋ tap queues until then.
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

// Picker lifecycle, device-proven model (taplog sessions, 2026-07-24):
//   presented --settle()--> tearing --teardownComplete()--> idle
// settle() = "the native UI is gone from the screen" (page tap, refocus, …);
// teardownComplete() = "WebKit finished tearing the panel down" (window
// refocus / cancel / change). A ＋ tap during "tearing" would have its click
// dropped inside WebKit, so it queues and presents on the completion signal.
// TEARDOWN_MAX_MS never delays a tap — it only classifies a stale "tearing"
// (no signal ever came because the present was dropped and nothing is
// actually tearing down) so the next tap presents immediately instead of
// queueing forever. Effects are injected so all of this is testable.
export const TEARDOWN_MAX_MS = 2500;

export function createPickerLifecycle(
  effects: { present: () => void; dismiss: () => void },
  now: () => number = () => performance.now(),
) {
  let phase: "idle" | "presented" | "tearing" = "idle";
  let queued = false;
  let tearStart = 0;
  const present = (): void => {
    phase = "presented";
    effects.present();
  };
  return {
    isOpen: () => phase === "presented",
    isTearing: () => phase === "tearing",
    open(): "presented" | "queued" | "represented" {
      if (phase === "tearing") {
        if (now() - tearStart < TEARDOWN_MAX_MS) {
          queued = true; // WebKit would drop the click; present on the signal
          return "queued";
        }
        phase = "idle"; // signal never came: nothing was tearing down
      }
      if (phase === "presented") {
        // a ＋ click while a sheet is supposedly showing is impossible (a
        // real sheet swallows page clicks) — that present was dropped.
        // Clean up and re-present inside THIS tap's user gesture.
        effects.dismiss();
        present();
        return "represented";
      }
      present();
      return "presented";
    },
    settle(): void {
      if (phase !== "presented") return;
      phase = "tearing";
      tearStart = now();
      effects.dismiss();
    },
    // flush=false drops a queued tap instead of presenting it — the
    // return-to-app paths use it, where any queued intent is stale and a
    // deferred click would lack user activation anyway.
    teardownComplete(flush: boolean): "flushed" | "completed" | "noop" {
      if (phase !== "tearing") return "noop";
      phase = "idle";
      if (queued) {
        queued = false;
        if (flush) {
          present();
          return "flushed";
        }
      }
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
  // Picker signals, page-level and permanent (they survive renderChat
  // re-renders). Window refocus is the one teardown-complete marker present
  // in every observed trace, so it both settles a still-open session (swipe
  // dismissals produce no page tap) and flushes a queued ＋ tap.
  window.addEventListener("focus", () => {
    picker.settle();
    if (picker.teardownComplete(true) === "flushed") slog("shell.flush", "queued ＋ presented");
    reconcile();
  });
  // return-to-app paths: whatever was queued is stale — drop it, never ghost-present
  window.addEventListener("pageshow", () => {
    picker.settle();
    picker.teardownComplete(false);
    reconcile();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      picker.settle();
      picker.teardownComplete(false);
      reconcile();
    }
  });
  // a tap landing in OUR page means the native UI is gone from the screen —
  // but NOT that teardown finished (the dismissing tap itself leaks through
  // ~0.5s before the refocus signal), so this one only settles
  document.addEventListener("pointerdown", () => picker.settle(), true);
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
    slog("shell.＋click", picker.open());
  });
  // the input's own signals end the session AND mark teardown finished
  const sessionDone = (): void => {
    picker.settle();
    if (picker.teardownComplete(true) === "flushed") slog("shell.flush", "queued ＋ presented");
  };
  input.addEventListener("cancel", sessionDone);
  input.addEventListener("change", sessionDone);
}
