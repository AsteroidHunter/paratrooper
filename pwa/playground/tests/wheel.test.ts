// The wheel path (src/gesture.ts).
//
// REGRESSION SUITE. Independent browser review measured genuine wheel input
// moving scrollTop 480 px and producing exactly 0 px of row displacement, in
// both modes and both directions, across four runs. The field was armed
// throughout and its reference lag never left 0.00.
//
// The delivery pattern is what does it, so that is what these tests reproduce:
// a wheel tick on EVERY frame, and a browser that applies the scroll on every
// OTHER frame, which is what a desktop does. Against that,
//
//   a gesture's first frame is a baseline only
//   + a no-finger gesture disarms on a quiet frame while the lag is at rest
//   + a wheel re-arms on every tick, and re-arming throws the sample run away
//
// locks into a cycle where the field never holds two moved readings at once,
// never measures a speed, and never leaves zero. Each of those three rules is
// correct on its own and none of them is changed here; what changed is what the
// wiring hands a no-finger gesture when it opens one.
//
// The first test below is the defect itself, driven through the old sequencing,
// and it asserts the BROKEN behaviour. It is here so that the fix cannot be
// quietly undone: if the old sequencing ever stops being broken, this fails and
// the rest of the suite is telling a different story than it thinks.

import { describe, expect, it } from "vitest";
import { createTunedSpringField, defaultFieldTunables } from "../src/springfield";
import { GESTURE_INTENT_MS, REPLAY_WINDOW_MS, openGesture, takesScrollBack } from "../src/gesture";
import type { ScrollReading } from "../src/gesture";
import { createTravellingSettle, defaultTravelTuning } from "../src/travelsettle";
import { FRAME_MS, makeRows } from "./harness";

const ROWS = makeRows(140);
const CLIENT_H = 844;

interface WheelRun {
  /** the largest |displacement| any row reached at any frame */
  peak: number;
  /** the largest |reference lag| the field reached */
  peakLag: number;
  /** frames on which at least one row was placed */
  movingFrames: number;
  /** did the field ever drop the gesture mid-scroll */
  disarms: number;
}

/**
 * A wheel scroll, driven the way a desktop delivers one.
 *
 * `ticks` wheel events one frame apart; the position advances by `step` px on
 * every `deliverEvery`-th frame, which is how the main thread actually sees it.
 * `open` is the wiring: either the corrected rule or the old sequencing.
 */
function wheelScroll(opts: {
  ticks: number;
  step: number;
  deliverEvery: number;
  open: "fixed" | "deferred";
  mode?: "baseline" | "travel";
  tailFrames?: number;
}): WheelRun {
  const fieldT = defaultFieldTunables();
  const tune = defaultTravelTuning();
  const field = createTunedSpringField(() => fieldT);
  const settle = createTravellingSettle();
  field.measure(ROWS);

  let t = 0;
  let s = 3000;
  const recent: ScrollReading[] = [];
  const out: WheelRun = { peak: 0, peakLag: 0, movingFrames: 0, disarms: 0 };
  let wasArmed = false;

  const frame = (): void => {
    field.frame(t, s);
    recent.push({ t, s });
    if (recent.length > 2) recent.shift();
    const win = field.window();
    const disp =
      opts.mode === "baseline"
        ? field.displacements()
        : settle.frame({
            nowMs: t,
            dt: FRAME_MS,
            fieldLag: field.lag(),
            phase: field.phase(),
            vertexY: field.vertex(),
            scrollTop: s,
            clientH: CLIENT_H,
            rows: ROWS,
            lo: win ? win.lo : 0,
            hi: win ? win.hi : -1,
            tune,
            field: fieldT,
          });
    if (disp.size > 0) out.movingFrames += 1;
    for (const dy of disp.values()) out.peak = Math.max(out.peak, Math.abs(dy));
    out.peakLag = Math.max(out.peakLag, Math.abs(field.lag()));
    if (wasArmed && !field.armed()) out.disarms += 1;
    wasArmed = field.armed();
  };

  for (let k = 0; k < opts.ticks; k++) {
    // the wheel tick, which fires BEFORE the browser applies the scroll
    if (opts.open === "fixed") {
      openGesture(field, {
        clientH: CLIENT_H,
        threadTop: 0,
        anchorScreenY: null,
        fingerDown: false,
        nowMs: t,
        scrollTop: s,
        recent,
      });
    } else {
      // the old sequencing: open it and let the next animation frame be the
      // baseline, which is what the field does on its own
      field.begin(CLIENT_H, 0, null, false);
    }
    // the browser applies the scroll on some frames and not others
    if (k % opts.deliverEvery === 0) s -= opts.step;
    t += FRAME_MS;
    frame();
  }
  for (let k = 0; k < (opts.tailFrames ?? 120); k++) {
    t += FRAME_MS;
    frame();
  }
  return out;
}

describe("the defect, as measured in the browser", () => {
  it("the old sequencing produces no displacement at all on a real wheel", () => {
    const run = wheelScroll({ ticks: 12, step: 40, deliverEvery: 2, open: "deferred" });
    // 480 px of scroll, and the rows never move: the reviewer's measurement
    expect(run.peak).toBe(0);
    expect(run.peakLag).toBe(0);
    expect(run.movingFrames).toBe(0);
    // ... because the gesture is dropped over and over mid-scroll
    expect(run.disarms).toBeGreaterThan(3);
  });
});

