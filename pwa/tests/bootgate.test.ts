// Pins for the fresh-open first-paint gate (src/bootgate.ts): the thread
// builds behind a veil and shows exactly once, only after the boot settle pin
// lands (or the socket dies first). One claim per shell keeps reconnect
// settles from yanking a reader; reset() re-arms everything for a rebuilt
// shell (re-login), whose fresh markup raises the veil again itself.
import { describe, expect, it, vi } from "vitest";
import { createBootGate } from "../src/bootgate";

function harness() {
  const reveal = vi.fn();
  const gate = createBootGate(reveal);
  return { reveal, gate };
}

describe("the settle pin is claimed exactly once per shell", () => {
  it("first settle claims the pin; every later settle is turned away", () => {
    const { gate } = harness();
    expect(gate.claimSettlePin()).toBe(true);
    expect(gate.claimSettlePin()).toBe(false); // reconnect settle: no re-pin
    expect(gate.claimSettlePin()).toBe(false);
  });

  it("claiming alone does not reveal — the pin has not landed yet", () => {
    const { reveal, gate } = harness();
    gate.claimSettlePin();
    expect(gate.revealed()).toBe(false);
    expect(reveal).not.toHaveBeenCalled();
  });
});

describe("the reveal — after the pin lands, or when the socket dies first", () => {
  it("pinLanded lifts the veil once; repeats stay silent", () => {
    const { reveal, gate } = harness();
    gate.claimSettlePin();
    gate.pinLanded();
    expect(gate.revealed()).toBe(true);
    gate.pinLanded(); // a reconnect settle also reports in
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it("a dead socket before any settle reveals too (offline open: outbox bubbles must show)", () => {
    const { reveal, gate } = harness();
    gate.socketClosed();
    expect(gate.revealed()).toBe(true);
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it("socket death after a normal reveal changes nothing", () => {
    const { reveal, gate } = harness();
    gate.claimSettlePin();
    gate.pinLanded();
    gate.socketClosed(); // a later drop mid-session
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it("both paths racing (socket dies during the decode wait) reveal exactly once", () => {
    const { reveal, gate } = harness();
    gate.claimSettlePin();
    gate.socketClosed();
    gate.pinLanded();
    expect(reveal).toHaveBeenCalledTimes(1);
  });
});

describe("reset — a rebuilt shell starts the whole dance over", () => {
  it("re-arms the claim and the reveal (re-login gets its own settled landing)", () => {
    const { reveal, gate } = harness();
    gate.claimSettlePin();
    gate.pinLanded();
    gate.reset();
    expect(gate.revealed()).toBe(false);
    expect(gate.claimSettlePin()).toBe(true); // the new shell owns a fresh pin
    gate.pinLanded();
    expect(reveal).toHaveBeenCalledTimes(2); // once per shell
  });
});
