// The control panel. Sliders for the feel, four repeatable gestures to feel it
// on, a build picker, reset and copy. It owns no physics: it writes the tuning
// object and calls back.
//
// The two buttons at the top are the A/B the tool exists for and are left
// exactly where they were. The picker under them is the same setting seen
// whole: it holds those two plus every distinct spring build recovered from
// pushed history, so choosing one is not a second, competing control.

import {
  KNOBS,
  configChoices,
  customisedKnobs,
  exportTuning,
  knobLive,
  loadConfigValues,
  readKnob,
  writeKnob,
} from "./tuning";
import type { Knob, Tuning } from "./tuning";
import { CONTROLLER_ONLY, configFor, provenanceOf, sharesCodeWith } from "./presets";
import type { ConfigId } from "./presets";
import { BAD_CLASS, DEFAULT_SENT, commitHex, syncFromHexInput, syncFromPicker } from "./swatch";

export type DemoKind = "up" | "down" | "catch" | "reverse";
export type Frame = "375" | "390" | "fill";

export interface ControlHooks {
  tuning: Tuning;
  /** a knob or the wave origin moved */
  onChange(): void;
  /** the selected build changed: the wiring has to build its field */
  onConfig(): void;
  /** the sent bubble colour moved: the wiring drives it onto --sent and stores it */
  onColour(): void;
  onReset(): void;
  onDemo(kind: DemoKind): void;
  onFrame(frame: Frame): void;
}

export interface ControlPanel {
  /** pull every widget back from the tuning object (after a reset or a load) */
  refresh(): void;
  /** the one live line under the panel */
  readout(text: string): void;
  /** the demo buttons go dead while a scripted gesture is running */
  demoBusy(busy: boolean): void;
  root: HTMLElement;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function fmt(k: Knob, v: number): string {
  const dp = k.step < 0.1 ? 2 : k.step < 1 ? 2 : 0;
  return `${v.toFixed(dp)}${k.unit ? ` ${k.unit}` : ""}`;
}

export function mountControls(root: HTMLElement, hooks: ControlHooks): ControlPanel {
  const t = hooks.tuning;
  const rows: { knob: Knob; input: HTMLInputElement; value: HTMLElement; row: HTMLElement }[] = [];
  const modeButtons: { id: ConfigId; btn: HTMLButtonElement }[] = [];
  const originButtons: { origin: "finger" | "bottom"; btn: HTMLButtonElement }[] = [];
  const frameButtons: { frame: Frame; btn: HTMLButtonElement }[] = [];
  const demoButtons: HTMLButtonElement[] = [];

  root.textContent = "";

  /** a build was chosen: its own numbers go into the sliders it reads */
  function chooseConfig(id: ConfigId): void {
    if (t.config === id) return;
    loadConfigValues(t, id);
    refresh();
    hooks.onConfig();
  }

  // --- mode -----------------------------------------------------------------
  const modeBlock = el("section", "block");
  modeBlock.append(el("h2", "", "How bubbles return"));
  const seg = el("div", "seg");
  const addMode = (id: ConfigId, label: string, sub: string): void => {
    const b = el("button", "segbtn");
    b.type = "button";
    b.append(el("span", "segmain", label), el("span", "segsub", sub));
    b.addEventListener("click", () => chooseConfig(id));
    seg.append(b);
    modeButtons.push({ id, btn: b });
  };
  addMode("live", "Baseline", "all rows return together");
  addMode("travelling", "Travelling", "the return moves up the thread");
  modeBlock.append(seg);

  // --- the build picker -----------------------------------------------------
  const pickRow = el("div", "knob");
  const pickHead = el("div", "knobhead");
  const pickLabel = el("label", "knoblabel", "Spring build");
  pickHead.append(pickLabel);
  const picker = el("select", "picker");
  picker.id = "configpicker";
  pickLabel.htmlFor = picker.id;
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const choice of configChoices()) {
    let g = groups.get(choice.group);
    if (!g) {
      g = document.createElement("optgroup");
      g.label = choice.group;
      groups.set(choice.group, g);
      picker.append(g);
    }
    const o = document.createElement("option");
    o.value = choice.id;
    o.textContent = choice.label;
    g.append(o);
  }
  picker.addEventListener("change", () => chooseConfig(picker.value as ConfigId));
  pickRow.append(pickHead, picker);
  const provenance = el("p", "hint prov", "");
  const alsoLine = el("p", "hint", "");
  pickRow.append(provenance, alsoLine);
  modeBlock.append(pickRow);

