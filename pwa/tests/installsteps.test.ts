// Pins for the sign-in screen's other face: the home-screen steps.
//
// Opened in a browser tab with nothing signed in, the card no longer asks for a
// token first. It says what the app is missing there (notifications on an
// iPhone, and the bars the browser keeps for itself), by asking for the home
// screen: the title, the five steps, and one quiet button for the other way.
// The button opens the chat's own centred box, and only Yes brings the passcode
// card back. Opened from the home screen none of that happens: the passcode
// card IS the screen, exactly as it always was.
//
// Two kinds of pin below. The copy and the look are read off the source, like
// the other presentation pins, because the words are the owner's and the
// cascade is the engine's. The behaviour is RUN: renderTokenGate and the
// alert's own block are cut out of main.ts and executed in a VM against
// element stand-ins, the way logoutbox.test.ts runs the two answers, so "No
// leaves the steps up" and "Yes builds the working passcode card" are claims
// about what the code does rather than about what it looks like it does. The
// controller the rebuilt card is wired to is the real one out of tokengate.ts.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";
import { transformWithEsbuild } from "vite";
import { CHECK_URL, createTokenGate } from "../src/tokengate";

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const splash = readFileSync(new URL("../src/splash.ts", import.meta.url), "utf8");
/** The sheet with its prose taken out, so pins land on rules, not comments. */
const sheet = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** renderTokenGate, from its own line to the end of the function. */
const gate = /function renderTokenGate\(\)[\s\S]*?\n\}/.exec(main)?.[0] ?? "";

/** The card's markup on the browser face: everything the else-branch writes. */
const installMarkup = gate.slice(gate.lastIndexOf("app.innerHTML = `"));

/** The steps, in the order the card lists them. */
const STEPS = ["Click …", "Share", "View more", "Add to Home Screen", "Add and done!"];
const TITLE = "Paratrooper feels better as an app on the home screen.";
const BUTTON = "Use it in the browser instead";
const WARNING =
  "In a browser you get no notifications on an iPhone, and the browser's bars " +
  "take part of the screen. Still want to proceed?";

// --- the words ----------------------------------------------------------------

describe("the card says what it was given to say", () => {
  it("leads with the title, under the badge it already had", () => {
    expect(gate, "renderTokenGate not found").not.toBe("");
    expect(installMarkup).toContain(`<p class="install-title">${TITLE}</p>`);
    // the badge is above it: the head is written once and both faces open with
    // it, so the version is on screen on this face too
    expect(gate.match(/\$\{head\}/g), "both faces render the one head").toHaveLength(2);
    expect(gate.indexOf("${head}")).toBeLessThan(gate.indexOf(TITLE));
  });

  it("lists the five steps, in the order they are done in", () => {
    const items = [...installMarkup.matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1]);
    expect(items).toEqual(STEPS);
    // the first step is the button Safari draws, which is one character and not
    // three full stops: a typed-out "..." would be a different glyph on screen
    expect(items[0]).toContain("…");
    expect(installMarkup).not.toContain("...");
  });

  it("offers the other way in one button, and says it is the other way", () => {
    expect(installMarkup).toContain(`>${BUTTON}</button>`);
    const labels = [...installMarkup.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((m) =>
      m[1].trim(),
    );
    expect(labels).toEqual([BUTTON, "No", "Yes"]); // the card's button, then the box's two
  });

  it("warns before it takes it, in the box's one sentence and two answers", () => {
    expect(installMarkup).toContain(WARNING);
    // the quiet pill is the one that stays, the filled one is what the box is
    // asking about: the same way round as Cancel beside Log Out
    expect(installMarkup).toContain('id="browser-warn-no" class="alert-quiet">No<');
    expect(installMarkup).toContain('id="browser-warn-yes" class="alert-action">Yes<');
  });

  it("says nothing about a gif, a video or a picture of any of it", () => {
    // the steps are words for this version, by instruction
    expect(installMarkup).not.toMatch(/<(?:img|video|source|canvas)\b/);
  });
});

// --- the box is the app's box, not a new one ----------------------------------

