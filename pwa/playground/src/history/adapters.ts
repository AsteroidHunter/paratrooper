// Driving an old build from this tool's wiring.
//
// The spring-0-3-*.ts and end-*.ts files beside this one are copies, byte for
// byte, of the modules each of those commits pushed (PROVENANCE.txt has the
// commits and hashes, and tests/historysource.test.ts re-checks them against
// reference/history/manifest.json). Nothing in them is edited, retuned or
// modernised. This file is the only new code in the directory and it does three
// things and no more:
//
//   1. constructs each field and each end model with the constants that build
//      documented, passed explicitly rather than left to the module's own
//      defaults, so what runs is the recorded configuration and not whatever
//      the file happens to default to;
//   2. gives 0.3.121 the gesture-shaped interface every later build exports;
//   3. pairs each spring with the end model that was pushed WITH it, including
//      the four builds that had no end model at all.
//
// WHAT AN ADAPTER MAY NOT DO. It may not change a number to make a build look
// better or worse, and it may not paper over a behaviour. 0.3.124 really does
// treat a frame the browser delivered no scroll on as a stop; 0.3.121 really
// does cap every row at 10 px; 0.3.132's first end model really does step when
// a bounce is caught. Those are the findings the later builds were made to fix,
// and hiding them would make the picker a lie.

import { createNoEnd } from "../engine";
import type { EndModel, SpringEngine } from "../engine";
import type { SpringRow } from "../vendor/springscroll";
import { createEndSpring as createEndReseat } from "../vendor/endspring";
import type { ConfigEntry, EndKind, SpringKind } from "../presets";
import * as s121 from "./spring-0-3-121";
import * as s123 from "./spring-0-3-123";
import * as s124 from "./spring-0-3-124";
import * as s132 from "./spring-0-3-132";
import * as s134 from "./spring-0-3-134";
import * as s140 from "./spring-0-3-140";
import * as s141 from "./spring-0-3-141";
import * as s148 from "./spring-0-3-148";
import * as endInitial from "./end-initial";
import * as endCatch from "./end-catch";

/** the live sliders, read once when a historical field is built */
export interface SharedNumbers {
  tau: number;
  divisor: number;
  strain: number;
}

