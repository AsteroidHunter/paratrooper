// The transcript's DOM, built to the same shape the real thread has, because
// the spring's geometry is the shape: it reads offsetTop and offsetHeight off
// the laid-out rows, and a different nesting would measure different rows.
//
//   .thread                       the scroller (flex column, 2px gap)
//     .evt                        one chat event, display: contents
//       .stamp | .row             the real flex row
//         .msg                    the bubble, .tail on the last of a run
//
// The row walk below is the app's own laidOutRows (reference/pwa/src/
// viewport.ts), copied as-is because it is what decides which elements the
// field is measuring: an .evt wrapper generates no box, so the walk steps
// through it and takes the children instead.
//
// Nothing here boots, authenticates, fetches, registers a worker or talks to a
// backend. It is markup and text.

import { TRANSCRIPT } from "./messages";
import { installTailMasks } from "./vendor/runs";

/** rows with a box of their own, in document order (viewport.ts laidOutRows) */
export function laidOutRows(thread: Element): HTMLElement[] {
  const out: HTMLElement[] = [];
  const walk = (parent: Element): void => {
    for (const el of Array.from(parent.children)) {
      if (!(el instanceof HTMLElement)) continue;
      if (el.getClientRects().length > 0) out.push(el);
      else walk(el); // no box of its own: whatever it groups is the real row
    }
  };
  walk(thread);
  return out;
}

/** minutes past a stamp, so a run's bubbles carry believable times */
function stepTime(base: string, step: number): string {
  const m = /^(\d+):(\d+)\s*(AM|PM)$/.exec(base);
  if (!m) return base;
  let h = Number(m[1]) % 12;
  let min = Number(m[2]) + step;
  let pm = m[3] === "PM";
  h += Math.floor(min / 60);
  min %= 60;
  if (h >= 12) {
    h -= 12;
    pm = !pm;
  }
  return `${h === 0 ? 12 : h}:${String(min).padStart(2, "0")} ${pm ? "PM" : "AM"}`;
}

/**
 * Render the transcript into `thread`. Returns nothing: the caller measures the
 * rows itself, through the same walk the field uses.
 */
export function buildThread(thread: HTMLElement): void {
  installTailMasks(document.documentElement); // the bubble tail's two masks
  thread.textContent = "";
  let time = "9:00 AM";
  let step = 0;
  for (let i = 0; i < TRANSCRIPT.length; i++) {
    const e = TRANSCRIPT[i];
    const evt = document.createElement("div");
    evt.className = "evt";
    if (e.kind === "stamp") {
      const s = document.createElement("div");
      s.className = "stamp";
      const b = document.createElement("b");
      b.textContent = e.day;
      s.append(b, document.createTextNode(` ${e.time}`));
      evt.append(s);
      time = e.time;
      step = 0;
    } else {
      // a run is consecutive bubbles from one sender; the LAST of them wears
      // the tail, exactly as decorate()/markRuns do in the app
      const prev = i > 0 ? TRANSCRIPT[i - 1] : null;
      const next = i + 1 < TRANSCRIPT.length ? TRANSCRIPT[i + 1] : null;
      const cont = prev !== null && prev.kind === "msg" && prev.from === e.from;
      const lastOfRun = !(next !== null && next.kind === "msg" && next.from === e.from);
      const row = document.createElement("div");
      row.className = `row ${e.from === "user" ? "user" : "agent"}${cont ? " cont" : ""}`;
      step += cont ? 1 : 2;
      row.dataset.time = stepTime(time, step);
      const msg = document.createElement("div");
      msg.className = `msg ${e.from === "user" ? "user" : "agent"}${lastOfRun ? " tail" : ""}`;
      msg.textContent = e.text;
      row.append(msg);
      evt.append(row);
    }
    thread.append(evt);
  }
}
