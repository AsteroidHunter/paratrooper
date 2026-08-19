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

// Tap-to-bottom glide plan — constant full speed while far away, braking only
// near the landing (the fixed-400ms-beat version scaled its speed with the
// distance, so a far jump blurred past and a short one crawled). Each frame's
// velocity is min(maxSpeed, k·remaining) with k = maxSpeed / (BRAKE_SCREENS
// viewports): beyond that crossover the cap wins (flat cruise, distance-blind),
// inside it speed falls in proportion to what's left — the exponential-feeling
// approach that eases to a stop. Pure and position-less: the wiring feeds it
// frame times, the live remaining distance, and the container height every
// frame, so content landing mid-glide simply grows `remaining` and the plan
// re-opens the throttle, still ending exactly at the true bottom. cancel() is
// the user taking the scroll back mid-flight — the run reports done and the
// wiring stops writing.
export const GLIDE_MAX_SPEED = 25; // px per ms of full-speed cruise
export const GLIDE_BRAKE_SCREENS = 2; // slowdown shows within this many viewports

export interface Glide {
  /** px to advance toward the landing this frame; 0 once landed or cancelled */
  step(nowMs: number, remaining: number, viewportHeight: number): number;
  /** the run is over: it landed exactly, or a gesture cancelled it */
  done(): boolean;
  cancel(): void;
  cancelled(): boolean;
}

export function createGlide(startMs: number, maxSpeed: number = GLIDE_MAX_SPEED): Glide {
  let lastMs = startMs;
  let landed = false;
  let cancelled = false;
  return {
    step(nowMs: number, remaining: number, viewportHeight: number): number {
      // rAF stamps the frame's vsync, which can predate the tap's own now()
      const dt = Math.max(nowMs - lastMs, 0);
      lastMs = nowMs;
      if (landed || cancelled) return 0;
      // the proportional rule only ever approaches the bottom, never touches
      // it — inside a sub-pixel (or past a bottom that moved up) land NOW
      if (remaining <= 1) {
        landed = true;
        return remaining;
      }
      const speed = Math.min(
        maxSpeed,
        (maxSpeed * remaining) / (GLIDE_BRAKE_SCREENS * viewportHeight),
      );
      const step = Math.min(remaining, speed * dt); // a stalled tab's huge dt must not overshoot
      if (step === remaining) landed = true;
      return step;
    },
    done: () => cancelled || landed,
    cancel(): void {
      cancelled = true;
    },
    cancelled: () => cancelled,
  };
}
