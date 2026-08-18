// Pins for the finished-reply hold (src/hold.ts) — the state machine that keeps
// the agent's reply from shoving the thread mid-keystroke. Pure with an
// injectable clock, so every scenario runs on fake timers: hold while
// composing (ANY keypress counts — content plays no role, per the owner's
// order), release on 7s of quiet since the last keystroke, flush-before-send
// ordering, send ending the composing window, and no hold at all for an idle
// composer.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUIET_MS, createReplyHold } from "../src/hold";

interface Frame {
  seq: number;
  payload: string;
}

function harness() {
  const rendered: Frame[] = [];
  const hold = createReplyHold<Frame>((f) => rendered.push(f));
  return { rendered, hold };
}

const reply = (seq: number, payload = "done!"): Frame => ({ seq, payload });

beforeEach(() => {
  vi.useFakeTimers(); // fakes Date.now too, so the quiet window is fully driven
});

afterEach(() => {
  vi.useRealTimers();
});

describe("holding — only an actively composing owner defers the reply", () => {
  it("no keystroke yet -> no hold, caller renders immediately", () => {
    const { rendered, hold } = harness();
    expect(hold.maybeHold(5, reply(5))).toBe(false);
    expect(hold.holding()).toBe(false);
    expect(rendered).toEqual([]); // the hold renders nothing; the caller does
  });

  it("keystroke just now -> held, nothing rendered", () => {
    const { rendered, hold } = harness();
    hold.typed(); // "dra"
    expect(hold.maybeHold(5, reply(5))).toBe(true);
    expect(hold.holding()).toBe(true);
    expect(rendered).toEqual([]);
  });

  it("stale draft (last keystroke over 7s ago) does not hold", () => {
    const { hold } = harness();
    hold.typed(); // "half a thought"
    vi.advanceTimersByTime(QUIET_MS + 1); // he wandered off mid-draft
    expect(hold.maybeHold(5, reply(5))).toBe(false);
  });

  it("re-delivery of the same seq (reconnect replay) stays one frame", () => {
    const { rendered, hold } = harness();
    hold.typed();
    hold.maybeHold(5, reply(5));
    hold.maybeHold(5, reply(5));
    hold.flush();
    expect(rendered).toEqual([reply(5)]);
  });
});

describe("release on quiet — 7s from the LAST keystroke", () => {
  it("renders after 7s of no typing, not before", () => {
    const { rendered, hold } = harness();
    hold.typed();
    hold.maybeHold(5, reply(5));
    vi.advanceTimersByTime(QUIET_MS - 1);
    expect(rendered).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(rendered).toEqual([reply(5)]);
    expect(hold.holding()).toBe(false);
  });

  it("non-stop typing keeps deferring: every keystroke restarts the window", () => {
    const { rendered, hold } = harness();
    hold.typed();
    hold.maybeHold(5, reply(5));
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(QUIET_MS - 1000); // keeps typing inside the window
      hold.typed();
      expect(rendered).toEqual([]);
    }
    vi.advanceTimersByTime(QUIET_MS - 1);
    expect(rendered).toEqual([]); // still short of quiet since the LAST key
    vi.advanceTimersByTime(1);
    expect(rendered).toEqual([reply(5)]);
  });

  it("a reply landing mid-window releases 7s after the keystroke, not arrival", () => {
    const { rendered, hold } = harness();
    hold.typed();
    vi.advanceTimersByTime(3000); // reply arrives 3s into his pause
    hold.maybeHold(5, reply(5));
    vi.advanceTimersByTime(QUIET_MS - 3000 - 1);
    expect(rendered).toEqual([]);
    vi.advanceTimersByTime(1); // 7s since the keystroke
    expect(rendered).toEqual([reply(5)]);
  });
});

