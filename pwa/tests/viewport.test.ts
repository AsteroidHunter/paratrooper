// Pins for the compose-bar resize decision (src/viewport.ts). The bug that
// motivated this: the bar growing a line shrank the thread, the browser held
// scrollTop, and the frame-late observer re-pin painted the slip first — the
// viewport bounce. The decision is synchronous so the wiring can adjust the
// thread between the height write and the same frame's paint.
import { describe, expect, it } from "vitest";
import { compensationFor, followFlipDecision, shoveResponse } from "../src/viewport";

describe("compensationFor", () => {
  it("bar grows at the bottom -> pin-bottom (the last reply stays in view)", () => {
    expect(compensationFor(39, 61, true)).toBe("pin-bottom");
  });

  it("bar grows while reading history -> keep-position (scrollTop untouched)", () => {
    expect(compensationFor(39, 61, false)).toBe("keep-position");
  });

  it("bar shrinks at the bottom (send collapse) -> pin-bottom", () => {
    expect(compensationFor(120, 39, true)).toBe("pin-bottom");
  });

  it("bar shrinks while reading history -> keep-position", () => {
    expect(compensationFor(120, 39, false)).toBe("keep-position");
  });

  it("no height change -> none, wherever the user is", () => {
    expect(compensationFor(39, 39, true)).toBe("none");
    expect(compensationFor(39, 39, false)).toBe("none");
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

// The caret shove's second door: a visualViewport pan with no window scroll
// event. Only a pure pan that no keyboard mode owns gets countered.
describe("shoveResponse", () => {
  it("pure pan while the shell is not tracking -> snap", () => {
    expect(shoveResponse(false, 44, false)).toBe("snap");
    expect(shoveResponse(false, 362, false)).toBe("snap");
  });

  it("kb-vv owns the pan (shell translates with it) -> none", () => {
    expect(shoveResponse(true, 362, false)).toBe("none");
    expect(shoveResponse(true, 362, true)).toBe("none");
  });

  it("pan riding a height change is keyboard geometry in motion -> none", () => {
    expect(shoveResponse(false, 40, true)).toBe("none");
  });

  it("no pan -> nothing to counter", () => {
    expect(shoveResponse(false, 0, false)).toBe("none");
  });
});
