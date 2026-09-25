// Pins for the placeholder's repaint on send (main.ts send's collapseBar, and
// styles.css .compose.emptying).
//
// The phone, 0.3.165: send "Who this" with the keyboard up and the emptied box
// shows "Carrier pi", the prompt cut off exactly where the sent words ended.
// Emptying a textarea brings its placeholder back as a fresh box, and WebKit's
// textarea layout does not repaint that box (a one-line input's layout does).
// While the keyboard is up the text box is its own layer (widen.test.ts), so
// nothing else is sure to repaint it, and the only part of the prompt drawn
// is the slice under the text that left.
//
// The answer is a colour change, which repaints the placeholder's whole box:
// the placeholder is laid out wearing .emptying, and the class comes off in the
// same task, before any frame is drawn. So the class is never on screen, and
// what these pins hold is the order and the reach: on, clear, lay out, off,
// only when the box held text, and a rule that touches the placeholder's
// colour and nothing else.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";
import { transformWithEsbuild } from "vite";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");

const SEL = "#app .compose.emptying textarea::placeholder";

function sourceBetween(start: string, end: string): string {
  const at = main.indexOf(start);
  const until = main.indexOf(end, at + start.length);
  expect(at, `missing ${start}`).toBeGreaterThanOrEqual(0);
  expect(until, `missing ${end}`).toBeGreaterThan(at);
  return main.slice(at, until);
}

// send()'s own clear, lifted out and run against a recording fake
const COLLAPSE_START = "const collapseBar = (): void => {";
const COLLAPSE_END = "// WHEN the bar collapses";
let collapseBlock = "";

beforeAll(async () => {
  collapseBlock =
    (
      await transformWithEsbuild(sourceBetween(COLLAPSE_START, COLLAPSE_END), "collapse.ts", {
        loader: "ts",
      })
    ).code + "\nglobalThis.__collapse = collapseBar;\n";
});

/** the send's clear on a box holding `typed`, with every effect written down in order */
function clear(typed: string): { log: string[]; classes: Set<string> } {
  const log: string[] = [];
  const classes = new Set<string>();
  const form = {
    classList: {
      add: (c: string) => {
        classes.add(c);
        log.push(`+${c}`);
      },
      remove: (c: string) => {
        classes.delete(c);
        log.push(`-${c}`);
      },
    },
  };
  let value = typed;
  const textEl = {
    form,
    get value() {
      return value;
    },
    set value(v: string) {
      value = v;
      log.push(`value=${JSON.stringify(v)}`);
    },
    // a layout read: the one place the placeholder's box is laid out
    get offsetHeight() {
      log.push(`layout [${[...classes].join(" ")}]`);
      return 39;
    },
  };
  const context: Record<string, unknown> = {
    textEl,
    performance: { now: () => 0 },
    composerWroteAt: -Infinity,
    pendingFiles: ["kept?"],
    autosize: () => log.push("autosize"),
    dismissSent: () => log.push("dismissSent"),
  };
  runInNewContext(collapseBlock, context);
  (context.__collapse as () => void)();
  expect(value).toBe("");
  expect(context.pendingFiles).toEqual([]);
  return { log, classes };
}

describe("the send empties the box and then repaints the whole placeholder", () => {
  it("lays the placeholder out under .emptying, then takes the class off in the same task", () => {
    const { log, classes } = clear("Who this");
    expect(log).toEqual([
      "+emptying", // before the clear, so the placeholder's first style has it
      'value=""',
      "autosize",
      "layout [emptying]", // the placeholder's box laid out while wearing the class
      "-emptying", // the colour change that repaints that whole box
      "dismissSent",
    ]);
    expect(classes.size).toBe(0); // nothing is left on the form for a frame to draw
  });

  it("leaves a box that held no text alone: its placeholder is already drawn", () => {
    // a photo-only send clears an empty box; there is no fresh placeholder box
    // to repaint, so no class and no extra layout
    const { log, classes } = clear("");
    expect(log).toEqual(['value=""', "autosize", "dismissSent"]);
    expect(classes.size).toBe(0);
  });

  it("holds the whole stretch in one task: nothing waits between on and off", () => {
    const block = sourceBetween(COLLAPSE_START, COLLAPSE_END);
    const on = block.indexOf('classList.add("emptying")');
    const off = block.indexOf('classList.remove("emptying")');
    expect(on).toBeGreaterThanOrEqual(0);
    expect(off).toBeGreaterThan(on);
    expect(block.slice(on, off)).not.toMatch(/\bawait\b|requestAnimationFrame|setTimeout|\.then\(/);
    // and the class is written nowhere else in the app, so it cannot linger
    expect(main.match(/"emptying"/g)).toHaveLength(2);
  });
});

describe("the rule behind it reaches the placeholder's colour and nothing else", () => {
  const rules = [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    sel: m[1].trim(),
    body: m[2],
  }));

  it("paints the placeholder transparent under .emptying", () => {
    const hits = rules.filter((r) => r.sel === SEL);
    expect(hits, `missing ${SEL}`).toHaveLength(1);
    // colour only: no box, no layout, no caret, no clock
    expect(hits[0].body.replace(/\s/g, "")).toBe("color:transparent;");
  });

  it("is the only rule that names the class or styles the placeholder", () => {
    expect(rules.filter((r) => /emptying/.test(r.sel)).map((r) => r.sel)).toEqual([SEL]);
    expect(rules.filter((r) => /placeholder/.test(r.sel)).map((r) => r.sel)).toEqual([SEL]);
  });
});
