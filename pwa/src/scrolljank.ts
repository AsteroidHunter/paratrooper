// ===================== TEMP DIAGNOSTIC (remove after the scroll-jank session) =====================
// Scroll-jank recorder. On the live build every scroll gesture in the thread
// stutters on the phone, and every earlier probe in this app reads geometry,
// so none of them can time a scroll without touching the thing it times. This
// channel is the opposite kind of instrument: clock-only. Inside a scroll
// window it records timestamps, counters and observer entries and nothing
// else; there is no geometry read of any kind on any path in this file or in
// jankledger.ts, so the recorder is incapable of adding the delay it exists
// to measure (scrolljank.test.ts pins that property by source and by spy).
//
// The window: a touchstart or wheel over the thread arms a tentative window,
// and the thread's first scroll event confirms it (a tap that never scrolls
// is discarded and ships nothing, so programmatic pins and heals stay out).
// The window keeps extending while scroll events arrive (momentum included)
// or a finger is down, and closes about one second after the last scroll
// event of the gesture. One record per gesture rides the trail on the
// "scroll-jank" channel, so the bounded tail a busy session's digest keeps
// still holds a whole test drive.
//
// Two cadences per window, because neither is trustworthy alone on the
// phone's engine: requestAnimationFrame timestamps, which the engine may
// throttle exactly during composited scrolls, and the scroll events' own
// timeStamp values, which keep coming precisely while the compositor moves.
// A stutter the user can feel shows as a gap over LONG_GAP_MS on at least one
// of the two. Long gaps are attributed at close from two push-based sources:
// the activity ledger (jankledger.ts, stamped around the app's own heavier
// jobs) and a longtask observer that runs for the app's whole life. Longtask
// entries arrive after the fact, and the close sits a second past the last
// scroll, so late delivery still lands inside the record; an engine without
// longtask support simply leaves those fields empty and the two clocks carry
// the verdict on their own — and the record says which case it is (ltSup), so
// an empty field is never mistaken for a clean gesture.
//
// The totals: worst keeps only the ten biggest gaps, so the record also
// carries stallN and stallMs — every stall and all of its time, summed as the
// gaps stream in (the same stall seen by both clocks is merged, not counted
// twice). They come from the two clocks themselves, not from the observer, so
// they are real on every engine, and they are on every record — a clean
// gesture says 0 rather than saying nothing.
//
// The recorder also feeds one thing OUT: the wiring hands hold.ts a gesture
// gate (holdDiagGesture) so the trail's own upload can wait for the window to
// close instead of stringifying inside a gesture — the upload was the one
// stall in the data that could name itself, and naming it got it evicted.
//
// TO REMOVE, every call site: delete this file and jankledger.ts; in main.ts
// delete the two import lines under the scroll-jank comment and the jankSpan
// pairs in writeThreadCache ("cache-write"), drainOlder ("drain-older"),
// decorate ("decorate"), watchPhotos' release batch ("photo-release"),
// renderUser's onload ("photo-load"), settleTail ("settle-tail") and
// prepareShot's drawn callback ("shot-drawn"); in hold.ts delete the
// jankledger import, the jankSpan pair in diagPostSend ("diag-post"), the
// "scroll-jank" entry with its comment in the post-now list, and the
// holdDiagGesture setter with its gate variable (the deferred upload stays
// and simply never parks with nothing feeding the gate); in threadcache.ts
// delete the jankledger import and the jankSpan pair in put ("cache-put");
// in web/app.py delete the "holddiag jank" digest block; and delete
// tests/scrolljank.test.ts and the
// scroll-jank test in tests/test_holddiag.py. Nothing else refers to any of
// it.

import { holdDiagGesture, holdDiagRecord } from "./hold";
import { jankStamps } from "./jankledger";
import type { JankStamp } from "./jankledger";

/** the gesture is over once this much quiet follows its last scroll event */
export const SCROLL_QUIET_MS = 1000;

/** an armed input unconfirmed by a scroll for this long was a tap: discard */
export const INPUT_LINK_MS = 1500;

/** a frame-to-frame or scroll-to-scroll gap over this is long (two 60fps frames) */
export const LONG_GAP_MS = 34;

