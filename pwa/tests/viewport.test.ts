// Pins for the compose-bar resize decision (src/viewport.ts). The bug that
// motivated this: the bar growing a line shrank the thread, the browser held
// scrollTop, and the frame-late observer re-pin painted the slip first — the
// viewport bounce. The decision is synchronous so the wiring can adjust the
// thread between the height write and the same frame's paint.
import { describe, expect, it } from "vitest";
import { compensationFor } from "../src/viewport";

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
