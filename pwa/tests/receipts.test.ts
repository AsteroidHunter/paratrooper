// Pins for the receipt derivation (src/receipts.ts) — the stored thread is the
// only input, so every iMessage state is encoded as plain rows. The bug that
// motivated this: labels drawn from live signals evaporated on every reopen.
import { describe, expect, it } from "vitest";
import { receiptFor, type ReceiptEvent } from "../src/receipts";

const user = (seq: number): ReceiptEvent => ({ seq, role: "user" });
const job = (seq: number): ReceiptEvent => ({ seq, role: "system", kind: "job" });
const working = (seq: number): ReceiptEvent => ({ seq, role: "agent", kind: "working" });
const done = (seq: number): ReceiptEvent => ({ seq, role: "agent", kind: "done" });

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
});
