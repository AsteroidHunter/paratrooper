// Pins for the ends of the thread (endspring.ts): the rubber band iOS Safari
// hides from an inner scroller, modelled rather than measured. The numbers come
// off the owner's Messages screen recording (three finger pulls past the bottom
// of 63.2, 90.5 and 25.0 CSS px, each released; the spring back critically
// damped at 1.65–1.88 Hz with no overshoot; the lag running straight through the
// bounce at a ratio of 0.99 against speed x tau) except the two the recording
// cannot hold — the pull-versus-finger curve (Apple's documented formula, since
// a screen recording has no finger in it) and a fling hitting the end at speed
// (absent from the clip; the same measured spring is given the impact speed).
// Tables in the wiki agent notes. The pure model is unit-tested directly; the
// main.ts seam is source-pinned like springscroll.test.ts, because main.ts boots
// a real shell at import and cannot load under node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  END_TUNING,
  advanceBounce,
  bouncePeak,
  createEndSpring,
  rubberBand,
  rubberTravel,
} from "../src/endspring";
import type { EndSpringModel } from "../src/endspring";

const src = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const FRAME = 1000 / 60;
const W = END_TUNING.BOUNCE_OMEGA;
const VH = 700; // the thread's height on the phone, CSS px
const MAX = 5000; // scrollTop's maximum in these tests

/** run the model forward from `t0`, feeding a fixed scroll position, and return
    the overscroll each frame */
function coast(m: EndSpringModel, t0: number, frames: number, st: number, max = MAX): number[] {
  const out: number[] = [];
  for (let i = 1; i <= frames; i++) out.push(m.frame(t0 + i * FRAME, st, max, VH));
  return out;
}

describe("the tunables — the measured spring and the documented curve, in one place", () => {
  it("is the critically damped bounce fitted on the recording: 11.2 rad/s, 1.78 Hz", () => {
    expect(END_TUNING.BOUNCE_OMEGA).toBe(11.2);
    const hz = END_TUNING.BOUNCE_OMEGA / (2 * Math.PI);
    expect(hz).toBeGreaterThan(1.6); // the three fits: 1.65, 1.80, 1.88 Hz
    expect(hz).toBeLessThan(1.9);
  });

  it("is Apple's documented rubber-band coefficient, with the same number as the ceiling", () => {
    expect(END_TUNING.RUBBER_C).toBe(0.55);
    // the ceiling needs 2.2 screens of finger travel, so it only ever binds a fling
    expect(END_TUNING.MAX_OVER_FRACTION).toBeGreaterThan(0.3);
    expect(END_TUNING.MAX_OVER_FRACTION).toBeLessThan(1);
  });

  it("feeds the lag at full gain, lands at exactly zero, and floors a crawl into the end", () => {
    expect(END_TUNING.FEED_GAIN).toBe(1); // the recording's pull measured 0.99 against speed x tau
    expect(END_TUNING.REST_EPS_PX).toBeLessThanOrEqual(0.5); // under the DOM's own rounding
    expect(END_TUNING.IMPACT_MIN_SPEED).toBeGreaterThan(0.23); // the clip's one soft arrival, which did not bounce
    expect(END_TUNING.IMPACT_MIN_SPEED).toBeLessThan(0.6);
  });

  it("carries no duration, no easing and no beat: the bounce is a spring, not a tween", () => {
    const t = END_TUNING as Record<string, unknown>;
    for (const gone of ["BOUNCE_MS", "EASING", "DAMPING_RATIO", "BEAT_MS", "OVERSHOOT"]) {
      expect(t[gone]).toBeUndefined();
    }
  });
});