/** the record carries this many of the worst gaps, biggest first */
export const WORST_GAPS = 10;

const GAP_KEEP = 64; // long gaps held per window before keep-worst kicks in
const TASK_KEEP = 32; // longtask entries held; at 50ms apiece this spans seconds of stall

/** one long gap as the record carries it; led and lt ride only when nonempty */
export interface JankGap {
  ms: number; // the gap's length
  at: number; // where it began, ms after the window opened
  clock: "raf" | "sc"; // which cadence exposed it
  led?: string[]; // ledger names whose spans overlap the gap
  lt?: number; // longtask ms overlapping the gap
}

export interface JankMachine {
  /** a touchstart over the thread, with its timeStamp */
  touchDown(t: number): void;
  /** any touchend or touchcancel; releases the finger hold on the window */
  touchUp(): void;
  /** a wheel over the thread, with its timeStamp */
  wheel(t: number): void;
  /** the thread's own scroll event, with its timeStamp */
  scroll(t: number): void;
  /** one requestAnimationFrame callback, with the timestamp it was handed */
  frame(t: number): void;
  /** one longtask observer entry (startTime, duration) */
  longtask(start: number, dur: number): void;
  /** the wiring saw a real longtask entry type on this engine: ltMs means
      "looked and found this much" rather than "could not look" */
  longtaskOn(): void;
  /** armed or open; the frame pump runs exactly while this is true */
  active(): boolean;
  /** advance the lifecycle; returns the finished record exactly once per gesture */
  poll(now: number): Record<string, unknown> | null;
}

