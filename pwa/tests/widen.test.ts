// Pins for the compose bar's widening: the sheet's three moving pieces
// (styles.css .cap, and the keyboard-up rules on the ＋ and the textarea), the
// layout switch and the close in widen.ts, and their wiring in main.ts and
// shell.ts. The record is plans/compose-expand in the wiki.
//
// What every pin here guards is one lesson from the reverted 0.3.89: on that
// build the ＋'s width and margin and the pill's padding began transitioning
// on the very frame of the focus tap, under a clip, and on every open the
// phone put the keyboard up and iOS took it straight back to its accessory
// strip with the box still focused — the "bar stranded at the bottom" report.
// 0.3.88, which was fine, touched no layout for the first 100ms. So:
//   - from the tap until the shell has PROVEN the keyboard, nothing about the
//     textarea's box, its parent's box or its flex siblings' boxes changes:
//     the rise is transform and opacity only, keyed off the shell's own
//     classes so it starts in the lift's style pass;
//   - the real layout (.wide) switches once, at rest, after the proof and the
//     end of the motion, at a point the transforms already occupy, so the
//     switch moves no pixel;
//   - the close starts from the wide look drawn in the resting layout (the
//     flip) and runs back on the keyboard's clock with the lift;
//   - nothing in the bar ever transitions width, margin, padding, height or
//     top, and nothing clips the ＋.
// The arithmetic is read out of the sheet, never retyped: the widen distance
// is the ＋'s width plus the bar's gap, the text's ride is minus that, the
// wide inset is the send column plus that, and the face piece's cut lands on
// the pill's own corner radius.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LIFT_SETTLE_MS } from "../src/shell";
import {
  FLIP_CLASS,
  FLIP_PIECES,
  WIDE_CLASS,
  WIDEN_SETTLE_MS,
  bindWiden,
  composeWidenDeps,
  createWiden,
} from "../src/widen";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");

// innermost brace pairs: every plain rule of this sheet, in source order
const rules = [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  sel: m[1].trim().replace(/\s*\n\s*/g, "\n"),
  body: m[2],
  at: m.index ?? 0,
}));
const found = (sel: string) => rules.find((r) => r.sel === sel);
const rule = (sel: string): string => {
  const r = found(sel);
  expect(r, `missing rule ${sel}`).toBeDefined();
  return r!.body;
};
const decl = (body: string, prop: string): string => {
  const m = new RegExp(`(?:^|;)\\s*${prop.replace(/[-]/g, "\\-")}\\s*:([^;]*)`).exec(body);
  expect(m, `missing ${prop}`).not.toBeNull();
  return m![1].replace(/\s+/g, " ").trim();
};
const sets = (body: string, prop: string): boolean =>
  new RegExp(`(?:^|;)\\s*${prop}\\s*:`).test(body);
// a transition list split at the top level only, so cubic-bezier()'s commas
// stay inside their entry
const entries = (body: string): string[] => {
  const m = body.match(/transition:([^;]*);/);
  if (!m) return [];
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of m[1]) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
};

const UP_ATTACH = "#app.kb .compose .attach,\n#app.focusing .compose .attach";
const UP_TEXT = "#app.kb .compose textarea,\n#app.focusing .compose textarea";
const UP_CAP = "#app.kb .compose .cap,\n#app.focusing .compose .cap";
const WIDE_ATTACH = "#app .compose.wide .attach";
const WIDE_TEXT = "#app .compose.wide textarea";
const WIDE_CAP = "#app .compose.wide .cap";
const FLIP_ATTACH = "#app .compose.flip .attach";
const FLIP_TEXT = "#app .compose.flip textarea";
const FLIP_CAP = "#app .compose.flip .cap";

// --- the sheet ---------------------------------------------------------------

