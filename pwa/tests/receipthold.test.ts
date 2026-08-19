// Pins for the send-flight receipt hold (the end-of-send bounce's last mover)
// and the TEMP send-window motion recorder. On a fast connection the send ACK
// lands mid-flight (real ACKs in 50-200ms against the 400ms beat) and
// updateReceipt then relocates the delivery stamp — removed from under the
// previous sent bubble, appended under the flying one — so the landing seat
// and everything above it jolt while the bubble is airborne. The hold parks
// any layout-mutating receipt work while a flight is up and applies it when
// the last flight settles, finish and cancel alike; label-only fades stay
// live, and sends with no flight keep the immediate path. main.ts boots a
// real shell at import and cannot load under node, so the wiring is
// source-pinned like flight.test.ts.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/main.ts"), "utf8");
const holdSrc = readFileSync(join(here, "../src/hold.ts"), "utf8");

function fnBody(name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("\n}", start);
  return src.slice(start, end);
}

describe("updateReceipt — layout mutations park while a flight is airborne", () => {
  const body = fnBody("updateReceipt");

  it("a relocation to a different wrapper parks on the flight gate", () => {
    // the fresh-stamp swap (remove + append) sits behind the flightsUp gate
    const gate = body.lastIndexOf("if (flightsUp > 0)");
    const swap = body.indexOf("wrapper.appendChild(buildReceipt(");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(swap);
    expect(body).toContain("receiptPending = true");
  });

  it("the bare removal (stamp target gone) parks behind the same hold", () => {
    // removing the stamp shifts every row above it exactly like a relocation
    const noTarget = body.indexOf("if (!r || !wrapper)");
    const sameWrapper = body.indexOf("existing.parentElement === wrapper");
    const gate = body.indexOf("flightsUp > 0", noTarget);
    expect(noTarget).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(noTarget);
    expect(gate).toBeLessThan(sameWrapper); // inside the no-target branch
  });

  it("same-wrapper label fades stay live: the fade branch precedes the gate", () => {
    // the Delivered -> Read flip is opacity-only (no layout), so it must
    // return before the relocation gate can park it
    const fade = body.indexOf('classList.add("rc-hide")');
    const gate = body.lastIndexOf("if (flightsUp > 0)");
    expect(fade).toBeGreaterThan(-1);
    expect(fade).toBeLessThan(gate);
  });

  it("the gate is the live animation count, never a timer", () => {
    // sends with no flight (flyFromField's early return) start no animation,
    // so flightsUp stays 0 and the immediate path is untouched; an ACK after
    // touchdown reads 0 the same way
    expect(body).not.toContain("lastLaunchAt");
    expect(body).not.toContain("performance.now");
    expect(fnBody("flyFromField")).toContain("flightsUp++");
  });

  it("both parks leave a receipt-hold record on the trail", () => {
    expect(body.match(/holdDiagRecord\("receipt-hold", \{ phase: "park" \}\)/g))
      .toHaveLength(2);
  });
});

describe("flightSettled — the parked stamp lands when the last flight ends", () => {
  const body = fnBody("flightSettled");
  const fly = fnBody("flyFromField");

  it("finish AND cancel both route through flightSettled", () => {
    // a cancelled flight (torn-down wrapper, replay beating the ACK) must
    // still deliver its stamp
    expect(fly.match(/flightSettled\(\);/g)).toHaveLength(2);
    expect(fly.indexOf("flightSettled()")).toBeGreaterThan(fly.indexOf('phase: "finish"'));
    expect(fly.lastIndexOf("flightSettled()")).toBeGreaterThan(fly.indexOf('phase: "cancel"'));
  });

  it("waits for the LAST flight: one counter, floored, drained per settle", () => {
    expect(body).toContain("if (flightsUp > 0) flightsUp--");
    expect(body).toContain("if (flightsUp > 0 || !receiptPending) return");
  });

  it("applies through the sibling-shift machinery, so the stamp newborn-enters", () => {
    // measure, swap, play: the relocation is height-neutral, the seat's hop
    // glides on the shared beat, and the fresh stamp (a newborn to the walk)
    // fades up into place — the same enter every send-born element gets
    const measure = body.indexOf("beginSiblingShift()");
    const apply = body.indexOf("updateReceipt()");
    const play = body.indexOf("shift.play()");
    expect(measure).toBeGreaterThan(-1);
    expect(measure).toBeLessThan(apply);
    expect(apply).toBeLessThan(play);
  });

  it("records the apply on the trail and clears the slot before recomputing", () => {
    expect(body).toContain('holdDiagRecord("receipt-hold", { phase: "apply" })');
    expect(body.indexOf("receiptPending = false")).toBeLessThan(body.indexOf("updateReceipt()"));
  });

  it("a fresh shell resets the counter and the slot", () => {
    const shell = fnBody("renderChat");
    expect(shell).toContain("flightsUp = 0");
    expect(shell).toContain("receiptPending = false");
  });
});

describe("send-window motion recorder (TEMP, rides the holddiag trail)", () => {
  const rec = fnBody("recordSendMotion");

  it("armed at flight start with the landing row", () => {
    const fly = fnBody("flyFromField");
    expect(fly).toContain("recordSendMotion(msgs[msgs.length - 1])");
  });

  it("samples scrollTop, scrollHeight, and the transform-stripped seat", () => {
    // the seat is the bubble's LAYOUT position: stripping the running
    // transform is what keeps the flying bubble itself out of the metric
    expect(rec).toContain("t.scrollTop");
    expect(rec).toContain("t.scrollHeight");
    expect(rec).toContain("seatTop(msg)");
    expect(fnBody("seatTop")).toContain("DOMMatrixReadOnly");
  });

  it("names the mover past a 1px threshold", () => {
    expect(rec).toContain("Math.abs(delta) > 1");
    expect(rec).toContain('holdDiagRecord("send-motion"');
    expect(rec).toMatch(/moved: name/);
  });

  it("caps the window's records and bounds the window itself", () => {
    expect(src).toContain("const SEND_MOTION_MAX = 40");
    expect(src).toContain("const SEND_MOTION_WINDOW_MS = 600");
    expect(rec).toContain("recorded < SEND_MOTION_MAX");
    expect(rec).toContain("< SEND_MOTION_WINDOW_MS");
  });

  it("a rapid second send re-arms one window instead of stacking loops", () => {
    expect(rec).toContain("cancelAnimationFrame(sendMotionRaf)");
  });

  it("the new record names trigger the diag post", () => {
    expect(holdSrc).toContain('ev === "send-motion"');
    expect(holdSrc).toContain('ev === "receipt-hold"');
  });
});
