// Pins for the jump-chevron behavior (src/downbtn.ts) — the state machine
// that surfaces the scroll-down button ONLY after a scroll pause while away
// from the bottom, plus the tap's cruise-then-brake glide plan. Pure with an
// injectable pause window, so every scenario runs on fake timers: show on 4s
// of stillness while away, every scroll restarting that window, staying up
// until the bottom takes it down, and never appearing at the bottom — a
// fresh open pinned there shows nothing.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GLIDE_BRAKE_SCREENS,
  GLIDE_MAX_SPEED,
  PAUSE_MS,
  createDownButton,
  createGlide,
} from "../src/downbtn";

function harness() {
  const calls: boolean[] = []; // every setVisible edge, in order
  const btn = createDownButton((show) => calls.push(show));
  return { calls, btn };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("showing — only a settled pause while away from the bottom", () => {
  it("the stillness window is 4 seconds", () => {
    expect(PAUSE_MS).toBe(4000);
  });

  it("shows after the full pause of stillness while away, not before", () => {
    const { calls, btn } = harness();
    btn.scrolled(false); // drifted up into history
    vi.advanceTimersByTime(PAUSE_MS - 1);
    expect(btn.visible()).toBe(false);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(btn.visible()).toBe(true);
    expect(calls).toEqual([true]); // one edge, no spam
  });

  it("every scroll while away restarts the window: shows one full pause after the LAST", () => {
    const { calls, btn } = harness();
    btn.scrolled(false);
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(PAUSE_MS - 1000); // keeps moving inside the window
      btn.scrolled(false);
      expect(calls).toEqual([]);
    }
    vi.advanceTimersByTime(PAUSE_MS - 1);
    expect(btn.visible()).toBe(false); // still short of a full pause since the last scroll
    vi.advanceTimersByTime(1);
    expect(btn.visible()).toBe(true);
    expect(calls).toEqual([true]);
  });

  it("once shown, further away-scrolling keeps it shown — no flicker", () => {
    const { calls, btn } = harness();
    btn.scrolled(false);
    vi.advanceTimersByTime(PAUSE_MS);
    btn.scrolled(false); // reading on upward
    vi.advanceTimersByTime(PAUSE_MS * 2);
    btn.scrolled(false);
    expect(btn.visible()).toBe(true);
    expect(calls).toEqual([true]); // still the one edge
  });
});

describe("hiding — reaching the bottom is the only way down", () => {
  it("a scroll landing at the bottom hides it", () => {
    const { calls, btn } = harness();
    btn.scrolled(false);
    vi.advanceTimersByTime(PAUSE_MS);
    btn.scrolled(true); // glided back down
    expect(btn.visible()).toBe(false);
    expect(calls).toEqual([true, false]);
  });

  it("the jump tap (bottomReached) hides it immediately", () => {
    const { calls, btn } = harness();
    btn.scrolled(false);
    vi.advanceTimersByTime(PAUSE_MS);
    btn.bottomReached(); // the tap, before any scroll event lands
    expect(btn.visible()).toBe(false);
    expect(calls).toEqual([true, false]);
  });

  it("hiding resets the machine: away again needs a full fresh pause", () => {
    const { btn } = harness();
    btn.scrolled(false);
    vi.advanceTimersByTime(PAUSE_MS);
    btn.scrolled(true); // shown -> bottom -> hidden
    btn.scrolled(false); // away once more
    vi.advanceTimersByTime(PAUSE_MS - 1);
    expect(btn.visible()).toBe(false); // no credit from the earlier stay
    vi.advanceTimersByTime(1);
    expect(btn.visible()).toBe(true);
  });

  it("reaching the bottom mid-wait cancels the pending show", () => {
    const { calls, btn } = harness();
    btn.scrolled(false);
    vi.advanceTimersByTime(PAUSE_MS - 1);
    btn.scrolled(true); // back at the bottom just before the window closes
    vi.advanceTimersByTime(PAUSE_MS * 2);
    expect(btn.visible()).toBe(false);
    expect(calls).toEqual([]); // the cancelled wait never surfaced anything
  });

  it("bottomReached disarms a pending wait too (fresh shell re-render)", () => {
    const { calls, btn } = harness();
    btn.scrolled(false);
    btn.bottomReached(); // renderChat: fresh shell opens pinned
    vi.advanceTimersByTime(PAUSE_MS * 2);
    expect(btn.visible()).toBe(false);
    expect(calls).toEqual([]); // no stray timer fires into the new shell
  });
});