describe("the widen distance is one token, read from the two things that leave", () => {
  const compose = rule(".compose");
  const attach = rule(".attach");
  const token = decl(compose, "--widen");

  it("is the ＋'s width plus the bar's gap, and nothing else", () => {
    const w = decl(attach, "width");
    const gap = decl(compose, "gap");
    expect(token).toBe(`calc(${w} + ${gap})`);
    expect(w).toBe("34px");
    expect(gap).toBe("0.5rem");
  });

  it("is registered as an inherited length, so a computed read answers in px", () => {
    const reg = css.match(/@property --widen \{([^}]*)\}/)?.[1] ?? "";
    expect(reg).toContain('syntax: "<length>"');
    expect(reg).toContain("inherits: true");
    expect(reg).toContain("initial-value: 0px");
  });

  it("is written on the bar once and read everywhere else", () => {
    expect(bare.match(/--widen:\s*calc/g)).toHaveLength(1);
    expect(bare.match(/var\(--widen\)/g)!.length).toBeGreaterThanOrEqual(6);
  });
});

describe("the rise is transform and opacity only, keyed off the shell's own classes", () => {
  it("the ＋ shrinks and fades in place: no width, no margin, no clip, no clock of its own", () => {
    const up = rule(UP_ATTACH);
    expect(decl(up, "opacity")).toBe("0");
    expect(decl(up, "transform")).toMatch(/^scale\(0\.\d+\)$/);
    expect(decl(up, "pointer-events")).toBe("none");
    for (const prop of ["width", "margin-right", "margin", "padding", "overflow", "transition", "height"]) {
      expect(sets(up, prop), `${prop} on the keyboard-up ＋`).toBe(false);
    }
  });

  it("the text rides by the widen distance as a transform, and its box does not change", () => {
    const up = rule(UP_TEXT);
    expect(decl(up, "transform")).toBe("translateX(calc(-1 * var(--widen)))");
    for (const prop of ["padding-right", "padding", "width", "margin", "transition"]) {
      expect(sets(up, prop), `${prop} on the keyboard-up textarea`).toBe(false);
    }
  });

  it("the face piece slides to its wide seat and shows; nothing else about it moves", () => {
    const up = rule(UP_CAP);
    expect(decl(up, "transform")).toBe("translateX(0)");
    expect(decl(up, "visibility")).toBe("visible");
    expect(up.replace(/\s/g, "")).toBe("transform:translateX(0);visibility:visible;");
  });

  it("all three read the keyboard's token at rest, so both directions run on the lift's clock", () => {
    expect(entries(rule(".attach"))).toEqual([
      "transform var(--kb-anim)",
      "opacity var(--kb-anim)",
      "filter 0.3s ease", // the settling window's re-enable fade, untouched
    ]);
    expect(entries(rule(".compose textarea"))).toEqual(["transform var(--kb-anim)"]);
    expect(entries(rule(".cap"))).toEqual(["transform var(--kb-anim)", "visibility var(--kb-anim)"]);
    // and the token itself is the measured keyboard, with no room for a delay
    expect(decl(rule("#app"), "--kb-anim")).toBe("0.22s cubic-bezier(0.45, 0, 0.55, 1)");
  });

  it("no rule in the bar transitions a box: width, margin, padding, height and top never move on a clock", () => {
    const bar = rules.filter((r) => /\.compose|\.attach|\.cap|\.field|textarea/.test(r.sel));
    expect(bar.length).toBeGreaterThan(8);
    for (const r of bar) {
      for (const e of entries(r.body)) {
        const prop = e.split(/\s+/)[0];
        // `none` is the layout switch and the flip: no clock at all
        expect(["transform", "opacity", "visibility", "filter", "--glow-a", "none"], `${r.sel} transitions ${prop}`).toContain(prop);
      }
    }
  });

  it("the ＋ is never clipped, in any state", () => {
    for (const r of rules.filter((r) => /\battach\b/.test(r.sel))) {
      expect(sets(r.body, "overflow"), `${r.sel} clips`).toBe(false);
    }
  });

  it("the textarea carries a transform only under the keyboard classes and the flip, never at rest", () => {
    const withTransform = rules
      .filter((r) => /textarea/.test(r.sel) && sets(r.body, "transform"))
      .map((r) => [r.sel, decl(r.body, "transform")]);
    expect(withTransform).toEqual([
      [UP_TEXT, "translateX(calc(-1 * var(--widen)))"],
      [WIDE_TEXT, "none"],
      [FLIP_TEXT, "translateX(calc(-1 * var(--widen)))"],
    ]);
    // composershine.test.ts's ban on the resting rule still holds
    expect(sets(rule(".compose textarea"), "transform")).toBe(false);
  });
});