describe("any keypress counts — the composer's content plays no role", () => {
  it("space-mash over a pending reply parks it, releases 7s after the last space", () => {
    const { rendered, hold } = harness();
    hold.typed(); // " " — thumbs on the space bar
    expect(hold.maybeHold(5, reply(5))).toBe(true); // parked, not under his thumbs
    vi.advanceTimersByTime(2000);
    hold.typed(); // "  "
    vi.advanceTimersByTime(2000);
    hold.typed(); // "   " — the last space
    vi.advanceTimersByTime(QUIET_MS - 1);
    expect(rendered).toEqual([]); // quiet window counts from the LAST space
    vi.advanceTimersByTime(1);
    expect(rendered).toEqual([reply(5)]);
  });

  it("whitespace-only composer still holds (flipped: it used to count as empty)", () => {
    const { rendered, hold } = harness();
    hold.typed(); // "x"
    hold.maybeHold(5, reply(5));
    hold.typed(); // "   " — was an instant release; now it is just more typing
    expect(rendered).toEqual([]);
    expect(hold.holding()).toBe(true);
  });

  it("backspacing to empty keeps the hold until 7s of stillness", () => {
    const { rendered, hold } = harness();
    hold.typed(); // "hm"
    hold.maybeHold(5, reply(5));
    vi.advanceTimersByTime(500);
    hold.typed(); // "h" — deleting is still typing
    vi.advanceTimersByTime(500);
    hold.typed(); // "" — box now empty; NOT an instant release anymore
    expect(rendered).toEqual([]);
    vi.advanceTimersByTime(QUIET_MS - 1);
    expect(rendered).toEqual([]);
    vi.advanceTimersByTime(1); // 7s of stillness since the emptying backspace
    expect(rendered).toEqual([reply(5)]);
  });
});

describe("flush on send — the held reply lands above the outgoing message", () => {
  it("flush renders synchronously, before the caller's own bubble", () => {
    const { rendered, hold } = harness();
    hold.typed();
    hold.maybeHold(5, reply(5));
    hold.flush(); // what send() does before appending the optimistic bubble
    expect(rendered).toEqual([reply(5)]); // reply first; the send comes after
    expect(hold.holding()).toBe(false);
  });

  it("several parked frames release oldest-first by seq", () => {
    const { rendered, hold } = harness();
    hold.typed();
    hold.maybeHold(9, reply(9, "second"));
    hold.maybeHold(5, reply(5, "first"));
    hold.flush();
    expect(rendered.map((f) => f.seq)).toEqual([5, 9]);
  });

  it("a frame arriving while one is parked parks behind it, one release for both", () => {
    const { rendered, hold } = harness();
    hold.typed();
    hold.maybeHold(5, reply(5));
    hold.typed(); // window restarts
    hold.maybeHold(6, reply(6)); // still composing: parks behind the first
    expect(rendered).toEqual([]);
    vi.advanceTimersByTime(QUIET_MS);
    expect(rendered.map((f) => f.seq)).toEqual([5, 6]); // one release, in order
  });
});

describe("send ends composing — flush zeroes the keystroke clock", () => {
  it("a reply arriving 2.5s after send renders immediately, not parked", () => {
    const { hold } = harness();
    hold.typed(); // composing the message he is about to send
    vi.advanceTimersByTime(300);
    hold.flush(); // the send: textarea clears with no input event, clock must not stay fresh
    vi.advanceTimersByTime(2500); // agent answers fast
    expect(hold.maybeHold(5, reply(5))).toBe(false); // caller renders it right away
    expect(hold.holding()).toBe(false);
  });

  it("send with a parked frame renders it AND ends the composing window", () => {
    const { rendered, hold } = harness();
    hold.typed();
    hold.maybeHold(5, reply(5));
    hold.flush(); // the send
    expect(rendered).toEqual([reply(5)]);
    vi.advanceTimersByTime(1000);
    expect(hold.maybeHold(6, reply(6))).toBe(false); // next reply is not parked
  });

  it("typing after a send re-establishes composing", () => {
    const { hold } = harness();
    hold.typed();
    hold.flush(); // the send
    vi.advanceTimersByTime(1000);
    hold.typed(); // a fresh draft begins
    expect(hold.maybeHold(7, reply(7))).toBe(true);
  });
});

describe("reset — a new shell drops parked frames unrendered", () => {
  it("reset clears the hold without rendering (history replays the reply)", () => {
    const { rendered, hold } = harness();
    hold.typed();
    hold.maybeHold(5, reply(5));
    hold.reset();
    expect(hold.holding()).toBe(false);
    vi.advanceTimersByTime(QUIET_MS * 2);
    expect(rendered).toEqual([]); // no stray timer fires into the new session
  });
});
