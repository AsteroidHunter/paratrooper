// Choosing a build, and what happens when you do.
//
// historysource.test.ts proves the copies are the pushed bytes and the labels
// are the manifest's. This file is the other half: that selecting an entry
// actually swaps the physics, that each of the eleven pushed states moves rows
// and reaches rest on this tool's transcript, that the states which share a
// numeric tuple do NOT behave alike, and that a customised entry can never
// leave here wearing a version label as though it were untouched.

import { describe, expect, it } from "vitest";
import { CONFIGS, configFor, hasReferenceLag } from "../src/presets";
import type { ConfigEntry } from "../src/presets";
import { createHistoryEnd, createHistorySpring } from "../src/history/adapters";
import { createTunedSpringField, defaultFieldTunables } from "../src/springfield";
import {
  customisedKnobs,
  defaultTuning,
  exportTuning,
  importTuning,
  knobLive,
  loadConfigValues,
  readKnob,
  writeKnob,
} from "../src/tuning";
import type { Tuning } from "../src/tuning";
import type { SpringEngine } from "../src/engine";
import { openGesture } from "../src/gesture";
import { FRAME_MS, makeRows } from "./harness";

const ROWS = makeRows(160);
const CLIENT_H = 844;

function engineFor(entry: ConfigEntry, t: Tuning): SpringEngine {
  const shared = { tau: t.field.tau, divisor: t.field.divisor, strain: t.field.strain };
  if (entry.spring === "current") {
    const f = createTunedSpringField(() => ({
      ...defaultFieldTunables(),
      tau: shared.tau,
      divisor: shared.divisor,
      strain: shared.strain,
    }));
    return f;
  }
  return createHistorySpring(entry, shared);
}

/**
 * One ordinary held stop, driven through the engine the way playground.ts
 * drives it: the end model's overscroll is added to the position, the finger
 * travels with the scroll, then it stops on the glass.
 */
function stopRun(entry: ConfigEntry, t: Tuning, opts?: { speed?: number; driveMs?: number }) {
  const engine = engineFor(entry, t);
  const end = createHistoryEnd(entry);
  engine.measure(ROWS);
  const speed = opts?.speed ?? 1.2;
  const driveMs = opts?.driveMs ?? 300;
  let now = 0;
  let scroll = 4000;
  const maxScroll = ROWS[ROWS.length - 1].top + 200;
  let finger = CLIENT_H * 0.72;
  engine.begin(CLIENT_H, 0, finger, true);
  end.begin(true, finger);

  const frames: { t: number; disp: Map<number, number>; phase: string }[] = [];
  const tick = (dScroll: number): void => {
    now += FRAME_MS;
    scroll += dScroll;
    const over = end.frame(now, scroll, maxScroll, CLIENT_H);
    engine.frame(now, scroll + over);
    frames.push({ t: now, disp: engine.displacements(), phase: engine.phase() });
  };
  for (let i = 0; i < Math.round(driveMs / FRAME_MS); i++) {
    finger -= speed * FRAME_MS;
    engine.anchor(finger);
    end.finger(finger);
    tick(speed * FRAME_MS);
  }
  const stopIdx = frames.length - 1;
  for (let i = 0; i < Math.round(1600 / FRAME_MS); i++) {
    engine.anchor(finger);
    end.finger(finger);
    tick(0);
  }
  return { engine, end, frames, stopIdx };
}

function peakOver(frames: { disp: Map<number, number> }[], from = 0): number {
  let m = 0;
  for (let k = from; k < frames.length; k++) {
    for (const dy of frames[k].disp.values()) m = Math.max(m, Math.abs(dy));
  }
  return m;
}

