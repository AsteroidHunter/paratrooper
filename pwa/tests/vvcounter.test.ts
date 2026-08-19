// Pins for the kb-vv keyboard-mode counter (the typing-view creep). The
// deploy logs showed the failure exactly: kb-vv active, iOS window-shoving
// y 45-52 over and over, the shipped vv door standing aside by design, the
// view creeping up line by line. The decision half (viewport.ts) is pure and
// tested directly; the main.ts wiring — the window door routing, the vvGuard
// session bookkeeping, the autosize same-frame preempt, the settle arm — is
// source-pinned because main.ts boots a real shell at import. Keyboard
// geometry itself cannot be reproduced headlessly; the real test is the
// owner's phone reading vv-counter records back from the deploy logs.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RESHOVE_WINDOW_MS,
  SESSION_COUNTER_CAP,
  kbvvCounterDecision,
} from "../src/viewport";

const QUIET = RESHOVE_WINDOW_MS * 10; // comfortably outside the re-shove window

describe("kbvvCounterDecision — when the counter fights, yields, or stands down", () => {
  it("does nothing unfocused, whatever the displacement", () => {
    expect(kbvvCounterDecision(false, false, 48, 45, 0, QUIET, 0)).toBe("none");
  });

  it("does nothing while keyboard geometry is in motion (height changed)", () => {
    expect(kbvvCounterDecision(true, true, 48, 45, 0, QUIET, 0)).toBe("none");
  });

  it("does nothing with no displacement on the books", () => {
    expect(kbvvCounterDecision(true, false, 0, 0, 0, QUIET, 0)).toBe("none");
  });

  it("snaps the logged shove: window y ~48 over a zero pan baseline", () => {
    expect(kbvvCounterDecision(true, false, 48, 0, 0, QUIET, 0)).toBe("snap");
  });

  it("snaps a pan drifting off a ZERO baseline (the overlay-mode creep)", () => {
    expect(kbvvCounterDecision(true, false, 0, 45, 0, QUIET, 0)).toBe("snap");
  });

  it("ignores sub-pixel pan noise", () => {
    expect(kbvvCounterDecision(true, false, 0, 1, 0, QUIET, 0)).toBe("none");
  });

  it("never fights a nonzero-baseline pan: that is the keyboard's own math", () => {
    // shrink-AND-pan parks the page at ~362 (2026-07-30); clearing it would
    // just make iOS re-assert it — the guaranteed loop
    expect(kbvvCounterDecision(true, false, 0, 362, 362, QUIET, 0)).toBe("none");
    expect(kbvvCounterDecision(true, false, 0, 500, 362, QUIET, 0)).toBe("none");
  });

  it("a window scroll is displacement in every mode, nonzero baseline included", () => {
    expect(kbvvCounterDecision(true, false, 48, 362, 362, QUIET, 0)).toBe("snap");
  });

  it("yields inside the re-shove window: fighting frame-for-frame IS the loop", () => {
    expect(kbvvCounterDecision(true, false, 48, 0, 0, RESHOVE_WINDOW_MS - 1, 1)).toBe("yield");
  });

  it("snaps again once the window has passed", () => {
    expect(kbvvCounterDecision(true, false, 48, 0, 0, RESHOVE_WINDOW_MS + 1, 1)).toBe("snap");
  });

  it("goes dormant past the session cap, however quiet it has been", () => {
    expect(kbvvCounterDecision(true, false, 48, 0, 0, QUIET, SESSION_COUNTER_CAP))
      .toBe("dormant");
    // and the cap outranks the rate limit
    expect(kbvvCounterDecision(true, false, 48, 0, 0, 100, SESSION_COUNTER_CAP + 1))
      .toBe("dormant");
  });
});

// --- main.ts wiring pins (source-read, like flight.test.ts) -------------------

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/main.ts"), "utf8");
const holdSrc = readFileSync(join(here, "../src/hold.ts"), "utf8");

function fnBody(name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("\n}", start);
  return src.slice(start, end);
}

describe("window door — kb-vv no longer takes the unconditional snap", () => {
  it("routes kb-vv through the counter and keeps the plain snap elsewhere", () => {
    const door = src.indexOf('door: "window"');
    const route = src.indexOf('runVvCounter("window")');
    expect(route).toBeGreaterThan(-1);
    expect(route).toBeLessThan(door); // the kb-vv branch exits before the snap
    expect(src.slice(route, door)).toContain("return");
  });
});

describe("vvGuard — session bookkeeping and the tracked-mode counter", () => {
  it("resets the session when kb-vv is absent and re-latches the baseline on height changes", () => {
    const guard = src.indexOf("const vvGuard");
    const reset = src.indexOf("vvCounterSessionReset()", guard);
    const latch = src.indexOf("vvPanBaseline = Math.round(vv.offsetTop)", guard);
    expect(reset).toBeGreaterThan(guard);
    expect(latch).toBeGreaterThan(guard);
  });

  it("runs the counter when tracking — the stand-aside is over", () => {
    const guard = src.indexOf("const vvGuard");
    const run = src.indexOf("if (tracking) runVvCounter(", guard);
    expect(run).toBeGreaterThan(guard);
  });
});

describe("autosize preempt — the cause, same frame", () => {
  const body = fnBody("autosize");

  it("after a height change under kb-vv it reconciles the shell then counters", () => {
    const write = body.indexOf("textEl.style.height =");
    const rec = body.indexOf("reconcile()");
    const run = body.indexOf('runVvCounter("autosize", true)');
    expect(write).toBeGreaterThan(-1);
    expect(rec).toBeGreaterThan(write); // the resync follows the height write
    expect(run).toBeGreaterThan(rec); // and the counter runs on fresh geometry
    expect(body).toContain('classList.contains("kb-vv")');
  });
});

describe("runVvCounter — acts, records, and the settle arm", () => {
  const body = fnBody("runVvCounter");

  it("records a vv-counter with the displacement it saw", () => {
    expect(body).toContain('holdDiagRecord("vv-counter"');
    expect(body).toMatch(/trigger, act, y: wy, top: pan, base: vvPanBaseline, spill/);
  });

  it("snap is the shell's own leave-write, counted against the session cap", () => {
    const snap = body.indexOf('if (act === "snap")');
    const after = body.slice(snap);
    expect(after).toContain("window.scrollTo(0, 0)");
    expect(after).toContain("vvCounterActs++");
  });

  it("yield arms one trailing settle, and the settle re-runs the counter", () => {
    expect(body).toContain("armVvSettle()");
    expect(fnBody("armVvSettle")).toContain('runVvCounter("settle", true)');
  });
});

describe("trail plumbing — vv-counter posts like every other mark", () => {
  it("hold.ts diagPost triggers include vv-counter", () => {
    const trigger = holdSrc.indexOf('ev === "vv-counter"');
    const post = holdSrc.indexOf("diagPost()", trigger);
    expect(trigger).toBeGreaterThan(-1);
    expect(post).toBeGreaterThan(trigger);
  });
});
