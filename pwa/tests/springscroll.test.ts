// Pins for the springy transcript (springscroll.ts): the bubbles lag the scroll
// through their own springs and settle back with no overshoot, the stretch is
// capped, only near-viewport rows participate, and the whole effect is held at
// zero while the app owns a motion. The pure field is unit-tested directly; the
// main.ts wiring is source-pinned like flight.test.ts / shift.test.ts, because
// main.ts boots a real shell at import and cannot load under node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DISPLACEMENT_CAP_PX,
  PARTICIPATION_BUFFER_PX,
  REST_EPS_PX,
  REST_EPS_V,
  RESISTANCE_MAX,
  SPRING_OMEGA,
  atRest,
  createSpringField,
  injectDisplacement,
  relax,
  resistanceFor,
  windowBounds,
} from "../src/springscroll";
import type { SpringRow, SpringState } from "../src/springscroll";

const src = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

describe("resistanceFor — softer with distance, saturating", () => {
  it("is zero under the anchor and grows with distance", () => {
    expect(resistanceFor(0)).toBe(0);
    expect(resistanceFor(200)).toBeGreaterThan(resistanceFor(50));
    expect(resistanceFor(400)).toBeGreaterThan(resistanceFor(200));
  });

  it("is symmetric above and below the anchor (absolute distance)", () => {
    expect(resistanceFor(-300)).toBe(resistanceFor(300));
  });

  it("never reaches a full stall — capped well under 1, so nothing crosses", () => {
    expect(resistanceFor(1e9)).toBe(RESISTANCE_MAX);
    expect(RESISTANCE_MAX).toBeLessThan(1);
  });
});

describe("injectDisplacement — the lag, capped", () => {
  it("lags against the travel in proportion to resistance (below the cap)", () => {
    expect(injectDisplacement(0, 0.3, 30)).toBeCloseTo(9, 6);
    expect(injectDisplacement(0, 0.1, 30)).toBeCloseTo(3, 6);
  });

  it("a near-zero resistance row barely moves (it tracks the scroll)", () => {
    expect(Math.abs(injectDisplacement(0, 0.01, 100))).toBeLessThan(1.5);
  });

  it("caps the stretch both ways, however fast the fling", () => {
    expect(injectDisplacement(0, RESISTANCE_MAX, 100000)).toBe(DISPLACEMENT_CAP_PX);
    expect(injectDisplacement(0, RESISTANCE_MAX, -100000)).toBe(-DISPLACEMENT_CAP_PX);
  });
});

describe("relax — the settle: to zero, no overshoot", () => {
  it("returns a pure position offset monotonically to rest", () => {
    let s: SpringState = { d: DISPLACEMENT_CAP_PX, v: 0 };
    let prev = s.d;
    for (let i = 0; i < 200; i++) {
      s = relax(s, 16);
      expect(s.d).toBeGreaterThanOrEqual(-1e-9); // never crosses to the far side
      expect(s.d).toBeLessThanOrEqual(prev + 1e-9); // never grows: no overshoot
      prev = s.d;
    }
    expect(Math.abs(s.d)).toBeLessThan(REST_EPS_PX);
  });

  it("cannot overshoot even under a hard inward velocity (the sign-cross snap)", () => {
    // a large velocity aimed through rest lands exactly on zero, never past it
    const s = relax({ d: 2, v: -50 }, 16);
    expect(s.d).toBe(0);
    expect(s.v).toBe(0);
  });

  it("settles from the cap in the gentle band (~0.4-0.7s), not instantly, not laggy", () => {
    let s: SpringState = { d: DISPLACEMENT_CAP_PX, v: 0 };
    let t = 0;
    while (!atRest(s) && t < 5000) {
      s = relax(s, 16);
      t += 16;
    }
    expect(t).toBeGreaterThan(300);
    expect(t).toBeLessThan(900);
  });

  it("does nothing on a non-positive dt", () => {
    const s: SpringState = { d: 5, v: 1 };
    expect(relax(s, 0)).toBe(s);
    expect(relax(s, -10)).toBe(s);
  });
});

describe("atRest — home is sub-visible", () => {
  it("is true only under both thresholds", () => {
    expect(atRest({ d: 0, v: 0 })).toBe(true);
    expect(atRest({ d: REST_EPS_PX / 2, v: REST_EPS_V / 2 })).toBe(true);
    expect(atRest({ d: 1, v: 0 })).toBe(false);
    expect(atRest({ d: 0, v: 1 })).toBe(false);
  });
});

