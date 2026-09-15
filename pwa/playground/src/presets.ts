// What the playground can be set to: the live build, the experiment, and the
// older spring builds recovered from pushed Git history.
//
// WHAT A HISTORICAL ENTRY IS, AND WHAT IT IS NOT
//
// It is that commit's OWN springscroll.ts - and, where that commit had one, its
// own endspring.ts - copied byte for byte into src/history/ and driven by this
// tool's wiring. Selecting one swaps the physics: 0.3.121 really does integrate
// one critically damped spring per row, 0.3.123 really does hold a beat and
// then let go underdamped, and the first-order builds really do differ in how
// they measure speed, bound a gap, seat a vertex and hand a caught bounce back.
// It is not the current sliders filled with old numbers.
//
// It is NOT a replay of an old version of the app. Only the spring and end
// modules of each commit are here. The transcript, the layout, the send
// flights, the hold-off, the scroll-ownership rules and everything else main.ts
// owns are this tool's, unchanged between entries, and no build is
// authenticated, fetched or booted. What an entry reproduces is that build's
// SPRING BEHAVIOUR on this tool's thread.
//
// WHY THERE ARE MORE ENTRIES THAN VERSIONS, AND FEWER THAN COMMITS
//
// The history helper's map separates three things. There are six NUMERIC
// FAMILIES, which is what a slider set can describe. There are eleven PHYSICS
// STATES, because the same numbers were shipped over several different
// implementations - 0.3.135, 0.3.140 and 0.3.141 share one numeric tuple and
// are three different modules - and collapsing those would be exactly the lie
// this picker exists to avoid. And there are forty-eight pushed COMMITS, most
// of which changed nothing a reader can see; each entry below names every
// commit that carries its state.
//
// Ten of the eleven states are historical entries here. The eleventh is the one
// already on screen: the live build IS first-order-immediate-brake-v1, and
// src/vendor/springscroll.ts is 4c865ac's file to the byte, so it is listed
// once with its own aliases rather than twice under two names.
//
// PUSHED, NOT PROVEN DEPLOYED. Every commit below is a verified ancestor of the
// public build-v0 tip 4c865ac, so the code was pushed. Nothing here is evidence
// that a given intermediate version was ever deployed to a device, and the
// labels say so. The ancestry check and the per-file SHA-256 for every snapshot
// were made by a history helper whose manifest lives with the standalone tool
// this page came from; tests/historysource.test.ts carries the hashes it
// recorded and re-checks the copies in src/history against them.

import type { KnobKey } from "./tuning";

export type ConfigId =
  /** the field this tool was built to reproduce: v0.3.151, 4c865ac */
  | "live"
  /** the experiment: the live field's drive with an ordered release */
  | "travelling"
  | "h-per-row"
  | "h-beat"
  | "h-raw"
  | "h-raw-end1"
  | "h-raw-end2"
  | "h-win"
  | "h-win-end2"
  | "h-win-reseat"
  | "h-win-parked"
  | "h-bounded";

/** which copied spring module runs */
export type SpringKind = "current" | "s121" | "s123" | "s124" | "s132" | "s134" | "s140" | "s141" | "s148";

/** which end-of-thread model runs with it */
export type EndKind = "none" | "end-initial" | "end-catch" | "end-reseat";

export interface ConfigEntry {
  id: ConfigId;
  /** the name in the picker */
  label: string;
  /** the numeric family this belongs to, from the history helper's map */
  family: string;
  /** the physics state id, which is what actually distinguishes the entries */
  state: string;
  /** the version this spring code was pushed under, or "" for the experiment */
  version: string;
  /** the representative commit, or "" for the experiment */
  commit: string;
  /** the snapshot directory under reference/history, or "" */
  snapshot: string;
  /** one line: what is different about this one */
  summary: string;
  /** experimental rather than a shipped build */
  experimental: boolean;
  spring: SpringKind;
  end: EndKind;
  /** every pushed commit carrying this exact state, "version shortsha" */
  aliases: readonly string[];
  /** the shared sliders this build actually reads. Every other slider is inert
      while it is selected, and the panel dims it rather than pretending. */
  knobs: readonly KnobKey[];
  /** the numbers this build shipped with, for the sliders above: selecting the
      entry loads these, and changing one marks the entry customised */
  values: Readonly<Partial<Record<KnobKey, number>>>;
  /** the build's documented spring constants, including the ones with no
      slider. The adapter passes these to the historical factory rather than
      letting the module's own defaults stand in for them. */
  constants: Readonly<Record<string, number>>;
  /** the same for its end model, or null where it had none */
  endConstants: Readonly<Record<string, number>> | null;
}

