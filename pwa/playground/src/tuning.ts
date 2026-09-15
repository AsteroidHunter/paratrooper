// The tuning set: what the controls write, what the physics reads, and what the
// copy button hands over. One place, so a knob cannot exist in the panel and
// nowhere else.
//
// Only the numbers that change how the effect FEELS are here. The field's other
// constants (the participation buffer, the velocity window and hold, the finger
// travel threshold, the stretch ceiling, the 2 px floor) are delivery and
// safety numbers rather than feel numbers: they stay at the selected build's
// own values, come from that build's source, and are not exposed. A wall of
// sliders would make the two that matter harder to find.
//
// WHICH SLIDERS A BUILD ACTUALLY HAS. Not every build here has all three. The
// per-row and beat builds have no lag time constant, and nothing before 0.3.148
// has a strain bound. presets.ts records which sliders each one reads;
// knobLive() answers the question and the panel dims the rest rather than
// letting a reader turn a control that does nothing.

import { defaultFieldTunables } from "./springfield";
import type { FieldTunables } from "./springfield";
import { defaultTravelTuning } from "./travelsettle";
import type { TravelTuning, WaveOrigin } from "./travelsettle";
import { CONFIGS, configFor, isConfigId } from "./presets";
import type { ConfigId } from "./presets";

export interface Tuning {
  /** which build, or the experiment, is on screen */
  config: ConfigId;
  field: FieldTunables;
  travel: TravelTuning;
}

export function defaultTuning(): Tuning {
  const t: Tuning = {
    config: "travelling",
    field: defaultFieldTunables(),
    travel: defaultTravelTuning(),
  };
  loadConfigValues(t, t.config);
  return t;
}

/** one slider */
export interface Knob {
  key: KnobKey;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  /** shared knobs drive whichever build is selected; travel knobs only the
      experimental settle */
  group: "shared" | "travel";
}

export type KnobKey =
  | "field.tau"
  | "field.divisor"
  | "field.strain"
  | "travel.upDelayPerPx"
  | "travel.downDelayRatio"
  | "travel.maxDelayMs"
  | "travel.returnMs"
  | "travel.bounce";

export const KNOBS: readonly Knob[] = [
  {
    key: "field.tau",
    label: "Trail and return time",
    hint: "Higher makes bubbles fall farther behind while scrolling and take longer to catch up. Lower keeps them closer to their resting positions and brings them back sooner. Available in builds that use a measured time delay; unavailable in the per-row and release-beat builds.",
    min: 10,
    max: 140,
    step: 1,
    unit: "ms",
    group: "shared",
  },
  {
    key: "field.divisor",
    label: "Trail distance spread",
    hint: "Higher confines strong trailing to bubbles farther from the finger, so nearby bubbles move less. Lower spreads strong trailing closer to the finger, so more of the visible thread moves by a similar amount. Available in every build. The earliest builds use 1400 or 1500 px.",
    min: 120,
    // the two oldest builds shipped 1400 and 1500, so the range has to hold them
    max: 1600,
    step: 10,
    unit: "px",
    group: "shared",
  },
  {
    key: "field.strain",
    label: "Gap change limit",
    hint: "Higher lets neighbouring bubbles open or close their gap by more, making the stretch between rows stronger. Lower keeps gaps more even and limits the visible stretch. Available only in Bounded gaps and coherent return, the live build, and Travelling.",
    min: 2,
    max: 40,
    step: 1,
    unit: "px",
    group: "shared",
  },
  {
    key: "travel.upDelayPerPx",
    label: "Upward wave delay",
    hint: "Higher makes bubbles farther above the starting point wait longer, so the return travels upward more slowly. Lower makes them return closer together; 0 releases the whole thread at once. Used only by Travelling.",
    min: 0,
    max: 1,
    step: 0.01,
    unit: "ms/px",
    group: "travel",
  },
  {
    key: "travel.downDelayRatio",
    label: "Delay below the start",
    hint: "Higher adds more of the upward delay below the starting point, making the return spread in both directions; 1 gives both directions the same delay. Lower releases the bubbles below sooner; 0 releases them together. Used only by Travelling.",
    min: 0,
    max: 1,
    step: 0.05,
    unit: "x",
    group: "travel",
  },
  {
    key: "travel.maxDelayMs",
    label: "Maximum wave delay",
    hint: "Higher lets distant bubbles wait longer before returning, lengthening the wave when it reaches this limit. Lower ends the waiting sooner and shortens the overall settle; 0 removes the stagger. Used only by Travelling.",
    min: 0,
    max: 400,
    step: 10,
    unit: "ms",
    group: "travel",
  },
  {
    key: "travel.returnMs",
    label: "Return time",
    hint: "Higher prolongs the settle and can carry a released bubble farther past its resting position. Because the bubble keeps its initial return speed, it may first cross that position sooner. Lower shortens the settle and reduces that tendency. Used only by Travelling.",
    min: 40,
    max: 500,
    step: 5,
    unit: "ms",
    group: "travel",
  },
  {
    key: "travel.bounce",
    label: "Return shape",
    hint: "Below 1, lowering the value adds more repeated bouncing. Above 1, raising it gives the final return a slower tail. A bubble can still pass its resting position at 1 or above because it keeps the speed it had when released. Used only by Travelling.",
    min: 0.4,
    max: 1.5,
    step: 0.05,
    unit: "",
    group: "travel",
  },
];

