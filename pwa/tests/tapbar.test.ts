// Emoji reactions on the phone: the reaction bar (tapbar.ts), the badges, the
// double tap on the thread and the socket frames, wired in main.ts. main.ts
// boots a real shell at import and cannot load under node, and tapbar.ts is
// all DOM, so both are held by source pins, the way the rest of the suite
// holds the wiring; the rules underneath are tested for real in
// reactions.test.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const bar = readFileSync(new URL("../src/tapbar.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

// a function's text, top level or nested (tapbar.ts keeps its handlers
// inside the factory), up to its own closing brace at its own indent
function fnBody(src: string, name: string): string {
  const found = new RegExp(`\\n( *)(?:export )?(?:async )?function ${name}\\(`).exec(src);
  expect(found, `missing function ${name}`).not.toBeNull();
  const at = found!.index;
  const end = src.indexOf(`\n${found![1]}}\n`, at + 1);
  return src.slice(at, end === -1 ? undefined : end + 2);
}

// the rule whose selector list is exactly this one selector, at a line start
function rule(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `missing ${selector} rule`).toBeGreaterThanOrEqual(0);
  const body = css.slice(start + selector.length + 3);
  return body.slice(0, body.indexOf("}"));
}

describe("the double tap on the thread", () => {
  const gestures = fnBody(main, "bindReactionGestures");

  it("is bound on every rendered thread", () => {
    expect(fnBody(main, "renderChat")).toContain("bindReactionGestures(thread)");
  });

  it("reads the thread's own touches and never prevents the first touch", () => {
    expect(gestures).toMatch(/"touchstart",[\s\S]*?\{ passive: true \}/);
    expect(gestures).toMatch(/"touchmove",[\s\S]*?\{ passive: true \}/);
    // only the second touch's end is taken: no click, no double click, no word
    const end = gestures.slice(gestures.indexOf('"touchend"'));
    expect(end).toContain('!== "double"');
    expect(end.indexOf("e.preventDefault()")).toBeGreaterThan(end.indexOf('!== "double"'));
    expect(gestures.slice(0, gestures.indexOf('"touchend"'))).not.toContain("preventDefault");
  });

  it("holds back a photo's waiting open from the second touch's start", () => {
    expect(gestures).toMatch(/const pairs = doubleTap\.down\([\s\S]*?if \(pairs && hit\) photoTapWait\.claim\(/);
  });

  it("a double click on a bubble selects no word (desktop, and any synthesised one)", () => {
    expect(gestures).toMatch(/"mousedown"[\s\S]*?e\.detail < 2[\s\S]*?e\.preventDefault\(\)/);
  });

  it("does not count a link, a button or a field as a bubble tap", () => {
    expect(fnBody(main, "reactionBubble")).toContain('closest("a, button, input, textarea")');
  });

  it("keeps long press copy: no selection rule is put on the bubbles", () => {
    for (const sel of [".msg", ".msg.user", ".msg.agent", ".msg.lifted"]) {
      expect(rule(sel)).not.toMatch(/user-select|touch-callout/);
    }
  });

  it("clears any selection the double tap left inside the bubble", () => {
    expect(fnBody(main, "openReactionBar")).toContain("clearBubbleSelection(hit.bubble)");
  });
});

describe("a photo's single tap", () => {
  it("waits out the double tap window for user photos and board previews", () => {
    expect(main).toMatch(/photoTap\(m\.seq, \(\) => openLightbox\(img\.src, img\)\)/);
    expect(main).toMatch(/photoTap\(m\.seq, \(\) => openLightbox\(value, img\)\)/);
  });

  it("does not wait for a photo with no number yet (a send in flight)", () => {
    expect(fnBody(main, "photoTap")).toMatch(/if \(!seq\) \{\s*open\(\);\s*return;/);
  });
});

describe("the badges", () => {
  it("are painted on every render, in the row, never inside the bubble", () => {
    expect(fnBody(main, "applyEvent")).toContain("paintReactionsInto(wrapper, seq, false)");
    expect(fnBody(main, "rerender")).toContain("paintReactionsInto(w, seq, false)");
    const paint = fnBody(main, "paintReactionsInto");
    expect(paint).toContain('":scope > .row"');
    expect(paint).toContain("row.append(dock)");
    expect(paint).not.toMatch(/bubble\.append|msg\.append/);
  });

  it("dock beside the bubble on the corner away from the sender", () => {
    expect(rule(".row.user > .tapdock")).toContain("order: -1");
    expect(rule(".row.agent > .tapdock .tapbadge")).toContain("left:");
    expect(rule(".row.user > .tapdock .tapbadge")).toContain("right:");
    expect(rule(".tapdock")).toContain("width: 0");
    expect(rule(".row.reacted")).toContain("padding-top");
  });

  it("show his in the accent and the agent's in the received grey", () => {
    expect(rule(".tapbadge.mine")).toContain("var(--accent)");
    expect(rule(".tapbadge.theirs")).toContain("var(--received)");
  });

  it("keep the reader's place when a reaction changes a row above him", () => {
    const paint = fnBody(main, "paintReactions");
    expect(paint).toContain("keepView(row,");
    expect(paint).toContain('settleContent("reaction")');
  });

  it("leave with a reply that is taken back", () => {
    expect(fnBody(main, "applyRetract")).toContain("reactionBook.drop(seq)");
  });
});

describe("the socket and the saved copy", () => {
  it("handles both keyless frames before anything keyed", () => {
    const connect = fnBody(main, "connect");
    expect(connect).toMatch(/m\.kind === "reaction"\) applyReactionFrame\(/);
    expect(connect).toMatch(/m\.kind === "reactions"\) applyReactionSnapshot\(/);
  });

  it("a snapshot replaces the book wholesale and repaints what changed", () => {
    const snap = fnBody(main, "applyReactionSnapshot");
    expect(snap).toContain("reactionBook.replaceAll(");
    expect(snap).toContain("paintReactions(");
  });

  it("frames of another chat are ignored", () => {
    expect(fnBody(main, "applyReactionFrame")).toContain("f.thread_id !== THREAD_ID");
    expect(fnBody(main, "applyReactionSnapshot")).toContain("f.thread_id !== THREAD_ID");
  });

  it("the saved copy carries the book, and a cold open restores it before painting", () => {
    expect(fnBody(main, "writeThreadCache")).toContain("reactions: reactionBook.entries()");
    const boot = fnBody(main, "bootFromCache");
    const restore = boot.indexOf("reactionBook.replaceAll(");
    expect(restore).toBeGreaterThan(-1);
    expect(restore).toBeLessThan(boot.indexOf("foldOnce("));
  });

  it("a fresh shell forgets the last chat's book and closes the bar", () => {
    const shell = fnBody(main, "renderChat");
    expect(shell).toContain("reactionBook.clear()");
    expect(shell).toContain("tapbar.close()");
  });
});

describe("his pick", () => {
  const react = fnBody(main, "reactTo");

  it("toggles his one reaction and paints it at once", () => {
    expect(react).toContain("nextReaction(");
    expect(react).toContain('reactionBook.set(seq, "user", next)');
  });

  it("is sent for the chat it was made in and put back if the service refuses", () => {
    const send = fnBody(main, "sendReaction");
    expect(send).toContain('"/api/react"');
    expect(send).toContain("thread_id: thread");
    expect(send).toContain("epoch !== threadEpoch");
    expect(send).toMatch(/reactionBook\.set\(seq, "user", previous\)/);
  });

  it("remembers the emoji outside the six as recents, and logout forgets them", () => {
    expect(react).toContain("rememberRecent(");
    expect(fnBody(main, "leaveChat")).toContain("forgetReactionRecents()");
  });
});

describe("the bar", () => {
  it("is drawn outside renderChat's markup, with no SVG", () => {
    expect(fnBody(main, "renderChat")).not.toContain("tapbar-");
    expect(bar).not.toContain("<svg");
    expect(bar).not.toContain("createElementNS");
  });

  it("builds no emoji grid of its own: the six, his recents, and the keyboard", () => {
    expect(bar).toContain("deps.items()");
    expect(bar).not.toMatch(/grid|picker|categories/i);
  });

  it("raises the keyboard by focusing its hidden field inside the smiley's own tap", () => {
    const smiley = fnBody(bar, "onSmiley");
    expect(smiley).toContain("key.focus({ preventScroll: true })");
    expect(smiley).not.toMatch(/setTimeout|requestAnimationFrame|await/);
  });

  it("takes the first emoji he types, drops letters, and lets the keyboard go", () => {
    const typed = fnBody(bar, "onKey");
    expect(typed).toContain("leadingEmoji(");
    expect(typed).toContain('key.value = ""');
    expect(typed).toContain("key.blur()");
  });

  it("closes on a tap outside, and that tap opens nothing in the thread", () => {
    expect(fnBody(bar, "onOutside")).toContain("swallowUntil");
    expect(fnBody(bar, "onSwallow")).toMatch(/e\.preventDefault\(\);\s*e\.stopPropagation\(\)/);
  });

  it("follows the bubble every frame while it is open", () => {
    expect(fnBody(bar, "follow")).toContain("requestAnimationFrame(");
    expect(fnBody(bar, "place")).toContain("barPlacement(");
  });

  it("closes when the chat list opens, or the app goes to the background", () => {
    expect(main).toMatch(/opening: \(\) => \{[\s\S]*?tapbar\.close\(\);/);
    const at = main.lastIndexOf('document.addEventListener("visibilitychange"');
    const hidden = main.slice(main.indexOf("} else {", at), main.indexOf("\n});", at));
    expect(hidden).toContain("tapbar.close()");
  });

  it("lifts the tapped bubble: brighter, a shadow and a little scale, nothing dimmed", () => {
    const lifted = rule(".msg.lifted");
    expect(lifted).toContain("brightness(");
    expect(lifted).toContain("drop-shadow(");
    expect(lifted).toContain("scale:");
    expect(css).not.toMatch(/\.tapbar[^{]*\{[^}]*backdrop-filter/);
  });

  it("the tapback glyphs are coloured, not grey", () => {
    expect(rule(".tb-haha")).toContain("linear-gradient(");
    expect(rule(".tb-emphasize")).toContain("linear-gradient(");
    expect(rule(".tb-question")).toContain("linear-gradient(");
  });

  it("the hidden field is focusable but never seen or tapped", () => {
    const key = rule(".tapbar-key");
    expect(key).toContain("opacity: 0");
    expect(key).toContain("pointer-events: none");
    expect(key).toContain("font-size: 16px"); // iOS zooms a field under 16px
    expect(key).not.toMatch(/display: none|visibility: hidden/);
  });
});
