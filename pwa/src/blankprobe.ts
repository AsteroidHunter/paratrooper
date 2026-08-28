// ===================== TEMP DIAGNOSTIC (remove after the blank-thread session) =====================
// Blank-thread probe.
//
// Failure shape, twice and not since: a photo is attached, the conversation is
// flicked upward and left gliding, and a tap on that photo's ✕ arrives while it
// is still moving. The message area goes empty — the top bar and the compose
// bar stay painted the whole time — and the next touch or scroll brings every
// message straight back, with nothing refetched.
//
// That last fact is why this file exists and what shapes all of it. Content
// that returns on a passive touch was never removed and was never scrolled away
// from: a list that had emptied would have to be rebuilt before it could come
// back, and a position sitting in white space would still be sitting in it
// after a touch that moved nothing. What is left is that the pixels were not
// drawn, and no page can observe that: there is no reading of the compositor
// from script, and a probe that claimed otherwise would be inventing its
// answer. So this does not try to catch the blank. It ELIMINATES the other two
// explanations, with readings taken either side of the repair, where the
// difference between a repaint and everything else is at its plainest.
//
// THE DECIDING FIELD IS vis: how many laid-out rows have a box overlapping the
// thread's own visible band at that instant. Above zero while the screen reads
// empty says the message elements are present, sized, and standing inside the
// box the reader is looking at, and there is then nothing left for the DOM or
// for the scroll position to be guilty of. Zero is the opposite answer, and
// kids tells which of the two it is: a thread holding nothing is an emptied
// list, and a thread still holding its rows with vis at zero is a scroll that
// went somewhere blank, which over then measures.
//
// THE MOMENTS. Seven readings, named so a log line reads as a sequence:
//   tap    the ✕'s own handler, before anything is dismissed: the before-picture
//   frame  the first animation frame after it, where a one-frame fault would sit
//   mid    a third of the way through the drawer's beat
//   beat   the beat's end, where the strip's teardown and its settle run
//   rest   past everything, with nothing left running
//   touch  the first touch or scroll on the thread after all of that
//   after  one frame later, which is the repair itself
// touch and after are the pair the whole design turns on. If the numbers either
// side of a touch that moved nothing are the same numbers, then nothing in the
// page changed and the repair was a repaint. A run that never gets its touch
// gives up on a clock and ships what it has, so the record cannot be lost by
// the owner simply putting the phone down.
//
// ARMED ONLY ON A LIVE SCROLL. A cancel with the conversation standing still is
// the ordinary case and has never once failed, so the run only starts when a
// thread scroll arrived within the arming window below. That keeps the channel
// to the gesture actually under suspicion and stops ten ordinary cancels
// clipping the one that matters off the digest's tail.
//
// WHAT IT COSTS THE THING IT MEASURES. This one cannot be clock-only the way
// the scroll-jank and pick-timing recorders are: the question is geometry, so
// geometry has to be read. What is bounded instead is the number of times
// layout is forced. Nothing here writes to the DOM or to style, so every read
// inside one sample is served by the single layout flush the first of them
// forces, however many rects it goes on to take; the cost is therefore one
// flush per moment, not one per field. Four of the seven land inside the
// drawer's beat, and they are taken from a frame callback, which runs before
// the style and layout that the drawer's own height animation was going to
// force on that frame regardless — so those four cost the ordering of a
// flush, not an extra one. The row walk is capped and stops at the foot of the
// view, and the record says when the cap was reached so a clipped count can
// never be read as a small one.
//
// TO REMOVE, every call site: delete this file and tests/blankprobe.test.ts; in
// main.ts delete the blankprobe import line, the blankProbeFollow registration
// beside watchFollowTail, the blankProbeSettle call in settleTail and the
// blankProbeTap call in the thumbnail's ✕ handler; in hold.ts delete the
// "thread-blank" entry with its paragraph in the post-now list; in web/app.py
// delete the "holddiag blank" digest block; and delete the thread-blank test in
// tests/test_holddiag.py. Nothing else refers to any of it.