const END_NUMBERS = {
  RUBBER_C: 0.55,
  BOUNCE_OMEGA: 11.2,
  MAX_OVER_FRACTION: 0.55,
  IMPACT_MIN_SPEED: 0.3,
  FEED_GAIN: 1,
  REST_EPS_PX: 0.25,
  DT_MAX_MS: 48,
} as const;

const RAW_NUMBERS = {
  RESISTANCE_DIVISOR: 500,
  RESISTANCE_MAX: 1,
  LAG_TAU_MS: 45,
  GAP_MIN_PX: 2,
  STRETCH_CAP_PX: 300,
  PARTICIPATION_BUFFER_PX: 400,
  REST_EPS_PX: 0.25,
} as const;

const WINDOWED_NUMBERS = {
  ...RAW_NUMBERS,
  VELOCITY_WINDOW_MS: 50,
  VELOCITY_HOLD_MS: 28,
} as const;

const BOUNDED_NUMBERS = {
  ...WINDOWED_NUMBERS,
  GAP_STRAIN_PX: 12,
} as const;

const LIVE_NUMBERS = {
  ...BOUNDED_NUMBERS,
  FINGER_TRAVEL_PX: 2,
} as const;

const TAU_REACH: readonly KnobKey[] = ["field.tau", "field.divisor"];
const TAU_REACH_STRAIN: readonly KnobKey[] = ["field.tau", "field.divisor", "field.strain"];
const REACH_ONLY: readonly KnobKey[] = ["field.divisor"];
const V45_500 = { "field.tau": 45, "field.divisor": 500 } as const;
const V45_500_12 = { "field.tau": 45, "field.divisor": 500, "field.strain": 12 } as const;

