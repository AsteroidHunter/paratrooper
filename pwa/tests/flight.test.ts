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