import { holdDiagRecord } from "./hold";

/** a thread scroll this recently means the glide was still running under the
    tap; anything older is a cancel on a conversation standing still */
export const BLANK_ARM_MS = 250;

/** the scheduled moments, in ms from the tap. The tap itself and the frame
    after it are taken on sight, so they are not offsets and are not listed. */
export const BLANK_OFFSETS = [130, 400, 700] as const;

/** names, in order, for every reading a run can take */
export const BLANK_MOMENTS = ["tap", "frame", "mid", "beat", "rest", "touch", "after"] as const;

export type BlankMoment = (typeof BLANK_MOMENTS)[number];

/** with no touch by this long after the tap the run gives up and ships without
    its pair, rather than sitting in the ring waiting for a finger */
export const BLANK_WAIT_MS = 8000;

/** elements the row walk will look at before it reports a clipped count */
export const ROW_SCAN_CAP = 500;

/** a row's vertical extent, in the same coordinates as the band it is tested
    against — viewport coordinates everywhere here, since what is being asked
    is whether the thing is where the eye was pointed */
export interface RowBox {
  top: number;
  bottom: number;
}

export interface BandRead {
  vis: number; // rows overlapping the band
  top1: number | null; // the first of them, relative to the band's own top
  botN: number | null; // and where the last of them ends
  h1: number | null; // the first one's height: a row collapsed to nothing shows here
}

/**
 * The rows standing in the visible band, counted.
 *
 * A row has to have height of its own before it can be counted, and the overlap
 * is strict at both edges. Both rules exist for one reason: a thread whose rows
 * had collapsed to nothing would still have every one of them sitting at a
 * plausible offset, and a count that took those would report a healthy
 * conversation for the exact screen this probe was built to explain. Anything
 * the reader could not have seen is not visible.
 */
export function bandRead(rows: readonly RowBox[], top: number, bottom: number): BandRead {
  let vis = 0;
  let first: RowBox | null = null;
  let last: RowBox | null = null;
  for (const r of rows) {
    if (!(r.bottom > r.top && r.bottom > top && r.top < bottom)) continue;
    vis += 1;
    if (!first) first = r;
    last = r;
  }
  return {
    vis,
    top1: first ? Math.round(first.top - top) : null,
    botN: last ? Math.round(last.bottom - top) : null,
    h1: first ? Math.round(first.bottom - first.top) : null,
  };
}

/** what one moment reads off the shell. Handed in rather than reached for, the
    same split the tail-gap frame uses, so the assembly below is pinned without
    a DOM and the walk that feeds it is pinned by source. */
export interface BlankReader {
  sh(): number;
  st(): number;
  ch(): number;
  /** the thread's own visible band, the rows found inside and above it, and
      how much of the walk it took */
  band(): { top: number; bottom: number; rows: RowBox[]; scan: number; cap: boolean };
  /** direct children of the thread: free of layout, and the honest answer to
      whether the conversation is still in the document at all */
  kids(): number;
  /** the photo strip: its height and whether it is displayed, so every reading
      says where in the close it was taken */
  pend(): { h: number; d: string };
  /** animations running on the shell root and on the thread itself — an
      ancestor's own animation is the one thing a sibling's cannot excuse */
  anims(): { app: number; thr: number };
  /** the mode classes as worn at that instant, both boxes */
  classes(): { app: string; thr: string };
  /** the peek offset every row's transform reads from */
  peek(): string;
  follow(): boolean;
}

/** the counters the run keeps for itself; no reading involved */
export interface BlankCounts {
  sc: number; // thread scroll events since the tap: momentum alive shows here
  set: number; // settle passes since the tap
  setMoved: number; // and how many of those actually moved the scroll
}

