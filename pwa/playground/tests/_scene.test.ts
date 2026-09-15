// The SCENE probe: what a reader actually sees, printed.
//
// _probe.test.ts prints the ordering ladder - how much of each row's stretch is
// left at one instant - which is the right table for asking "did the near row go
// first". It is the wrong table for asking "can any of this be seen", because it
// normalises each row by its own peak: a row that peaked at 0.5 px and a row that
// peaked at 12 px both read "0.4 left".
//
// This one keeps the pixels. For a scripted stop it prints, per visible row, the
// stretch at the stop in BOTH modes, and splits the scene into the part every row
// shares (a bulk slide of the whole band, which reads as nothing at all because
// the reader has no fixed reference) and the part that differs row to row (the
// gaps opening and closing, which is the only thing that can be seen).
//
//     npm --prefix app run scene
//
// It asserts nothing about which design is better. It is a measuring stick.

import { describe, expect, it } from "vitest";
import { harness } from "./harness";
import type { Reading } from "./harness";
import type { TravelTuning } from "../src/travelsettle";

function pick(r: Reading, mode: "base" | "trav"): Map<number, number> {
  return mode === "base" ? r.base : r.disp;
}

function scene(vals: number[]): { peak: number; mean: number; rel: number; spread: number } {
  const n = vals.length || 1;
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  const rel = Math.sqrt(vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n);
  return {
    peak: vals.reduce((a, b) => Math.max(a, Math.abs(b)), 0),
    mean,
    rel,
    spread: Math.max(...vals) - Math.min(...vals),
  };
}

function look(label: string, speed: number, ms: number, dir: 1 | -1, tune: Partial<TravelTuning> = {}): void {
  const h = harness({ tune });
  const finger0 = dir === 1 ? 700 : 150;
  h.begin(finger0, true);
  h.frame(0, finger0);
  const fingerEnd = h.drag(dir * speed, ms, finger0);
  const stopIdx = h.log.length - 1;
  const stop = h.log[stopIdx];
  const vertexY = h.field.vertex();
  const vis = h.visible();
  h.holdStill(900, fingerEnd);

  const lines = [
    `\n=== ${label} | ${(speed * ms).toFixed(0)} px at ${speed} px/ms | ${dir === 1 ? "up" : "down"}` +
      ` | lag at the stop ${stop.lag.toFixed(1)} px`,
  ];
  for (const mode of ["base", "trav"] as const) {
    const s = scene(vis.map((i) => pick(stop, mode).get(i) ?? 0));
    lines.push(
      `  ${mode === "base" ? "baseline" : "travel  "} at the stop:` +
        ` peak ${s.peak.toFixed(2)} px, band spread ${s.spread.toFixed(2)} px,` +
        ` common slide ${s.mean.toFixed(2)} px, relative rms ${s.rel.toFixed(2)} px`,
    );
  }
  lines.push("  row   above finger      base     trav    |  gap change to the row below (base / trav)");
  for (const i of vis) {
    const b = pick(stop, "base").get(i) ?? 0;
    const t = pick(stop, "trav").get(i) ?? 0;
    const nb = pick(stop, "base").get(i + 1) ?? 0;
    const nt = pick(stop, "trav").get(i + 1) ?? 0;
    const up = vertexY - h.centre(i);
    lines.push(
      `  ${String(i).padStart(3)}   ${up.toFixed(0).padStart(9)} px ${b.toFixed(2).padStart(8)} ${t.toFixed(2).padStart(8)}` +
        `    | ${(nb - b).toFixed(2).padStart(7)} ${(nt - t).toFixed(2).padStart(7)}`,
    );
  }
  // the shape of the scene at a few instants after the stop: this is the table
  // that says whether a front exists, because it shows the rows that have
  // arrived next to the rows that have not
  for (const mode of ["base", "trav"] as const) {
    lines.push(`  ${mode === "base" ? "baseline" : "travel  "} px by row, ms after the stop:`);
    for (const ms of [0, 40, 80, 120, 160, 200, 260, 320]) {
      let best = h.log[stopIdx];
      for (const r of h.log) {
        if (Math.abs(r.t - (stop.t + ms)) < Math.abs(best.t - (stop.t + ms))) best = r;
      }
      lines.push(
        `   +${String(ms).padStart(3)} ms  ${vis
          .map((i) => (pick(best, mode).get(i) ?? 0).toFixed(1).padStart(6))
          .join("")}`,
      );
    }
  }
  // peak stretch each row ever reached, and when it last had half a pixel left
  for (const mode of ["base", "trav"] as const) {
    const pk: number[] = [];
    const land: number[] = [];
    for (const i of vis) {
      let m = 0;
      let last = 0;
      for (const r of h.log) {
        const v = Math.abs(pick(r, mode).get(i) ?? 0);
        if (v > m) m = v;
        if (r.t >= stop.t && v >= 0.5) last = r.t - stop.t;
      }
      pk.push(m);
      land.push(last);
    }
    lines.push(`  ${mode === "base" ? "baseline" : "travel  "} peak px : ${pk.map((v) => v.toFixed(1)).join(" ")}`);
    lines.push(`  ${mode === "base" ? "baseline" : "travel  "} clear ms: ${land.map((v) => Math.round(v)).join(" ")}`);
  }
  console.log(lines.join("\n"));
}

describe("scene probe", () => {
  it("prints the visible scene at an ordinary stop", () => {
    look("ordinary drag", 1.0, 350, 1);
    look("short slow drag", 0.45, 320, 1);
    look("firm drag down", 1.5, 280, -1);
    expect(true).toBe(true);
  });
});
