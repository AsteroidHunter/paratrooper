// The sent-bubble colour control.
//
// Three things are pinned, the way the rest of this tool pins things: the hex
// parse/normalise on its own (src/swatch.ts, a pure function like drawer.ts's
// swipeVerdict); the three-way sync between the swatch, the picker and the hex
// field, exercised against element stand-ins the way dots pins its reorder
// against a node fake with no jsdom; and the persistence, reset and presentation
// - which is where the colour actually reaches the bubbles - pinned through the
// real tuning round-trip and against the source of the modules that build and
// paint the control, the way drawer.test.ts pins its wiring.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BAD_CLASS,
  FALLBACK_SENT,
  commitHex,
  normaliseHex,
  syncFromHexInput,
  syncFromPicker,
} from "../src/swatch";
import type { HexField, ValueField } from "../src/swatch";
import { defaultTuning, exportTuning, importTuning, sanitise } from "../src/tuning";
import type { Tuning } from "../src/tuning";

const controls = readFileSync(new URL("../src/controls.ts", import.meta.url), "utf8");
const wiring = readFileSync(new URL("../src/playground.ts", import.meta.url), "utf8");
const bubbles = readFileSync(new URL("../src/bubbles.css", import.meta.url), "utf8");
const tool = readFileSync(new URL("../src/tool.css", import.meta.url), "utf8");
const swatch = readFileSync(new URL("../src/swatch.ts", import.meta.url), "utf8");
const tuningSrc = readFileSync(new URL("../src/tuning.ts", import.meta.url), "utf8");

describe("reading a typed hex value", () => {
  it("takes six digits, with or without the hash, in either case", () => {
    expect(normaliseHex("#4538ff")).toBe("#4538ff");
    expect(normaliseHex("4538ff")).toBe("#4538ff");
    expect(normaliseHex("#4538FF")).toBe("#4538ff");
    expect(normaliseHex("4538FF")).toBe("#4538ff");
  });

  it("expands three digits into six", () => {
    expect(normaliseHex("#f0a")).toBe("#ff00aa");
    expect(normaliseHex("f0a")).toBe("#ff00aa");
    expect(normaliseHex("ABC")).toBe("#aabbcc");
    expect(normaliseHex("#000")).toBe("#000000");
  });

  it("trims surrounding space but nothing inside", () => {
    expect(normaliseHex("  #abcabc  ")).toBe("#abcabc");
    expect(normaliseHex("ab cabc")).toBeNull();
  });

  it("rejects a part-typed, wrong-length or non-hex value as not a colour", () => {
    expect(normaliseHex("")).toBeNull();
    expect(normaliseHex("#")).toBeNull();
    expect(normaliseHex("#1")).toBeNull();
    expect(normaliseHex("12")).toBeNull(); // two digits
    expect(normaliseHex("1234")).toBeNull(); // four digits
    expect(normaliseHex("12345")).toBeNull(); // five digits
    expect(normaliseHex("1234567")).toBeNull(); // seven digits
    expect(normaliseHex("#12345g")).toBeNull(); // g is not hex
    expect(normaliseHex("#4538ff;")).toBeNull(); // a stray character
    expect(normaliseHex("rebeccapurple")).toBeNull(); // names are not accepted
    // the property is typed string, but a stored value could be anything
    expect(normaliseHex(undefined as unknown as string)).toBeNull();
    expect(normaliseHex(null as unknown as string)).toBeNull();
  });
});

// element stand-ins: just the members swatch.ts reads and writes, the way
// dots.test.ts stands in a FakeNode for an HTMLElement.
function hexStub(value = ""): HexField & { has(t: string): boolean; attr(n: string): string | undefined } {
  const classes = new Set<string>();
  const attrs: Record<string, string> = {};
  return {
    value,
    classList: {
      toggle(token: string, force?: boolean): void {
        const on = force ?? !classes.has(token);
        if (on) classes.add(token);
        else classes.delete(token);
      },
    },
    setAttribute(name: string, v: string): void {
      attrs[name] = v;
    },
    removeAttribute(name: string): void {
      delete attrs[name];
    },
    has: (t: string) => classes.has(t),
    attr: (n: string) => attrs[n],
  };
}
const fieldStub = (value = ""): ValueField => ({ value });

