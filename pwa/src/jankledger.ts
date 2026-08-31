// ===================== TEMP DIAGNOSTIC (remove after the scroll-jank session) =====================
// Activity ledger for the scroll-jank recorder. scrolljank.ts owns the session
// banner and the TO REMOVE list that names every stamped call site; this file
// is only the ledger half: a small ring of {name, start, end} spans stamped
// around the app's own heavier main-thread jobs, so a long frame caught
// mid-scroll can be matched to what the app itself was running inside it.
//
// Writers take a start from performance.now() at entry to the stamped job and
// call jankSpan at its exit. The ledger holds plain numbers, reads nothing
// from the document, and never allocates past the fixed ring, so a stamp is
// safe from any path, scroll-time paths included. A ring rather than a list
// because stamps only need to outlive their window long enough for the
// recorder to read overlaps at gesture close; the newest spans are always the
// ones a close cares about, and the ledger can never grow with session length.
//
// The ring is sized for its busiest writer: one history page landing stamps a
// "decorate" span per applied frame (twenty-five of them) around its one
// "drain-older", and the gesture that provoked it still needs its photo and
// settle spans alive at close, a second later. 128 holds two such landings
// with room, where the original 64 could have evicted the very spans the
// worst gaps were waiting to be named by.

export interface JankStamp {
  name: string;
  start: number; // performance.now() at entry to the stamped job
  end: number; // and at its exit; the span between is main-thread time spent
}

export const JANK_STAMP_KEEP = 128;

const stamps: JankStamp[] = [];
let cursor = 0; // once the ring is full, the next slot to overwrite (the oldest)

/** stamp one span of the app's own work; end defaults to now, taken at call time */
export function jankSpan(name: string, start: number, end: number = performance.now()): void {
  const s: JankStamp = { name, start, end };
  if (stamps.length < JANK_STAMP_KEEP) stamps.push(s);
  else stamps[cursor] = s;
  cursor = (cursor + 1) % JANK_STAMP_KEEP;
}

/** the ring as it stands, unordered; overlap math does not care about order */
export function jankStamps(): readonly JankStamp[] {
  return stamps;
}

/** tests only: a fresh ledger between cases */
export function jankLedgerReset(): void {
  stamps.length = 0;
  cursor = 0;
}
// =================== END TEMP DIAGNOSTIC (remove after the scroll-jank session) ===================