describe("rubberBand — Apple's documented UIScrollView curve", () => {
  it("is zero at the end and never negative", () => {
    expect(rubberBand(0, VH)).toBe(0);
    expect(rubberBand(-50, VH)).toBe(0);
    expect(rubberBand(50, 0)).toBe(0);
  });

  it("follows the finger at c near the end and resists harder further out", () => {
    expect(rubberBand(1, VH) / 1).toBeCloseTo(END_TUNING.RUBBER_C, 2); // the curve's slope at the end
    expect(rubberBand(100, VH) / 100).toBeLessThan(0.53);
    expect(rubberBand(400, VH) / 400).toBeLessThan(0.42);
  });

  it("asymptotes at the scroller's own height, so the end can never run away", () => {
    expect(rubberBand(1e6, VH)).toBeLessThan(VH);
    expect(rubberBand(1e6, VH)).toBeGreaterThan(VH * 0.99);
    expect(rubberBand(1e9, VH)).toBeLessThan(VH);
    // and a whole screen of finger travel only reaches a third of it
    expect(rubberBand(VH, VH)).toBeLessThan(VH * 0.4);
  });

  it("is monotone in the finger's travel", () => {
    let prev = 0;
    for (let x = 1; x <= 600; x += 7) {
      const b = rubberBand(x, VH);
      expect(b).toBeGreaterThan(prev);
      prev = b;
    }
  });

  it("puts the recording's three pulls at ordinary finger travels (the only check available)", () => {
    // 63.2 / 90.5 / 25.0 CSS px of content past the bottom on a ~620 px scroller
    const d = 620;
    expect(rubberTravel(63.2, d)).toBeGreaterThan(100);
    expect(rubberTravel(63.2, d)).toBeLessThan(160);
    expect(rubberTravel(90.5, d)).toBeGreaterThan(160);
    expect(rubberTravel(90.5, d)).toBeLessThan(230);
    expect(rubberTravel(25.0, d)).toBeLessThan(70);
    // and it inverts the curve it came from
    expect(rubberBand(rubberTravel(63.2, d), d)).toBeCloseTo(63.2, 6);
  });
});

describe("advanceBounce — the measured spring, exact per frame", () => {
  it("released from rest it returns without ever crossing the end", () => {
    let [x, v] = [90, 0];
    let minimum = x;
    for (let i = 0; i < 90; i++) {
      [x, v] = advanceBounce(x, v, FRAME);
      minimum = Math.min(minimum, x);
    }
    expect(minimum).toBeGreaterThanOrEqual(0); // no overshoot: the recording showed 0.03 CSS px
    expect(x).toBeLessThan(0.05);
  });

  it("matches the recording's milestones: 50% back by ~150 ms, 90% by ~340 ms, home by ~550 ms", () => {
    const A = 90.5; // the recording's largest pull
    let [x, v] = [A, 0];
    const at: Record<string, number> = {};
    for (let i = 1; i <= 60; i++) {
      [x, v] = advanceBounce(x, v, FRAME);
      const t = i * FRAME;
      for (const f of [0.5, 0.63, 0.9, 0.99]) {
        if (at[f] === undefined && x <= A * (1 - f)) at[f] = t;
      }
    }
    expect(at[0.5]).toBeGreaterThan(120); // measured 140–165 ms
    expect(at[0.5]).toBeLessThan(190);
    expect(at[0.63]).toBeGreaterThan(140); // measured 181–209 ms
    expect(at[0.63]).toBeLessThan(220);
    expect(at[0.9]).toBeGreaterThan(260); // measured 340–364 ms
    expect(at[0.9]).toBeLessThan(370);
    expect(at[0.99]).toBeGreaterThan(430); // measured 512–576 ms
    expect(at[0.99]).toBeLessThan(630);
  });

  it("accelerates first — a spring, not the transcript's own first-order lag", () => {
    // the recording's returns peak in speed 67–133 ms after the release, which
    // an exponential (fastest at t = 0) cannot do
    let [x, v] = [90, 0];
    let peakAt = 0;
    let peak = 0;
    for (let i = 1; i <= 40; i++) {
      [x, v] = advanceBounce(x, v, FRAME);
      if (Math.abs(v) > peak) {
        peak = Math.abs(v);
        peakAt = i * FRAME;
      }
    }
    expect(peakAt).toBeGreaterThan(50);
    expect(peakAt).toBeLessThan(140);
    expect(peak).toBeCloseTo((90 * (W / 1000)) / Math.E, 2); // A x omega / e, px per ms
  });

  it("is frame-rate independent: one 33 ms frame lands where two 16.7 ms frames do", () => {
    let a = advanceBounce(80, -20, 2 * FRAME);
    let b = advanceBounce(80, -20, FRAME);
    b = advanceBounce(b[0], b[1], FRAME);
    expect(a[0]).toBeCloseTo(b[0], 9);
    expect(a[1]).toBeCloseTo(b[1], 9);
    a = advanceBounce(80, 0, 0);
    expect(a[0]).toBe(80);
  });

  it("a fling's peak is speed / (omega x e), reached at 1 / omega", () => {
    for (const speed of [0.5, 1, 2, 4]) {
      let [x, v] = [0, speed];
      let peak = 0;
      let peakAt = 0;
      for (let i = 1; i <= 40; i++) {
        [x, v] = advanceBounce(x, v, FRAME);
        if (x > peak) {
          peak = x;
          peakAt = i * FRAME;
        }
      }
      expect(peak).toBeCloseTo(bouncePeak(speed), 0);
      expect(peakAt).toBeGreaterThan(1000 / W - 20); // 89 ms
      expect(peakAt).toBeLessThan(1000 / W + 20);
    }
    expect(bouncePeak(2)).toBeCloseTo((2 * 1000) / (W * Math.E), 9);
  });
});

