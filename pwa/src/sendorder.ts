// Where a row stands in the thread: strict order by the moment it was composed.
//
// Messages, Signal and Telegram all order a conversation by a key fixed when
// the send was pressed, so a message whose send failed keeps its slot and
// everything sent afterwards lands BELOW it. A device photo of a Messages
// thread shows failed and delivered bubbles interleaved in send order, never
// grouped. This app used to do the opposite: the 0.3.119 tail rule pushed every
// failed bubble to the end of the thread on each later send, which is the new
// message "flying above the not delivered ones" Akash reported off his phone.
// This module is the replacement rule, and the tail rule is gone with it.
//
// The key is (at, seq, ord):
//
//   at   the compose time in ms, stamped by the phone the instant the bubble is
//        made, carried on the wire as ``sent_at`` and stored by the server as
//        the message's own ts. A failure never touches it and Try Again never
//        re-stamps it, so a retried message cannot move: it resends in place.
//   seq  the server's number. Only a tiebreak between two rows composed inside
//        the same millisecond, with an un-numbered row sorting after a numbered
//        one, which is the order a reload rebuilds them in.
//   ord  a per-row ordinal handed out in creation order, the last resort that
//        makes the sort total and stable. Two numbered rows never reach it;
//        two unsent rows from the same millisecond would.
//
// A reload rebuilds exactly this order: the history page and the cold-open
// snapshot come back sorted by (ts, seq), and the durable outbox is replayed by
// (ts, id) so its rows are created in the same order every time. The live
// screen therefore holds the reload's shape at every moment, which is what
// inReloadOrder states and what the sequences in the tests check after every
// single step.
//
// Pure and DOM-free on purpose. main.ts reads the facts off each wrapper and
// hands them over, so the same rule can be driven frame by frame in a harness
// and pinned in tests without booting a shell.

/** the facts a row's place is decided on */
export interface Standing {
  /** compose time in ms: when the send was pressed, never re-stamped */
  at: number;
  /** the number the server gave it, or null while it has never been accepted */
  seq: number | null;
  /** creation ordinal, breaking a tie two rows of the same ms and seq reach */
  ord: number;
  /** still unsent: the failure mark is up (this session's, or a restored one) */
  failed: boolean;
}

/** un-numbered rows sort after numbered ones composed in the same millisecond */
const UNNUMBERED = Number.MAX_SAFE_INTEGER;

/** the total order: compose time, then the server's number, then creation */
export function compare(a: Standing, b: Standing): number {
  if (a.at !== b.at) return a.at - b.at;
  const as = a.seq ?? UNNUMBERED;
  const bs = b.seq ?? UNNUMBERED;
  if (as !== bs) return as - bs;
  return a.ord - b.ord;
}

/**
 * The order a reload rebuilds: every row that survives a reload, by the key
 * above. A row still in the air is left out, for the plain reason that a reload
 * cannot show a message the server has not answered for and the outbox has not
 * been told to keep. A failed row does survive — that is what the outbox is for.
 */
export function reloadOrder<T extends Standing>(rows: readonly T[]): T[] {
  return rows.filter((r) => r.seq !== null || r.failed).sort(compare);
}

/** true when the rows on screen already stand in the order a reload rebuilds */
export function inReloadOrder(rows: readonly Standing[]): boolean {
  const shown = rows.filter((r) => r.seq !== null || r.failed);
  const want = reloadOrder(rows);
  return shown.length === want.length && shown.every((r, i) => r === want[i]);
}

/**
 * The row `rows[self]` must sit directly above, or null when it belongs at the
 * very end: the first row that sorts after it. Every other row is already in
 * order (the invariant above holds after every step), so inserting ahead of
 * that one puts this row in its place and leaves the rest untouched.
 *
 * There is no case analysis left. A failure is not a standing any more, only a
 * mark on a row whose place was fixed when it was composed, so the answer for
 * an accepted row, a row in the air and an unsent row is the one comparison.
 */
export function seatBefore<T extends Standing>(rows: readonly T[], self: number): T | null {
  const me = rows[self];
  if (!me) return null;
  for (let i = 0; i < rows.length; i++) {
    if (i !== self && compare(rows[i], me) > 0) return rows[i];
  }
  return null;
}
