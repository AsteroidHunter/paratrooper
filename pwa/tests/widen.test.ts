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
import { CARET_CATCHUP_MS, LIFT_SETTLE_MS } from "../src/shell";
import {
  FLIP_CLASS,
  FLIP_PIECES,
  WIDE_CLASS,
  NOCARET_CLASS,
  WIDEN_CARET_MS,
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
const NOCARET_TEXT = "#app .compose.nocaret textarea";

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

  // THE OTHER CARET PIN. On iOS the caret is a UIKit view attached to the
  // enclosing compositing layer, and the transform above gives the focused box
  // its own layer at the focus tap. In 0.3.129 that layer was released again on
  // the frame the transition ended, about 220ms in, right under the end of the
  // keyboard's rise: the phone re-attached the caret from the rect it still
  // held and drew it below the bar. The promotion is therefore declared under
  // every class the keyboard session wears, so nothing is built or torn down
  // under the caret between the focus tap and the blur. Same remedy as .gate's
  // standing will-change (the token card) and the same family as 0.3.71's
  // growing shadow rect on the pill.
  it("the text box keeps ONE layer for the whole keyboard session, and none at rest", () => {
    for (const sel of [UP_TEXT, WIDE_TEXT, FLIP_TEXT]) {
      expect(decl(rule(sel), "will-change"), `${sel} drops the layer`).toBe("transform");
    }
    // every rule in this sheet that touches the textarea, and the only ones
    // allowed to promote it are the session's three
    const promoted = rules
      .filter((r) => /textarea/.test(r.sel) && sets(r.body, "will-change"))
      .map((r) => r.sel);
    expect(promoted).toEqual([UP_TEXT, WIDE_TEXT, FLIP_TEXT]);
    // at rest the box is the engine's own again: a composited text box costs
    // double-tap select and tap-to-caret (composershine.test.ts's rule)
    expect(sets(rule(".compose textarea"), "will-change")).toBe(false);
    // and the promotion covers exactly the states the transform is declared in,
    // plus .wide, where the transform is identity but the layer must stand
    const transformed = rules
      .filter((r) => /textarea/.test(r.sel) && sets(r.body, "transform"))
      .map((r) => r.sel);
    expect(transformed).toEqual(promoted);
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

describe("the caret's hold: a colour, and only a colour", () => {
  const nocaret = rule(NOCARET_TEXT);

  it("paints the caret transparent and touches nothing else", () => {
    expect(decl(nocaret, "caret-color")).toBe("transparent");
    expect(nocaret.replace(/\s/g, "")).toBe("caret-color:transparent;");
  });

  it("changes no layout, so the rule the rise is built on is untouched", () => {
    // 0.3.89: nothing about the focused box's box may move before the keyboard
    // is proven, and this class goes on in the focus tap's own style pass
    for (const prop of [
      "position", "inset", "top", "right", "bottom", "left", "width", "height",
      "margin", "padding", "border", "display", "visibility", "opacity",
      "transform", "font", "font-size", "line-height", "overflow", "transition",
    ]) {
      expect(sets(nocaret, prop), `the hold sets ${prop}`).toBe(false);
    }
  });

  it("leaves the box its own caret colour at rest, and the text its own colour always", () => {
    expect(decl(rule(".compose textarea"), "caret-color")).toBe("var(--accent)");
    expect(sets(nocaret, "color")).toBe(false); // typed characters are never hidden
    // the only two rules in the sheet that hold a caret, and they are the two
    // boxes the keyboard lifts: this one and the sign-in card's
    const holds = rules
      .filter((r) => /caret-color:\s*transparent/.test(r.body))
      .map((r) => r.sel);
    expect(holds).toEqual(["#app.lifting .gate input,\n.gate.inflight input", NOCARET_TEXT]);
  });

  it("is the class the driver writes, spelled once", () => {
    expect(NOCARET_CLASS).toBe("nocaret");
    expect(NOCARET_TEXT).toContain(`.compose.${NOCARET_CLASS} textarea`);
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
  const log: string[] = []; // the layout's own writes and its settle clock
  const caret: string[] = []; // the caret's hold, its frame and its beat
  let pending: (() => void) | null = null; // the settle backstop
  let paint: (() => void) | null = null; // the release's frame
  let beat: (() => void) | null = null; // the release's catch-up beat
  let cancelled = 0;
  const widen = createWiden({
    setWide: (on) => log.push(`wide:${on}`),
    flip: () => log.push("flip"),
    setCaretHidden: (on) => caret.push(on ? "hide" : "show"),
    wait: (ms, fn) => {
      if (ms === WIDEN_CARET_MS) {
        caret.push(`beat:${ms}`);
        beat = fn;
        return () => {
          cancelled += 1;
          if (beat === fn) beat = null;
        };
      }
      log.push(`wait:${ms}`);
      pending = fn;
      return () => {
        cancelled += 1;
        if (pending === fn) pending = null;
      };
    },
    frame: (fn) => {
      caret.push("frame");
      paint = fn;
      return () => {
        cancelled += 1;
        if (paint === fn) paint = null;
      };
    },
  });
  return {
    widen,
    log,
    caret,
    tick: () => {
      const fn = pending;
      pending = null;
      fn?.();
    },
    /** the frame after the switch */
    nextFrame: () => {
      const fn = paint;
      paint = null;
      fn?.();
    },
    /** the phone's catch-up beat, at the end of that frame */
    tickBeat: () => {
      const fn = beat;
      beat = null;
      fn?.();
    },
    /** both, in order: the caret comes back */
    release: () => {
      const f = paint;
      paint = null;
      f?.();
      const b = beat;
      beat = null;
      b?.();
    },
    cancelled: () => cancelled,
    armed: () => pending !== null,
    releasing: () => paint !== null || beat !== null,
  };
}

describe("createWiden — the layout switch waits for the proof, the end and the landing", () => {
  it("a good open: up at the tap, the report proves it, the motion ends, the lift lands, then wide", () => {
    const h = harness();
    h.widen.keyboard(true);
    expect(h.log).toEqual([`wait:${WIDEN_SETTLE_MS}`]);
    h.widen.proven(true); // the viewport's report, about 80ms in
    expect(h.log).toEqual([`wait:${WIDEN_SETTLE_MS}`]); // proven alone switches nothing
    h.widen.ended(); // the face piece's transitionend at 220ms
    expect(h.log).toEqual([`wait:${WIDEN_SETTLE_MS}`]); // and the bar's own end is not enough either
    h.widen.landed(true); // the lift wrapper's transitionend: the transform has stopped
    expect(h.log).toEqual([`wait:${WIDEN_SETTLE_MS}`, "wide:true"]);
    expect(h.widen.state()).toEqual({
      up: true, proven: true, ended: true, landed: true, wide: true, hidden: true,
    });
  });

  it("a late report: the motion ends first, the proof arrives after, the switch waits for it", () => {
    const h = harness();
    h.widen.keyboard(true);
    h.widen.ended();
    h.widen.landed(true);
    expect(h.log).not.toContain("wide:true");
    h.widen.proven(true); // the slowest genuine report in the trail was 319ms
    expect(h.log).toEqual([`wait:${WIDEN_SETTLE_MS}`, "wide:true"]);
  });

  // THE CARET PIN. 0.3.129 switched on the proof and the face piece's end
  // alone. The bar's clock starts at the focus tap and is never retargeted;
  // the lift's is retargeted by the viewport's report whenever the keyboard's
  // height differs from the remembered one, and starts at the report when
  // nothing is remembered. In both, the face piece ends about 85ms before the
  // lift stops, so the focused box's real layout changed under a running
  // ancestor transform — measured in both engines at 77 to 176px of lift still
  // to travel — and iOS drew its caret below the bar for a frame or two, right
  // before the keyboard topped out.
  it("a retargeted lift: the bar's motion ends first and the switch WAITS for the lift to stop", () => {
    const h = harness();
    h.widen.keyboard(true); // the focus tap
    h.widen.proven(true); // the report at ~90ms, at a height the phone did not remember
    h.widen.ended(); // the face piece's own end at ~220ms, on the tap's clock
    expect(h.log).toEqual([`wait:${WIDEN_SETTLE_MS}`]); // NOT wide: the lift is still rising
    h.widen.landed(true); // the retargeted lift, ~85ms later
    expect(h.log).toEqual([`wait:${WIDEN_SETTLE_MS}`, "wide:true"]);
  });

  it("the close's landing is not the rise's: only an up landing counts", () => {
    const h = harness();
    h.widen.keyboard(true);
    h.widen.proven(true);
    h.widen.ended();
    h.widen.landed(false); // a stale close landing arriving late
    expect(h.log).toEqual([`wait:${WIDEN_SETTLE_MS}`]);
    expect(h.widen.state().landed).toBe(false);
    h.widen.landed(true);
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
    h.widen.landed(true);
    expect(h.armed()).toBe(true);
    h.tick();
    expect(h.log).toEqual([`wait:${WIDEN_SETTLE_MS}`, "wide:true"]);
  });

  it("and it backs the BAR only: no clock of this module's ever stands in for the landing", () => {
    // a report slower than this window re-aims the lift and lands it later; a
    // clock that called the landing in would put the switch back inside the
    // motion, which is the whole bug. The shell has its own clock behind the
    // landing (armLift's LIFT_SETTLE_MS + 20), and a proof implies an armed
    // edge, so waiting here can never hang.
    const h = harness();
    h.widen.keyboard(true);
    h.widen.proven(true);
    h.tick(); // the settle window runs out: ended, but not landed
    expect(h.widen.state()).toMatchObject({ ended: true, landed: false, wide: false });
    expect(h.log).toEqual([`wait:${WIDEN_SETTLE_MS}`]);
    const src = readFileSync(new URL("../src/widen.ts", import.meta.url), "utf8");
    const clock = src.match(/deps\.wait\(WIDEN_SETTLE_MS, \(\) => \{([\s\S]*?)\}\);/)?.[1] ?? "";
    expect(clock).toContain("ended = true;");
    expect(clock).not.toContain("landed");
  });

  it("the switch happens once: a second end, a repeated proof, a re-landed lift write nothing", () => {
    const h = harness();
    h.widen.keyboard(true);
    h.widen.proven(true);
    h.widen.ended();
    h.widen.landed(true);
    h.widen.ended();
    h.widen.proven(true);
    h.widen.landed(true); // a keyboard that changed height mid-session lands again
    h.tick();
    expect(h.log.filter((l) => l === "wide:true")).toHaveLength(1);
  });

  it("the switch is ONE write, so no frame can carry half of it", () => {
    // the ＋'s slot, the pill's growth and the text's inset all hang off the
    // one class: a half-applied switch would move the focused box's left edge
    // without the transform coming off it, which is a real jump under the caret
    const h = harness();
    h.widen.keyboard(true);
    h.widen.proven(true);
    h.widen.ended();
    h.widen.landed(true);
    expect(h.log.filter((l) => l.startsWith("wide:"))).toEqual(["wide:true"]);
    const src = readFileSync(new URL("../src/widen.ts", import.meta.url), "utf8");
    expect(src).toContain('setWide: (on) => lookup()?.classList.toggle(WIDE_CLASS, on),');
  });
});

describe("createWiden — the close", () => {
  it("from the wide layout the down edge is the flip, once, and the clock is called off", () => {
    const h = harness();
    h.widen.keyboard(true);
    h.widen.proven(true);
    h.widen.ended();
    h.widen.landed(true);
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
    h.widen.landed(true);
    h.widen.keyboard(false); // flip
    h.widen.proven(false);
    h.widen.keyboard(true); // the quick re-tap while the bar is returning
    expect(h.log.at(-1)).toBe(`wait:${WIDEN_SETTLE_MS}`);
    h.widen.ended(); // the transition, turned round, reaches the wide look
    h.widen.landed(true); // and the lift, turned round with it, stops
    expect(h.log.filter((l) => l === "wide:true")).toHaveLength(1); // still unproven: the first open's switch only
    h.widen.proven(true);
    expect(h.log.filter((l) => l === "wide:true")).toHaveLength(2);
  });

  it("an up edge forgets the last rise's end AND its landing, so the re-tap waits for both again", () => {
    const h = harness();
    h.widen.keyboard(true);
    h.widen.proven(true);
    h.widen.ended();
    h.widen.landed(true);
    h.widen.keyboard(false);
    h.widen.keyboard(true); // the re-tap
    expect(h.widen.state()).toMatchObject({ ended: false, landed: false, wide: false });
    h.widen.ended();
    expect(h.log.filter((l) => l === "wide:true")).toHaveLength(1); // no landing yet
    h.widen.landed(true);
    expect(h.log.filter((l) => l === "wide:true")).toHaveLength(2);
  });

  it("a proof lost while wide waits for the down edge: the flip belongs to the close, not to the viewport", () => {
    const h = harness();
    h.widen.keyboard(true);
    h.widen.proven(true);
    h.widen.ended();
    h.widen.landed(true);
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
    expect(h.widen.state()).toEqual({
      up: false, proven: false, ended: false, landed: false, wide: false, hidden: false,
    });
    h.tick(); // a clock that was already called off fires nothing
    expect(h.log).toEqual([`wait:${WIDEN_SETTLE_MS}`]);
  });
});

// THE CARET'S HOLD. 0.3.131 took the caret below the bar from every open to an
// occasional one by removing the two things the page could remove: the layout
// switch landing inside the lift's motion, and the box's compositor layer
// being released under the caret. What is left is the phone's own redraw from
// a rect WebKit freezes for the length of an accelerated transition, which the
// page has no say in. So the page draws no caret from a rect it knows is
// stale. The rule is the sign-in card's (shell.ts createGateFlight), with the
// layout switch as the release point instead of the card's transition, since
// the switch is the last thing that moves this box's geometry.
describe("createWiden — the caret is not drawn from a rect the page knows is stale", () => {
  it("hidden from the up edge, through the whole rise, and back one frame plus a beat after the switch", () => {
    const h = harness();
    h.widen.keyboard(true); // the focus tap's own style pass
    expect(h.caret).toEqual(["hide"]);
    h.widen.proven(true);
    h.widen.ended();
    expect(h.caret).toEqual(["hide"]); // still moving: still no caret
    h.widen.landed(true); // the switch
    expect(h.log).toContain("wide:true");
    expect(h.caret).toEqual(["hide", "frame"]); // the switch has not painted yet
    h.nextFrame(); // it has now, at the final geometry
    expect(h.caret).toEqual(["hide", "frame", `beat:${WIDEN_CARET_MS}`]);
    expect(h.widen.state().hidden).toBe(true); // the phone has not caught up yet
    h.tickBeat();
    expect(h.caret).toEqual(["hide", "frame", `beat:${WIDEN_CARET_MS}`, "show"]);
    expect(h.widen.state().hidden).toBe(false);
  });

  it("the beat is the phone's own catch-up, measured once for the card and read here", () => {
    expect(WIDEN_CARET_MS).toBe(CARET_CATCHUP_MS);
    const src = readFileSync(new URL("../src/widen.ts", import.meta.url), "utf8");
    expect(src).toContain("export const WIDEN_CARET_MS = CARET_CATCHUP_MS;");
    // and it is a frame FIRST, so the caret's first paint is the final geometry
    // rather than whatever the beat happens to land on
    expect(src).toMatch(/caretOff = deps\.frame\(\(\) => \{\n\s*caretOff = deps\.wait\(WIDEN_CARET_MS,/);
  });

  it("the close gives it straight back, before the flip, in one style pass", () => {
    const h = harness();
    h.widen.keyboard(true);
    h.widen.proven(true);
    h.widen.ended();
    h.widen.landed(true);
    h.release();
    h.widen.keyboard(false);
    expect(h.caret).toEqual(["hide", "frame", `beat:${WIDEN_CARET_MS}`, "show"]); // already back
    expect(h.log.at(-1)).toBe("flip");
    // and from a close taken DURING the hold, the show comes before the flip
    const g = harness();
    g.widen.keyboard(true);
    g.widen.proven(true);
    g.widen.ended();
    g.widen.landed(true); // wide, release pending
    expect(g.widen.state().hidden).toBe(true);
    g.widen.keyboard(false);
    expect(g.widen.state().hidden).toBe(false);
    expect(g.caret).toEqual(["hide", "frame", "show"]); // the pending release, called off
    expect(g.releasing()).toBe(false);
  });

  it("a rise the keyboard never answered gives it back at the bar's own backstop", () => {
    // the 0.3.90 shape: .kb never latches, the shell's focusing window expires
    // a full second later and the sheet's transitions take the bar home. No
    // switch, so the release never runs — and a second with no cursor in a
    // focused box is worse than the flicker the hold is for, so the settle
    // window gives it back instead of waiting for the down edge.
    const h = harness();
    h.widen.keyboard(true);
    h.widen.ended();
    expect(h.widen.state().hidden).toBe(true); // the motion ended; the proof may still come
    h.tick(); // the settle clock: still no proof, so the hold gives up
    expect(h.caret).toEqual(["hide", "show"]);
    expect(h.widen.state()).toMatchObject({ wide: false, hidden: false });
    h.widen.keyboard(false); // the lapse, later: nothing left to do
    expect(h.caret).toEqual(["hide", "show"]);
    expect(h.log).not.toContain("wide:true");
    expect(h.log).not.toContain("flip");
  });

  it("a PROVEN rise still holds through its backstop: only the unproven one gives up", () => {
    // a late landing is not an abandoned rise. The proof is in, so the switch
    // is coming and the caret waits for it however long the lift takes.
    const h = harness();
    h.widen.keyboard(true);
    h.widen.proven(true);
    h.widen.ended();
    h.tick(); // the settle window runs out with the lift still moving
    expect(h.widen.state().hidden).toBe(true);
    expect(h.caret).toEqual(["hide"]);
    h.widen.landed(true);
    h.release();
    expect(h.caret).toEqual(["hide", "frame", `beat:${WIDEN_CARET_MS}`, "show"]);
  });

  it("a blur gives it back at once and calls the pending release off", () => {
    const h = harness();
    h.widen.keyboard(true);
    h.widen.proven(true);
    h.widen.ended();
    h.widen.landed(true);
    expect(h.releasing()).toBe(true);
    h.widen.blurred();
    expect(h.caret).toEqual(["hide", "frame", "show"]);
    expect(h.releasing()).toBe(false);
    // and the release, had it survived, writes nothing now
    h.release();
    expect(h.caret).toEqual(["hide", "frame", "show"]);
    // a blur mid-rise, before any switch, frees it just the same
    const g = harness();
    g.widen.keyboard(true);
    g.widen.blurred();
    expect(g.caret).toEqual(["hide", "show"]);
  });

  it("a form rebuilt under the hold starts the new one clear", () => {
    const h = harness();
    h.widen.keyboard(true);
    expect(h.widen.state().hidden).toBe(true);
    h.widen.reset(); // renderChat replaced the bar mid-rise
    expect(h.caret).toEqual(["hide", "show"]);
    expect(h.widen.state().hidden).toBe(false);
  });

  it("EVERY way a rise can end frees the caret: it can never be left hidden", () => {
    // the same guarantee shell.ts holds for the card ("a lift that never
    // transitions never enters flight, so nothing here can hide the caret for
    // good"). Hidden is only ever set on an up edge, and the shell delivers a
    // down edge for every up edge — a close, a blur, or the focusing window
    // lapsing inside FOCUSING_MAX_MS when no keyboard ever came.
    const endings: [string, (h: ReturnType<typeof harness>) => void][] = [
      ["the switch and its release", (h) => {
        h.widen.proven(true);
        h.widen.ended();
        h.widen.landed(true);
        h.release();
      }],
      ["the down edge from wide", (h) => {
        h.widen.proven(true);
        h.widen.ended();
        h.widen.landed(true);
        h.widen.keyboard(false);
      }],
      ["the down edge mid-rise", (h) => h.widen.keyboard(false)],
      ["the lapse with no proof", (h) => {
        h.widen.ended();
        h.tick();
        h.widen.keyboard(false);
      }],
      ["a blur", (h) => h.widen.blurred()],
      ["a rebuilt form", (h) => h.widen.reset()],
    ];
    for (const [name, end] of endings) {
      const h = harness();
      h.widen.keyboard(true);
      expect(h.widen.state().hidden, `${name}: the hold never started`).toBe(true);
      end(h);
      expect(h.widen.state().hidden, `${name}: the caret was left hidden`).toBe(false);
      expect(h.caret.at(-1), `${name}: the last write is not a show`).toBe("show");
    }
  });

  it("a re-tap takes it again, and the hold is written once per edge", () => {
    const h = harness();
    h.widen.keyboard(true);
    h.widen.keyboard(true); // a duplicate up edge
    h.widen.proven(true);
    h.widen.proven(true);
    expect(h.caret).toEqual(["hide"]); // one write, not two
    h.widen.keyboard(false);
    h.widen.keyboard(false); // a duplicate down edge
    expect(h.caret).toEqual(["hide", "show"]);
    h.widen.keyboard(true); // the re-tap
    expect(h.caret).toEqual(["hide", "show", "hide"]);
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

  it("the caret's hold is one class on the same form, and independent of the layout's", () => {
    const form = fakeEl("form");
    const deps = composeWidenDeps(() => form as unknown as HTMLElement, () => {});
    deps.setCaretHidden(true);
    expect([...form.classes]).toEqual([NOCARET_CLASS]);
    deps.setWide(true); // the switch, while the hold is still on
    expect([...form.classes]).toEqual([NOCARET_CLASS, WIDE_CLASS]);
    deps.setCaretHidden(false); // the release, a frame and a beat later
    expect([...form.classes]).toEqual([WIDE_CLASS]);
  });

  it("no form on screen: the hold writes nothing and throws nothing", () => {
    const deps = composeWidenDeps(() => null, () => {});
    expect(() => deps.setCaretHidden(true)).not.toThrow();
    expect(() => deps.setCaretHidden(false)).not.toThrow();
  });

  it("the frame is the engine's own, and it can be called off", () => {
    const src = readFileSync(new URL("../src/widen.ts", import.meta.url), "utf8");
    expect(src).toContain("const id = requestAnimationFrame(fn);");
    expect(src).toContain("return () => cancelAnimationFrame(id);");
    // and no DOM is touched at import time: it lives inside the factory
    expect(src.slice(0, src.indexOf("export function composeWidenDeps"))).not.toContain(
      "requestAnimationFrame(",
    );
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
    expect(h.widen.state()).toEqual({
      up: false, proven: false, ended: false, landed: false, wide: false, hidden: false,
    });
    const fire = cap.listeners.get("transitionend")!;
    h.widen.keyboard(true);
    h.widen.proven(true);
    fire({ target: cap, propertyName: "visibility" }); // the visibility entry ends too: not the motion
    expect(h.widen.state().ended).toBe(false);
    fire({ target: fakeEl("other"), propertyName: "transform" }); // a bubbled end from elsewhere
    expect(h.widen.state().ended).toBe(false);
    h.widen.landed(true);
    fire({ target: cap, propertyName: "transform" });
    expect(h.widen.state()).toEqual({
      up: true, proven: true, ended: true, landed: true, wide: true, hidden: true,
    });
  });

  it("a focusout on the bar gives the caret back, whatever the rise was doing", () => {
    // focusout, not blur: blur does not bubble and the bar is what is bound.
    // An unfocused box draws no caret, so there is nothing left to hold.
    const cap = fakeEl(".cap");
    const form = fakeEl("form", { ".cap": cap });
    const h = harness();
    bindWiden(form as unknown as HTMLElement, h.widen);
    h.widen.keyboard(true);
    expect(h.widen.state().hidden).toBe(true);
    const out = form.listeners.get("focusout");
    expect(out, "the bar hears no focusout").toBeDefined();
    out!({ target: form });
    expect(h.widen.state().hidden).toBe(false);
    expect(h.caret).toEqual(["hide", "show"]);
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

  it("the lift's landing reaches the driver first too, in the same style pass as the thread's pad", () => {
    // shell.ts hands out ONE landing callback, so the switch and the thread's
    // reachability padding share it; the switch goes first, and both land in
    // the one style pass this task ends with
    expect(main).toMatch(
      /watchLiftLanding\(\(up, lift\) => \{[\s\S]{0,400}?widen\.landed\(up\);\n\s*setLiftPad\(up \? lift : 0\);\n\}\);/,
    );
    expect(main.match(/widen\.landed\(/g)).toHaveLength(1);
    // and the landing itself is the lift wrapper's own transitionend, with the
    // shell's clock behind it — never a guess of the bar's
    expect(shell).toContain('liftLanded("end");');
    expect(shell).toMatch(/liftTimer = setTimeout\(\(\) => \{\n\s*liftTimer = null;\n\s*liftLanded\("clock"\);/);
    expect(shell).toContain("onLiftLanding?.(appliedUp, Number.isFinite(y) ? Math.abs(y) : 0);");
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