describe("the end marker — nothing at all until the thread is on an end", () => {
  it("returns exactly zero mid-thread, however the finger moves", () => {
    const m = createEndSpring();
    m.begin(true, 400);
    let t = 0;
    m.frame((t += FRAME), 2000, MAX, VH);
    for (let i = 0; i < 20; i++) {
      m.finger(400 - i * 12);
      expect(m.frame((t += FRAME), 2000 + i * 12, MAX, VH)).toBe(0);
    }
    expect(m.phase()).toBe("idle");
    expect(m.active()).toBe(false);
  });

  it("fires at the top when scrollTop reaches 0 and at the bottom when it reaches its maximum", () => {
    for (const [st, sign] of [[0, -1], [MAX, 1]] as const) {
      const m = createEndSpring();
      m.begin(true, 400);
      let t = 0;
      m.frame((t += FRAME), st, MAX, VH); // baseline
      m.frame((t += FRAME), st, MAX, VH); // the marker fires, origin = 400
      m.finger(400 - sign * 60); // further into that end
      const over = m.frame((t += FRAME), st, MAX, VH);
      expect(Math.sign(over)).toBe(sign);
      expect(m.phase()).toBe("pulling");
    }
  });

  it("stands down when the engine reports its own overscroll (no double count)", () => {
    const m = createEndSpring();
    m.begin(true, 400);
    let t = 0;
    m.frame((t += FRAME), MAX, MAX, VH); // baseline
    m.frame((t += FRAME), MAX, MAX, VH); // the marker fires, origin = 400
    m.finger(340);
    expect(m.frame((t += FRAME), MAX, MAX, VH)).toBeGreaterThan(0);
    // the engine starts exposing the stretch itself: it is already in scrollTop
    expect(m.frame((t += FRAME), MAX + 40, MAX, VH)).toBe(0);
    expect(m.phase()).toBe("idle");
  });

  it("does nothing when there is nothing to scroll", () => {
    const m = createEndSpring();
    m.begin(true, 400);
    let t = 0;
    m.frame((t += FRAME), 0, 0, VH);
    m.frame((t += FRAME), 0, 0, VH);
    m.finger(500);
    expect(m.frame((t += FRAME), 0, 0, VH)).toBe(0);
  });
});

