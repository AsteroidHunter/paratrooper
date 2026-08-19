// Jump-to-latest visibility — the chevron must never chase the reader.
//
// The ONLY way it appears: the view is away from the bottom AND no scroll
// activity has happened for PAUSE_MS. Every scroll event while away restarts
// that stillness window, so the chevron surfaces exactly when reading has
// settled somewhere up-thread. Once shown it stays shown until the bottom is
// reached (a scroll landing there or the jump tap), which hides it and clears
// everything; at or near the bottom it never appears. New content landing at
// the tail no longer shows it — that trigger is gone on purpose.
//
// Same shape as hold.ts: a pure state machine (unit-tested, driven entirely
// through the injectable pause window and the environment's timers — the
// window always restarts whole on a scroll, so no now() reading is needed)
// beneath a thin wiring in main.ts: the scroll handler feeds it at-bottom
// facts, and it drives the .show class through the one callback.

export const PAUSE_MS = 4000;

export interface DownButton {
  /** every thread scroll event, with the handler's own nearBottom() verdict */
  scrolled(atBottom: boolean): void;
  /** the bottom was reached outside a scroll event (jump tap, fresh shell) */
  bottomReached(): void;
  visible(): boolean;
}

export function createDownButton(
  setVisible: (show: boolean) => void,
  pauseMs: number = PAUSE_MS,
): DownButton {
  let shown = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function disarm(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  // edge-triggered: the callback fires only on a real change, so the wiring
  // never spams classList writes on every scroll event
  function apply(next: boolean): void {
    if (next === shown) return;
    shown = next;
    setVisible(next);
  }

  function bottomReached(): void {
    disarm();
    apply(false);
  }

  function scrolled(atBottom: boolean): void {
    if (atBottom) return bottomReached();
    if (shown) return; // stays up while away; only the bottom takes it down
    disarm(); // still moving: the stillness window restarts from zero
    timer = setTimeout(() => {
      timer = null;
      apply(true);
    }, pauseMs);
  }

  return { scrolled, bottomReached, visible: () => shown };
}

// Tap-to-bottom glide plan — ONE continuous decelerating scroll over the
// whole distance in a fixed beat, so a long jump simply moves faster: no
// teleport step anywhere (the hop-then-glide version read as a jump cut from
// far up). Pure: the wiring drives it from rAF timestamps and re-reads the
// live bottom every frame, so content landing mid-glide still ends the run
// exactly at the true bottom. cancel() is the user taking the scroll back
// mid-flight — the run reports done and the wiring stops writing.
export const GLIDE_MS = 400;

export interface Glide {
  /** eased scrollTop for this frame; target is the CURRENT landing scrollTop */
  at(nowMs: number, target: number): number;
  /** the run is over: the beat has elapsed, or a gesture cancelled it */
  done(nowMs: number): boolean;
  cancel(): void;
  cancelled(): boolean;
}

export function createGlide(from: number, startMs: number, beatMs: number = GLIDE_MS): Glide {
  let cancelled = false;
  return {
    at(nowMs: number, target: number): number {
      const t = Math.min(Math.max((nowMs - startMs) / beatMs, 0), 1);
      const eased = 1 - (1 - t) ** 3; // ease-out cubic: fast launch, soft landing
      return from + (target - from) * eased;
    },
    done: (nowMs: number) => cancelled || nowMs - startMs >= beatMs,
    cancel(): void {
      cancelled = true;
    },
    cancelled: () => cancelled,
  };
}
