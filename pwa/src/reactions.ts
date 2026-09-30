// Emoji reactions (tapbacks): the rules under the bar, the badges and the
// double tap. Pure, no DOM: tapbar.ts draws the bar, main.ts paints the badges
// and feeds the touches in.
//
// A reaction is one of Messages' six tapbacks, stored by name (HA HA, !! and ?
// have no emoji of their own), or one emoji. One per person per message: his
// ("user") and the agent's. The service keeps them per chat and sends the whole
// chat's set after every socket replay (a snapshot) and each change live; the
// book below is the phone's copy for the chat on screen, and the saved thread
// carries it so a cold open paints the badges before the socket is up.

import { emojiCount, leadingEmoji } from "./emoji";

/** Messages' six, in the order its bar shows them. */
export const TAPBACKS = ["heart", "like", "dislike", "haha", "emphasize", "question"] as const;
export type Tapback = (typeof TAPBACKS)[number];

export function isTapback(value: string): value is Tapback {
  return (TAPBACKS as readonly string[]).includes(value);
}

// How each is drawn (styles.css .tb-*): the heart and the thumbs are the
// system's own emoji, which on the phone are the glossy iOS 18 tapback glyphs;
// HA HA, !! and ? are rounded heavy type filled with the tapbacks' gradients.
// No SVG anywhere in the chat's markup (downbtn.test.ts holds that rule).
const TAPBACK_GLYPHS: Record<Tapback, string> = {
  heart: "\u{1FA77}", // pink heart
  like: "\u{1F44D}",
  dislike: "\u{1F44E}",
  haha: "HA\nHA",
  emphasize: "!!",
  question: "?",
};

const TAPBACK_LABELS: Record<Tapback, string> = {
  heart: "Heart",
  like: "Thumbs up",
  dislike: "Thumbs down",
  haha: "Ha ha",
  emphasize: "Exclamation marks",
  question: "Question mark",
};

/** The text a reaction draws as, and its glyph class. */
export function glyphOf(reaction: string): { text: string; cls: string } {
  if (isTapback(reaction)) return { text: TAPBACK_GLYPHS[reaction], cls: `tb tb-${reaction}` };
  return { text: reaction, cls: "tb tb-emoji" };
}

/** What VoiceOver says for a reaction: the tapback's name, or the emoji itself. */
export function reactionLabel(reaction: string): string {
  return isTapback(reaction) ? TAPBACK_LABELS[reaction] : reaction;
}

// The emoji drawn AS a tapback are that tapback, so his thumbs up from the
// keyboard and the bar's thumbs up are one reaction, and the recents never
// repeat one of the six. The red heart is not the heart tapback, in Messages or
// here. The service folds the same set (models.py normalize_reaction).
const TAPBACK_EMOJI: Record<string, Tapback> = {
  "\u{1FA77}": "heart",
  "\u{1F44D}": "like",
  "\u{1F44E}": "dislike",
  "‼": "emphasize",
  "‼️": "emphasize",
  "❓": "question",
};

/** The stored form of a reaction, or null when it is not one. */
export function normalizeReaction(value: string): string | null {
  const text = value.trim();
  if (isTapback(text)) return text;
  if (text in TAPBACK_EMOJI) return TAPBACK_EMOJI[text];
  if (emojiCount(text) !== 1 || leadingEmoji(text) !== text) return null;
  return text;
}

/** A pick in the bar: the same one again takes it off, another replaces it. */
export function nextReaction(current: string | null | undefined, picked: string): string | null {
  return current === picked ? null : picked;
}

// --- recents ---------------------------------------------------------------

/** Where his recent reaction emoji live on the phone; logout removes it. */
export const RECENTS_KEY = "paratrooper_reaction_recents";
export const RECENTS_MAX = 12;

/** The list after one use: newest first, never twice, never one of the six. */
export function rememberRecent(list: readonly string[], used: string): string[] {
  if (isTapback(used)) return [...list];
  return [used, ...list.filter((e) => e !== used)].slice(0, RECENTS_MAX);
}

/** Whatever storage held, as a clean list; anything unreadable is none. */
export function readRecents(raw: string | null): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") continue;
    const value = normalizeReaction(item);
    if (value && !isTapback(value) && !out.includes(value)) out.push(value);
  }
  return out.slice(0, RECENTS_MAX);
}

