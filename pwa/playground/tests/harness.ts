// A driven harness for the stateful physics: no DOM, no browser, no clock of
// its own. It calls the field and the travelling settle in exactly the order
// src/playground.ts calls them on an animation frame, so what the tests measure
// is the sequence the page runs, not a re-derivation of it.

import { createTunedSpringField, defaultFieldTunables } from "../src/springfield";
import type { FieldTunables } from "../src/springfield";
import { createTravellingSettle, defaultTravelTuning } from "../src/travelsettle";
import type { TravelTuning } from "../src/travelsettle";
import type { SpringRow } from "../src/vendor/springscroll";

export const FRAME_MS = 1000 / 60;

/** a transcript of `n` rows: a believable mix of one-line and three-line
    bubbles, so the pitch varies the way a real thread's does */
export function makeRows(n: number): SpringRow[] {
  const out: SpringRow[] = [];
  let top = 0;
  for (let i = 0; i < n; i++) {
    const tall = i % 5 === 3;
    const height = tall ? 92 : 42;
    out.push({ top, height });
    top += height + (i % 3 === 0 ? 12 : 4);
  }
  return out;
}

export interface Reading {
  t: number;
  scroll: number;
  lag: number;
  signal: number;
  phase: string;
  state: string;
  /** the travelling settle's placement for this frame */
  disp: Map<number, number>;
  /** the shipped field's own placement for the same frame, so the two can be
      held against each other rather than against a number somebody chose */
  base: Map<number, number>;
  /** the rows the field would write this frame: outside this range a row is not
      placed at all, so a pair straddling the edge is not a pair the effect
      controls (it is 400 px off screen by construction) */
  lo: number;
  hi: number;
}

export interface HarnessOptions {
  rows?: SpringRow[];
  clientH?: number;
  threadTop?: number;
  tune?: Partial<TravelTuning>;
  field?: Partial<FieldTunables>;
  scroll?: number;
}

export function harness(opts: HarnessOptions = {}) {
  const rows = opts.rows ?? makeRows(140);
  const clientH = opts.clientH ?? 844;
  const threadTop = opts.threadTop ?? 0;
  const tune: TravelTuning = { ...defaultTravelTuning(), ...opts.tune };
  const fieldT: FieldTunables = { ...defaultFieldTunables(), ...opts.field };

  const field = createTunedSpringField(() => fieldT);
  const settle = createTravellingSettle();
  field.measure(rows);

  let now = 0;
  let scroll = opts.scroll ?? 3000;
  let held = false;
  const log: Reading[] = [];

  /** one animation frame: move the scroll, move the finger, run both models */
  function frame(dScroll = 0, fingerY?: number, dt = FRAME_MS): Reading {
    now += dt;
    scroll += dScroll;
    if (fingerY !== undefined) {
      field.anchor(fingerY);
      held = true;
    }
    field.frame(now, scroll);
    const win = field.window();
    const base = field.displacements();
    const disp = settle.frame({
      nowMs: now,
      dt,
      fieldLag: field.lag(),
      phase: field.phase(),
      vertexY: field.vertex(),
      scrollTop: scroll,
      clientH,
      rows,
      lo: win ? win.lo : 0,
      hi: win ? win.hi : -1,
      tune,
      field: fieldT,
    });
    const r: Reading = {
      t: now,
      scroll,
      lag: field.lag(),
      signal: settle.signal(),
      phase: field.phase(),
      state: settle.state(),
      disp,
      base,
      lo: win ? win.lo : 0,
      hi: win ? win.hi : -1,
    };
    log.push(r);
    return r;
  }

  return {
    rows,
    clientH,
    threadTop,
    tune,
    fieldT,
    field,
    settle,
    log,
    get now() {
      return now;
    },
    get scroll() {
      return scroll;
    },
    get held() {
      return held;
    },
    /** a finger lands (or a wheel tick opens a gesture) */
    begin(fingerY: number | null, fingerDown: boolean): void {
      held = fingerDown;
      field.begin(clientH, threadTop, fingerY, fingerDown);
    },
    lift(): void {
      held = false;
      field.lift();
    },
    frame,
    /** a 1:1 drag: the scroll and the finger move together, `speed` px/ms of
        scrollTop (positive = toward newer, the content travelling up) */
    drag(speed: number, ms: number, fingerStart: number): number {
      let finger = fingerStart;
      const n = Math.round(ms / FRAME_MS);
      for (let i = 0; i < n; i++) {
        finger -= speed * FRAME_MS;
        frame(speed * FRAME_MS, finger);
      }
      return finger;
    },
    /** the finger stays on the glass and stops travelling: the braked stop */
    holdStill(ms: number, finger: number): void {
      const n = Math.round(ms / FRAME_MS);
      for (let i = 0; i < n; i++) frame(0, finger);
    },
    /** no finger at all: the return running on its own */
    coastToRest(ms: number): void {
      const n = Math.round(ms / FRAME_MS);
      for (let i = 0; i < n; i++) frame(0);
    },
    /** the content Y of a row's centre */
    centre(i: number): number {
      return rows[i].top + rows[i].height / 2;
    },
    /** the visible rows for the current scroll position */
    visible(): number[] {
      const out: number[] = [];
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].top + rows[i].height < scroll) continue;
        if (rows[i].top > scroll + clientH) break;
        out.push(i);
      }
      return out;
    },
  };
}

export type Harness = ReturnType<typeof harness>;

/** the peak |displacement| each row reached over a slice of the log */
export function peaks(log: readonly Reading[], from: number): Map<number, number> {
  const out = new Map<number, number>();
  for (let k = from; k < log.length; k++) {
    for (const [i, dy] of log[k].disp) {
      const m = Math.abs(dy);
      if (m > (out.get(i) ?? 0)) out.set(i, m);
    }
  }
  return out;
}