describe("a finger down past the end — the pull follows its travel", () => {
  function pull(sign: -1 | 1, travels: number[]): { over: number[]; model: EndSpringModel } {
    const m = createEndSpring();
    const st = sign < 0 ? 0 : MAX;
    m.begin(true, 400);
    let t = 0;
    m.frame((t += FRAME), st, MAX, VH); // baseline
    m.frame((t += FRAME), st, MAX, VH); // the marker fires, origin = 400
    const over: number[] = [];
    for (const tr of travels) {
      m.finger(400 - sign * tr); // top (-1): the finger moves DOWN; bottom (+1): UP
      over.push(m.frame((t += FRAME), st, MAX, VH));
    }
    return { over, model: m };
  }

  it("is the rubber-band curve of the finger's travel, at the bottom", () => {
    const { over } = pull(1, [40, 80, 160, 320]);
    for (const [i, tr] of [40, 80, 160, 320].entries()) {
      expect(over[i]).toBeCloseTo(rubberBand(tr, VH), 6);
    }
    expect(over[0]).toBeGreaterThan(0); // pulled past the bottom = positive
  });

  it("is the same curve mirrored at the top", () => {
    const { over } = pull(-1, [40, 80, 160, 320]);
    for (const [i, tr] of [40, 80, 160, 320].entries()) {
      expect(over[i]).toBeCloseTo(-rubberBand(tr, VH), 6);
    }
  });

  it("reproduces the recording's three pulls from their implied finger travels", () => {
    const d = VH;
    for (const px of [63.2, 90.5, 25.0]) {
      const { over } = pull(1, [rubberTravel(px, d)]);
      expect(over[0]).toBeCloseTo(px, 4);
    }
  });

  it("measures the travel from where the marker fired, not from where the drag began", () => {
    // a drag that arrives at the bottom at speed: the finger has already moved a
    // long way, but the pull starts at zero
    const m = createEndSpring();
    let t = 0;
    m.begin(true, 700);
    m.frame((t += FRAME), 3000, MAX, VH);
    m.finger(500);
    m.frame((t += FRAME), 4200, MAX, VH); // still mid-thread
    m.finger(420);
    const first = m.frame((t += FRAME), MAX, MAX, VH); // the marker fires here
    expect(first).toBe(0);
    m.finger(400);
    expect(m.frame((t += FRAME), MAX, MAX, VH)).toBeCloseTo(rubberBand(20, VH), 6);
  });

  it("goes slack when the finger comes back, and re-arms fresh on the next outward move", () => {
    const m = createEndSpring();
    let t = 0;
    m.begin(true, 400);
    m.frame((t += FRAME), MAX, MAX, VH);
    m.frame((t += FRAME), MAX, MAX, VH);
    m.finger(300); // 100 px out
    expect(m.frame((t += FRAME), MAX, MAX, VH)).toBeCloseTo(rubberBand(100, VH), 6);
    m.finger(430); // back past the origin
    expect(m.frame((t += FRAME), MAX, MAX, VH)).toBe(0);
    m.finger(400); // 30 px out from the NEW origin
    expect(m.frame((t += FRAME), MAX, MAX, VH)).toBeCloseTo(rubberBand(30, VH), 6);
  });

  it("never models further out than the curve's own asymptote", () => {
    const { over } = pull(1, [2000, 20000]);
    for (const o of over) expect(o).toBeLessThanOrEqual(END_TUNING.MAX_OVER_FRACTION * VH);
  });

  it("a wheel has no finger to pull with: the pull path stays at zero", () => {
    const m = createEndSpring();
    let t = 0;
    m.begin(false, null);
    m.frame((t += FRAME), MAX, MAX, VH);
    expect(m.frame((t += FRAME), MAX, MAX, VH)).toBe(0);
  });
});

