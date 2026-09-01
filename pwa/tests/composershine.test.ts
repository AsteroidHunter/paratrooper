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

function zIndex(body: string): number {
  return Number(/z-index:\s*(-?\d+)/.exec(body)?.[1]);
}

describe("composer hold-brighten versus native text selection", () => {
  const veil = rule(".field::before");
  const glow = rule(".field.glow::before");
  const textarea = rule(".compose textarea");
  const send = rule(".compose .send");

  it("keeps the approved shine as one pointer-driven opacity fade", () => {
    // Its strength is intentionally unchanged. If this 55%-white veil painted
    // above black ink, only 45% of that foreground contribution would survive.
    const lightVeilAlpha = Number(/--pill-veil:\s*rgba\(255, 255, 255, ([\d.]+)\)/.exec(css)?.[1]);
    expect(lightVeilAlpha).toBe(0.55);
    expect(1 - lightVeilAlpha).toBeCloseTo(0.45);
    expect(veil).toContain('content: ""');
    expect(veil).toContain("position: absolute");
    expect(veil).toContain("inset: 0");
    expect(veil).toContain("background: var(--pill-veil)");
    expect(veil).toContain("opacity: 0");
    expect(veil).toContain("transition: opacity 0.5s ease");
    expect(veil).toContain("pointer-events: none");
    expect(glow).toContain("opacity: 1");
    expect(glow).toContain("transition: opacity 0.25s ease-out");
    expect(main).toMatch(/t\.id === "text"[\s\S]{0,120}classList\.add\("glow"\)/);
    expect(main).toContain('document.addEventListener("pointerup", unglow, true);');
    expect(main).toContain('document.addEventListener("pointercancel", unglow, true);');
  });

  it("puts the complete native textarea paint, including iPhone selection, above the veil", () => {
    expect(textarea).toContain("position: relative");
    expect(zIndex(veil)).toBe(0);
    expect(zIndex(textarea)).toBe(1);
    expect(zIndex(textarea)).toBeGreaterThan(zIndex(veil));
    // Selection stays WebKit-native: the fix is layer order, not a replacement
    // highlight whose foreground Safari could render differently.
    expect(css).not.toContain("::selection");
  });

  it("keeps the in-field send button on the same foreground plane", () => {
    expect(zIndex(send)).toBe(zIndex(textarea));
    expect(main).toMatch(
      /<div class="field">\s*<textarea id="text"[\s\S]*?<button type="submit" id="sendbtn" class="send">↑<\/button>\s*<\/div>/,
    );
  });

  it("never applies the shine opacity to the field or textarea layer", () => {
    expect(glow.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/transform|filter|animation/);
    expect(css).not.toMatch(/\.field\.glow\s+(?:textarea|#text)\s*\{/);
    // The separate 20ms focus blink remains the iOS caret-reveal guard; the
    // hold shine itself still targets only ::before.
    expect(css).toMatch(/\.compose textarea:focus \{\s*animation: focus-blink 0\.02s;/);
  });
});
