// Frame-shape rules for the client event store (main.ts): the duplicate-delivery
// repair below, and the send ACK's frame guard at the bottom. Both are pure and
// look at nothing but a frame's fields, in the bootgate.ts mold.
//
// --- the duplicate-delivery repair -------------------------------------------
//
// Apply is idempotent by seq, so a re-delivered frame normally vanishes. But
// the server heals photo rows on read: a frame stored before attachment_dims
// and attachment_blurhashes shipped (an old cache era, or the frame the send
// path synthesizes when the skew guard below turns an ACK down) lacks them,
// and the healed re-delivery is the one copy that carries them. Dropping it
// would leave the stored frame, and through it the cold-open cache, squishing
// photos forever. The rule: a
// re-delivery carrying a meaningful field the stored frame lacks yields a
// merged frame to store; anything identical or poorer yields null and is
// dropped exactly as before.
//
// main.ts wires it into applyEvent (the one path every keyed frame takes), the
// skew fallback's read-back, and the reconcile page.

// the fields the pre-heal eras lack; gaining any one makes a re-delivery
// richer. A null ENTRY inside them is the deliberate undecodable-preview
// marker, so only a missing field counts as poorer, never a null entry.
const GAIN_FIELDS = ["attachment_dims", "attachment_blurhashes"] as const;

export interface EnrichableFrame {
  attachment_dims?: unknown;
  attachment_blurhashes?: unknown;
}

// the merged frame to store when next is richer, null when it is not. The
// merge keeps every stored field and lets next's values win, so a frame
// gaining dims never loses a blurhash list the stored copy already had.
export function enrichFrame<F extends EnrichableFrame>(cur: F, next: F): F | null {
  const gains = GAIN_FIELDS.some((f) => next[f] != null && cur[f] == null);
  if (!gains) return null;
  return { ...cur, ...next };
}

// --- the send ACK's frame guard ----------------------------------------------
//
// /api/send answers with the finished frame beside its status, the same one
// history returns for that seq, so the send path stores the server's own row
// instead of inventing one. But a client held in the service worker's cache can
// keep running against a server too old to send that frame, so the answer only
// counts as a frame when it carries the fields that identify one: a role and a
// ts. Anything less yields null and the caller falls back to its older
// behaviour, which is the whole point: a frameless answer must never be stored.

export interface AckShape {
  status?: unknown; // the transport-level ACK field; no frame ever carries it
  role?: unknown;
  ts?: unknown;
}

// the frame to store, minus the status that is not part of it, or null when
// the answer is a bare ACK from an older server.
export function ackFrame<F extends AckShape>(ack: F): Omit<F, "status"> | null {
  if (typeof ack.role !== "string" || !ack.role) return null;
  if (typeof ack.ts !== "string" || !ack.ts) return null;
  // drop the status, so what lands in the store matches history exactly
  const { status, ...frame } = ack;
  return frame;
}
