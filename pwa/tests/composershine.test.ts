import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing ${selector} rule`).toBeGreaterThanOrEqual(0);
  const body = css.slice(start + selector.length + 2);
  return body.slice(0, body.indexOf("}"));
}

function withoutComments(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("composer hold-brighten preserves Safari-native text interaction", () => {
  const veil = withoutComments(rule(".field::before"));
  const glow = withoutComments(rule(".field.glow::before"));
  const textarea = withoutComments(rule(".compose textarea"));

  it("does not put the textarea into a positioned stacking layer", () => {
    expect(textarea).not.toMatch(/(?:^|;)\s*position\s*:/);
    expect(textarea).not.toMatch(/(?:^|;)\s*z-index\s*:/);
    expect(css).not.toContain("::selection");
  });

  it("keeps the shine on its pointer-transparent veil", () => {
    expect(veil).toContain('content: ""');
    expect(veil).toContain("position: absolute");
    expect(veil).toContain("pointer-events: none");
    expect(veil).not.toMatch(/z-index\s*:/);
    expect(glow).toContain("opacity: 1");
    expect(glow).toContain("transition: opacity 0.25s ease-out");
    expect(main).toMatch(/t\.id === "text"[\s\S]{0,120}classList\.add\("glow"\)/);
  });
});
