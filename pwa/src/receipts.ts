// Delivery receipt derivation (Messages "Delivered"/"Read") — pure, no DOM.
//
// The receipt is a projection of the stored thread, never of live signals, so
// reopen/replay recompute exactly what was true. Two facts back it:
//   Delivered — the message has a seq: the server persisted it.
//   Read      — the agent picked up a job covering it. A job marker (system
//               row written at enqueue) covers every user message below it;
//               a working row (written at pickup) vouches that its job — and,
//               since jobs run one at a time in order, every earlier job —
//               was actually taken up, not just queued.
// Watermark = the newest job marker with any working row after it. A user
// message below the watermark is Read; at or above it, Delivered. A message
// sent between a job's enqueue and its pickup stays Delivered: it belongs to
// the NEXT batch, which the agent hasn't seen.
//
// THE ANCHOR AND THE STATE ARE TWO DIFFERENT QUESTIONS, and they used to be
// answered by one number. The label hangs under the newest sent message, and
// "newest" is a question about the ORDER ON SCREEN, which is compose time
// (sendorder.ts). Whether that message has been read is a question about what
// the agent picked up, which is the server's numbering. A retried message is
// where the two part company: Try Again stores a brand new row, so it holds the
// highest number in the thread while keeping the compose time that puts it back
// up where it was written. Anchoring on the highest number therefore dropped the
// label into the middle of the thread, under a bubble that was not the last one.
// The anchor below is the last sent message in compose order and the state is
// read for that message, so the label is per message and nothing migrates: a
// later delivered bubble carries its own mark under an earlier failure.

export interface ReceiptEvent {
  seq?: number;
  ts?: string; // ISO-8601 compose time: the order the thread is drawn in
  role?: string;
  kind?: string | null;
}

export interface Receipt {
  seq: number; // the last sent message in compose order — where the label anchors
  state: "Delivered" | "Read";
}

/** a frame's place on the thread's clock; an unstamped frame sorts first */
function at(e: ReceiptEvent): number {
  const ms = e.ts ? Date.parse(e.ts) : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/** later in the order the thread is drawn in: compose time, then the number */
function below(e: ReceiptEvent, anchor: ReceiptEvent): boolean {
  const ea = at(e);
  const aa = at(anchor);
  if (ea !== aa) return ea > aa;
  return (e.seq as number) > (anchor.seq as number);
}

// order-independent (the scan keeps the best answer, never the last one): the
// store yields insertion order, which after history paging is not seq order
export function receiptFor(events: Iterable<ReceiptEvent>): Receipt | null {
  let anchor: ReceiptEvent | null = null;
  let lastWorking = 0;
  const jobs: number[] = [];
  for (const e of events) {
    if (!e.seq) continue;
    if (e.role === "user" && (anchor === null || below(e, anchor))) anchor = e;
    if (e.kind === "working" && e.seq > lastWorking) lastWorking = e.seq;
    if (e.kind === "job") jobs.push(e.seq);
  }
  if (!anchor) return null;
  let watermark = 0;
  for (const j of jobs) if (j < lastWorking && j > watermark) watermark = j;
  const seq = anchor.seq as number;
  return { seq, state: seq < watermark ? "Read" : "Delivered" };
}
