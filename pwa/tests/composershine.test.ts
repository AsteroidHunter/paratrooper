// Pins for the compose pill's resting well and its hold light (styles.css
// .field / .field.glow, plus the pointerdown hook in main.ts).
//
// This corner has broken Safari's native text interaction twice, and the
// cursor comes before the look every time:
//   1. A white veil pseudo-element painted OVER the textarea washed the text.
//   2. Lifting the textarea out from under it with position/z-index cost
//      double-tap word selection and tap-to-place-caret.
// And once more in 0.3.71, for a third reason: the pill is composited
// (backdrop-filter), so its backing store is sized from its visual overflow —
// border box UNION every box-shadow's reach. Two OUTSET shadows faded in on
// hold, regrowing that rect on every frame, and iOS drew the caret from a rect
// that no longer agreed with where the layer had landed. The cursor jumped up,
// then down, then sat wrong for the rest of the press.
//
// So the invariants below are not style preferences. Each one is a door that
// was walked through: nothing paints above the textarea, nothing positions it,
// the light lives in the field's own background layers, and the shadow is
// declared exactly once so there is nothing for a press to interpolate.
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

// Every non-custom property a rule sets, sorted.
function properties(body: string): string[] {
  return withoutComments(body)
    .split(";")
    .map((d) => d.split(":")[0].trim())
    .filter((p) => p.length > 0 && !p.startsWith("--"))
    .sort();
}