export function readKnob(t: Tuning, key: KnobKey): number {
  switch (key) {
    case "field.tau":
      return t.field.tau;
    case "field.divisor":
      return t.field.divisor;
    case "field.strain":
      return t.field.strain;
    case "travel.upDelayPerPx":
      return t.travel.upDelayPerPx;
    case "travel.downDelayRatio":
      return t.travel.downDelayRatio;
    case "travel.maxDelayMs":
      return t.travel.maxDelayMs;
    case "travel.returnMs":
      return t.travel.returnMs;
    case "travel.bounce":
      return t.travel.bounce;
  }
}

export function writeKnob(t: Tuning, key: KnobKey, v: number): void {
  switch (key) {
    case "field.tau":
      t.field.tau = v;
      break;
    case "field.divisor":
      t.field.divisor = v;
      break;
    case "field.strain":
      t.field.strain = v;
      break;
    case "travel.upDelayPerPx":
      t.travel.upDelayPerPx = v;
      break;
    case "travel.downDelayRatio":
      t.travel.downDelayRatio = v;
      break;
    case "travel.maxDelayMs":
      t.travel.maxDelayMs = v;
      break;
    case "travel.returnMs":
      t.travel.returnMs = v;
      break;
    case "travel.bounce":
      t.travel.bounce = v;
      break;
  }
}

/** does the selected build read this slider at all */
export function knobLive(t: Tuning, key: KnobKey): boolean {
  const c = configFor(t.config);
  if (key.startsWith("travel.")) return t.config === "travelling";
  return c.knobs.includes(key);
}

/** put a build's own documented numbers into the sliders it reads */
export function loadConfigValues(t: Tuning, id: ConfigId): void {
  const c = configFor(id);
  t.config = id;
  for (const key of c.knobs) {
    const v = c.values[key];
    if (typeof v === "number") writeKnob(t, key, v);
  }
}

/**
 * The sliders that no longer say what the selected build shipped.
 *
 * This is the whole reason the entry carries its documented numbers: a reader
 * who drags Reach while "Per-row critical springs" is selected is no longer
 * looking at 0.3.121, and the panel, the readout and the exported JSON all have
 * to say so rather than keeping the version label on something else.
 */
export function customisedKnobs(t: Tuning): KnobKey[] {
  const c = configFor(t.config);
  const out: KnobKey[] = [];
  for (const key of c.knobs) {
    const want = c.values[key];
    if (typeof want === "number" && readKnob(t, key) !== want) out.push(key);
  }
  return out;
}

