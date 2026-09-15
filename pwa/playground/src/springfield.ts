// The scroll field, ADAPTED from reference/pwa/src/springscroll.ts
// (createSpringField). The copy of that module in src/vendor/springscroll.ts is
// byte-identical to the baseline and is where all of the PHYSICS still lives:
// relaxLag, resistanceFor, speedOver, softStrain, profileFor, windowBounds,
// atRest and TUNING are imported from there and are not restated here. What
// this file holds is the same STATE MACHINE - the gesture, the vertex park, the
// braking rule, the sample window - with exactly three changes, each marked
// `TOOL:` where it happens:
//
//   1. TUNABLES ARE READ LIVE. The baseline factory freezes its numbers at
//      construction (`const tau = opts.tau ?? TUNING.LAG_TAU_MS`). A playground
//      whose sliders move while a gesture is in the air cannot do that without
//      rebuilding the field and losing the gesture with it, so the factory
//      takes a `read()` callback and asks it per frame. With a constant
//      callback the behaviour is identical, which tests/fieldparity.test.ts
//      checks frame for frame against the untouched module.
//   2. THREE READ-ONLY ACCESSORS ARE ADDED: `vertex()`, `window()` and
//      `rowTable()`. The travelling settle needs the same vertex and the same
//      participation window the baseline profile uses, and the baseline only
//      exposes the finished displacement map. They read state; they never
//      write it.
//   3. The long narrative comments are not duplicated. Every claim about what
//      was measured and why a rule exists is in vendor/springscroll.ts, in the
//      baseline's own words; the short notes kept here are the ones needed to
//      follow the control flow.
//
// Nothing else differs: no constant is retuned, no branch is added or removed,
// and the order of operations inside frame() is the baseline's.

import {
  TUNING,
  atRest,
  profileFor,
  relaxLag,
  speedOver,
  windowBounds,
} from "./vendor/springscroll";
import type { ScrollSample, SpringPhase, SpringRow } from "./vendor/springscroll";

/** every number the field reads, supplied fresh on the frame that uses it */
export interface FieldTunables {
  tau: number;
  divisor: number;
  resistanceMax: number;
  stretchCap: number;
  gapMin: number;
  strain: number;
  buffer: number;
  velocityWindow: number;
  velocityHold: number;
  fingerTravel: number;
}

/** the baseline defaults, spelled from the untouched module's TUNING */
export function defaultFieldTunables(): FieldTunables {
  return {
    tau: TUNING.LAG_TAU_MS,
    divisor: TUNING.RESISTANCE_DIVISOR,
    resistanceMax: TUNING.RESISTANCE_MAX,
    stretchCap: TUNING.STRETCH_CAP_PX,
    gapMin: TUNING.GAP_MIN_PX,
    strain: TUNING.GAP_STRAIN_PX,
    buffer: TUNING.PARTICIPATION_BUFFER_PX,
    velocityWindow: TUNING.VELOCITY_WINDOW_MS,
    velocityHold: TUNING.VELOCITY_HOLD_MS,
    fingerTravel: TUNING.FINGER_TRAVEL_PX,
  };
}

/** the participating span this frame: inclusive row indices, or null for none */
export type Participation = { lo: number; hi: number } | null;

export interface TunedSpringField {
  measure(rows: readonly SpringRow[]): void;
  begin(clientHeight: number, threadTop: number, anchorScreenY: number | null, held: boolean): void;
  anchor(screenY: number): void;
  lift(): void;
  frame(nowMs: number, scrollTop: number): void;
  reseat(dy: number): void;
  displacements(): Map<number, number>;
  active(): boolean;
  armed(): boolean;
  phase(): SpringPhase;
  lag(): number;
  freeze(): void;
  reset(): void;
  // TOOL additions, all read-only
  /** the profile's vertex in CONTENT space for the position last framed */
  vertex(): number;
  /** the rows the window would write this frame */
  window(): Participation;
  /** the row table as last measured */
  rowTable(): readonly SpringRow[];
  /** the scroll position the last frame read (end-spring overscroll included) */
  scrollAt(): number;
  /** the viewport height the gesture was opened with */
  viewport(): number;
}

