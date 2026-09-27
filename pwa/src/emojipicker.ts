// The emoji picker: the smiley at the right end of the compose bar and the
// compact panel it opens over the bottom of the thread (a recent row and the
// curated grid, emoji.ts). A pick puts the emoji into the compose box at the
// caret.
//
// THE ONE RULE: a pick never moves focus. Everything about the keyboard (the
// lift, the widening, the caret hold, the shove correction; shell.ts and
// widen.ts) turns on which element holds focus, so the picker leaves that
// alone in both directions. The smiley and the whole panel wear the send
// arrow's shield (shell.ts bindFocusShield, bound in main.ts renderChat): with
// the keyboard up the box keeps focus and the keyboard stays, with it down
// nothing is focused and nothing rises. The emoji then goes in two ways:
//   - the box holds focus: the insertText command, which is the path a typed
//     character takes. The engine fires beforeinput and input itself, so the
//     shell's keystroke listener re-opens its shove budget, the undo stack
//     holds the pick, and the app's own input handler (autosize with its
//     blink, the send arrow, the reply hold) runs exactly as for a key.
//   - it does not: there is no caret to type at, so the value is spliced at
//     the selection the box kept when it lost focus and the same input event
//     is fired by hand, so the same handler runs.
//
// The panel is NOT inside the compose form. The form carries the swipe down
// the bar that puts the keyboard away (shell.ts bindComposeDismiss), and a
// finger scrolling the grid down would read as that swipe. It is the form's
// sibling inside the lift instead, so it still rides the keyboard with the bar.
//
// The recent row is written to storage on every pick but redrawn only when the
// panel opens: a row that reorders under the finger turns a second tap on the
// same spot into a different emoji (Messages' own row waits the same way).

import { EMOJI_GROUPS, RECENT_KEY, pushRecent, readRecent, recentRow, spliceAtCaret } from "./emoji";

/** The part of a textarea an insert touches: what the tests fake. */
export interface CaretBox {
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  setSelectionRange(start: number, end: number): void;
  dispatchEvent(e: Event): boolean;
}

/**
 * Put `text` into the box at its caret. `focused` says whether the box holds
 * focus; `command` is the typed path (the insertText command), tried only
 * then, and trusted only if the value actually took the text. Says which way
 * the text went in.
 */
export function insertAtCaret(
  box: CaretBox,
  text: string,
  focused: boolean,
  command: (text: string) => boolean,
): "typed" | "spliced" {
  const before = box.value;
  if (focused && command(text) && box.value !== before) return "typed";
  const at = box.value.length;
  const next = spliceAtCaret(box.value, box.selectionStart ?? at, box.selectionEnd ?? at, text);
  box.value = next.value;
  box.setSelectionRange(next.caret, next.caret);
  box.dispatchEvent(new Event("input", { bubbles: true }));
  return "spliced";
}

export interface EmojiPicker {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
}

// The picker on screen now. renderChat rebuilds the bar on every sign-in, so
// the document listeners below are installed once and read whichever picker
// is current, rather than one set per render piling up on old elements.
let current: { button: HTMLElement; panel: HTMLElement; picker: EmojiPicker } | null = null;
let listening = false;

function loadRecent(): string[] {
  try {
    return readRecent(localStorage.getItem(RECENT_KEY));
  } catch {
    return []; // storage refused (private mode, quota): the defaults stand in
  }
}

function saveRecent(list: readonly string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* best-effort: the pick itself already happened */
  }
}

function cell(emoji: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "emojicell";
  b.textContent = emoji;
  return b;
}

function heading(name: string): HTMLDivElement {
  const h = document.createElement("div");
  h.className = "emojihead";
  h.textContent = name;
  return h;
}

function drawRecent(row: HTMLElement): void {
  row.replaceChildren(...recentRow(loadRecent()).map(cell));
}

// the recents move the pick to the front for next time; the row on screen stays put
function pick(editor: HTMLTextAreaElement, emoji: string): void {
  insertAtCaret(
    editor,
    emoji,
    document.activeElement === editor,
    (text) => typeof document.execCommand === "function"
      && document.execCommand("insertText", false, text),
  );
  saveRecent(pushRecent(loadRecent(), emoji));
}

function listen(): void {
  if (listening) return;
  listening = true;
  // a tap anywhere else closes it: capture, so it sees the tap before anything
  // it lands on acts, and it prevents nothing, so the tap still does its thing
  // (the send arrow still sends, the box still takes its caret)
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!current?.picker.isOpen()) return;
      const t = e.target;
      if (t instanceof Node && (current.panel.contains(t) || current.button.contains(t))) return;
      current.picker.close();
    },
    true,
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") current?.picker.close();
  });
}

/**
 * Wire a freshly rendered smiley and panel to the compose box. The panel is
 * filled here, once per render: a heading and the recent row, then the grid's
 * groups in their own scroll area.
 */
export function bindEmojiPicker(
  button: HTMLButtonElement,
  panel: HTMLElement,
  editor: HTMLTextAreaElement,
): EmojiPicker {
  const recent = document.createElement("div");
  recent.className = "emojirow emojirecent";
  const scroll = document.createElement("div");
  scroll.className = "emojiscroll";
  for (const group of EMOJI_GROUPS) {
    const row = document.createElement("div");
    row.className = "emojirow";
    row.append(...group.emoji.map(cell));
    scroll.append(heading(group.name), row);
  }
  panel.replaceChildren(heading("Recent"), recent, scroll);
  let shown = false;
  const picker: EmojiPicker = {
    open(): void {
      drawRecent(recent);
      shown = true;
      panel.classList.add("open");
      button.setAttribute("aria-expanded", "true");
    },
    close(): void {
      shown = false;
      panel.classList.remove("open");
      button.setAttribute("aria-expanded", "false");
    },
    toggle(): void {
      if (shown) picker.close();
      else picker.open();
    },
    isOpen: () => shown,
  };
  button.addEventListener("click", () => picker.toggle());
  panel.addEventListener("click", (e) => {
    const hit = e.target instanceof Element ? e.target.closest(".emojicell") : null;
    if (hit?.textContent) pick(editor, hit.textContent);
  });
  current = { button, panel, picker };
  listen();
  return picker;
}