describe("the wide layout: switched once, at rest, on the pixels the transforms already occupy", () => {
  const restText = rule(".compose textarea");
  const restPad = restText.match(/padding: [\d.]+px ([\d.]+)px [\d.]+px ([\d.]+)px/);

  it("the ＋ gives up its width and its gap for real, already invisible, with no clock but the settling fade", () => {
    const wide = rule(WIDE_ATTACH);
    expect(decl(wide, "width")).toBe("0");
    expect(decl(wide, "margin-right")).toBe(`-${decl(rule(".compose"), "gap")}`); // eats exactly the bar's gap
    expect(decl(wide, "opacity")).toBe("0");
    expect(decl(wide, "transform")).toBe("none");
    expect(decl(wide, "pointer-events")).toBe("none");
    expect(entries(wide)).toEqual(["filter 0.3s ease"]);
  });

  it("the text's right inset absorbs exactly what the left edge gained, so the wrap width is the same number", () => {
    expect(restPad).not.toBeNull();
    const sendColumn = restPad![1]; // the ↑'s reserved column, both layouts
    expect(sendColumn).toBe("40");
    const wide = rule(WIDE_TEXT);
    expect(decl(wide, "padding-right")).toBe(`calc(${sendColumn}px + var(--widen))`);
    expect(decl(wide, "transform")).toBe("none");
    expect(decl(wide, "transition")).toBe("none");
    // released = the ＋ plus the gap = the token; absorbed = the token: they
    // cancel by construction rather than by two numbers that happen to agree
    expect(decl(rule(".compose"), "--widen")).toBe("calc(34px + 0.5rem)");
  });

  it("the face piece goes back under the pill and hides, without a transition", () => {
    const wide = rule(WIDE_CAP);
    expect(decl(wide, "transform")).toBe("translateX(var(--widen))");
    expect(decl(wide, "visibility")).toBe("hidden");
    expect(decl(wide, "transition")).toBe("none");
  });

  it("the wide rules come after the keyboard-up rules, which they tie on specificity", () => {
    for (const [up, wide] of [
      [UP_ATTACH, WIDE_ATTACH],
      [UP_TEXT, WIDE_TEXT],
      [UP_CAP, WIDE_CAP],
    ]) {
      expect(found(wide)!.at).toBeGreaterThan(found(up)!.at);
    }
  });
});

describe("the flip: the wide look drawn in the resting layout, for one flushed style pass", () => {
  it("mirrors the keyboard-up values with no transition, so the return starts from them", () => {
    const flipAttach = rule(FLIP_ATTACH);
    expect(decl(flipAttach, "opacity")).toBe(decl(rule(UP_ATTACH), "opacity"));
    expect(decl(flipAttach, "transform")).toBe(decl(rule(UP_ATTACH), "transform"));
    expect(decl(flipAttach, "transition")).toBe("none");
    expect(sets(flipAttach, "width")).toBe(false); // the resting 34px: the layout IS rest

    const flipText = rule(FLIP_TEXT);
    expect(decl(flipText, "transform")).toBe(decl(rule(UP_TEXT), "transform"));
    expect(decl(flipText, "transition")).toBe("none");
    expect(sets(flipText, "padding-right")).toBe(false);

    const flipCap = rule(FLIP_CAP);
    expect(decl(flipCap, "transform")).toBe("translateX(0)");
    expect(decl(flipCap, "visibility")).toBe("visible");
    expect(decl(flipCap, "transition")).toBe("none");
  });
});