describe("every pushed build runs, moves the thread and reaches rest", () => {
  for (const entry of CONFIGS) {
    it(`${entry.label}${entry.version ? ` (v${entry.version})` : ""}`, () => {
      const t = defaultTuning();
      loadConfigValues(t, entry.id);
      const run = stopRun(entry, t);
      // it did something a reader could see
      expect(peakOver(run.frames), "peak displacement").toBeGreaterThan(2);
      // and it finished: nothing placed at the end, and no frames wanted
      const last = run.frames[run.frames.length - 1];
      expect(last.disp.size, "rows left off their seats").toBe(0);
      expect(run.engine.active()).toBe(false);
      expect(run.end.active()).toBe(false);
      // and it never put two bubbles through each other on the way, to that
      // build's OWN guarantee - which is not the same guarantee in every one of
      // them, and pretending it was would be the easy way to make these all
      // look alike:
      //
      //   0.3.121  no gap rule at all, and its own no-overlap argument does not
      //            hold up on this transcript. The test below measures it.
      //   0.3.123  a pair may close by at most half its own rest gap.
      //   0.3.124+ a 2 px floor, and from 0.3.148 a strain bound above it.
      //
      // Only pairs the build actually PLACES are pairs it controls: each field
      // writes a band wider than the viewport, and a row sitting exactly on its
      // seat is left out of the map, so neighbours are taken where both ends
      // are present.
      const floor =
        entry.spring === "s121"
          ? () => -1.5
          : entry.spring === "s123"
            ? (rest: number) => rest * (1 - 0.5) - 0.02
            : (rest: number) => Math.min(rest, 2) - 0.02;
      for (const f of run.frames) {
        for (const i of f.disp.keys()) {
          if (!f.disp.has(i + 1)) continue;
          const a = ROWS[i];
          const b = ROWS[i + 1];
          const rest = b.top - (a.top + a.height);
          const gap =
            b.top + (f.disp.get(i + 1) as number) - (a.top + a.height + (f.disp.get(i) as number));
          expect(gap, `pair ${i}/${i + 1}`).toBeGreaterThan(floor(rest));
        }
      }
    });
  }
});

