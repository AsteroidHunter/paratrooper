// Pins for the take-back (one reply per burst, always): a reply still held
// unseen when the owner sends must vanish for good — the rerun's next reply
// answers everything. Two halves here: the hold machine's take()/drop() (pure,
// fake timers, same harness as hold.test.ts) and source pins for the main.ts
// wiring (main.ts boots a real shell at import and cannot load under node, so
// the send-path ordering, the failure re-render, and the retract frame handler
// are held the way flight.test.ts holds the flight).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUIET_MS, createReplyHold, holdDiagEvents, holdDiagReset } from "../src/hold";

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
const last = (ev: string) => [...holdDiagEvents()].reverse().find((e) => e.ev === ev);

beforeEach(() => {
  vi.useFakeTimers();
  holdDiagReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("take — the send hands held replies over unrendered", () => {
  it("returns the parked frames in seq order and renders nothing", () => {
    const { rendered, hold } = harness();
    hold.typed();
    hold.maybeHold(9, reply(9, "second"));
    hold.maybeHold(5, reply(5, "first"));
    const taken = hold.take();
    expect(taken.map(([seq]) => seq)).toEqual([5, 9]);
    expect(rendered).toEqual([]); // nothing rendered — that is the whole point
    expect(hold.holding()).toBe(false);
  });

  it("ends composing exactly like flush: the next reply passes straight through", () => {
    const { hold } = harness();
    hold.typed(); // composing the message he is about to send
    hold.take(); // the send
    vi.advanceTimersByTime(2500); // agent answers fast
    expect(hold.maybeHold(6, reply(6))).toBe(false); // renders via the caller, unparked
  });

  it("empty take still ends composing (every send routes through it)", () => {
    const { hold } = harness();
    hold.typed();
    expect(hold.take()).toEqual([]);
    expect(hold.maybeHold(6, reply(6))).toBe(false);
  });

  it("no stray quiet timer fires after a take", () => {
    const { rendered, hold } = harness();
    hold.typed();
    hold.maybeHold(5, reply(5));
    hold.take();
    vi.advanceTimersByTime(QUIET_MS * 2);
    expect(rendered).toEqual([]);
  });

  it("records a release with reason take and the count", () => {
    const { hold } = harness();
    hold.typed();
    hold.maybeHold(5, reply(5));
    hold.take();
    expect(last("release")?.d).toMatchObject({ reason: "take", held: 1 });
  });
});

describe("drop — a server retract removes a parked frame", () => {
  it("drops the named seq; the quiet release renders only survivors", () => {
    const { rendered, hold } = harness();
    hold.typed();
    hold.maybeHold(5, reply(5));
    hold.maybeHold(6, reply(6));
    expect(hold.drop(5)).toBe(true);
    expect(last("drop")?.d).toMatchObject({ seq: 5, held: 1 });
    vi.advanceTimersByTime(QUIET_MS);
    expect(rendered.map((f) => f.seq)).toEqual([6]);
  });

  it("dropping the last parked frame disarms the timer entirely", () => {
    const { rendered, hold } = harness();
    hold.typed();
    hold.maybeHold(5, reply(5));
    expect(hold.drop(5)).toBe(true);
    expect(hold.holding()).toBe(false);
    vi.advanceTimersByTime(QUIET_MS * 2);
    expect(rendered).toEqual([]); // no release fires into an empty hold
  });

  it("an unknown seq is a no-op false (the clean-echo case)", () => {
    const { hold } = harness();
    hold.typed();
    hold.maybeHold(5, reply(5));
    expect(hold.drop(99)).toBe(false);
    expect(hold.holding()).toBe(true); // the parked frame is untouched
  });
});

// --- main.ts wiring pins (source-read, like flight.test.ts) -------------------

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/main.ts"),
  "utf8",
);

function fnBody(name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("\n}", start);
  return src.slice(start, end);
}

describe("send path wiring — held replies are taken, not rendered", () => {
  const body = fnBody("send");

  it("send takes (never flushes) and records the retract-sent seqs", () => {
    expect(body).toContain("replyHold.take()");
    expect(body).not.toContain("replyHold.flush()");
    expect(body).toContain('holdDiagRecord("retract-sent", { seqs: retractSeqs })');
  });

  it("the taken seqs ride transmit into the send body", () => {
    expect(body).toContain("transmit(w, text, files, retractSeqs)");
    expect(fnBody("transmit")).toContain("retract_seqs: retractSeqs");
  });

  it("failure (and only failure) renders the taken replies, above the failed bubble", () => {
    const gate = body.indexOf("failedSends.has(w)");
    expect(gate).toBeGreaterThan(-1);
    const after = body.slice(gate);
    const render = after.indexOf("applyEvent(frame)");
    const reappend = after.indexOf("threadEl().appendChild(w)");
    expect(render).toBeGreaterThan(-1);
    // the failed wrapper is re-appended AFTER the replies render, so the
    // replies sit above it — the order a reload rebuilds
    expect(reappend).toBeGreaterThan(render);
    expect(after).toContain('route: "send-fail"');
  });

  it("the failure re-render happens after transmit settles, not before", () => {
    expect(body.indexOf("await transmit(")).toBeLessThan(body.indexOf("failedSends.has(w)"));
  });
});

describe("retract frame wiring — the socket path removes every trace", () => {
  it("ws.onmessage routes kind retract to applyRetract before the seq gate", () => {
    const onmessage = src.indexOf("ws.onmessage");
    const retract = src.indexOf('m.kind === "retract"', onmessage);
    const seqGate = src.indexOf("if (!m.seq)", onmessage);
    expect(retract).toBeGreaterThan(onmessage);
    expect(retract).toBeLessThan(seqGate);
    expect(src.slice(retract, seqGate)).toContain("applyRetract(m.retract_seq)");
  });

  it("applyRetract clears hold, store, and bubble, and records what it found", () => {
    const body = fnBody("applyRetract");
    expect(body).toContain("replyHold.drop(seq)");
    expect(body).toContain("store.delete(seq)");
    expect(body).toContain("w.remove()");
    expect(body).toContain('holdDiagRecord("retract-applied"');
    expect(body).toMatch(/bubble:.*stored:.*held:/s);
  });
});
