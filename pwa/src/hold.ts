// Reply hold — the finished reply must not land under Akash's thumbs.
//
// When the agent's final reply (a keyed "done" frame) arrives while he is
// actively composing — ANY keystroke within the last QUIET_MS, the composer's
// text plays no role (space-mash and backspacing to empty are still typing) —
// its RENDER is parked here instead of shoving the thread mid-keystroke. It
// releases (through the caller's normal apply path, so ordering and
// idempotence rules hold unchanged) when QUIET_MS passes with no keystroke,
// or via flush() on send — BEFORE the outgoing bubble, so the live view shows
// the same reply-then-your-message order the store replays after a reload.
// flush() also ends composing: after a send he is by definition not typing,
// so a fast next reply renders immediately instead of riding the pre-send
// keystrokes' stale quiet window.
//
// Purely visual and purely live-view: the reply is already persisted
// server-side, so nothing is held across a reload — history simply shows it.
//
// Same shape as the shell/splash modules: a pure state machine (unit-tested,
// injectable clock, no DOM) beneath a one-line wiring in main.ts.

export const QUIET_MS = 7000;

export interface ReplyHold<T> {
  /** a composer keystroke happened (content irrelevant — any keypress counts) */
  typed(): void;
  /** park a frame if he's mid-composition; true = held, caller must not render */
  maybeHold(seq: number, frame: T): boolean;
  /** render everything held, in seq order, right now, and end composing (the send path) */
  flush(): void;
  holding(): boolean;
  /** new shell/session: drop parked frames unrendered (replay covers them) */
  reset(): void;
}

export function createReplyHold<T>(
  render: (frame: T) => void,
  quietMs: number = QUIET_MS,
  now: () => number = Date.now,
): ReplyHold<T> {
  let lastKeyAt = 0; // 0 = no keystroke since session start / last send
  const held = new Map<number, T>(); // keyed by seq: a reconnect re-delivery no-ops
  let timer: ReturnType<typeof setTimeout> | null = null;

  // "actively composing" is pure keystroke freshness: a keypress within the
  // last quietMs. What the composer CONTAINS is irrelevant — space-mash and a
  // backspaced-to-empty box are still typing ("any keypress counts as typing")
  const composing = (): boolean => lastKeyAt !== 0 && now() - lastKeyAt < quietMs;

  function disarm(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function arm(): void {
    disarm();
    // the window counts from the LAST keystroke, not from the frame's arrival
    timer = setTimeout(flush, Math.max(0, quietMs - (now() - lastKeyAt)));
  }

  function flush(): void {
    disarm();
    // the send path: after a send he is not composing, so zero the freshness
    // clock even when nothing is parked — otherwise the pre-send keystrokes
    // would wrongly park a fast reply for up to quietMs after the send
    lastKeyAt = 0;
    if (held.size === 0) return;
    const frames = [...held.entries()].sort(([a], [b]) => a - b).map(([, f]) => f);
    held.clear();
    for (const f of frames) render(f);
  }

  function typed(): void {
    lastKeyAt = now();
    if (held.size > 0) arm(); // still typing: keep deferring, a full quiet window again
  }

  function maybeHold(seq: number, frame: T): boolean {
    // while anything is already parked, later frames park too — releasing them
    // out of order would pop a newer bubble above a still-held older one
    if (held.size === 0 && !composing()) return false;
    held.set(seq, frame);
    if (!timer) arm();
    return true;
  }

  function reset(): void {
    disarm();
    held.clear();
    lastKeyAt = 0;
  }

  return { typed, maybeHold, flush, holding: () => held.size > 0, reset };
}
