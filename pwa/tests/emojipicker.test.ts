// The emoji picker: the smiley at the bar's right end and the compact panel it
// opens (a recent row and a curated static grid). Its rules are the ones the
// keyboard regime depends on, so they are pinned hard:
//   - a pick never moves focus (the smiley and the panel wear the send arrow's
//     shield), so the keyboard stays up if it was up and never rises if not;
//   - with the box focused the emoji goes in the way a typed character does
//     (the insertText command, native beforeinput and input), otherwise it is
//     spliced at the remembered selection and the same input event is fired;
//   - the panel sits outside the form, so a scroll of the grid can never read
//     as the bar's swipe-down-to-dismiss;
//   - nothing is fetched and no emoji library is bundled.
// Pure helpers are tested directly; the DOM wiring is pinned on the source,
// like the rest of the suite (main.ts cannot load under node).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECENT,
  EMOJI_GROUPS,
  RECENT_CAP,
  RECENT_KEY,
  emojiCount,
  pushRecent,
  readRecent,
  recentRow,
  spliceAtCaret,
} from "../src/emoji";
import { insertAtCaret, type CaretBox } from "../src/emojipicker";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
const pickerSrc = readFileSync(new URL("../src/emojipicker.ts", import.meta.url), "utf8");
const emojiSrc = readFileSync(new URL("../src/emoji.ts", import.meta.url), "utf8");

function fnBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `missing ${name}`).toBeGreaterThan(-1);
  const end = src.indexOf("\n}", start);
  return src.slice(start, end);
}

