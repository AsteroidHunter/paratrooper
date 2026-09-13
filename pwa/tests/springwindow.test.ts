import { describe, expect, it } from "vitest";
import { profileFor } from "../src/springscroll";

describe("spring profile participation window", () => {
  it("keeps retained rows in place when an offscreen row leaves the window", () => {
    // The geometry, lag and content anchor have not changed. Advancing the
    // calculation window must not translate every row that stays visible.
    const rows = Array.from({ length: 50 }, (_, seq) => ({
      seq, top: seq * 114, height: 110,
    }));
    const before = profileFor(rows, 4, 20, 250, 106);
    const after = profileFor(rows, 5, 21, 250, 106);
    expect(before.get(10)).toBeDefined();
    expect(after.get(10)).toBeCloseTo(before.get(10)!, 8);
  });
});
