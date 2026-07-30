// Delivery receipt derivation (iMessage "Delivered"/"Read") — pure, no DOM.
//
// The receipt is a projection of the stored thread, never of live signals, so
// reopen/replay recompute exactly what was true. Two facts back it:
//   Delivered — the message has a seq: the server persisted it.
//   Read      — the agent picked up a job covering it. A job marker (system
//               row written at enqueue) covers every user message below it;
//               a working row (written at pickup) vouches that its job — and,
//               since jobs run one at a time in order, every earlier job —
//               was actually taken up, not just queued.
// Watermark = the newest job marker with any working row after it. User
// messages below the watermark are Read; at/above it, Delivered. A message
// sent between a job's enqueue and its pickup stays Delivered: it belongs to
// the NEXT batch, which the agent hasn't seen.

export interface ReceiptEvent {
  seq?: number;
  role?: string;
  kind?: string | null;
}

export interface Receipt {
  seq: number; // the newest user message — where the label anchors
  state: "Delivered" | "Read";
}

// order-independent (max scans): the store yields insertion order, which
// after history paging is not seq order
export function receiptFor(events: Iterable<ReceiptEvent>): Receipt | null {
  let lastUser = 0;
  let lastWorking = 0;
  const jobs: number[] = [];
  for (const e of events) {
    if (!e.seq) continue;
    if (e.role === "user" && e.seq > lastUser) lastUser = e.seq;
    if (e.kind === "working" && e.seq > lastWorking) lastWorking = e.seq;
    if (e.kind === "job") jobs.push(e.seq);
  }
  if (!lastUser) return null;
  let watermark = 0;
  for (const j of jobs) if (j < lastWorking && j > watermark) watermark = j;
  return { seq: lastUser, state: lastUser < watermark ? "Read" : "Delivered" };
}
