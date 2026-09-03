// Pins for the LOOK of the sign-in screen: what the card shows, and what its
// button is painted with (main.ts renderTokenGate, plus the token-gate rules
// and the bar's badge rules in styles.css). How that same card rides the
// keyboard is shell.test.ts's business; nothing here is about motion.
//
// The card used to open with a bare <h1>Paratrooper</h1> over a sentence, a
// hinted token box and a rounded button in the legacy iOS blue. It now opens
// with the chat's OWN badge — the trooper, the name, the version line under it
// — so the mark you sign in under is the mark you go on to message under, and
// Connect is the sent bubble worn as a pill.
//
// Almost nothing below names a value it wants. The badge is pinned by being
// required to be the same markup and the same rules the bar already renders,
// and the button by being required to repeat the sent bubble's own
// declarations, in the mould of prtone.test.ts — so neither can quietly become
// a lookalike free to drift. The one number pinned outright is the pill's
// radius, and it is pinned against the radius the notification pills wear.
//
// The card then grew into a login page rather than a strip: the badge is the
// bar's badge MULTIPLIED by one declared factor, the sentence and the box read
// as a pair, the sentence is SET as the ask instead of left at the body type a
// <p> inherits, the box is a share of the card, and the build stamp is gone.
// Those are pinned the same way — as relationships (the bar's figure times the
// one dial, above-gap against below-gap, a percentage inside a range, a size
// and a weight between the app's body type and the badge's name), so the look
// can be tuned without rewriting the pins and cannot be undone without hitting
// one.
//
// Source-parsed, like the other presentation pins: the cascade is the engine's
// and jsdom resolves none of these sheets.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const push = readFileSync(new URL("../src/push.css", import.meta.url), "utf8");

interface Rule {
  selectors: string[]; // the rule's selector list, one entry per comma
  body: string;
  at: string[]; // the at-rule blocks it sits inside, outermost first
}

/** Every rule in a sheet, with the at-rule blocks it is nested in. */
function parse(sheet: string): Rule[] {
  const src = sheet.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = [];
  const open: string[] = [];
  let head = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") {
      const selector = head.replace(/\s+/g, " ").trim();
      head = "";
      if (selector.startsWith("@")) {
        open.push(selector);
        continue;
      }
      const end = src.indexOf("}", i); // no rule in these sheets nests
      expect(end, `unclosed rule: ${selector}`).toBeGreaterThan(i);
      out.push({
        selectors: selector.split(",").map((one) => one.trim()),
        body: src.slice(i + 1, end),
        at: [...open],
      });
      i = end; // skip the close, so it never pops an at-rule
    } else if (ch === "}") {
      open.pop();
      head = "";
    } else head += ch;
  }
  return out;
}

const styleRules = parse(css);
const pushRules = parse(push);

/** Every rule whose selector list contains exactly this selector. */
const matching = (rules: Rule[], sel: string): Rule[] =>
  rules.filter((r) => r.selectors.includes(sel));

/** The single rule that selector belongs to — and there had better be one. */
function one(rules: Rule[], sel: string): Rule {
  const hits = matching(rules, sel);
  expect(hits, `expected exactly one rule for ${sel}`).toHaveLength(1);
  return hits[0];
}

/** One declaration out of a rule body, whitespace flattened. */
function decl(body: string, property: string): string {
  const m = new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]*)`).exec(body);
  expect(m, `missing ${property}`).not.toBeNull();
  return m![1].replace(/\s+/g, " ").trim();
}

/** Whether a rule body declares this property at all. */
const declares = (body: string, property: string): boolean =>
  new RegExp(`(?:^|;)\\s*${property}\\s*:`).test(body);

/** The name of the card's one badge dial — nothing else may size the badge. */
const SCALE = "--gate-badge-scale";

/** The bar's own figure, out of a size written as that figure times the dial.
 *  Fails unless the property IS that multiplication, falling back to 1 — which
 *  is what keeps the bar, where the dial is never declared, exactly as it was. */
function scaled(body: string, property: string): number {
  const value = decl(body, property);
  const m = new RegExp(`^calc\\(([\\d.]+)px \\* var\\(${SCALE}, 1\\)\\)$`).exec(value);
  expect(m, `${property} must be the bar's value times ${SCALE}, not ${value}`).not.toBeNull();
  return Number(m![1]);
}

const bubble = one(styleRules, ".msg.user").body; // the user's own messages
const fill = decl(bubble, "background"); // what they are filled with
const ink = decl(bubble, "color"); // what they write on that fill

// the card's markup, and every badge in the app: the bar renders one, the
// sign-in card renders the other, and nothing else renders any
const gate = /function renderTokenGate\(\)[\s\S]*?\n\}/.exec(main)?.[0] ?? "";
const badges = main.match(/<div class="contact">[\s\S]*?<\/div>\s*<\/div>/g) ?? [];