describe("the release — the measured spring, ending at exactly zero", () => {
  function pullAndRelease(travel: number): { over: number[]; model: EndSpringModel } {
    const m = createEndSpring();
    let t = 0;
    m.begin(true, 400);
    m.frame((t += FRAME), MAX, MAX, VH);
    m.frame((t += FRAME), MAX, MAX, VH);
    m.finger(400 - travel);
    m.frame((t += FRAME), MAX, MAX, VH);
    m.frame((t += FRAME), MAX, MAX, VH); // held still: velocity falls to zero
    m.lift();
    const over: number[] = [];
    for (let i = 0; i < 90; i++) over.push(m.frame((t += FRAME), MAX, MAX, VH));
    return { over, model: m };
  }

  it("returns to the end and never crosses it", () => {
    const { over } = pullAndRelease(200);
    expect(over[0]).toBeGreaterThan(0);
    expect(Math.min(...over)).toBeGreaterThanOrEqual(0); // no overshoot, as measured
  });

  it("ends at EXACTLY zero and hands back with no step", () => {
    const { over, model } = pullAndRelease(200);
    expect(over[over.length - 1]).toBe(0);
    expect(model.over()).toBe(0);
    expect(model.phase()).toBe("idle");
    expect(model.active()).toBe(false);
    // the last non-zero frame is under the rest threshold, so the step to zero
    // is smaller than the DOM's own rounding
    const last = [...over].reverse().find((v) => v !== 0) ?? 0;
    expect(last).toBeLessThan(0.5); // under the DOM's own rounding: nothing is seen
  });

  it("is monotone and hits the recording's milestones", () => {
    const { over } = pullAndRelease(rubberTravel(90.5, VH));
    const A = over[0];
    expect(A).toBeGreaterThan(80);
    for (let i = 1; i < 40; i++) expect(over[i]).toBeLessThanOrEqual(over[i - 1]);
    const at = (f: number): number => over.findIndex((v) => v <= A * (1 - f)) * FRAME;
    expect(at(0.5)).toBeGreaterThan(110);
    expect(at(0.5)).toBeLessThan(200);
    expect(at(0.9)).toBeGreaterThan(250);
    expect(at(0.9)).toBeLessThan(380);
    expect(at(0.99)).toBeLessThan(620);
  });

  it("frames stop within about 600 ms of the release", () => {
    const { over } = pullAndRelease(200);
    const done = over.findIndex((v) => v === 0);
    expect(done).toBeGreaterThan(0);
    // 99% of the bounce is over by ~590 ms (the recording: 512–576); the tail to
    // the quarter-pixel rest threshold is the last 0.9 px and is not seen
    expect(done * FRAME).toBeLessThan(850);
  });

  it("a flick still moving outward at the lift carries a little further before it returns", () => {
    const m = createEndSpring();
    let t = 0;
    m.begin(true, 400);
    m.frame((t += FRAME), MAX, MAX, VH);
    m.frame((t += FRAME), MAX, MAX, VH);
    let y = 400;
    for (let i = 0; i < 4; i++) {
      m.finger((y -= 30));
      m.frame((t += FRAME), MAX, MAX, VH);
    }
    const atLift = m.over();
    m.lift();
    const over = coast(m, t, 60, MAX);
    expect(Math.max(...over)).toBeGreaterThan(atLift); // it kept going out
    expect(over[over.length - 1]).toBe(0); // and still landed exactly home
    expect(Math.min(...over)).toBeGreaterThanOrEqual(0);
  });

  it("a finger landing mid-bounce keeps the band where it stands, with no jump", () => {
    const m = createEndSpring();
    let t = 0;
    m.begin(true, 400);
    m.frame((t += FRAME), MAX, MAX, VH);
    m.frame((t += FRAME), MAX, MAX, VH);
    m.finger(200);
    m.frame((t += FRAME), MAX, MAX, VH);
    m.frame((t += FRAME), MAX, MAX, VH);
    m.lift();
    for (let i = 0; i < 6; i++) m.frame((t += FRAME), MAX, MAX, VH);
    expect(m.phase()).toBe("bouncing");
    const mid = m.over();
    expect(mid).toBeGreaterThan(10);
    m.begin(true, 500); // the finger is back
    m.finger(500);
    const held = m.frame((t += FRAME), MAX, MAX, VH);
    expect(m.phase()).toBe("pulling");
    // the whole point: the overscroll is UNCHANGED, so the lag is handed no step
    expect(held).toBeCloseTo(mid, 6);
    // and this finger now owns it: moving further out grows it from here
    m.finger(460);
    expect(m.frame((t += FRAME), MAX, MAX, VH)).toBeGreaterThan(held);
    // while coming back well inside the origin lets it go slack
    m.finger(900);
    expect(m.frame((t += FRAME), MAX, MAX, VH)).toBe(0);
  });

  it("a finger landing mid-bounce at the top keeps it too", () => {
    const m = createEndSpring();
    let t = 0;
    m.begin(false, null);
    m.frame((t += FRAME), 300, MAX, VH);
    m.frame((t += FRAME), 300 - 2 * FRAME, MAX, VH); // 2 px/ms toward the top
    m.frame((t += FRAME), 0, MAX, VH);
    for (let i = 0; i < 4; i++) m.frame((t += FRAME), 0, MAX, VH);
    const mid = m.over();
    expect(mid).toBeLessThan(-10);
    m.begin(true, 400);
    m.finger(400);
    expect(m.frame((t += FRAME), 0, MAX, VH)).toBeCloseTo(mid, 6);
    m.finger(440); // further past the top
    expect(m.frame((t += FRAME), 0, MAX, VH)).toBeLessThan(mid);
  });
});