describe("the swatch, the picker and the hex field stay in step", () => {
  it("the picker moving fills the hex field and clears any mark", () => {
    const picker = fieldStub("#00ff00");
    const hex = hexStub("was-bad");
    hex.classList.toggle(BAD_CLASS, true);
    const applied = syncFromPicker(picker, hex);
    expect(applied).toBe("#00ff00");
    expect(hex.value).toBe("#00ff00");
    expect(hex.has(BAD_CLASS)).toBe(false);
    expect(hex.attr("aria-invalid")).toBeUndefined();
  });

  it("a whole value typed into the hex field applies live and moves the picker", () => {
    const picker = fieldStub("#4538ff");
    const hex = hexStub("f0a");
    const applied = syncFromHexInput(hex, picker);
    expect(applied).toBe("#ff00aa"); // the colour applied is normalised
    expect(picker.value).toBe("#ff00aa"); // the picker follows
    expect(hex.value).toBe("f0a"); // but the field is left exactly as typed
    expect(hex.has(BAD_CLASS)).toBe(false);
  });

  it("a part-typed value applies nothing, disturbs neither, and is marked", () => {
    const picker = fieldStub("#4538ff");
    const hex = hexStub("#12");
    const applied = syncFromHexInput(hex, picker);
    expect(applied).toBeNull(); // nothing to apply
    expect(picker.value).toBe("#4538ff"); // the colour in force is untouched
    expect(hex.value).toBe("#12"); // what was typed stays for the reader to finish
    expect(hex.has(BAD_CLASS)).toBe(true);
    expect(hex.attr("aria-invalid")).toBe("true");
  });

  it("commit normalises a good value in place", () => {
    const picker = fieldStub("#ff00aa");
    const hex = hexStub("F0A");
    const now = commitHex(hex, picker, "#ff00aa");
    expect(now).toBe("#ff00aa");
    expect(hex.value).toBe("#ff00aa"); // normalised on blur/Enter
    expect(picker.value).toBe("#ff00aa");
    expect(hex.has(BAD_CLASS)).toBe(false);
  });

  it("commit drops a part-typed value back to the colour in force and clears the mark", () => {
    const picker = fieldStub("#123456");
    const hex = hexStub("nope");
    syncFromHexInput(hex, picker); // marks it bad, applies nothing
    expect(hex.has(BAD_CLASS)).toBe(true);
    const now = commitHex(hex, picker, "#123456");
    expect(now).toBe("#123456"); // the colour that was in force
    expect(hex.value).toBe("#123456"); // the field returns to it
    expect(picker.value).toBe("#123456");
    expect(hex.has(BAD_CLASS)).toBe(false);
    expect(hex.attr("aria-invalid")).toBeUndefined();
  });

  it("a full round of typing: bad, then good, then blur, ends normalised and clean", () => {
    const picker = fieldStub(FALLBACK_SENT);
    const hex = hexStub("");
    hex.value = "#ab";
    expect(syncFromHexInput(hex, picker)).toBeNull();
    expect(hex.has(BAD_CLASS)).toBe(true);
    hex.value = "#abc";
    expect(syncFromHexInput(hex, picker)).toBe("#aabbcc");
    expect(hex.has(BAD_CLASS)).toBe(false);
    expect(picker.value).toBe("#aabbcc");
    expect(commitHex(hex, picker, "#aabbcc")).toBe("#aabbcc");
    expect(hex.value).toBe("#aabbcc");
  });
});

describe("the colour persists and resets the way the other settings do", () => {
  it("the default is the accent it is handed, not a colour of its own", () => {
    // whatever the stylesheet says --accent is, that is the default and that is
    // what a reset restores: the literal below is only a stand-in
    expect(defaultTuning("#4538ff").sent).toBe("#4538ff");
    expect(defaultTuning("#ff8a00").sent).toBe("#ff8a00");
    expect(defaultTuning("#ABC").sent).toBe("#aabbcc"); // normalised on the way in
  });

  it("falls back only when there is no stylesheet to read, and to the accent's value", () => {
    expect(defaultTuning().sent).toBe(FALLBACK_SENT); // a node test, no DOM
    expect(defaultTuning("not-a-colour").sent).toBe(FALLBACK_SENT);
    expect(FALLBACK_SENT).toBe("#4538ff"); // the same colour bubbles.css declares
  });

  it("it rides in the same exported JSON that carries every other setting", () => {
    const t = defaultTuning();
    t.sent = "#0a0b0c";
    const o = JSON.parse(exportTuning(t)) as Record<string, unknown>;
    expect(o.sentBubble).toBe("#0a0b0c");
  });

  it("round trips through export and import, which is how it is stored", () => {
    const t = defaultTuning();
    t.sent = "#12ab34";
    const back = importTuning(exportTuning(t));
    expect(back).not.toBeNull();
    expect((back as Tuning).sent).toBe("#12ab34");
  });

  it("a stored value from before this control existed loads as the accent", () => {
    const old = '{"tool":"bubble-animation-tool","config":"live"}';
    expect((importTuning(old, "#ff8a00") as Tuning).sent).toBe("#ff8a00");
    expect((importTuning(old) as Tuning).sent).toBe(FALLBACK_SENT);
  });

  it("a stored value is not trusted: a shorthand is expanded, junk falls to the accent", () => {
    expect(sanitise({ ...defaultTuning(), sent: "#ABC" }).sent).toBe("#aabbcc");
    expect(sanitise({ ...defaultTuning(), sent: "not-a-colour" }, "#ff8a00").sent).toBe("#ff8a00");
    expect(sanitise({ ...defaultTuning(), sent: "" }).sent).toBe(FALLBACK_SENT);
  });
});