export type BlankFrame = {
  w: BlankMoment;
  ms: number;
  st: number;
  sh: number;
  ch: number;
  over: number;
  kids: number;
  rows: number;
  vis: number;
  top1: number | null;
  botN: number | null;
  h1: number | null;
  scan: number;
  cap: boolean;
  pendH: number;
  pendD: string;
  anA: number;
  anT: number;
  app: string;
  thr: string;
  peek: string;
  ft: boolean;
  sc: number;
  set: number;
  setMoved: number;
};

export function blankFrame(
  w: BlankMoment,
  ms: number,
  r: BlankReader,
  c: BlankCounts,
): BlankFrame {
  const sh = r.sh();
  const st = r.st();
  const ch = r.ch();
  const band = r.band();
  const seen = bandRead(band.rows, band.top, band.bottom);
  const pend = r.pend();
  const anims = r.anims();
  const classes = r.classes();
  return {
    w,
    ms: Math.round(ms),
    st: Math.round(st),
    sh: Math.round(sh),
    ch: Math.round(ch),
    over: Math.round(Math.max(0, st - Math.max(0, sh - ch))),
    kids: r.kids(),
    rows: band.rows.length,
    vis: seen.vis,
    top1: seen.top1,
    botN: seen.botN,
    h1: seen.h1,
    scan: band.scan,
    cap: band.cap,
    pendH: Math.round(pend.h),
    pendD: pend.d,
    anA: anims.app,
    anT: anims.thr,
    app: classes.app,
    thr: classes.thr,
    peek: r.peek(),
    ft: r.follow(),
    sc: c.sc,
    set: c.set,
    setMoved: c.setMoved,
  };
}

export interface BlankProbe {
  /** the ✕ was tapped. Starts a run and takes the tap reading, or refuses when
      the conversation was not moving; true when a run began. */
  tap(at: number, sinceScrollMs: number): boolean;
  /** one animation frame while a run is open */
  frame(at: number): void;
  /** a thread scroll event: counted always, and the repair once the beat is past */
  scrolled(at: number): void;
  /** a finger on the thread: the repair, once the beat is past */
  touched(at: number): void;
  /** a settle pass ran, and whether it moved the scroll */
  settled(moved: boolean): void;
  /** a run is open; the frame pump runs exactly while this is true */
  live(): boolean;
  /** advance the clock; hands back the finished record exactly once per run */
  poll(at: number): Record<string, unknown> | null;
}