describe("a fling into the end — the same spring, given the impact speed", () => {
  function fling(speed: number, sign: -1 | 1 = 1): { over: number[]; model: EndSpringModel } {
    const m = createEndSpring();
    let t = 0;
    m.begin(false, null); // the finger already left
    const end = sign > 0 ? MAX : 0;
    let st = end - sign * 600;
    m.frame((t += FRAME), st, MAX, VH); // baseline
    for (let i = 0; i < 6; i++) {
      st += sign * speed * FRAME;
      m.frame((t += FRAME), st, MAX, VH); // coasting, away from the end
    }
    const over: number[] = [m.frame((t += FRAME), end, MAX, VH)]; // the impact
    for (let i = 0; i < 80; i++) over.push(m.frame((t += FRAME), end, MAX, VH));
    return { over, model: m };
  }

  it("peaks at speed / (omega x e) about 89 ms in, at the bottom", () => {
    for (const speed of [0.6, 1.2, 2.5]) {
      const { over } = fling(speed);
      const peak = Math.max(...over);
      expect(peak).toBeGreaterThan(bouncePeak(speed) * 0.9);
      expect(peak).toBeLessThan(bouncePeak(speed) * 1.05);
      const at = over.indexOf(peak) * FRAME;
      expect(at).toBeGreaterThan(60);
      expect(at).toBeLessThan(120);
    }
  });

  it("is mirrored at the top", () => {
    const { over } = fling(1.2, -1);
    expect(Math.min(...over)).toBeLessThan(-bouncePeak(1.2) * 0.9);
    expect(Math.max(...over)).toBeLessThanOrEqual(0);
  });

  it("grows with the impact speed and stops at the ceiling", () => {
    const peaks = [0.4, 0.8, 1.6, 3.2].map((s) => Math.max(...fling(s).over));
    for (let i = 1; i < peaks.length; i++) expect(peaks[i]).toBeGreaterThan(peaks[i - 1]);
    expect(Math.max(...fling(50).over)).toBeLessThanOrEqual(END_TUNING.MAX_OVER_FRACTION * VH);
  });

  it("a crawl into the end lands rather than bounces", () => {
    const { over, model } = fling(END_TUNING.IMPACT_MIN_SPEED * 0.6);
    expect(Math.max(...over)).toBe(0);
    expect(model.phase()).toBe("idle");
  });

  it("comes back to EXACTLY zero with no overshoot past the end", () => {
    const { over, model } = fling(2);
    expect(Math.min(...over)).toBeGreaterThanOrEqual(0);
    expect(over[over.length - 1]).toBe(0);
    expect(model.over()).toBe(0);
    expect(model.active()).toBe(false);
  });

  it("reads the speed from the last frame that ended away from the end, not the clipped one", () => {
    // the frame that lands ON the end covers only what was left of the gap, so
    // its own delta understates the fling badly
    const m = createEndSpring();
    let t = 0;
    m.begin(false, null);
    m.frame((t += FRAME), MAX - 300, MAX, VH);
    m.frame((t += FRAME), MAX - 300 + 2 * FRAME, MAX, VH); // 2 px/ms
    const over = [m.frame((t += FRAME), MAX, MAX, VH)]; // the last 267 px, clipped
    for (let i = 0; i < 40; i++) over.push(m.frame((t += FRAME), MAX, MAX, VH));
    expect(Math.max(...over)).toBeGreaterThan(bouncePeak(2) * 0.9);
    expect(Math.max(...over)).toBeLessThan(bouncePeak(2) * 1.05);
  });

  it("a programmatic jump onto an end cannot fake a bounce", () => {
    const m = createEndSpring();
    let t = 0;
    m.begin(false, null);
    m.frame((t += FRAME), 40, MAX, VH);
    m.frame((t += FRAME), 40 + 0.5 * FRAME, MAX, VH); // 0.5 px/ms, mid-thread
    const over = coast(m, t, 40, MAX); // and now pinned at the bottom, 4960 px on
    // the bounce is the 0.5 px/ms the thread was really carrying, not the jump
    expect(Math.max(...over)).toBeCloseTo(bouncePeak(0.5), 0);
  });

  it("does not bounce when the thread reaches an end moving away from it", () => {
    const m = createEndSpring();
    let t = 0;
    m.begin(false, null);
    m.frame((t += FRAME), 40, MAX, VH);
    m.frame((t += FRAME), 20, MAX, VH); // moving toward the TOP
    // and now the position is reported at the BOTTOM (a programmatic jump)
    const over = coast(m, t, 20, MAX);
    expect(Math.max(...over.map(Math.abs))).toBe(0);
  });

  it("bounces once per arrival, not once per frame", () => {
    const { over } = fling(2);
    // one rise and one fall, never a re-seed: the sequence is unimodal
    const peak = over.indexOf(Math.max(...over));
    for (let i = peak + 1; i < over.length; i++) expect(over[i]).toBeLessThanOrEqual(over[i - 1]);
  });
});