/** every knob back inside its own range, and the enums back to something legal:
    a pasted or stored tuning is not trusted */
export function sanitise(t: Tuning): Tuning {
  const out = defaultTuning();
  out.config = isConfigId(t.config) ? t.config : "travelling";
  for (const k of KNOBS) {
    const v = readKnob(t, k.key);
    if (typeof v === "number" && Number.isFinite(v)) {
      writeKnob(out, k.key, Math.min(Math.max(v, k.min), k.max));
    }
  }
  const origin: WaveOrigin = t.travel?.origin === "bottom" ? "bottom" : "finger";
  out.travel.origin = origin;
  return out;
}

/**
 * What the copy button puts on the clipboard.
 *
 * The identity block is not decoration. A historical entry whose sliders have
 * been moved is NOT that build any more, and a JSON file that carried the
 * version and commit without saying so would be the one artefact from this tool
 * most likely to be believed later. So `customised` is always present, and the
 * knobs that differ are listed with the numbers the build actually shipped.
 */
export function exportTuning(t: Tuning): string {
  const c = configFor(t.config);
  const changed = customisedKnobs(t);
  const body: Record<string, unknown> = {
    tool: "bubble-animation-tool",
    config: t.config,
    label: c.label,
    experimental: c.experimental,
    customised: changed.length > 0,
    shared: { tauMs: t.field.tau, divisorPx: t.field.divisor, strainPx: t.field.strain },
    sharedUsedByThisBuild: c.knobs,
  };
  if (!c.experimental) {
    body.source = {
      version: c.version,
      commit: c.commit,
      snapshot: c.snapshot,
      family: c.family,
      physicsState: c.state,
      pushed: true,
      deploymentVerified: false,
      alsoPushedAs: c.aliases,
    };
  }
  if (changed.length > 0) {
    body.changedFromBuild = Object.fromEntries(
      changed.map((k) => [k, { now: readKnob(t, k), build: c.values[k] }]),
    );
  }
  if (t.config === "travelling") {
    body.travel = {
      upDelayPerPx: t.travel.upDelayPerPx,
      downDelayRatio: t.travel.downDelayRatio,
      maxDelayMs: t.travel.maxDelayMs,
      origin: t.travel.origin,
      returnMs: t.travel.returnMs,
      bounce: t.travel.bounce,
    };
  }
  return JSON.stringify(body, null, 2);
}

/** the inverse, for the stored tuning and for anything pasted back in */
export function importTuning(text: string): Tuning | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const shared = (o.shared ?? {}) as Record<string, unknown>;
  const travel = (o.travel ?? {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  const base = defaultTuning();
  // v1 of this file only had `mode`, which named the two current options
  const config: ConfigId = isConfigId(o.config)
    ? o.config
    : o.mode === "baseline"
      ? "live"
      : o.mode === "travel"
        ? "travelling"
        : base.config;
  return sanitise({
    config,
    field: {
      ...base.field,
      tau: num(shared.tauMs, base.field.tau),
      divisor: num(shared.divisorPx, base.field.divisor),
      strain: num(shared.strainPx, base.field.strain),
    },
    travel: {
      upDelayPerPx: num(travel.upDelayPerPx, base.travel.upDelayPerPx),
      downDelayRatio: num(travel.downDelayRatio, base.travel.downDelayRatio),
      maxDelayMs: num(travel.maxDelayMs, base.travel.maxDelayMs),
      origin: travel.origin === "bottom" ? "bottom" : "finger",
      returnMs: num(travel.returnMs, base.travel.returnMs),
      bounce: num(travel.bounce, base.travel.bounce),
    },
  });
}

/** the picker's contents, in the order it shows them */
export function configChoices(): readonly { id: ConfigId; label: string; group: string }[] {
  return CONFIGS.map((c) => ({
    id: c.id,
    label: c.label,
    group: c.experimental
      ? "Experimental"
      : c.id === "live"
        ? "Current build"
        : "Pushed history (deployment not verified)",
  }));
}