// Every custom property a rule sets.
function customProperties(body: string): string[] {
  return withoutComments(body)
    .split(";")
    .map((d) => d.split(":")[0].trim())
    .filter((p) => p.startsWith("--"))
    .sort();
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
// re-declares some of them, so the sheet is cut at the media query first.
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

const WHITE: Rgb = [255, 255, 255]; // the light-mode canvas
const BLACK: Rgb = [0, 0, 0]; // the dark-mode canvas

const field = withoutComments(rule(".field"));
const glow = withoutComments(rule(".field.glow"));
const textarea = withoutComments(rule(".compose textarea"));

describe("nothing the hold does can reach Safari's native text layer", () => {
  it("leaves the textarea unpositioned and uncomposited", () => {
    // attempt 2: position/z-index on the textarea to lift it above a veil.
    // It worked visually and cost double-tap word select and tap-to-caret.
    expect(textarea).not.toMatch(
      /(?:^|;)\s*(?:position|z-index|transform|scale|translate|filter|backdrop-filter|opacity|isolation|will-change|contain|mix-blend-mode|perspective)\s*:/,
    );
    // the selection is the engine's to draw; the app has never had a say in it
    expect(css).not.toContain("::selection");
  });

  it("paints nothing above the textarea: no overlay pseudo-element on the pill", () => {
    // attempt 1: a 55%-white veil pseudo-element over the text, which washed
    // the letters and the selection toward grey
    expect(css).not.toMatch(/\.field(?:\.glow)?::(?:before|after)/);
    expect(css).not.toMatch(/\.compose\s+textarea::(?:before|after)/);
    expect(css).not.toMatch(/\.compose::(?:before|after)/);
  });

  it("keeps the pill's only children the text and the send button", () => {
    // the field is a flex box with the bare textarea as its one in-flow child;
    // a background layer on it paints BENEATH that child by definition, which
    // is the entire safety argument for where the light lives
    expect(decl(field, "display")).toBe("flex");
    expect(field).not.toMatch(/(?:^|;)\s*(?:padding|border|overflow)\s*:/);
  });
});

describe("the resting pill: a face, a rim, and a shadow well", () => {
  it("keeps the face exactly as it shipped — the hold is not a tint", () => {
    expect(decl(field, "background-color")).toBe("var(--glass-bg)");
    expect(over(rgba(variable(lightSheet, "--glass-bg")), WHITE)[0]).toBeCloseTo(250.95, 1);
    expect(over(rgba(variable(darkSheet, "--glass-bg")), BLACK)[0]).toBeCloseTo(35.7, 1);
    // 0.3.71 made the hold visible by sinking the BODY to a cooler tone. On
    // the phone the pill just turned grey. That token is gone for good.
    expect(css).not.toContain("--glass-bg-glow");
    expect(glow).not.toMatch(/(?:^|;)\s*background/);
  });

  it("carries the Messages well and the bright rim, both static", () => {
    const shadow = parts(decl(field, "box-shadow"));
    // outside in: the one-device-pixel rim, the pill's established stack, the well
    expect(shadow[0]).toBe("inset 0 0 0 0.5px var(--glass-rim)");
    expect(shadow[1]).toBe("var(--glass-stack)");
    expect(shadow[2]).toMatch(/^0 6px 33px rgba\(0, 0, 0, 0\.06\d\)$/);
    expect(shadow).toHaveLength(3);
    // the rim is bright in both schemes: invisible on a white page by
    // construction, and on black it IS the edge, because a black shadow
    // cast on a black canvas is nothing at all
    for (const sheet of [lightSheet, darkSheet]) {
      const rim = rgba(variable(sheet, "--glass-rim"));
      expect(rim.slice(0, 3)).toEqual([255, 255, 255]);
      expect(rim[3]).toBeGreaterThan(0);
    }
    // and the whole 0.3.71 hold-edge vocabulary is gone
    for (const dead of ["--glass-rim-glow", "--glass-lift-glow-a", "--glass-lift-glow-b"]) {
      expect(css).not.toContain(dead);
    }
  });

  it("declares the shadow ONCE, so a press has nothing to interpolate", () => {
    // This is the 0.3.71 caret bug, closed at the source. The pill is
    // composited (backdrop-filter), so its backing store is sized from border
    // box UNION every shadow's reach; a shadow that fades in on hold regrows
    // that rect every frame and iOS's caret rect stops agreeing with it.
    expect(glow).not.toContain("box-shadow");
    expect(properties(glow)).toEqual(["transition"]);
    // stronger than "the two declarations match": .field.glow cannot reach the
    // shadow indirectly either, so no future token can smuggle a change in
    const shadow = decl(field, "box-shadow");
    for (const token of customProperties(glow)) expect(shadow).not.toContain(token);
    // and nothing animates the shadow from either side
    for (const body of [field, glow]) {
      expect(decl(body, "transition")).not.toContain("box-shadow");
      expect(decl(body, "transition")).not.toContain("background");
    }
  });

  it("grows no box on press: the hold sets a number and a clock, nothing else", () => {
    // any of these would move the pill's box or its layer, and the caret with it
    expect(glow).not.toMatch(
      /(?:^|;)\s*(?:position|inset|top|right|bottom|left|width|height|margin|padding|border|border-radius|outline|transform|scale|translate|filter|backdrop-filter|z-index|isolation|animation|will-change|contain|mix-blend-mode)\s*:/,
    );
    expect(customProperties(glow)).toEqual(["--glow-a"]);
  });
});

describe("the hold light: one white bloom, in a background layer", () => {
  it("anchors a radial white flood at the touch point", () => {
    const image = decl(field, "background-image");
    expect(image).toMatch(/^radial-gradient\(/);
    expect(image).toContain("circle var(--glow-r) at var(--tx) var(--ty)");
    expect(image).toContain("calc(var(--glow-a) * var(--glow-peak))");
    expect(image).not.toMatch(/rgba\(\s*0\b/); // never a dark wash under the text
    // every stop is white, scaled by the one dial, so --glow-a: 0 makes the
    // whole layer transparent and the resting composite is the face alone
    for (const stop of parts(image).slice(1)) {
      expect(stop).toMatch(/^rgba\(255, 255, 255, (?:0|calc\(var\(--glow-a\))/);
    }
    expect(decl(field, "--glow-a")).toBe("0");
    expect(decl(glow, "--glow-a")).toBe("1");
  });

  it("holds the gradient's geometry still — only the stop alphas move", () => {
    // 0.3.71 grew the radius from 24px to 180px during the press. Nothing
    // about the shape moves now: the radius is authored once and never
    // appears in either transition list.
    expect(decl(field, "--glow-r")).toMatch(/^\d+px$/);
    expect(glow).not.toContain("--glow-r");
    for (const body of [field, glow]) expect(decl(body, "transition")).not.toContain("--glow-r");
  });

  it("registers only what it animates, and keeps all of it off the textarea", () => {
    // an unregistered custom property transitions discretely: the light would
    // snap on instead of coming up
    for (const name of ["--glow-a", "--tx", "--ty"]) {
      const at = css.indexOf(`@property ${name} {`);
      expect(at, `${name} is not registered`).toBeGreaterThanOrEqual(0);
      expect(css.slice(at, at + 140)).toContain("inherits: false");
    }
    // --tx/--ty are registered for the fallback, never animated: the light has
    // to jump to the new fingertip, not slide there from the last one
    for (const body of [field, glow]) {
      expect(decl(body, "transition")).not.toContain("--tx");
      expect(decl(body, "transition")).not.toContain("--ty");
    }
  });

  it("comes up over 0.25s and settles back over 0.5s, settling fade intact", () => {
    const rest = parts(decl(field, "transition"));
    const held = parts(decl(glow, "transition"));
    expect(rest[0]).toBe("opacity 0.3s ease"); // the .settling fade, preserved
    expect(held[0]).toBe("opacity 0.3s ease");
    expect(rest).toContain("--glow-a 0.5s ease");
    expect(held).toContain("--glow-a 0.25s ease-out");
    expect(rest).toHaveLength(2);
    expect(held).toHaveLength(2);
  });
});

describe("what the light actually composites to, per scheme", () => {
  const peak = parseFloat(variable(lightSheet, "--glow-peak"));
  // the far end of the pill sits at the 62% stop's neighbourhood; that stop's
  // multiplier is what keeps the light from ending at the fingertip
  const farMul = parseFloat(
    /\* 0\.34\)\) 62%/.exec(decl(field, "background-image")) ? "0.34" : "0",
  );

  it("uses one peak for both schemes, near the 0.15 Messages measures", () => {
    expect(peak).toBeGreaterThanOrEqual(0.12);
    expect(peak).toBeLessThanOrEqual(0.18);
    // declared once, in :root, and never overridden: it is the same light in
    // both schemes, and only the face it lands on differs
    expect(withoutComments(css).match(/--glow-peak\s*:/g)).toHaveLength(1);
    expect(farMul).toBeGreaterThan(0.25); // the far end still carries the glow
  });

  it("brightens the dark face clearly, core and far end alike", () => {
    const body = over(rgba(variable(darkSheet, "--glass-bg")), BLACK);
    const core = over([255, 255, 255, peak], body);
    const far = over([255, 255, 255, peak * farMul], body);
    expect(body[0]).toBeCloseTo(35.7, 1);
    expect(core[0]).toBeCloseTo(68.6, 1); // measured 69 in Chromium and WebKit
    expect(far[0]).toBeGreaterThan(body[0] + 6); // measured 49 at the pill's end
    expect(core[0] - body[0]).toBeGreaterThanOrEqual(25);
  });

  it("clips to nothing over white, which is what Messages does", () => {
    // This is deliberate and it is the reason the resting SHADOW carries the
    // pill in light mode. A white light on a 251 face over a 255 page has
    // half a level of headroom; 0.3.71 manufactured some by sinking the body
    // to a cooler grey and the phone showed a grey pill. Not again.
    const body = over(rgba(variable(lightSheet, "--glass-bg")), WHITE);
    const core = over([255, 255, 255, peak], body);
    expect(core[0]).toBeGreaterThan(body[0]); // still a LIGHT, never a darkening
    expect(core[0] - body[0]).toBeLessThan(1.5); // and it clips, as measured
  });
});

// the hold hook, from its banner down to the last listener it binds
function holdHook(): string {
  const start = main.indexOf("// editor hold-brighten");
  const end = main.indexOf('document.addEventListener("pointercancel", unglow, true)', start);
  if (start < 0 || end < 0) throw new Error("the hold-brighten hook is gone from main.ts");
  return main.slice(start, end);
}

describe("the gesture hook owns the glow and its origin, and forces no layout", () => {
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
    expect(hook).toContain('field.style.setProperty("--tx", `${Math.round(e.offsetX)}px`)');
    expect(hook).toContain('field.style.setProperty("--ty", `${Math.round(e.offsetY)}px`)');
    expect(hook).not.toMatch(/\bt\.(?:style|setAttribute|classList)\b/);
  });

  it("reads no geometry: no synchronous layout flush on the touch-start path", () => {
    // offsetX/offsetY are measured from the target's padding edge, and the
    // textarea is the field's only in-flow child in a flex box with no padding
    // and no border, so its padding edge IS the field's box. Forcing a layout
    // ahead of the engine's own tap handling, next to a caret placement, is
    // the last thing this composer needs. (Comments stripped first: the hook's
    // banner names the call it used to make, and saying so is the point.)
    const code = hook.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("getBoundingClientRect");
    expect(code).not.toMatch(/\b(?:offsetTop|offsetLeft|offsetWidth|offsetHeight|getClientRects)\b/);
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

  it("ships as 0.3.97", () => {
    expect(main).toMatch(/^const APP_VERSION = "0\.3\.97"; \/\/ \S/m);
  });
});
