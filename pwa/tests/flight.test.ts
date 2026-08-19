// Pins for the send-flight gate removal and the socket trail wiring. Both live
// in main.ts's DOM layer, which boots a real shell at import time and cannot
// load under node — so these pins read the source instead. What they hold:
// the standing order that the flight ALWAYS plays (no reduced-motion early
// return creeping back), that every flight leaves measured dx/dy and
// start/finish/cancel records on the trail, and that every socket frame
// passing the hold gate is recorded before applyEvent renders it.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/main.ts"),
  "utf8",
);

function fnBody(name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("\n}", start);
  return src.slice(start, end);
}

describe("send flight (flyFromField)", () => {
  const body = fnBody("flyFromField");

  it("the prefers-reduced-motion early return is gone for good", () => {
    expect(body).not.toContain("prefers-reduced-motion");
    expect(body).not.toContain("matchMedia");
  });

  it("records invoke, per-bubble dx/dy at start, and finish/cancel on the trail", () => {
    expect(body).toContain('phase: "invoke"');
    expect(body).toContain('phase: "start"');
    expect(body).toMatch(/dx:.*dy:/s);
    expect(body).toContain('phase: "finish"');
    expect(body).toContain('phase: "cancel"');
  });

  it("still animates via the Web Animations API (the WebKit-proof path)", () => {
    expect(body).toContain("msg.animate(");
  });

  it("a fresh send collapses the composer before it launches", () => {
    // the field rect is the flight's start seat and the thread pin is its
    // landing seat: both must be final when the FLIP measures, so a fresh
    // launch runs the collapse (and its re-pin wait) before flyFromField;
    // only a send onto a still-airborne flight defers the collapse past it
    const send = fnBody("send");
    const freshCollapse = send.indexOf("collapseBar();");
    const fly = send.indexOf("flyFromField(w, morph)");
    expect(freshCollapse).toBeGreaterThan(-1);
    expect(freshCollapse).toBeLessThan(fly);
    expect(send.indexOf("if (airborne) collapseBar();")).toBeGreaterThan(fly);
  });
});

describe("send morph (armFieldMorph) — the bar leaves the box", () => {
  const morph = fnBody("armFieldMorph");
  const send = fnBody("send");
  const fly = fnBody("flyFromField");

  it("the bar snapshot predates the collapse: the shell lifts the typed text", () => {
    const arm = send.indexOf("armFieldMorph(");
    const collapse = send.indexOf("collapseBar();");
    expect(arm).toBeGreaterThan(-1);
    expect(arm).toBeLessThan(collapse);
  });

  it("only a text send arms a morph, and the text row rides it", () => {
    expect(send).toContain("text ? armFieldMorph(textEl) : null");
    expect(fly).toContain('msg.classList.contains("text")');
    expect(fly).toContain("morph.launch(msg)");
  });

  it("photo rows keep the WAAPI translate flight, unrouted through the morph", () => {
    expect(fly).toContain("msg.animate(");
  });

  it("the shell is honest box geometry re-aimed at the live seat every frame", () => {
    expect(morph).toContain("morphBox(");
    expect(morph).toContain("morphCorners(");
    expect(morph).toContain("flightEase(");
    // a second send's pin-and-shift moves the seat mid-flight; the per-frame
    // rect read is what lands the shell on the seat as it IS
    const step = morph.indexOf("const step");
    expect(step).toBeGreaterThan(-1);
    expect(morph.indexOf("msg.getBoundingClientRect()", step)).toBeGreaterThan(step);
    expect(morph).not.toContain("scale("); // shape morphs by box, never by transform
  });

  it("the real bubble holds its seat hidden and is handed back byte-clean", () => {
    expect(morph).toContain('msg.style.opacity = "0"');
    expect(morph).toContain('removeProperty("opacity")');
    expect(morph).toContain('removeAttribute("style")');
  });

  it("the crossfade layers ride the shared fractions from shift.ts", () => {
    expect(morph).toContain("barTextAlpha(f)");
    expect(morph).toContain("bubbleTextAlpha(f)");
    expect(morph).toContain("accentAlpha(f)");
  });

  it("morph flights join the receipt-hold ledger like translate flights", () => {
    expect(morph).toContain("flightsUp++");
    expect(morph).toContain("flightSettled()");
  });

  it("the landing frame paints before the swap (no snap under load)", () => {
    expect(morph).toContain('requestAnimationFrame(() => settle(msg, "morph-finish"))');
  });

  it("records arm, launch with travel and target, finish, and cancel", () => {
    expect(morph).toContain('phase: "morph-arm"');
    expect(morph).toContain('phase: "morph-launch"');
    expect(morph).toMatch(/dx:.*dy:/s);
    expect(morph).toContain('"morph-finish"');
    expect(morph).toContain('"morph-cancel"');
  });
});

describe("socket apply trail (ws onmessage)", () => {
  it("records seq/kind/role after the hold gate and before applyEvent", () => {
    const gate = src.indexOf("replyHold.maybeHold(m.seq, m)");
    const record = src.indexOf('holdDiagRecord("ws-apply"');
    const apply = src.indexOf("applyEvent(m);", record);
    expect(gate).toBeGreaterThan(-1);
    expect(record).toBeGreaterThan(gate);
    expect(apply).toBeGreaterThan(record);
    expect(src.slice(record, apply)).toContain("kind: m.kind ?? null");
    expect(src.slice(record, apply)).toContain("role: m.role ?? null");
  });
});