describe("windowBounds — only near the viewport", () => {
  it("spans the visible band widened by the buffer each way", () => {
    const [lo, hi] = windowBounds(1000, 800);
    expect(lo).toBe(1000 - PARTICIPATION_BUFFER_PX);
    expect(hi).toBe(1000 + 800 + PARTICIPATION_BUFFER_PX);
  });
});

// --- the field: a small synthetic thread ---------------------------------------
// 40 rows of 40px stacked from the top; the viewport is 400px (10 rows).
function makeRows(n = 40, pitch = 40): SpringRow[] {
  return Array.from({ length: n }, (_, i) => ({ top: i * pitch, height: pitch - 2 }));
}
const CLIENT_H = 400;
const THREAD_TOP = 0;

describe("createSpringField — zero at rest", () => {
  it("displaces nothing before any scroll", () => {
    const f = createSpringField();
    f.measure(makeRows());
    expect(f.active()).toBe(false);
    expect(f.displacements().size).toBe(0);
  });

  it("the first scroll of a gesture is only a baseline (no jump from nowhere)", () => {
    const f = createSpringField();
    f.measure(makeRows());
    f.scroll(1000, CLIENT_H, THREAD_TOP, 1000); // no prior reference
    expect(f.active()).toBe(false);
  });
});

describe("createSpringField — a drag opens capped gaps, only near the viewport", () => {
  it("injects into rows in the window and leaves far rows at zero", () => {
    const f = createSpringField();
    const rows = makeRows();
    f.measure(rows);
    // viewport sits at content [1000,1400]; anchor is the finger near its centre
    f.scroll(1000, CLIENT_H, THREAD_TOP, 200); // baseline at scrollTop 1000
    f.scroll(1120, CLIENT_H, THREAD_TOP, 200); // a 120px drag
    const disp = f.displacements();
    // a row deep above the viewport (row 0, top 0) never participates
    expect(disp.has(0)).toBe(false);
    // rows inside the window did move
    let moved = 0;
    for (const [, dy] of disp) {
      moved++;
      expect(Math.abs(dy)).toBeLessThanOrEqual(DISPLACEMENT_CAP_PX + 1e-9);
    }
    expect(moved).toBeGreaterThan(0);
  });

  it("a faster drag opens a wider gap than a slow one, up to the cap", () => {
    const slow = createSpringField();
    const fast = createSpringField();
    slow.measure(makeRows());
    fast.measure(makeRows());
    slow.scroll(1000, CLIENT_H, THREAD_TOP, 200);
    fast.scroll(1000, CLIENT_H, THREAD_TOP, 200);
    slow.scroll(1020, CLIENT_H, THREAD_TOP, 200); // 20px
    fast.scroll(1300, CLIENT_H, THREAD_TOP, 200); // 300px
    const maxOf = (m: Map<number, number>) => Math.max(...[...m.values()].map(Math.abs), 0);
    expect(maxOf(fast.displacements())).toBeGreaterThan(maxOf(slow.displacements()));
  });

  it("farther-from-anchor rows lag more than nearer ones (the stretch)", () => {
    const f = createSpringField();
    const rows = makeRows();
    f.measure(rows);
    f.scroll(1000, CLIENT_H, THREAD_TOP, 200);
    f.scroll(1200, CLIENT_H, THREAD_TOP, 200);
    const disp = f.displacements();
    const anchorContent = 1200 + (200 - THREAD_TOP); // finger content-Y at the drag's end
    // |displacement| is a monotone function of distance from the anchor, up to
    // the cap — so sorting by distance, the magnitudes never decrease.
    const pairs = [...disp.entries()]
      .map(([i, dy]) => ({
        dist: Math.abs(rows[i].top + rows[i].height / 2 - anchorContent),
        mag: Math.abs(dy),
      }))
      .sort((a, b) => a.dist - b.dist);
    for (let k = 1; k < pairs.length; k++) {
      expect(pairs[k].mag).toBeGreaterThanOrEqual(pairs[k - 1].mag - 1e-9);
    }
  });
});

