// Pins for the TEMP hold diagnostic (src/hold.ts, bottom block): the state
// machine's trail must name every decision (parks, clock resets, and releases
// with their exact reason) because the device session is reconstructed from
// this trail alone. Pure recorder assertions; the DOM observers and the POST
// are gated off outside the real shell, so none of that runs here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUIET_MS, createReplyHold, holdDiagEvents, holdDiagReset } from "../src/hold";

interface Frame {
  seq: number;
}

function harness() {
  const rendered: Frame[] = [];
  const hold = createReplyHold<Frame>((f) => rendered.push(f));
  return { rendered, hold };
}

const names = (): string[] => holdDiagEvents().map((e) => e.ev);
const last = (ev: string) => [...holdDiagEvents()].reverse().find((e) => e.ev === ev);

beforeEach(() => {
  vi.useFakeTimers();
  holdDiagReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("hold diagnostic trail", () => {
  it("records park, clock resets, and a quiet release with its reason", () => {
    const { hold } = harness();
    hold.typed();
    hold.maybeHold(5, { seq: 5 });
    vi.advanceTimersByTime(2000);
    hold.typed(); // clock reset while holding
    vi.advanceTimersByTime(QUIET_MS);
    expect(names()).toEqual(["typed", "held", "typed", "release", "render"]);
    expect(last("held")?.d).toMatchObject({ seq: 5, held: 1 });
    expect(last("typed")?.d).toMatchObject({ held: 1, sinceKey: 2000 });
    expect(last("release")?.d).toMatchObject({ reason: "quiet", held: 1 });
    expect(last("render")?.d).toMatchObject({ seq: 5, route: "hold-release" });
  });

  it("names a send release 'send' and a bypassed frame 'pass'", () => {
    const { hold } = harness();
    hold.typed();
    hold.maybeHold(5, { seq: 5 });
    hold.flush(); // the send path
    expect(last("release")?.d).toMatchObject({ reason: "send", held: 1 });
    hold.maybeHold(6, { seq: 6 }); // clock zeroed by flush: renders via the caller
    expect(last("pass")?.d).toMatchObject({ seq: 6, sinceKey: -1 });
  });

  it("records reset with the count of frames it dropped unrendered", () => {
    const { hold } = harness();
    hold.typed();
    hold.maybeHold(5, { seq: 5 });
    hold.maybeHold(6, { seq: 6 });
    hold.reset();
    expect(last("reset")?.d).toMatchObject({ dropped: 2 });
  });

  it("keeps only the newest events once the ring cap is reached", () => {
    const { hold } = harness();
    for (let i = 0; i < 700; i++) hold.typed();
    expect(holdDiagEvents().length).toBe(600);
    expect(holdDiagEvents()[0].d).toMatchObject({ sinceKey: 0 }); // oldest survivors, not the first keys
  });

  it("changes nothing about hold behavior: held frames still release in order", () => {
    const { rendered, hold } = harness();
    hold.typed();
    hold.maybeHold(9, { seq: 9 });
    hold.maybeHold(5, { seq: 5 });
    vi.advanceTimersByTime(QUIET_MS);
    expect(rendered.map((f) => f.seq)).toEqual([5, 9]);
  });
});
