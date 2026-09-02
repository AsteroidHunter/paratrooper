// Pins for how the notification card presents itself: what its two pills are
// painted with, and how it arrives on screen. The wiring — which state shows
// which copy, what each button is allowed to call — is push.test.ts's job.
//
// Neither half names a value it wants. The colours are read out of the sent
// bubble at run time and the card is required to repeat them, in the mould of
// prtone.test.ts, so a copied hex cannot drift away from the bubble again. The
// entrance is checked for a property of its curve rather than for one curve:
// it has to start and end at rest and never pass its destination, which is
// what "gentle" means here, and it has to stay short.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const push = readFileSync(new URL("../src/push.css", import.meta.url), "utf8");

interface Rule {
  selectors: string[]; // the rule's selector list, one entry per comma
  body: string;
  at: string[]; // the at-rule blocks it sits inside, outermost first
  index: number; // where it starts in the sheet, for source-order questions
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
      const end = src.indexOf("}", i); // nothing in these sheets nests
      expect(end, `unclosed rule: ${selector}`).toBeGreaterThan(i);
      out.push({
        selectors: selector.split(",").map((one) => one.trim()),
        body: src.slice(i + 1, end),
        at: [...open],
        index: i,
      });
      i = end; // skip the close, so it never pops an at-rule
    } else if (ch === "}") {
      open.pop();
      head = "";
    } else head += ch;
  }
  return out;
}

const pushRules = parse(push);

/** Every rule whose selector list contains exactly this selector. */
function rules(sheet: Rule[], selector: string): Rule[] {
  return sheet.filter((r) => r.selectors.includes(selector));
}

/** The one such rule that is not inside an at-rule. */
function only(sheet: Rule[], selector: string): Rule {
  const found = rules(sheet, selector).filter((r) => r.at.length === 0);
  expect(found, `expected exactly one plain ${selector} rule`).toHaveLength(1);
  return found[0];
}