  const controllerNote = el("details", "note");
  const controllerSummary = document.createElement("summary");
  controllerSummary.textContent = `Seven more pushed changes are not in this list`;
  controllerNote.append(controllerSummary);
  controllerNote.append(
    el(
      "p",
      "hint",
      "They changed how the app hands the field its scroll, not what a spring computes: a finished send flight releasing the hold-off, a pinned page of older messages reporting its correction, who owns the scroll after a resume. This transcript never sends, pins or resumes, so there is nothing here for them to do and they are listed rather than offered.",
    ),
  );
  const controllerList = el("ul", "hint");
  for (const v of CONTROLLER_ONLY) {
    controllerList.append(el("li", "", `${v.at} — ${v.what}`));
  }
  controllerNote.append(controllerList);
  modeBlock.append(controllerNote);
  root.append(modeBlock);

  // --- repeatable gestures --------------------------------------------------
  const demoBlock = el("section", "block");
  demoBlock.append(el("h2", "", "Repeatable stops"));
  demoBlock.append(
    el(
      "p",
      "note",
      "Each runs the same scripted gesture from the same place at the same speed, through the same handlers a real finger uses. Change a slider, run it again, compare.",
    ),
  );
  const demos = el("div", "btns");
  const addDemo = (kind: DemoKind, label: string): void => {
    const b = el("button", "btn");
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", () => hooks.onDemo(kind));
    demos.append(b);
    demoButtons.push(b);
  };
  addDemo("up", "Drag up, stop");
  addDemo("down", "Drag down, stop");
  addDemo("reverse", "Reverse, stop");
  addDemo("catch", "Flick, then catch");
  demoBlock.append(demos);
  root.append(demoBlock);

  // --- sliders --------------------------------------------------------------
  const group = (title: string, note: string): HTMLElement => {
    const s = el("section", "block");
    s.append(el("h2", "", title));
    s.append(el("p", "note", note));
    root.append(s);
    return s;
  };
  const shared = group(
    "While scrolling",
    "These settings control how the bubbles trail behind the scroll. A dimmed slider is not used by the selected build.",
  );
  const rippleGroup = group(
    "Ripple return",
    "This setting controls the experimental ripple after scrolling stops. It works only while Ripple from the finger is selected.",
  );
  const travelGroup = group(
    "Travelling return",
    "These settings control the experimental wave after scrolling stops. They work only while Travelling is selected.",
  );

  for (const knob of KNOBS) {
    const host =
      knob.group === "shared" ? shared : knob.group === "ripple" ? rippleGroup : travelGroup;
    const row = el("div", "knob");
    const head = el("div", "knobhead");
    const label = el("label", "knoblabel", knob.label);
    const value = el("span", "knobvalue", fmt(knob, readKnob(t, knob.key)));
    head.append(label, value);
    const input = el("input");
    input.type = "range";
    input.min = String(knob.min);
    input.max = String(knob.max);
    input.step = String(knob.step);
    input.value = String(readKnob(t, knob.key));
    const id = `knob-${knob.key.replace(".", "-")}`;
    input.id = id;
    label.htmlFor = id;
    input.addEventListener("input", () => {
      writeKnob(t, knob.key, Number(input.value));
      value.textContent = fmt(knob, readKnob(t, knob.key));
      paint(); // the provenance line has to say at once that this is no longer the build
      hooks.onChange();
    });
    row.append(head, input, el("p", "hint", knob.hint));
    host.append(row);
    rows.push({ knob, input, value, row });
  }