// Pure state machine in the shell/splash mold: timestamps in, one record out,
// injectable ledger, no timers of its own and nothing of the document touched,
// so the whole lifecycle is unit-tested with plain numbers.
export function createJankMachine(
  ledger: () => readonly JankStamp[] = jankStamps,
): JankMachine {
  let state: "idle" | "tentative" | "open" = "idle";
  let fingerDown = false;
  let lastInputAt = -Infinity;
  let start = 0; // the window opens at the INPUT that led to scrolling
  let lastScrollAt = 0;
  let prevRaf = NaN;
  let prevSc = NaN;
  let rafN = 0;
  let scN = 0;
  let longN = 0; // every long gap, counted even when keep-worst drops its entry
  let stallN = 0; // distinct stalls: a gap both clocks expose is one stall, not two
  let stallMs = 0; // their total time — every stall's, not just the ten kept below
  let coverEnd = -Infinity; // how far the stalls counted so far reach; the merge line
  let gaps: { ms: number; end: number; clock: "raf" | "sc" }[] = [];
  let gesture = 0;
  const tasks: { s: number; d: number }[] = []; // lifetime ring, like the ledger
  let taskCursor = 0;
  let ltSup = 0; // 1 once the wiring reports the engine really has longtask

  const begin = (t: number): void => {
    state = "tentative";
    start = t;
    prevRaf = NaN;
    prevSc = NaN;
    rafN = 0;
    scN = 0;
    longN = 0;
    stallN = 0;
    stallMs = 0;
    coverEnd = -Infinity;
    gaps = [];
  };

  // The running totals, summed as gaps stream in so keep-worst can never lose
  // time from them. Gaps arrive in end order (each ends at the event exposing
  // it), so one watermark merges the two clocks: only the stretch past the
  // line is new time, and a gap starting behind the line is the stall the
  // other clock already opened, extended rather than double counted.
  const noteGap = (ms: number, end: number, clock: "raf" | "sc"): void => {
    if (!(ms > LONG_GAP_MS)) return;
    longN += 1;
    const gapStart = end - ms;
    if (gapStart >= coverEnd) stallN += 1;
    stallMs += Math.max(0, end - Math.max(gapStart, coverEnd));
    coverEnd = Math.max(coverEnd, end);
    if (gaps.length < GAP_KEEP) {
      gaps.push({ ms, end, clock });
      return;
    }
    let min = 0;
    for (let i = 1; i < gaps.length; i += 1) {
      if (gaps[i].ms < gaps[min].ms) min = i;
    }
    if (gaps[min].ms < ms) gaps[min] = { ms, end, clock };
  };

  const overlap = (aStart: number, aEnd: number, bStart: number, bEnd: number): number =>
    Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));

  // One record per gesture. t0 and dur describe the GESTURE (input to last
  // scroll); raf, long, the stall totals and ltMs run to the close a second
  // later on purpose: a
  // stall right after the last scroll event is exactly where glide-boundary
  // work lands, and a gap there carries at past dur, which names it a settle
  // stall without a field of its own. Attribution happens here, at close,
  // because both sources are push-based and may deliver late.
  //
  // stallN and stallMs beside ltMs, and ltSup beside both, because ltMs alone
  // proved unreadable: it read 0 in every record off the phone, not because
  // the gestures were clean but because the phone's engine has no longtask
  // entry type at all — the observe() lands in the wiring's catch, the tasks
  // ring stays empty for the app's whole life, and an empty sum rounds to the
  // same 0 a clean gesture would earn (and even with the API, the TASK_KEEP
  // ring caps what a close can still sum). ltSup says whether the observer is
  // real here, and the stall totals are the true bound: they need only the
  // two clocks, which are the same instruments that expose the gaps.
  const build = (now: number): Record<string, unknown> => {
    gesture += 1;
    const stamps = ledger();
    const worst = [...gaps]
      .sort((a, b) => b.ms - a.ms)
      .slice(0, WORST_GAPS)
      .map((g) => {
        const gapStart = g.end - g.ms;
        const led: string[] = [];
        for (const s of stamps) {
          if (s.start < g.end && s.end > gapStart && !led.includes(s.name)) led.push(s.name);
        }
        let lt = 0;
        for (const task of tasks) lt += overlap(task.s, task.s + task.d, gapStart, g.end);
        const out: JankGap = {
          ms: Math.round(g.ms),
          at: Math.round(gapStart - start),
          clock: g.clock,
        };
        if (led.length > 0) out.led = led;
        if (lt > 0) out.lt = Math.round(lt);
        return out;
      });
    let ltMs = 0;
    for (const task of tasks) ltMs += overlap(task.s, task.s + task.d, start, now);
    return {
      n: gesture,
      t0: Math.round(start),
      dur: Math.round(lastScrollAt - start),
      raf: rafN,
      sc: scN,
      long: longN,
      stallN,
      stallMs: Math.round(stallMs),
      ltSup,
      ltMs: Math.round(ltMs),
      worst,
    };
  };

  return {
    touchDown(t: number): void {
      fingerDown = true;
      lastInputAt = t;
      if (state === "idle") begin(t); // during a window: overlapping input extends it
    },
    touchUp(): void {
      fingerDown = false;
    },
    wheel(t: number): void {
      lastInputAt = t;
      if (state === "idle") begin(t);
    },
    scroll(t: number): void {
      if (state === "idle") return; // no user input led here: programmatic moves stay out
      state = "open";
      if (Number.isFinite(prevSc)) noteGap(t - prevSc, t, "sc");
      prevSc = t;
      lastScrollAt = t;
      scN += 1;
    },
    frame(t: number): void {
      if (state === "idle") return;
      if (Number.isFinite(prevRaf)) noteGap(t - prevRaf, t, "raf");
      prevRaf = t;
      rafN += 1;
    },
    longtask(s: number, d: number): void {
      const entry = { s, d };
      if (tasks.length < TASK_KEEP) tasks.push(entry);
      else tasks[taskCursor] = entry;
      taskCursor = (taskCursor + 1) % TASK_KEEP;
    },
    longtaskOn(): void {
      ltSup = 1;
    },
    active(): boolean {
      return state !== "idle";
    },
    poll(now: number): Record<string, unknown> | null {
      if (state === "tentative") {
        // a resting finger keeps the arm alive; a lifted one expires as a tap
        if (!fingerDown && now - lastInputAt > INPUT_LINK_MS) state = "idle";
        return null;
      }
      if (state !== "open") return null;
      if (fingerDown || now - lastScrollAt < SCROLL_QUIET_MS) return null;
      state = "idle";
      return build(now);
    },
  };
}

