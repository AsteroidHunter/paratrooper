// Pins for the sign-in screen's other face: the home-screen steps.
//
// Opened in a browser tab with nothing signed in, the card no longer asks for a
// token first. It says what the app is missing there (notifications on an
// iPhone, and the bars the browser keeps for itself), by asking for the home
// screen — and it asks the way the app will talk to you once you are in: five
// messages from Paratrooper, in the chat's own received bubbles, each one
// typed out after the chat's own dots and grown out of them the way a reply
// arrives in the chat, with the tail under the last of them. The run is
// one block, as wide as its widest message, centred on the screen with every
// bubble on the block's left edge. Under it, one sentence offers the other
// way over three lines, and the words that take it are the link, in the app's
// accent. That link opens the chat's own centred box, and only Yes brings the
// passcode card back. Opened from the home screen none of that happens: the
// passcode card IS the screen, exactly as it always was.
//
// Two kinds of pin below. The copy and the look are read off the source, like
// the other presentation pins, because the words are the owner's and the
// cascade is the engine's. The behaviour is RUN: renderTokenGate and the
// alert's own block are cut out of main.ts and executed in a VM against
// element stand-ins, the way logoutbox.test.ts runs the two answers, so "No
// leaves the steps up" and "Yes builds the working passcode card" are claims
// about what the code does rather than about what it looks like it does. The
// controller the rebuilt card is wired to is the real one out of tokengate.ts.
// The reveal's own clock is not pinned here at all — it is arithmetic and it is
// pinned as arithmetic, in installreveal.test.ts; this file pins that the card
// hands itself to it.
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

/** The two drawn symbols, as main.ts declares them. */
const glyphSource = /const SHARE_GLYPH =[\s\S]*?;\nconst ADD_GLYPH =[\s\S]*?;\n/.exec(main)?.[0] ?? "";
const SHARE_SRC = /const SHARE_GLYPH =([\s\S]*?);\n/.exec(glyphSource)?.[1] ?? "";
const ADD_SRC = /const ADD_GLYPH =([\s\S]*?);\n/.exec(glyphSource)?.[1] ?? "";

/** The run, as the card sends it: the bubbles' own markup, in order. */
const MESSAGES = [
  "1. Tap ••• in Safari's toolbar",
  "2. Click <b>Share</b> ${SHARE_GLYPH}",
  "3. Open <b>View More</b>",
  "4. Tap <b>Add to Home Screen</b> ${ADD_GLYPH}",
  "Once added, use it like a regular app!",
];
/** the line under the run: the plain half, and the half that is the link */
const ASIDE = "Or, if you prefer an inferior interface, ";
const LINK = "click here to use it within this browser's tab window";
const WARNING =
  "In a browser you get no notifications on an iPhone, and the browser's bars " +
  "take part of the screen. Still want to proceed?";
/** the sentence the face used to open with, and no longer says at all */
const OLD_TITLE = "Paratrooper feels better as an app on the home screen.";

/** every bubble in the run, as it is written: the class list and the contents */
const bubbles = [...installMarkup.matchAll(/<div class="(msg agent install-msg[^"]*)">([\s\S]*?)<\/div>/g)];

// --- the words ----------------------------------------------------------------

