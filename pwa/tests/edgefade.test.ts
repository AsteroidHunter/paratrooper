// Pins for the two edge fades: the short dissolve where the message list is cut
// under the top bar, and the one where it is cut above the compose bar
// (styles.css --edge-fade, .bar::after and .edgefade::before).
//
// The list is clipped flat at both of those lines — .liftclip at the top, the
// scroller's own box at the bottom — and a bubble that reached one of them
// simply stopped mid-pixel. The fix is a band of the CANVAS at each line,
// opaque against the bar and gone by the far side, so the message reads as
// dissolving into the page rather than being sliced by it.
//
// Everything a band can get wrong is a layout or a stacking mistake, so that is
// what is pinned:
//   - it must take no room, or the bars and the list change size;
//   - it must be the canvas, not a grey wash, or dark mode breaks;
//   - it must be inert to touch, or it eats taps on the message under it;
//   - it must outrank the list and be outranked by the chevron, or the jump
//     button dims every time it parks near the bottom edge.
// Nothing below names a depth or a colour of its own: the depth is read out of
// the sheet's own custom property and the colour has to be the canvas token, so
// a copied number cannot drift away from either.
//
// The two ends are anchored differently, and the asymmetry is the point. The
// top band hangs off the BAR, which does not move for the keyboard, so it stays
// on the visible edge in both states. The bottom band hangs off a marker parked
// immediately after the list INSIDE the lift, so it rides up with the keyboard
// — and so it is still on the real edge when the photo drawer stands between
// the list and the compose bar.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

// every sheet the app loads, in import order: "declared once" has to see all of
// them, not just the file these rules happen to live in
const sheets = [...main.matchAll(/^import "\.\/([\w.-]+\.css)";$/gm)].map((m) =>
  readFileSync(new URL(`../src/${m[1]}`, import.meta.url), "utf8"),
);

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
      const end = src.indexOf("}", i); // nothing in these sheets nests
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

const rules = parse(styles);

/** The one rule with exactly this selector that is not inside an at-rule. */
function only(selector: string): Rule {
  const found = rules.filter((r) => r.selectors.includes(selector) && r.at.length === 0);
  expect(found, `expected exactly one plain ${selector} rule`).toHaveLength(1);
  return found[0];
}

