// The one shape the playground drives.
//
// main.ts's spring seam has always called the same eleven methods, and every
// build in this tool's history answers to them - four of the historical modules
// export exactly this interface already, and the fifth (0.3.121, which predates
// the idea of a gesture) is adapted onto it in history/adapters.ts. Naming it
// here is what lets the wiring pick a build at runtime without a branch in
// every handler.
//
// The current field adds vertex(), window() and viewport() on top of this; the
// travelling settle needs them and only ever runs on the current field.

import type { SpringRow } from "./vendor/springscroll";

export interface SpringEngine {
  measure(rows: readonly SpringRow[]): void;
  begin(clientHeight: number, threadTop: number, anchorScreenY: number | null, held: boolean): void;
  anchor(screenY: number): void;
  lift(): void;
  frame(nowMs: number, scrollTop: number): void;
  displacements(): Map<number, number>;
  /** frames are still wanted */
  active(): boolean;
  /** a gesture, its momentum or its settle is live */
  armed(): boolean;
  /** the build's own phase name, for the readout */
  phase(): string;
  /** the build's own reference number, px, for the readout. A per-row build has
      no single one and reports its largest displacement instead. */
  lag(): number;
  freeze(): void;
  reset(): void;
  /**
   * The position a gesture is opening AT, handed over at the moment it opens.
   *
   * Every build from 0.3.123 on takes its delta reference on its own first
   * frame and does not need this. 0.3.121 does: its armSpring rebased the
   * reference synchronously, inside the event handler, BEFORE the browser had
   * applied the scroll that event was about - and a wheel re-arms on every
   * tick, so a reference taken one animation frame later is taken after the
   * travel it was supposed to measure. That is a whole gesture's worth of
   * scrolling lost, which is what an independent browser run found: 480 px of
   * wheel, every row at exactly zero.
   */
  rebase?(scrollTop: number): void;
}

/**
 * The end of the thread, to the same standard.
 *
 * Three different rubber-band models were pushed, and the builds before 0.3.132
 * had none at all - pulling past the top of a transcript simply stopped. An
 * entry that swapped the spring but kept today's end model would be showing a
 * mixture that was never pushed, so the picker swaps both, and "none" is a real
 * option rather than a missing one.
 *
 * `reseat` is deliberately absent: only the newest of the three has it, and the
 * playground never pins a page of older messages in, so nothing calls it.
 */
export interface EndModel {
  begin(held: boolean, fingerScreenY: number | null): void;
  finger(screenY: number): void;
  lift(): void;
  /** the modelled overscroll to ADD to the position, px */
  frame(nowMs: number, scrollTop: number, maxScrollTop: number, viewportH: number): number;
  over(): number;
  active(): boolean;
  freeze(): void;
  reset(): void;
}

/** the builds that had no rubber band: the thread simply stops at its ends */
export function createNoEnd(): EndModel {
  return {
    begin: () => {},
    finger: () => {},
    lift: () => {},
    frame: () => 0,
    over: () => 0,
    active: () => false,
    freeze: () => {},
    reset: () => {},
  };
}
