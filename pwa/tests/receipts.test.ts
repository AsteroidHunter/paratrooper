// Pins for the receipt derivation (src/receipts.ts) — the stored thread is the
// only input, so every Messages state is encoded as plain rows. The bug that
// motivated it: labels drawn from live signals evaporated on every reopen.
//
// The second bug, and the block at the bottom of this file: the anchor and the
// state are different questions. The label hangs under the newest sent message,
// which is a question about the order on screen (compose time); whether it has
// been read is a question about what the agent picked up (the numbering). A
// retried message parts them, holding the highest number in the thread while
// keeping the compose time that puts it back where it was written.
import { describe, expect, it } from "vitest";
import { receiptFor, type ReceiptEvent } from "../src/receipts";

// a thread whose rows were composed in numbering order, the ordinary case: the
// ts is derived from the seq so the two orders agree and only the seq matters
const iso = (n: number): string => new Date(Date.UTC(2026, 8, 7, 0, 0, n)).toISOString();
const user = (seq: number): ReceiptEvent => ({ seq, ts: iso(seq), role: "user" });
const job = (seq: number): ReceiptEvent => ({ seq, ts: iso(seq), role: "system", kind: "job" });
const working = (seq: number): ReceiptEvent =>
  ({ seq, ts: iso(seq), role: "agent", kind: "working" });
const done = (seq: number): ReceiptEvent => ({ seq, ts: iso(seq), role: "agent", kind: "done" });
/** a user message numbered `seq` but composed at `at` — a retried send */
const retried = (seq: number, at: number): ReceiptEvent =>
  ({ seq, ts: iso(at), role: "user" });

describe("receiptFor", () => {
  it("no sent messages -> no receipt", () => {
    expect(receiptFor([])).toBeNull();
    expect(receiptFor([done(1)])).toBeNull();
  });

  it("persisted but unqueued -> Delivered", () => {
    expect(receiptFor([user(1)])).toEqual({ seq: 1, state: "Delivered" });
  });

  it("queued is not read: job marker alone stays Delivered", () => {
    expect(receiptFor([user(1), job(2)])).toEqual({ seq: 1, state: "Delivered" });
  });

  it("picked up -> Read", () => {
    expect(receiptFor([user(1), job(2), working(3)])).toEqual({ seq: 1, state: "Read" });
  });

  it("message sent between enqueue and pickup belongs to the NEXT batch: Delivered", () => {
    // u1..u3 batched (job@4), u4 lands before the pickup row (working@6) —
    // the agent taking up job@4 has not seen u4
    const events = [user(1), user(2), user(3), job(4), user(5), working(6)];
    expect(receiptFor(events)).toEqual({ seq: 5, state: "Delivered" });
  });

  it("second batch picked up -> newest message reads Read", () => {
    const events = [user(1), job(2), working(3), done(4), user(5), job(6), working(7)];
    expect(receiptFor(events)).toEqual({ seq: 5, state: "Read" });
  });

  it("messages buffered during a running job flip only when THEIR job is picked up", () => {
    const running = [user(1), job(2), working(3), user(4), user(5)];
    expect(receiptFor(running)).toEqual({ seq: 5, state: "Delivered" });
    const next = [...running, done(6), job(7), working(8)];
    expect(receiptFor(next)).toEqual({ seq: 5, state: "Read" });
  });

  it("order-independent: history pages insert out of seq order", () => {
    const shuffled = [working(7), user(5), job(6), done(4), job(2), user(1), working(3)];
    expect(receiptFor(shuffled)).toEqual({ seq: 5, state: "Read" });
  });

  it("rows without seq (ephemeral frames) are ignored", () => {
    expect(receiptFor([user(1), { role: "agent", kind: "working" }]))
      .toEqual({ seq: 1, state: "Delivered" });
  });

  it("no compose times at all: the numbering decides, as it always did", () => {
    const bare = [{ seq: 1, role: "user" }, { seq: 2, role: "user" }];
    expect(receiptFor(bare)).toEqual({ seq: 2, state: "Delivered" });
  });
});

describe("the anchor is the last message on screen, not the highest number", () => {
  it("a retried message does not steal the label from the bubble below it", () => {
    // A composed at 1, failed, retried and stored as seq 3; B composed at 2 and
    // stored as seq 2. B is the bottom bubble, so B carries the label.
    const events = [user(2), retried(3, 1)];
    expect(receiptFor(events)).toEqual({ seq: 2, state: "Delivered" });
  });

  it("the state is read for the anchor's own message, not for the newest one", () => {
    // the retried A (seq 4) is inside the picked-up batch; B (seq 5) is not
    const events = [
      retried(4, 1), job(2), working(3), user(5),
    ];
    // job@2 has working@3 after it, so the watermark is 2: seq 4 and 5 are both
    // above it and both Delivered. The anchor is B, composed last.
    expect(receiptFor(events)).toEqual({ seq: 5, state: "Delivered" });
  });

  it("an anchor below the watermark reads Read even with a newer number around", () => {
    // B (seq 2, composed at 2) is below the watermark; the retried A holds seq 6
    const events = [retried(6, 1), user(2), job(3), working(4)];
    expect(receiptFor(events)).toEqual({ seq: 2, state: "Read" });
  });

  it("two messages composed in the same instant: the number settles the anchor", () => {
    const events = [
      { seq: 4, ts: iso(1), role: "user" },
      { seq: 7, ts: iso(1), role: "user" },
    ];
    expect(receiptFor(events)).toEqual({ seq: 7, state: "Delivered" });
  });

  it("an unparseable stamp does not win the anchor by accident", () => {
    const events = [{ seq: 1, ts: "not a date", role: "user" }, user(2)];
    expect(receiptFor(events)).toEqual({ seq: 2, state: "Delivered" });
  });
});