/** The bar's items: the six, then his recents that are not among them. */
export function barItems(recents: readonly string[]): string[] {
  const out: string[] = [...TAPBACKS];
  for (const e of recents) if (!out.includes(e)) out.push(e);
  return out;
}

// --- the reaction book ----------------------------------------------------------

export type ReactionRole = "user" | "agent";

/** One reaction as the service sends it (and as the saved copy keeps it). */
export interface ReactionEntry {
  target: number;
  role: ReactionRole;
  reaction: string;
  ts?: string;
}

/** The two reactions a message can carry. */
export interface ReactionPair {
  user?: string;
  agent?: string;
}

export interface ReactionBook {
  get(seq: number): ReactionPair | undefined;
  /** set or (null) take off one person's reaction; true when it changed */
  set(seq: number, role: ReactionRole, reaction: string | null): boolean;
  /** the snapshot: replace everything, and say which messages changed */
  replaceAll(entries: readonly ReactionEntry[]): number[];
  /** a message that is gone (a take back); true when it had any */
  drop(seq: number): boolean;
  /** forget the chat; the messages that had any */
  clear(): number[];
  /** every reaction, for the saved copy */
  entries(): ReactionEntry[];
}

function validEntry(e: ReactionEntry): boolean {
  return (
    e !== null && typeof e === "object" && Number.isInteger(e.target) && e.target > 0 &&
    (e.role === "user" || e.role === "agent") && typeof e.reaction === "string" &&
    normalizeReaction(e.reaction) === e.reaction
  );
}

function samePair(a: ReactionPair | undefined, b: ReactionPair | undefined): boolean {
  return (a?.user ?? null) === (b?.user ?? null) && (a?.agent ?? null) === (b?.agent ?? null);
}

export function createReactionBook(): ReactionBook {
  let pairs = new Map<number, ReactionPair>();
  return {
    get: (seq) => pairs.get(seq),
    set(seq, role, reaction) {
      const had = pairs.get(seq);
      if ((had?.[role] ?? null) === reaction) return false;
      const next: ReactionPair = { ...had };
      if (reaction === null) delete next[role];
      else next[role] = reaction;
      if (next.user === undefined && next.agent === undefined) pairs.delete(seq);
      else pairs.set(seq, next);
      return true;
    },
    replaceAll(entries) {
      const fresh = new Map<number, ReactionPair>();
      for (const e of entries) {
        if (!validEntry(e)) continue;
        fresh.set(e.target, { ...fresh.get(e.target), [e.role]: e.reaction });
      }
      const changed: number[] = [];
      for (const seq of new Set([...pairs.keys(), ...fresh.keys()])) {
        if (!samePair(pairs.get(seq), fresh.get(seq))) changed.push(seq);
      }
      pairs = fresh;
      return changed;
    },
    drop: (seq) => pairs.delete(seq),
    clear() {
      const had = [...pairs.keys()];
      pairs = new Map();
      return had;
    },
    entries() {
      const out: ReactionEntry[] = [];
      for (const [target, pair] of [...pairs].sort((a, b) => a[0] - b[0])) {
        if (pair.user !== undefined) out.push({ target, role: "user", reaction: pair.user });
        if (pair.agent !== undefined) out.push({ target, role: "agent", reaction: pair.agent });
      }
      return out;
    },
  };
}

// --- the double tap ---------------------------------------------------------------
//
// Two touches on the same message: the second starts within DOUBLE_TAP_MS of
// the first lifting and within DOUBLE_TAP_REACH_PX of it, and each touch is a
// tap (shorter than TAP_MAX_MS, moving less than TAP_SLOP_PX). 250 ms is under
// both platforms' own windows (Android 300 ms, UIKit about 350 ms) and catches
// an ordinary double tap. It is also exactly how long a photo's single tap
// waits before the photo opens (createTapWait below), the only single tap in
// the thread that has to wait at all: a text bubble has no single tap action,
// and a link opens on its first tap as it always did.

export const DOUBLE_TAP_MS = 250;
export const DOUBLE_TAP_REACH_PX = 30;
export const TAP_SLOP_PX = 10;
export const TAP_MAX_MS = 350;

export type TapVerdict = "single" | "double" | null;