describe("the face piece is the pill's left end drawn again, under the text and above the face", () => {
  const cap = rule(".cap");
  const field = rule(".field");

  it("sits out of the pill's flow at the wide pill's end, hidden and inert at rest", () => {
    expect(decl(cap, "position")).toBe("absolute");
    expect(decl(cap, "top")).toBe("0");
    expect(decl(cap, "bottom")).toBe("0");
    expect(decl(cap, "left")).toBe("calc(-1 * var(--widen))");
    expect(decl(cap, "transform")).toBe("translateX(var(--widen))"); // wholly under the pill
    expect(decl(cap, "visibility")).toBe("hidden");
    expect(decl(cap, "pointer-events")).toBe("none");
  });

  it("paints above the pill's face and below the text: negative z-index inside an isolated pill", () => {
    expect(decl(cap, "z-index")).toBe("-1");
    expect(decl(field, "isolation")).toBe("isolate");
  });

  it("wears the pill's own face, rim, inset lighting and radius, and no outer shadow", () => {
    expect(decl(cap, "background-color")).toBe("var(--bg)"); // opaque underlay: the canvas
    expect(decl(cap, "background-image")).toBe("linear-gradient(var(--glass-bg), var(--glass-bg))"); // the glass over it
    expect(decl(field, "background-color")).toBe("var(--glass-bg)"); // the same tint the pill composites over that canvas
    const shadow = decl(cap, "box-shadow");
    expect(shadow).toBe("inset 0 0 0 0.5px var(--glass-rim), var(--glass-inset)");
    expect(decl(field, "box-shadow")).toMatch(/^inset 0 0 0 0\.5px var\(--glass-rim\), var\(--glass-stack\)/);
    const radius = decl(field, "border-radius");
    expect(decl(cap, "border-radius")).toBe(`${radius} 0 0 ${radius}`);
    // the inset lighting is split out of BOTH schemes' stacks and each stack still reads it
    const scheme = (from: number, to: number) => bare.slice(from, to);
    const dark = bare.indexOf("@media (prefers-color-scheme: dark)");
    for (const sheet of [scheme(0, dark), scheme(dark, bare.length)]) {
      expect(sheet).toMatch(/--glass-inset:\s*inset 0 1px 0 [^;]*inset 0 0 0 1px var\(--hairline\),\s*inset 0 0 2px [^;]*;/);
      expect(sheet).toMatch(/--glass-stack:\s*var\(--glass-inset\),/);
      expect(sheet.match(/inset 0 0 0 1px var\(--hairline\)/g)).toHaveLength(2); // the inset token and the small stack, not a third copy
    }
  });

  it("ends in a straight cut on the pill's corner radius, with the edge clipped off", () => {
    const radius = Number(decl(field, "border-radius").replace("px", ""));
    const width = decl(cap, "width").match(/^calc\(var\(--widen\) \+ (\d+)px\)$/);
    const clip = decl(cap, "clip-path").match(/^inset\(0 (\d+)px 0 0\)$/);
    expect(width).not.toBeNull();
    expect(clip).not.toBeNull();
    // the visible piece reaches exactly the radius past the resting pill's
    // edge: over the pill's own rounded corner, inside its straight section
    expect(Number(width![1]) - Number(clip![1])).toBe(radius);
    expect(Number(clip![1])).toBeGreaterThanOrEqual(2); // the 2px melt, the 1px ring and the half-pixel rim all go with the cut
  });

  it("is rendered as the pill's first child, marked decorative", () => {
    expect(main).toMatch(
      /<div class="field">\n\s*<div class="cap" aria-hidden="true"><\/div>\n\s*<textarea id="text" rows="1" data-owned-focus/,
    );
    expect(main.match(/class="cap"/g)).toHaveLength(1);
  });
});

// --- the driver ---------------------------------------------------------------

function harness() {
  const log: string[] = [];
  let pending: (() => void) | null = null;
  let cancelled = 0;
  const widen = createWiden({
    setWide: (on) => log.push(`wide:${on}`),
    flip: () => log.push("flip"),
    wait: (ms, fn) => {
      log.push(`wait:${ms}`);
      pending = fn;
      return () => {
        cancelled += 1;
        if (pending === fn) pending = null;
      };
    },
  });
  return {
    widen,
    log,
    tick: () => {
      const fn = pending;
      pending = null;
      fn?.();
    },
    cancelled: () => cancelled,
    armed: () => pending !== null,
  };
}