describe("freeze and reset — the hold-off, and a fresh shell", () => {
  it("freeze zeroes a live pull outright and refuses further frames", () => {
    const m = createEndSpring();
    let t = 0;
    m.begin(true, 400);
    m.frame((t += FRAME), MAX, MAX, VH);
    m.frame((t += FRAME), MAX, MAX, VH);
    m.finger(250);
    expect(m.frame((t += FRAME), MAX, MAX, VH)).toBeGreaterThan(0);
    m.freeze();
    expect(m.over()).toBe(0);
    expect(m.active()).toBe(false);
    m.finger(200);
    expect(m.frame((t += FRAME), MAX, MAX, VH)).toBe(0); // disarmed: no gesture
  });

  it("freeze zeroes a live bounce too", () => {
    const { model } = (() => {
      const m = createEndSpring();
      let t = 0;
      m.begin(false, null);
      m.frame((t += FRAME), MAX - 300, MAX, VH);
      m.frame((t += FRAME), MAX - 300 + 2 * FRAME, MAX, VH);
      m.frame((t += FRAME), MAX, MAX, VH);
      m.frame((t += FRAME), MAX, MAX, VH);
      return { model: m };
    })();
    expect(model.active()).toBe(true);
    model.freeze();
    expect(model.over()).toBe(0);
    expect(model.phase()).toBe("idle");
  });

  it("reset drops the finger as well, so a fresh shell starts clean", () => {
    const m = createEndSpring();
    let t = 0;
    m.begin(true, 400);
    m.frame((t += FRAME), MAX, MAX, VH);
    m.frame((t += FRAME), MAX, MAX, VH);
    m.finger(250);
    m.frame((t += FRAME), MAX, MAX, VH);
    m.reset();
    expect(m.over()).toBe(0);
    m.begin(true, 400);
    m.frame((t += FRAME), MAX, MAX, VH);
    expect(m.frame((t += FRAME), MAX, MAX, VH)).toBe(0); // no travel remembered
  });

  it("a re-armed gesture never reads a speed from before it", () => {
    const m = createEndSpring();
    let t = 0;
    m.begin(false, null);
    m.frame((t += FRAME), MAX - 300, MAX, VH);
    m.frame((t += FRAME), MAX - 300 + 3 * FRAME, MAX, VH); // fast, then frozen
    m.freeze();
    m.begin(true, 400);
    const first = m.frame((t += 500), MAX, MAX, VH); // a fresh gesture, at the end
    expect(first).toBe(0);
    expect(m.frame((t += FRAME), MAX, MAX, VH)).toBe(0); // and no phantom impact
  });

  it("a stalled frame cannot teleport the spring", () => {
    const m = createEndSpring();
    let t = 0;
    m.begin(true, 400);
    m.frame((t += FRAME), MAX, MAX, VH);
    m.frame((t += FRAME), MAX, MAX, VH);
    m.finger(200);
    const at = m.frame((t += FRAME), MAX, MAX, VH);
    m.frame((t += FRAME), MAX, MAX, VH); // held still: the pull's own speed dies
    m.lift();
    const after = m.frame((t += 4000), MAX, MAX, VH); // the tab came back
    expect(after).toBeLessThan(at);
    expect(after).toBeGreaterThan(0); // clamped to DT_MAX_MS, not jumped to zero
  });
});