describe("the sign-in card wears the chat's own badge", () => {
  it("renders the bar's badge character for character, not a second copy of it", () => {
    expect(gate, "renderTokenGate not found").not.toBe("");
    expect(badges).toHaveLength(2); // the card and the bar, and nowhere else
    expect(badges[0]).toBe(badges[1]); // same image, same classes, same version
    expect(gate).toContain(badges[0]);
  });

  it("the badge is the trooper, the name, and the version straight off APP_VERSION", () => {
    const badge = badges[0];
    expect(badge).toContain('<img class="avatar" src="/topbar-logo.png" alt="" />');
    expect(badge).toContain('<span class="title">Paratrooper</span>');
    // the number is read, never written: the card cannot show a stale version
    expect(badge).toContain('<span class="ver">v${APP_VERSION}</span>');
    expect(main).toMatch(/^const APP_VERSION = "\d+\.\d+\.\d+";/m);
  });

  it("the badge leads the card, in place of the heading it replaced", () => {
    expect(gate).toContain('<div class="gate">\n      <div class="contact">');
    expect(gate).not.toMatch(/<h1/); // the name comes from the badge now
  });

  it("the name and the version line are one declaration with two homes", () => {
    // not a .gate copy of the bar's values — the bar's own rules, widened to
    // reach this card, so the two can never be given different type again
    expect(one(styleRules, ".gate .title").selectors).toEqual([".bar .title", ".gate .title"]);
    const ver = one(styleRules, ".gate .ver");
    expect(ver.selectors).toEqual([".bar .ver", ".gate .ver"]);
    expect(decl(ver.body, "color")).toBe("var(--muted)"); // grey, the bar's grey
    expect(matching(styleRules, ".bar .title")).toHaveLength(1);
    expect(matching(styleRules, ".bar .ver")).toHaveLength(1);
  });

  it("the rest of the badge was never scoped to the bar, so it needs no second rule", () => {
    for (const sel of [".contact", ".avatar", ".ident"]) {
      expect(matching(styleRules, sel), `${sel} should be declared once`).toHaveLength(1);
      expect(css).not.toContain(`.gate ${sel}`); // nothing re-states it for the card
    }
    // the faint header tag is unscoped too, and one rule: whatever it fades
    // the version line to, it fades it to the same thing on both screens
    expect(matching(styleRules, ".ver")).toHaveLength(1);
    expect(one(styleRules, ".ver").body).toContain("opacity:");
  });
});

// The same badge is a strip on a bar and the TITLE of the sign-in page, so it
// is not restated at a bigger size — it is multiplied. One factor is declared
// on the card, custom properties inherit it into every part of the badge, and
// each of the badge's rules is the bar's own figure times that factor with a
// fallback of 1. So there is exactly one number to change, the proportions are
// the bar's by construction, and the bar — which never declares the factor —
// cannot be moved by any of it.
describe("the badge is the bar's badge, multiplied", () => {
  const card = one(styleRules, ".gate").body;

  it("one factor, declared once, and only on the card", () => {
    const factor = Number(decl(card, SCALE));
    expect(factor).toBeGreaterThanOrEqual(1.6); // a title, not a strip
    expect(factor).toBeLessThanOrEqual(2);
    // one declaration in the whole sheet: no second dial to fall out of step
    expect(css.match(new RegExp(`${SCALE}\\s*:`, "g"))).toHaveLength(1);
    expect(one(styleRules, ".gate").at).toEqual([]); // and not per appearance
  });

  it("the logo, the name and the version are the bar's own figures times it", () => {
    expect(scaled(one(styleRules, ".avatar").body, "height")).toBe(48);
    expect(scaled(one(styleRules, ".gate .title").body, "font-size")).toBe(13);
    expect(scaled(one(styleRules, ".gate .ver").body, "font-size")).toBe(9);
    // the gap the badge is built on rides it too, so the block grows as one
    expect(scaled(one(styleRules, ".contact").body, "gap")).toBe(5);
    // nothing in the badge states a size the factor cannot reach
    expect(declares(one(styleRules, ".avatar").body, "font-size")).toBe(false);
    expect(one(styleRules, ".ident").body).not.toMatch(/font-size|height/);
  });

  it("the lines follow the type, so the block keeps the bar's shape", () => {
    // unitless multipliers: a px line-height would hold bar-sized rows under
    // title-sized letters and the badge would grow out of proportion
    for (const sel of [".gate .title", ".gate .ver"]) {
      expect(decl(one(styleRules, sel).body, "line-height")).toMatch(/^[\d.]+$/);
    }
    expect(decl(one(styleRules, ".avatar").body, "width")).toBe("auto"); // aspect, not a box
  });

  it("the top bar is untouched: it never declares the factor, so it takes the 1", () => {
    // the fallback IS the bar's rendering — every scaled rule carries it, and
    // no rule scoped to the bar or above it sets the dial to anything
    for (const rule of styleRules) {
      if (!declares(rule.body, SCALE)) continue;
      expect(rule.selectors, `${SCALE} may only be set on the card`).toEqual([".gate"]);
    }
    expect(css).not.toContain(`.bar { ${SCALE}`);
  });
});