/** One declaration out of a rule body, whitespace flattened. */
function decl(body: string, property: string): string {
  const m = new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]*)`).exec(body);
  expect(m, `missing ${property}`).not.toBeNull();
  return m![1].replace(/\s+/g, " ").trim();
}

const bubble = only(parse(styles), ".msg.user"); // the user's own message
const fill = decl(bubble.body, "background"); // what it is filled with
const ink = decl(bubble.body, "color"); // what it writes on that fill

describe("the notification card's pills are painted out of the sent bubble", () => {
  it("the bubble states its colours as tokens, so they can be shared", () => {
    // literals here would leave the rules below as copies of a colour, and a
    // copy is what let the card keep the legacy blue after the bubbles moved
    expect(fill).toMatch(/^var\(--[\w-]+\)$/);
    expect(ink).toMatch(/^var\(--[\w-]+\)$/);
  });

  it("Enable is the bubble: its fill, with the bubble's own ink on it", () => {
    const action = only(pushRules, ".push-action");
    expect(decl(action.body, "background")).toBe(fill);
    expect(decl(action.body, "color")).toBe(ink);
  });

  it("Not Now stays the secondary one but takes its label from that fill", () => {
    const notNow = only(pushRules, ".push-not-now");
    expect(decl(notNow.body, "color")).toBe(fill);
    // still a plain neutral wash, so the pair reads as primary and secondary
    // rather than as two solid accents side by side
    const wash = decl(notNow.body, "background");
    expect(wash).toMatch(/^rgba\(/);
    expect(wash).not.toBe(fill);
  });

  it("nothing in the card names the legacy blue any more", () => {
    expect(push).not.toMatch(/var\(--sent\)/); // --sent-text, the ink, is fine
  });

  it("no appearance gets to re-colour either pill", () => {
    const schemes = pushRules.filter((r) =>
      r.at.some((a) => a.includes("prefers-color-scheme")),
    );
    expect(schemes.length).toBeGreaterThan(0); // the guard has something to guard
    expect(rules(pushRules, ".push-action").filter((r) => r.at.length)).toHaveLength(0);
    // dark may still deepen the neutral wash behind Not Now; it may not touch
    // the label, which resolves to the bubble's fill in both appearances
    for (const scheme of rules(pushRules, ".push-not-now").filter((r) => r.at.length)) {
      expect(scheme.body).not.toMatch(/(?:^|;)\s*color\s*:/);
    }
  });

  it("those two rules are the buttons the dialog actually renders", () => {
    expect(main).toContain('<div class="push-actions">');
    expect(main).toContain('id="push-not-now" class="push-not-now"');
    expect(main).toContain('id="push-action" class="push-action"');
  });
});

type Curve = [number, number, number, number];

/** The standard easings, as the spec defines their control points. */
const KEYWORDS: Record<string, Curve> = {
  linear: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1],
  "ease-in": [0.42, 0, 1, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
};

function curve(easing: string): Curve {
  const bezier = /^cubic-bezier\(([^)]*)\)$/.exec(easing);
  if (bezier) {
    const points = bezier[1].split(",").map((n) => Number(n.trim()));
    expect(points, `unreadable easing: ${easing}`).toHaveLength(4);
    for (const n of points) expect(Number.isFinite(n), `unreadable easing: ${easing}`).toBe(true);
    return points as Curve;
  }
  // a spring, a steps() or a linear() list would land here, and none of them
  // can be reasoned about as a curve with two ends
  expect(KEYWORDS[easing], `${easing} is not a standard easing`).toBeDefined();
  return KEYWORDS[easing];
}

/** The transition on a rule, split into what it animates and how. */
function transition(body: string): { property: string; ms: number; easing: string } {
  const value = decl(body, "transition");
  const m = /^([\w-]+) (\d+)ms (.+)$/.exec(value);
  expect(m, `unreadable transition: ${value}`).not.toBeNull();
  return { property: m![1], ms: Number(m![2]), easing: m![3] };
}

/** A function body out of main.ts, up to the next named thing. */
function fn(name: string, until: string): string {
  const at = main.indexOf(`function ${name}(`);
  expect(at, `missing ${name}`).toBeGreaterThanOrEqual(0);
  const end = main.indexOf(until, at);
  expect(end, `missing ${until}`).toBeGreaterThan(at);
  return main.slice(at, end);
}

const dialogIn = only(pushRules, ".push-dialog");
const cardIn = only(pushRules, ".push-card");
const dialogOut = only(pushRules, ".push-dialog.push-dialog-leaving");
const cardOut = only(pushRules, ".push-dialog.push-dialog-leaving .push-card");

describe("the notification card eases in from rest and leaves as it always did", () => {
  it("one class runs both directions, so the base rules time the way in", () => {
    // a transition takes its duration and easing from the style it lands ON:
    // dropping the class lands on the base rules, adding it lands on the
    // leaving ones. That is the whole reason the two can be timed apart.
    const show = fn("showPushDialog", "function renderPushState(");
    expect(show.indexOf('classList.add("push-dialog-leaving")')).toBeGreaterThan(0);
    expect(show).toMatch(
      /requestAnimationFrame\(\(\) => \{\s*dialog\.classList\.remove\("push-dialog-leaving"\)/,
    );
    expect(show.indexOf('classList.add("push-dialog-leaving")')).toBeLessThan(
      show.indexOf('classList.remove("push-dialog-leaving")'),
    );
    const hide = fn("hidePushDialog", "function showPushDialog(");
    expect(hide).toMatch(
      /classList\.add\("push-dialog-leaving"\);\s*pushDialogHideTimer = window\.setTimeout\(/,
    );
  });

  it("the way in starts at rest, ends at rest and never overshoots", () => {
    for (const rule of [dialogIn, cardIn]) {
      const [x1, y1, x2, y2] = curve(transition(rule.body).easing);
      expect(y1, "leaves at speed instead of from a standstill").toBe(0);
      expect(x1, "no run-up: a horizontal first handle is not zero velocity")
        .toBeGreaterThan(0);
      expect(y2, "does not settle").toBe(1);
      expect(x2, "arrives at speed").toBeLessThan(1);
      // control points inside the box: no bounce, no pass-and-return
      for (const y of [y1, y2]) expect(y).toBeGreaterThanOrEqual(0);
      for (const y of [y1, y2]) expect(y).toBeLessThanOrEqual(1);
    }
  });

  it("the way in is short: the card fades and the card itself scales", () => {
    expect(transition(dialogIn.body).property).toBe("opacity");
    expect(transition(cardIn.body).property).toBe("transform");
    for (const rule of [dialogIn, cardIn]) {
      const { ms } = transition(rule.body);
      expect(ms).toBeGreaterThanOrEqual(220);
      expect(ms).toBeLessThanOrEqual(300);
    }
    expect(transition(dialogIn.body).ms).toBe(transition(cardIn.body).ms); // one arrival
  });

  it("the way out is untouched, and the hide timer still matches it", () => {
    for (const rule of [dialogOut, cardOut]) {
      const { ms, easing } = transition(rule.body);
      expect(ms).toBe(360);
      expect(easing).toBe("cubic-bezier(0.22, 0.61, 0.36, 1)");
    }
    expect(decl(dialogOut.body, "opacity")).toBe("0");
    expect(decl(cardOut.body, "transform")).toBe("translateY(8px) scale(0.95)");
    const held = /const PUSH_DIALOG_TRANSITION_MS = (\d+);/.exec(main);
    expect(held, "missing PUSH_DIALOG_TRANSITION_MS").not.toBeNull();
    expect(Number(held![1])).toBe(transition(dialogOut.body).ms);
  });

  it("reduced motion still flattens both directions", () => {
    const reduced = pushRules.filter((r) =>
      r.at.some((a) => a.includes("prefers-reduced-motion")),
    );
    expect(reduced).toHaveLength(1);
    // the leaving rules now carry timing of their own and outrank the base
    // ones, so naming only the base two would hand the dismissal back its 360ms
    expect(reduced[0].selectors).toEqual(
      expect.arrayContaining([
        ...dialogIn.selectors,
        ...cardIn.selectors,
        ...dialogOut.selectors,
        ...cardOut.selectors,
      ]),
    );
    expect(decl(reduced[0].body, "transition-duration")).toBe("1ms");
    // equal specificity: it only wins by coming last
    expect(reduced[0].index).toBeGreaterThan(Math.max(dialogOut.index, cardOut.index));
  });
});
