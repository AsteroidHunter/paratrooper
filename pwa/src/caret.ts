// Caret activity gate — the decision half of "caret moves count as composing".
//
// The reply hold's clock is fed by composer keystrokes (the input listener in
// main.ts calling replyHold.typed()), but repositioning the caret or selecting
// text fires no input event — a reply could land mid-thumb-drag exactly like
// mid-keystroke. selectionchange is the signal, and it fires DOCUMENT-wide
// (any selection anywhere, including programmatic ones), so two gates apply:
//   - only events while the compose textarea itself holds focus count;
//   - not within the grace window after a PROGRAMMATIC composer write — the
//     send path clears the box (which moves the caret and queues its own
//     selectionchange) right after flush() deliberately zeroed the composing
//     clock, and letting that echo re-arm the clock would park a fast reply
//     for the full quiet window after every send.
// Pure beneath the one-line main.ts wiring, same shape as viewport.ts.

export const COMPOSER_WRITE_GRACE_MS = 200;

export function caretCountsAsComposing(
  activeElementId: string | null | undefined,
  msSinceComposerWrite: number = Infinity,
): boolean {
  return activeElementId === "text" && msSinceComposerWrite >= COMPOSER_WRITE_GRACE_MS;
}
