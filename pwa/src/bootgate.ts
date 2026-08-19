// Boot-replay ledger — the honest half of the deterministic bottom landing.
//
// A fresh socket's first delivery is the connect-time backlog: every event
// that already existed when the socket opened, replayed in seq order. Those
// frames are history — they must never play entrance animations or animated
// scrolls, however late the network hands them over. The old 400ms quiet
// timer only guessed at that boundary, and a replay frame straggling past
// the guess rendered as if live, entrance pop and glide included. The marker
// here does not guess: the newest seq that existed at connect (learned by
// main.ts from the same history endpoint the client already pages with) is
// the backlog's ceiling — at or below it is replay, above it is genuinely
// new. Until the probe answers, every frame counts as replay: stillness is
// the safe default.
//
// Same shape as hold.ts/downbtn.ts: a pure ledger (unit-tested, no DOM)
// beneath a thin wiring in main.ts — connect() re-arms it per socket, the
// probe feeds tailKnown, and ws.onmessage asks isReplay per frame.
//
//   claimSettlePin() — whether THIS settle owns the boot pin (decode every
//     pending image, then one unconditional bottom pin). True exactly once
//     per shell, so reconnect settles can never yank a reader.
//   caughtUp(applied) — latches true once per socket, the moment the applied
//     cursor covers the whole backlog: animations may come on.

export interface BootGate {
  /** fresh shell rebuilt: the settle pin and the replay ledger both re-arm */
  reset(): void;
  /** a socket (re)opened: a new backlog is inbound, everything is replay again */
  reconnect(): void;
  /** true exactly once per shell: the caller owns the decode-then-pin */
  claimSettlePin(): boolean;
  /** the tail probe answered: the newest seq that existed at connect (0 = none) */
  tailKnown(tail: number): void;
  /** the probe has not answered for this socket yet (ceiling still unknown) —
      the commit-fallback timer closes the ledger only while this holds, so a
      timeout can never lower a ceiling the probe already established */
  tailPending(): boolean;
  /** part of the connect-time backlog — never animate it, however late it lands */
  isReplay(seq: number): boolean;
  /** latches true ONCE per socket when the backlog is fully applied */
  caughtUp(applied: number): boolean;
  settled(): boolean;
}

export function createBootGate(): BootGate {
  let pinClaimed = false;
  let tail = Infinity; // backlog ceiling; Infinity = probe pending (all replay)
  let settled = false;

  function rearm(): void {
    tail = Infinity;
    settled = false;
  }

  return {
    reset(): void {
      pinClaimed = false;
      rearm();
    },
    reconnect: rearm,
    claimSettlePin(): boolean {
      if (pinClaimed) return false;
      pinClaimed = true;
      return true;
    },
    tailKnown(t: number): void {
      tail = t;
    },
    tailPending: () => tail === Infinity,
    isReplay: (seq: number) => seq <= tail,
    caughtUp(applied: number): boolean {
      if (settled || applied < tail) return false;
      settled = true;
      return true;
    },
    settled: () => settled,
  };
}
