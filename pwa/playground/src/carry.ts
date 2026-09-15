// Continuity across a live change.
//
// A tuning tool's whole point is that the numbers move while the effect is on
// screen, and every one of them changes where a row belongs. Rather than let a
// slider step the thread, the difference between what is ON SCREEN and what the
// new numbers want is taken once and decayed away. The same mechanism covers
// the mode switch, which is otherwise the largest step there is, and a gesture
// opening on rows that have not reached their seats yet.
//
// THE INVARIANT, and it is the whole file: `lastWritten` is what the DOM is
// showing, which ALREADY INCLUDES the correction being carried. So the new
// correction is
//
//     carry = lastWritten - fresh
//
// and nothing else. Adding the old carry to that was a real bug with a real
// signature: each change re-counted a correction that was already in the
// number it was being measured against, so dragging one slider back and forth
// across its track during a gesture compounded it every frame. An independent
// browser run measured rendered row offsets reaching +12,834 and -14,018 px,
// with rows crossing one another, against a legitimate ceiling of a few
// hundred. The formula is the fix; the clamp below is a backstop so that no
// future arithmetic mistake here can put a row somewhere impossible again.

import { TUNING } from "./vendor/springscroll";

/** the correction melts with this time constant, ms */
export const CARRY_TAU_MS = 90;
/** under this many px a correction is not worth carrying or writing */
export const CARRY_EPS_PX = 0.05;
/**
 * No correction may exceed this. The field itself can never place a row further
 * than the stretch ceiling from its seat (profileFor's own cap), so a
 * correction bigger than that is not a continuity blend, it is a fault.
 */
export const CARRY_MAX_PX = TUNING.STRETCH_CAP_PX;

export interface Carry {
  /** the tuning, the mode or the gesture changed: reconcile on the next frame */
  note(): void;
  /** what to write this frame, given what the physics wants */
  blend(fresh: Map<number, number>, dt: number): Map<number, number>;
  /** a correction is still melting: the pump must keep asking for frames */
  active(): boolean;
  /** the largest correction being carried, px (for the readout and for tests) */
  peak(): number;
  /** drop everything: a freeze, a re-measure, a thread swap */
  reset(): void;
}

export function createCarry(): Carry {
  let held = new Map<number, number>();
  let lastWritten = new Map<number, number>();
  let pending = false;

  function reset(): void {
    held = new Map();
    lastWritten = new Map();
    pending = false;
  }

  function blend(fresh: Map<number, number>, dt: number): Map<number, number> {
    if (pending) {
      pending = false;
      const next = new Map<number, number>();
      const keys = new Set<number>([...lastWritten.keys(), ...fresh.keys()]);
      for (const i of keys) {
        // lastWritten is the screen, corrections included. The difference IS
        // the new correction; the old one must not be added back.
        const d = (lastWritten.get(i) ?? 0) - (fresh.get(i) ?? 0);
        if (!Number.isFinite(d)) continue;
        const bounded = d > CARRY_MAX_PX ? CARRY_MAX_PX : d < -CARRY_MAX_PX ? -CARRY_MAX_PX : d;
        if (Math.abs(bounded) > CARRY_EPS_PX) next.set(i, bounded);
      }
      held = next;
    }
    if (held.size > 0 && dt > 0) {
      const k = Math.exp(-dt / CARRY_TAU_MS);
      for (const [i, v] of held) {
        const n = v * k;
        if (Math.abs(n) < CARRY_EPS_PX) held.delete(i);
        else held.set(i, n);
      }
    }
    if (held.size === 0) {
      lastWritten = fresh;
      return fresh;
    }
    const out = new Map(fresh);
    for (const [i, v] of held) {
      const sum = (out.get(i) ?? 0) + v;
      if (Math.abs(sum) > CARRY_EPS_PX) out.set(i, sum);
      else out.delete(i);
    }
    lastWritten = out;
    return out;
  }

  return {
    note: () => {
      pending = true;
    },
    blend,
    active: () => held.size > 0,
    peak: () => {
      let m = 0;
      for (const v of held.values()) m = Math.max(m, Math.abs(v));
      return m;
    },
    reset,
  };
}
