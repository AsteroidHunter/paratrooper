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
// One more gate, on top of all that: while the keyboard is up the chevron is
// never visible. It goes down as the keyboard comes up and it stays down
// however still the view gets, because typing is not scroll activity: the
// stillness window simply runs to its end behind the keys and used to surface
// the chevron on top of the typing box, where only reaching the bottom could
// take it away again. The close is ONE nudge back through scrolled(), the same
// call the scroll handler makes, so the ordinary three second rule decides all
// over again from scratch. Nothing is remembered and nothing is restored.
//
// Same shape as hold.ts: a pure state machine (unit-tested, driven entirely
// through the injectable pause window and the environment's timers — the
// window always restarts whole on a scroll, so no now() reading is needed)
// beneath a thin wiring in main.ts: the scroll handler feeds it at-bottom
// facts, shell.ts's keyboard edge feeds the gate, and it drives the .show
// class through the one callback.

export const PAUSE_MS = 3000;

export interface DownButton {
  /** every thread scroll event, with the handler's own nearBottom() verdict */
  scrolled(atBottom: boolean): void;
  /** the bottom was reached outside a scroll event (jump tap, fresh shell) */
  bottomReached(): void;
  /**
   * the keyboard's up/down edge (shell.ts), carrying the view's own at-bottom
   * verdict: up hides and holds hidden, down is one ordinary nudge
   */
  keyboard(up: boolean, atBottom: boolean): void;
  visible(): boolean;
}

export function createDownButton(
  setVisible: (show: boolean) => void,
  pauseMs: number = PAUSE_MS,
): DownButton {
  let shown = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // the keyboard gate: while this is true nothing may arm the window, so no
  // amount of typing stillness can surface the chevron over the typing box
  let kbUp = false;

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
    // behind a keyboard there is nothing to surface onto: the caret reveals
    // and the composer's own growth compensation fire scroll events while he
    // types, and every one of them used to restart a window that then closed
    // on top of the typing box
    if (kbUp) return;
    if (shown) return; // stays up while away; only the bottom takes it down
    disarm(); // still moving: the stillness window restarts from zero
    timer = setTimeout(() => {
      timer = null;
      apply(true);
    }, pauseMs);
  }

  function keyboard(up: boolean, atBottom: boolean): void {
    if (up === kbUp) return; // edges only: a repeated verdict is not an event
    kbUp = up;
    if (up) {
      // coming up: down it goes, pending window and all
      disarm();
      apply(false);
      return;
    }
    // gone: ONE nudge down the ordinary path. If the view is still away from
    // the bottom the usual stillness window runs and brings it back; if the
    // view is at the bottom this is the plain hide it always was.
    scrolled(atBottom);
  }

  return { scrolled, bottomReached, keyboard, visible: () => shown };
}

// Tap-to-bottom glide plan — a weight on a damped spring (device verdict on
// the piecewise cruise/brake/soften stack: do the motion right). The state is
// (remaining, velocity) and the one law is Hooke's with damping,
// x″ = −k·x − c·x′ on the remaining distance, with the damping ratio
// ζ = c/(2√k) held above critical: an at-least-critically damped spring
// cannot cross its rest point from this side of it, so no overshoot and no
// bounce ever, by construction rather than by clamp. Each frame integrates
// the CLOSED-FORM two-mode solution over the real dt (no Euler step to blow
// up; dt itself clamped so a background tab's stalled frame can't teleport),
// then caps: velocity and the frame's advance never exceed maxSpeed — the
// capped spring, so a far jump still cruises flat at the old full speed and
// only the approach changes. Stiffness comes from the live viewport
// (ω = maxSpeed / (SPRING_SCREENS·height)), tuned to the device verdict on
// the first spring: its whole slowdown read inside the last message, so the
// reach is now long enough that braking is READABLE about two screens out,
// while the damping sits just over critical so the shed spreads through
// those screens instead of stacking into the tail — the final crawl stays
// exactly as gentle as the settle he approved. Pure and
// position-less as before: the wiring feeds frame times, live remaining, and
// container height every frame, so content landing mid-glide simply grows
// `remaining` and the spring stretches — velocity carries over, the same
// flight bends instead of restarting, and it still ends exactly at the true
// bottom (converge, then snap once under a pixel and nearly still). cancel()
// is the user taking the scroll back mid-flight — the run reports done and
// the wiring stops writing.
export const GLIDE_MAX_SPEED = 25; // px per ms of full-speed cruise
export const GLIDE_SPRING_SCREENS = 3.0; // ω = maxSpeed / (this · viewport): reach long enough to read two screens out
export const GLIDE_DAMPING_RATIO = 1.02; // ζ, kept above 1 (critical): overshoot is impossible; near-critical keeps the tail from crawling
export const GLIDE_DT_MAX = 48; // ms of frame time integrated at most — a stalled tab's ceiling
export const GLIDE_SNAP_SPEED = 0.05; // px/ms; under a pixel out and this slow = landed

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
  let velocity = 0; // px/ms toward the bottom — the spring's carried state
  let landed = false;
  let cancelled = false;
  return {
    step(nowMs: number, remaining: number, viewportHeight: number): number {
      // rAF stamps the frame's vsync, which can predate the tap's own now();
      // the ceiling keeps a background tab's stalled frame from teleporting
      const dt = Math.min(Math.max(nowMs - lastMs, 0), GLIDE_DT_MAX);
      lastMs = nowMs;
      if (landed || cancelled) return 0;
      // the spring only ever converges on the bottom, never touches it — once
      // under a pixel and nearly still (or past a bottom that moved up) land
      // NOW, exactly
      if (remaining <= 0 || (remaining <= 1 && velocity <= GLIDE_SNAP_SPEED)) {
        landed = true;
        return remaining;
      }
      const omega = maxSpeed / (GLIDE_SPRING_SCREENS * viewportHeight);
      const spread = Math.sqrt(GLIDE_DAMPING_RATIO * GLIDE_DAMPING_RATIO - 1);
      const fast = omega * (GLIDE_DAMPING_RATIO + spread);
      const slow = omega * (GLIDE_DAMPING_RATIO - spread);
      // exact overdamped solution of x″ = −k·x − c·x′ across this frame
      // (x = remaining, x′ = −velocity): r(t) = a·e^(−fast·t) + b·e^(−slow·t)
      const a = (velocity - slow * remaining) / (fast - slow);
      const b = (fast * remaining - velocity) / (fast - slow);
      const decayFast = Math.exp(-fast * dt);
      const decaySlow = Math.exp(-slow * dt);
      const springRemaining = a * decayFast + b * decaySlow;
      // the capped spring: a huge displacement may not stretch speed past the
      // cruise cap — velocity state and this frame's advance both saturate
      velocity = Math.min(fast * a * decayFast + slow * b * decaySlow, maxSpeed);
      const step = Math.min(remaining - springRemaining, maxSpeed * dt, remaining);
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
