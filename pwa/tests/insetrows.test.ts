// Pins for the top and bottom rows' inset offsets (styles.css: #app's --pad-b,
// --pad-r and --pad-l, and .bar's --bar-nudge). The rules are evaluated, not
// string-matched: each env() is replaced by the inset a device reports, each
// var() by its own resolved figure, and the max/min/calc that is left is
// worked out the way the browser does. What this proves is the RULE at a
// given set of insets, never a rendering.
//
// Two promises. With no insets, and with the top inset alone (an iPhone with
// a home button reports its status bar as a 20px top inset in the installed
// app), every figure is the one the rows had before. With the iPhone 13 mini's
// insets (top 50, bottom 34) they are the approved mock's.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
const REM = 17; // html, body { font: 17px/... }

const ruleOf = (sel: string): string => {
  const m = [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((r) => r[1].trim() === sel);
  return m?.[2] ?? "";
};
const declOf = (sel: string, prop: string): string => {
  const m = ruleOf(sel).match(new RegExp(`(?:^|;)\\s*${prop.replace(/-/g, "\\-")}:\\s*([^;]*);`));
  expect(m, `${sel} ${prop}`).not.toBeNull();
  return (m?.[1] ?? "").replace(/\s+/g, " ").trim();
};

type Insets = { top: number; bottom: number };

// one length expression, in px, with the custom properties it reads
function px(expr: string, insets: Insets, vars: Record<string, number>): number {
  const js = expr
    .replace(/env\(safe-area-inset-(top|bottom)\)/g, (_m, side: "top" | "bottom") => `${insets[side]}px`)
    .replace(/var\((--[\w-]+)\)/g, (_m, name: string) => {
      expect(vars, name).toHaveProperty(name);
      return `${vars[name]}px`;
    })
    .replace(/([\d.]+)rem/g, (_m, n: string) => `${Number(n) * REM}`)
    .replace(/([\d.]+)px/g, "$1")
    .replace(/\bcalc\(/g, "(")
    .replace(/\bmax\(/g, "Math.max(")
    .replace(/\bmin\(/g, "Math.min(");
  expect(js).toMatch(/^[\d.\s+\-*(),Mathminax]+$/); // nothing left but arithmetic
  return Function(`return (${js});`)() as number;
}

// a shorthand padding of two to four lengths, split at the top level
function sides(expr: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of expr) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === " " && depth === 0) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function rows(insets: Insets) {
  const padB = px(declOf("#app", "--pad-b"), insets, {});
  const vars = {
    "--pad-b": padB,
    "--pad-r": px(declOf("#app", "--pad-r"), insets, { "--pad-b": padB }),
    "--pad-l": px(declOf("#app", "--pad-l"), insets, { "--pad-b": padB }),
    "--bar-nudge": px(declOf(".bar", "--bar-nudge"), insets, {}),
  };
  const [barTop, barX, barBottom] = sides(declOf(".bar", "padding")).map((s) => px(s, insets, vars));
  const [cTop, cRight, cBottom, cLeft] = sides(declOf(".compose", "padding")).map((s) =>
    px(s, insets, vars),
  );
  return {
    bar: { top: barTop, x: barX, bottom: barBottom },
    compose: { top: cTop, right: cRight, bottom: cBottom, left: cLeft },
    filepickLeft: px(declOf(".filepick", "left"), insets, vars),
    jumpRight: px(declOf(".jump", "right"), insets, vars),
  };
}

// the rows as build-v0 drew them (0.3.169): padding max(0.5rem, top inset)
// 0.75rem 0.5rem on the bar, 0.5rem 0.75rem max(0.5rem, bottom inset) on the
// compose row, and the input and the chevron on its 0.75rem sides
const before = (insets: Insets) => ({
  bar: { top: Math.max(0.5 * REM, insets.top), x: 0.75 * REM, bottom: 0.5 * REM },
  compose: { top: 0.5 * REM, right: 0.75 * REM, bottom: Math.max(0.5 * REM, insets.bottom), left: 0.75 * REM },
  filepickLeft: 0.75 * REM,
  jumpRight: 0.75 * REM,
});

describe("the rows keep their old layout wherever there is no home indicator", () => {
  it("no insets at all (a desktop browser, a home-button iPhone in Safari)", () => {
    const none = { top: 0, bottom: 0 };
    expect(rows(none)).toEqual(before(none));
  });

  it("the status bar's top inset alone (a home-button iPhone's installed app)", () => {
    const se = { top: 20, bottom: 0 };
    expect(rows(se)).toEqual(before(se));
  });
});

describe("on the iPhone 13 mini the rows land on the approved mock", () => {
  const mini = rows({ top: 50, bottom: 34 });

  it("the top row's centre moves 0.25rem down and the bar keeps its height", () => {
    expect(mini.bar.top).toBe(50 + 0.25 * REM);
    expect(mini.bar.bottom).toBe(0.25 * REM);
    expect(mini.bar.top + mini.bar.bottom).toBe(50 + 0.5 * REM);
  });

  it("the compose row sits 8px lower, its ends 26px and 27px in", () => {
    expect(mini.compose.bottom).toBe(26);
    expect(mini.compose.right).toBe(26);
    expect(mini.compose.left).toBe(27);
    expect(mini.compose.top).toBe(0.5 * REM); // unchanged
  });

  it("the file input stays on the ＋ and the chevron stays flush with the pill's end", () => {
    expect(mini.filepickLeft).toBe(mini.compose.left);
    expect(mini.jumpRight).toBe(mini.compose.right);
  });
});
