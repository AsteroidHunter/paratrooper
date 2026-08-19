// Pins for the jump-chevron behavior (src/downbtn.ts) — the state machine
// that surfaces the scroll-down button ONLY after a scroll pause while away
// from the bottom, plus the tap's one-swoosh glide plan. Pure with an
// injectable pause window, so every scenario runs on fake timers: show on 4s
// of stillness while away, every scroll restarting that window, staying up
// until the bottom takes it down, and never appearing at the bottom — a
// fresh open pinned there shows nothing.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GLIDE_MS, PAUSE_MS, createDownButton, createGlide } from "../src/downbtn";

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

describe("createGlide — one continuous decelerating swoosh, whole distance, fixed beat", () => {
  it("the beat is 400ms regardless of distance — a long jump just moves faster", () => {
    expect(GLIDE_MS).toBe(400);
    const short = createGlide(4000, 0); // 300 from the landing
    const long = createGlide(0, 0); // 4300 from the landing
    expect(short.done(399)).toBe(false);
    expect(short.done(400)).toBe(true);
    expect(long.done(399)).toBe(false);
    expect(long.done(400)).toBe(true); // same beat either way
  });

  it("starts at the start and lands exactly on the target — no teleport step", () => {
    const g = createGlide(0, 1000);
    expect(g.at(1000, 4300)).toBe(0); // frame zero: still where the tap found it
    expect(g.at(1016, 4300)).toBeLessThan(600); // one frame in: moving, not hopping
    expect(g.at(1400, 4300)).toBe(4300); // the beat ends exactly on the landing
    expect(g.at(1500, 4300)).toBe(4300); // past the beat it stays put
  });

  it("decelerates: the front half covers far more ground than the back half", () => {
    const g = createGlide(0, 0);
    const mid = g.at(GLIDE_MS / 2, 1000);
    expect(mid).toBeGreaterThan(800); // ease-out cubic: 87.5% done at half-beat
    expect(1000 - mid).toBeLessThan(200); // the rest is the soft landing
  });

  it("moves monotonically toward the landing, never past it", () => {
    const g = createGlide(500, 0);
    let prev = 500;
    for (let ms = 0; ms <= GLIDE_MS; ms += 16) {
      const pos = g.at(ms, 9000);
      expect(pos).toBeGreaterThanOrEqual(prev);
      expect(pos).toBeLessThanOrEqual(9000);
      prev = pos;
    }
  });

  it("the target is re-read live: content landing mid-glide still ends exactly", () => {
    const g = createGlide(0, 0);
    g.at(200, 4300); // half-flight against the old bottom
    expect(g.at(400, 4550)).toBe(4550); // a message grew the thread; the beat ends at the NEW bottom
  });

  it("a user gesture cancels mid-flight: the run is over immediately and stays over", () => {
    const g = createGlide(0, 0);
    expect(g.done(200)).toBe(false);
    g.cancel();
    expect(g.cancelled()).toBe(true);
    expect(g.done(200)).toBe(true); // done mid-beat: the wiring stops writing
    expect(g.done(400)).toBe(true);
  });
});

// Presentation pins: the chevron's disc and seat live in styles.css/markup,
// so these read the source directly — cheap tripwires for exactly what the
// device test ruled on: the original glass back, the arrow a fixed color,
// the disc seated in the ＋'s column directly above it.
describe("presentation — original glass, fixed arrow, above-the-＋ seat", () => {
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

  it("seated in the ＋'s column, directly above it", () => {
    const attachRule = css.match(/\n\.attach \{([^}]*)\}/)?.[1] ?? "";
    expect(attachRule).toContain("width: 34px"); // the ＋'s circle
    expect(jumpRule).toContain("left: calc(0.75rem - 1px)"); // 36px disc centered on the 34px column
    expect(jumpRule).not.toContain("right:"); // off the right edge for good
    expect(jumpRule).toContain("bottom: calc(var(--pad-b) + 36.5px + 0.5rem)"); // one bar gap above the ＋
    // and the button actually lives inside the compose bar's anchor box
    expect(main).toMatch(/<form id="compose"[\s\S]*id="jump"[\s\S]*<\/form>/);
  });

  it("the tap runs the one-swoosh glide, cancelled by any real gesture", () => {
    expect(main).not.toContain("glideHop"); // the teleport hop is gone
    expect(main).toMatch(/Id\("jump"\)!\.addEventListener\("click",[\s\S]{0,700}startGlide\(\)/);
    expect(main).toMatch(/"wheel",[\s\S]{0,80}cancelGlide\(\)/);
    expect(main).toMatch(/"pointerdown",[\s\S]{0,80}cancelGlide\(\)/);
    expect(main).toMatch(/"touchstart",[\s\S]{0,120}cancelGlide\(\)/);
  });
});