describe("the warning is the chat's centred box, wearing other words", () => {
  it("is built out of the shared classes and names none of its own", () => {
    expect(installMarkup).toContain('id="browser-warn" class="alert-dialog"');
    expect(installMarkup).toContain('<div class="alert-card">');
    expect(installMarkup).toContain('id="browser-warn-copy" class="alert-copy"');
    expect(installMarkup).toContain('<div class="alert-actions">');
    // and no rule of its own anywhere: alert.css dresses all three boxes
    expect(css).not.toContain("browser-warn");
  });

  it("is announced the same way, and ships closed like the other two", () => {
    expect(installMarkup).toContain('role="alertdialog"');
    expect(installMarkup).toContain('aria-modal="true"');
    expect(installMarkup).toContain('aria-labelledby="browser-warn-copy"');
    expect(installMarkup).toMatch(/aria-labelledby="browser-warn-copy" hidden>/);
  });

  it("goes up and comes down through the alert's own two functions", () => {
    const wiring = gate.slice(gate.indexOf('const warn = document.getElementById'));
    expect(wiring).toContain("showAlert(warn)");
    // three ways out of the box, and all three are the shared exit: No, the
    // backdrop, and Yes, which hands the exit the card to build afterwards
    expect(wiring.match(/hideAlert\(warn/g)).toHaveLength(3);
    expect(wiring).not.toMatch(/warn\.classList/); // no second mechanism
    expect(wiring).toContain("hideAlert(warn, askForToken)");
  });

  it("sits outside the card, because the card holds a layer of its own", () => {
    // .gate carries will-change: transform for the keyboard lift, and a fixed
    // overlay inside an element like that is fixed to the element rather than
    // to the screen. So the box is a sibling of the card, not a child.
    expect(sheet).toMatch(/\.gate \{[^}]*will-change: transform;/);
    const beforeBox = installMarkup
      .slice(0, installMarkup.indexOf('<div id="browser-warn"'))
      .replace(/<!--[\s\S]*?-->/g, "")
      .trimEnd();
    expect(beforeBox.endsWith("</div>"), "the card is closed before the box opens").toBe(true);
  });
});

// --- one question about the phone, asked in one place -------------------------

describe("home screen or browser tab is one question with one answer", () => {
  it("splash.ts owns it, and states the check exactly once", () => {
    expect(splash).toContain("export function isInstalledWindow(nav: Navigator): boolean {");
    // the launch image and the loading page ask it too; none of the three
    // carries a second copy of the expression
    expect(splash.match(/matchMedia\("\(display-mode: standalone\)"\)/g)).toHaveLength(1);
    expect(splash.match(/standalone\?: boolean/g)).toHaveLength(1);
  });

  it("the card asks that one, and never asks the phone itself", () => {
    expect(main).toContain("isInstalledWindow,"); // imported from splash.ts
    expect(gate).toContain("if (isInstalledWindow(navigator)) {");
    expect(main).not.toContain("display-mode: standalone"); // no copy over here
    expect(main).not.toMatch(/navigator[\s\S]{0,20}\.standalone/);
  });

  it("the installed window is answered first, and answered with the old card", () => {
    const branch = gate.slice(gate.indexOf("if (isInstalledWindow(navigator)) {"));
    expect(branch.slice(0, branch.indexOf("}"))).toContain("askForToken();");
  });

  it("every way back to this screen goes through the one entry point", () => {
    // boot, log out, and a token the server has stopped accepting all call
    // renderTokenGate, so the face each of them lands on is decided in one place
    expect(main).toMatch(/} else \{\n  renderTokenGate\(\);/); // boot, with no token
    expect(main).toMatch(/leaveChat\(\);[\s\S]{0,200}renderTokenGate\(\);/);
    expect(main.match(/renderTokenGate\(\);/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

// --- the look -----------------------------------------------------------------

describe("the install face is a white sheet, in both appearances", () => {
  /** One rule's body, by its whole selector. */
  function rule(selector: string): string {
    const m = new RegExp(`(?:^|\\})\\s*${selector.replace(/\./g, "\\.")} \\{([^}]*)\\}`).exec(
      sheet,
    );
    expect(m, `missing rule ${selector}`).not.toBeNull();
    return m![1];
  }

  it("is white, and carries the ink that keeps it readable", () => {
    const face = rule(".gate.install");
    expect(face).toMatch(/background:\s*#ffffff;/);
    // a card that kept the page's --text would be white on white in dark mode,
    // so the face declares the two colours it needs and they inherit downwards
    expect(face).toMatch(/--text:\s*#000000;/);
    expect(face).toMatch(/--muted:\s*#8e8e93;/);
    expect(face).toMatch(/color:\s*var\(--text\);/);
  });

  it("is the same sheet whatever the phone's appearance is", () => {
    // nothing this face is made of may be re-stated inside an appearance block:
    // white was asked for, and white is what both appearances get
    expect(sheet).toContain("@media (prefers-color-scheme: dark)"); // the guard bites
    for (const selector of [".gate.install", ".install-steps", ".gate-quiet"]) {
      const spots = [...sheet.matchAll(new RegExp(selector.replace(/\./g, "\\."), "g"))];
      expect(spots.length, `${selector} is not in the sheet at all`).toBeGreaterThan(0);
      for (const spot of spots) {
        const before = sheet.slice(0, spot.index);
        const depth =
          (before.match(/\{/g)?.length ?? 0) - (before.match(/\}/g)?.length ?? 0);
        expect(depth, `${selector} may not be stated per appearance`).toBe(0);
      }
    }
  });

  it("puts the steps in a numbered list the card seats as one block", () => {
    const steps = rule(".gate .install-steps");
    expect(steps).toMatch(/list-style:\s*decimal inside;/); // the order, shown
    expect(steps).toMatch(/text-align:\s*left;/); // the lines, aligned to each other
    expect(steps).toMatch(/margin:\s*0 auto/); // the block, centred by the card
    expect(steps).toMatch(/width:\s*max-content;/);
    expect(installMarkup).toContain('<ol class="install-steps">'); // ordered, in the markup too
  });

  it("says the other way quietly: the accent, not the pill Connect wears", () => {
    const quiet = rule(".gate button.gate-quiet");
    expect(quiet).toMatch(/background:\s*none;/);
    expect(quiet).toMatch(/color:\s*var\(--accent\);/);
    expect(quiet).not.toMatch(/#[0-9a-fA-F]{3,8}|rgb\(|hsl\(/); // no colour of its own
    expect(installMarkup).toContain('id="use-browser" class="gate-quiet"');
  });
});

// --- the two faces, run -------------------------------------------------------
//
// main.ts is the app's entry point, so importing it would boot the whole app,
// and there is no DOM under node. The card's function and the alert's block are
// cut out by name and run in one VM context over the smallest stand-ins the two
// of them ask for: an element table keyed by the ids the markup carries, and a
// card element for the one querySelector.

interface Fired {
  target?: unknown;
  key?: string;
  preventDefault?: () => void;
}

class El {
  hidden = false;
  disabled = false;
  value = "";
  textContent: string | null = "";
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  classes = new Set<string>();
  private heard = new Map<string, Array<(event: Fired) => void>>();

  classList = {
    add: (name: string) => void this.classes.add(name),
    remove: (name: string) => void this.classes.delete(name),
    contains: (name: string) => this.classes.has(name),
  };

  addEventListener(type: string, run: (event: Fired) => void): void {
    const list = this.heard.get(type) ?? [];
    list.push(run);
    this.heard.set(type, list);
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  fire(type: string, event: Fired = {}): void {
    for (const run of this.heard.get(type) ?? []) run({ target: this, ...event });
  }
}

/** The beat a box takes to leave, read off the app's own constant. */
const ALERT_MS = Number(/const ALERT_TRANSITION_MS = (\d+);/.exec(main)![1]);
const PASS_MS = Number(/export const PASS_MS = (\d+);/.exec(
  readFileSync(new URL("../src/tokengate.ts", import.meta.url), "utf8"),
)![1]);

const after = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

let script = "";

beforeAll(async () => {
  const at = main.indexOf("const ALERT_TRANSITION_MS");
  const until = main.indexOf("function pushApisSupported(", at);
  expect(until).toBeGreaterThan(at);
  const block = main.slice(at, until) + "\n" + gate;
  script = (await transformWithEsbuild(block, "gate.ts", { loader: "ts" })).code;
});

function harness(installed: boolean, answer = 204) {
  let html = "";
  let card = new El();
  const els = new Map<string, El>();
  const asked: string[] = [];
  const stored: Array<[string, string]> = [];
  const built: string[] = [];
  const app = {
    get innerHTML(): string {
      return html;
    },
    set innerHTML(value: string) {
      html = value; // a fresh card: every stand-in the old one handed out is gone
      els.clear();
      card = new El();
    },
    querySelector: (selector: string): El | null => (selector === ".gate" ? card : null),
  };
  // one element per id in the markup that is up, and nothing for an id that is
  // not: an element the card did not render is not on screen. The tag's own
  // `hidden` comes with it, so a box that ships closed starts closed here too.
  const byId = (id: string): El | null => {
    const tag = new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`).exec(html)?.[0];
    if (!tag) return null;
    let found = els.get(id);
    if (!found) {
      found = new El();
      found.hidden = /\shidden[\s>]/.test(tag);
      els.set(id, found);
    }
    return found;
  };
  const context: Record<string, unknown> = {
    app,
    document: { getElementById: byId },
    window: {
      setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
      clearTimeout: (handle: number) => clearTimeout(handle),
    },
    setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
    requestAnimationFrame: (run: () => void) => {
      setTimeout(run, 0);
      return 1;
    },
    cancelAnimationFrame: () => {},
    navigator: {}, // the card hands it to the check, which the harness answers
    APP_VERSION: "9.9.9",
    TOKEN_KEY: "tok",
    token: "",
    tokenGate: { refuse: () => built.push("refused") },
    pushNotifications: null,
    isInstalledWindow: () => installed,
    bindGateFlight: () => built.push("flight"),
    createTokenGate,
    gateFetch: (url: string) => {
      asked.push(url);
      return Promise.resolve({ status: answer });
    },
    localStorage: { setItem: (key: string, value: string) => void stored.push([key, value]) },
    renderChat: () => built.push("chat"),
    connect: () => built.push("socket"),
  };
  runInNewContext(script, context);
  (context.renderTokenGate as () => void)();
  return {
    context,
    asked,
    stored,
    built,
    get card(): El {
      return card;
    },
    html: () => html,
    el: (id: string) => byId(id),
    click: (id: string) => byId(id)!.fire("click"),
    render: () => (context.renderTokenGate as () => void)(),
  };
}

describe("a browser tab opens on the steps", () => {
  it("shows the title, the five steps and the button, and no box to type in", () => {
    const run = harness(false);
    expect(run.html()).toContain(TITLE);
    const items = [...run.html().matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1]);
    expect(items).toEqual(STEPS); // in order, on screen
    expect(run.el("use-browser")).not.toBeNull();
    expect(run.el("token-input"), "no passcode box on this face").toBeNull();
    expect(run.el("token-save")).toBeNull();
    expect(run.html()).not.toContain("Your access token please?");
  });

  it("wears the install face's own paint, and nothing else does", () => {
    const run = harness(false);
    expect(run.card.classes.has("install")).toBe(true);
    expect(harness(true).card.classes.has("install")).toBe(false);
  });

  it("holds no controller, so a socket refused behind it paints nothing", () => {
    const run = harness(false);
    expect(run.context.tokenGate).toBeNull();
    expect(run.built).not.toContain("refused");
  });

  it("ships the warning box closed, and the button opens it", () => {
    const run = harness(false);
    const warn = run.el("browser-warn")!;
    expect(warn.hidden, "the box ships out of the layout, like the other two").toBe(true);
    run.click("use-browser");
    expect(warn.hidden).toBe(false);
    expect(warn.attributes["aria-hidden"]).toBe("false");
  });
});

describe("No keeps the steps, Yes brings the passcode card", () => {
  it("No takes the box away and leaves the card exactly as it was", async () => {
    const run = harness(false);
    const before = run.html();
    const warn = run.el("browser-warn")!;
    run.click("use-browser");
    run.click("browser-warn-no");
    await after(ALERT_MS + 60);
    expect(warn.hidden).toBe(true); // the box has left the layout
    expect(warn.attributes["aria-hidden"]).toBe("true");
    expect(run.html()).toBe(before); // and the steps are untouched
    expect(run.el("token-input")).toBeNull();
  });

  it("the backdrop is a No as well", async () => {
    const run = harness(false);
    const warn = run.el("browser-warn")!;
    run.click("use-browser");
    warn.fire("click", { target: warn }); // a tap on the dim, not on a pill
    await after(ALERT_MS + 60);
    expect(warn.hidden).toBe(true);
    expect(run.el("token-input")).toBeNull();
  });

  it("Yes waits out the box's own exit, then builds the passcode card", async () => {
    const run = harness(false);
    const warn = run.el("browser-warn")!;
    run.click("use-browser");
    run.click("browser-warn-yes");
    expect(run.el("token-input"), "not before the box has gone").toBeNull();
    await after(ALERT_MS + 60);
    expect(run.html()).toContain("Your access token please?");
    expect(run.el("token-input")).not.toBeNull();
    expect(run.el("token-save")).not.toBeNull();
    expect(run.el("token-note")).not.toBeNull();
    // the steps and the box are gone with the face that carried them
    expect(run.html()).not.toContain(TITLE);
    expect(run.el("browser-warn")).toBeNull();
    // and the card kept the badge above it, version and all
    expect(run.html()).toContain('<span class="title">Paratrooper</span>');
    expect(run.html()).toContain("v9.9.9");
  });

  it("the card it builds is the working one: Connect asks, and a yes signs in", async () => {
    const run = harness(false);
    const warn = run.el("browser-warn")!;
    run.click("use-browser");
    run.click("browser-warn-yes");
    await after(ALERT_MS + 60);
    const box = run.el("token-input")!;
    box.value = "  a-good-token  "; // the controller trims it
    run.click("token-save");
    await after(PASS_MS + 80);
    expect(run.asked).toEqual([CHECK_URL]); // the server was asked, once
    expect(box.classes.has("ok")).toBe(true); // green, then the chat
    expect(run.stored).toEqual([["tok", "a-good-token"]]);
    expect(run.context.token).toBe("a-good-token");
    expect(run.built).toContain("chat");
    expect(run.built).toContain("socket");
  });

  it("a refused token is refused on that card, and nothing is stored", async () => {
    const run = harness(false, 401);
    const warn = run.el("browser-warn")!;
    run.click("use-browser");
    run.click("browser-warn-yes");
    await after(ALERT_MS + 60);
    const box = run.el("token-input")!;
    box.value = "wrong";
    run.click("token-save");
    await after(80);
    expect(box.classes.has("bad")).toBe(true);
    expect(box.classes.has("shake")).toBe(true);
    expect(run.stored).toEqual([]);
    expect(run.built).not.toContain("chat");
  });
});

describe("an installed window never sees any of it", () => {
  it("opens on the passcode card, with no steps and no box to dismiss", () => {
    const run = harness(true);
    expect(run.html()).toContain("Your access token please?");
    expect(run.el("token-input")).not.toBeNull();
    expect(run.html()).not.toContain(TITLE);
    expect(run.el("use-browser")).toBeNull();
    expect(run.el("browser-warn")).toBeNull();
    expect(run.context.tokenGate).not.toBeNull(); // the card holds its controller
  });

  it("Return in the box is still Connect, and Connect still asks", async () => {
    const run = harness(true);
    const box = run.el("token-input")!;
    box.value = "typed-then-entered";
    box.fire("keydown", { key: "Enter", preventDefault: () => {} } as Fired);
    await after(PASS_MS + 80);
    expect(run.asked).toEqual([CHECK_URL]);
    expect(run.stored).toEqual([["tok", "typed-then-entered"]]);
  });
});

describe("logging out lands on the face the open called for", () => {
  // log out is renderTokenGate again, after the teardown (logoutbox.test.ts
  // pins that wiring); here is what the two modes get when it runs
  it("a browser tab goes back to the steps", () => {
    const run = harness(false);
    run.render(); // the call the log-out box makes once the fade has ended
    expect(run.html()).toContain(TITLE);
    expect(run.el("token-input")).toBeNull();
  });

  it("an installed window goes back to the passcode card", () => {
    const run = harness(true);
    run.render();
    expect(run.html()).toContain("Your access token please?");
    expect(run.html()).not.toContain(TITLE);
  });

  it("the choice is not remembered: a tab that chose the browser starts over", () => {
    const run = harness(false);
    const warn = run.el("browser-warn")!;
    run.click("use-browser");
    run.click("browser-warn-yes");
    run.render(); // a fresh open of the page, which is what a log out leaves
    expect(run.html()).toContain(TITLE);
    // nothing was written down for it either
    expect(run.stored).toEqual([]);
    expect(gate).not.toContain("localStorage.getItem");
  });
});