const num = (c: Readonly<Record<string, number>>, key: string, fallback: number): number => {
  const v = c[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
};

/** 0.3.121's own disarm rule, from its main.ts: SPRING_QUIET_MS. A drag or its
    momentum stays live until the scroll has been quiet this long. */
const QUIET_MS_121 = 180;

/**
 * 0.3.121 onto the gesture interface.
 *
 * That build had no gesture object and no phase. Its controller (main.ts
 * 1701-1857 of the snapshot; reference/history/integration-map.json has the
 * spans) held the state itself, and this wrapper holds the same state in the
 * same way rather than treating the module as a modern field:
 *
 *   - armSpring REBASES the delta reference, AT THE MOMENT THE GESTURE OPENS.
 *     The first position of a gesture is a reference, never a stretch. The
 *     wiring hands the position over through rebase() the moment it arms, which
 *     is where 0.3.121's own armSpring took it.
 *
 *     ONE DEPARTURE, AND IT IS DELIBERATE. That build re-took the reference on
 *     EVERY arm, and a wheel arms on every tick. An independent observer ran
 *     the untouched module through that exact sequence on real Chromium wheel
 *     events: a passive handler sees an already-advanced scrollTop, so the
 *     reference lands on the position the next frame will report and 480 px of
 *     wheel moves nothing. That is the old controller under today's delivery,
 *     not a fault in its springs. playground.ts therefore rebases only a FRESH
 *     gesture, which is a fixture adaptation of wheel admission rather than a
 *     replay, and is named as one there, in presets.ts and in the panel.
 *   - the delta is injected from the SCROLL, not from the frame. A frame on
 *     which the position did not change injected nothing, so this calls
 *     `scroll` only when the position really moved.
 *   - `frame(now)` relaxes the springs on every animation frame while any of
 *     them is still moving, which is what its pump did.
 *   - the anchor is set when the gesture opens and NOT updated as the finger
 *     travels: that build's touchmove did not re-anchor, so `anchor()` here is
 *     deliberately a no-op. It is a screen position, re-read into content space
 *     on every scroll, so the vertex rides the glass rather than the thread.
 *   - a finger that is not down anchors on the viewport centre, which is what
 *     `threadTouching ? springTouchY : null` did.
 *   - the gesture ends on a QUIET TIMER, 180 ms after the last scroll it owned,
 *     not on the lift. A lift only stops the finger being the anchor.
 *
 * `phase()` and `lag()` have no counterpart in this build at all. They exist
 * for the readout line, they are derived here and nowhere else, and presets.ts
 * marks this entry as having no reference lag so the readout says "largest
 * offset" rather than inventing one.
 */
function adapt121(c: Readonly<Record<string, number>>, shared: SharedNumbers): SpringEngine {
  const field = s121.createSpringField({
    omega: (2 * Math.PI * num(c, "SPRING_FREQUENCY_HZ", 1.4)) / 1000,
    divisor: shared.divisor,
    resistanceMax: num(c, "RESISTANCE_MAX", 0.5),
    cap: num(c, "DISPLACEMENT_CAP_PX", 10),
    buffer: num(c, "PARTICIPATION_BUFFER_PX", 120),
  });
  let isArmed = false;
  let held = false;
  let clientH = 0;
  let threadTop = 0;
  let anchorY: number | null = null;
  let lastScroll: number | null = null;
  /** the arm's own bumpSpringQuiet, stamped on the frame that follows it */
  let armPending = false;
  let quietAt = -Infinity;
  let moving = false;

  const drop = (): void => {
    isArmed = false;
    held = false;
    lastScroll = null;
    armPending = false;
    quietAt = -Infinity;
    moving = false;
  };

  return {
    measure: (rows) => field.measure(rows),
    begin: (ch, top, screenY, fingerDown) => {
      clientH = ch;
      threadTop = top;
      anchorY = screenY;
      held = fingerDown;
      isArmed = true;
      armPending = true;
    },
    rebase: (scrollTop) => {
      // armSpring's own line, at armSpring's own moment
      field.rebase(scrollTop);
      lastScroll = scrollTop;
      moving = false;
    },
    anchor: () => {
      /* 0.3.121 did not re-anchor on a finger's travel */
    },
    lift: () => {
      held = false; // the quiet timer, not the lift, ends the gesture
    },
    frame: (nowMs, scrollTop) => {
      if (armPending) {
        quietAt = nowMs;
        armPending = false;
      }
      if (!isArmed) {
        // an idle drift or a write nobody asked for: reference only, no stretch
        field.rebase(scrollTop);
        lastScroll = scrollTop;
        moving = false;
      } else if (lastScroll === null) {
        // no reference yet: this position is one, which is what the module's
        // own first-reading rule does
        field.rebase(scrollTop);
        lastScroll = scrollTop;
        moving = false;
      } else {
        moving = scrollTop !== lastScroll;
        if (moving) {
          field.scroll(scrollTop, clientH, threadTop, held ? anchorY : null);
          quietAt = nowMs;
        }
        lastScroll = scrollTop;
      }
      field.frame(nowMs);
      if (isArmed && nowMs - quietAt >= QUIET_MS_121) {
        isArmed = false;
        moving = false;
      }
    },
    displacements: () => field.displacements(),
    // A LIVE ARM IS A REASON TO KEEP ASKING FOR FRAMES, even when no spring is
    // moving. The gesture ends on a 180 ms quiet timer, and the only place that
    // timer is read is frame(); 0.3.121 could afford that because its timer was
    // a real setTimeout that fired whether or not the pump was running. Here
    // the pump stops as soon as nothing wants a frame, so an arm that injected
    // nothing - a wheel tick the browser then did not scroll, a finger that
    // landed and never moved - would leave the gesture armed for good, and an
    // armed field is one gesture.ts will not re-open on a later bare scroll.
    // Reporting the arm keeps the clock running until it lapses, which costs
    // the eleven frames the original's timeout cost anyway.
    active: () => field.active() || isArmed,
    armed: () => isArmed,
    phase: () => {
      if (!field.active() && !moving) return "idle";
      if (moving) return held ? "driving" : "coasting";
      return "settling";
    },
    lag: () => {
      let m = 0;
      for (const dy of field.displacements().values()) m = Math.max(m, Math.abs(dy));
      return m;
    },
    freeze: () => {
      field.freeze();
      drop();
    },
    reset: () => {
      field.reset();
      drop();
    },
  };
}

/** every build from 0.3.123 on already exports this shape; only the numbers
    have to be handed over. Later ones add reseat(), which nothing here calls. */
function passthrough(f: {
  measure(rows: readonly SpringRow[]): void;
  begin(ch: number, top: number, anchorScreenY: number | null, held: boolean): void;
  anchor(screenY: number): void;
  lift(): void;
  frame(nowMs: number, scrollTop: number): void;
  displacements(): Map<number, number>;
  active(): boolean;
  armed(): boolean;
  phase(): string;
  lag(): number;
  freeze(): void;
  reset(): void;
}): SpringEngine {
  return f;
}

/** the first-order builds all take the same options; only the later ones read
    the last three */
function firstOrderOpts(c: Readonly<Record<string, number>>, shared: SharedNumbers) {
  return {
    tau: shared.tau,
    divisor: shared.divisor,
    resistanceMax: num(c, "RESISTANCE_MAX", 1),
    stretchCap: num(c, "STRETCH_CAP_PX", 300),
    gapMin: num(c, "GAP_MIN_PX", 2),
    buffer: num(c, "PARTICIPATION_BUFFER_PX", 400),
  };
}

function windowedOpts(c: Readonly<Record<string, number>>, shared: SharedNumbers) {
  return {
    ...firstOrderOpts(c, shared),
    velocityWindow: num(c, "VELOCITY_WINDOW_MS", 50),
    velocityHold: num(c, "VELOCITY_HOLD_MS", 28),
  };
}

/**
 * Build the field for an entry.
 *
 * `shared` is what the sliders say. A build only ever receives a slider it
 * actually had: 0.3.121 and 0.3.123 have no lag time constant and no strain
 * bound, so those sliders are not passed to them and the panel dims them. The
 * rest of each build's documented constants come from the entry itself.
 */
export function createHistorySpring(entry: ConfigEntry, shared: SharedNumbers): SpringEngine {
  const c = entry.constants;
  switch (entry.spring as Exclude<SpringKind, "current">) {
    case "s121":
      return adapt121(c, shared);
    case "s123":
      return passthrough(
        s123.createSpringField({
          omega: (2 * Math.PI * num(c, "FREQUENCY_HZ", 1)) / 1000,
          zeta: num(c, "DAMPING_RATIO", 0.8),
          divisor: shared.divisor,
          resistanceMax: num(c, "RESISTANCE_MAX", 1),
          stretchCap: num(c, "STRETCH_CAP_PX", 300),
          closeMax: num(c, "GAP_CLOSE_MAX", 0.5),
          buffer: num(c, "PARTICIPATION_BUFFER_PX", 200),
          stopQuietMs: num(c, "STOP_QUIET_MS", 50),
          releaseBeatMs: num(c, "RELEASE_BEAT_MS", 100),
        }),
      );
    case "s124":
      return passthrough(s124.createSpringField(firstOrderOpts(c, shared)));
    case "s132":
      return passthrough(s132.createSpringField(firstOrderOpts(c, shared)));
    case "s134":
      return passthrough(s134.createSpringField(windowedOpts(c, shared)));
    case "s140":
      return passthrough(s140.createSpringField(windowedOpts(c, shared)));
    case "s141":
      return passthrough(s141.createSpringField(windowedOpts(c, shared)));
    case "s148":
      return passthrough(
        s148.createSpringField({ ...windowedOpts(c, shared), strain: shared.strain }),
      );
  }
}

/** the end of the thread that was pushed with that spring */
export function createHistoryEnd(entry: ConfigEntry): EndModel {
  const c = entry.endConstants;
  if (c === null) return createNoEnd();
  const opts = {
    omega: num(c, "BOUNCE_OMEGA", 11.2),
    rubberC: num(c, "RUBBER_C", 0.55),
    maxFraction: num(c, "MAX_OVER_FRACTION", 0.55),
    impactMin: num(c, "IMPACT_MIN_SPEED", 0.3),
    gain: num(c, "FEED_GAIN", 1),
  };
  switch (entry.end as Exclude<EndKind, "none">) {
    case "end-initial":
      return endInitial.createEndSpring(opts);
    case "end-catch":
      return endCatch.createEndSpring(opts);
    case "end-reseat":
      return createEndReseat(opts);
  }
}