describe("createWiden — the layout switch waits for the proof and the end, in either order", () => {
  it("a good open: up at the tap, the report proves it, the motion ends, then and only then wide", () => {
    const h = harness();
    h.widen.keyboard(true);
    expect(h.log).toEqual([`wait:${WIDEN_SETTLE_MS}`]);
    h.widen.proven(true); // the viewport's report, about 80ms in
    expect(h.log).toEqual([`wait:${WIDEN_SETTLE_MS}`]); // proven alone switches nothing
    h.widen.ended(); // the face piece's transitionend at 220ms
    expect(h.log).toEqual([`wait:${WIDEN_SETTLE_MS}`, "wide:true"]);
    expect(h.widen.state()).toEqual({ up: true, proven: true, ended: true, wide: true });
  });

  it("a late report: the motion ends first, the proof arrives after, the switch waits for it", () => {
    const h = harness();
    h.widen.keyboard(true);
    h.widen.ended();
    expect(h.log).not.toContain("wide:true");
    h.widen.proven(true); // the slowest genuine report in the trail was 319ms
    expect(h.log).toEqual([`wait:${WIDEN_SETTLE_MS}`, "wide:true"]);
  });

  it("the 0.3.90 shape: a keyboard that never proves itself never gets the layout, and the lapse flips nothing", () => {
    const h = harness();
    h.widen.keyboard(true);
    h.widen.ended();
    h.tick(); // the settle clock too: still no proof
    h.widen.keyboard(false); // the shell's signals lapsed with the box still focused
    expect(h.log).toEqual([`wait:${WIDEN_SETTLE_MS}`]); // no wide, no flip: the sheet's transitions take the bar home
    expect(h.widen.state().wide).toBe(false);
  });

  it("the clock is the backstop for a transition that never says it ended, on the lift's own window", () => {
    expect(WIDEN_SETTLE_MS).toBe(LIFT_SETTLE_MS);
    const h = harness();
    h.widen.keyboard(true);
    h.widen.proven(true);
    expect(h.armed()).toBe(true);
    h.tick();
    expect(h.log).toEqual([`wait:${WIDEN_SETTLE_MS}`, "wide:true"]);
  });

  it("the switch happens once: a second end, a repeated proof, a re-landed lift write nothing", () => {
    const h = harness();
    h.widen.keyboard(true);
    h.widen.proven(true);
    h.widen.ended();
    h.widen.ended();
    h.widen.proven(true);
    h.tick();
    expect(h.log.filter((l) => l === "wide:true")).toHaveLength(1);
  });
});

describe("createWiden — the close", () => {
  it("from the wide layout the down edge is the flip, once, and the clock is called off", () => {
    const h = harness();
    h.widen.keyboard(true);
    h.widen.proven(true);
    h.widen.ended();
    h.widen.keyboard(false);
    expect(h.log).toEqual([`wait:${WIDEN_SETTLE_MS}`, "wide:true", "flip"]);
    expect(h.widen.state().wide).toBe(false);
    h.widen.keyboard(false); // a duplicate down edge
    h.widen.proven(false); // the viewport catching up
    expect(h.log).toEqual([`wait:${WIDEN_SETTLE_MS}`, "wide:true", "flip"]);
  });

  it("a close mid-rise flips nothing: the layout never switched, the transitions simply turn round", () => {
    const h = harness();
    h.widen.keyboard(true);
    h.widen.proven(true);
    h.widen.keyboard(false); // focus lost before the motion ended
    expect(h.log).toEqual([`wait:${WIDEN_SETTLE_MS}`]);
    expect(h.cancelled()).toBe(1); // the settle clock is called off with the edge
    h.widen.ended(); // the return's own end, later: nothing to switch
    h.tick();
    expect(h.log).toEqual([`wait:${WIDEN_SETTLE_MS}`]);
  });

  it("a re-tap mid-fall: up again re-arms the clock, and the retargeted motion's end switches once the proof is in", () => {
    const h = harness();
    h.widen.keyboard(true);
    h.widen.proven(true);
    h.widen.ended();
    h.widen.keyboard(false); // flip
    h.widen.proven(false);
    h.widen.keyboard(true); // the quick re-tap while the bar is returning
    expect(h.log.at(-1)).toBe(`wait:${WIDEN_SETTLE_MS}`);
    h.widen.ended(); // the transition, turned round, reaches the wide look
    expect(h.log.filter((l) => l === "wide:true")).toHaveLength(1); // still unproven: the first open's switch only
    h.widen.proven(true);
    expect(h.log.filter((l) => l === "wide:true")).toHaveLength(2);
  });

  it("a proof lost while wide waits for the down edge: the flip belongs to the close, not to the viewport", () => {
    const h = harness();
    h.widen.keyboard(true);
    h.widen.proven(true);
    h.widen.ended();
    h.widen.proven(false); // the keyboard minimised under a held focus
    expect(h.widen.state().wide).toBe(true);
    expect(h.log).not.toContain("flip");
    h.widen.keyboard(false); // the focusing window lapses: the shell's down edge
    expect(h.log.at(-1)).toBe("flip");
  });

  it("reset forgets everything and calls the clock off", () => {
    const h = harness();
    h.widen.keyboard(true);
    h.widen.proven(true);
    h.widen.reset();
    expect(h.cancelled()).toBe(1);
    expect(h.widen.state()).toEqual({ up: false, proven: false, ended: false, wide: false });
    h.tick(); // a clock that was already called off fires nothing
    expect(h.log).toEqual([`wait:${WIDEN_SETTLE_MS}`]);
  });
});

