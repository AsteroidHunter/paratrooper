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
// The dots are not an event and have no compose time: they say the agent is
// typing NOW, which is later than anything already written, so they belong at
// the very end of the thread and nothing sorts under them. They used to be
// held above the .evt.failed band, because a failure was pinned to the tail and
// burying the dots under it would have hidden them; with the thread now in
// strict compose order (sendorder.ts) there is no band to stay above, and a
// failed bubble sits wherever it was written like any other row.
// moveTypingAfter anchors to the wrapper that just landed, so it composes with
// either append site without re-deriving anything.

/** initial placement for a fresh #typing: the end of the thread */
export function placeTyping(thread: HTMLElement, dots: HTMLElement): void {
  if (thread.lastElementChild !== dots) thread.appendChild(dots);
}

/** a wrapper just landed at the tail: an existing #typing moves directly after it */
export function moveTypingAfter(thread: HTMLElement, content: HTMLElement): void {
  const dots = thread.querySelector<HTMLElement>("#typing");
  if (!dots || content.nextElementSibling === dots) return;
  thread.insertBefore(dots, content.nextElementSibling);
}