describe("what the model hands the lag — a bounce is ordinary scrolling to it", () => {
  it("the overscroll's own motion is what the field would have seen scrolling", () => {
    // the sum of the per-frame changes over a whole bounce is the pull itself,
    // so the lag integrates exactly the displacement the rows should trail
    const m = createEndSpring();
    let t = 0;
    m.begin(true, 400);
    m.frame((t += FRAME), MAX, MAX, VH);
    m.frame((t += FRAME), MAX, MAX, VH);
    m.finger(400 - rubberTravel(90.5, VH));
    const peak = m.frame((t += FRAME), MAX, MAX, VH);
    m.frame((t += FRAME), MAX, MAX, VH);
    m.lift();
    let prev = m.over();
    let travelled = 0;
    for (let i = 0; i < 90; i++) {
      const now = m.frame((t += FRAME), MAX, MAX, VH);
      travelled += now - prev;
      prev = now;
    }
    expect(peak).toBeCloseTo(90.5, 4);
    expect(travelled).toBeCloseTo(-90.5, 4); // every px of the pull comes back
  });

  it("the frame's motion never exceeds what a real fling could deliver", () => {
    const { over } = (() => {
      const m = createEndSpring();
      let t = 0;
      m.begin(false, null);
      m.frame((t += FRAME), MAX - 900, MAX, VH);
      m.frame((t += FRAME), MAX - 900 + 6 * FRAME, MAX, VH); // a 6 px/ms fling
      const o = [m.frame((t += FRAME), MAX, MAX, VH)];
      for (let i = 0; i < 80; i++) o.push(m.frame((t += FRAME), MAX, MAX, VH));
      return { over: o };
    })();
    for (let i = 1; i < over.length; i++) {
      expect(Math.abs(over[i] - over[i - 1]) / FRAME).toBeLessThanOrEqual(6.01);
    }
  });
});

describe("main.ts seam — one line in the pump, and every hold-off kept", () => {
  it("the pump adds the modelled overscroll to the position the field reads", () => {
    const pump = src.slice(src.indexOf("function springPump()"), src.indexOf("function springFreeze"));
    expect(pump).toContain("const st = t.scrollTop + endSpring.frame(now, t.scrollTop, springMaxScroll, springClientH)");
    expect(pump).toContain("springField.frame(now, st)");
    expect(pump).toContain("if (springField.active() || endSpring.active()) springRaf = requestAnimationFrame(step)");
  });

  it("the pump still makes one scroll read a frame and no layout read: the limit is cached at measure", () => {
    const pump = src.slice(src.indexOf("function springPump()"), src.indexOf("function springFreeze"));
    expect(pump).not.toContain("scrollHeight");
    expect(pump).not.toContain("clientHeight");
    expect(pump).not.toContain("getBoundingClientRect");
    const measure = src.slice(src.indexOf("function measureSpring()"), src.indexOf("function applySpring"));
    expect(measure).toContain("springMaxScroll = Math.max(t.scrollHeight - t.clientHeight, 0)");
  });

  it("the hold-off covers the end model: every freeze zeroes it too", () => {
    const freeze = src.slice(src.indexOf("function springFreeze()"), src.indexOf("function springHandleScroll"));
    expect(freeze).toContain("endSpring.freeze()");
    // and springBlocked() is what springFreeze answers to, unchanged
    const pump = src.slice(src.indexOf("function springPump()"), src.indexOf("function springFreeze"));
    expect(pump).toContain("if (springBlocked())");
    expect(pump).toContain("springFreeze();");
    const arm = src.slice(src.indexOf("function armSpring("), src.indexOf("function springFinger"));
    expect(arm).toContain("if (springBlocked()) return;");
  });

  it("touch events reach the model: the gesture opens it, moves feed the pull, the lift bounces it", () => {
    const arm = src.slice(src.indexOf("function armSpring("), src.indexOf("function springFinger"));
    expect(arm).toContain("endSpring.begin(fingerDown, touchY)");
    const fin = src.slice(src.indexOf("function springFinger("), src.indexOf("function liftSpring"));
    expect(fin).toContain("endSpring.finger(touchY)");
    const lift = src.slice(src.indexOf("function liftSpring()"), src.indexOf("// --- scrolling: glide"));
    expect(lift).toContain("endSpring.lift();");
    expect(lift).toContain("if (endSpring.active() && !springField.armed()) armSpring(springTouchY, false)");
  });

  it("a fresh shell drops the ends with the rest of the field", () => {
    expect(src).toContain("endSpring.reset();");
    expect(src).toContain("springMaxScroll = 0;");
  });

  it("the model writes no scroll of its own: it is a number the field reads", () => {
    const endsrc = readFileSync(new URL("../src/endspring.ts", import.meta.url), "utf8");
    expect(endsrc).not.toContain("document.");
    expect(endsrc).not.toContain("window.");
    expect(endsrc).not.toMatch(/scrollTo\(/);
    expect(endsrc).not.toContain("requestAnimationFrame");
    expect(endsrc).not.toMatch(/scrollTop\s*=/);
  });
});
