// Pins for the log-out question: that it is the notification card's twin, and
// that it is that twin by being the same rules rather than a good copy of them.
//
// It used to be its own small flat card — a 14px radius on the opaque menu
// grey, a 15px bold line, and two text buttons split by a hairline, the safe
// one in the legacy iOS blue and the destructive one in red — while the
// notification card had moved on to the system's centred alert. Nothing was
// wrong with either sheet; they were simply two sheets, and that is the whole
// reason one fell behind. So the pins below are mostly about sharing: the box
// names only the shared classes, the sheet holds one rule per selector, and
// there is nothing in the app's own stylesheet left for a confirm box at all.
//
// The behaviour half runs. Cancel and Log Out both have to play the box out
// first, and "the teardown happens after the fade, not during it" is a claim
// about a sequence in time that reading the source cannot settle.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { transformWithEsbuild } from "vite";

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const alertCss = readFileSync(new URL("../src/alert.css", import.meta.url), "utf8");

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

/** One declaration out of a rule body, whitespace flattened. */
function decl(body: string, property: string): string {
  const m = new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]*)`).exec(body);
  expect(m, `missing ${property}`).not.toBeNull();
  return m![1].replace(/\s+/g, " ").trim();
}

/** The one rule for this selector that is not inside an at-rule. */
function only(sheet: Rule[], selector: string): Rule {
  const found = sheet.filter((r) => r.selectors.includes(selector) && r.at.length === 0);
  expect(found, `expected exactly one plain ${selector} rule`).toHaveLength(1);
  return found[0];
}

function sourceBetween(start: string, end: string): string {
  const at = main.indexOf(start);
  const until = main.indexOf(end, at + start.length);
  expect(at, `missing ${start}`).toBeGreaterThanOrEqual(0);
  expect(until, `missing ${end}`).toBeGreaterThan(at);
  return main.slice(at, until);
}

const alertRules = parse(alertCss);
/** The sheet with its prose taken out, so pins land on rules, not comments. */
const alertSheet = alertCss.replace(/\/\*[\s\S]*?\*\//g, "");
const render = sourceBetween("function renderChat()", "async function loadOlder(");
/** The log-out box's markup, from its own div to the end of the template. */
const boxMarkup = render.slice(
  render.indexOf('id="confirm"'),
  render.indexOf('<div class="liftclip">'),
);

describe("the log-out question is the notification card, wearing other words", () => {
  it("is built out of the shared classes and names none of its own", () => {
    expect(boxMarkup).toContain('id="confirm" class="alert-dialog"');
    expect(boxMarkup).toContain('<div class="alert-card">');
    expect(boxMarkup).toContain('id="confirm-copy" class="alert-copy"');
    expect(boxMarkup).toContain('<div class="alert-actions">');
    // the old box's own family is gone from the app entirely — markup and
    // sheet. Its two buttons keep their ids; it is the classes that went.
    for (const source of [main, styles]) {
      expect(source).not.toMatch(/\bconfirm-(?:card|msg|row)\b/);
      expect(source).not.toMatch(/class="confirm(?:-no|-yes|")/);
    }
    expect(parse(styles).some((r) => r.selectors.some((s) => s.startsWith(".confirm")))).toBe(
      false,
    );
  });

  it("is announced the same way, and ships closed like the card does", () => {
    expect(boxMarkup).toContain('role="alertdialog"');
    expect(boxMarkup).toContain('aria-modal="true"');
    expect(boxMarkup).toContain('aria-labelledby="confirm-copy"');
    // hidden, not a transparent layer parked over the chat: the old box sat
    // there at opacity 0 with pointer-events off, which is a second thing to
    // remember to switch off. The shared rules take it out of the layout.
    expect(boxMarkup).toMatch(/aria-labelledby="confirm-copy" hidden>/);
    expect(only(alertRules, ".alert-dialog[hidden]").body).toContain("display: none");
  });

  it("asks the question it always asked, and answers it with the two pills", () => {
    expect(boxMarkup).toContain("Are you sure you want to log out?");
    const labels = [...boxMarkup.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((m) =>
      m[1].trim(),
    );
    expect(labels).toEqual(["Cancel", "Log Out"]);
    // the one the box is asking for is the filled pill, the quiet one is beside
    // it — the same way round as Not Now beside Enable
    expect(boxMarkup).toContain('id="confirm-no" class="alert-quiet"');
    expect(boxMarkup).toContain('id="confirm-yes" class="alert-action"');
  });

  it("takes the accent pill and the quiet pill, and no red of its own", () => {
    const bubble = only(parse(styles), ".msg.user"); // the user's own message
    const action = only(alertRules, ".alert-action");
    const quiet = only(alertRules, ".alert-quiet");
    // the same two rules the card wears, resolving to the same bubble
    expect(decl(action.body, "background")).toBe(decl(bubble.body, "background"));
    expect(decl(action.body, "color")).toBe(decl(bubble.body, "color"));
    expect(decl(quiet.body, "color")).toBe(decl(bubble.body, "background"));
    // Log Out is destructive, and the system's own alert still does not paint
    // its pill red — nothing in the sheet may single this box out
    expect(alertSheet).not.toMatch(/--error-text|--sent\)/);
    expect(alertSheet, "no rule may single a box out").not.toMatch(
      /#confirm|\.confirm|#push|logout/i,
    );
  });

  it("shares every rule: the sheet states each selector once, for both boxes", () => {
    const plain = alertRules.filter((r) => r.at.length === 0);
    const seen = plain.flatMap((r) => r.selectors);
    expect(seen.length, "a selector is stated twice").toBe(new Set(seen).size);
    // and every one of them is the shared family, so neither box has a rule
    // that is only its own to fall behind with
    for (const selector of seen) {
      expect(selector, `${selector} is not a shared alert rule`).toMatch(/^\.alert-/);
    }
  });

  it("arrives and leaves on the one clock, which it does not restate", () => {
    // the box borrows the layer's fade and the card's settle by being them; the
    // only number anywhere is --alert-anim, and it is written once
    expect([...alertSheet.matchAll(/--alert-anim\s*:([^;]*)/g)]).toHaveLength(1);
    expect(decl(only(alertRules, ".alert-dialog").body, "transition")).toBe(
      "opacity var(--alert-anim)",
    );
    expect(decl(only(alertRules, ".alert-card").body, "transition")).toBe(
      "transform var(--alert-anim)",
    );
    expect(alertSheet).not.toMatch(/transition:[^;]*\d+(?:ms|s)\b/); // no second timing
    // the JS side waits out that same fade, from one constant
    const held = /const ALERT_TRANSITION_MS = (\d+);/.exec(main);
    expect(held, "missing ALERT_TRANSITION_MS").not.toBeNull();
    expect(`${held![1]}ms ease-in-out`).toBe(
      /--alert-anim\s*:([^;]*)/.exec(alertSheet)![1].trim(),
    );
  });

  it("goes up and comes down through the alert's own two functions", () => {
    const wiring = render.slice(render.indexOf('const confirmEl = document.getElementById'));
    const logout = wiring.slice(0, wiring.indexOf("const filesEl"));
    expect(logout).toContain("showAlert(confirmEl)");
    // three ways out of the box, and all three are the shared exit
    expect(logout.match(/hideAlert\(confirmEl/g)).toHaveLength(3);
    // no second mechanism: the box's own classes are the alert's to write
    expect(logout).not.toMatch(/confirmEl\.classList/);
    // and the teardown is what the exit is given to run when it has finished
    expect(logout).toMatch(
      /hideAlert\(confirmEl, \(\) => \{\s*leaveChat\(\);[\s\S]*?renderTokenGate\(\);\s*\}\)/,
    );
  });
});

// --- the two answers, run ----------------------------------------------------
//
// The alert's block is cut out of main.ts by name and run in a VM, the way
// push.test.ts runs it: main.ts is the app's entry point, so importing it would
// boot the whole app, and there is no DOM here. The stand-in is the smallest
// thing the two functions ask of an element.

/** Enough of an element for the alert: classes, hidden, attributes. */
class DialogStandIn {
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  private classes = new Set<string>();
  hidden = false;

  classList = {
    add: (name: string) => void this.classes.add(name),
    remove: (name: string) => void this.classes.delete(name),
    contains: (name: string) => this.classes.has(name),
  };

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
}

let alertScript = "";
let TRANSITION_MS = 0;

beforeAll(async () => {
  const block = sourceBetween("const ALERT_TRANSITION_MS", "function pushApisSupported(");
  TRANSITION_MS = Number(/const ALERT_TRANSITION_MS = (\d+);/.exec(block)![1]);
  alertScript = (await transformWithEsbuild(block, "alert.ts", { loader: "ts" })).code;
});

function logoutHarness() {
  const dialog = new DialogStandIn();
  dialog.hidden = true; // as renderChat's markup ships it
  const frames = new Map<number, () => void>();
  let nextFrame = 1;
  const context: Record<string, unknown> = {
    document: { getElementById: () => null },
    window: {
      setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
      clearTimeout: (handle: number) => clearTimeout(handle),
    },
    requestAnimationFrame: (run: () => void) => {
      const handle = nextFrame++;
      frames.set(handle, run);
      return handle;
    },
    cancelAnimationFrame: (handle: number) => void frames.delete(handle),
    pushNotifications: null,
  };
  runInNewContext(alertScript, context);
  const call = (name: string, ...args: unknown[]): void => {
    (context[name] as (...a: unknown[]) => void)(...args);
  };
  return {
    dialog,
    show: () => call("showAlert", dialog),
    hide: (settled?: () => void) => call("hideAlert", dialog, settled),
    /** Run the frame the entrance is waiting on, landing it at rest. */
    paint: () => {
      const due = [...frames.values()];
      frames.clear();
      for (const run of due) run();
    },
    entering: () => dialog.classList.contains("alert-entering"),
    leaving: () => dialog.classList.contains("alert-leaving"),
  };
}

describe("Cancel and Log Out, through the shared show and hide", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A box that has been opened from the menu and has finished arriving. */
  function open(): ReturnType<typeof logoutHarness> {
    const h = logoutHarness();
    h.show();
    return h;
  }

  it("comes up on the entrance, from the start state, and settles at rest", () => {
    const h = open();
    expect(h.dialog.hidden).toBe(false);
    expect([h.entering(), h.leaving()]).toEqual([true, false]);
    expect(h.dialog.attributes["aria-hidden"]).toBe("false");
    h.paint();
    expect([h.entering(), h.leaving()]).toEqual([false, false]);
  });

  it("Cancel plays the exit and leaves the chat exactly where it was", () => {
    const h = open();
    h.paint();
    h.hide();
    expect([h.entering(), h.leaving()]).toEqual([false, true]);
    expect(h.dialog.hidden).toBe(false); // still on screen, still fading
    expect(h.dialog.attributes["aria-hidden"]).toBe("true");
    vi.advanceTimersByTime(TRANSITION_MS - 1);
    expect(h.dialog.hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(h.dialog.hidden).toBe(true);
  });

  it("Log Out plays that same exit first, and only then tears the session down", () => {
    const h = open();
    h.paint();
    const teardown = vi.fn();
    h.hide(teardown);
    expect(h.leaving()).toBe(true);
    vi.advanceTimersByTime(TRANSITION_MS - 1);
    expect(teardown).not.toHaveBeenCalled(); // never mid-fade
    vi.advanceTimersByTime(1);
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(h.dialog.hidden).toBe(true); // gone before the gate is drawn over it
  });

  it("re-opening a box that is still fading out brings it back, not a swell", () => {
    const h = open();
    h.paint();
    h.hide();
    h.show();
    // the leaving state is dropped and the start state put back on, so the way
    // in runs again from 1.1 rather than the box hanging at half a fade
    expect([h.entering(), h.leaving()]).toEqual([true, false]);
    h.paint();
    vi.advanceTimersByTime(TRANSITION_MS);
    expect(h.dialog.hidden).toBe(false); // the cancelled hide cannot still fire
  });

  it("a second Cancel on a box already gone runs its answer anyway", () => {
    // the tap that lands after the box has left the layout still has to be
    // honoured, or a log out could be swallowed and the session left open
    const h = logoutHarness();
    const teardown = vi.fn();
    h.hide(teardown);
    expect(teardown).toHaveBeenCalledTimes(1);
  });
});