export const CONFIGS: readonly ConfigEntry[] = [
  {
    id: "live",
    label: "Live baseline",
    family: "first-order-immediate-brake",
    state: "first-order-immediate-brake-v1",
    version: "0.3.151",
    commit: "4c865acad5a5685b1e2a9dbd319bfaa5e52205f9",
    snapshot: "0.3.151-4c865ac",
    summary:
      "The build this tool was made to reproduce. One reference lag for the whole thread, so every row melts on the same curve and the profile lands together. A finger resting on a stretched thread is braking: it drives with nothing at all.",
    experimental: false,
    spring: "current",
    end: "end-reseat",
    aliases: [
      "0.3.150 6da4ac9",
      "0.3.150 08a45c8",
      "0.3.150 6ebd6b3",
      "0.3.151 e4ead16",
      "0.3.151 7f434d2",
      "0.3.151 4c865ac",
    ],
    knobs: TAU_REACH_STRAIN,
    values: V45_500_12,
    constants: LIVE_NUMBERS,
    endConstants: END_NUMBERS,
  },
  {
    id: "travelling",
    label: "Travelling settle",
    family: "first-order-immediate-brake",
    state: "first-order-immediate-brake-v1 + ordered release",
    version: "",
    commit: "",
    snapshot: "",
    summary:
      "Experimental, not a shipped build. The live build's drive exactly, then an ordered release: each pair of neighbours lets go on its own, starting at the finger and running up the thread.",
    experimental: true,
    spring: "current",
    end: "end-reseat",
    aliases: [],
    knobs: TAU_REACH_STRAIN,
    values: V45_500_12,
    constants: LIVE_NUMBERS,
    endConstants: END_NUMBERS,
  },
  {
    id: "h-per-row",
    label: "Per-row critical springs",
    family: "per-row-critical",
    state: "per-row-critical-v1",
    version: "0.3.121",
    commit: "15c40a0a17a4e3dd494da9fe9b46c24e77f4fa22",
    snapshot: "0.3.121-15c40a0",
    summary:
      "The first build: one critically damped spring per row at 1.4 Hz, fed the scroll delta scaled by distance from the finger, every row capped at 10 px. The cap is what flattened it - at any real speed the far rows all sit on it and the thread shifts as a block. Its anchor is a screen position the thread flows past, and pairs do close on this transcript, to about a pixel of a 4 px gap, which its own header says cannot happen. On a wheel it is adapted rather than replayed: its own arm step re-took the scroll reference on every tick, which moves nothing at all under a browser that has already scrolled before the handler runs, so the wiring rebases only a fresh gesture.",
    experimental: false,
    spring: "s121",
    end: "none",
    aliases: ["0.3.121 15c40a0", "0.3.122 0732366"],
    knobs: REACH_ONLY,
    values: { "field.divisor": 1400 },
    constants: {
      SPRING_FREQUENCY_HZ: 1.4,
      RESISTANCE_DIVISOR: 1400,
      RESISTANCE_MAX: 0.5,
      DISPLACEMENT_CAP_PX: 10,
      PARTICIPATION_BUFFER_PX: 120,
      DT_MAX_MS: 48,
      REST_EPS_PX: 0.05,
      REST_EPS_V: 0.02,
    },
    endConstants: null,
  },
  {
    id: "h-beat",
    label: "Shared spring with release beat",
    family: "shared-underdamped-beat",
    state: "shared-underdamped-beat-v1",
    version: "0.3.123",
    commit: "57087ceab4d3c2026cc6e0752265065074565540",
    snapshot: "0.3.123-57087ce",
    summary:
      "One underdamped spring for the whole thread at 1 Hz and 0.8 damping. The scroll must sit still for 50 ms, then the rows hold a 100 ms beat and drop back together with a small overshoot. A coast carries the stretch frozen. Gaps may close by half of their rest gap.",
    experimental: false,
    spring: "s123",
    end: "none",
    aliases: [
      "0.3.123 57087ce",
      "0.3.125 692fcfe",
      "0.3.127 2d8625f",
      "0.3.130 7f83762",
      "0.3.136 e2bf029",
    ],
    knobs: REACH_ONLY,
    values: { "field.divisor": 1500 },
    constants: {
      RESISTANCE_DIVISOR: 1500,
      RESISTANCE_MAX: 1,
      FREQUENCY_HZ: 1.0,
      DAMPING_RATIO: 0.8,
      STOP_QUIET_MS: 50,
      RELEASE_BEAT_MS: 100,
      GAP_CLOSE_MAX: 0.5,
      STRETCH_CAP_PX: 300,
      PARTICIPATION_BUFFER_PX: 200,
      DT_MAX_MS: 48,
      REST_EPS_PX: 0.25,
      REST_EPS_V: 0.01,
    },
    endConstants: null,
  },
  {
    id: "h-raw",
    label: "Measured first-order lag",
    family: "first-order-raw",
    state: "first-order-raw-v1",
    version: "0.3.124",
    commit: "af9a4550f94445261bde3bbd532bfc8620f0afea",
    snapshot: "0.3.124-af9a455",
    summary:
      "Where the measured numbers arrive: the 45 ms lag and the 500 px reach, driven from each frame's raw scroll delta and returning straight away on exp(-t/tau). No beat, no speed window - a frame the browser delivered nothing on reads as a stop - and a live screen-space finger vertex.",
    experimental: false,
    spring: "s124",
    end: "none",
    aliases: [
      "0.3.124 af9a455",
      "0.3.124 c9477d0",
      "0.3.124 81e4298",
      "0.3.128 2388a89",
      "0.3.129 ac8a1d9",
      "0.3.131 45056ec",
      "0.3.133 88f3c6c",
    ],
    knobs: TAU_REACH,
    values: V45_500,
    constants: RAW_NUMBERS,
    endConstants: null,
  },
  {
    id: "h-raw-end1",
    label: "Raw lag, first end bounce",
    family: "first-order-raw",
    state: "first-order-raw-end-initial",
    version: "0.3.132",
    commit: "a94ab0a5e7bf5c4e4a2f1c55e75b4fbd56cc2c85",
    snapshot: "0.3.132-a94ab0a",
    summary:
      "The same raw-delta lag with the first rubber-band model behind it, so pulling past either end is modelled overscroll the field reads as ordinary scrolling. Catching that bounce does not yet keep the pull's origin, so a caught band can step.",
    experimental: false,
    spring: "s132",
    end: "end-initial",
    aliases: ["0.3.132 a94ab0a"],
    knobs: TAU_REACH,
    values: V45_500,
    constants: RAW_NUMBERS,
    endConstants: END_NUMBERS,
  },
  {
    id: "h-raw-end2",
    label: "Raw lag, continuous end catch",
    family: "first-order-raw",
    state: "first-order-raw-end-catch",
    version: "0.3.132",
    commit: "299e90b5e968f97698e7bc56967d25f625f197cd",
    snapshot: "0.3.132-299e90b",
    summary:
      "The same numbers again, with the end model's catch fixed: a finger landing on a running bounce reads its origin back through the inverse rubber-band curve, so the band hands over without a jump. Same sliders as the entry above; the difference is in the end of the thread.",
    experimental: false,
    spring: "s132",
    end: "end-catch",
    aliases: ["0.3.132 299e90b"],
    knobs: TAU_REACH,
    values: V45_500,
    constants: RAW_NUMBERS,
    endConstants: END_NUMBERS,
  },
  {
    id: "h-win",
    label: "First-order lag with moving speed",
    family: "first-order-windowed",
    state: "first-order-windowed-v1",
    version: "0.3.134",
    commit: "8bb06a7c6d566c52eb51e450819e0341acc34de5",
    snapshot: "0.3.134-8bb06a7",
    summary:
      "The same lag, driven from a speed measured over a 50 ms window with a 28 ms allowance for a delivery gap, so a phone's sparse scroll events stop reading as a stop. Still no strain bound on the gaps and no end model.",
    experimental: false,
    spring: "s134",
    end: "none",
    aliases: ["0.3.134 8bb06a7", "0.3.134 baa155e"],
    knobs: TAU_REACH,
    values: V45_500,
    constants: WINDOWED_NUMBERS,
    endConstants: null,
  },
  {
    id: "h-win-end2",
    label: "Windowed lag with end catch",
    family: "first-order-windowed",
    state: "first-order-windowed-end-catch",
    version: "0.3.135",
    commit: "f65820898c9ef6e88eb485336e577438b9e4d2e6",
    snapshot: "0.3.135-f658208",
    summary:
      "The windowed lag and the corrected end bounce together. The longest-lived of these states: seven pushed commits carry it, across 0.3.135 to 0.3.139.",
    experimental: false,
    spring: "s134",
    end: "end-catch",
    aliases: [
      "0.3.135 f658208",
      "0.3.136 9a9089b",
      "0.3.138 ba24fdb",
      "0.3.138 31b33bf",
      "0.3.139 d9e4cc3",
      "0.3.139 5cadf43",
      "0.3.139 b8e515f",
    ],
    knobs: TAU_REACH,
    values: V45_500,
    constants: WINDOWED_NUMBERS,
    endConstants: END_NUMBERS,
  },
  {
    id: "h-win-reseat",
    label: "Windowed lag that survives a pin",
    family: "first-order-windowed",
    state: "first-order-windowed-reseat",
    version: "0.3.140",
    commit: "0bec0ecb064480c13e69d19e814e179aea443bc7",
    snapshot: "0.3.140-0bec0ec",
    summary:
      "Identical numbers to the two entries above, different module: the reference and every reading in the speed window are carried across a pinned insertion, so loading older messages under the finger no longer reads as a page of scrolling. This tool never pins, so the difference shows only in the source.",
    experimental: false,
    spring: "s140",
    end: "end-reseat",
    aliases: ["0.3.140 0bec0ec"],
    knobs: TAU_REACH,
    values: V45_500,
    constants: WINDOWED_NUMBERS,
    endConstants: END_NUMBERS,
  },
  {
    id: "h-win-parked",
    label: "Windowed lag with a parked vertex",
    family: "first-order-windowed",
    state: "first-order-windowed-parked-vertex",
    version: "0.3.141",
    commit: "b644dd9babc4d5dfb42465411067d93c1cc30c15",
    snapshot: "0.3.141-b644dd9",
    summary:
      "A finger landing on a thread that still carries stretch parks its anchor: the old vertex stands until that finger's own drag starts. Same numbers again, and the state that stood longest by commit count - eleven of them, 0.3.141 to 0.3.149.",
    experimental: false,
    spring: "s141",
    end: "end-reseat",
    aliases: [
      "0.3.141 b644dd9",
      "0.3.142 c751b68",
      "0.3.143 c09d3e5",
      "0.3.144 0d7448a",
      "0.3.145 bcdfddb",
      "0.3.146 7e93531",
      "0.3.147 09fbe8d",
      "0.3.147 592c8fe",
      "0.3.148 8b1e75b",
      "0.3.148 4f0eb57",
      "0.3.149 bdac681",
    ],
    knobs: TAU_REACH,
    values: V45_500,
    constants: WINDOWED_NUMBERS,
    endConstants: END_NUMBERS,
  },
  {
    id: "h-bounded",
    label: "Bounded gaps and coherent return",
    family: "first-order-bounded-coherent",
    state: "first-order-bounded-coherent-v1",
    version: "0.3.148",
    commit: "418188c4d857d93fc0904410a729ec5285a305bb",
    snapshot: "0.3.148-418188c",
    summary:
      "Adds the 12 px soft strain bound on both sides of every gap, the content-space vertex and the whole-table walk. Everything the live build has except the braking rule: a finger resting on a stretched thread is not yet treated as zero drive.",
    experimental: false,
    spring: "s148",
    end: "end-reseat",
    aliases: [
      "0.3.148 418188c",
      "0.3.149 565a071",
      "0.3.150 64d4d36",
      "0.3.150 32f1e09",
      "0.3.150 73e734b",
    ],
    knobs: TAU_REACH_STRAIN,
    values: V45_500_12,
    constants: BOUNDED_NUMBERS,
    endConstants: END_NUMBERS,
  },
];

