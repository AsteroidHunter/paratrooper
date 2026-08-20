// Pins for the compose-bar resize decision (src/viewport.ts). The bug that
// motivated this: the bar growing a line shrank the thread, the browser held
// scrollTop, and the frame-late observer re-pin painted the slip first — the
// viewport bounce. The decision is synchronous so the wiring can adjust the
// thread between the height write and the same frame's paint.
import { describe, expect, it } from "vitest";
import { compensationFor, followFlipDecision, giveUpTarget } from "../src/viewport";

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

// The mid-typing shove doors and the kb-vv counter were retired with the
// vv-sized shell (shell.ts owns keyboard geometry; its close-time correction,
// heal, and growth-time shove decisions are pinned in shell.test.ts).