describe("the sign-in card's copy and its token box", () => {
  it("asks for the token in the one sentence it was given", () => {
    expect(gate).toContain("<p>Your access token please?</p>");
    expect(main).not.toContain("Enter your access token to connect.");
  });

  it("the token box is still a password field and shows nothing inside it", () => {
    const input = /<input id="token-input"[^>]*\/>/.exec(gate)?.[0] ?? "";
    expect(input, "token box not found").not.toBe("");
    expect(input).toContain('type="password"'); // what is typed stays hidden
    expect(input).not.toContain("placeholder"); // and no grey hint sits in it
    expect(input).toContain('autocomplete="off"');
    // the app's only placeholder is the composer's dispatch prompt
    expect(main.match(/placeholder=/g)).toHaveLength(1);
  });

  it("the box is marked as one the app focuses itself, the same as the chat's", () => {
    // markup, so it belongs here; what the mark DOES is shell.test.ts's, and
    // this pin exists so the attribute is never read as decoration and dropped
    const input = /<input id="token-input"[^>]*\/>/.exec(gate)?.[0] ?? "";
    expect(input).toContain("data-owned-focus");
    expect(main).toContain('<textarea id="text" rows="1" data-owned-focus'); // the other one
    // and no third: read off the tags, so the list is every marked element
    const marked = [...main.matchAll(/<(\w+)[^>]*\sdata-owned-focus[\s/>]/g)];
    expect(marked.map((m) => m[1])).toEqual(["input", "textarea"]);
  });

  it("no build stamp in the gate", () => {
    // the version is already on the badge; a build timestamp is not something a
    // login screen says. The paragraph is gone and so is the rule it wore —
    // nothing else in the app ever carried the class
    expect(gate).not.toContain("buildstamp");
    expect(gate).not.toContain("__BUILT_AT__"); // the stamp's text went with it
    expect(css).not.toContain("buildstamp");
    expect(main).not.toContain("buildstamp");
    // the stamp itself lives on, where it is actually read: the boot log
    expect(main).toContain("__BUILT_AT__"); // and the console line still prints it
  });

  it("the box is a share of the card's width, written as a share", () => {
    // full width ran the field wall to wall and read as a form; trimmed at both
    // ends it reads as one thing to fill in. A percentage, so it is the card's
    // own measure at every text size and on every screen — never a phone number
    const box = one(styleRules, ".gate input").body;
    const share = /^([\d.]+)%$/.exec(decl(box, "width"));
    expect(share, "the box's width must be a percentage of the card").not.toBeNull();
    expect(Number(share![1])).toBeGreaterThanOrEqual(65);
    expect(Number(share![1])).toBeLessThanOrEqual(80);
    // and it is seated by the card's own centring, not by a margin of its own
    expect(decl(one(styleRules, ".gate").body, "text-align")).toBe("center");
    expect(decl(box, "margin")).not.toContain("auto");
  });

  it("the sentence breaks from the badge and sits tight to the box", () => {
    // the ask and the field it asks for are a pair; the badge above them is not
    const gaps = /^([\d.]+)rem 0 ([\d.]+)rem$/.exec(decl(one(styleRules, ".gate p").body, "margin"));
    expect(gaps, "the gate's own paragraph gaps must be in rem").not.toBeNull();
    const [above, below] = [Number(gaps![1]), Number(gaps![2])];
    expect(above).toBeGreaterThan(1); // more than the 1em the browser used to give it
    expect(below * 3).toBeLessThan(above); // and MUCH less underneath: one pair
    // nothing puts the pair back apart: the box adds no top margin of its own
    const boxGaps = /^0 0 ([\d.]+)rem$/.exec(decl(one(styleRules, ".gate input").body, "margin"));
    expect(boxGaps, "the box's own gaps must be in rem, and none above").not.toBeNull();
    // the sentence-to-box gap stays the smallest thing on the card
    expect(below).toBeLessThan(Number(boxGaps![1]));
    // and the shared paragraph rules were not touched to get any of this
    expect(matching(styleRules, "p")).toHaveLength(0);
  });

  it("the sentence is set as the ask, between the app's body type and the badge", () => {
    // left alone, a <p> is the thread's own type and the one line this screen
    // says reads as leftover prose. It is stepped up in both dials — and only
    // stepped: the name above it is still the card's title. Both ends of the
    // range are the sheet's own figures, so neither can be tuned past the other
    const ask = one(styleRules, ".gate p").body;
    const body = Number(/^([\d.]+)px\//.exec(decl(one(styleRules, "body").body, "font"))![1]);
    const rem = /^([\d.]+)rem$/.exec(decl(ask, "font-size"));
    expect(rem, "the ask's size must be in rem, like every measure on this card").not.toBeNull();
    const size = Number(rem![1]) * body; // rem IS the app's text size: html sets it
    expect(size).toBeGreaterThan(body); // no longer the type it inherited
    const title = one(styleRules, ".gate .title").body;
    expect(size).toBeLessThan(scaled(title, "font-size") * Number(decl(one(styleRules, ".gate").body, SCALE)));
    const weight = Number(decl(ask, "font-weight"));
    expect(weight).toBeGreaterThan(400); // heavier than the regular it inherited
    expect(weight).toBeLessThan(Number(decl(title, "font-weight"))); // lighter than the name
    // and that is the whole treatment: the app's own face, at the app's own
    // colour. Naming either here would be a second copy of a decision made once
    expect(declares(ask, "font-family"), "no face of its own").toBe(false);
    expect(declares(ask, "color"), "the ask stays --text, not the version line's grey").toBe(false);
    expect(ask).not.toMatch(/#[0-9a-fA-F]{3,8}|rgb|hsl/);
  });

  it("nothing about saving the token or connecting moved", () => {
    expect(gate).toContain('document.getElementById("token-save")!.addEventListener("click"');
    expect(gate).toContain("localStorage.setItem(TOKEN_KEY, value)");
    expect(gate).toContain("renderChat();");
    expect(gate).toContain("connect();");
  });
});

describe("Connect is the sent bubble worn as a pill", () => {
  it("is the bubble's fill with the bubble's ink on it", () => {
    const btn = one(styleRules, ".gate button").body;
    expect(decl(btn, "background")).toBe(fill);
    expect(decl(btn, "color")).toBe(ink);
    // tokens on both sides, so neither can be a colour that drifts
    expect(fill).toBe("var(--accent)");
    expect(ink).toBe("var(--sent-text)");
    // and the legacy iOS blue and the literal white it wore before are gone
    expect(btn).not.toContain("var(--sent)");
    expect(btn).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(gate).toContain('<button id="token-save">Connect</button>'); // same label
  });

  it("is a full pill, at the radius the notification pills already wear", () => {
    const pill = decl(one(pushRules, ".push-actions button").body, "border-radius");
    expect(pill).toBe("999px"); // past any height this button can take
    expect(decl(one(styleRules, ".gate button").body, "border-radius")).toBe(pill);
  });

  it("no appearance re-colours the button or the badge", () => {
    // one value each, wherever the scheme lands: nothing here is restated
    // inside a prefers-color-scheme block, in either sheet
    const nested = [...styleRules, ...pushRules]
      .filter((r) => r.at.some((at) => at.includes("prefers-color-scheme")))
      .flatMap((r) => r.selectors);
    expect(nested.length).toBeGreaterThan(0); // the blocks exist, so this bites
    for (const sel of [".gate button", ".gate .title", ".gate .ver", ".avatar", ".contact"]) {
      expect(nested, `${sel} must not be re-coloured`).not.toContain(sel);
    }
  });
});

describe("the trooper on the sign-in card carries no box", () => {
  it("the image itself declares nothing that could paint behind it", () => {
    const avatar = one(styleRules, ".avatar");
    expect(avatar.at).toEqual([]); // and not from inside an appearance block
    for (const prop of [
      "background",
      "background-color",
      "background-image",
      "border",
      "border-radius",
      "box-shadow",
      "backdrop-filter",
      "outline",
      "filter",
    ]) {
      expect(declares(avatar.body, prop), `.avatar must not declare ${prop}`).toBe(false);
    }
    // natural aspect, no crop: a cut-out figure, sized by its height alone
    expect(decl(avatar.body, "width")).toBe("auto");
  });

  it("and nothing else paints one behind it, on either screen", () => {
    const painted = [...styleRules, ...pushRules].filter(
      (r) =>
        r.selectors.some((s) => s.includes(".avatar") || s.includes(".contact")) &&
        /background|border|box-shadow|backdrop-filter/.test(r.body),
    );
    expect(painted.map((r) => r.selectors.join(", "))).toEqual([]);
  });
});