/**
 * The seven pushed changes that are NOT in the picker, and why.
 *
 * Each of these changed main.ts and nothing a spring computes: they are about
 * motions the APP owns - a send flight finishing, a page of older messages
 * being pinned in, whose scroll a resume belongs to - and this tool has none of
 * them. There is no honest way to put them on a transcript that never pins,
 * never sends and never resumes, so they are named here instead of being
 * offered as settings that would do nothing.
 */
export const CONTROLLER_ONLY: readonly { at: string; what: string }[] = [
  { at: "0.3.124 81e4298", what: "a finished sibling-shift animation releases the hold-off" },
  { at: "0.3.139 b8e515f", what: "the field is lifted before a stationary end pull is re-armed for its bounce" },
  { at: "0.3.150 73e734b", what: "a pinned insertion reports its actual clamped scroll correction back to the field" },
  { at: "0.3.150 6ebd6b3", what: "mid-gesture hand-back through a boolean gesture era and a 100 ms scroll run" },
  { at: "0.3.151 e4ead16", what: "an expiring reader-motion clock replaces that era; ownership gates coast take-back" },
  { at: "0.3.151 7f434d2", what: "content-preserving writes carry the field reference; a resume claim needs travel evidence" },
  { at: "0.3.151 4c865ac", what: "only vertical travel claims the resume era; a no-movement bottom pin keeps its reference" },
];

