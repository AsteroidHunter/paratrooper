// Pins for caret-counts-as-composing (src/caret.ts): repositioning the caret
// or selecting text inside the compose box must reset the reply hold's quiet
// window exactly like a keypress — and selectionchange fires document-wide,
// so only events while the composer holds focus may feed the clock. The
// harness mirrors the main.ts wiring (gate, then a "caret" trail record, then
// typed()) against the real hold state machine.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPOSER_WRITE_GRACE_MS, caretCountsAsComposing } from "../src/caret";
import { QUIET_MS, createReplyHold, holdDiagEvents, holdDiagRecord, holdDiagReset } from "../src/hold";

interface Frame {
  seq: number;
}

function harness() {
  const rendered: Frame[] = [];
  const hold = createReplyHold<Frame>((f) => rendered.push(f));
  // the main.ts selectionchange listener, with the focused element injectable
  const selectionchange = (activeElementId: string | undefined): void => {
    if (!caretCountsAsComposing(activeElementId)) return;
    holdDiagRecord("caret");
    hold.typed();
  };
  return { rendered, hold, selectionchange };
}

beforeEach(() => {
  vi.useFakeTimers();
  holdDiagReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("caret activity feeds the composing clock", () => {
  it("a focused selectionchange resets the quiet window like a keypress", () => {
    const { rendered, hold, selectionchange } = harness();
    hold.typed();
    vi.advanceTimersByTime(6000);
    selectionchange("text"); // caret drag 6s in: the window restarts whole
    vi.advanceTimersByTime(6000); // 12s since the key, 6s since the caret move
    expect(hold.maybeHold(5, { seq: 5 })).toBe(true); // still composing: parked
    expect(rendered).toEqual([]);
    vi.advanceTimersByTime(QUIET_MS); // quiet at last: the reply renders
    expect(rendered.map((f) => f.seq)).toEqual([5]);
  });

  it("an unfocused selectionchange does not touch the clock", () => {
    const { hold, selectionchange } = harness();
    hold.typed();
    vi.advanceTimersByTime(QUIET_MS + 1000); // the keystroke window has lapsed
    selectionchange(undefined); // selection elsewhere (body, token gate, ...)
    selectionchange("token-input");
    // not composing: the frame passes to the caller instead of parking
    expect(hold.maybeHold(5, { seq: 5 })).toBe(false);
  });

  it("records 'caret' for focused activity only, distinct from key-driven 'typed'", () => {
    const { selectionchange } = harness();
    selectionchange(undefined);
    expect(holdDiagEvents().map((e) => e.ev)).toEqual([]);
    selectionchange("text");
    expect(holdDiagEvents().map((e) => e.ev)).toEqual(["caret", "typed"]);
  });

  it("the send-clear's own selectionchange echo does not re-arm composing", () => {
    // send() zeroes the clock via flush, then clears the box — the clear moves
    // the caret and queues a selectionchange while focus is still held. Inside
    // the write grace window it must not count, or every send would park the
    // next reply for the full quiet window.
    expect(caretCountsAsComposing("text", 16)).toBe(false);
    expect(caretCountsAsComposing("text", COMPOSER_WRITE_GRACE_MS)).toBe(true);
    expect(caretCountsAsComposing("text")).toBe(true); // no recent write at all
  });
});