  // wave origin sits with the travel knobs: it is one of them, just not a number
  const originRow = el("div", "knob");
  const originHead = el("div", "knobhead");
  originHead.append(el("span", "knoblabel", "Return wave starts at"));
  originRow.append(originHead);
  const originSeg = el("div", "seg small");
  const addOrigin = (origin: "finger" | "bottom", label: string): void => {
    const b = el("button", "segbtn");
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", () => {
      if (t.travel.origin === origin) return;
      t.travel.origin = origin;
      paint();
      hooks.onChange();
    });
    originSeg.append(b);
    originButtons.push({ origin, btn: b });
  };
  addOrigin("finger", "The finger");
  addOrigin("bottom", "Screen bottom");
  originRow.append(
    originSeg,
    el(
      "p",
      "hint",
      "The finger starts the return near the touched bubbles; if scrolling carries that point off screen, the bottom edge takes over. Screen bottom always starts the return there. In both cases the wave moves upward. Used only by Travelling.",
    ),
  );
  travelGroup.append(originRow);

  // --- sent bubble colour ---------------------------------------------------
  // A swatch, the native colour well and a hex field, in one row. The three are
  // kept in step by swatch.ts; the colour itself is driven onto --sent by the
  // wiring, and the swatch reads that same var, so it follows every change for
  // free. Received bubbles and the sent text colour are left untouched.
  const colourBlock = el("section", "block");
  colourBlock.append(el("h2", "", "Bubble colour"));
  colourBlock.append(
    el(
      "p",
      "note",
      "The fill of the sent bubbles and their tails, in both light and dark. The received bubbles are left as they are.",
    ),
  );
  const colourRow = el("div", "knob");
  const colourHead = el("div", "knobhead");
  const colourLabel = el("label", "knoblabel", "Sent bubble colour");
  colourHead.append(colourLabel);
  const swatchRow = el("div", "swatchrow");
  const swatch = el("span", "swatch");
  swatch.setAttribute("aria-hidden", "true"); // the picker and the hex field carry the value
  const colourInput = el("input", "colourpick");
  colourInput.type = "color";
  colourInput.id = "sent-colour";
  colourLabel.htmlFor = colourInput.id;
  const hexInput = el("input", "hexinput");
  hexInput.type = "text";
  hexInput.id = "sent-hex";
  hexInput.setAttribute("aria-label", "Sent bubble colour, hex value");
  hexInput.setAttribute("inputmode", "text");
  hexInput.setAttribute("autocomplete", "off");
  hexInput.setAttribute("autocapitalize", "off");
  hexInput.setAttribute("autocorrect", "off");
  hexInput.spellcheck = false;
  hexInput.maxLength = 7; // "#rrggbb"
  hexInput.placeholder = DEFAULT_SENT;
  swatchRow.append(swatch, colourInput, hexInput);
  colourRow.append(
    colourHead,
    swatchRow,
    el(
      "p",
      "hint",
      `Pick from the well, or type a hex value — three or six digits, with or without the #, either case. A part-typed or unknown value changes nothing until it is a whole colour. Reset to defaults returns it to ${DEFAULT_SENT}.`,
    ),
  );
  colourBlock.append(colourRow);
  root.append(colourBlock);

  const applyColour = (colour: string): void => {
    t.sent = colour;
    hooks.onColour();
  };
  const refreshColour = (): void => {
    colourInput.value = t.sent;
    hexInput.value = t.sent;
    hexInput.classList.toggle(BAD_CLASS, false);
    hexInput.removeAttribute("aria-invalid");
  };
  colourInput.addEventListener("input", () => applyColour(syncFromPicker(colourInput, hexInput)));
  hexInput.addEventListener("input", () => {
    const colour = syncFromHexInput(hexInput, colourInput);
    if (colour !== null) applyColour(colour);
  });
  // blur and Enter are the two moments a typed value is settled: a good one is
  // normalised in place, a part-typed one falls back to the colour in force
  const commit = (): void => applyColour(commitHex(hexInput, colourInput, t.sent));
  hexInput.addEventListener("blur", commit);
  hexInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }
  });
  refreshColour();

  // --- viewport, reset, copy ------------------------------------------------
  const outBlock = el("section", "block");
  outBlock.append(el("h2", "", "Tool"));
  const frameRow = el("div", "knob");
  const frameHead = el("div", "knobhead");
  frameHead.append(el("span", "knoblabel", "Preview size"));
  frameRow.append(frameHead);
  const frameSeg = el("div", "seg small");
  const addFrame = (frame: Frame, label: string): void => {
    const b = el("button", "segbtn");
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", () => {
      paintFrame(frame);
      hooks.onFrame(frame);
    });
    frameSeg.append(b);
    frameButtons.push({ frame, btn: b });
  };
  addFrame("375", "375 x 812");
  addFrame("390", "390 x 844");
  addFrame("fill", "Fill");
  frameRow.append(
    frameSeg,
    el(
      "p",
      "hint",
      "375 x 812 is the iPhone 13 mini's logical screen in CSS pixels, drawn unscaled. Its device pixel ratio of 3 is a rendering scale, not a wider canvas. The phone's safe-area insets are not simulated: env() inside a preview box would report this window's insets rather than a phone's, and no verified figures for the device were available to put in their place.",
    ),
  );
  outBlock.append(frameRow);

  const actions = el("div", "btns");
  const resetBtn = el("button", "btn");
  resetBtn.type = "button";
  resetBtn.textContent = "Reset to defaults";
  resetBtn.addEventListener("click", () => hooks.onReset());
  const copyBtn = el("button", "btn");
  copyBtn.type = "button";
  copyBtn.textContent = "Copy tuning";
  copyBtn.addEventListener("click", () => {
    const text = exportTuning(t);
    dump.value = text;
    dump.hidden = false;
    dump.select();
    const done = (ok: boolean): void => {
      copyBtn.textContent = ok ? "Copied" : "Select and copy";
      setTimeout(() => (copyBtn.textContent = "Copy tuning"), 1400);
    };
    // navigator.clipboard is unavailable over plain http on some engines; the
    // textarea below is the fallback and is always filled first
    const nav = navigator as Navigator & { clipboard?: { writeText(s: string): Promise<void> } };
    if (nav.clipboard?.writeText) nav.clipboard.writeText(text).then(() => done(true), () => done(false));
    else done(false);
  });
  actions.append(resetBtn, copyBtn);
  outBlock.append(actions);
  const dump = el("textarea", "dump");
  dump.readOnly = true;
  dump.rows = 12;
  dump.hidden = true;
  outBlock.append(dump);
  root.append(outBlock);

  // --- painting -------------------------------------------------------------
  function paintFrame(frame: Frame): void {
    for (const f of frameButtons) f.btn.classList.toggle("on", f.frame === frame);
  }

  function paint(): void {
    const c = configFor(t.config);
    for (const m of modeButtons) {
      m.btn.classList.toggle("on", m.id === t.config);
      m.btn.setAttribute("aria-pressed", String(m.id === t.config));
    }
    // a historical build is neither of the two buttons: neither lights up, and
    // the picker is the control that is telling the truth
    picker.value = t.config;
    const changed = customisedKnobs(t);
    provenance.textContent =
      provenanceOf(c) + (changed.length > 0 ? " · CUSTOMISED, no longer this build's numbers" : "");
    provenance.classList.toggle("warn", changed.length > 0);
    const shares = sharesCodeWith(t.config);
    const also: string[] = [];
    if (c.aliases.length > 1) also.push(`also pushed as ${c.aliases.length - 1} more commits`);
    if (shares.length > 0) also.push(`same modules as ${shares.map((s) => s.label).join(", ")}`);
    alsoLine.textContent = also.length > 0 ? `${c.summary} (${also.join("; ")})` : c.summary;
    for (const o of originButtons) o.btn.classList.toggle("on", o.origin === t.travel.origin);
    rippleGroup.classList.toggle("dim", t.config !== "ripple");
    travelGroup.classList.toggle("dim", t.config !== "travelling");
    for (const r of rows) {
      const live = knobLive(t, r.knob.key);
      r.row.classList.toggle("dim", !live);
      r.input.disabled = !live;
      r.row.classList.toggle("changed", changed.includes(r.knob.key));
    }
    if (!dump.hidden) dump.value = exportTuning(t);
  }

  function refresh(): void {
    for (const r of rows) {
      r.input.value = String(readKnob(t, r.knob.key));
      r.value.textContent = fmt(r.knob, readKnob(t, r.knob.key));
    }
    refreshColour(); // a reset or a load pulls the colour widgets back too
    paint();
  }

  const line = el("p", "readout", "");
  root.append(line);

  paint();
  paintFrame("375");

  return {
    refresh,
    readout: (text: string) => {
      line.textContent = text;
    },
    demoBusy: (busy: boolean) => {
      for (const b of demoButtons) b.disabled = busy;
    },
    root,
  };
}