// --- the binder ---------------------------------------------------------------

interface FakeEl {
  classes: Set<string>;
  classList: { toggle(c: string, on?: boolean): void; add(c: string): void; remove(c: string): void };
  querySelector(sel: string): FakeEl | null;
  addEventListener(type: string, fn: (e: unknown) => void): void;
  listeners: Map<string, (e: unknown) => void>;
  name: string;
}

function fakeEl(name: string, children: Record<string, FakeEl> = {}): FakeEl {
  const classes = new Set<string>();
  const listeners = new Map<string, (e: unknown) => void>();
  return {
    name,
    classes,
    listeners,
    classList: {
      toggle: (c, on) => {
        if (on === undefined ? !classes.has(c) : on) classes.add(c);
        else classes.delete(c);
      },
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
    },
    querySelector: (sel) => children[sel] ?? null,
    addEventListener: (type, fn) => listeners.set(type, fn),
  };
}

describe("composeWidenDeps — the effects on the live form", () => {
  it("wide is one class on the form, looked up live", () => {
    const form = fakeEl("form");
    const deps = composeWidenDeps(() => form as unknown as HTMLElement, () => {});
    deps.setWide(true);
    expect([...form.classes]).toEqual([WIDE_CLASS]);
    deps.setWide(false);
    expect([...form.classes]).toEqual([]);
  });

  it("the flip is wide off, flip on, one flush per moving piece, flip off — in that order, in one call", () => {
    const seq: string[] = [];
    const pieces = Object.fromEntries(FLIP_PIECES.map((sel) => [sel, fakeEl(sel)]));
    const form = fakeEl("form", pieces);
    form.classes.add(WIDE_CLASS);
    const record = (c: string, on: boolean) => seq.push(`${on ? "+" : "-"}${c}`);
    const inner = form.classList;
    form.classList = {
      toggle: inner.toggle,
      add: (c) => {
        record(c, true);
        inner.add(c);
      },
      remove: (c) => {
        record(c, false);
        inner.remove(c);
      },
    };
    const deps = composeWidenDeps(
      () => form as unknown as HTMLElement,
      (el) => seq.push(`flush ${(el as unknown as FakeEl).name}`),
    );
    deps.flip();
    expect(seq).toEqual([`-${WIDE_CLASS}`, `+${FLIP_CLASS}`, "flush .cap", "flush textarea", "flush .attach", `-${FLIP_CLASS}`]);
    expect([...form.classes]).toEqual([]); // nothing left on the form: the base rules carry the return
    expect(FLIP_PIECES).toEqual([".cap", "textarea", ".attach"]); // every piece the sheet moves
  });

  it("no form on screen: nothing happens, nothing throws", () => {
    const deps = composeWidenDeps(() => null, () => {
      throw new Error("flushed nothing");
    });
    expect(() => deps.flip()).not.toThrow();
    expect(() => deps.setWide(true)).not.toThrow();
  });

  it("the real flush is one computed read of the piece's transform", () => {
    const src = readFileSync(new URL("../src/widen.ts", import.meta.url), "utf8");
    expect(src).toContain("flush: (el: HTMLElement) => void = (el) => void getComputedStyle(el).transform,");
  });
});

