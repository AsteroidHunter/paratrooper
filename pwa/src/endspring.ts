// The ends of the thread — the rubber band iOS Safari hides from us.
//
// springscroll.ts drives the whole springy transcript from one number: the
// scroll position, read once per animation frame. That works everywhere except
// at the two ends. When a finger drags past the top or the bottom, iOS stretches
// the scroller past its limit and springs it back, but for an INNER scroller it
// never puts that overscroll into `scrollTop`: the position simply pins at 0 or
// at the maximum and sits there for the whole bounce. The frames see no delta,
// the lag melts, and the rows ride the bounce rigidly — which is exactly the one
// thing the third build could not reproduce (wiki: springy-scroll, "not
// replicable").
//
// So the overscroll is MODELLED here instead of measured. The moment the thread
// hits an end is known exactly (`scrollTop` reaches 0 or its maximum); from that
// marker this module runs its own rubber band, and main.ts adds the modelled
// overscroll to the position it hands the field. To the field a bounce is then
// indistinguishable from real scrolling: the same lag, the same time constant,
// the same anchor (the finger, left where it lifted), the same compress guard.
// Nothing is read back from Safari's own bounce.
//
// WHAT THE RECORDING SHOWED (the owner's Messages clip, tables in the wiki agent
// notes; measured by correlating every frame against a rest frame after the
// bounce, so the numbers carry no integration drift and read 0.0 px at rest):
//
//   - Four times in 62 s the thread reached its BOTTOM end. The top was never
//     reached, so every number below is from the bottom; the two ends are
//     mirror images in iOS and are treated as such here.
//   - Three finger pulls past the end, of 63.2, 90.5 and 25.0 CSS px, each held
//     for a frame and released.
//   - The spring back is CRITICALLY DAMPED. Fitting a second-order return with
//     the damping ratio free lands at zeta = 0.93, 1.10, 1.00 on the three; at
//     zeta = 1 exactly the fitted frequency is 10.35, 11.80 and 11.30 rad/s
//     (1.65, 1.88, 1.80 Hz) with an rms of 1.7, 3.3 and 0.9 device px against
//     peaks of 190, 271 and 75 — under 1.5% of the amplitude. A first-order
//     exponential (the transcript's own lag) fits 4 to 13 times worse: the
//     return ACCELERATES first, which only a spring does.
//   - Milestones: 50% of the pull gone at 140–165 ms, 63% at 181–209 ms, 90% at
//     340–364 ms, 99% at 512–576 ms. Overshoot past the end: none (0.09 device
//     px, 0.03 CSS px, at the worst of the three).
//   - The lag runs STRAIGHT THROUGH the bounce. Per-bubble residuals against a
//     rigid thread keep the linear profile the whole way: during one pull the
//     profile's slope gives a reference lag of 196.9 device px where speed x
//     45 ms is 199.8 (ratio 0.99), and through that bounce's spring back the
//     ratio holds between 1.2 and 1.7 frame after frame. A rigid thread is
//     refuted outright (residual rms up to 17.5 device px, dropping to 7.0 once
//     the lag profile is removed). So: same lag, same tau, driven by the
//     bounce's own motion — which is precisely what this module feeds it.
//
// WHAT THE RECORDING COULD NOT SHOW, taken from documentation instead:
//
//   - The pull versus the FINGER. A screen recording has no finger in it, so the
//     resistance curve could not be measured. RUBBER_C and `rubberBand` below
//     are Apple's documented UIScrollView formula. All the recording can say is
//     that the three pulls it holds are consistent with it: they imply finger
//     travels of 128, 193 and 48 CSS px on a ~620 px scroller, which are
//     ordinary flicks.
//   - A FLING hitting the end at speed. The clip has no such bounce: its one
//     coast that reached the bottom arrived with its momentum already spent
//     (0.23 CSS px/ms) and stopped at the end with zero overshoot — which is
//     what IMPACT_MIN_SPEED is set from. The impact case therefore runs the same
//     measured spring with the impact speed as its initial velocity, giving a
//     peak of speed / (omega x e) at 1 / omega ~= 89 ms. The one consistency
//     check available: the recording's largest pull crossed the end at 4640
//     device px/s while the finger was still pushing, and the spring predicts a
//     153 device px peak at 90 ms against a measured 180 at 86 ms — the timing
//     matches and the height is 18% high, which the finger still pushing
//     explains. That is not a measurement of the fling case and is not claimed
//     as one.
//
// Pure and DOM-free, like springscroll.ts: a scroll position, a limit and a
// finger in, one signed overscroll out. Sign follows `scrollTop`: NEGATIVE past
// the top (as if the position went below 0), POSITIVE past the bottom (as if it
// went past the maximum), and EXACTLY zero everywhere else, so the hand-back to
// the normal path is a no-op rather than a step.