/** One declaration out of a rule body, whitespace flattened. */
function decl(body: string, property: string): string {
  const m = new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]*)`).exec(body);
  expect(m, `missing ${property}`).not.toBeNull();
  return m![1].replace(/\s+/g, " ").trim();
}

/** Whether a rule sets a property at all. */
function sets(body: string, property: string): boolean {
  return new RegExp(`(?:^|;)\\s*${property}\\s*:`).test(body);
}

/** Every property a rule sets, custom ones included. */
function properties(body: string): string[] {
  return body
    .split(";")
    .map((d) => d.split(":")[0].trim())
    .filter((p) => p.length > 0);
}

const DEPTH = "--edge-fade"; // the one named depth both bands are drawn at

// Each band, with the edge of its host it hangs off and the way the dissolve
// therefore has to run: away from the bar, into the list. The offset is checked
// as a literal because it is what keeps the band OUTSIDE the box it is anchored
// to — 100% of the bar's height clears the bar, and 0 on a zero-height marker
// is the marker's own line.
const bands = [
  { name: "top", rule: only(".bar::after"), side: "top", offset: "100%", runs: "bottom" },
  { name: "bottom", rule: only(".edgefade::before"), side: "bottom", offset: "0", runs: "top" },
] as const;

describe("the message list dissolves at the two lines it is cut at", () => {
  it("there is one band per edge, and each hangs off the right thing", () => {
    // the top one costs no markup at all: it is the bar's own pseudo-element,
    // and the bar is the thing that does not move for the keyboard
    expect(only(".bar::after").selectors).toEqual([".bar::after"]);
    // the bottom one is one empty marker, and it is deliberately NOT a
    // pseudo-element of the compose form: composershine.test.ts bans those on
    // the pill, and the form's top edge is not the list's edge with photos
    // staged anyway
    expect(rules.flatMap((r) => r.selectors)).not.toContain(".compose::before");
    expect(rules.flatMap((r) => r.selectors)).not.toContain(".compose::after");
    expect([...main.matchAll(/class="edgefade"/g)]).toHaveLength(1);
    expect(main).toContain('<div class="edgefade" aria-hidden="true"></div>');
    for (const band of bands) {
      expect(decl(band.rule.body, "content")).toBe('""');
    }
  });

  it("the bottom band sits at the list's real edge, drawer or no drawer", () => {
    // Order inside the lift: list, marker, photo drawer, compose bar. The
    // marker is immediately after the list, so when the drawer opens between
    // the list and the form the band is still on the edge the list actually
    // ends at, with nothing to toggle.
    const at = (needle: string): number => {
      const i = main.indexOf(needle);
      expect(i, `missing ${needle}`).toBeGreaterThan(-1);
      return i;
    };
    expect(at("</main>")).toBeLessThan(at('<div class="edgefade"'));
    expect(at('<div class="edgefade"')).toBeLessThan(at('<div id="pending"'));
    expect(at('<div id="pending"')).toBeLessThan(at('<form id="compose"'));
    // and it is inside the lift wrapper, so the keyboard carries it with the
    // edge rather than leaving it behind
    expect(at('<div class="lift">')).toBeLessThan(at('<div class="edgefade"'));
    expect(at('<div class="edgefade"')).toBeLessThan(at("bindLift("));
  });

  it("each band is the canvas dissolving away from its bar", () => {
    for (const band of bands) {
      const paint = decl(band.rule.body, "background");
      const stops = /^linear-gradient\(to (\w+), (.+), (.+)\)$/.exec(paint);
      expect(stops, `${band.name}: a two-stop linear gradient, not ${paint}`).not.toBeNull();
      const [, direction, opaque, clear] = stops!;
      // the opaque end is the canvas token, so the dark scheme follows with no
      // second rule and no hex can be copied in beside it
      expect(opaque).toBe("var(--bg)");
      expect(clear).toBe("transparent");
      // and it runs from the bar it hangs off toward the list, never back
      expect(direction).toBe(band.runs);
      expect(decl(band.rule.body, band.side)).toBe(band.offset);
      expect(band.rule.body).not.toMatch(/#[0-9a-f]{3}|rgba?\(|hsla?\(/i);
    }
  });

  it("neither band takes any room, so no bar and no list changes size", () => {
    for (const band of bands) {
      expect(decl(band.rule.body, "position")).toBe("absolute");
      // it spans its host and nothing more; the only length it owns is its
      // depth, and nothing here can push a sibling around
      expect(decl(band.rule.body, "left")).toBe("0");
      expect(decl(band.rule.body, "right")).toBe("0");
      for (const grabby of ["margin", "padding", "flex", "display", "float", "width"]) {
        expect(sets(band.rule.body, grabby), `${grabby} has no business on a band`).toBe(false);
      }
    }
    // the marker itself is a flex item in the lift's column, so it has to be
    // no height at all or the list loses exactly that much
    const marker = only(".edgefade");
    expect(decl(marker.body, "height")).toBe("0");
    expect(decl(marker.body, "position")).toBe("relative"); // the band's anchor
    expect(properties(marker.body)).toEqual(["position", "height"]);
  });

  it("neither band answers a touch", () => {
    // the message under the fade is still a message: taps go through
    for (const band of bands) {
      expect(decl(band.rule.body, "pointer-events")).toBe("none");
    }
  });

  it("the depth is one named property, not a number written twice", () => {
    for (const band of bands) {
      expect(decl(band.rule.body, "height")).toBe(`var(${DEPTH})`);
    }
    // declared once, on the shell, where the rest of the app's layout dials live
    const declared = sheets.reduce(
      (n, s) =>
        n +
        s.replace(/\/\*[\s\S]*?\*\//g, "").split(new RegExp(`(?:^|[;{])\\s*${DEPTH}\\s*:`)).length -
        1,
      0,
    );
    expect(declared, `${DEPTH} is declared exactly once`).toBe(1);
    expect(properties(only("#app").body)).toContain(DEPTH);
    // a modest band stated in rem, so it rides the type rather than a phone
    const depth = decl(only("#app").body, DEPTH);
    expect(depth).toMatch(/^\d*\.?\d+rem$/);
    expect(parseFloat(depth)).toBeGreaterThanOrEqual(0.75);
    expect(parseFloat(depth)).toBeLessThanOrEqual(1);
  });

  it("the bands outrank the list and the chevron outranks them", () => {
    // The top band's stacking is the bar's own, and the bar already stands over
    // everything the lift carries — so the band covers a message that has been
    // lifted up under the header, without a z-index of its own to keep in step.
    expect(decl(only(".bar").body, "z-index")).toBe("5");
    // The bottom band takes none either: at auto it paints after the thread's
    // rows (tree order) and before the chevron's face and glyph, which carry 4.
    expect(decl(only(".jump::before").body, "z-index")).toBe("4");
    expect(decl(only(".jump-glyph").body, "z-index")).toBe("4");
    for (const band of bands) {
      expect(sets(band.rule.body, "z-index"), `${band.name} keeps no z-index`).toBe(false);
    }
    expect(sets(only(".edgefade").body, "z-index")).toBe(false);
  });

  it("the bars and the list are the size they were", () => {
    // the fades are overlays and nothing else: no padding moved to make room
    // for one, and no box grew a height to hold one
    expect(decl(only(".bar").body, "padding")).toBe(
      "max(0.5rem, env(safe-area-inset-top)) 0.75rem 0.5rem",
    );
    expect(decl(only(".compose").body, "padding")).toBe("0.5rem 0.75rem var(--pad-b)");
    expect(decl(only(".thread").body, "padding")).toBe(
      "calc(0.75rem + var(--lift-pad, 0px)) 1rem 0.75rem",
    );
    for (const selector of [".bar", ".compose", ".thread"]) {
      for (const box of ["height", "min-height", "max-height"]) {
        expect(sets(only(selector).body, box), `${selector} sets no ${box}`).toBe(false);
      }
    }
    // the header's own gradient is untouched — the band sits under it, it is
    // not a second coat on it
    expect(decl(only(".bar").body, "background")).toBe(
      "linear-gradient(to bottom, var(--bar-grad-top), var(--bar-grad-bottom))",
    );
  });
});