describe("createSpringField — the settle returns every row to exactly zero", () => {
  it("after a drag, frames relax all rows home with no overshoot and no residue", () => {
    const f = createSpringField();
    const rows = makeRows();
    f.measure(rows);
    f.scroll(1000, CLIENT_H, THREAD_TOP, 200);
    f.scroll(1200, CLIENT_H, THREAD_TOP, 200);
    // record the sign of each row's displacement at release
    const startSign = new Map<number, number>();
    for (const [i, dy] of f.displacements()) startSign.set(i, Math.sign(dy));
    // now let go: run frames until at rest
    let now = 0;
    f.frame(now); // first frame is a clock reading
    let frames = 0;
    while (f.active() && frames < 2000) {
      now += 16;
      f.frame(now);
      // no row ever crosses to the far side of rest (no overshoot)
      for (const [i, dy] of f.displacements()) {
        if (startSign.get(i)) expect(Math.sign(dy) === startSign.get(i) || dy === 0).toBe(true);
      }
      frames++;
    }
    expect(f.active()).toBe(false);
    expect(f.displacements().size).toBe(0);
  });

  it("stops scheduling: active() is false once settled, and frames after rest are free", () => {
    const f = createSpringField();
    f.measure(makeRows());
    f.scroll(1000, CLIENT_H, THREAD_TOP, 200);
    f.scroll(1100, CLIENT_H, THREAD_TOP, 200);
    let now = 0;
    f.frame(now);
    while (f.active() && now < 5000) {
      now += 16;
      f.frame(now);
    }
    expect(f.active()).toBe(false);
    const touchedBefore = f.displacements().size;
    f.frame(now + 16); // a stray frame after rest
    expect(f.displacements().size).toBe(touchedBefore); // touches nothing
  });
});

describe("createSpringField — rows never overlap", () => {
  it("displaced screen positions stay in strict document order throughout a drag and settle", () => {
    const f = createSpringField();
    const rows = makeRows(40, 40); // 40px pitch, 38px tall: 2px gaps
    f.measure(rows);
    const check = () => {
      const disp = f.displacements();
      // screen order = seat top + displacement; must stay increasing and never
      // let a row's displaced top pass the next row's displaced top
      for (let i = 0; i < rows.length - 1; i++) {
        const a = rows[i].top + (disp.get(i) ?? 0);
        const b = rows[i + 1].top + (disp.get(i + 1) ?? 0);
        expect(b).toBeGreaterThan(a); // still ordered, no overlap
      }
    };
    f.scroll(600, CLIENT_H, THREAD_TOP, 100);
    f.scroll(900, CLIENT_H, THREAD_TOP, 100); // hard fling
    check();
    let now = 0;
    f.frame(now);
    while (f.active() && now < 5000) {
      now += 16;
      f.frame(now);
      check();
    }
  });
});

describe("createSpringField — freeze is the hold-off", () => {
  it("zeroes every spring at once and drops them from the active set", () => {
    const f = createSpringField();
    f.measure(makeRows());
    f.scroll(1000, CLIENT_H, THREAD_TOP, 200);
    f.scroll(1200, CLIENT_H, THREAD_TOP, 200);
    expect(f.active()).toBe(true);
    f.freeze();
    expect(f.active()).toBe(false);
    expect(f.displacements().size).toBe(0);
  });
});

describe("createSpringField — rebase never injects (the app's own writes)", () => {
  it("a rebased jump leaves everything at zero", () => {
    const f = createSpringField();
    f.measure(makeRows());
    f.rebase(1000);
    f.rebase(2000); // an app write of 1000px: not a drag
    expect(f.active()).toBe(false);
    expect(f.displacements().size).toBe(0);
  });

  it("after a rebase the next real drag reads a correct delta, not the app's jump", () => {
    const f = createSpringField();
    f.measure(makeRows());
    f.scroll(500, CLIENT_H, THREAD_TOP, 200); // baseline reference at 500
    f.rebase(900); // the app wrote the scroll 400px down: the reference follows
    f.scroll(910, CLIENT_H, THREAD_TOP, 200); // a 10px real drag from 900
    const maxMag = Math.max(...[...f.displacements().values()].map(Math.abs), 0);
    expect(maxMag).toBeGreaterThan(0);
    // a 10px drag stays well under the cap; had rebase not moved the reference the
    // delta would have been 1010px and every window row would be pinned at the cap
    expect(maxMag).toBeLessThan(DISPLACEMENT_CAP_PX);
  });
});