export interface DoubleTap {
  /**
   * a finger lands; key is the message under it, null for none. True when
   * this touch could be the second of a double tap: the caller holds back the
   * first tap's waiting action (a photo opening) from here, because the
   * window is measured to the second touch's START, and a photo that opened
   * while the second finger was still down would open under the bar.
   */
  down(key: number | null, x: number, y: number, t: number): boolean;
  move(x: number, y: number): void;
  /** the finger lifts: a first tap, the second of a double, or no tap */
  up(x: number, y: number, t: number): TapVerdict;
  /** a second finger or a cancelled touch: forget everything */
  cancel(): void;
}

export function createDoubleTap(): DoubleTap {
  let press: { key: number | null; x: number; y: number; t: number; moved: boolean } | null = null;
  let last: { key: number; x: number; y: number; upAt: number } | null = null;
  return {
    down(key, x, y, t) {
      press = { key, x, y, t, moved: false };
      return (
        key !== null && last !== null && last.key === key && t - last.upAt <= DOUBLE_TAP_MS &&
        Math.hypot(x - last.x, y - last.y) <= DOUBLE_TAP_REACH_PX
      );
    },
    move(x, y) {
      if (press && Math.hypot(x - press.x, y - press.y) > TAP_SLOP_PX) press.moved = true;
    },
    up(_x, _y, t) {
      const p = press;
      press = null;
      if (!p || p.moved || p.key === null || t - p.t > TAP_MAX_MS) {
        last = null;
        return null;
      }
      const pair =
        last !== null && last.key === p.key && p.t - last.upAt <= DOUBLE_TAP_MS &&
        Math.hypot(p.x - last.x, p.y - last.y) <= DOUBLE_TAP_REACH_PX;
      if (pair) {
        last = null;
        return "double";
      }
      last = { key: p.key, x: p.x, y: p.y, upAt: t };
      return "single";
    },
    cancel() {
      press = null;
      last = null;
    },
  };
}

export interface TapWait {
  /** run `fn` once the double tap window has passed, unless claimed first */
  after(key: number, fn: () => void): void;
  /** the double tap landed on `key`: its waiting single tap never runs */
  claim(key: number): boolean;
  clear(): void;
}

export function createTapWait(ms: number = DOUBLE_TAP_MS): TapWait {
  const waiting = new Map<number, ReturnType<typeof setTimeout>>();
  return {
    after(key, fn) {
      const had = waiting.get(key);
      if (had !== undefined) clearTimeout(had);
      waiting.set(key, setTimeout(() => {
        waiting.delete(key);
        fn();
      }, ms));
    },
    claim(key) {
      const had = waiting.get(key);
      if (had === undefined) return false;
      clearTimeout(had);
      waiting.delete(key);
      return true;
    },
    clear() {
      for (const t of waiting.values()) clearTimeout(t);
      waiting.clear();
    },
  };
}

// --- where the bar goes ---------------------------------------------------------------

export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** the air between the bar and the bubble, and the bar and the screen's edges */
export const BAR_GAP_PX = 8;
export const BAR_MARGIN_PX = 12;

/**
 * Where the bar sits for one bubble, in the same coordinates as `bubble` and
 * `view` (the visible thread: under the header, over the compose bar). Above
 * the bubble when it fits, else below it, else clamped into view; lined up with
 * the bubble's sender side (his on the right, the agent's on the left, as
 * Messages lines its bar up with the bubble) and kept off the screen's edges.
 */
export function barPlacement(
  bubble: Box,
  view: Box,
  bar: { width: number; height: number },
  side: ReactionRole,
): { top: number; left: number; below: boolean } {
  const want = side === "user" ? bubble.right - bar.width : bubble.left;
  const left = Math.max(view.left + BAR_MARGIN_PX,
    Math.min(want, view.right - BAR_MARGIN_PX - bar.width));
  const above = bubble.top - BAR_GAP_PX - bar.height;
  if (above >= view.top + BAR_MARGIN_PX) return { top: above, left, below: false };
  const below = bubble.bottom + BAR_GAP_PX;
  if (below + bar.height <= view.bottom - BAR_MARGIN_PX) return { top: below, left, below: true };
  const top = Math.max(view.top + BAR_MARGIN_PX,
    Math.min(above, view.bottom - BAR_MARGIN_PX - bar.height));
  return { top, left, below: false };
}
