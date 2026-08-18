// First-paint gate for a fresh shell — the reveal half of the deterministic
// bottom landing.
//
// The boot replay is a stream: frames land across many tasks, the browser
// paints between them, and each tail append shifts everything above it. A
// frame straggling past the settle window is worse still — it renders as if
// live, entrance pop and glide included. So the shell builds the thread
// behind an opacity veil (.thread.booting) and this gate owns the two
// decisions the wiring must not improvise:
//
//   claimSettlePin() — whether THIS settle owns the boot pin (decode every
//     pending image, then one unconditional bottom pin). True exactly once
//     per shell, so reconnect settles can never yank a reader.
//   the reveal — the veil lifts only AFTER that pin lands (pinLanded), so
//     the first visible frame is already the settled bottom state; or
//     immediately when the socket dies first (socketClosed): with no server
//     there is no replay, and restored-outbox bubbles must not sit behind a
//     veil that would otherwise never lift.
//
// Same shape as hold.ts/downbtn.ts: a pure latch (unit-tested, no DOM)
// beneath a thin wiring in main.ts that routes the one reveal callback at
// the thread's .booting class. reset() re-arms both halves when renderChat
// rebuilds the shell — the fresh markup raises the veil again itself.

export interface BootGate {
  /** fresh shell rebuilt: settle pin re-armed, reveal re-armed */
  reset(): void;
  /** true exactly once per shell: the caller owns the decode-then-pin */
  claimSettlePin(): boolean;
  /** the boot pin has landed: lift the veil */
  pinLanded(): void;
  /** the socket died (possibly before any settle): lift the veil regardless */
  socketClosed(): void;
  revealed(): boolean;
}

export function createBootGate(reveal: () => void): BootGate {
  let pinClaimed = false;
  let shown = false;

  // edge-triggered like the chevron: the callback fires once per shell,
  // however many paths race to lift the veil
  function lift(): void {
    if (shown) return;
    shown = true;
    reveal();
  }

  return {
    reset(): void {
      pinClaimed = false;
      shown = false;
    },
    claimSettlePin(): boolean {
      if (pinClaimed) return false;
      pinClaimed = true;
      return true;
    },
    pinLanded: lift,
    socketClosed: lift,
    revealed: () => shown,
  };
}