// Pure state machine in the scroll-jank and pick-timing mold: timestamps in,
// one record out, an injected reader, no timers of its own, so a whole run is
// driven on synthetic numbers with no document anywhere near it.
export function createBlankProbe(reader: () => BlankReader | null): BlankProbe {
  let live = false;
  let runs = 0;
  let t0 = 0;
  let next = 0; // how many of BLANK_OFFSETS have been taken
  let sawFrame = false;
  let repairAt = -1; // the touch's own clock; the frame after it closes the run
  let done = false;
  let frames: BlankFrame[] = [];
  let counts: BlankCounts = { sc: 0, set: 0, setMoved: 0 };

  const take = (w: BlankMoment, at: number): boolean => {
    const r = reader();
    if (!r) return false; // no shell to read from: nothing to say about it
    frames.push(blankFrame(w, at - t0, r, counts));
    return true;
  };

  const ship = (): Record<string, unknown> | null => {
    live = false;
    if (frames.length === 0) return null;
    runs += 1;
    return {
      n: runs,
      t0: Math.round(t0),
      // whether the pair either side of the repair was actually caught; a run
      // that gave up says so rather than looking like one that had no touch
      paired: frames.some((f) => f.w === "after"),
      f: frames,
    };
  };

  return {
    tap(at: number, sinceScrollMs: number): boolean {
      if (live) return false; // a second ✕ inside a run belongs to the run already open
      if (!(sinceScrollMs >= 0) || sinceScrollMs > BLANK_ARM_MS) return false;
      t0 = at;
      next = 0;
      sawFrame = false;
      repairAt = -1;
      done = false;
      frames = [];
      counts = { sc: 0, set: 0, setMoved: 0 };
      // the before-picture is the run's reason for existing: with no shell to
      // take it from there is nothing worth opening a run for
      if (!take("tap", at)) return false;
      live = true;
      return true;
    },
    frame(at: number): void {
      if (!live) return;
      if (!sawFrame) {
        sawFrame = true;
        take("frame", at);
      }
      while (next < BLANK_OFFSETS.length && at - t0 >= BLANK_OFFSETS[next]) {
        take(BLANK_MOMENTS[2 + next], at);
        next += 1;
      }
      // the repair's own second half: the frame after the touch is where a
      // compositor that had dropped the scroller has drawn it again
      if (repairAt >= 0 && at > repairAt) {
        take("after", at);
        done = true;
      }
    },
    scrolled(at: number): void {
      if (!live) return;
      counts.sc += 1;
      if (next >= BLANK_OFFSETS.length && repairAt < 0) {
        repairAt = at;
        take("touch", at);
      }
    },
    touched(at: number): void {
      if (!live) return;
      if (next >= BLANK_OFFSETS.length && repairAt < 0) {
        repairAt = at;
        take("touch", at);
      }
    },
    settled(moved: boolean): void {
      if (!live) return;
      counts.set += 1;
      if (moved) counts.setMoved += 1;
    },
    live(): boolean {
      return live;
    },
    poll(at: number): Record<string, unknown> | null {
      if (!live) return null;
      if (done) return ship();
      // the give-up: the beat is long past and no finger has arrived
      if (repairAt < 0 && at - t0 > BLANK_WAIT_MS) return ship();
      return null;
    },
  };
}

// --- wiring (real shell only; node and vitest drive the machine directly) -----
// Every listener is passive and on the capture path, the shape the other
// probes use: they observe and can never cancel, delay or reorder anything,
// and none of them holds an element, so a shell re-render needs no rebinding.

let readFollowTail: (() => boolean) | null = null;

/** the thread's follow state, read rather than tracked, so this file never has
    an opinion about a flag main.ts owns */
export function blankProbeFollow(read: () => boolean): void {
  readFollowTail = read;
}

/** the rows standing at or above the foot of the view, in document order.
 *
 * Not the tail-gap frame's walk, on purpose: that one is exhaustive because it
 * is looking for the LAST row, and this one wants the visible band and must not
 * pay for a thousand rows to find fifteen. So it stops at the first row whose
 * top is past the foot of the view — the thread is a column, so everything
 * after that one is lower still — and it stops outright at the cap, saying so.
 *
 * An element's client rects answer both questions at once, which is what keeps
 * this to a single read apiece: no rects at all means no box, so it is either
 * one of the display:contents groupings every row sits inside or a hidden
 * subtree, and either way the thing to do is look within it.
 */
function walkBand(
  thread: Element,
  bottom: number,
): { rows: RowBox[]; scan: number; cap: boolean } {
  const rows: RowBox[] = [];
  let scan = 0;
  let cap = false;
  let below = false;
  const walk = (parent: Element): void => {
    for (const el of Array.from(parent.children)) {
      if (below || cap) return;
      if (scan >= ROW_SCAN_CAP) {
        cap = true;
        return;
      }
      scan += 1;
      const rects = el.getClientRects();
      if (rects.length === 0) {
        walk(el);
        continue;
      }
      const r = rects[0];
      if (r.top >= bottom) {
        below = true;
        return;
      }
      rows.push({ top: r.top, bottom: r.bottom });
    }
  };
  walk(thread);
  return { rows, scan, cap };
}

function countAnimations(el: Element | null): number {
  if (!el) return 0;
  const get = (el as Element & { getAnimations?: () => unknown[] }).getAnimations;
  if (typeof get !== "function") return 0;
  try {
    return get.call(el).length;
  } catch {
    return 0; // an engine without the call answers nothing rather than throwing
  }
}

