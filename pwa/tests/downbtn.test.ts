// Pins for the jump-chevron visibility (src/downbtn.ts) — the state machine
// that surfaces the scroll-down button ONLY after a scroll pause while away
// from the bottom. Pure with an injectable pause window, so every scenario
// runs on fake timers: show on 7s of stillness while away, every scroll
// restarting that window, staying up until the bottom takes it down, and
// never appearing at the bottom — a fresh open pinned there shows nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAUSE_MS, createDownButton } from "../src/downbtn";

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
  it("shows after 7s of stillness while away, not before", () => {
    const { calls, btn } = harness();
    btn.scrolled(false); // drifted up into history
    vi.advanceTimersByTime(PAUSE_MS - 1);
    expect(btn.visible()).toBe(false);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(btn.visible()).toBe(true);
    expect(calls).toEqual([true]); // one edge, no spam
  });

  it("every scroll while away restarts the window: shows 7s after the LAST", () => {
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
