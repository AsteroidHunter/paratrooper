// Pins for the jump-chevron behavior (src/downbtn.ts) — the state machine
// that surfaces the scroll-down button ONLY after a scroll pause while away
// from the bottom, plus the tap's damped-spring glide plan. Pure with an
// injectable pause window, so every scenario runs on fake timers: show on 4s
// of stillness while away, every scroll restarting that window, staying up
// until the bottom takes it down, and never appearing at the bottom — a
// fresh open pinned there shows nothing.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GLIDE_DAMPING_RATIO,
  GLIDE_DT_MAX,
  GLIDE_MAX_SPEED,
  GLIDE_SNAP_SPEED,
  GLIDE_SPRING_SCREENS,
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

describe("createGlide — a capped damped spring: flat cruise far out, one physical settle", () => {
  const VH = 700; // the driver feeds the real container height every frame
  const CAP = GLIDE_MAX_SPEED * 16; // full-speed px per 60fps frame

  // drive one glide over fixed frames until it lands; the per-frame ledger is
  // the proof material for every claim below
  function ride(start: number, vh = VH, dt = 16) {
    const g = createGlide(0);
    let remaining = start;
    const steps: number[] = [];
    const remainingBefore: number[] = [];
    for (let ms = dt; !g.done() && steps.length < 5000; ms += dt) {
      remainingBefore.push(remaining);
      const s = g.step(ms, remaining, vh);
      steps.push(s);
      remaining -= s;
    }
    return { g, remaining, steps, remainingBefore };
  }

  it("the tuning: 25px/ms cap, 3-screen spring reach, damping just above critical", () => {
    expect(GLIDE_MAX_SPEED).toBe(25);
    // reach 3.0 (was 1.7): the device verdict — braking must READ about two
    // screens out, not stack into the last message; near-critical ζ spreads
    // the shed through those screens instead of feeding a longer tail crawl
    expect(GLIDE_SPRING_SCREENS).toBe(3.0);
    expect(GLIDE_DAMPING_RATIO).toBe(1.02);
    expect(GLIDE_DAMPING_RATIO).toBeGreaterThanOrEqual(1); // ζ<1 would ring — never
    expect(GLIDE_SNAP_SPEED).toBeLessThanOrEqual(0.1); // the snap fires only at a crawl
  });

  it("frame zero moves nothing: the tap's own frame is not a hop", () => {
    expect(createGlide(1000).step(1000, 5000, VH)).toBe(0);
  });

  it("far away the advance pins flat at the cap — the cruise is distance-blind", () => {
    // a screens-long stretch: the spring's pull saturates the cap immediately
    expect(createGlide(0).step(16, 50_000, VH)).toBe(CAP);
    const far = ride(20_000);
    const cruise = far.steps.filter((s) => s === CAP);
    expect(cruise.length).toBeGreaterThan(20); // most of the ride is exact-cap frames
    // the 3-screen spring spends its first from-rest frame ACCELERATING at
    // this distance (~80% of the cap's advance) — an ease-in, not a hop —
    // and is pinned from the second frame on
    expect(far.steps[0]).toBeGreaterThan(0.75 * CAP);
    expect(far.steps[1]).toBe(CAP);
    expect(Math.max(...far.steps)).toBe(CAP); // and nothing ever outruns it
  });

  it("NO overshoot, cap held, exact landing — a sweep of rides, viewports, clocks", () => {
    const clocks: Array<(i: number) => number> = [
      () => 16,
      () => 16.667,
      (i) => (i % 3 === 0 ? 33.4 : 8.3), // a jittery main thread
      (i) => (i === 20 ? 400 : 16.667), // a background-tab stall mid-ride
    ];
    for (const start of [80, 500, 1200, 2500, 6340, 20_000, 120_000]) {
      for (const vh of [568, 700, 844]) {
        for (const clock of clocks) {
          const g = createGlide(0);
          let remaining = start;
          let now = 0;
          for (let i = 0; !g.done() && i < 5000; i++) {
            const dt = clock(i);
            now += dt;
            const s = g.step(now, remaining, vh);
            const dtSeen = Math.min(dt, GLIDE_DT_MAX); // the plan's own stall ceiling
            expect(s).toBeGreaterThanOrEqual(0);
            expect(s).toBeLessThanOrEqual(GLIDE_MAX_SPEED * dtSeen + 1e-9); // cap, every frame
            remaining -= s;
            expect(remaining).toBeGreaterThanOrEqual(0); // position NEVER passes the target
          }
          expect(g.done()).toBe(true);
          expect(remaining).toBe(0); // exact landing, no sub-pixel residue
        }
      }
    }
  });

  it("a stalled tab's huge dt integrates as at most the ceiling — no teleport frame", () => {
    const g = createGlide(0);
    g.step(16, 50_000, VH); // clean first frame
    expect(g.step(16 + 400, 49_600, VH)).toBe(GLIDE_MAX_SPEED * GLIDE_DT_MAX); // not 25·400
  });

  it("the brake is one monotone slide: once off the cap for good, every frame is slower", () => {
    const { steps, remaining } = ride(6340);
    expect(remaining).toBe(0);
    // the ride's shape: a wind-up frame or two, the capped cruise, then decay —
    // the monotone claim starts where the cap lets go
    const brakeStart = steps.lastIndexOf(Math.max(...steps));
    expect(Math.max(...steps)).toBe(CAP); // this long a ride does reach the cruise cap
    // bar the final frame — the sub-pixel exact-landing snap takes what's left
    for (let i = brakeStart + 1; i < steps.length - 1; i++) {
      expect(steps[i]).toBeLessThan(steps[i - 1]); // no surge, no shudder, no bounce
    }
  });

  it("the slowdown READS from two screens out — not only at the last message", () => {
    // the device verdict on the 1.7-screen spring: it shed 25 -> 15 by two
    // viewports but stacked everything readable into the final half screen.
    // Retuned, the crossing speeds spread the brake across the whole approach
    // (old tuning at the same marks: 15.1 / 7.6 / 3.7 / 0.73) while the final
    // tenth crawls exactly as gently as the settle he already approved.
    const { steps, remaining, remainingBefore } = ride(6340);
    expect(remaining).toBe(0);
    const speedCrossing = (px: number) => {
      const i = remainingBefore.findIndex((r) => r <= px);
      return steps[i - 1] / 16; // the frame that carried the ride past the mark
    };
    expect(speedCrossing(2 * VH)).toBeCloseTo(12.18, 1); // under half the cap by 2 screens
    expect(speedCrossing(VH)).toBeCloseTo(6.47, 1); // readable glide by one screen
    expect(speedCrossing(0.5 * VH)).toBeCloseTo(3.24, 1); // clearly gliding by half
    expect(speedCrossing(0.1 * VH)).toBeCloseTo(0.64, 1); // the approved crawl, unchanged
    // and the spread does not turn sluggish: time inside the final two
    // viewports stays in the 600–1100ms band (the first spring spent 656ms)
    const inside2 = remainingBefore.filter((r) => r <= 2 * VH).length;
    expect(inside2).toBe(49); // 784ms at 16ms frames
  });

  it("velocity carries across a retarget: content growing mid-flight bends the ride", () => {
    const g = createGlide(0);
    let remaining = 2000;
    let ms = 0;
    let speed = 0;
    while (remaining >= 600) {
      ms += 16;
      const s = g.step(ms, remaining, VH);
      speed = s / 16;
      remaining -= s;
    }
    expect(speed).toBeLessThan(8); // deep in the approach, crawling
    remaining += 3000; // a tall message lands: the bottom leaps away again
    ms += 16;
    const after1 = g.step(ms, remaining, VH) / 16;
    remaining -= after1 * 16;
    ms += 16;
    const after2 = g.step(ms, remaining, VH) / 16;
    remaining -= after2 * 16;
    // the throttle re-opens through the spring, not a jump cut: speed climbs
    // from the carried value over frames (the old law leapt straight to 25)
    expect(after1).toBeGreaterThan(speed);
    expect(after1).toBeLessThan(16);
    expect(after2).toBeGreaterThan(after1);
    expect(after2).toBeLessThanOrEqual(GLIDE_MAX_SPEED);
    for (let i = 0; i < 1000 && !g.done(); i++) {
      ms += 16;
      remaining -= g.step(ms, remaining, VH);
    }
    expect(remaining).toBe(0); // the retargeted run still ends exactly
  });

  it("a bottom that moved UP mid-cruise lands NOW, exactly, never past", () => {
    const g = createGlide(0);
    let ms = 0;
    let remaining = 8000;
    for (let i = 0; i < 5; i++) {
      ms += 16;
      remaining -= g.step(ms, remaining, VH); // at full cruise
    }
    ms += 16;
    expect(g.step(ms, 50, VH)).toBe(50); // collapsed content: the landing is the remaining, whole
    expect(g.done()).toBe(true);
    expect(g.step(ms + 16, 0, VH)).toBe(0); // and the run stays over
  });

  it("the settle through the final viewport of a long ride: 704ms — 592ms before", () => {
    // the same fixed-frame sim the soften ramp was measured with (6340px ride):
    // frames spent under one viewport-height of remaining, at 16ms each
    const { steps, remaining, remainingBefore } = ride(6340);
    expect(remaining).toBe(0);
    const inside = remainingBefore.filter((r) => r <= VH).length;
    expect(inside).toBe(44); // 704ms; the 1.7-reach spring did 37 (592ms)
    // and the touch itself is a crawl, not a slam
    expect(steps[steps.length - 1] / 16).toBeLessThan(0.1);
  });

  it("from rest one viewport out the ride takes 51 frames (816ms) — 40 before", () => {
    const { steps, remaining } = ride(VH);
    expect(remaining).toBe(0); // still an exact landing, just a softer one
    expect(steps.length).toBe(51); // the 1.7-reach spring did 40; the soften ramp 36
  });

  it("a user gesture cancels mid-flight: over immediately, steps stop dead", () => {
    const g = createGlide(0);
    expect(g.step(16, 5000, VH)).toBeGreaterThan(0);
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

  it("only the arrow changed: one fixed fill per scheme, no blend tricks", () => {
    expect(css).not.toContain("mix-blend-mode");
    expect(glyphRule).toContain("fill: var(--jump-fg)");
  });

  it("the arrow carries a thin rim of the opposite tone; the disc does not", () => {
    expect(glyphRule).toContain("stroke: var(--jump-rim)");
    expect(css).toMatch(/--jump-rim: rgba\(255, 255, 255/); // light: white hair under the accent arrow
    expect(css).toMatch(/--jump-rim: rgba\(0, 0, 0/); // dark: dark hair under the white arrow
    expect(faceRule).not.toContain("stroke"); // the glass face itself stays untouched
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
    // raised seat: the pill's 39px + one 0.75rem gap of air (~12.5px clear of
    // the pill, roughly double the old 36.5px + 0.5rem carry-over's ~6px)
    expect(jumpRule).toContain("bottom: calc(var(--pad-b) + 39px + 0.75rem)");
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

// Pins for the arrow's construction (the m215 device verdict): the adaptive
// backdrop-invert overlay doubled the arrow on device, read too thick, and
// flipped tone at the wrong moment — it is gone root and branch. The one
// arrow is an inline SVG silhouette (markup in main.ts) with the scheme's
// fixed --jump-fg as fill over a --jump-rim stroke painted UNDER the fill:
// only the stroke's outer half shows, a thinner boundary than the retired
// eight-direction shadow ring, and round joins keep it a smooth offset of
// the shape — the shadow ring ran to points at every sharp glyph angle.
describe("presentation — one SVG arrow, smooth under-stroke rim", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const glyphRule = css.match(/\n\.jump-glyph \{([^}]*)\}/)?.[1] ?? "";

  it("the adaptive overlay is gone root and branch", () => {
    expect(css).not.toContain(".jump::after"); // no second arrow layer
    expect(css).not.toContain("--jump-floor"); // no floor split either
    expect(css).not.toContain("mask-image");
    expect(css).not.toContain("invert(");
  });

  it("the glyph is ONE inline SVG arrow at the disc's own 1-unit-per-px scale", () => {
    const svg = main.match(/<svg\s[\s\S]*?class="jump-glyph"[\s\S]*?<\/svg>/)?.[0] ?? "";
    expect(svg).toContain('viewBox="0 0 36 36"');
    expect(svg.match(/<path/g)?.length).toBe(1); // one path, one arrow — never two
    // the silhouette: stem 1.7 wide, head 7.8 wide at 45°, ink x 14.1–21.9
    // and y 12–28 — the footprint of the font arrow the device approved
    expect(svg).toContain(
      'd="M17.15 12h1.7v12.75l1.85-1.85 1.2 1.2L18 28l-3.9-3.9 1.2-1.2 1.85 1.85z"');
  });

  it("the rim is a stroke UNDER the fill: thin, round-joined, spike-proof", () => {
    expect(glyphRule).toContain("paint-order: stroke"); // stroke first = under the fill
    // 2 units centered on the edge, inner half covered by the fill: a 1px
    // visible boundary — thinner than the old ring's 1px-plus-diagonals
    expect(glyphRule).toContain("stroke-width: 2");
    expect(glyphRule).toContain("stroke-linejoin: round"); // corners round, never pointy
    expect(glyphRule).toContain("stroke-linecap: round");
    expect(glyphRule).not.toContain("text-shadow"); // the eight-direction halo is gone
  });

  it("shown state: face and glyph both at full strength — no floor opacity", () => {
    expect(css).toMatch(/\.jump\.show::before \{\n {2}opacity: 1;/);
    expect(css).toMatch(/\.jump\.show \.jump-glyph \{\n {2}opacity: 1;/);
  });
});
