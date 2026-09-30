// The reaction bar: Messages' tapback bar over a lifted bubble (the owner's
// screenshot of it, IMG_3027, is the reference). A white capsule holding the
// six tapbacks and then his recent reaction emoji, scrolling sideways, and a
// smiley bubble hanging off its right end that brings up his own iPhone
// keyboard. There is deliberately nothing else: every iPhone keyboard already
// has an emoji key, so the app draws no emoji chooser of its own (the one it
// once had was taken out on the owner's word).
//
// The bar is drawn in the app shell, outside the scrolling thread, and placed
// from the bubble's own rectangle every frame it is open. That is what lets it
// follow everything that can move a bubble without the bar owning any scroll:
// the keyboard lift, a reply landing under a pinned thread, a photo loading
// above it. It never touches the thread's scroll and adds nothing to its range.
//
// The keyboard: a web page can raise the iPhone keyboard only by focusing a
// field inside the user's own tap, synchronously. The smiley's tap focuses a
// hidden one character field (styles.css .tapbar-key), the keyboard shell
// treats it as any editor and lifts the thread with it, and the first emoji he
// types is the reaction. A page cannot choose which keyboard opens: it is the
// one he used last, and the emoji key is one tap away.

import { leadingEmoji } from "./emoji";
import {
  BAR_MARGIN_PX,
  barPlacement,
  glyphOf,
  normalizeReaction,
  reactionLabel,
} from "./reactions";
import type { Box, ReactionRole } from "./reactions";

/** the capsule's widest, and its height (the screenshot: about 340 by 56) */
export const BAR_MAX_W = 340;
export const BAR_H = 56;
/** how long a tap that closed the bar keeps the thread from acting on it */
const SWALLOW_MS = 600;
/** the exit's length (styles.css tapbar-out), plus a frame of slack */
const OUT_MS = 180;

export interface TapbarDeps {
  /** the element the bar is drawn in (#app) */
  host(): HTMLElement | null;
  /** the visible part of the thread, in viewport coordinates */
  view(): Box | null;
  /** what the bar offers, in order: the six, then his recents */
  items(): string[];
  /** his reaction on this message now, if any */
  current(seq: number): string | undefined;
  /** he picked this for this message (the toggle is the caller's) */
  pick(seq: number, reaction: string): void;
}

export interface Tapbar {
  open(bubble: HTMLElement, seq: number, side: ReactionRole): void;
  close(): void;
  isOpen(): boolean;
  /** the message the bar is open on, or null */
  openSeq(): number | null;
  /** his reaction changed while the bar was up: re-mark the pressed item */
  refresh(): void;
}

