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

// One declaration out of a rule body, whitespace flattened, so the assertions
// below can read a multi-line value as the one string it really is.
function decl(body: string, property: string): string {
  const m = new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]*)`).exec(withoutComments(body));
  expect(m, `missing ${property}`).not.toBeNull();
  return m![1].replace(/\s+/g, " ").trim();
}

// Split a comma-separated value at the top level only, so var()/rgba() stay whole.
function parts(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

type Rgb = [number, number, number];

// The declared value of a custom property, per colour scheme: the dark block
// re-declares most of them, so the sheet is cut at the media query first.
const darkAt = css.indexOf("@media (prefers-color-scheme: dark)");
const lightSheet = css.slice(0, darkAt);
const darkSheet = css.slice(darkAt);

function variable(sheet: string, name: string): string {
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(withoutComments(sheet));
  expect(m, `missing ${name}`).not.toBeNull();
  return m![1].trim();
}

function rgba(value: string): [number, number, number, number] {
  const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)/.exec(value);
  expect(m, `not a colour: ${value}`).not.toBeNull();
  return [+m![1], +m![2], +m![3], m![4] === undefined ? 1 : +m![4]];
}

// source-over: what the eye actually receives once the layer is on its canvas
function over(fg: [number, number, number, number], bg: Rgb): Rgb {
  return [0, 1, 2].map((i) => fg[3] * fg[i] + (1 - fg[3]) * bg[i]) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const lin = (v: number): number => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE: Rgb = [255, 255, 255]; // the light-mode canvas
const BLACK: Rgb = [0, 0, 0]; // the dark-mode canvas

describe("composer hold-light lives under the textarea, never over it", () => {
  const field = withoutComments(rule(".field"));
  const glow = withoutComments(rule(".field.glow"));
  const textarea = withoutComments(rule(".compose textarea"));

  // --- the two ways this was broken before -----------------------------
  it("does not put the textarea into a positioned or composited layer", () => {
    // attempt 1: position/z-index on the textarea to lift it above a veil.
    // It worked visually and cost double-tap word select and tap-to-caret.
    expect(textarea).not.toMatch(
      /(?:^|;)\s*(?:position|z-index|transform|filter|opacity|isolation|will-change|contain|mix-blend-mode)\s*:/,
    );
    expect(css).not.toContain("::selection");
  });

  it("paints nothing above the textarea: no overlay pseudo-element anywhere on the pill", () => {
    // the original bug: a 55%-white veil pseudo-element over the text, which
    // washed the letters and the selection toward grey
    expect(css).not.toMatch(/\.field(?:\.glow)?::(?:before|after)/);
    expect(css).not.toMatch(/\.compose textarea::(?:before|after)/);
  });

  it("expresses the light only through the field's own background and shadow", () => {
    expect(glow).not.toMatch(
      /(?:^|;)\s*(?:position|z-index|isolation|transform|filter|opacity|animation|mix-blend-mode|will-change|contain|backdrop-filter)\s*:/,
    );
    // every non-custom property .field.glow sets has to be one of these three
    const set = withoutComments(glow)
      .split(";")
      .map((d) => d.split(":")[0].trim())
      .filter((p) => p.length > 0 && !p.startsWith("--"));
    expect(set.sort()).toEqual(["background-color", "box-shadow", "transition"]);
  });

  // --- the light itself -------------------------------------------------
  it("anchors a radial flood at the touch point in the field's background layer", () => {
    const image = decl(field, "background-image");
    expect(image).toMatch(/^radial-gradient\(/);
    expect(image).toContain("circle var(--glow-r) at var(--tx) var(--ty)");
    // it is white light, scaled by the two dials and by the per-scheme peak
    expect(image).toContain("calc(var(--glow-a) * var(--glow-peak))");
    expect(image).not.toMatch(/rgba\(\s*0\b/); // never a dark wash over the text
  });

  it("resolves to nothing at rest, so the resting pill is unchanged", () => {
    expect(decl(field, "background-color")).toBe("var(--glass-bg)");
    expect(decl(field, "--glow-a")).toBe("0");
    // every stop is white * --glow-a, so --glow-a: 0 makes the whole layer
    // transparent and the resting composite is exactly --glass-bg over canvas
    for (const stop of parts(decl(field, "background-image")).slice(1)) {
      expect(stop).toMatch(/rgba\(255, 255, 255, (?:0|calc\(var\(--glow-a\))/);
    }
    expect(over(rgba(variable(lightSheet, "--glass-bg")), WHITE)[0]).toBeCloseTo(250.95, 1);
  });

  it("animates through registered custom properties, so the light spreads", () => {
    // an unregistered custom property transitions discretely: the light would
    // arrive whole instead of growing out from under the fingertip
    for (const name of ["--glow-a", "--glow-r", "--tx", "--ty"]) {
      const at = css.indexOf(`@property ${name} {`);
      expect(at, `${name} is not registered`).toBeGreaterThanOrEqual(0);
      expect(css.slice(at, at + 140)).toContain("inherits: false");
    }
    expect(decl(glow, "--glow-a")).toBe("1");
    expect(parseFloat(decl(glow, "--glow-r"))).toBeGreaterThan(parseFloat(decl(field, "--glow-r")));
  });

  it("keeps the two shadow lists interpolable, so the lift fades with the light", () => {
    const rest = parts(decl(field, "box-shadow"));
    const held = parts(decl(glow, "box-shadow"));
    expect(rest.length).toBe(held.length);
    expect(rest.map((s) => s.startsWith("inset"))).toEqual(held.map((s) => s.startsWith("inset")));
    expect(rest[0]).toBe("var(--glass-stack)"); // the resting stack, untouched
    expect(held[0]).toBe("var(--glass-stack)");
    // rest carries dormant stand-ins for the rim and the two casts
    for (const slot of rest.slice(1)) expect(slot).toMatch(/0 0 0 0 transparent$/);
    expect(held.slice(1).join(" ")).toContain("var(--glass-rim-glow)");
    expect(held.slice(1).join(" ")).toContain("var(--glass-lift-glow-a)");
    expect(held.slice(1).join(" ")).toContain("var(--glass-lift-glow-b)");
  });

  it("presses in over 0.25s and settles back over 0.5s, fade included", () => {
    const rest = parts(decl(field, "transition"));
    const held = parts(decl(glow, "transition"));
    expect(rest[0]).toBe("opacity 0.3s ease"); // the .settling fade, preserved
    expect(held[0]).toBe("opacity 0.3s ease");
    for (const prop of ["background-color", "box-shadow", "--glow-a", "--glow-r"]) {
      expect(rest).toContain(`${prop} 0.5s ease`);
      expect(held).toContain(`${prop} 0.25s ease-out`);
    }
  });

  // --- the reason 0.3.70 was invisible ---------------------------------
  it("clears a visible margin in light mode, where there is no headroom above white", () => {
    // 0.3.70 aimed the hold at rgba(252,252,252,.5635): 253 against a resting
    // 251 on a white canvas, a 2-level move nobody could see. The light has to
    // be a difference, so the body goes cooler and the bloom writes white back.
    const restBody = over(rgba(variable(lightSheet, "--glass-bg")), WHITE);
    const heldBody = over(rgba(variable(lightSheet, "--glass-bg-glow")), WHITE);
    const peak = parseFloat(variable(lightSheet, "--glow-peak"));
    const core = over([255, 255, 255, peak], heldBody);

    expect(restBody[0] - heldBody[0]).toBeGreaterThanOrEqual(10); // the pill's far end moves
    expect(contrast(core, heldBody)).toBeGreaterThanOrEqual(1.1); // and the core reads on it
    expect(heldBody[2]).toBeGreaterThan(heldBody[0]); // cooler, not just darker
    expect(core[0]).toBeGreaterThan(restBody[0]); // the core is still a LIGHT
  });

  it("brightens toward the existing tone in dark mode, where the headroom is", () => {
    const restBody = over(rgba(variable(darkSheet, "--glass-bg")), BLACK);
    const heldBody = over(rgba(variable(darkSheet, "--glass-bg-glow")), BLACK);
    const core = over([255, 255, 255, parseFloat(variable(darkSheet, "--glow-peak"))], heldBody);

    expect(variable(darkSheet, "--glass-bg-glow")).toBe("rgba(255, 255, 255, 0.2432)");
    expect(heldBody[0] - restBody[0]).toBeGreaterThanOrEqual(10);
    expect(core[0] - heldBody[0]).toBeGreaterThanOrEqual(10);
    expect(contrast(core, heldBody)).toBeGreaterThanOrEqual(1.1);
    // the same alpha that reads as paper white on the light body would be a
    // headlight on black, so the dark peak has to be the gentler of the two
    expect(parseFloat(variable(darkSheet, "--glow-peak"))).toBeLessThan(
      parseFloat(variable(lightSheet, "--glow-peak")),
    );
  });

  it("gives both schemes a lit rim and a cast to lift the pill", () => {
    for (const sheet of [lightSheet, darkSheet]) {
      expect(rgba(variable(sheet, "--glass-rim-glow"))[3]).toBeGreaterThan(0);
      expect(rgba(variable(sheet, "--glass-lift-glow-a"))[3]).toBeGreaterThan(0);
      expect(rgba(variable(sheet, "--glass-lift-glow-b"))[3]).toBeGreaterThan(0);
    }
  });
});

// the hold-brighten hook, from its banner down to the last listener it binds
function holdHook(): string {
  const start = main.indexOf("// editor hold-brighten");
  const end = main.indexOf('document.addEventListener("pointercancel", unglow, true)', start);
  if (start < 0 || end < 0) throw new Error("the hold-brighten hook is gone from main.ts");
  return main.slice(start, end);
}

describe("the gesture hook still owns the glow, and now its origin", () => {
  const hook = holdHook();

  it("keeps the document-level capture listeners and the settling guard", () => {
    expect(hook).toMatch(/document\.addEventListener\(\s*"pointerdown",/);
    expect(hook).toContain('!app.classList.contains("settling")');
    expect(main).toContain('document.addEventListener("pointerup", unglow, true)');
    expect(main).toContain('document.addEventListener("pointercancel", unglow, true)');
    expect(main).toContain('document.querySelector(".field.glow")?.classList.remove("glow")');
  });

  it("still glows the textarea's parent field on pointerdown", () => {
    expect(hook).toMatch(/t\.id === "text"[\s\S]{0,400}classList\.add\("glow"\)/);
    expect(hook).toContain("const field = t.parentElement;");
    expect(hook).toContain('field.classList.add("glow");');
  });

  it("records the touch point on the FIELD, never on the textarea", () => {
    expect(hook).toContain("field.getBoundingClientRect()");
    expect(hook).toContain('field.style.setProperty("--tx", `${Math.round(e.clientX - box.left)}px`)');
    expect(hook).toContain('field.style.setProperty("--ty", `${Math.round(e.clientY - box.top)}px`)');
    expect(hook).not.toMatch(/\bt\.(?:style|setAttribute)\b/);
  });

  it("neither binds to the textarea nor interferes with the native gesture", () => {
    expect(hook).not.toMatch(/preventDefault|stopPropagation|stopImmediatePropagation/);
    // every listener in the hook is on document, so nothing sits on the text
    expect([...hook.matchAll(/(\S+)\.addEventListener\(/g)].map((m) => m[1])).toEqual([
      "document",
      "document",
    ]);
    expect(main).not.toMatch(/textEl\.addEventListener\("(?:pointer|touch|mouse)/);
  });

  it("ships as 0.3.75", () => {
    expect(main).toMatch(/^const APP_VERSION = "0\.3\.75"; \/\/ \S/m);
  });
});