// --- wiring (real shell only; node and vitest drive it through stubs) ---------
// Passive capture listeners on document, the shape the other probes use: they
// observe the gesture and can never cancel or delay it, and they survive the
// shell re-rendering the thread element because nothing here holds an element.
// Target checks are name walks only.
function startScrollJank(): void {
  if (typeof document === "undefined" || document.getElementById("app") === null) return;
  const machine = createJankMachine();
  // the trail's upload must never stringify inside a gesture (hold.ts defers
  // it), and this machine already owns the definition of "a gesture is on":
  // armed or open, quiet tail included, exactly the stretch a stall would land
  // a long block into
  holdDiagGesture(() => machine.active());
  let pumping = false;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const ship = (rec: Record<string, unknown> | null): void => {
    if (rec) holdDiagRecord("scroll-jank", rec);
  };

  // the frame pump: one requestAnimationFrame chain, alive exactly while a
  // window is armed or open. Each step is a counter push and a poll; the poll
  // closes quiet windows and discards tentative ones, so the chain ends
  // itself the moment the machine goes idle.
  const pump = (): void => {
    if (pumping) return;
    pumping = true;
    const step = (ts: number): void => {
      machine.frame(ts);
      ship(machine.poll(performance.now()));
      if (machine.active()) requestAnimationFrame(step);
      else pumping = false;
    };
    requestAnimationFrame(step);
  };

  // the fallback close: the pump is the fast path, but the engine can starve
  // requestAnimationFrame at exactly the moments this recorder exists for,
  // and an open window must close even if no further frame callback runs.
  // Armed once per open window, re-armed while it stays open, dead with it.
  const armClose = (): void => {
    if (closeTimer) return;
    closeTimer = setTimeout(() => {
      closeTimer = null;
      ship(machine.poll(performance.now()));
      if (machine.active()) armClose();
    }, SCROLL_QUIET_MS + 250);
  };

  // is the event's target the thread or inside it: a name walk, not a measure
  const inThread = (e: Event): boolean => {
    const t = e.target as Element | null;
    if (!t) return false;
    if (t.id === "thread") return true;
    return typeof t.closest === "function" && t.closest("#thread") !== null;
  };

  document.addEventListener(
    "touchstart",
    (e) => {
      if (!inThread(e)) return;
      machine.touchDown(e.timeStamp);
      pump();
    },
    { capture: true, passive: true },
  );
  // a finger up anywhere releases the hold, whatever it first landed on
  document.addEventListener("touchend", () => machine.touchUp(), { capture: true, passive: true });
  document.addEventListener("touchcancel", () => machine.touchUp(), { capture: true, passive: true });
  document.addEventListener(
    "wheel",
    (e) => {
      if (!inThread(e)) return;
      machine.wheel(e.timeStamp);
      pump();
    },
    { capture: true, passive: true },
  );
  // scroll does not bubble but capture still sees it; only the thread's own
  // scroll confirms a window, so the shell's other scrollers stay out
  document.addEventListener(
    "scroll",
    (e) => {
      const t = e.target as Element | null;
      if (!t || t.id !== "thread") return;
      machine.scroll(e.timeStamp);
      armClose();
    },
    { capture: true, passive: true },
  );

  // longtask entries are push-based and cost nothing between deliveries, so
  // the observer runs for the app's whole life; buffered picks up boot-era
  // entries too. An engine without the type lands in the catch and the
  // record's lt fields simply stay empty — which is why ltSup rides the
  // record: WebKit has never shipped the type, so on the phone every ltMs
  // read 0 and nothing said whether that was innocence or blindness. The
  // supportedEntryTypes check is the honest source (observe() can swallow an
  // unknown type with only a console warning, which no phone session sees).
  if (typeof PerformanceObserver !== "undefined") {
    try {
      if (PerformanceObserver.supportedEntryTypes?.includes("longtask")) machine.longtaskOn();
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) machine.longtask(entry.startTime, entry.duration);
      }).observe({ type: "longtask", buffered: true });
    } catch {
      /* no longtask on this engine: the two clocks carry the verdict alone */
    }
  }
}
startScrollJank();
// =================== END TEMP DIAGNOSTIC (remove after the scroll-jank session) ===================
