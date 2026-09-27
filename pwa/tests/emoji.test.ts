// Big emoji: a message made only of 1 to 3 emoji is drawn large with no bubble
// (Messages' treatment: 1 to 3 qualify, 4 or more go back to a normal balloon,
// whitespace between them is skipped). The rule is pure (emoji.ts), so it is
// tested directly, and cross-checked against the engine's own grapheme
// segmentation so the tokenizer cannot drift from how the text is drawn. The
// render wiring and the sheet are pinned on the source, like the rest of the
// suite: main.ts boots a shell at import and cannot load under node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JUMBO_MAX, emojiCount, isJumboEmoji } from "../src/emoji";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const arrival = readFileSync(new URL("../src/arrival.ts", import.meta.url), "utf8");

function fnBody(name: string): string {
  const start = main.indexOf(`function ${name}(`);
  expect(start, `missing ${name}`).toBeGreaterThan(-1);
  const end = main.indexOf("\n}", start);
  return main.slice(start, end);
}

function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing ${selector} rule`).toBeGreaterThanOrEqual(0);
  const body = css.slice(start + selector.length + 2);
  return body.slice(0, body.indexOf("}"));
}

// one emoji each, of every shape the rule has to hold together as one unit
const SINGLES = [
  "😀", // plain, emoji presentation by default
  "👍🏽", // skin tone
  "☝🏽", // a text-default base made an emoji by its skin tone
  "❤️", // text-default base with its FE0F
  "©️", // the same for a symbol that is text without it
  "🇺🇸", // a flag: two regional indicators
  "1️⃣", // keycap
  "#️⃣",
  "🏳️‍🌈", // FE0F then ZWJ
  "👨‍👩‍👧‍👦", // family
  "🧑🏽‍💻", // skin tone then ZWJ
  "👩🏻‍🤝‍👨🏿", // two skin tones across three joins
  "🏴󠁧󠁢󠁥󠁮󠁧󠁿", // England: a tag sequence
  "❤️‍🔥",
  "🙂‍↔️", // head shaking: a ZWJ onto a text-default arrow with its FE0F
  "👁️‍🗨️",
  "🏻", // a lone skin tone swatch draws as a colour square emoji
];

const NOT_EMOJI = [
  "",
  "   ",
  "\n",
  "1",
  "#",
  "*",
  "12",
  "🇺", // a lone regional indicator is a letter, not a flag
  "©", // text-default symbols without FE0F draw as text
  "™",
  "❤",
  "↔",
  "☺",
  "☺\uFE0E", // FE0E asks for text presentation outright
  "hi 😀",
  "😀!",
  "😀 ok",
  "ok",
  "\u200D", // a lone joiner
  "\uFE0F", // a lone variation selector
  "😀\u200B😀", // a zero-width space is not whitespace
];

describe("emojiCount / isJumboEmoji", () => {
  it("Messages' limit: three", () => {
    expect(JUMBO_MAX).toBe(3);
  });

  it("every single emoji shape counts as exactly one", () => {
    for (const e of SINGLES) {
      expect(emojiCount(e), JSON.stringify(e)).toBe(1);
      expect(isJumboEmoji(e), JSON.stringify(e)).toBe(true);
    }
  });

  it("two and three, joined, spaced, or on their own lines", () => {
    expect(emojiCount("😀😀")).toBe(2);
    expect(emojiCount("😀 😀")).toBe(2);
    expect(emojiCount("🇺🇸🇬🇧")).toBe(2);
    expect(emojiCount("👍🏽\n🎉")).toBe(2);
    expect(emojiCount("🎉🎉🎉")).toBe(3);
    expect(emojiCount("  😀 😂\t🥰 \n")).toBe(3);
    expect(emojiCount("👨‍👩‍👧‍👦🏳️‍🌈1️⃣")).toBe(3);
    for (const t of ["😀😀", "😀 😀", "🎉🎉🎉", "  😀 😂\t🥰 \n"]) {
      expect(isJumboEmoji(t), JSON.stringify(t)).toBe(true);
    }
  });

  it("four or more are counted but are not big", () => {
    expect(emojiCount("😀😀😀😀")).toBe(4);
    expect(isJumboEmoji("😀😀😀😀")).toBe(false);
    expect(isJumboEmoji("🎉 🎉 🎉 🎉 🎉")).toBe(false);
  });

  it("anything that is not drawn as an emoji makes the whole text not emoji-only", () => {
    for (const t of NOT_EMOJI) {
      expect(emojiCount(t), JSON.stringify(t)).toBe(0);
      expect(isJumboEmoji(t), JSON.stringify(t)).toBe(false);
    }
  });

  it("the text-default symbols become big emoji with their FE0F, as the keyboard sends them", () => {
    expect(isJumboEmoji("❤")).toBe(false);
    expect(isJumboEmoji("❤️")).toBe(true);
    expect(isJumboEmoji("™")).toBe(false);
    expect(isJumboEmoji("™️")).toBe(true);
  });

  it("agrees with the engine's grapheme segmentation on every emoji it accepts", () => {
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const graphemes = (t: string): number =>
      [...seg.segment(t)].filter((s) => s.segment.trim() !== "").length;
    const corpus = [
      ...SINGLES,
      ...SINGLES.map((e) => e + e),
      SINGLES.join(""),
      SINGLES.join(" "),
      "🇺🇸🇬🇧🇯🇵",
      "1️⃣2️⃣3️⃣",
      "👍🏽👍🏿👍",
    ];
    for (const t of corpus) expect(emojiCount(t), JSON.stringify(t)).toBe(graphemes(t));
  });

  it("stays fast on a long message: the first word ends the scan", () => {
    const long = "a".repeat(200_000);
    const t0 = performance.now();
    expect(emojiCount(long)).toBe(0);
    expect(emojiCount("😀".repeat(50_000))).toBe(50_000);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("uses no v flag and no RGI_Emoji: the build still targets Safari 14", () => {
    const src = readFileSync(new URL("../src/emoji.ts", import.meta.url), "utf8");
    expect(src).not.toContain("RGI_Emoji");
    expect(src).not.toMatch(/\/[gimsuy]*v[gimsuy]*[,);]/);
    expect(src).not.toMatch(/,\s*"[a-z]*v[a-z]*"\s*\)/);
  });
});

describe("main.ts: every text row goes through the one class helper", () => {
  it("textCls picks the jumbo class off isJumboEmoji and nothing else", () => {
    const body = fnBody("textCls");
    expect(body).toContain("isJumboEmoji(value)");
    expect(body).toContain('"text jumbo"');
    expect(body).toContain('"text"');
  });

  it("the four text render sites all ask it", () => {
    expect(fnBody("renderUser")).toContain('rowEl(wrapper, "user", textCls(value), at)');
    expect(fnBody("renderAgentText")).toContain('rowEl(wrapper, "agent", textCls(value), at)');
    expect(fnBody("send")).toContain('rowEl(w, "user", textCls(text), Date.now())');
    expect(fnBody("restoreOutbox")).toContain('rowEl(w, "user", textCls(rec.text), rec.ts)');
    // and no text row is built the old way anywhere
    expect(main).not.toMatch(/rowEl\([^)]*, "text", /);
  });

  it("a big-emoji reply does not grow out of the dots: arrivalShape takes plain text and error only", () => {
    expect(arrival).toContain('return role === "agent" && (cls === "text" || cls === "error");');
  });
});

describe("styles.css: a big emoji has no bubble and no tail", () => {
  const body = rule(".msg.jumbo");

  it("no fill, the tail's paint transparent too, the page's own text colour", () => {
    expect(body).toMatch(/background:\s*none/);
    expect(body).toMatch(/--fill:\s*transparent/);
    expect(body).toMatch(/color:\s*var\(--text\)/);
  });

  it("about three times the 17px text, from one token", () => {
    expect(body).toMatch(/font-size:\s*var\(--jumbo-size\)/);
    const size = /--jumbo-size:\s*(\d+)px/.exec(css);
    expect(size).not.toBeNull();
    const px = Number(size![1]);
    expect(px / 17).toBeGreaterThanOrEqual(2.6);
    expect(px / 17).toBeLessThanOrEqual(3.2);
  });

  it("the tail pseudo is removed at a specificity above the tail rule's own", () => {
    expect(rule(".msg.jumbo.tail:not(:has(img.waiting))::after")).toMatch(/content:\s*none/);
  });

  it("comes after the role rules, so it wins at equal specificity", () => {
    const jumbo = css.indexOf(".msg.jumbo {");
    expect(jumbo).toBeGreaterThan(css.indexOf(".msg.user {"));
    expect(jumbo).toBeGreaterThan(css.indexOf(".msg.agent {"));
    expect(jumbo).toBeGreaterThan(css.indexOf(".msg.error {"));
  });
});

describe("the big-emoji send: its glyphs fly, not the bar (armGlyphMorph)", () => {
  it("armFieldMorph hands a big-emoji value over before it builds the bar's shell", () => {
    const body = fnBody("armFieldMorph");
    const hand = body.indexOf("if (isJumboEmoji(textEl.value)) return armGlyphMorph(textEl);");
    expect(hand).toBeGreaterThan(-1);
    expect(hand).toBeLessThan(body.indexOf('document.querySelector(".field")'));
  });

  it("send and flyFromField are untouched: the glyph flight rides the bar morph's arm point and launch", () => {
    const send = fnBody("send");
    expect(send).toContain("text ? armFieldMorph(textEl) : null");
    expect(send.indexOf("armFieldMorph(")).toBeLessThan(send.indexOf("collapseBar();"));
    expect(send).not.toContain("armGlyphMorph");
    expect(fnBody("flyFromField")).not.toContain("armGlyphMorph");
  });

  it("the glyphs stand where they were typed, measured before the collapse clears the box", () => {
    const glyph = fnBody("armGlyphMorph");
    expect(glyph).toContain("textEl.getBoundingClientRect()");
    expect(glyph).toContain("textEl.scrollTop");
    expect(glyph).toContain('shell.className = "glyphflight"');
    expect(glyph).toContain("document.body.appendChild(shell)");
  });

  it("flies on the send's own beat and curve, re-reading the seat every frame", () => {
    const glyph = fnBody("armGlyphMorph");
    expect(glyph).toContain("FLIGHT_MS");
    expect(glyph).toContain("const p = flightEase(f);");
    const step = glyph.slice(glyph.indexOf("const step = "));
    expect(step).toContain("msg.getBoundingClientRect()");
    expect(step).toContain("s0 + (1 - s0) * p");
    expect(step).toContain("requestAnimationFrame(step)");
    // every frame is one transform write: the translate and the scale together
    expect(glyph).toMatch(/shell\.style\.transform = `translate\(.*\) scale\(\$\{/);
  });

  it("grows by a uniform scale from the typed size: glyphs have no corners to distort", () => {
    const glyph = fnBody("armGlyphMorph");
    expect(glyph).toMatch(/const s0 = typedSize \/ size;/);
    expect(glyph).not.toContain("scaleX");
    expect(glyph).not.toContain("scaleY");
  });

  it("the real row is hidden until the landing, then handed back clean, and the flight is counted", () => {
    const glyph = fnBody("armGlyphMorph");
    expect(glyph).toContain('msg.style.opacity = "0"');
    expect(glyph).toContain('msg.style.removeProperty("opacity")');
    expect(glyph).toContain("flightsUp++");
    expect(glyph).toContain("flightSettled()");
    expect(glyph).toContain("if (!msg.isConnected)");
    expect(glyph).toContain("shell.remove()");
  });

  it("has no bubble face of any kind, in flight or at the landing", () => {
    const glyph = fnBody("armGlyphMorph");
    expect(glyph).not.toContain("morph-face");
    expect(glyph).not.toContain("tailShell");
    const body = rule(".glyphflight");
    expect(body).not.toMatch(/background/);
    expect(body).toMatch(/position:\s*fixed/);
    expect(body).toMatch(/pointer-events:\s*none/);
    expect(body).toMatch(/transform-origin:\s*0 0/);
    expect(body).toMatch(/white-space:\s*pre-wrap/);
  });
});