export function createTapbar(deps: TapbarDeps): Tapbar {
  let el: HTMLDivElement | null = null;
  let row: HTMLDivElement | null = null;
  let key: HTMLInputElement | null = null;
  let lifted: HTMLElement | null = null;
  let seq: number | null = null;
  let side: ReactionRole = "agent";
  let raf = 0;
  let placed = ""; // the position as last written, so a still frame writes nothing
  let swallowUntil = 0;

  function make<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.className = cls;
    return node;
  }

  function paintItems(): void {
    if (!row || seq === null) return;
    const now = deps.current(seq);
    const buttons = deps.items().map((reaction) => {
      const b = make("button", reaction === now ? "tapback on" : "tapback");
      b.type = "button";
      b.dataset.reaction = reaction;
      b.setAttribute("aria-label", reactionLabel(reaction));
      b.setAttribute("aria-pressed", String(reaction === now));
      const g = glyphOf(reaction);
      const face = make("span", g.cls);
      face.textContent = g.text;
      face.setAttribute("aria-hidden", "true");
      b.appendChild(face);
      return b;
    });
    row.replaceChildren(...buttons);
  }

  function build(): HTMLDivElement {
    const bar = make("div", "tapbar");
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Reactions");
    const pill = make("div", "tapbar-pill");
    row = make("div", "tapbar-row");
    pill.appendChild(row);
    const more = make("div", "tapbar-more");
    const smiley = make("button", "tapbar-smiley");
    smiley.type = "button";
    smiley.setAttribute("aria-label", "Any emoji from the keyboard");
    const face = make("span", "tapbar-face");
    face.setAttribute("aria-hidden", "true");
    smiley.appendChild(face);
    key = make("input", "tapbar-key");
    key.type = "text";
    key.tabIndex = -1;
    key.autocomplete = "off";
    key.spellcheck = false;
    key.setAttribute("autocorrect", "off");
    key.setAttribute("autocapitalize", "off");
    key.setAttribute("enterkeyhint", "done");
    key.setAttribute("aria-label", "Type an emoji to react with");
    more.append(smiley, key);
    bar.append(pill, more);
    // a tap here keeps whatever holds focus (the compose box with its keyboard
    // up, or the hidden field): mousedown is the event that grants focus
    bar.addEventListener("mousedown", (e) => {
      if (e.target !== key) e.preventDefault();
    });
    row.addEventListener("click", onItem);
    smiley.addEventListener("click", onSmiley);
    key.addEventListener("input", onKey);
    return bar;
  }

  function onItem(e: MouseEvent): void {
    const b = e.target instanceof Element ? e.target.closest<HTMLElement>(".tapback") : null;
    const reaction = b?.dataset.reaction;
    const on = seq;
    if (!reaction || on === null) return;
    close();
    deps.pick(on, reaction);
  }

  // Inside the tap, first and synchronously: iOS raises the keyboard for a
  // focus call only while the tap that caused it is still being handled.
  function onSmiley(): void {
    if (!key || !el) return;
    key.value = "";
    key.focus({ preventScroll: true });
    el.classList.add("keying");
  }

  // The first emoji he types is the reaction; a letter typed first is thrown
  // away and the field waits for an emoji. The keyboard goes with the bar.
  function onKey(): void {
    if (!key) return;
    const typed = key.value;
    const emoji = leadingEmoji(typed);
    if (emoji === null) {
      if (typed.trim()) key.value = "";
      return;
    }
    const on = seq;
    key.value = "";
    key.blur();
    close();
    if (on !== null) deps.pick(on, normalizeReaction(emoji) ?? emoji);
  }

  // A tap anywhere else closes the bar, and a tap that closed it is only
  // that: on the thread it opens no photo and follows no link.
  function onOutside(e: PointerEvent): void {
    if (!el || (e.target instanceof Node && el.contains(e.target))) return;
    if (e.target instanceof Element && e.target.closest("#thread")) {
      swallowUntil = performance.now() + SWALLOW_MS;
    }
    close();
  }

  function onSwallow(e: MouseEvent): void {
    if (performance.now() > swallowUntil) return;
    if (!(e.target instanceof Element) || !e.target.closest("#thread")) return;
    swallowUntil = 0;
    e.preventDefault();
    e.stopPropagation();
  }
  document.addEventListener("click", onSwallow, true);

  function onEscape(e: KeyboardEvent): void {
    if (e.key === "Escape") close();
  }

  function place(): void {
    if (!el || !lifted) return;
    const host = deps.host();
    const view = deps.view();
    if (!host || !view || !lifted.isConnected) {
      close(); // the bubble was re-rendered or its chat left: nothing to point at
      return;
    }
    const b = lifted.getBoundingClientRect();
    if (b.bottom < view.top || b.top > view.bottom) {
      close(); // carried out of sight (a reply pinned the thread): nothing to point at
      return;
    }
    const h = host.getBoundingClientRect();
    const width = Math.min(BAR_MAX_W, h.width - 2 * BAR_MARGIN_PX);
    const p = barPlacement(
      { top: b.top, bottom: b.bottom, left: b.left, right: b.right },
      view, { width, height: BAR_H }, side,
    );
    const left = Math.round(p.left - h.left);
    const top = Math.round(p.top - h.top);
    const at = `${left},${top},${width},${p.below}`;
    if (at === placed) return;
    placed = at;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.width = `${width}px`;
    el.classList.toggle("below", p.below);
    el.classList.toggle("mine", side === "user");
  }

  function follow(): void {
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!el) return;
      place();
      if (el) follow();
    });
  }

  function close(): void {
    if (!el) return;
    const leaving = el;
    el = null;
    row = null;
    seq = null;
    placed = "";
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (key && document.activeElement === key) key.blur(); // and the keyboard with it
    key = null;
    if (lifted) {
      const bubble = lifted;
      bubble.classList.remove("lifted");
      bubble.classList.add("droplift"); // eases back rather than snapping
      setTimeout(() => bubble.classList.remove("droplift"), OUT_MS + 80);
    }
    lifted = null;
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onEscape, true);
    leaving.classList.add("out");
    setTimeout(() => leaving.remove(), OUT_MS);
  }

  return {
    open(bubble, on, from) {
      close();
      const host = deps.host();
      if (!host) return;
      seq = on;
      side = from;
      lifted = bubble;
      bubble.classList.remove("droplift");
      bubble.classList.add("lifted");
      el = build();
      paintItems();
      host.appendChild(el);
      place();
      document.addEventListener("pointerdown", onOutside, true);
      document.addEventListener("keydown", onEscape, true);
      follow();
    },
    close,
    isOpen: () => el !== null,
    openSeq: () => seq,
    refresh: paintItems,
  };
}