describe("the control is built, wired and painted the tool's own way", () => {
  it("declares a swatch, a native colour input and a hex text field", () => {
    expect(controls).toContain('colourInput.type = "color";');
    expect(controls).toContain('hexInput.type = "text";');
    expect(controls).toContain('el("span", "swatch")');
    expect(controls).toContain('"Sent bubble colour"');
    // the label points at the picker, and the hex field carries its own name
    expect(controls).toContain("colourLabel.htmlFor = colourInput.id;");
    expect(controls).toContain('hexInput.setAttribute("aria-label"');
  });

  it("wires the three swatch.ts helpers to input, blur and Enter", () => {
    expect(controls).toContain("syncFromPicker(colourInput, hexInput)");
    expect(controls).toContain("syncFromHexInput(hexInput, colourInput)");
    expect(controls).toContain("commitHex(hexInput, colourInput, t.sent)");
    expect(controls).toMatch(/hexInput\.addEventListener\("blur", commit\)/);
    expect(controls).toMatch(/if \(e\.key === "Enter"\)/);
    // a keystroke that is not yet a colour applies nothing
    expect(controls).toContain("if (colour !== null) applyColour(colour);");
    // and a reset or a load pulls the widgets back
    expect(controls).toContain("refreshColour();");
  });

  it("keeps the hex field usable on a phone: an <input>, so the closing swipe lets it be", () => {
    // drawer.ts's CONTROL selector already spares any <input> from a closing
    // swipe; here we only pin that these two ARE inputs and are finger-sized
    expect(controls).toContain('colourInput = el("input"');
    expect(controls).toContain('hexInput = el("input"');
    const phone = tool.slice(tool.indexOf("@media (max-width: 900px), (display-mode: standalone) {"));
    expect(phone).toContain(".hexinput,");
    expect(phone).toContain(".colourpick,");
    expect(phone).toContain(".panelclose { min-height: 44px; }");
  });

  it("drives the colour onto --sent with a CSSOM write, never an inline style", () => {
    expect(wiring).toContain('document.documentElement.style.setProperty("--sent", tuning.sent);');
    expect(wiring).toContain("tuning.sent = next.sent;");
    // applied on load and again on reset, so the thread and the widgets agree
    expect(wiring).toMatch(/applySentColour\(\); \/\/ a stored colour paints on load/);
    expect(wiring).toMatch(/applySentColour\(\); \/\/ the colour resets/);
    // no inline-style attribute anywhere, the way drawer.test.ts requires
    expect(wiring).not.toContain('setAttribute("style"');
  });

  it("paints the sent bubbles and the swatch from one token, and leaves the rest alone", () => {
    // the sent bubble and its tail follow --sent; --sent defaults to --accent
    expect(bubbles).toContain("--sent: var(--accent);");
    const user = bubbles.slice(bubbles.indexOf(".msg.user {"), bubbles.indexOf(".msg.agent {"));
    expect(user).toContain("--fill: var(--sent);");
    expect(user).toContain("background: var(--sent);");
    expect(user).toContain("color: var(--sent-text);"); // the sent text is left as it was
    // received bubbles are not touched
    const agent = bubbles.slice(bubbles.indexOf(".msg.agent {"));
    expect(agent).toContain("--fill: var(--received);");
    expect(agent).toContain("background: var(--received);");
    // the panel swatch reads the very same token, so it follows for free
    expect(tool).toMatch(/\.swatch \{[^}]*background: var\(--sent\);/);
    // and the not-accepted mark is the quiet one, not an alarm
    expect(tool).toContain(".hexinput.bad {");
    expect(tool).toContain("border-style: dashed;");
  });

  it("takes its default from the stylesheet's accent, read once at start-up", () => {
    expect(wiring).toContain(
      'getComputedStyle(document.documentElement).getPropertyValue("--accent")',
    );
    expect(wiring).toContain("normaliseHex(declared) ?? FALLBACK_SENT");
    // the value read is what the tuning starts with, what a stored tuning with no
    // colour of its own loads as, and what a reset restores - one value, not three
    expect(wiring).toContain("defaultTuning(ACCENT)");
    expect(wiring).toContain("importTuning(stored, ACCENT)");
    expect(wiring).toContain("applyTuning(defaultTuning(ACCENT));");
    // and the panel is told the same value rather than naming one of its own
    expect(wiring).toContain("defaultSent: ACCENT,");
    expect(controls).toContain("hexInput.placeholder = hooks.defaultSent;");
    expect(controls).toContain("Reset to defaults returns it to ${hooks.defaultSent}");
  });

  it("keeps no copy of the old accent anywhere in the control", () => {
    // the point of reading the sheet: when --accent is repainted there is no
    // literal here to go stale. bubbles.css is the sheet itself and owns the
    // accent's value; these modules must not hold one.
    for (const src of [swatch, tuningSrc, controls, wiring]) {
      expect(src).not.toContain("432bff");
    }
  });
});
