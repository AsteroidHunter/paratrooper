// Pins for the jump-chevron behavior (src/downbtn.ts) — the state machine
// that surfaces the scroll-down button ONLY after a scroll pause while away
// from the bottom, plus the tap's capped-glide plan. Pure with an injectable
// pause window, so every scenario runs on fake timers: show on 4s of
// stillness while away, every scroll restarting that window, staying up until
// the bottom takes it down, and never appearing at the bottom — a fresh open
// pinned there shows nothing.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAUSE_MS, createDownButton, glideHop } from "../src/downbtn";

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

describe("glideHop — the tap's capped glide (teleport far, glide the last stretch)", () => {
  // geometry: viewport 700, content 5000 -> the landing scrollTop is 4300

  it("from far up: teleport to exactly one viewport above the bottom", () => {
    expect(glideHop(0, 5000, 700)).toBe(3600); // 4300 - 700
    expect(glideHop(2000, 5000, 700)).toBe(3600); // same landing prep from anywhere far
  });

  it("within one viewport of the bottom: no teleport, glide the real distance", () => {
    expect(glideHop(3600, 5000, 700)).toBe(null); // exactly the cap away
    expect(glideHop(4000, 5000, 700)).toBe(null);
    expect(glideHop(4300, 5000, 700)).toBe(null); // already at the bottom
  });

  it("just past the cap teleports; the hop always lands ahead of the reader", () => {
    const hop = glideHop(3599, 5000, 700);
    expect(hop).toBe(3600);
    expect(hop! > 3599).toBe(true); // never a backward hop
  });

  it("a short thread that cannot scroll never teleports", () => {
    expect(glideHop(0, 500, 700)).toBe(null);
  });
});

// Presentation pins: the chevron's disc and seat live in styles.css/markup,
// so these read the source directly — cheap tripwires for the properties the
// device test actually complained about.
describe("presentation — disc, seat, and fade (styles.css / main.ts)", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const jumpRule = css.match(/\n\.jump \{([^}]*)\}/)?.[1] ?? "";
  const showRule = css.match(/\n\.jump\.show \{([^}]*)\}/)?.[1] ?? "";

  it("no blend-mode tricks anywhere: the arrow is a fixed color on its own disc", () => {
    expect(css).not.toContain("mix-blend-mode");
    expect(jumpRule).toContain("color: var(--jump-fg)");
    expect(jumpRule).toContain("background-color: var(--jump-bg)");
  });

  it("mirrors the ＋: same 34px circle, same 0.75rem edge inset, seated above the bar", () => {
    const attachRule = css.match(/\n\.attach \{([^}]*)\}/)?.[1] ?? "";
    expect(attachRule).toContain("width: 34px"); // the twin it mirrors
    expect(jumpRule).toContain("width: 34px");
    expect(jumpRule).toContain("height: 34px");
    expect(jumpRule).toContain("right: 0.75rem"); // = the compose bar's own edge padding
    expect(jumpRule).toContain("bottom: calc(100% +"); // anchored to the bar, rides its growth
    // and the button actually lives inside the compose bar's anchor box
    expect(main).toMatch(/<form id="compose"[\s\S]*id="jump"[\s\S]*<\/form>/);
  });

  it("arrives on a fade slower than it leaves", () => {
    const dur = (rule: string) => Number(rule.match(/transition: opacity ([\d.]+)s/)?.[1]);
    expect(dur(showRule)).toBeGreaterThan(dur(jumpRule));
    expect(dur(showRule)).toBeGreaterThanOrEqual(0.3); // a real fade-in, not a pop
  });
});
