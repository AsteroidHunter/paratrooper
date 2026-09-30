// Emoji reactions (tapbacks): the pure rules the bar, the badges and the double
// tap are built on (reactions.ts), the first emoji of what he typed (emoji.ts),
// and the saved copy carrying a chat's reactions (threadcache.ts). The DOM and
// the main.ts wiring are pinned on the source in tapbar.test.ts.
import { describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { leadingEmoji } from "../src/emoji";
import {
  DOUBLE_TAP_MS,
  DOUBLE_TAP_REACH_PX,
  RECENTS_MAX,
  TAPBACKS,
  TAP_MAX_MS,
  TAP_SLOP_PX,
  barItems,
  barPlacement,
  createDoubleTap,
  createReactionBook,
  createTapWait,
  glyphOf,
  isTapback,
  nextReaction,
  normalizeReaction,
  reactionLabel,
  readRecents,
  rememberRecent,
} from "../src/reactions";

// --- the six, and what a reaction may be -----------------------------------------

describe("the tapbacks", () => {
  it("are Messages' six, in its bar's order", () => {
    expect(TAPBACKS).toEqual(["heart", "like", "dislike", "haha", "emphasize", "question"]);
    for (const t of TAPBACKS) expect(isTapback(t)).toBe(true);
    expect(isTapback("😂")).toBe(false);
  });

  it("each draws as its own glyph class, and any other reaction as the emoji", () => {
    expect(glyphOf("heart")).toEqual({ text: "🩷", cls: "tb tb-heart" });
    expect(glyphOf("like")).toEqual({ text: "👍", cls: "tb tb-like" });
    expect(glyphOf("dislike")).toEqual({ text: "👎", cls: "tb tb-dislike" });
    expect(glyphOf("haha")).toEqual({ text: "HA\nHA", cls: "tb tb-haha" });
    expect(glyphOf("emphasize")).toEqual({ text: "!!", cls: "tb tb-emphasize" });
    expect(glyphOf("question")).toEqual({ text: "?", cls: "tb tb-question" });
    expect(glyphOf("😂")).toEqual({ text: "😂", cls: "tb tb-emoji" });
  });

  it("read aloud by name, and an emoji by itself", () => {
    expect(reactionLabel("heart")).toBe("Heart");
    expect(reactionLabel("like")).toBe("Thumbs up");
    expect(reactionLabel("haha")).toBe("Ha ha");
    expect(reactionLabel("emphasize")).toBe("Exclamation marks");
    expect(reactionLabel("question")).toBe("Question mark");
    expect(reactionLabel("🎈")).toBe("🎈");
  });

  it("the emoji drawn as a tapback fold into it; the red heart stays itself", () => {
    expect(normalizeReaction("🩷")).toBe("heart");
    expect(normalizeReaction("👍")).toBe("like");
    expect(normalizeReaction("👎")).toBe("dislike");
    expect(normalizeReaction("‼️")).toBe("emphasize");
    expect(normalizeReaction("‼")).toBe("emphasize");
    expect(normalizeReaction("❓")).toBe("question");
    expect(normalizeReaction("heart")).toBe("heart");
    expect(normalizeReaction("❤️")).toBe("❤️");
    expect(normalizeReaction("👍🏽")).toBe("👍🏽");
    expect(normalizeReaction(" 🇺🇸 ")).toBe("🇺🇸");
  });

  it("words and runs of emoji are not a reaction", () => {
    for (const bad of ["", "lol", "a", "7", "😂😂", "😂 ok", "hearts"]) {
      expect(normalizeReaction(bad), bad).toBeNull();
    }
  });
});

describe("picking in the bar", () => {
  it("the same one again takes it off; another replaces it", () => {
    expect(nextReaction(null, "heart")).toBe("heart");
    expect(nextReaction(undefined, "😂")).toBe("😂");
    expect(nextReaction("heart", "heart")).toBeNull();
    expect(nextReaction("heart", "like")).toBe("like");
    expect(nextReaction("😂", "haha")).toBe("haha");
  });
});

// --- recents ------------------------------------------------------------------------

describe("his recent reaction emoji", () => {
  it("newest first, never twice, capped", () => {
    let list: string[] = [];
    for (const e of ["😂", "🎈", "🔥", "😂"]) list = rememberRecent(list, e);
    expect(list).toEqual(["😂", "🔥", "🎈"]);
    for (let i = 0; i < 20; i++) list = rememberRecent(list, String.fromCodePoint(0x1f600 + i));
    expect(list).toHaveLength(RECENTS_MAX);
    expect(list[0]).toBe(String.fromCodePoint(0x1f600 + 19));
  });

  it("never stores one of the six", () => {
    expect(rememberRecent(["😂"], "heart")).toEqual(["😂"]);
    expect(rememberRecent(["😂"], "like")).toEqual(["😂"]);
  });

  it("reads back whatever storage held, and survives junk", () => {
    expect(readRecents(JSON.stringify(["🎈", "heart", "lol", 5, "😂"]))).toEqual(["🎈", "😂"]);
    expect(readRecents(null)).toEqual([]);
    expect(readRecents("{not json")).toEqual([]);
    expect(readRecents(JSON.stringify({ a: 1 }))).toEqual([]);
  });

  it("the bar is the six, then the recents that are not among them", () => {
    expect(barItems([])).toEqual([...TAPBACKS]);
    expect(barItems(["😂", "🎈", "😂"])).toEqual([...TAPBACKS, "😂", "🎈"]);
  });
});

// --- the reaction book --------------------------------------------------------------

describe("the reaction book", () => {
  it("holds one of his and one of the agent's per message", () => {
    const book = createReactionBook();
    expect(book.set(7, "user", "heart")).toBe(true);
    expect(book.set(7, "agent", "like")).toBe(true);
    expect(book.get(7)).toEqual({ user: "heart", agent: "like" });
    expect(book.set(7, "user", "heart")).toBe(false); // nothing changed
    expect(book.set(7, "user", "haha")).toBe(true); // replaced, never stacked
    expect(book.get(7)).toEqual({ user: "haha", agent: "like" });
    expect(book.set(7, "user", null)).toBe(true);
    expect(book.set(7, "agent", null)).toBe(true);
    expect(book.get(7)).toBeUndefined();
  });

  it("a snapshot replaces it wholesale and names the messages that changed", () => {
    const book = createReactionBook();
    book.set(1, "user", "heart");
    book.set(2, "user", "like");
    book.set(3, "agent", "😂");
    const changed = book.replaceAll([
      { target: 2, role: "user", reaction: "like" },
      { target: 3, role: "agent", reaction: "🎈" },
      { target: 4, role: "user", reaction: "question" },
    ]);
    expect(changed.sort()).toEqual([1, 3, 4]); // 2 is as it was
    expect(book.get(1)).toBeUndefined();
    expect(book.get(4)).toEqual({ user: "question" });
  });

  it("a snapshot entry that is not a reaction is skipped", () => {
    const book = createReactionBook();
    book.replaceAll([
      { target: 1, role: "user", reaction: "lol" },
      { target: 0, role: "user", reaction: "heart" },
      { target: 2, role: "someone", reaction: "heart" },
      { target: 3, role: "user", reaction: "heart" },
    ] as never);
    expect(book.entries()).toEqual([{ target: 3, role: "user", reaction: "heart" }]);
  });

  it("round-trips through its entries (the saved copy), and drops a taken back reply", () => {
    const book = createReactionBook();
    book.set(5, "user", "heart");
    book.set(5, "agent", "like");
    book.set(9, "agent", "🔥");
    const again = createReactionBook();
    again.replaceAll(book.entries());
    expect(again.get(5)).toEqual({ user: "heart", agent: "like" });
    expect(again.drop(5)).toBe(true);
    expect(again.drop(5)).toBe(false);
    expect(again.clear()).toEqual([9]);
    expect(again.entries()).toEqual([]);
  });
});

// --- the double tap -----------------------------------------------------------------

describe("the double tap", () => {
  const tap = (d: ReturnType<typeof createDoubleTap>, key: number | null, t: number, x = 100, y = 200) => {
    d.down(key, x, y, t);
    return d.up(x, y, t + 60);
  };

  it("two quick still taps on one message", () => {
    const d = createDoubleTap();
    expect(tap(d, 4, 0)).toBe("single");
    expect(tap(d, 4, 60 + DOUBLE_TAP_MS)).toBe("double");
    // and a third starts over rather than making another double
    expect(tap(d, 4, 400)).toBe("single");
  });

  it("too slow, too far apart, or on another message is not one", () => {
    const d = createDoubleTap();
    tap(d, 4, 0);
    expect(tap(d, 4, 60 + DOUBLE_TAP_MS + 1)).toBe("single");
    const far = createDoubleTap();
    tap(far, 4, 0, 100, 200);
    expect(tap(far, 4, 150, 100 + DOUBLE_TAP_REACH_PX + 1, 200)).toBe("single");
    const other = createDoubleTap();
    tap(other, 4, 0);
    expect(tap(other, 5, 150)).toBe("single");
  });

  it("a touch that moves or is held is no tap at all, and resets the pair", () => {
    const d = createDoubleTap();
    tap(d, 4, 0);
    d.down(4, 100, 200, 120);
    d.move(100, 200 + TAP_SLOP_PX + 1); // a scroll
    expect(d.up(100, 211, 180)).toBeNull();
    expect(tap(d, 4, 200)).toBe("single"); // the scroll broke the pair
    const held = createDoubleTap();
    tap(held, 4, 0);
    held.down(4, 100, 200, 100);
    expect(held.up(100, 200, 100 + TAP_MAX_MS + 1)).toBeNull(); // a long press
  });

  it("a touch off any message counts for nothing, and cancel forgets everything", () => {
    const d = createDoubleTap();
    expect(tap(d, null, 0)).toBeNull();
    tap(d, 4, 100);
    d.cancel(); // a second finger, or a touchcancel
    expect(tap(d, 4, 200)).toBe("single");
  });

  it("says at the second touch's start that it could complete the pair", () => {
    const d = createDoubleTap();
    expect(d.down(4, 100, 200, 0)).toBe(false);
    d.up(100, 200, 60);
    expect(d.down(4, 105, 200, 60 + DOUBLE_TAP_MS)).toBe(true);
    d.up(105, 200, 380);
    expect(d.down(4, 100, 200, 400)).toBe(false); // a third touch is a fresh first
    d.up(100, 200, 450);
    expect(d.down(5, 100, 200, 500)).toBe(false); // another message
    d.up(100, 200, 550);
    expect(d.down(5, 100, 200, 550 + DOUBLE_TAP_MS + 1)).toBe(false); // too late
  });

  it("the window is a quarter second", () => {
    expect(DOUBLE_TAP_MS).toBe(250);
    expect(TAP_SLOP_PX).toBe(10);
    expect(DOUBLE_TAP_REACH_PX).toBe(30);
    expect(TAP_MAX_MS).toBe(350);
  });
});

describe("a photo's single tap waits out the double tap window", () => {
  it("runs after the window unless the double tap claims it", () => {
    vi.useFakeTimers();
    try {
      const wait = createTapWait();
      const opened: number[] = [];
      wait.after(3, () => opened.push(3));
      vi.advanceTimersByTime(DOUBLE_TAP_MS - 1);
      expect(opened).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(opened).toEqual([3]);
      wait.after(4, () => opened.push(4));
      expect(wait.claim(4)).toBe(true); // the second tap landed: no photo
      vi.advanceTimersByTime(DOUBLE_TAP_MS * 2);
      expect(opened).toEqual([3]);
      expect(wait.claim(4)).toBe(false);
      wait.after(5, () => opened.push(5));
      wait.clear();
      vi.advanceTimersByTime(DOUBLE_TAP_MS * 2);
      expect(opened).toEqual([3]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- where the bar goes ---------------------------------------------------------------

describe("the bar's place", () => {
  const view = { top: 100, bottom: 700, left: 0, right: 393 };
  const bar = { width: 340, height: 56 };

  it("above the bubble, aligned to its sender's side", () => {
    const agent = barPlacement({ top: 400, bottom: 460, left: 16, right: 250 }, view, bar, "agent");
    expect(agent).toEqual({ top: 400 - 8 - 56, left: 16, below: false });
    const user = barPlacement({ top: 400, bottom: 460, left: 200, right: 377 }, view, bar, "user");
    expect(user).toEqual({ top: 400 - 8 - 56, left: 377 - 340, below: false });
  });

  it("kept inside the screen's sides", () => {
    const wide = barPlacement({ top: 400, bottom: 460, left: 16, right: 100 }, view, bar, "user");
    expect(wide.left).toBe(12);
    const narrow = barPlacement({ top: 400, bottom: 460, left: 60, right: 380 }, view, bar, "agent");
    expect(narrow.left).toBe(393 - 12 - 340);
  });

  it("below the bubble when there is no room above it", () => {
    const p = barPlacement({ top: 120, bottom: 200, left: 16, right: 250 }, view, bar, "agent");
    expect(p).toEqual({ top: 200 + 8, left: 16, below: true });
  });

  it("clamped into the visible area when there is room on neither side", () => {
    const p = barPlacement({ top: 110, bottom: 690, left: 16, right: 250 }, view, bar, "agent");
    expect(p.top).toBe(100 + 12);
    expect(p.below).toBe(false);
  });
});

// --- the first emoji he typed ------------------------------------------------------------

describe("the first emoji typed on the keyboard", () => {
  it("is the whole first emoji, joins and modifiers included", () => {
    expect(leadingEmoji("😂")).toBe("😂");
    expect(leadingEmoji("❤️")).toBe("❤️");
    expect(leadingEmoji("👍🏽")).toBe("👍🏽");
    expect(leadingEmoji("🇺🇸")).toBe("🇺🇸");
    expect(leadingEmoji("1️⃣")).toBe("1️⃣");
    expect(leadingEmoji("👨‍👩‍👧‍👦")).toBe("👨‍👩‍👧‍👦");
    expect(leadingEmoji(" 🎈🎈")).toBe("🎈");
  });

  it("is nothing when the first thing typed is a letter", () => {
    expect(leadingEmoji("a😂")).toBeNull();
    expect(leadingEmoji("")).toBeNull();
    expect(leadingEmoji("7")).toBeNull();
    expect(leadingEmoji("©")).toBeNull(); // a symbol drawn as text is a letter
  });
});

// --- the saved copy -------------------------------------------------------------------

describe("the saved copy carries the chat's reactions", () => {
  async function freshCache() {
    globalThis.indexedDB = new IDBFactory();
    vi.resetModules();
    return import("../src/threadcache");
  }

  it("round-trips them beside the frames", async () => {
    const cache = await freshCache();
    const reactions = [{ target: 3, role: "user", reaction: "heart", ts: "t" }];
    await cache.put({ id: "default", lastSeq: 3, frames: [{ seq: 3 }], reactions });
    const got = await cache.get("default");
    expect(got?.reactions).toEqual(reactions);
    expect(got?.frames).toEqual([{ seq: 3 }]);
  });

  it("a record saved before reactions existed reads as none, not as a broken record", async () => {
    const cache = await freshCache();
    await cache.put({ id: "default", lastSeq: 3, frames: [{ seq: 3 }] });
    const got = await cache.get("default");
    expect(got?.reactions).toEqual([]);
    expect(got?.frames).toHaveLength(1);
  });
});