describe("createSpringField — re-measure preserves a settle in progress", () => {
  it("carries the state of rows whose seat did not move", () => {
    const f = createSpringField();
    const rows = makeRows();
    f.measure(rows);
    f.scroll(1000, CLIENT_H, THREAD_TOP, 200);
    f.scroll(1200, CLIENT_H, THREAD_TOP, 200);
    const before = f.displacements().size;
    f.measure(rows.map((r) => ({ ...r }))); // identical layout, fresh objects
    expect(f.displacements().size).toBe(before); // nothing snapped to zero
  });

  it("zeroes rows whose seat moved (a real content change)", () => {
    const f = createSpringField();
    const rows = makeRows();
    f.measure(rows);
    f.scroll(1000, CLIENT_H, THREAD_TOP, 200);
    f.scroll(1200, CLIENT_H, THREAD_TOP, 200);
    expect(f.active()).toBe(true);
    f.measure(rows.map((r) => ({ top: r.top + 100, height: r.height }))); // everything shifted
    expect(f.active()).toBe(false); // the effect resets on a genuine re-lay
  });
});

// --- the wiring, source-pinned (main.ts boots a shell at import) ----------------
describe("main.ts wiring — held off through every motion the app owns", () => {
  const blocked = src.slice(
    src.indexOf("function springBlocked()"),
    src.indexOf("}", src.indexOf("function springBlocked()") + 400),
  );

  it("springBlocked reads every app-owned motion", () => {
    for (const signal of [
      "flightsUp > 0", // a send flight
      "airborneRows.size", // its rows
      "arrival !== null", // the arrival morph
      "glide !== null", // a scroll ride (jump)
      "glideRaf !== 0",
      "landingHold", // the resume ride
      "resumeWindowOpen()", // the resume window
      "shiftAnims.length", // a seat move / the receipt crossfade (beginSiblingShift)
      'app.classList.contains("kb")', // the keyboard lift
    ]) {
      expect(blocked).toContain(signal);
    }
  });

  it("the FLIP shift freezes the springs before it measures a single rect", () => {
    const shift = src.slice(
      src.indexOf("function beginSiblingShift()"),
      src.indexOf("const before = new Map", src.indexOf("function beginSiblingShift()")),
    );
    expect(shift).toContain("springFreeze();");
  });

  it("the scroll handler drives the effect and writes no scroll of its own", () => {
    const at = src.indexOf('thread.addEventListener("scroll"');
    const body = src.slice(at, src.indexOf("if (hasScrollend)", at));
    expect(body).toContain("springHandleScroll();");
    expect(body).not.toMatch(/scrollTop\s*=/); // the effect is transform-only
  });

  it("only a real gesture arms the effect; an app write or idle move just rebases", () => {
    const handler = src.slice(
      src.indexOf("function springHandleScroll()"),
      src.indexOf("function armSpring"),
    );
    expect(handler).toContain("if (springBlocked())");
    expect(handler).toContain("springFreeze()");
    expect(handler).toContain("if (!springArmed)");
    expect(handler).toContain("springField.rebase(st)");
    expect(handler).toContain("springField.scroll(");
  });

  it("gestures arm it: touchstart with the finger, wheel and non-touch pointer without", () => {
    expect(src).toContain("armSpring(e.touches[0].clientY)"); // the finger is the anchor
    expect(src).toContain("armSpring(null)"); // a wheel anchors on the centre
    expect(src).toContain('if (e.pointerType !== "touch") armSpring(e.clientY)');
  });

  it("the effect is applied as the compositor-only translate longhand", () => {
    const apply = src.slice(
      src.indexOf("function applySpring()"),
      src.indexOf("function springPump"),
    );
    expect(apply).toContain("el.style.translate = `0 ${dy.toFixed(2)}px`");
    expect(apply).toContain('el.style.removeProperty("translate")'); // cleared at rest
    expect(apply).not.toContain("style.transform"); // never the peek's property
  });

  it("row geometry is read once per gesture, not per frame", () => {
    const pump = src.slice(src.indexOf("function springPump()"), src.indexOf("function springFreeze"));
    expect(pump).not.toContain("offsetTop"); // the frame loop reads no layout
    expect(pump).not.toContain("getBoundingClientRect");
    const measure = src.slice(src.indexOf("function measureSpring()"), src.indexOf("function applySpring"));
    expect(measure).toContain("el.offsetTop"); // the once-per-gesture read
  });

  it("uses the omega derived from the stated frequency", () => {
    // a smoke check that the exported constant is finite and gentle-ranged
    expect(SPRING_OMEGA).toBeGreaterThan(0);
    expect(SPRING_OMEGA).toBeLessThan(0.05);
  });
});
