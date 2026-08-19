// Pins for the boot-replay ledger (src/bootgate.ts): the honest replay
// marker. The connect-time backlog — every frame at or below the server's
// newest seq when the socket opened — never animates, no matter how late it
// arrives; only frames above that ceiling are genuinely new. One settle-pin
// claim per shell keeps reconnect settles from yanking a reader; reset()
// re-arms everything for a rebuilt shell (re-login).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createBootGate } from "../src/bootgate";

describe("the settle pin is claimed exactly once per shell", () => {
  it("first settle claims the pin; every later settle is turned away", () => {
    const gate = createBootGate();
    expect(gate.claimSettlePin()).toBe(true);
    expect(gate.claimSettlePin()).toBe(false); // reconnect settle: no re-pin
    expect(gate.claimSettlePin()).toBe(false);
  });
});

describe("replay classification — the connect-time backlog never animates", () => {
  it("before the probe answers, every frame is replay (stillness is the safe default)", () => {
    const gate = createBootGate();
    expect(gate.isReplay(1)).toBe(true);
    expect(gate.isReplay(9999)).toBe(true);
  });

  it("after the probe: at or below the connect tail is replay, above is live", () => {
    const gate = createBootGate();
    gate.tailKnown(50);
    expect(gate.isReplay(3)).toBe(true);
    expect(gate.isReplay(50)).toBe(true); // the ceiling itself is backlog
    expect(gate.isReplay(51)).toBe(false); // genuinely new: animates
  });

  it("late stragglers stay replay forever — arrival time never enters it", () => {
    const gate = createBootGate();
    gate.tailKnown(50);
    gate.caughtUp(51); // the boot settled long ago
    expect(gate.isReplay(31)).toBe(true); // a backlog frame limping in after settle
    expect(gate.isReplay(52)).toBe(false); // while new frames still animate
  });

  it("an empty backlog (tail 0) marks every frame live", () => {
    const gate = createBootGate();
    gate.tailKnown(0);
    expect(gate.isReplay(1)).toBe(false);
  });
});

describe("caught up — animations come on exactly once per socket", () => {
  it("never before the probe answers, however many frames applied", () => {
    const gate = createBootGate();
    expect(gate.caughtUp(500)).toBe(false); // ceiling unknown: still replaying
    expect(gate.settled()).toBe(false);
  });

  it("latches on the apply that covers the tail; repeats stay silent", () => {
    const gate = createBootGate();
    gate.tailKnown(24);
    expect(gate.caughtUp(23)).toBe(false); // one frame short
    expect(gate.caughtUp(24)).toBe(true); // the backlog is fully in
    expect(gate.caughtUp(25)).toBe(false); // the edge fires once
    expect(gate.settled()).toBe(true);
  });

  it("an empty thread settles the moment the probe answers", () => {
    const gate = createBootGate();
    gate.tailKnown(0);
    expect(gate.caughtUp(0)).toBe(true); // nothing to wait for
  });

  it("a live frame overtaking a straggler settles too — the tail is covered", () => {
    const gate = createBootGate();
    gate.tailKnown(50);
    expect(gate.caughtUp(51)).toBe(true); // a live frame carried the cursor past it
    expect(gate.isReplay(31)).toBe(true); // the straggler still applies as replay
  });
});

describe("reconnect — a new socket gets a fresh backlog", () => {
  it("re-arms classification and the latch, keeps the shell's pin claim spent", () => {
    const gate = createBootGate();
    gate.tailKnown(50);
    expect(gate.caughtUp(50)).toBe(true);
    expect(gate.claimSettlePin()).toBe(true);
    gate.reconnect();
    expect(gate.isReplay(70)).toBe(true); // ceiling unknown again: replay by default
    gate.tailKnown(80);
    expect(gate.caughtUp(80)).toBe(true); // a fresh latch for the new socket
    expect(gate.claimSettlePin()).toBe(false); // but this shell's pin stays spent
  });
});

describe("reset — a rebuilt shell starts the whole dance over", () => {
  it("re-arms the pin claim and the ledger (re-login gets its own settled landing)", () => {
    const gate = createBootGate();
    gate.tailKnown(10);
    gate.caughtUp(10);
    gate.claimSettlePin();
    gate.reset();
    expect(gate.settled()).toBe(false);
    expect(gate.isReplay(999)).toBe(true); // the new socket's backlog is unknown
    expect(gate.claimSettlePin()).toBe(true); // the new shell owns a fresh pin
  });
});

// The veil is gone and the wiring hangs off the ledger, not a clock — cheap
// source tripwires for exactly what the device test complained about.
describe("wiring — no veil, no quiet timer (main.ts / styles.css)", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

  it("the fake white screen is gone: no .booting veil anywhere", () => {
    expect(css).not.toContain("booting");
    expect(main).not.toContain("booting");
  });

  it("no wall-clock settle: the marker is probed, classified, and latched", () => {
    expect(main).not.toContain("settleAnim");
    expect(main).toContain("probeReplayTail");
    expect(main).toMatch(/isReplay\(m\.seq\)/);
  });

  it("replay applies force stillness; a genuinely new frame flips animations on", () => {
    expect(main).toMatch(/function applyReplay[\s\S]{0,700}suppressAnim = true/);
    expect(main).toMatch(/isReplay\(m\.seq\)[\s\S]{0,400}suppressAnim = false/);
  });

  it("a straggler that lost the tail inserts with the same-frame bottom pin", () => {
    expect(main).toMatch(
      /function applyReplay[\s\S]{0,900}scrollTop = prevScroll \+ \(t\.scrollHeight - prevHeight\)/,
    );
  });
});
