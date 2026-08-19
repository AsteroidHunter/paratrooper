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

describe("tailPending — the commit-fallback's guard on the probe", () => {
  it("pending until the probe answers, then closed", () => {
    const gate = createBootGate();
    expect(gate.tailPending()).toBe(true);
    gate.tailKnown(50);
    expect(gate.tailPending()).toBe(false);
    expect(gate.tailPending()).toBe(false); // stays closed: a timeout firing late is a no-op
  });

  it("an empty backlog still counts as answered (tail 0 is an answer)", () => {
    const gate = createBootGate();
    gate.tailKnown(0);
    expect(gate.tailPending()).toBe(false);
  });

  it("reconnect and reset re-open it: each socket's probe stands alone", () => {
    const gate = createBootGate();
    gate.tailKnown(50);
    gate.reconnect();
    expect(gate.tailPending()).toBe(true);
    gate.tailKnown(80);
    gate.reset();
    expect(gate.tailPending()).toBe(true);
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
    // the window spans the buffering branch that now sits between the two
    expect(main).toMatch(/isReplay\(m\.seq\)[\s\S]{0,800}suppressAnim = false/);
  });

  it("a straggler that lost the tail inserts with the same-frame bottom pin", () => {
    expect(main).toMatch(
      /function applyReplay[\s\S]{0,900}scrollTop = prevScroll \+ \(t\.scrollHeight - prevHeight\)/,
    );
  });
});

// The catch-up streams into a buffer and lands as ONE task on the caughtUp
// edge — the browser may paint between socket tasks, so per-frame applies are
// a visible movie by definition. Source pins hold the wiring the way the
// veil/timer pins above do.
describe("wiring — replay batching: buffer while streaming, one commit at the edge", () => {
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

  it("an unsettled replay frame buffers; only a post-settle straggler applies per-frame", () => {
    expect(main).toMatch(
      /isReplay\(m\.seq\)[\s\S]{0,200}settled\(\)[\s\S]{0,100}applyReplay\(m\)[\s\S]{0,600}replayBuffer\.push\(m\)/,
    );
  });

  it("the caught-up cursor counts buffered frames, not just applied ones", () => {
    expect(main).toMatch(/caughtUp\(Math\.max\(lastSeq, replayBufferMax\)\)/);
  });

  it("the edge commits the whole buffer BEFORE animations come on, then settles", () => {
    const settle = main.indexOf("function replaySettle");
    const body = main.slice(settle, main.indexOf("\n}", settle));
    expect(body.indexOf("commitReplayBuffer()")).toBeGreaterThan(-1);
    expect(body.indexOf("commitReplayBuffer()")).toBeLessThan(body.indexOf("suppressAnim = false"));
    expect(body).toContain("bootSettlePin()");
    expect(body).toContain("reconcileRetracts()");
  });

  it("the commit is one seq-ordered pass through the silent replay path, recorded", () => {
    const commit = main.indexOf("function commitReplayBuffer");
    const body = main.slice(commit, main.indexOf("\n}", commit));
    expect(body).toMatch(/frames\.sort/);
    expect(body).toContain("applyReplay(m)");
    expect(body).toMatch(/holdDiagRecord\("batch-commit", \{ n: frames\.length \}\)/);
  });

  it("a hung probe cannot strand the buffer: the fallback closes the ledger", () => {
    expect(main).toMatch(
      /probeFallback = setTimeout[\s\S]{0,300}tailPending\(\)[\s\S]{0,200}tailKnown\(Math\.max\(lastSeq, replayBufferMax\)\)/,
    );
    // and a probe that answered keeps its ceiling: the guard returns first
    expect(main).toMatch(/if \(!bootGate\.tailPending\(\)\) return/);
  });

  it("a failed probe closes at whatever arrived, buffered frames included", () => {
    expect(main).toMatch(
      /function probeReplayTail[\s\S]{0,900}catch[\s\S]{0,120}Math\.max\(lastSeq, replayBufferMax\)/,
    );
  });

  it("a hold release re-checks the edge: the last uncovered frame may be parked", () => {
    expect(main).toMatch(/createReplyHold<ServerMsg>[\s\S]{0,300}replaySettle\(\)/);
  });

  it("each socket starts with an empty buffer and a fresh fallback clock", () => {
    const connect = main.indexOf("function connect(");
    const body = main.slice(connect, main.indexOf("\n}", connect));
    expect(body).toContain("replayBuffer = []");
    expect(body).toContain("replayBufferMax = 0");
    expect(body).toMatch(/clearTimeout\(probeFallback\)/);
  });
});

// After the settle, one cheap look at the server's newest page drops any
// stored seq inside that page's span the server no longer has — a take-back
// that happened while the app was closed never sent its retract frame, and
// the cached reply must not survive on screen.
describe("wiring — offline-retract reconcile after the settle", () => {
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const start = main.indexOf("async function reconcileRetracts");
  const body = main.slice(start, main.indexOf("\n}", start));

  it("one newest-page fetch, bounded to the page's own seq span", () => {
    expect(start).toBeGreaterThan(-1);
    expect(body).toMatch(/api\/history\/\$\{THREAD_ID\}\?before=\$\{Number\.MAX_SAFE_INTEGER\}/);
    expect(body).toMatch(/s >= lo && s <= hi && !present\.has\(s\)/);
  });

  it("drops ride the live take-back path and the trail names the seqs", () => {
    expect(body).toMatch(/holdDiagRecord\("reconcile-drop", \{ seqs: dropped \}\)/);
    expect(body).toContain("applyRetract(s)");
  });

  it("an empty or failed page drops nothing (reconcile is best-effort)", () => {
    expect(body).toMatch(/catch[\s\S]{0,120}return/);
    expect(body).toMatch(/if \(!present\.size\) return/);
  });
});