describe("the wheel now exercises the field", () => {
  for (const mode of ["baseline", "travel"] as const) {
    for (const dir of [1, -1] as const) {
      it(`${mode}, ${dir === 1 ? "upward" : "downward"}: the rows actually move`, () => {
        const run = wheelScroll({
          ticks: 12,
          step: 40 * dir,
          deliverEvery: 2,
          open: "fixed",
          mode,
        });
        // the reviewer's case: 12 ticks, 480 px of travel
        expect(run.peakLag).toBeGreaterThan(20);
        expect(run.peak).toBeGreaterThan(8);
        expect(run.movingFrames).toBeGreaterThan(10);
        expect(run.disarms).toBeLessThanOrEqual(1); // once, at the very end
      });
    }
  }

  it("holds the gesture through the quiet frames instead of dropping it", () => {
    const run = wheelScroll({ ticks: 12, step: 40, deliverEvery: 2, open: "fixed", tailFrames: 0 });
    expect(run.disarms).toBe(0);
  });

  it("works when the browser delivers on every frame", () => {
    const run = wheelScroll({ ticks: 12, step: 20, deliverEvery: 1, open: "fixed" });
    expect(run.peak).toBeGreaterThan(8);
  });

  it("works when the browser delivers only every third frame", () => {
    const run = wheelScroll({ ticks: 18, step: 60, deliverEvery: 3, open: "fixed" });
    expect(run.peak).toBeGreaterThan(8);
  });

  it("and still comes to rest afterwards", () => {
    const run = wheelScroll({ ticks: 12, step: 40, deliverEvery: 2, open: "fixed", tailFrames: 300 });
    expect(run.peak).toBeGreaterThan(8);
    // the last frames place nothing: the settle finished
    const tail = wheelScroll({
      ticks: 12,
      step: 40,
      deliverEvery: 2,
      open: "fixed",
      tailFrames: 300,
    });
    expect(tail.movingFrames).toBeLessThan(300);
  });
});

describe("opening a gesture", () => {
  const base = {
    clientH: CLIENT_H,
    threadTop: 0,
    anchorScreenY: null,
    fingerDown: false,
    nowMs: 1000,
    scrollTop: 3000,
  };

  it("leaves a finger's timing exactly as the field has it", () => {
    const field = createTunedSpringField(() => defaultFieldTunables());
    field.measure(ROWS);
    const how = openGesture(field, {
      ...base,
      anchorScreenY: 400,
      fingerDown: true,
      recent: [
        { t: 980, s: 3040 },
        { t: 996, s: 3000 },
      ],
    });
    expect(how).toBe("kept");
    // nothing was framed: the field is still waiting for its own first frame
    expect(field.lag()).toBe(0);
  });

  it("leaves an already-live gesture alone", () => {
    const field = createTunedSpringField(() => defaultFieldTunables());
    field.measure(ROWS);
    openGesture(field, { ...base, recent: [] });
    expect(openGesture(field, { ...base, nowMs: 1016, recent: [] })).toBe("kept");
  });

  it("seeds a fresh no-finger gesture from readings that are recent enough", () => {
    const field = createTunedSpringField(() => defaultFieldTunables());
    field.measure(ROWS);
    const how = openGesture(field, {
      ...base,
      recent: [
        { t: 980, s: 3040 },
        { t: 996, s: 3000 },
      ],
    });
    expect(how).toBe("seeded");
    expect(Math.abs(field.lag())).toBeGreaterThan(10); // it has a real speed
  });

  it("refuses to replay readings older than the window", () => {
    const field = createTunedSpringField(() => defaultFieldTunables());
    field.measure(ROWS);
    const how = openGesture(field, {
      ...base,
      recent: [
        { t: 100, s: 3040 },
        { t: 116, s: 3000 },
      ],
    });
    expect(how).toBe("baselined");
    expect(field.lag()).toBe(0); // no travel from a second ago injected as live
  });

  it("refuses to replay a pair that did not move, or that has no time between it", () => {
    const still = createTunedSpringField(() => defaultFieldTunables());
    still.measure(ROWS);
    expect(
      openGesture(still, {
        ...base,
        recent: [
          { t: 980, s: 3000 },
          { t: 996, s: 3000 },
        ],
      }),
    ).toBe("baselined");

    const instant = createTunedSpringField(() => defaultFieldTunables());
    instant.measure(ROWS);
    expect(
      openGesture(instant, {
        ...base,
        recent: [
          { t: 996, s: 3040 },
          { t: 996, s: 3000 },
        ],
      }),
    ).toBe("baselined");
  });

  it("the replay window is bounded and small", () => {
    // it may bridge a desktop's half-rate delivery and nothing like a gesture
    expect(REPLAY_WINDOW_MS).toBeGreaterThanOrEqual(2 * FRAME_MS);
    expect(REPLAY_WINDOW_MS).toBeLessThan(200);
  });
});

describe("taking a dropped gesture back on a scroll event", () => {
  const now = 10_000;
  it("does nothing while the field still has one", () => {
    expect(takesScrollBack({ armed: true, fingerDown: false, nowMs: now, lastGestureAt: now })).toBe(
      false,
    );
  });
  it("does nothing while a finger is holding one open", () => {
    expect(takesScrollBack({ armed: false, fingerDown: true, nowMs: now, lastGestureAt: now })).toBe(
      false,
    );
  });
  it("takes it back just after a real gesture act", () => {
    expect(
      takesScrollBack({ armed: false, fingerDown: false, nowMs: now, lastGestureAt: now - 50 }),
    ).toBe(true);
  });
  it("and not long after one", () => {
    expect(
      takesScrollBack({
        armed: false,
        fingerDown: false,
        nowMs: now,
        lastGestureAt: now - GESTURE_INTENT_MS - 1,
      }),
    ).toBe(false);
  });
  it("and never with no gesture at all behind it", () => {
    expect(
      takesScrollBack({ armed: false, fingerDown: false, nowMs: now, lastGestureAt: -Infinity }),
    ).toBe(false);
  });
});