// ---- every tunable, in one place ---------------------------------------------
export const END_TUNING = {
  /** Apple's rubber-band coefficient. `rubberBand` below is the documented
      UIScrollView curve; 0.55 is the constant it ships with, and it is the
      curve's slope at the end, so the content follows the finger at 55% of its
      travel there and less further out. NOT measured from the recording (no
      finger is visible in a screen recording). */
  RUBBER_C: 0.55,
  /** the bounce spring, RAD PER SECOND, critically damped. Fitted 10.35 / 11.30
      / 11.80 on the recording's three releases (1.65 / 1.80 / 1.88 Hz); 11.2 is
      their middle, 1.78 Hz. The character knob: larger = a shorter, snappier
      bounce. At 11.2 the return is 50% done at 150 ms, 63% at 184 ms, 90% at
      347 ms and home by 593 ms (measured 140–165 / 181–209 / 340–364 / 512–576),
      and a fling peaks at speed / (omega x e) after 1 / omega = 89 ms. */
  BOUNCE_OMEGA: 11.2,
  /** ceiling on the modelled overscroll, as a fraction of the scroller's
      height. A finger would need 2.2 screens of travel to pull this far, so it
      only ever binds a fling, and only past 11.7 px/ms of impact — a speed no
      thumb produces. */
  MAX_OVER_FRACTION: 0.55,
  /** a coast arriving at the end slower than this (px/ms) is modelled as
      landing, not bouncing. The recording's one soft arrival came in at 0.23
      px/ms and overshot by nothing at all. */
  IMPACT_MIN_SPEED: 0.3,
  /** how much of the modelled overscroll reaches the lag. 1 = the bounce drives
      it exactly as real scrolling does, which is what the recording's pull
      measured (a ratio of 0.99 against speed x tau). Lower = a quieter bounce. */
  FEED_GAIN: 1,
  /** home: under this the overscroll is set to EXACTLY zero and the model hands
      back, so the normal path resumes with no step. */
  REST_EPS_PX: 0.25,
  /** a stalled frame (a backgrounded tab) is clamped to this, so the spring can
      never teleport across a gap it did not animate. */
  DT_MAX_MS: 48,
} as const;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Apple's rubber-band resistance: a finger `travel` px past the end moves the
 * content only this far. Documented UIScrollView curve
 *
 *     b = (1 - 1 / (travel * c / d + 1)) * d
 *
 * with `d` the scroller's own height and `c` = 0.55. Its slope at the end is `c`
 * itself, so the content follows the finger at 55% there and less further out,
 * and it asymptotes at `d`: the end resists from the first pixel and never runs
 * away. Not measured off the recording — a screen recording has no finger in it.
 */
export function rubberBand(travel: number, dimension: number, c: number = END_TUNING.RUBBER_C): number {
  if (travel <= 0 || dimension <= 0) return 0;
  return (1 - 1 / ((travel * c) / dimension + 1)) * dimension;
}

/** the inverse: the finger travel that produces `offset` px of pull. Only used
    to state the recording's pulls in finger terms; the model never needs it. */
