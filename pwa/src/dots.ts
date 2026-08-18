// Typing-dots placement — the dots ride the tail of the content, never bury it.
//
// The device bug: a message sent while the dots showed landed BELOW them —
// showTyping() appends #typing to the thread's end, and both localWrapper()
// (optimistic sends) and applyEvent()'s tail branch append newer content to
// the absolute end, past the dots. The fix is structural and instant: right
// after a tail append, an existing #typing moves back behind the appended
// wrapper in the same frame — appendChild/insertBefore RELOCATE a live node,
// no transition or entrance animation is involved (the dots carry only their
// looping blink, and .typing has no entrance rule to replay).
//
// Order rule preserved from applyEvent: keyed tail appends slot above
// .evt.restored wrappers (a prior session's unsent sends stay pinned at the
// very tail), so the resting order from the top is: messages, dots, restored
// failures. moveTypingAfter anchors to the wrapper that just landed, so it
// composes with either append site without re-deriving that rule.

/** initial placement for a fresh #typing: above restored failures, else the end */
export function placeTyping(thread: HTMLElement, dots: HTMLElement): void {
  const restored = thread.querySelector<HTMLElement>(".evt.restored");
  if (restored) {
    if (dots.nextElementSibling !== restored) thread.insertBefore(dots, restored);
  } else if (thread.lastElementChild !== dots) {
    thread.appendChild(dots);
  }
}

/** a wrapper just landed at the tail: an existing #typing moves directly after it */
export function moveTypingAfter(thread: HTMLElement, content: HTMLElement): void {
  const dots = thread.querySelector<HTMLElement>("#typing");
  if (!dots || content.nextElementSibling === dots) return;
  thread.insertBefore(dots, content.nextElementSibling);
}
