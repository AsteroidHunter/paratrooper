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
  const field = withoutComments(rule(".field"));
  const glow = withoutComments(rule(".field.glow"));
  const textarea = withoutComments(rule(".compose textarea"));

  it("does not put the textarea into a positioned stacking layer", () => {
    expect(textarea).not.toMatch(/(?:^|;)\s*position\s*:/);
    expect(textarea).not.toMatch(/(?:^|;)\s*z-index\s*:/);
    expect(css).not.toContain("::selection");
  });

  it("brightens only the field background, behind native text and selection", () => {
    expect(css).not.toMatch(/\.field(?:\.glow)?::(?:before|after)/);
    expect(glow).toContain("background-color: var(--glass-bg-glow)");
    expect(glow).not.toMatch(
      /(?:^|;)\s*(?:position|z-index|isolation|transform|filter|opacity|animation|background|background-image|box-shadow)\s*:/,
    );
    expect(glow).not.toMatch(/gradient\s*\(/);
  });

  it("preserves the press, release, and settling fade timings", () => {
    expect(field).toContain("transition: opacity 0.3s ease, background-color 0.5s ease");
    expect(glow).toContain("transition: opacity 0.3s ease, background-color 0.25s ease-out");
  });

  it("uses the source-over equivalents of the former light and dark veils", () => {
    expect(css).toContain("--glass-bg-glow: rgba(252, 252, 252, 0.5635)");
    expect(css).toContain("--glass-bg-glow: rgba(255, 255, 255, 0.2432)");
  });

  it("keeps the existing pointer gesture hook", () => {
    expect(main).toMatch(/t\.id === "text"[\s\S]{0,120}classList\.add\("glow"\)/);
    expect(main).toContain('document.addEventListener("pointerup", unglow, true)');
    expect(main).toContain('document.addEventListener("pointercancel", unglow, true)');
  });
});