describe("the builds that share a numeric tuple do not share a behaviour", () => {
  // 0.3.135, 0.3.140 and 0.3.141 all ship 45 ms / 500 px / no strain bound, and
  // the grouping contract says not to collapse them. This is that claim as a
  // measurement rather than a promise: the parked-vertex build must differ from
  // the two before it on the gesture it was written for - a finger landing on a
  // thread that still carries stretch.
  function landOnStretch(entry: ConfigEntry): Map<number, number> {
    const t = defaultTuning();
    loadConfigValues(t, entry.id);
    const engine = engineFor(entry, t);
    engine.measure(ROWS);
    let now = 0;
    let scroll = 4000;
    let finger = 600;
    engine.begin(CLIENT_H, 0, finger, true);
    for (let i = 0; i < 18; i++) {
      finger -= 1.5 * FRAME_MS;
      engine.anchor(finger);
      now += FRAME_MS;
      scroll += 1.5 * FRAME_MS;
      engine.frame(now, scroll);
    }
    engine.lift();
    // a new finger lands 300 px away while the thread is still stretched
    for (let i = 0; i < 2; i++) {
      now += FRAME_MS;
      engine.frame(now, scroll);
    }
    engine.begin(CLIENT_H, 0, 300, true);
    for (let i = 0; i < 6; i++) {
      engine.anchor(300);
      now += FRAME_MS;
      engine.frame(now, scroll);
    }
    return engine.displacements();
  }

  it("the parked vertex changes what a landing finger does to the profile", () => {
    const before = landOnStretch(configFor("h-win-end2"));
    const after = landOnStretch(configFor("h-win-parked"));
    let biggest = 0;
    for (const i of new Set([...before.keys(), ...after.keys()])) {
      biggest = Math.max(biggest, Math.abs((before.get(i) ?? 0) - (after.get(i) ?? 0)));
    }
    expect(biggest).toBeGreaterThan(1);
  });

  it("the per-row build caps every row, which the shared builds do not", () => {
    // 0.3.121's own diagnosis of itself: DISPLACEMENT_CAP_PX 10 flattens the
    // field, and no row may pass it however hard the drag
    const t = defaultTuning();
    loadConfigValues(t, "h-per-row");
    const run = stopRun(configFor("h-per-row"), t, { speed: 3, driveMs: 500 });
    expect(peakOver(run.frames)).toBeLessThanOrEqual(10.001);
    expect(hasReferenceLag(configFor("h-per-row"))).toBe(false);
    expect(hasReferenceLag(configFor("live"))).toBe(true);
  });

  it("0.3.121 closes gaps its own header says can only open", () => {
    // Its header says: "the farther row of any pair always displaces at least
    // as much and in the same direction, so a gap only ever opens." That holds
    // for ONE injection against a fixed anchor. It does not hold across a drag,
    // because the anchor is a SCREEN position and the thread flows past it: a
    // row crossing the anchor has its resistance fall to nothing while the
    // neighbour it is passing keeps a displacement of its own, and each of them
    // is relaxing on its own spring from its own history.
    // vendor/springscroll.ts records the same finding from the other end
    // ("bubbles saw against each other") as the reason the later builds moved
    // the vertex into content space.
    //
    // WHAT THE TOOL IS ENTITLED TO SAY. The closing is not an artefact of how
    // this adapter drives it: a 4 px gap is squeezed to about a pixel whether
    // the position changes every frame or on alternate frames, which is the
    // spread between an animation frame and a phone's scroll delivery. Whether
    // it tips over into an actual overlap IS cadence-sensitive - it does at
    // frame rate and does not at half of it on this gesture - so the tool says
    // the gaps close and does not claim a fixed amount of overlap.
    const worst = (everyOtherFrame: boolean): number => {
      const entry = configFor("h-per-row");
      const t = defaultTuning();
      loadConfigValues(t, entry.id);
      const engine = createHistorySpring(entry, {
        tau: t.field.tau,
        divisor: t.field.divisor,
        strain: t.field.strain,
      });
      engine.measure(ROWS);
      let now = 0;
      let scroll = 4000;
      let finger = CLIENT_H * 0.72;
      engine.begin(CLIENT_H, 0, finger, true);
      let gap = Infinity;
      for (let i = 0; i < 90; i++) {
        now += FRAME_MS;
        const move = !everyOtherFrame || i % 2 === 0;
        const step = everyOtherFrame ? 1.2 * FRAME_MS * 2 : 1.2 * FRAME_MS;
        if (move && i < 40) {
          scroll += step;
          finger -= step;
          engine.anchor(finger);
        }
        engine.frame(now, scroll);
        const disp = engine.displacements();
        for (const k of disp.keys()) {
          if (!disp.has(k + 1)) continue;
          const a = ROWS[k];
          const b = ROWS[k + 1];
          const now2 =
            b.top + (disp.get(k + 1) as number) - (a.top + a.height + (disp.get(k) as number));
          if (now2 < gap) gap = now2;
        }
      }
      return gap;
    };
    // the pairs here rest 4 px apart: both cadences squeeze one to about a px
    expect(worst(false)).toBeLessThan(1.5);
    expect(worst(true)).toBeLessThan(1.5);
    // at frame-rate delivery it goes past touching
    expect(worst(false)).toBeLessThan(0);
    // sparser delivery is gentler, which is why no single overlap figure is
    // quoted anywhere in the tool
    expect(worst(true)).toBeGreaterThan(worst(false));
    // and it is a defect of that build, not a collapse
    expect(worst(false)).toBeGreaterThan(-4);
  });

  it("a wheel moves every build, including the one that re-arms on every tick", () => {
    // REGRESSION, found by an independent browser run and not here: selecting
    // 0.3.121 and delivering twelve real wheel events of 40 px moved scrollTop
    // 480 px and left every rendered row at exactly zero, while the other
    // states peaked at 39-99 px.
    //
    // The cause was the wiring, not the build. A wheel has no finger, so the
    // page opens a gesture on EVERY tick, and 0.3.121's arm step takes the
    // delta reference; the adapter was deferring that reference to the next
    // animation frame, by which time the browser had already applied the tick.
    // Every gesture therefore measured from a position it had already reached.
    // The build's own armSpring took the reference inside the handler, so the
    // wiring hands it over there now (SpringEngine.rebase).
    //
    // This drives the whole seam playground.ts drives, including gesture.ts's
    // openGesture and the two positions the pump keeps - the current field
    // needs those, because a no-finger gesture re-armed on every tick would
    // otherwise throw its sample run away and never measure a speed at all.
    for (const entry of CONFIGS) {
      const t = defaultTuning();
      loadConfigValues(t, entry.id);
      const engine = engineFor(entry, t);
      engine.measure(ROWS);
      let now = 0;
      let scroll = 4000;
      let peak = 0;
      // Run it under BOTH deliveries, because which one a browser gives is not
      // something this tool gets to know. "after" is the one that broke it: a
      // passive wheel is scrolled on the compositor, so the main thread's
      // scrollTop can already be past the tick when the handler runs, and the
      // frame after it then reads the same number. A reference re-taken on
      // every tick is re-taken at exactly the position the next frame will
      // report, and the delta between them is nothing at all.
      for (const sees of ["before", "after"] as const) {
        const e = engineFor(entry, t);
        e.measure(ROWS);
        let n = 0;
        let s = 4000;
        let top = 0;
        const recent: { t: number; s: number }[] = [];
        for (let f = 0; f < 24; f++) {
          // a tick on EVERY frame: the worst case, and the one that leaves no
          // frame-to-frame delta for a per-tick reference to survive on
          if (sees === "after") s += 20;
          const fresh = !e.armed();
          openGesture(e, {
            clientH: CLIENT_H,
            threadTop: 0,
            anchorScreenY: null,
            fingerDown: false,
            nowMs: n,
            scrollTop: s,
            recent,
          });
          if (fresh) e.rebase?.(s);
          if (sees === "before") s += 20;
          n += FRAME_MS;
          e.frame(n, s);
          recent.push({ t: n, s });
          if (recent.length > 2) recent.shift();
          for (const dy of e.displacements().values()) top = Math.max(top, Math.abs(dy));
        }
        expect(top, `${entry.id} moved nothing on 480 px of wheel (${sees})`).toBeGreaterThan(1);
        peak = Math.max(peak, top);
        // and it comes home afterwards
        for (let f = 0; f < 240; f++) {
          n += FRAME_MS;
          e.frame(n, s);
        }
        expect(e.displacements().size, `${entry.id} never settled (${sees})`).toBe(0);
      }
      expect(peak).toBeGreaterThan(1);
      void now;
      void scroll;
    }
  });

  it("an arm that moves nothing still lets go of the gesture", () => {
    // 0.3.121 is the only build whose gesture ends on a clock rather than on
    // its own physics, and its clock was a setTimeout that fired whether or not
    // the pump was running. Here the pump stops the moment nothing wants a
    // frame, so an arm that injected nothing - a wheel tick the browser did not
    // act on, a finger that landed and never moved - could leave the gesture
    // armed with no frame left to expire it, and gesture.ts will not re-open a
    // field it believes is already armed.
    const entry = configFor("h-per-row");
    const t = defaultTuning();
    loadConfigValues(t, entry.id);
    const engine = createHistorySpring(entry, {
      tau: t.field.tau,
      divisor: t.field.divisor,
      strain: t.field.strain,
    });
    engine.measure(ROWS);
    const scroll = 4000;
    engine.begin(CLIENT_H, 0, null, false);
    engine.rebase?.(scroll);
    expect(engine.armed()).toBe(true);
    // nothing moved, so nothing is placed - and the pump must still be asked,
    // or the clock never runs
    let now = 0;
    engine.frame((now += FRAME_MS), scroll);
    expect(engine.displacements().size).toBe(0);
    expect(engine.active(), "an armed gesture with no frames left to expire it").toBe(true);
    // it lets go on its own 180 ms, and only then does it stop asking
    while (now < 170) engine.frame((now += FRAME_MS), scroll);
    expect(engine.armed()).toBe(true);
    while (now < 220) engine.frame((now += FRAME_MS), scroll);
    expect(engine.armed()).toBe(false);
    expect(engine.active()).toBe(false);
  });

  it("a build with no end model models no overscroll at all", () => {
    for (const entry of CONFIGS) {
      const end = createHistoryEnd(entry);
      end.begin(true, 400);
      end.finger(900); // a hard pull past the top
      const over = end.frame(16, 0, 100000, CLIENT_H);
      if (entry.end === "none") {
        expect(over, entry.id).toBe(0);
        expect(end.active(), entry.id).toBe(false);
      }
    }
  });
});