export function rubberTravel(offset: number, dimension: number, c: number = END_TUNING.RUBBER_C): number {
  if (offset <= 0 || dimension <= 0 || offset >= dimension) return Infinity;
  return (dimension / c) * (1 / (1 - offset / dimension) - 1);
}

/**
 * Advance the critically damped bounce over one frame, in closed form, so the
 * result does not depend on the frame rate: a 33 ms frame lands exactly where
 * two 16.7 ms frames do. For x'' + 2*w*x' + w^2*x = 0,
 *
 *     x(t) = (x + (v + w*x) * t) * e^(-w*t)
 *     v(t) = (v - w * (v + w*x) * t) * e^(-w*t)
 *
 * Released from rest it never crosses the end (the measured bounces overshoot by
 * 0.03 CSS px, i.e. nothing); given an inward velocity it lands without
 * crossing either, which is what "the model must end at exactly zero" needs.
 *
 * `dt` is MILLISECONDS and `v` is px per millisecond (the units the pump and
 * springscroll.ts already work in); `omega` is rad per SECOND, the way the
 * tunable and the fits read, and is converted here.
 */
export function advanceBounce(
  x: number,
  v: number,
  dt: number,
  omega: number = END_TUNING.BOUNCE_OMEGA,
): [number, number] {
  if (dt <= 0) return [x, v];
  const w = omega / 1000; // rad/ms
  const e = Math.exp(-w * dt);
  const b = v + w * x;
  return [(x + b * dt) * e, (v - w * b * dt) * e];
}

/** the peak a fling of `speed` px/ms reaches past the end: the critically damped
    spring's x = v*t*e^(-w*t) peaks at v/(w*e), reached at t = 1/w (89 ms). */
export function bouncePeak(speed: number, omega: number = END_TUNING.BOUNCE_OMEGA): number {
  return (Math.abs(speed) * 1000) / (omega * Math.E);
}

export type EndPhase = "idle" | "pulling" | "bouncing";

export interface EndSpringModel {
  /** a gesture opens (main.ts's armSpring): whether a finger is on the glass,
      and its screen-Y (null for a wheel or a pointer, which never rubber-band —
      those get the fling path only). */
  begin(held: boolean, fingerScreenY: number | null): void;
  /** the finger moved: the pull is measured from where the end marker fired */
  finger(screenY: number): void;
  /** the finger left the glass: a pull becomes a bounce carrying its own speed */
  lift(): void;
  /**
   * One animation frame. `scrollTop`, its maximum and the scroller's height go
   * in; the modelled overscroll to ADD to the position comes out — negative
   * past the top, positive past the bottom, EXACTLY zero the rest of the time.
   */
  frame(nowMs: number, scrollTop: number, maxScrollTop: number, viewportH: number): number;
  /** the modelled overscroll as it stands (the same number `frame` returned) */
  over(): number;
  /** a pull or a bounce is live: the pump must keep asking for frames */
  active(): boolean;
  phase(): EndPhase;
  /** zero it now and drop the gesture (the hold-off: an app motion is starting) */
  freeze(): void;
  /** fresh shell: drop all state */
  reset(): void;
}