describe("bindWiden — the face piece's own transitionend is the end of the motion", () => {
  it("resets the core for the fresh form, then hears the transform end and nothing else", () => {
    const cap = fakeEl(".cap");
    const form = fakeEl("form", { ".cap": cap });
    const h = harness();
    h.widen.keyboard(true);
    bindWiden(form as unknown as HTMLElement, h.widen);
    expect(h.widen.state()).toEqual({ up: false, proven: false, ended: false, wide: false });
    const fire = cap.listeners.get("transitionend")!;
    h.widen.keyboard(true);
    h.widen.proven(true);
    fire({ target: cap, propertyName: "visibility" }); // the visibility entry ends too: not the motion
    expect(h.widen.state().ended).toBe(false);
    fire({ target: fakeEl("other"), propertyName: "transform" }); // a bubbled end from elsewhere
    expect(h.widen.state().ended).toBe(false);
    fire({ target: cap, propertyName: "transform" });
    expect(h.widen.state()).toEqual({ up: true, proven: true, ended: true, wide: true });
  });
});

// --- the wiring ---------------------------------------------------------------

describe("wiring: one driver, fed by the shell's two edges, bound per render", () => {
  it("main.ts builds the driver on the live form and feeds it the proven edge", () => {
    expect(main).toContain(
      'const widen = createWiden(composeWidenDeps(() => document.getElementById("compose")));',
    );
    expect(main).toContain("watchKeyboardProven((proven) => widen.proven(proven));");
  });

  it("the keyboard edge reaches the driver first in the existing gate, so the close starts in the lift's frame", () => {
    expect(main).toMatch(/watchKeyboard\(\(up\) => \{\n\s*widen\.keyboard\(up\);/);
  });

  it("the bar is bound per render, with the rest of the bar", () => {
    expect(main).toMatch(
      /bindComposeDismiss\(document\.getElementById\("compose"\)!, textEl\);[\s\S]{0,400}bindWiden\(document\.getElementById\("compose"\)!, widen\);/,
    );
    expect(main.match(/bindWiden\(/g)).toHaveLength(1);
  });

  it("shell.ts fires the proven edge last in applyShell, after the classes it describes", () => {
    const apply = shell.match(/function applyShell\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(apply).toMatch(
      /onKeyboard\?\.\(keyboard\);\n\s*\}\n[\s\S]{0,200}if \(t\.kb !== appliedProven\) \{\n\s*appliedProven = t\.kb;\n\s*onKeyboardProven\?\.\(t\.kb\);\n\s*\}\n\}$/,
    );
    expect(shell).toContain("export function watchKeyboardProven(cb: (proven: boolean) => void): void {");
  });

  it("no JavaScript joins the tap path: the rise is the sheet's, keyed off .focusing and .kb", () => {
    // the driver never touches a class on the up edge; it only arms its clock
    const src = readFileSync(new URL("../src/widen.ts", import.meta.url), "utf8");
    const up = src.match(/if \(isUp\) \{([\s\S]*?)return;\n\s*\}/)?.[1] ?? "";
    expect(up).toContain("ended = false;");
    expect(up).toContain("callOff = deps.wait(WIDEN_SETTLE_MS");
    expect(up).not.toMatch(/setWide|flip|classList/);
    // and the up-look rules are keyed off the shell's classes, not the driver's
    for (const sel of [UP_ATTACH, UP_TEXT, UP_CAP]) expect(found(sel)).toBeDefined();
    expect(bare).not.toMatch(/\.compose\.rising|\.compose\.widening/);
  });
});