describe("choosing a build loads its numbers, and changing them says so", () => {
  it("each entry's own documented numbers land in the sliders it reads", () => {
    const t = defaultTuning();
    for (const entry of CONFIGS) {
      loadConfigValues(t, entry.id);
      expect(t.config).toBe(entry.id);
      for (const k of entry.knobs) expect(readKnob(t, k), `${entry.id} ${k}`).toBe(entry.values[k]);
      expect(customisedKnobs(t), entry.id).toEqual([]);
    }
  });

  it("the sliders a build never had are not live", () => {
    const t = defaultTuning();
    loadConfigValues(t, "h-per-row");
    expect(knobLive(t, "field.divisor")).toBe(true);
    expect(knobLive(t, "field.tau")).toBe(false);
    expect(knobLive(t, "field.strain")).toBe(false);
    expect(knobLive(t, "travel.returnMs")).toBe(false);
    loadConfigValues(t, "h-bounded");
    expect(knobLive(t, "field.strain")).toBe(true);
    loadConfigValues(t, "travelling");
    expect(knobLive(t, "travel.returnMs")).toBe(true);
  });

  it("moving one marks the entry customised, and names which one", () => {
    const t = defaultTuning();
    loadConfigValues(t, "h-beat");
    expect(customisedKnobs(t)).toEqual([]);
    writeKnob(t, "field.divisor", 900);
    expect(customisedKnobs(t)).toEqual(["field.divisor"]);
    // a slider the build does not read cannot make it customised: it is not
    // that build's number either way
    loadConfigValues(t, "h-beat");
    writeKnob(t, "field.strain", 30);
    expect(customisedKnobs(t)).toEqual([]);
  });

  it("switching back to a build restores its numbers", () => {
    const t = defaultTuning();
    loadConfigValues(t, "h-per-row");
    writeKnob(t, "field.divisor", 300);
    loadConfigValues(t, "h-raw");
    expect(readKnob(t, "field.divisor")).toBe(500);
    loadConfigValues(t, "h-per-row");
    expect(readKnob(t, "field.divisor")).toBe(1400);
    expect(customisedKnobs(t)).toEqual([]);
  });
});