export function configFor(id: ConfigId): ConfigEntry {
  return CONFIGS.find((c) => c.id === id) ?? CONFIGS[0];
}

/**
 * Does this build compute a single reference lag?
 *
 * Every build from 0.3.123 on holds one number for the whole thread and every
 * row shows its own share of it, so the readout can name it. 0.3.121 holds one
 * spring per row and never computes such a number; the readout says what the
 * largest offset on screen is instead of inventing one that build never had.
 */
export function hasReferenceLag(c: ConfigEntry): boolean {
  return c.spring !== "s121";
}

export function isConfigId(v: unknown): v is ConfigId {
  return typeof v === "string" && CONFIGS.some((c) => c.id === v);
}

/**
 * The entries that run the same modules as `id`.
 *
 * The live baseline and the travelling settle both drive the current field, and
 * the current field is 0.3.151's springscroll.ts byte for byte - the manifest
 * records the same SHA-256 for both. Saying so is the point: an entry that
 * claimed to be a distinct historical build when it is the one already on
 * screen would be the easiest thing in this file to get quietly wrong.
 */
export function sharesCodeWith(id: ConfigId): ConfigEntry[] {
  const me = configFor(id);
  return CONFIGS.filter((c) => c.id !== id && c.spring === me.spring && c.end === me.end);
}

/** the provenance line the panel and the export both use */
export function provenanceOf(c: ConfigEntry): string {
  if (c.experimental) return "Experimental. Not a shipped build and not from Git history.";
  const short = c.commit.slice(0, 7);
  if (c.id === "live") return `v${c.version} · ${short} · the current live build`;
  return `v${c.version} · ${short} · pushed to build-v0; deployment not verified`;
}
