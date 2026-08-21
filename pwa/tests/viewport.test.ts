// Pins for the compose-bar resize decision (src/viewport.ts). The bug that
// motivated this: the bar growing a line shrank the thread, the browser held
// scrollTop, and the frame-late observer re-pin painted the slip first — the
// viewport bounce. The decision is synchronous so the wiring can adjust the
// thread between the height write and the same frame's paint.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAUSE_MS, createDownButton } from "../src/downbtn";
import {
  NEAR_BOTTOM_PX,
  compensationFor,
  flightOverflow,
  followFlipDecision,
  giveUpTarget,
  nearBottomOf,
} from "../src/viewport";

describe("compensationFor", () => {
  it("bar grows at the bottom -> pin-bottom (the last reply stays in view)", () => {
    expect(compensationFor(39, 61, true)).toBe("pin-bottom");
  });

  it("bar grows while reading history -> give-up (the box must not eat the last line)", () => {
    expect(compensationFor(39, 61, false)).toBe("give-up");
  });

  it("bar shrinks at the bottom (send collapse) -> pin-bottom", () => {
    expect(compensationFor(120, 39, true)).toBe("pin-bottom");
  });

  it("bar shrinks while reading history -> keep-position (nothing was covered)", () => {
    expect(compensationFor(120, 39, false)).toBe("keep-position");
  });

  it("no height change -> none, wherever the user is", () => {
    expect(compensationFor(39, 39, true)).toBe("none");
    expect(compensationFor(39, 39, false)).toBe("none");
  });
});

// His second report: "the growing box eats the previously sent message". The
// thread's box shrinks from the BOTTOM by whatever the bar gained, so the
// thread has to hand back exactly that many pixels of scroll or the line that
// sat on that edge is clipped away under the bar.
describe("giveUpTarget: the thread gives up exactly the height the box gains", () => {
  it("one grown line: the thread scrolls down by exactly that many pixels", () => {
    expect(giveUpTarget(400, 39, 62, 900)).toBe(423); // 62 - 39 = 23
  });

  it("at the tail the give-up IS the bottom pin: same landing, no overshoot", () => {
    // sitting exactly at the old bottom (max 500); the bar grows 23, so the
    // shrunken box raises the max to 523 and both arms want 523
    const grown = 62 - 39;
    expect(giveUpTarget(500, 39, 62, 500 + grown)).toBe(523);
  });

  it("the cap frame (fifth line, 108 -> 120) gives up the partial 12px it really gained", () => {
    expect(giveUpTarget(300, 108, 120, 900)).toBe(312);
  });

  it("never past the thread's own range", () => {
    expect(giveUpTarget(890, 39, 62, 900)).toBe(900);
    expect(giveUpTarget(10, 120, 39, 900)).toBe(0);
  });

  it("no growth, no movement", () => {
    expect(giveUpTarget(400, 62, 62, 900)).toBe(400);
  });
});

// The device slip: shove/pin scroll events read "away", followTail flipped
// false, and every later growth line picked keep-position — compounding until
// a three-line message sat fully hidden. While composing, only a genuine
// gesture may turn following off.
describe("followFlipDecision", () => {
  it("at the bottom -> follow, regardless of focus or gesture", () => {
    expect(followFlipDecision(true, true, false)).toBe("follow");
    expect(followFlipDecision(true, false, false)).toBe("follow");
    expect(followFlipDecision(true, true, true)).toBe("follow");
  });

  it("away without composer focus -> unfollow (the shipped rule, untouched)", () => {
    expect(followFlipDecision(false, false, false)).toBe("unfollow");
    expect(followFlipDecision(false, false, true)).toBe("unfollow");
  });

  it("away while composing with a real gesture -> unfollow (reading history)", () => {
    expect(followFlipDecision(false, true, true)).toBe("unfollow");
  });

  it("away while composing with NO gesture -> hold: a shove or our own pin", () => {
    expect(followFlipDecision(false, true, false)).toBe("hold");
  });
});

// --- the at-bottom verdict under a send flight --------------------------------
// The chevron appearing right after a send, which he then had to tap away. The
// fresh bubble is translated DOWN to the compose field and released, CSS counts
// transformed overflow as scrollable area, and so scrollHeight carries the part
// of that translate hanging past the thread's own bottom padding for the whole
// beat. Nothing subtracted it where the verdict was read, so a reader sitting
// exactly on the bottom was told he was hundreds of pixels above it.
//
// The stand-in below is the load-bearing part: a thread pinned to its TRUE
// bottom (send() pins before it launches anything) whose scrollHeight then
// carries the flight's tax. Without it these tests would pass either way.

const PAD_B = 8; // the thread's own bottom padding
const CLIENT = 620; // the thread box on a phone with the keyboard down
const CONTENT = 4000; // everything laid out inside it

function pinnedThreadFlying(translateY: number): {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
  overflow: number;
} {
  const overflow = flightOverflow(translateY, PAD_B);
  return {
    scrollTop: CONTENT - CLIENT, // send() pinned here before the launch
    clientHeight: CLIENT,
    scrollHeight: CONTENT + overflow, // and the flight inflated it afterwards
    overflow,
  };
}

// his six sends today, by the bubble's measured travel
const FLIPPED = [575.1, 362.5, 362.3, 213.3]; // follow went off within ~30ms
const HELD = [135.8, 63.3]; // these two never did

describe("flightOverflow: what the flying bubble adds to the thread's height", () => {
  it("is the translate past the thread's own bottom padding", () => {
    expect(flightOverflow(575.1, PAD_B)).toBeCloseTo(567.1, 10);
    expect(flightOverflow(213.3, PAD_B)).toBeCloseTo(205.3, 10);
  });

  it("is never negative: a bubble still inside the padding taxes nothing", () => {
    expect(flightOverflow(4, PAD_B)).toBe(0);
    expect(flightOverflow(0, PAD_B)).toBe(0); // the landed frame
  });
});