describe("at the bottom it never appears", () => {
  it("at/near-bottom scrolls never show it, however long things stay still", () => {
    const { calls, btn } = harness();
    for (let i = 0; i < 3; i++) {
      btn.scrolled(true);
      vi.advanceTimersByTime(PAUSE_MS * 2);
    }
    expect(btn.visible()).toBe(false);
    expect(calls).toEqual([]);
  });

  it("a fresh open pinned at the bottom shows nothing — pin echoes included", () => {
    const { calls, btn } = harness();
    // boot replay: no user scrolling, only the pins' own at-bottom scroll
    // events (and possibly none at all on a short thread)
    btn.scrolled(true);
    btn.scrolled(true);
    vi.advanceTimersByTime(PAUSE_MS * 10);
    expect(btn.visible()).toBe(false);
    expect(calls).toEqual([]); // the chevron plays no part in a fresh landing
  });
});

describe("createGlide — flat cruise while far, distance-proportional brake near the landing", () => {
  const VH = 700; // the driver feeds the real container height every frame
  const ZONE = GLIDE_BRAKE_SCREENS * VH; // the slowdown may only show inside this
  const CAP = GLIDE_MAX_SPEED * 16; // full-speed px per 60fps frame

  it("the tuning: 25px/ms cruise, braking within two screens of the bottom", () => {
    expect(GLIDE_MAX_SPEED).toBe(25);
    expect(GLIDE_BRAKE_SCREENS).toBe(2);
  });

  it("far away the speed is capped flat — the step is distance-blind", () => {
    expect(createGlide(0).step(16, 50_000, VH)).toBe(CAP);
    expect(createGlide(0).step(16, ZONE + 1, VH)).toBe(CAP); // still outside: same step
  });

  it("frame zero moves nothing: the tap's own frame is not a hop", () => {
    expect(createGlide(1000).step(1000, 5000, VH)).toBe(0);
  });

  it("braking onset sits exactly two viewport heights out", () => {
    expect(createGlide(0).step(16, ZONE, VH)).toBe(CAP); // the crossover: both rules agree
    expect(createGlide(0).step(16, ZONE - 1, VH)).toBeLessThan(CAP); // one px inside: braking
    expect(createGlide(0).step(16, ZONE / 2, VH)).toBeCloseTo(CAP / 2, 8); // speed ∝ remaining
  });

  it("inside the zone every frame is slower than the last — monotonic brake", () => {
    const g = createGlide(0);
    let remaining = ZONE;
    let prev = Number.POSITIVE_INFINITY;
    for (let ms = 16; remaining > 1; ms += 16) {
      const step = g.step(ms, remaining, VH);
      expect(step).toBeGreaterThan(0);
      expect(step).toBeLessThan(prev);
      prev = step;
      remaining -= step;
    }
  });

  it("a long ride is cruise-then-brake and lands EXACTLY — never a teleport", () => {
    const g = createGlide(0);
    let remaining = 4300; // a typical far-up jump: several screens
    const steps: number[] = [];
    for (let ms = 16; !g.done() && steps.length < 1000; ms += 16) {
      const s = g.step(ms, remaining, VH);
      steps.push(s);
      remaining -= s;
    }
    expect(remaining).toBe(0); // exact landing, no sub-pixel residue
    expect(g.done()).toBe(true);
    expect(Math.max(...steps)).toBe(CAP); // nothing ever outruns the cruise cap
    const cruise = steps.filter((s) => s === CAP);
    expect(cruise.length).toBeGreaterThanOrEqual(7); // (4300 − ZONE) / CAP flat-out frames
    // once braking begins it only slows, bar the final sub-pixel landing snap
    const brake = steps.slice(cruise.length, -1);
    for (let i = 1; i < brake.length; i++) {
      expect(brake[i]).toBeLessThan(brake[i - 1]);
    }
  });

  it("content growing mid-flight re-opens the throttle, still landing on the NEW bottom", () => {
    const g = createGlide(0);
    let remaining = 600; // deep in the brake zone, easing in
    const crawl = g.step(16, remaining, VH);
    expect(crawl).toBeLessThan(CAP);
    remaining -= crawl;
    remaining += 5000; // a tall message lands: the bottom leaps away again
    expect(g.step(32, remaining, VH)).toBe(CAP); // back to flat cruise, still capped
    remaining -= CAP;
    let ms = 32;
    for (let i = 0; i < 1000 && !g.done(); i++) {
      ms += 16;
      remaining -= g.step(ms, remaining, VH);
    }
    expect(remaining).toBe(0); // the retargeted run still ends exactly
  });

  it("a user gesture cancels mid-flight: over immediately, steps stop dead", () => {
    const g = createGlide(0);
    expect(g.step(16, 5000, VH)).toBe(CAP);
    expect(g.done()).toBe(false);
    g.cancel();
    expect(g.cancelled()).toBe(true);
    expect(g.done()).toBe(true); // done mid-ride: the wiring stops writing
    expect(g.step(32, 5000, VH)).toBe(0);
  });
});