export function createEndSpring(
  opts: {
    omega?: number;
    rubberC?: number;
    maxFraction?: number;
    impactMin?: number;
    gain?: number;
  } = {},
): EndSpringModel {
  const omega = opts.omega ?? END_TUNING.BOUNCE_OMEGA;
  const rubberC = opts.rubberC ?? END_TUNING.RUBBER_C;
  const maxFraction = opts.maxFraction ?? END_TUNING.MAX_OVER_FRACTION;
  const impactMin = opts.impactMin ?? END_TUNING.IMPACT_MIN_SPEED;
  const gain = opts.gain ?? END_TUNING.FEED_GAIN;

  let armedNow = false;
  let held = false;
  let fingerY: number | null = null;
  let ph: EndPhase = "idle";
  let x = 0; // the modelled overscroll, signed like scrollTop
  let vx = 0; // its velocity, px/ms
  let side = 0; // -1 past the top, +1 past the bottom, 0 = not at an end
  let originY: number | null = null; // the finger where the marker fired
  let grabbed = false; // a finger landed on a live bounce: re-seat the origin
  let lastMs: number | null = null;
  let lastSt: number | null = null;
  let lastSpeed = 0; // px/ms, measured on the last frame that ended AWAY from an end

  function clearPull(): void {
    ph = "idle";
    x = 0;
    vx = 0;
    side = 0;
    originY = null;
    grabbed = false;
  }

  function begin(fingerDown: boolean, screenY: number | null): void {
    held = fingerDown;
    if (screenY !== null) fingerY = screenY;
    if (!armedNow) {
      // a fresh gesture: the next frame is a baseline, so no speed from before
      // it is ever read as an impact
      lastMs = null;
      lastSt = null;
      lastSpeed = 0;
    }
    armedNow = true;
    // A finger landing mid-bounce takes the band over WHERE IT STANDS. The
    // spring's momentum is dropped and the pull takes over, but the overscroll
    // itself is kept and the origin re-seated so that this finger position
    // already produces it (`grabbed`, done in frame() where the scroller's
    // height is known): dropping it here instead would hand the lag the whole
    // remaining bounce as one frame's delta, and the rows would lurch.
    if (fingerDown && ph === "bouncing") {
      vx = 0;
      originY = null;
      grabbed = true;
    }
  }

  function finger(screenY: number): void {
    fingerY = screenY;
  }

  function lift(): void {
    held = false;
    // the pull becomes a bounce: it keeps the displacement AND the speed the
    // finger left it with, which is what lets a flick past the end carry a
    // little further out before it returns, exactly as iOS does
    if (ph === "pulling") ph = x === 0 ? "idle" : "bouncing";
  }

  function frame(nowMs: number, scrollTop: number, maxScrollTop: number, viewportH: number): number {
    if (!armedNow) return 0;
    const max = Math.max(maxScrollTop, 0);
    if (lastMs === null || lastSt === null) {
      lastMs = nowMs;
      lastSt = scrollTop;
      return x; // a clock and position reading only
    }
    const dt = clamp(nowMs - lastMs, 0, END_TUNING.DT_MAX_MS);
    const speed = dt > 0 ? (scrollTop - lastSt) / dt : 0;
    lastMs = nowMs;
    lastSt = scrollTop;

    // The engine may report its own overscroll (a desktop elastic scroll, or an
    // iOS that one day exposes an inner scroller's). Whatever it reports is
    // already in scrollTop and already drives the lag, so the model stands down
    // rather than double-counting it.
    const seen = scrollTop < 0 ? scrollTop : scrollTop > max ? scrollTop - max : 0;
    if (seen !== 0 || max <= 0) {
      clearPull();
      return 0;
    }

    const atTop = scrollTop <= 0;
    const atBottom = scrollTop >= max;
    const dim = Math.max(viewportH, 1);
    const cap = dim * maxFraction;

    if (!atTop && !atBottom) {
      // away from both ends: nothing is modelled, and this frame's speed is the
      // one an impact would be read from (the frame that lands ON the end has
      // its delta clipped by the engine and understates it)
      lastSpeed = speed;
      if (ph !== "idle") clearPull();
      return 0;
    }

    // ---- the marker: the thread is at an end this frame -----------------------
    const endSide = atTop ? -1 : 1;

    if (held) {
      // A FINGER IS DOWN: the modelled overscroll follows its extra travel
      // through the rubber-band curve. The travel is measured from where the
      // finger was when the marker fired, so a drag that arrives at the end at
      // speed starts its pull from zero rather than from wherever it began.
      if (ph !== "pulling" || side !== endSide || originY === null) {
        // the band was already stretched when this finger landed: seat the
        // origin so this very position reproduces it, and nothing jumps
        const back =
          grabbed && side === endSide && x !== 0 && fingerY !== null
            ? rubberTravel(Math.abs(x), dim, rubberC)
            : Infinity;
        ph = "pulling";
        side = endSide;
        vx = 0;
        if (Number.isFinite(back) && fingerY !== null) {
          originY = fingerY + endSide * back;
        } else {
          originY = fingerY;
          x = 0;
        }
        grabbed = false;
      }
      if (originY === null || fingerY === null) return 0; // a wheel: no finger to pull with
      // past the TOP the finger travels DOWN the screen, past the BOTTOM it
      // travels UP: both are "further into the end"
      const travel = endSide < 0 ? fingerY - originY : originY - fingerY;
      const prev = x;
      if (travel <= 0) {
        // back inside: the band is slack and the next outward move starts fresh
        // from here (the scroller itself takes over the moment it leaves the
        // limit). The phase stays `pulling` — the marker is still armed on this
        // end, it just has nothing to show — so the origin survives a finger
        // that wanders back and forth across it.
        originY = fingerY;
        x = 0;
      } else {
        x = endSide * Math.min(rubberBand(travel, dim, rubberC), cap);
      }
      vx = dt > 0 ? (x - prev) / dt : 0;
      return x * gain;
    }

    // NO FINGER. Either a bounce is already running, or a fling has just
    // arrived at the end and this frame is the impact.
    if (ph === "bouncing" || ph === "pulling") {
      // a lift that landed here before `lift()` ran still counts as a bounce
      ph = "bouncing";
      [x, vx] = advanceBounce(x, vx, dt, omega);
      if (Math.abs(x) < END_TUNING.REST_EPS_PX && Math.abs(vx) * dt < END_TUNING.REST_EPS_PX) {
        // EXACTLY zero, and the gesture is handed back with no step
        clearPull();
        return 0;
      }
      // the band may never model further out than a finger could pull
      if (Math.abs(x) > cap) {
        x = endSide * cap;
        vx = 0;
      }
      return x * gain;
    }

    // the impact: the speed the thread carried into the end, taken from the LAST
    // FRAME THAT ENDED AWAY FROM IT. This frame's own delta covers only what was
    // left of the gap, so it understates the fling badly; and momentum only
    // decays, so the previous frame is both the honest reading and a ceiling. It
    // is also why a programmatic jump onto an end cannot fake a bounce: its
    // giant delta lands in the clipped frame, which is not read.
    const impact = lastSpeed;
    lastSpeed = 0; // one impact per arrival
    if (Math.sign(impact) !== endSide || Math.abs(impact) < impactMin) {
      // a crawl into the end lands rather than bounces (the recording's one soft
      // arrival came in at 0.23 px/ms and overshot by nothing)
      clearPull();
      return 0;
    }
    ph = "bouncing";
    side = endSide;
    x = 0;
    // peak = v / (w * e), so this is the speed whose peak is exactly the ceiling
    const vMax = (cap * (omega / 1000) * Math.E) / 1;
    vx = clamp(impact, -vMax, vMax);
    [x, vx] = advanceBounce(x, vx, dt, omega);
    return x * gain;
  }

  return {
    begin,
    finger,
    lift,
    frame,
    over: () => x * gain,
    // a finger resting on an end is `pulling` with nothing to show: the marker
    // is armed but there are no frames to ask for until it actually pulls
    active: () => ph === "bouncing" || x !== 0,
    phase: () => ph,
    freeze: () => {
      clearPull();
      armedNow = false;
      held = false;
      lastMs = null;
      lastSt = null;
      lastSpeed = 0;
    },
    reset: () => {
      clearPull();
      armedNow = false;
      held = false;
      fingerY = null;
      lastMs = null;
      lastSt = null;
      lastSpeed = 0;
    },
  };
}
