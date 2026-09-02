// Pins for the colour of the PR row (styles.css .msg.agent a and .publish;
// the row itself is built by renderPr in main.ts).
//
// The row hangs two controls off an agent bubble — a link to the pull request
// and the Publish button under it — and both were painted with --sent, the
// legacy iOS blue. The sent bubbles stopped being that colour when --accent
// arrived, so the one place the thread offers something to tap read as a
// second accent inside it.
//
// What is pinned is not a colour. Nothing below names a hex or even a token:
// the sent bubble's own declarations are read out of the sheet and the row is
// required to repeat them, so the two cannot part again — including across
// appearances, where the whole scheme is tokens redefined in one media block
// and nothing re-colours these rules for one side of it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

// every sheet the app loads, in import order: a pin on the cascade has to see
// all of them, not just the one file these rules happen to live in
const sheets = [...main.matchAll(/^import "\.\/([\w.-]+\.css)";$/gm)].map((m) =>
  readFileSync(new URL(`../src/${m[1]}`, import.meta.url), "utf8"),
);

function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing ${selector} rule`).toBeGreaterThanOrEqual(0);
  const body = css.slice(start + selector.length + 2);
  return body.slice(0, body.indexOf("}"));
}

// One declaration out of a rule body, whitespace flattened, comments dropped.
function decl(body: string, property: string): string {
  const m = new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]*)`).exec(
    body.replace(/\/\*[\s\S]*?\*\//g, ""),
  );
  expect(m, `missing ${property}`).not.toBeNull();
  return m![1].replace(/\s+/g, " ").trim();
}

// how many rules across the app's sheets open with exactly this selector
function declaredTimes(selector: string): number {
  return sheets.reduce((n, s) => n + s.split(`${selector} {`).length - 1, 0);
}

// the body of every prefers-color-scheme block in those sheets, brace-matched
function schemeBlocks(): string[] {
  const out: string[] = [];
  for (const sheet of sheets) {
    const re = /@media \(prefers-color-scheme: \w+\) \{/g;
    for (let m = re.exec(sheet); m; m = re.exec(sheet)) {
      const from = m.index + m[0].length;
      let depth = 1;
      let i = from;
      for (; i < sheet.length && depth > 0; i++) {
        if (sheet[i] === "{") depth++;
        else if (sheet[i] === "}") depth--;
      }
      out.push(sheet.slice(from, i - 1));
    }
  }
  return out;
}

const bubble = rule(".msg.user"); // the bubble the user's own messages get
const fill = decl(bubble, "background"); // what it is filled with
const ink = decl(bubble, "color"); // what it writes on that fill

describe("the PR row is painted out of the sent bubble", () => {
  it("the bubble states its colours as tokens, so they can be shared", () => {
    // if these were literals the rules below could only ever be copies of a
    // colour, and a copy is what drifted in the first place
    expect(fill).toMatch(/^var\(--[\w-]+\)$/);
    expect(ink).toMatch(/^var\(--[\w-]+\)$/);
  });

  it("the PR link is the bubble's fill", () => {
    expect(decl(rule(".msg.agent a"), "color")).toBe(fill);
  });

  it("Publish is the bubble's fill with the bubble's ink on it", () => {
    const btn = rule(".publish");
    expect(decl(btn, "background")).toBe(fill);
    expect(decl(btn, "color")).toBe(ink);
  });

  it("no appearance gets to re-colour either of them", () => {
    // one rule each, and neither named inside a scheme block: light and dark
    // resolve the same two tokens the bubble does
    expect(declaredTimes(".msg.agent a")).toBe(1);
    expect(declaredTimes(".publish")).toBe(1);
    const blocks = schemeBlocks();
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).not.toContain(".msg.agent a");
      expect(block).not.toContain(".publish");
    }
  });

  it("those rules are the ones renderPr's two controls land on", () => {
    const body = /function renderPr\(([\s\S]*?)\n}\n/.exec(main)?.[1] ?? "";
    expect(body, "renderPr not found").not.toBe("");
    expect(body).toContain('rowEl(wrapper, "agent", "pr", at)'); // .msg.agent
    expect(body).toContain('createElement("a")'); // .msg.agent a
    expect(body).toContain('btn.className = "publish"'); // .publish
  });
});