// Presentation pins: the chevron's disc and seat live in styles.css/markup,
// so these read the source directly — cheap tripwires for exactly what the
// device test ruled on: the original glass back, the arrow a fixed color,
// the disc seated at the bar's right end, right edges flush with the pill.
describe("presentation — original glass, fixed arrow, right-tangent seat", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const jumpRule = css.match(/\n\.jump \{([^}]*)\}/)?.[1] ?? "";
  const faceRule = css.match(/\n\.jump::before \{([^}]*)\}/)?.[1] ?? "";
  const glyphRule = css.match(/\n\.jump-glyph \{([^}]*)\}/)?.[1] ?? "";

  it("the original glass disc: translucent face, blur, ring stack, 36px", () => {
    expect(faceRule).toContain("background-color: var(--glass-bg)"); // not a near-opaque slab
    expect(faceRule).toContain("backdrop-filter: blur(16px) saturate(180%)");
    expect(faceRule).toContain("box-shadow: var(--glass-stack-sm)");
    expect(jumpRule).toContain("width: 36px");
    expect(jumpRule).toContain("height: 36px");
    expect(jumpRule).toContain("background: none"); // the face lives on ::before
    expect(css).not.toContain("--jump-bg"); // the butchered opaque disc is gone
  });

  it("only the arrow changed: one fixed color per scheme, no blend tricks", () => {
    expect(css).not.toContain("mix-blend-mode");
    expect(glyphRule).toContain("color: var(--jump-fg)");
  });

  it("keeps the original 0.15s show/hide fade on face and glyph alike", () => {
    expect(faceRule).toContain("transition: opacity 0.15s");
    expect(glyphRule).toContain("transition: opacity 0.15s");
  });

  it("seated at the bar's right end: disc and pill right edges flush", () => {
    const composeRule = css.match(/\n\.compose \{([^}]*)\}/)?.[1] ?? "";
    expect(composeRule).toContain("padding: 0.5rem 0.75rem var(--pad-b)"); // the pill's right edge: 0.75rem in
    expect(jumpRule).toContain("right: 0.75rem"); // the same inset = the two right edges tangent
    expect(jumpRule).not.toContain("left:"); // off the ＋'s column for good
    expect(jumpRule).toContain("bottom: calc(var(--pad-b) + 36.5px + 0.5rem)"); // vertical seat unchanged
    // and the button actually lives inside the compose bar's anchor box
    expect(main).toMatch(/<form id="compose"[\s\S]*id="jump"[\s\S]*<\/form>/);
  });

  it("the tap runs the cruise-then-brake glide, cancelled by any real gesture", () => {
    expect(main).not.toContain("glideHop"); // the teleport hop is gone
    expect(main).toMatch(/Id\("jump"\)!\.addEventListener\("click",[\s\S]{0,700}startGlide\(\)/);
    expect(main).toMatch(/"wheel",[\s\S]{0,80}cancelGlide\(\)/);
    expect(main).toMatch(/"pointerdown",[\s\S]{0,80}cancelGlide\(\)/);
    expect(main).toMatch(/"touchstart",[\s\S]{0,120}cancelGlide\(\)/);
  });
});