function shellReader(): BlankReader | null {
  const thread = document.getElementById("thread");
  const app = document.getElementById("app");
  if (!thread) return null;
  const pending = document.getElementById("pending");
  return {
    sh: () => thread.scrollHeight,
    st: () => thread.scrollTop,
    ch: () => thread.clientHeight,
    band: () => {
      const box = thread.getBoundingClientRect();
      // rows above the band are kept rather than skipped: bandRead takes the
      // visible ones out of them, and what is left over is the count that says
      // the conversation is still laid out at all
      const found = walkBand(thread, box.bottom);
      return { top: box.top, bottom: box.bottom, ...found };
    },
    kids: () => thread.childElementCount,
    pend: () => ({
      h: pending ? pending.offsetHeight : 0,
      d: pending ? getComputedStyle(pending).display : "none",
    }),
    anims: () => ({ app: countAnimations(app), thr: countAnimations(thread) }),
    classes: () => ({ app: app?.className ?? "", thr: thread.className }),
    peek: () => getComputedStyle(thread).getPropertyValue("--peek").trim(),
    follow: () => readFollowTail?.() ?? false,
  };
}

const probe = createBlankProbe(shellReader);

/** the ✕ was tapped; sinceScrollMs is how long ago the thread last scrolled */
export function blankProbeTap(sinceScrollMs: number): void {
  if (!probe.tap(performance.now(), sinceScrollMs)) return;
  pump();
  armClose();
}

/** a settle pass ran. A counter bump and nothing else, so this stays safe to
    call from inside the settle's own frame. */
export function blankProbeSettle(moved: boolean): void {
  probe.settled(moved);
}

let pumping = false;
let closeTimer: ReturnType<typeof setTimeout> | null = null;

function ship(rec: Record<string, unknown> | null): void {
  if (rec) holdDiagRecord("thread-blank", rec);
}

// The frame pump, alive exactly while a run is open. Each step takes whichever
// readings are due, then polls, and the chain ends itself once the machine goes
// idle, so an app with no run open never holds a frame callback.
function pump(): void {
  if (pumping) return;
  if (typeof requestAnimationFrame !== "function") return;
  pumping = true;
  const step = (): void => {
    const now = performance.now();
    probe.frame(now);
    ship(probe.poll(now));
    if (probe.live()) requestAnimationFrame(step);
    else pumping = false;
  };
  requestAnimationFrame(step);
}

// The pump is the fast path, but the engine can starve frame callbacks at
// exactly the moments this recorder exists for, and a run that has taken its
// readings must not be stranded in the ring by a chain that stopped being
// called. Armed with the run, re-armed while it stays open, dead with it.
function armClose(): void {
  if (closeTimer) return;
  closeTimer = setTimeout(() => {
    closeTimer = null;
    ship(probe.poll(performance.now()));
    if (probe.live()) armClose();
  }, BLANK_WAIT_MS + 250);
}

function startBlankProbe(): void {
  if (typeof document === "undefined" || document.getElementById("app") === null) return;
  const inThread = (e: Event): boolean => {
    const t = e.target as Element | null;
    if (!t) return false;
    if (t.id === "thread") return true;
    return typeof t.closest === "function" && t.closest("#thread") !== null;
  };
  document.addEventListener(
    "scroll",
    (e) => {
      const t = e.target as Element | null;
      if (!t || t.id !== "thread") return;
      probe.scrolled(performance.now());
    },
    { capture: true, passive: true },
  );
  document.addEventListener(
    "touchstart",
    (e) => {
      if (!inThread(e)) return;
      probe.touched(performance.now());
    },
    { capture: true, passive: true },
  );
}
startBlankProbe();
// =================== END TEMP DIAGNOSTIC (remove after the blank-thread session) ===================
