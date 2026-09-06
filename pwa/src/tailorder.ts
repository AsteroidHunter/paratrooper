// Where a row stands in the thread, and where a reload would put it.
//
// The thread has two bands. Above: the messages the server has accepted, in
// its own numbering. Below: the ones that never got out, still wearing the red
// mark, in the order they came to rest. A reload rebuilds exactly that shape
// (the cold-open snapshot and the history page both sort by sequence, and the
// durable outbox is replayed at the tail), so the live screen has to hold the
// same shape at every moment or the two disagree the next time he opens the
// app.
//
// Two of the three places that reorder the thread already applied it: a frame
// landing while a bubble is failed slots in above the failure, and a prior
// session's unsent rows are rebuilt at the tail. The third, a user send, did
// not: the new bubble was appended past the failed one, which left a failure
// standing above a message numbered before it. Try Again then stored the
// re-sent message as a brand new one, numbered after everything, and the
// bubble adopted that number without moving, so the screen said one order and
// a reload said another, and the receipt jumped up under the wrong bubble.
//
// Pure and DOM-free on purpose. main.ts reads the two facts off each wrapper
// and hands them over, so the same rule can be driven frame by frame in a
// harness and pinned in tests without booting a shell.

/** the two facts a row's place is decided on */
export interface Standing {
  /** the number the server gave it, or null while it has never been accepted */
  seq: number | null;
  /** still unsent: the failure mark is up (this session's, or a restored one) */
  failed: boolean;
}

/**
 * The order a reload rebuilds: accepted rows by number, then the unsent ones
 * in the order they already stand in. Rows still in the air are left out, for
 * the plain reason that a reload cannot show a message the server has not
 * answered for yet.
 */
export function reloadOrder<T extends Standing>(rows: readonly T[]): T[] {
  const sent = rows.filter((r) => !r.failed && r.seq !== null);
  sent.sort((a, b) => (a.seq as number) - (b.seq as number));
  return [...sent, ...rows.filter((r) => r.failed)];
}

/** true when the rows on screen already stand in the order a reload rebuilds */
export function inReloadOrder(rows: readonly Standing[]): boolean {
  const shown = rows.filter((r) => r.failed || r.seq !== null);
  const want = reloadOrder(rows);
  return shown.length === want.length && shown.every((r, i) => r === want[i]);
}

/**
 * The thread right after a user send: the new bubble takes the tail of the
 * accepted band and every still-unsent row drops below it, keeping the
 * arrangement they already held. This is the tail rule the send was missing.
 */
export function afterSend<T extends Standing>(rows: readonly T[], sent: T): T[] {
  return [...rows.filter((r) => !r.failed), sent, ...rows.filter((r) => r.failed)];
}

/**
 * The row `rows[self]` must sit directly above, or null when it belongs at the
 * very end. Three standings, three answers:
 *
 *   accepted   seat by number: above every larger number and above the whole
 *              unsent band. On the common retry, with nothing sent since the
 *              failure, that is the place the bubble already stands in, so the
 *              caller moves nothing and the retry is motionless.
 *   in the air a send seated it a moment ago and only the answer can move it:
 *              it stays exactly where it is.
 *   unsent     below every accepted row, keeping its place among the other
 *              unsent ones. The scan only ever looks downward, so an unsent
 *              row can sink past a message that landed under it and can never
 *              climb over one.
 */
export function seatBefore<T extends Standing>(rows: readonly T[], self: number): T | null {
  const me = rows[self];
  if (!me) return null;
  if (me.failed) {
    for (let i = self + 1; i < rows.length; i++) if (rows[i].failed) return rows[i];
    return null;
  }
  if (me.seq === null) return rows[self + 1] ?? null; // still out: nothing to seat it by
  for (let i = 0; i < rows.length; i++) {
    if (i === self) continue;
    const r = rows[i];
    if (r.failed) return r; // the unsent band starts here, and it is below us
    if (r.seq !== null && r.seq > me.seq) return r;
  }
  return null;
}