export function createTunedSpringField(read: () => FieldTunables): TunedSpringField {
  let rows: readonly SpringRow[] = [];
  let L = 0; // the reference lag, px
  let phaseNow: SpringPhase = "idle";
  let isArmed = false;
  let held = false;
  let clientH = 0;
  let threadTop = 0;
  let anchorScreenY: number | null = null;
  let scrollNow = 0;
  let lastScrollTop: number | null = null;
  let lastFrameMs: number | null = null;
  let samples: ScrollSample[] = [];
  let lastAnchorSeen: number | null = null;
  let anchorMovedAt = -Infinity;
  let pendingAnchorY: number | null = null;
  let vertexParked = false;
  let parkedFingerMoved = false;
  let parkedFrom: number | null = null;
  // the vertex is a CONTENT position: read once, on the gesture's first frame,
  // and it rides the thread from there (vendor/springscroll.ts holds the whole
  // argument for why it is not a screen position)
  let anchorContentY: number | null = null;
  let vertexNeedsSeat = false;

  function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function measure(next: readonly SpringRow[]): void {
    rows = next;
  }

  /** the vertex in content space for this scroll position */
  function vertexAt(scrollTop: number): number {
    if (anchorScreenY === null) return scrollTop + clientH / 2; // a wheel: the viewport's middle
    return anchorContentY ?? scrollTop + (anchorScreenY - threadTop);
  }

  /** put the vertex on the content under its screen-Y, once */
  function seatVertex(scrollTop: number): void {
    if (anchorScreenY === null || !vertexNeedsSeat) return;
    anchorContentY = scrollTop + (anchorScreenY - threadTop);
    vertexNeedsSeat = false;
  }

  function begin(ch: number, top: number, anchorY: number | null, fingerDown: boolean): void {
    clientH = ch;
    threadTop = top;
    // a finger landing on a thread that still carries stretch parks its anchor:
    // the old vertex stands until that finger's own drag starts, or the lag
    // reaches rest
    if (isArmed && !atRest(L)) {
      pendingAnchorY = anchorY;
      parkedFrom = anchorY;
      vertexParked = true;
      parkedFingerMoved = false;
    } else {
      anchorScreenY = anchorY;
      anchorContentY = null; // the gesture's first frame seats it on the content
      vertexNeedsSeat = anchorY !== null;
      pendingAnchorY = null;
      parkedFrom = null;
      vertexParked = false;
      parkedFingerMoved = false;
    }
    held = fingerDown;
    if (!isArmed) {
      lastScrollTop = null;
      lastFrameMs = null;
      samples = [];
    }
    isArmed = true;
    lastAnchorSeen = vertexParked ? pendingAnchorY : anchorScreenY;
    anchorMovedAt = -Infinity;
    if (phaseNow === "idle" || phaseNow === "coasting") phaseNow = "driving";
  }

  function anchor(screenY: number): void {
    const { fingerTravel } = read(); // TOOL: live read
    if (vertexParked) {
      if (parkedFrom === null || Math.abs(screenY - parkedFrom) >= fingerTravel) parkedFingerMoved = true;
      pendingAnchorY = screenY;
    } else anchorScreenY = screenY;
  }

  function lift(): void {
    held = false;
    if (phaseNow === "idle") isArmed = false;
    else if (phaseNow === "driving") phaseNow = "coasting";
  }

  function settle(): void {
    L = 0;
    phaseNow = "idle";
    if (!held) isArmed = false;
  }

  function frame(nowMs: number, scrollTop: number): void {
    const { tau, stretchCap, velocityWindow, velocityHold } = read(); // TOOL: live read
    scrollNow = scrollTop;
    if (!isArmed) return;
    const fingerSeenNow = vertexParked ? pendingAnchorY : anchorScreenY;
    if (fingerSeenNow !== lastAnchorSeen) {
      if (lastAnchorSeen !== null) anchorMovedAt = nowMs;
      lastAnchorSeen = fingerSeenNow;
    }
    seatVertex(scrollTop);
    if (lastFrameMs === null || lastScrollTop === null) {
      lastFrameMs = nowMs;
      lastScrollTop = scrollTop;
      samples = [{ t: nowMs, s: scrollTop }];
      return; // a clock and position reading only
    }
    const prevFrameMs = lastFrameMs;
    const dt = Math.max(nowMs - lastFrameMs, 0);
    lastFrameMs = nowMs;
    const delta = scrollTop - lastScrollTop;
    lastScrollTop = scrollTop;
    // a finger that moved on THIS frame is a scroll still moving, and what it
    // evidences is a delivery gap, so it buys exactly one
    const fingerTravelling = held && anchorMovedAt > prevFrameMs;
    const budget = held ? (fingerTravelling ? velocityHold : 0) : velocityHold;
    // a finger resting on a stretched thread owns the scroller: it is BRAKING,
    // and a braking frame is driven with nothing at all
    const braking = held && vertexParked && !parkedFingerMoved;
    if (delta !== 0) {
      samples.push({ t: nowMs, s: scrollTop });
      while (samples.length > 2 && nowMs - samples[0].t > velocityWindow) samples.shift();
    } else if (samples.length > 0 && nowMs - samples[samples.length - 1].t > velocityWindow) {
      // really still for the whole window: the run is spent, one reading kept
      samples = [{ t: nowMs, s: scrollTop }];
    }
    const v = braking ? 0 : speedOver(samples, nowMs, budget);
    L = clamp(relaxLag(L, v * dt, dt, tau), -stretchCap, stretchCap);
    if (v !== 0) phaseNow = held ? "driving" : "coasting";
    else if (atRest(L)) settle();
    else phaseNow = "settling";
    if (vertexParked && ((delta !== 0 && (!held || parkedFingerMoved)) || atRest(L))) {
      anchorScreenY = pendingAnchorY;
      pendingAnchorY = null;
      parkedFrom = null;
      vertexParked = false;
      parkedFingerMoved = false;
      lastAnchorSeen = anchorScreenY; // the adoption itself is not finger travel
      anchorContentY = null;
      vertexNeedsSeat = anchorScreenY !== null;
      seatVertex(scrollTop);
    }
  }

  function reseat(dy: number): void {
    if (dy === 0 || !Number.isFinite(dy)) return;
    if (lastScrollTop !== null) lastScrollTop += dy;
    samples = samples.map((s) => ({ t: s.t, s: s.s + dy }));
    if (anchorContentY !== null) anchorContentY += dy;
  }

  /** TOOL: the participating span, lifted out of displacements() so the
      travelling settle can write the same rows the baseline would */
  function participating(): Participation {
    const { buffer } = read();
    if (rows.length === 0) return null;
    const [lo, hi] = windowBounds(scrollNow, clientH, buffer);
    let first = -1;
    let last = -1;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.top + r.height < lo) continue;
      if (r.top > hi) break;
      if (first < 0) first = i;
      last = i;
    }
    return first < 0 ? null : { lo: first, hi: last };
  }

  function displacements(): Map<number, number> {
    const { divisor, resistanceMax, gapMin, strain } = read(); // TOOL: live read
    if (L === 0 || rows.length === 0) return new Map();
    const span = participating();
    if (!span) return new Map();
    return profileFor(
      rows, span.lo, span.hi, vertexAt(scrollNow), L, divisor, resistanceMax, gapMin, strain,
    );
  }

  function active(): boolean {
    return phaseNow !== "idle";
  }

  function armed(): boolean {
    return isArmed;
  }

  function phase(): SpringPhase {
    return phaseNow;
  }

  function lag(): number {
    return L;
  }

  function freeze(): void {
    L = 0;
    phaseNow = "idle";
    isArmed = false;
    held = false;
    lastScrollTop = null;
    lastFrameMs = null;
    samples = [];
    lastAnchorSeen = null;
    anchorMovedAt = -Infinity;
    pendingAnchorY = null;
    parkedFrom = null;
    vertexParked = false;
    parkedFingerMoved = false;
    anchorContentY = null;
    vertexNeedsSeat = false;
  }

  function reset(): void {
    freeze();
    rows = [];
    anchorScreenY = null;
  }

  return {
    measure,
    begin,
    anchor,
    lift,
    frame,
    reseat,
    displacements,
    active,
    armed,
    phase,
    lag,
    freeze,
    reset,
    vertex: () => vertexAt(scrollNow),
    window: participating,
    rowTable: () => rows,
    scrollAt: () => scrollNow,
    viewport: () => clientH,
  };
}