describe("the export cannot mislabel a changed setting as a pushed build", () => {
  const read = (t: Tuning): Record<string, unknown> =>
    JSON.parse(exportTuning(t)) as Record<string, unknown>;

  it("an untouched historical entry carries its provenance and says untouched", () => {
    const t = defaultTuning();
    loadConfigValues(t, "h-win-parked");
    const o = read(t);
    expect(o.config).toBe("h-win-parked");
    expect(o.customised).toBe(false);
    expect(o.changedFromBuild).toBeUndefined();
    const src = o.source as Record<string, unknown>;
    expect(src.version).toBe("0.3.141");
    expect(src.commit).toBe("b644dd9babc4d5dfb42465411067d93c1cc30c15");
    expect(src.physicsState).toBe("first-order-windowed-parked-vertex");
    expect(src.pushed).toBe(true);
    expect(src.deploymentVerified).toBe(false);
    expect((src.alsoPushedAs as string[]).length).toBe(11);
  });

  it("one moved slider flips it, and both numbers are in the file", () => {
    const t = defaultTuning();
    loadConfigValues(t, "h-win-parked");
    writeKnob(t, "field.tau", 70);
    const o = read(t);
    expect(o.customised).toBe(true);
    const changed = o.changedFromBuild as Record<string, { now: number; build: number }>;
    expect(changed["field.tau"]).toEqual({ now: 70, build: 45 });
    // the provenance is still there - the file says what it was DERIVED from -
    // but it can no longer be read as that build untouched
    expect((o.source as Record<string, unknown>).version).toBe("0.3.141");
  });

  it("the experimental entry claims no source block at all", () => {
    const t = defaultTuning();
    loadConfigValues(t, "travelling");
    const o = read(t);
    expect(o.experimental).toBe(true);
    expect(o.source).toBeUndefined();
    expect(o.travel).toBeDefined();
  });

  it("a historical entry exports no travel block: the settle is not running", () => {
    const t = defaultTuning();
    loadConfigValues(t, "h-raw");
    expect(read(t).travel).toBeUndefined();
  });

  it("round trips, including the selected build and a customised value", () => {
    const t = defaultTuning();
    loadConfigValues(t, "h-raw-end2");
    writeKnob(t, "field.divisor", 640);
    const back = importTuning(exportTuning(t));
    expect(back).not.toBeNull();
    expect((back as Tuning).config).toBe("h-raw-end2");
    expect(readKnob(back as Tuning, "field.divisor")).toBe(640);
    expect(customisedKnobs(back as Tuning)).toEqual(["field.divisor"]);
  });

  it("a stored v1 tuning still loads, and its two modes still mean something", () => {
    const one = importTuning('{"tool":"bubble-animation-tool","mode":"baseline","shared":{"tauMs":50}}');
    expect((one as Tuning).config).toBe("live");
    expect(readKnob(one as Tuning, "field.tau")).toBe(50);
    const two = importTuning('{"tool":"bubble-animation-tool","mode":"travel"}');
    expect((two as Tuning).config).toBe("travelling");
  });

  it("an unknown or missing build falls back to the experiment, not to a version", () => {
    const bad = importTuning('{"config":"v9.9.9-deadbee"}');
    expect((bad as Tuning).config).toBe("travelling");
    expect(importTuning("not json")).toBeNull();
  });
});
