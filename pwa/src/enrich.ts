// Duplicate-delivery repair rule for the client event store (main.ts).
//
// Apply is idempotent by seq, so a re-delivered frame normally vanishes. But
// the server heals photo rows on read: a frame stored before attachment_dims
// and attachment_blurhashes shipped (an old cache era, or the synthesized ACK
// frame the send path writes) lacks them, and the healed re-delivery is the
// one copy that carries them. Dropping it would leave the stored frame, and
// through it the cold-open cache, squishing photos forever. The rule: a
// re-delivery carrying a meaningful field the stored frame lacks yields a
// merged frame to store; anything identical or poorer yields null and is
// dropped exactly as before.
//
// Pure and frame-shape-only, in the bootgate.ts mold: main.ts wires it into
// applyEvent (the one path every keyed frame takes), the send ACK read-back,
// and the reconcile page.

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