function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing ${selector} rule`).toBeGreaterThanOrEqual(0);
  const body = css.slice(start + selector.length + 2);
  return body.slice(0, body.indexOf("}"));
}

describe("the curated grid", () => {
  const all = EMOJI_GROUPS.flatMap((g) => [...g.emoji]);

  it("is a static list of named groups, each a whole number of eight-wide rows", () => {
    expect(EMOJI_GROUPS.length).toBeGreaterThanOrEqual(4);
    for (const g of EMOJI_GROUPS) {
      expect(g.name.length).toBeGreaterThan(0);
      expect(g.emoji.length % 8, g.name).toBe(0);
    }
    expect(all.length).toBeGreaterThanOrEqual(64);
    expect(all.length).toBeLessThanOrEqual(160); // compact, not a keyboard
  });

  it("every cell is exactly one emoji by the big-emoji rule, and none repeats", () => {
    for (const e of all) expect(emojiCount(e), JSON.stringify(e)).toBe(1);
    expect(new Set(all).size).toBe(all.length);
  });

  it("the default recent row is eight grid emoji", () => {
    expect(DEFAULT_RECENT.length).toBe(RECENT_CAP);
    expect(RECENT_CAP).toBe(8);
    for (const e of DEFAULT_RECENT) expect(all, e).toContain(e);
  });

  it("no library, no network: neither module imports a package or fetches", () => {
    for (const src of [pickerSrc, emojiSrc]) {
      expect(src).not.toMatch(/from\s+"(?!\.\/)/); // only relative imports
      expect(src).not.toContain("fetch(");
      expect(src).not.toContain("import(");
    }
  });
});

describe("recents", () => {
  it("the newest goes first, a repeat moves up instead of doubling, and the list stays at eight", () => {
    expect(pushRecent([], "😀")).toEqual(["😀"]);
    expect(pushRecent(["👍", "😀", "🔥"], "😀")).toEqual(["😀", "👍", "🔥"]);
    const full = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣"];
    expect(pushRecent(full, "🎉")).toEqual(["🎉", ...full.slice(0, 7)]);
  });

  it("reading storage never throws and keeps only single emoji, deduped, capped", () => {
    expect(readRecent(null)).toEqual([]);
    expect(readRecent("")).toEqual([]);
    expect(readRecent("not json")).toEqual([]);
    expect(readRecent('{"a":1}')).toEqual([]);
    expect(readRecent('["😀", 3, "hello", "😀😀", "", "👍", "😀"]')).toEqual(["😀", "👍"]);
    const many = JSON.stringify(EMOJI_GROUPS[0].emoji.slice(0, 20));
    expect(readRecent(many).length).toBe(RECENT_CAP);
  });

  it("the row is always full: his recents first, the defaults after, no repeats", () => {
    expect(recentRow([])).toEqual([...DEFAULT_RECENT]);
    const row = recentRow(["🦄", "👍"]);
    expect(row.length).toBe(RECENT_CAP);
    expect(row.slice(0, 2)).toEqual(["🦄", "👍"]);
    expect(new Set(row).size).toBe(row.length);
  });

  it("is stored under the app's own key prefix", () => {
    expect(RECENT_KEY).toBe("paratrooper:emoji-recent");
  });
});

describe("spliceAtCaret", () => {
  it("inserts at a caret, replaces a selection, and leaves the caret after the insert", () => {
    expect(spliceAtCaret("", 0, 0, "😀")).toEqual({ value: "😀", caret: 2 });
    expect(spliceAtCaret("hi there", 2, 2, "😀")).toEqual({ value: "hi😀 there", caret: 4 });
    expect(spliceAtCaret("hi there", 3, 8, "👍🏽")).toEqual({ value: "hi 👍🏽", caret: 7 });
  });

  it("clamps a selection the value no longer has", () => {
    expect(spliceAtCaret("ab", 9, 9, "😀")).toEqual({ value: "ab😀", caret: 4 });
    expect(spliceAtCaret("ab", 2, 1, "😀")).toEqual({ value: "ab😀", caret: 4 });
  });
});

// a textarea's caret surface, recorded
class FakeBox implements CaretBox {
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  events: string[] = [];
  constructor(value: string, start: number | null, end: number | null = start) {
    this.value = value;
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  setSelectionRange(a: number, b: number): void {
    this.selectionStart = a;
    this.selectionEnd = b;
  }
  dispatchEvent(e: Event): boolean {
    this.events.push(`${e.type}:${e.bubbles}`);
    return true;
  }
}

describe("insertAtCaret", () => {
  it("focused: the emoji goes in as typed text, through the command, and nothing else is written", () => {
    const box = new FakeBox("hi", 1);
    const typed: string[] = [];
    const how = insertAtCaret(box, "😀", true, (t) => {
      typed.push(t);
      box.value = "h😀i"; // what the engine does with the command
      return true;
    });
    expect(how).toBe("typed");
    expect(typed).toEqual(["😀"]);
    expect(box.events).toEqual([]); // the engine fires its own input
  });

  it("focused but the command refused or did nothing: spliced, and the input event fired", () => {
    for (const command of [() => false, () => true]) {
      const box = new FakeBox("hi", 1);
      expect(insertAtCaret(box, "😀", true, command)).toBe("spliced");
      expect(box.value).toBe("h😀i");
      expect([box.selectionStart, box.selectionEnd]).toEqual([3, 3]);
      expect(box.events).toEqual(["input:true"]);
    }
  });

  it("blurred: never the command (there is no caret to type at), spliced at the kept selection", () => {
    const box = new FakeBox("hello world", 5, 11);
    let asked = false;
    expect(insertAtCaret(box, "🎉", false, () => (asked = true))).toBe("spliced");
    expect(asked).toBe(false);
    expect(box.value).toBe("hello🎉");
    expect(box.selectionStart).toBe(7);
    expect(box.events).toEqual(["input:true"]);
  });

  it("a box that never had a selection gets the emoji at the end", () => {
    const box = new FakeBox("ok", null);
    insertAtCaret(box, "👍", false, () => false);
    expect(box.value).toBe("ok👍");
  });
});

describe("the DOM half (emojipicker.ts)", () => {
  const bind = fnBody(pickerSrc, "bindEmojiPicker");

  it("the command is the insertText one, and only for a focused box", () => {
    expect(pickerSrc).toContain('document.execCommand("insertText", false, text)');
    expect(fnBody(pickerSrc, "pick")).toContain("document.activeElement === editor");
  });

  it("the recent row redraws on open, never under the finger", () => {
    const open = bind.slice(bind.indexOf("open(): void"));
    expect(open.slice(0, 200)).toContain("drawRecent(");
    const pick = fnBody(pickerSrc, "pick");
    expect(pick).not.toContain("drawRecent(");
    expect(pick).toContain("pushRecent(");
  });

  it("closes on a pointerdown outside it or the smiley, and on Escape, from one document listener", () => {
    expect(pickerSrc).toMatch(/document\.addEventListener\(\s*"pointerdown"/);
    expect(pickerSrc).toMatch(/"keydown"/);
    expect(pickerSrc).toContain('"Escape"');
    expect(pickerSrc).toContain("listening"); // installed once, however many renders bind a picker
  });

  it("storage is best-effort: every read and write is caught", () => {
    const reads = pickerSrc.match(/localStorage\.(getItem|setItem)/g) ?? [];
    expect(reads.length).toBeGreaterThan(0);
    expect(pickerSrc.match(/try \{/g)!.length).toBeGreaterThanOrEqual(reads.length);
  });

  it("builds cells from its own constants with textContent, never markup", () => {
    expect(pickerSrc).not.toContain("innerHTML");
    expect(pickerSrc).toContain("textContent");
  });
});

describe("main.ts wiring", () => {
  const chat = fnBody(main, "renderChat");

  it("the smiley is in the form after the pill; the panel is in the lift but outside the form", () => {
    const field = chat.indexOf('<div class="field">');
    const btn = chat.indexOf('id="emoji"');
    const formStart = chat.indexOf('<form id="compose"');
    const formEnd = chat.indexOf("</form>");
    const lift = chat.indexOf('<div class="lift">');
    const threadEnd = chat.indexOf("</main>");
    const panel = chat.indexOf('id="emojipanel"');
    expect(field).toBeGreaterThan(-1);
    expect(btn).toBeGreaterThan(field);
    expect(btn).toBeLessThan(formEnd);
    // after the thread, before the form: inside the lift, never inside the form
    expect(panel).toBeGreaterThan(lift);
    expect(panel).toBeGreaterThan(threadEnd);
    expect(panel).toBeLessThan(formStart);
    expect(chat).toContain('class="emojibtn"');
    expect(chat).toContain('aria-controls="emojipanel"');
  });

  it("the smiley's face is a font glyph, like every other mark in the bar", () => {
    const tag = chat.slice(chat.indexOf('id="emoji"'), chat.indexOf("</button>", chat.indexOf('id="emoji"')));
    expect(tag).toContain('class="emojiglyph"');
    expect(tag).not.toContain("<svg");
    expect(emojiCount(/>([^<]+)<\/span>/.exec(tag)![1])).toBe(1);
  });

  it("the smiley does not wear the plus's class: the widening reads .attach by name", () => {
    const tag = chat.slice(chat.lastIndexOf("<button", chat.indexOf('id="emoji"')), chat.indexOf("</button>", chat.indexOf('id="emoji"')));
    expect(tag).not.toContain("attach");
  });

  it("no inline style attribute in the chat's markup (the page's style policy is hashed)", () => {
    const markup = chat.slice(chat.indexOf("app.innerHTML = `"), chat.indexOf("</div>`;"));
    expect(markup).not.toMatch(/\sstyle="/);
  });

  it("both carry the focus shield, and the picker is bound to the compose box", () => {
    expect(chat).toContain("bindFocusShield(emojiBtn)");
    expect(chat).toContain("bindFocusShield(emojiPanel)");
    expect(chat).toContain("bindEmojiPicker(emojiBtn, emojiPanel, textEl)");
  });
});

describe("shell.ts bindFocusShield", () => {
  it("is the send arrow's rule: prevent the pointerdown only while an editor holds focus", () => {
    const body = fnBody(shell, "bindFocusShield");
    expect(body).toContain('addEventListener("pointerdown"');
    expect(body).toContain("if (preservesFocus(readWorld())) e.preventDefault();");
    // and the send arrow's own shield is untouched
    expect(fnBody(shell, "bindSendShield")).toContain(
      "if (preservesFocus(readWorld())) e.preventDefault();",
    );
  });
});

describe("styles.css", () => {
  it("the smiley is the plus's 34px glass circle with the same 44px tap square", () => {
    const b = rule(".emojibtn");
    expect(b).toMatch(/width:\s*34px/);
    expect(b).toMatch(/height:\s*34px/);
    expect(b).toMatch(/border-radius:\s*50%/);
    expect(b).toMatch(/box-shadow:\s*var\(--glass-stack-sm\)/);
    expect(b).toMatch(/flex:\s*none/);
    expect(b).toMatch(/margin-bottom:\s*2\.5px/); // the plus's optical centre on the pill
    expect(rule(".emojibtn::after")).toMatch(/inset:\s*-5px/);
  });

  it("the panel floats above the bar, off the pill's live height, hidden until .open", () => {
    const p = rule(".emojipanel");
    expect(p).toMatch(/position:\s*absolute/);
    expect(p).toMatch(/bottom:\s*calc\(var\(--pad-b\) \+ var\(--field-h, 39px\)/);
    expect(p).toMatch(/visibility:\s*hidden/);
    expect(p).toMatch(/pointer-events:\s*none/);
    expect(p).toMatch(/background:\s*var\(--menu-bg\)/);
    const open = rule(".emojipanel.open");
    expect(open).toMatch(/visibility:\s*visible/);
    expect(open).toMatch(/pointer-events:\s*auto/);
  });

  it("the grid scrolls on its own and never hands the scroll on", () => {
    const g = rule(".emojiscroll");
    expect(g).toMatch(/overflow-y:\s*auto/);
    expect(g).toMatch(/overscroll-behavior:\s*contain/);
    expect(g).toMatch(/touch-action:\s*pan-y/);
  });
});
