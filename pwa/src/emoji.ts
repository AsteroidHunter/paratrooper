// Emoji: which texts are emoji and nothing else, and how many (the big-emoji
// rule). Pure, no DOM: main.ts draws the rows.
//
// THE BIG-EMOJI RULE is Messages' own (the decompiled iOS 18.2 ChatKit): the
// text is walked one visible character at a time, whitespace and newlines are
// skipped, every other character must be a single emoji, and 1 to 3 of them
// get the big treatment with no balloon. A fourth emoji, or any other
// character, and the message is an ordinary bubble.
//
// "One visible character" is a grapheme cluster, and for emoji that means a
// sequence, not a code point: a skin tone, a variation selector and the tag run
// of a subdivision flag all hang off the pictograph before them, a zero width
// joiner chains two pictographs into one (a family, a profession, a flag), a
// pair of regional indicators is one country flag, and a digit, # or * with
// U+20E3 is a keycap. The tokenizer below reads exactly those shapes and
// nothing else, so it can say both "this is one emoji" and "this is not an
// emoji at all" in one pass. The test holds its count to Intl.Segmenter's
// grapheme count on the same corpus.
//
// Why not the engine's own emoji set: the property that names the full emoji
// list needs the regex flag that arrived in Safari 17, and this bundle is
// built for Safari 14. A pattern that flag-less engines cannot parse throws at
// load and takes the whole app with it. Everything here is a u-flag Unicode
// property (Safari 11.1).
//
// A sequence counts only if it is DRAWN as an emoji. A lone regional
// indicator is a letter. A pictograph whose default presentation is text (the
// copyright sign, the trade mark, the plain heart, the arrows) draws as text
// unless something asks for the emoji form: its FE0F, a skin tone, a join, a
// tag run or the keycap mark. The iPhone keyboard always sends those with the
// FE0F, so what he types is big; a bare symbol from the agent stays a letter.

/** Messages' limit: up to this many emoji are drawn big, one more and it is a bubble. */
export const JUMBO_MAX = 3;

// one pictograph and everything that can hang off it
const ATOM = String.raw`(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\uFE0F|\p{Emoji_Modifier}|[\u{E0020}-\u{E007F}])*`;

// whitespace (group 1, skipped), a flag, a keycap, or a joined chain of atoms;
// sticky, so a character none of them can start at ends the scan right there
const TOKEN = new RegExp(
  String.raw`(\s+)|\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|${ATOM}(?:\u200D${ATOM})*`,
  "uy",
);

const LONE_LETTER = /^\p{Regional_Indicator}$/u;
// anything in a sequence that asks for the emoji form outright
const EMOJI_FORM = /[\uFE0F\u200D\u20E3\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]/u;
const EMOJI_BY_DEFAULT = /^\p{Emoji_Presentation}/u;

function drawnAsEmoji(unit: string): boolean {
  if (LONE_LETTER.test(unit)) return false;
  if (EMOJI_FORM.test(unit)) return true;
  return EMOJI_BY_DEFAULT.test(unit);
}

/**
 * How many emoji the text is made of, when it is made of emoji and whitespace
 * and nothing else; 0 when anything else is in it, and 0 for a text with no
 * emoji at all. The first character that is not part of an emoji ends the scan.
 */
export function emojiCount(text: string): number {
  TOKEN.lastIndex = 0;
  let count = 0;
  while (TOKEN.lastIndex < text.length) {
    const m = TOKEN.exec(text); // a miss resets lastIndex, and the answer is 0 anyway
    if (!m) return 0;
    if (m[1] !== undefined) continue;
    if (!drawnAsEmoji(m[0])) return 0;
    count++;
  }
  return count;
}

/** Whether a message's text is drawn as big emoji with no bubble: 1 to JUMBO_MAX emoji, nothing else. */
export function isJumboEmoji(text: string): boolean {
  const n = emojiCount(text);
  return n >= 1 && n <= JUMBO_MAX;
}