describe("nearBottomOf: a flight in the air cannot move the bottom", () => {
  it("the window stays at 150 — his travel reached 575, and widening retires the chevron", () => {
    expect(NEAR_BOTTOM_PX).toBe(150);
  });

  it("without the subtraction, his four long sends read as away from the bottom", () => {
    for (const dy of FLIPPED) {
      const t = pinnedThreadFlying(dy);
      expect(nearBottomOf(t.scrollHeight, t.scrollTop, t.clientHeight)).toBe(false);
    }
  });

  it("without it his two short ones still read at the bottom — the threshold, exactly", () => {
    for (const dy of HELD) {
      const t = pinnedThreadFlying(dy);
      expect(nearBottomOf(t.scrollHeight, t.scrollTop, t.clientHeight)).toBe(true);
    }
  });

  it("with it, all six read at the bottom, because that is where he was sitting", () => {
    for (const dy of [...FLIPPED, ...HELD]) {
      const t = pinnedThreadFlying(dy);
      expect(nearBottomOf(t.scrollHeight, t.scrollTop, t.clientHeight, t.overflow)).toBe(true);
    }
  });

  it("a reader who really does scroll away mid-flight still reads away", () => {
    // the subtraction must not pin the answer to true: this is the whole reason
    // the verdict stays a live measurement instead of a held pre-flight one
    const t = pinnedThreadFlying(575.1);
    expect(nearBottomOf(t.scrollHeight, t.scrollTop - 400, t.clientHeight, t.overflow)).toBe(false);
  });

  it("with no flight up it is the plain reading it always was", () => {
    expect(nearBottomOf(4000, 3380, 620)).toBe(true);
    expect(nearBottomOf(4000, 3230, 620)).toBe(false); // 150 out, on the nose
    expect(nearBottomOf(4000, 3231, 620)).toBe(true);
  });
});

// The harm, end to end: verdict -> follow flip -> chevron. The keyboard is DOWN
// on these sends (the chevron is gated shut while it is up, so its appearing at
// all says so), which means the composer is unfocused and an away reading needs
// no gesture to turn following off.
describe("the chevron right after a send", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function chevronAfter(atBottom: boolean): boolean {
    let shown = false;
    const btn = createDownButton((v) => {
      shown = v;
    });
    const flip = followFlipDecision(atBottom, false, false);
    btn.scrolled(flip === "follow");
    vi.advanceTimersByTime(PAUSE_MS + 50); // he sits still, as he does after sending
    return shown;
  }

  it("the inflated reading unfollows and surfaces the chevron over a reader who never moved", () => {
    const t = pinnedThreadFlying(575.1);
    const raw = nearBottomOf(t.scrollHeight, t.scrollTop, t.clientHeight);
    expect(followFlipDecision(raw, false, false)).toBe("unfollow");
    expect(chevronAfter(raw)).toBe(true);
  });

  it("the subtracted reading keeps following on and the chevron down", () => {
    const t = pinnedThreadFlying(575.1);
    const fixed = nearBottomOf(t.scrollHeight, t.scrollTop, t.clientHeight, t.overflow);
    expect(followFlipDecision(fixed, false, false)).toBe("follow");
    expect(chevronAfter(fixed)).toBe(false);
  });
});

// --- source pins on the main.ts wiring ----------------------------------------

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/main.ts"),
  "utf8",
);

// read inside each test, never at describe level: a pin for a function that does
// not exist yet must fail as its own test, not take the whole file down with it
function fnBody(name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("\n}", start);
  return src.slice(start, end);
}

describe("at-bottom wiring: the reading site subtracts what the flight adds", () => {
  it("nearBottom goes through the shared verdict with the flight handed in", () => {
    const body = fnBody("nearBottom");
    expect(body).toContain(
      "nearBottomOf(t.scrollHeight, t.scrollTop, t.clientHeight, flightInflation(t))",
    );
    expect(body).not.toContain("150"); // the window is viewport.ts's to name
  });

  it("the inflation is read off the live transforms, the recorder's own way", () => {
    const body = fnBody("flightInflation");
    expect(body).toContain("new DOMMatrixReadOnly(tr).f");
    expect(body).toContain("paddingBottom");
    expect(body).toContain("flightOverflow(");
    expect(body).toContain("if (airborneRows.size === 0) return 0"); // nothing flying, nothing read
  });

  it("every flying row registers, and every way a flight can end takes it back off", () => {
    const fly = fnBody("flyFromField");
    expect(fly).toContain("airborneRows.add(msg)");
    expect(fly.indexOf("airborneRows.add(msg)")).toBeLessThan(fly.indexOf("anim.finished"));
    expect(fly.match(/airborneRows\.delete\(msg\)/g)).toHaveLength(2); // finish AND cancel
  });

  it("the bar-morph registers nothing: its shell is fixed and inflates no height", () => {
    expect(fnBody("armFieldMorph")).not.toContain("airborneRows");
  });

  it("a fresh shell forgets rows belonging to a thread that is gone", () => {
    expect(src).toContain("airborneRows.clear()");
  });

  it("the chevron is still fed followTail, not a second fresh reading", () => {
    // feeding downBtn its own nearBottom() would mask this symptom and leave the
    // inflated reading to bite somewhere else
    expect(src).toContain("downBtn.scrolled(followTail)");
  });
});

// The mid-typing shove doors and the kb-vv counter were retired with the
// vv-sized shell (shell.ts owns keyboard geometry; its close-time correction,
// heal, and growth-time shove decisions are pinned in shell.test.ts).
