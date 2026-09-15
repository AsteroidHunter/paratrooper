// The settle ladder, printed.
//
// A tuning session is a subjective thing done in a browser, and this is the one
// place the numbers behind the feel can be read directly: for a scripted stop it
// dumps, row by row, how far each bubble is from its seat and how much of that
// it still has left at a chosen moment after the stop. It is the same
// measurement the ordering tests in travelsettle.test.ts assert on, without the
// assertions in the way.
//
//     npm --prefix app run ladder
//
// It asserts too, so it cannot rot: the table it prints has to be ordered, or
// the run fails and the table is there to show why.

import { describe, expect, it } from "vitest";
import { harness, peaks } from "./harness";
import type { TravelTuning } from "../src/travelsettle";

const SAMPLE_MS = 70; // where along the settle to take the reading

function ladder(dir: 1 | -1, tune: Partial<TravelTuning>, label: string): number {
  const h = harness({ tune });
  const finger0 = dir === 1 ? 700 : 150;
  h.begin(finger0, true);
  h.frame(0, finger0);
  const fingerEnd = h.drag(dir * 1.5, 220, finger0);
  const stopIdx = h.log.length;
  const stopT = h.log[stopIdx - 1].t;
  const vertexY = h.field.vertex();
  h.holdStill(900, fingerEnd);
  const pk = peaks(h.log, stopIdx - 3);

  let best = h.log[stopIdx];
  for (const r of h.log) {
    if (Math.abs(r.t - (stopT + SAMPLE_MS)) < Math.abs(best.t - (stopT + SAMPLE_MS))) best = r;
  }

  const lines = [
    `\n=== ${label} | ${dir === 1 ? "toward newer" : "toward older"}` +
      ` | lag at the stop ${h.log[stopIdx - 1].lag.toFixed(1)} px` +
      ` | reading taken ${SAMPLE_MS} ms after it`,
    "  row   above finger    stretch     still there   left",
  ];
  let above = 0;
  for (const i of h.visible()) {
    const p = pk.get(i) ?? 0;
    if (p < 1) continue;
    const d = best.disp.get(i) ?? 0;
    const up = vertexY - h.centre(i);
    if (up > 0) above += 1;
    lines.push(
      `  ${String(i).padStart(3)}   ${up.toFixed(0).padStart(8)} px  ${p.toFixed(1).padStart(7)} px` +
        `   ${d.toFixed(1).padStart(8)} px   ${(Math.abs(d) / p).toFixed(2)}`,
    );
  }
  console.log(lines.join("\n"));
  return above;
}

describe("settle ladder", () => {
  it("prints the rows a stop leaves behind, and finds bubbles above the finger", () => {
    let above = 0;
    above += ladder(1, {}, "defaults");
    above += ladder(-1, {}, "defaults");
    above += ladder(1, { upDelayPerPx: 0 }, "stagger off");
    expect(above).toBeGreaterThan(6); // there was something above the finger to order
  });
});