describe("the card says what it was given to say", () => {
  it("opens on the badge and goes straight into the run: no sentence between", () => {
    expect(gate, "renderTokenGate not found").not.toBe("");
    // the badge is above it: the head is written once and both faces open with
    // it, so the version is on screen on this face too
    expect(gate.match(/\$\{head\}/g), "both faces render the one head").toHaveLength(2);
    expect(gate.indexOf("${head}")).toBeLessThan(gate.indexOf(MESSAGES[0]));
    // and the line the face used to lead with is gone, with the list it led
    expect(main).not.toContain(OLD_TITLE);
    expect(main).not.toContain("install-title");
    expect(installMarkup).not.toMatch(/<\/?(?:ol|ul|li)\b/);
  });

  it("sends the five messages, in the order the steps are done in", () => {
    expect(bubbles.map((b) => b[2])).toEqual(MESSAGES);
    // the first step is the button Safari draws, which is three bullets and not
    // three full stops: a typed-out "..." would be a different glyph on screen
    expect(MESSAGES[0]).toContain("•••");
    expect(installMarkup).not.toContain("...");
    // Click, not Choose: it is what Safari's own menu says
    expect(MESSAGES[1]).toContain("Click");
    expect(installMarkup).not.toContain("Choose");
  });

  it("emphasises the four words Safari itself shows, and nothing else", () => {
    const bold = [...installMarkup.matchAll(/<b>([^<]+)<\/b>/g)].map((m) => m[1]);
    expect(bold).toEqual(["Share", "View More", "Add to Home Screen"]);
  });

  it("closes with a line that is not a step, so it is not numbered", () => {
    const numbered = MESSAGES.filter((m) => /^\d\. /.test(m));
    expect(numbered).toHaveLength(4); // the four things to do
    expect(MESSAGES[4]).toBe("Once added, use it like a regular app!");
    expect(MESSAGES[4]).not.toMatch(/^\d/);
    // and the step the reference had in its place is gone
    expect(main).not.toContain("Finish with");
  });

  it("offers the other way in one line, with the words that take it as the link", () => {
    expect(installMarkup).toContain(
      `<p class="install-switch">${ASIDE}` +
        `<a id="use-browser" class="install-link" role="button" href="#">${LINK}</a></p>`,
    );
    // the aside is said once, and the two halves are one sentence
    expect(installMarkup.match(/install-switch/g)).toHaveLength(1);
    // the quiet pill this replaced is gone, and so is its rule
    expect(main).not.toContain("gate-quiet");
    expect(css).not.toContain("gate-quiet");
    expect(installMarkup).not.toContain("Use it in the browser instead");
  });

  it("warns before it takes it, in the box's one sentence and two answers", () => {
    expect(installMarkup).toContain(WARNING);
    // the quiet pill is the one that stays, the filled one is what the box is
    // asking about: the same way round as Cancel beside Log Out
    expect(installMarkup).toContain('id="browser-warn-no" class="alert-quiet">No<');
    expect(installMarkup).toContain('id="browser-warn-yes" class="alert-action">Yes<');
    // and they are the only buttons on this face now
    const labels = [...installMarkup.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((m) =>
      m[1].trim(),
    );
    expect(labels).toEqual(["No", "Yes"]);
  });

  it("says nothing about a gif, a video or a picture of any of it", () => {
    // the steps are words and two drawn symbols, by instruction
    expect(installMarkup).not.toMatch(/<(?:img|video|source|canvas)\b/);
  });
});

// --- the two symbols ----------------------------------------------------------

describe("Safari's two symbols are drawn, not typed", () => {
  it("both are inline strokes in a 20-unit square, sized to the text", () => {
    for (const src of [SHARE_SRC, ADD_SRC]) {
      expect(src, "a glyph constant is missing").not.toBe("");
      expect(src).toContain('<svg class="install-glyph"');
      expect(src).toContain('viewBox="0 0 20 20"');
      expect(src).toContain('aria-hidden="true"'); // the word beside it is the label
      expect(src).toContain("</svg>");
    }
    const glyph = rule(".gate .install-glyph");
    expect(glyph).toMatch(/width:\s*1em;/); // one em, so it grows with the message
    expect(glyph).toMatch(/height:\s*1em;/);
    expect(glyph).toMatch(/vertical-align:/); // and seated on the line, not floating
    expect(glyph).toMatch(/stroke:\s*currentColor;/); // the bubble's own ink
  });

  it("the share symbol is a tray with an arrow going up out of it", () => {
    expect(SHARE_SRC).toContain('<path d="M6.6 8.2H4.6a2.1 2.1 0 0 0-2.1 2.1'); // the open tray
    expect(SHARE_SRC).toContain('<path d="M10 12.6V2.3"/>'); // the shaft, upward
    expect(SHARE_SRC).toContain('d="m6.7 5.5 3.3-3.3 3.3 3.3"'); // the head on top of it
  });

  it("the add symbol is a plus inside a rounded square", () => {
    expect(ADD_SRC).toContain('<rect x="2.5" y="2.5" width="15" height="15" rx="3.6"/>');
    expect(ADD_SRC).toContain('d="M10 6.3v7.4"'); // the upright
    expect(ADD_SRC).toContain('d="M6.3 10h7.4"'); // the crossbar
  });

  it("neither reaches for a font, a file or a colour of its own", () => {
    for (const src of [SHARE_SRC, ADD_SRC]) {
      expect(src).not.toContain("url("); // nothing is fetched to draw the card
      expect(src).not.toMatch(/<(?:image|text|use)\b/); // no font, no bitmap
      expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}|rgb\(/); // no paint of its own
    }
    // and the two are not Unicode lookalikes smuggled in beside the drawing
    expect(installMarkup).not.toMatch(/[↩↪⊞⬆]/);
  });

  it("each sits in the message whose step it belongs to", () => {
    expect(MESSAGES[1]).toContain("${SHARE_GLYPH}");
    expect(MESSAGES[3]).toContain("${ADD_GLYPH}");
    expect(installMarkup.match(/\$\{SHARE_GLYPH\}/g)).toHaveLength(1);
    expect(installMarkup.match(/\$\{ADD_GLYPH\}/g)).toHaveLength(1);
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

  it("the link that opens it refuses its own navigation first", () => {
    // an anchor, because a button cannot break across the two lines the link's
    // own words take in WebKit; so the one thing it must not do is follow itself
    const wiring = gate.slice(gate.indexOf('getElementById("use-browser")'));
    expect(wiring.slice(0, wiring.indexOf("});"))).toContain("event.preventDefault()");
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

/** One rule's body, by its whole selector. */
function rule(selector: string): string {
  const m = new RegExp(
    `(?:^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`,
  ).exec(sheet);
  expect(m, `missing rule ${selector}`).not.toBeNull();
  return m![1];
}

describe("the install face is a white sheet, in both appearances", () => {
  it("is white, and carries the ink that keeps it readable", () => {
    const face = rule(".gate.install");
    expect(face).toMatch(/background:\s*#ffffff;/);
    // a card that kept the page's --text would be white on white in dark mode,
    // so the face declares the colours it needs and they inherit downwards
    expect(face).toMatch(/--text:\s*#000000;/);
    expect(face).toMatch(/--muted:\s*#8e8e93;/);
    expect(face).toMatch(/color:\s*var\(--text\);/);
  });

  it("is the same sheet whatever the phone's appearance is", () => {
    // nothing this face is made of may be re-stated inside an appearance block:
    // white was asked for, and white is what both appearances get
    expect(sheet).toContain("@media (prefers-color-scheme: dark)"); // the guard bites
    for (const selector of [
      ".gate.install",
      ".install-thread",
      ".install-row",
      ".install-dots",
      ".install-msg",
      ".install-glyph",
      ".install-switch",
      ".install-link",
    ]) {
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

  it("sits in the upper middle, with the room Safari's bar takes left under it", () => {
    // the card is centred in the large viewport, which includes the strip the
    // browser draws its bottom bar over; this is the half of that strip taken
    // back, and it is an offset rather than a transform because the keyboard
    // lift owns this card's transform
    expect(rule(".gate.install")).toMatch(/top:\s*-[\d.]+rem;/);
    expect(rule(".gate.install")).not.toMatch(/transform:/);
  });
});

describe("the steps are messages, in the chat's own bubbles", () => {
  it("every one is an agent bubble, and the last one alone carries the tail", () => {
    expect(bubbles).toHaveLength(5);
    expect(bubbles.map((b) => b[1])).toEqual([
      "msg agent install-msg",
      "msg agent install-msg",
      "msg agent install-msg",
      "msg agent install-msg",
      "msg agent install-msg tail", // the run's last bubble, and the only hook
    ]);
    // and the tail is the chat's own: the mask hung under the run's last
    // bubble, painted with the bubble's fill (styles.css .msg.tail::after)
    expect(sheet).toMatch(/\.msg\.tail:not\(:has\(img\.waiting\)\)::after \{/);
  });

  it("takes its shape and its paint from the thread rather than restating them", () => {
    const face = rule(".gate.install");
    // the fill the owner asked for and the ink on it, declared as the SAME two
    // names the thread's agent bubbles read, so .msg.agent dresses these too
    expect(face).toMatch(/--received:\s*#eaeaeb;/);
    expect(face).toMatch(/--received-text:\s*#111111;/);
    expect(rule(".gate .install-msg")).toMatch(/max-width:\s*100%;/);
    // nothing on this face restates the bubble itself
    const block = sheet.slice(sheet.indexOf(".gate.install {"), sheet.indexOf(".bar {"));
    expect(block).not.toMatch(/border-radius:\s*18px/);
    expect(block).not.toMatch(/font-size:\s*17px/);
    expect(block).not.toMatch(/\.install-msg[^{]*\{[^}]*padding/);
  });

  it("stacks them as one block, as wide as the widest, centred on the screen", () => {
    // the owner's rule for this face: the group is centred on the screen, and
    // the words in the steps are left aligned. So the column is a block that
    // is exactly its widest bubble wide and no wider, and its auto margins put
    // the same room on either side of it
    const thread = rule(".gate .install-thread");
    expect(thread).toMatch(/display:\s*flex;/);
    expect(thread).toMatch(/flex-direction:\s*column;/);
    expect(thread).toMatch(/width:\s*fit-content;/);
    expect(thread).toMatch(/max-width:\s*100%;/); // and never wider than the card
    expect(thread).toMatch(/margin:\s*[\d.]+rem auto [\d.]+rem;/);
    expect(thread).toMatch(/text-align:\s*left;/); // the words, against the card's centring
    expect(installMarkup.match(/class="install-row"/g)).toHaveLength(5);
  });

  it("every bubble starts on the block's own left edge, and keeps its own width", () => {
    // nothing pulls a row off the block's left edge: the rows are stretched
    // across the block and lay their bubble at the start, and nothing centres
    // or right-aligns the items
    const thread = rule(".gate .install-thread");
    expect(thread).not.toMatch(/align-items:|justify-content:/);
    const row = rule(".gate .install-row");
    expect(row).toMatch(/display:\s*flex;/); // so each bubble is its own words wide
    expect(row).not.toMatch(/justify-content:|align-items:|margin-left:|margin-right:/);
    // the gap inside one run is the column's, not a margin on each row: the
    // morph moves a row's top margin from the dots' to the row's own, and
    // with both of those nought there is nothing on that leg to move (the
    // dots' nought is pinned with the dots, below)
    expect(thread).toMatch(/gap:\s*4px;/);
    expect(row).not.toMatch(/margin-top:/);
    expect(sheet).not.toContain(".install-row:first-child"); // no first-row exception left over
    // and the bubbles stay bubbles, sized to their words: nothing stretches
    // them to the block's width, which is the widest one's alone
    const bubble = rule(".gate .install-msg");
    expect(bubble).toMatch(/max-width:\s*100%;/);
    expect(bubble).not.toMatch(/(?:^|[^-])width:\s*100%|flex:|align-self:|min-width:/);
  });

  it("holds every row's space from the first frame, so the group cannot walk", () => {
    // visibility, not display: a hidden row keeps its box, so the card is its
    // final height before the first message lands and the centred group stays
    // where it is while the run arrives
    expect(rule(".gate .install-row")).toMatch(/visibility:\s*hidden;/);
    expect(rule(".gate .install-row.shown")).toMatch(/visibility:\s*visible;/);
    // the row's own box is never taken out of the layout, and showing one is
    // the visibility flip and nothing else
    expect(rule(".gate .install-row")).toMatch(/display:\s*flex;/);
    expect(rule(".gate .install-row.shown")).not.toMatch(/display:/);
    // and the message under the dots keeps its box too — visibility again,
    // never display — so a row is the message's height with the dots in it
    // and without, and the block is the same shape from the first frame to
    // the last
    expect(sheet).toMatch(/\.gate \.install-row:has\(\.typing\) \.install-msg \{ visibility: hidden; \}/);
    expect(sheet).not.toMatch(/\.install-row:has\(\.typing\) \.install-msg \{[^}]*display/);
  });
});

describe("the dots are the chat's dots, in every message's seat in turn", () => {
  it("ship with the card, once, wearing the thread's own typing classes", () => {
    expect(installMarkup).toContain(
      '<div id="install-dots" class="msg agent typing install-dots" aria-hidden="true">' +
        "<span></span><span></span><span></span></div>",
    );
    expect(installMarkup.match(/id="install-dots"/g)).toHaveLength(1); // one element, moved
    // the same three-span box showTyping builds for the thread
    expect(main).toContain('el.className = "msg agent typing"');
  });

  it("start in the first row, before the message they become", () => {
    const firstRow = installMarkup.slice(
      installMarkup.indexOf('<div class="install-row">'),
      installMarkup.indexOf('<div class="install-row">') + 400,
    );
    expect(firstRow.indexOf("install-dots")).toBeLessThan(firstRow.indexOf("install-msg"));
  });

  it("stand over the message's own box, on the row's top-left corner, with no gap of their own", () => {
    // out of the flow and on the corner: the box the dots are read from at
    // the handover is exactly the seat the message grows in, and the dots add
    // no height to a row that is already the message's height
    const dots = rule(".gate .install-dots");
    expect(dots).toMatch(/position:\s*absolute;/);
    expect(dots).toMatch(/top:\s*0;/);
    expect(dots).toMatch(/left:\s*0;/);
    expect(rule(".gate .install-row")).toMatch(/position:\s*relative;/); // the corner is the row's
    // the thread's 6px is the gap to whatever the dots follow; here the gap
    // is the column's, so theirs goes — and with the row's margin gone too
    // the morph's margin leg has nothing to travel
    expect(dots).toMatch(/margin-top:\s*0;/);
    // stated on this face's own class rather than on the thread's .typing:
    // that rule is the chat's and is read by name elsewhere (runs.test.ts),
    // and the dots take this face's class only for what differs here
    expect(rule(".typing")).toMatch(/margin-top:\s*6px;/); // the chat's own, untouched
    expect(rule(".typing")).not.toMatch(/position:/);
  });

  it("go where the chat's dots go: under the last message, and become the next", () => {
    const wiring = main.slice(main.indexOf("function playRevealStep"), main.indexOf("function revealInstallSteps"));
    // the row a dots step names is the next message's row, and the dots are
    // moved into it (the first time they are already there)
    expect(wiring).toContain("const row = rows[step.index];");
    expect(wiring).toContain("if (dots && dots.parentElement !== row) row.prepend(dots);");
    // and at the handover only the dots in THIS row can be the seat
    expect(wiring).toContain("const inRow = dots && dots.parentElement === row ? dots : null;");
    // the one element is found once, by the wiring, and handed to every step
    const arm = main.slice(main.indexOf("function revealInstallSteps"));
    expect(arm.slice(0, arm.indexOf("\n}"))).toContain('card.querySelector<HTMLElement>(".install-dots")');
    expect(arm.slice(0, arm.indexOf("\n}"))).toMatch(/playRevealStep\(step, rows, statement, dots\)/);
  });
});

describe("the line under the run, and the link inside it", () => {
  it("takes three lines: the aside on one of its own, the link on two under it", () => {
    // the sentence is still written as one paragraph, the aside and then the
    // link, with no break element anywhere in it ...
    const paragraph = /<p class="install-switch">[\s\S]*?<\/p>/.exec(installMarkup)?.[0] ?? "";
    expect(paragraph).not.toBe("");
    expect(paragraph).not.toMatch(/<br|<span|display/);
    // ... because the break after the comma is the link being a block: a
    // block-level box starts a new line whatever the width, so the aside is
    // always a line to itself and the link always begins the next one
    const link = rule(".gate .install-link");
    expect(link).toMatch(/display:\s*block;/);
    expect(link).toMatch(/margin:\s*0 auto;/); // centred under the aside
    // and the link's measure is what breaks its own words over two lines, and
    // where. Measured in Chrome at this size: the reference's first line
    // ("click here to use it within this") is 11.3rem, and with the next word
    // on it it would be 15.3rem; so the measure has to sit between those two,
    // and it sits in the middle of them with room on either side for the
    // phone's own font metrics. In rem, so the same two lines come out at any
    // phone's width — the reference's break, after "this"
    const measure = Number(/max-width:\s*([\d.]+)rem;/.exec(link)?.[1]);
    expect(measure).toBeGreaterThanOrEqual(12.5);
    expect(measure).toBeLessThanOrEqual(14.25);
    // plain wrapping, not balance: balancing would even the two lines out by
    // moving "this" down, and the reference does not
    expect(link).not.toMatch(/text-wrap:/);
  });

  it("the paragraph itself carries no measure and no balancing of its own", () => {
    // its one line is the aside; the line the link's words break on is the
    // link's own business, so nothing on the paragraph can move that break
    const line = rule(".gate .install-switch");
    expect(line).not.toMatch(/max-width:/);
    expect(line).not.toMatch(/text-wrap:/);
    expect(line).toMatch(/margin:\s*0 auto;/); // centred, where the bubbles are not
    expect(line).not.toMatch(/text-align:/); // the card's own centring reaches it
  });

  it("comes in last and is the only thing on the face that fades", () => {
    expect(rule(".gate .install-switch")).toMatch(/opacity:\s*0;/);
    expect(rule(".gate .install-switch")).toMatch(/transition:\s*opacity/);
    expect(rule(".gate .install-switch.shown")).toMatch(/opacity:\s*1;/);
    // and under reduced motion even that is taken off it
    expect(rule(".gate .install-switch.instant")).toMatch(/transition:\s*none;/);
  });

  it("is written in the card's own ink, with the link in the app's accent", () => {
    // the owner asked for the link in the app-wide colour: the same token the
    // sent bubbles, the caret and the send button read, so a future accent
    // moves the link with it. Not a literal, and not a token of this face's own
    expect(rule(".gate .install-link")).toMatch(/color:\s*var\(--accent\);/);
    expect(rule(".gate .install-link")).not.toMatch(/#[0-9a-fA-F]{3,8}|rgb\(/);
    expect(css).not.toContain("--install-link"); // the face-local token is gone
    expect(css).not.toMatch(/1b96fe/i); // and iOS's blue with it
    expect(rule(".gate.install")).not.toMatch(/--accent:/); // read from the root, never restated here
    expect(sheet).toMatch(/--accent:\s*#4538ff;/); // the token both bubbles and buttons take
    expect(rule(".msg.user")).toContain("background: var(--accent);"); // the same one
    expect(rule(".gate .install-switch")).not.toMatch(/#[0-9a-fA-F]{3,8}|rgb\(/);
  });

  it("the accent is one value in both appearances, so the link is one colour on the white sheet", () => {
    // the sheet is white in both appearances (pinned above); the token it
    // reads must not change under it, or the link would be one colour on the
    // white by day and another on the same white by night
    const dark = sheet.slice(sheet.indexOf("@media (prefers-color-scheme: dark)"));
    const darkRoot = /:root \{([^}]*)\}/.exec(dark)?.[1] ?? "";
    expect(darkRoot).not.toContain("--accent:");
  });
});

// --- the reveal is armed by the card, and nothing else about it is here -------

describe("the card hands itself to the reveal", () => {
  it("arms it last, with the card it has just built", () => {
    expect(gate).toContain("revealInstallSteps(card)");
    expect(gate.indexOf("revealInstallSteps(card)")).toBeGreaterThan(
      gate.indexOf('getElementById("browser-warn-yes")'),
    );
  });

  it("the clock itself is somebody else's, and is not spelled here twice", () => {
    expect(main).toContain('from "./installreveal"');
    expect(installMarkup).not.toMatch(/setTimeout/); // this face arms no timer of its own
    expect(main).toMatch(/revealSteps\(rows\.length, reduced\)/);
    // the phone is asked once, by the wiring, and the schedule answers for it
    expect(main).toContain('window.matchMedia("(prefers-reduced-motion: reduce)").matches');
  });

  it("every message takes the dots' box over through the chat's own morph", () => {
    const play = main.slice(main.indexOf("function playRevealStep"), main.indexOf("function revealInstallSteps"));
    // the one arrival, the chat's, and nothing of its own beside it
    expect(play).toContain("runArrival(row, bubble, seat, {");
    expect(play).toContain("dotsSeat(inRow)"); // read before anything is written
    expect(play.indexOf("dotsSeat(inRow)")).toBeLessThan(play.indexOf("inRow?.remove()"));
    expect(play).toContain('bubble.classList.add("arriving")');
    // no message wears the pop: the pop is the second entrance the morph
    // replaces, and a box that grows does not also pop
    expect(play).not.toContain('"anim"');
    expect(play).not.toContain("pop");
    // and no message is singled out: the seat is whichever row the dots are in
    expect(play).not.toMatch(/step\.index === 0/);
    expect(play).not.toContain('getElementById("install-dots")');
  });

  it("the morph is the chat's, not a copy: one runArrival, called from two places", () => {
    expect(main).toContain('import { arrivalOffered, arrivalShape, runArrival } from "./arrival";');
    expect(main.match(/runArrival\(/g)).toHaveLength(2); // the thread's replies, and this face
    expect(main).not.toMatch(/function runArrival|function installArrival|function growBubble/);
  });

  it("holds the row's box for the morph's beat, so the centred group does not walk", () => {
    // the morph writes the bubble's height from the dots' box up to its own;
    // a row that followed it would shrink the block and re-centre the group
    // once per message. The row's height is read BEFORE the dots go — while
    // the message stands in it hidden — and held for exactly the morph
    const play = main.slice(main.indexOf("function playRevealStep"), main.indexOf("function revealInstallSteps"));
    expect(play).toContain("const held = row.getBoundingClientRect().height;");
    expect(play.indexOf("const held")).toBeLessThan(play.indexOf("inRow?.remove()"));
    expect(play).toContain("row.style.minHeight = `${held}px`;");
    expect(play.indexOf("row.style.minHeight")).toBeLessThan(play.indexOf("runArrival("));
    // and let go of when the morph hands the bubble back, leaving no empty
    // style attribute behind the way the morph itself leaves none
    const done = play.slice(play.indexOf("done: () => {"));
    expect(done).toContain('row.style.removeProperty("min-height");');
    expect(done).toContain('if (!row.getAttribute("style")) row.removeAttribute("style");');
    // under reduced motion there is no morph and so no hold: nothing is
    // written when there is no seat
    expect(play).toContain("if (!seat) return;");
    expect(play.indexOf("if (!seat) return;")).toBeLessThan(play.indexOf("row.style.minHeight"));
  });

  it("the morph carries the message's own bold and glyph, because it carries nodes", () => {
    // three of the five bubbles are not plain text (a bold word, a drawn
    // symbol), and the chat's morph used to lay out and hand back a STRING;
    // it now moves the bubble's own nodes into its layer and back, so what
    // the box grows to show is what the bubble holds (arrival.test.ts pins
    // the mechanics; this pins that the face relies on it)
    const arrival = readFileSync(new URL("../src/arrival.ts", import.meta.url), "utf8");
    expect(arrival).toContain("ink.append(...bubble.childNodes);");
    expect(arrival).toContain("bubble.replaceChildren(...ink.childNodes);");
    expect(arrival).not.toContain("textContent = text");
    expect(MESSAGES.filter((m) => /<b>|\$\{[A-Z_]+_GLYPH\}/.test(m))).toHaveLength(3);
  });
});

// --- the two faces, run -------------------------------------------------------
//
// main.ts is the app's entry point, so importing it would boot the whole app,
// and there is no DOM under node. The card's function and the alert's block are
// cut out by name and run in one VM context over the smallest stand-ins the two
// of them ask for: an element table keyed by the ids the markup carries, and a
// card element for the one querySelector. The two glyph constants are cut out
// with them, so the markup the VM renders is the markup the phone gets.

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
  expect(glyphSource, "the glyph constants were not found").not.toBe("");
  const block = main.slice(at, until) + "\n" + glyphSource + "\n" + gate;
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
    // the reveal is the face's own clock and is pinned in installreveal.test.ts;
    // here it only has to be armed, with the card that was just built
    revealInstallSteps: (given: unknown) => built.push(given === card ? "reveal" : "reveal-other"),
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
    click: (id: string) => byId(id)!.fire("click", { preventDefault: () => {} }),
    render: () => (context.renderTokenGate as () => void)(),
  };
}

describe("a browser tab opens on the steps", () => {
  it("shows the five messages, the line under them, and no box to type in", () => {
    const run = harness(false);
    for (const message of MESSAGES) {
      // the glyph placeholders are the real symbols by the time this renders
      const written = message.replace(/\$\{[A-Z_]+\}/g, "");
      expect(run.html()).toContain(written.trimEnd());
    }
    expect(run.html()).toContain(LINK);
    expect(run.html()).toContain("<svg class=\"install-glyph\""); // drawn, not typed
    expect(run.el("use-browser")).not.toBeNull();
    expect(run.el("install-dots"), "the dots are on screen from the first frame").not.toBeNull();
    expect(run.el("token-input"), "no passcode box on this face").toBeNull();
    expect(run.el("token-save")).toBeNull();
    expect(run.html()).not.toContain("Your access token please?");
  });

  it("wears the install face's own paint, and nothing else does", () => {
    const run = harness(false);
    expect(run.card.classes.has("install")).toBe(true);
    expect(harness(true).card.classes.has("install")).toBe(false);
  });

  it("arms the reveal with that same card, and only on this face", () => {
    expect(harness(false).built).toContain("reveal");
    expect(harness(true).built).not.toContain("reveal");
  });

  it("holds no controller, so a socket refused behind it paints nothing", () => {
    const run = harness(false);
    expect(run.context.tokenGate).toBeNull();
    expect(run.built).not.toContain("refused");
  });

  it("ships the warning box closed, and the link opens it", () => {
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
    expect(run.html()).not.toContain(MESSAGES[0]);
    expect(run.html()).not.toContain(LINK);
    expect(run.el("browser-warn")).toBeNull();
    expect(run.el("install-dots")).toBeNull();
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
    expect(run.html()).not.toContain(MESSAGES[0]);
    expect(run.html()).not.toContain(LINK);
    expect(run.el("use-browser")).toBeNull();
    expect(run.el("install-dots")).toBeNull();
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
  it("a browser tab goes back to the steps, and they are typed out again", () => {
    const run = harness(false);
    run.render(); // the call the log-out box makes once the fade has ended
    expect(run.html()).toContain(MESSAGES[0]);
    expect(run.el("install-dots")).not.toBeNull();
    expect(run.built.filter((b) => b === "reveal")).toHaveLength(2);
    expect(run.el("token-input")).toBeNull();
  });

  it("an installed window goes back to the passcode card", () => {
    const run = harness(true);
    run.render();
    expect(run.html()).toContain("Your access token please?");
    expect(run.html()).not.toContain(MESSAGES[0]);
  });

  it("the choice is not remembered: a tab that chose the browser starts over", () => {
    const run = harness(false);
    const warn = run.el("browser-warn")!;
    run.click("use-browser");
    run.click("browser-warn-yes");
    run.render(); // a fresh open of the page, which is what a log out leaves
    expect(run.html()).toContain(MESSAGES[0]);
    // nothing was written down for it either
    expect(run.stored).toEqual([]);
    expect(gate).not.toContain("localStorage.getItem");
  });
});
