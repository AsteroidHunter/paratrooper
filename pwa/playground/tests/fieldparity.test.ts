// Two checks that the reuse is real reuse.
//
//   1. The three modules under src/vendor still carry the hashes the source
//      manifest recorded for the baseline they were copied from. The whole claim
//      that this playground runs the app's own mechanics rests on those bytes
//      not having drifted, so it is checked rather than asserted in prose.
//
//      REPOINTED WHEN THE PLAYGROUND MOVED INTO THE REPOSITORY. This check used
//      to read the same three files out of the tool's reference/pwa tree as
//      well and compare both sides against the manifest. That tree is a
//      snapshot beside the tool and did not move here, so the second read is
//      gone and the pins below are the whole check. The live app's own copies
//      are NOT the other side of it either: src/vendor is 0.3.151's field, kept
//      frozen because the picker offers it as that build, while pwa/src is
//      whatever the app ships today - the two have already parted (the 33 ms
//      trail and return went in after 0.3.151) and pinning a frozen copy to a
//      moving one would only break the next time the spring is tuned.
//   2. The ADAPTED field (src/springfield.ts) behaves exactly like the
//      untouched createSpringField when it is handed the baseline's numbers.
//      The adaptation is meant to be live tunables plus three read-only
//      accessors and nothing else; this drives both through the same gesture,
//      frame for frame, and compares everything either of them will say.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createSpringField } from "../src/vendor/springscroll";
import type { SpringRow } from "../src/vendor/springscroll";
import { createTunedSpringField, defaultFieldTunables } from "../src/springfield";
import { makeRows } from "./harness";

const FRAME = 1000 / 60;

describe("the copied modules are the baseline's own bytes", () => {
  // sha256 of the file's bytes, from the source manifest taken at commit
  // 4c865acad5a5685b1e2a9dbd319bfaa5e52205f9, where the app version was 0.3.151
  const EXPECTED: Record<string, string> = {
    "springscroll.ts": "793369f0430d607932454225c8cb7b1c861c49f49f63c892354a099a05a4b995",
    "endspring.ts": "b426e05fb9feb7053082efd18f128cdd259ea7d062cc82d0a6f51672745428fb",
    "runs.ts": "e1f5256bc1e285d3ac7305083b56aa6a06b3a688abf2a1ae86d37a94e003fc46",
  };

  for (const name of Object.keys(EXPECTED)) {
    it(`${name} is still the byte-for-byte copy the manifest recorded`, () => {
      const mine = readFileSync(new URL(`../src/vendor/${name}`, import.meta.url));
      expect(createHash("sha256").update(mine).digest("hex")).toBe(EXPECTED[name]);
    });
  }
});

describe("the adapted field is the baseline field", () => {
  /**
   * One gesture, driven into both fields in the same order the page drives
   * them: a drag, a braked stop, a lift, a coast, a catch and a reversal. Every
   * observable is compared on every frame.
   */
  function bothThrough(rows: readonly SpringRow[]): void {
    const base = createSpringField();
    const tuned = createTunedSpringField(() => defaultFieldTunables());
    base.measure(rows);
    tuned.measure(rows);

    let t = 0;
    let s = 3000;
    const both = (fn: (f: typeof base) => void): void => {
      fn(base);
      fn(tuned as unknown as typeof base);
    };
    const step = (ds: number, finger?: number): void => {
      t += FRAME;
      s += ds;
      if (finger !== undefined) both((f) => f.anchor(finger));
      both((f) => f.frame(t, s));
      expect(tuned.lag()).toBe(base.lag());
      expect(tuned.phase()).toBe(base.phase());
      expect(tuned.armed()).toBe(base.armed());
      expect(tuned.active()).toBe(base.active());
      expect([...tuned.displacements()].sort()).toEqual([...base.displacements()].sort());
    };

    both((f) => f.begin(844, 0, 700, true));
    step(0, 700);
    let finger = 700;
    for (let i = 0; i < 18; i++) {
      finger -= 25;
      step(25, finger);
    }
    for (let i = 0; i < 12; i++) step(0, finger); // the braked stop
    both((f) => f.lift());
    for (let i = 0; i < 10; i++) step(14); // a coast
    both((f) => f.begin(844, 0, 420, true)); // a finger catches it
    for (let i = 0; i < 10; i++) step(0, 420);
    for (let i = 0; i < 14; i++) {
      finger = 420 + i * 22;
      step(-22, finger); // and drags the other way
    }
    both((f) => f.reseat(900)); // a page of older messages goes in above
    for (let i = 0; i < 6; i++) step(0, finger);
    for (let i = 0; i < 40; i++) step(0); // home
    expect(base.phase()).toBe("idle");
    expect(tuned.phase()).toBe("idle");
  }

  it("frame for frame, through a drag, a stop, a coast, a catch and a reversal", () => {
    bothThrough(makeRows(140));
  });

  it("and on a thread of uniform rows, where every pair is tight", () => {
    const rows: SpringRow[] = [];
    for (let i = 0; i < 90; i++) rows.push({ top: i * 46, height: 42 });
    bothThrough(rows);
  });

  it("a wheel gesture, which has no finger at all, agrees too", () => {
    const rows = makeRows(140);
    const base = createSpringField();
    const tuned = createTunedSpringField(() => defaultFieldTunables());
    base.measure(rows);
    tuned.measure(rows);
    base.begin(844, 0, null, false);
    tuned.begin(844, 0, null, false);
    let t = 0;
    let s = 3000;
    for (let i = 0; i < 60; i++) {
      t += FRAME;
      s += i < 24 ? 30 : 0;
      base.frame(t, s);
      tuned.frame(t, s);
      expect(tuned.lag()).toBe(base.lag());
      expect([...tuned.displacements()]).toEqual([...base.displacements()]);
    }
  });

  it("the added accessors only read: asking them changes nothing", () => {
    const rows = makeRows(140);
    const tuned = createTunedSpringField(() => defaultFieldTunables());
    tuned.measure(rows);
    tuned.begin(844, 0, 700, true);
    let t = 0;
    let s = 3000;
    for (let i = 0; i < 10; i++) {
      t += FRAME;
      s += 25;
      tuned.frame(t, s);
    }
    const lag = tuned.lag();
    const before = [...tuned.displacements()];
    for (let i = 0; i < 20; i++) {
      tuned.vertex();
      tuned.window();
      tuned.rowTable();
      tuned.scrollAt();
      tuned.viewport();
    }
    expect(tuned.lag()).toBe(lag);
    expect([...tuned.displacements()]).toEqual(before);
  });

  it("the vertex it reports is the one the profile is actually built on", () => {
    // the accessor exists so the travelling settle can use the SAME apex the
    // baseline profile uses; if it drifted, the two modes would disagree about
    // where the finger is
    const rows = makeRows(140);
    const tuned = createTunedSpringField(() => defaultFieldTunables());
    tuned.measure(rows);
    tuned.begin(844, 0, 600, true);
    tuned.frame(FRAME, 3000);
    // the gesture's first frame seats the vertex on the content under the finger
    expect(tuned.vertex()).toBeCloseTo(3000 + 600, 9);
    // and it rides the thread from there: the scroll moves, the vertex does not
    tuned.frame(2 * FRAME, 3400);
    expect(tuned.vertex()).toBeCloseTo(3600, 9);
    // a pinned insert above the viewport carries it across the jump
    tuned.reseat(500);
    expect(tuned.vertex()).toBeCloseTo(4100, 9);
  });
});
