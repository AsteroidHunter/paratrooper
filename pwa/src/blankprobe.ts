// ===================== TEMP DIAGNOSTIC (remove after the blank-thread session) =====================
// Blank-thread probe.
//
// Failure shape, twice and not since: a photo is attached, the conversation is
// flicked upward and left gliding, and while it is still moving the photo strip
// changes height under it. The message area goes empty — the top bar and the
// compose bar stay painted the whole time — and the next touch or scroll brings
// every message straight back, with nothing refetched.
//
// The account of it named the ✕, and this probe first armed on that tap alone.
// It was widened because the account is a memory of two occurrences and cannot
// be reproduced on demand, and arming on the cancel would have caught nothing
// at all if the real trigger were the drawer OPENING — which moves the same
// edge, over the same beat, through the same settle. So every drawer height
// edge arms it now and the record says which one did, rather than the
// instrument quietly assuming the answer to its own question.
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
//   edge   the drawer edge's own handler, before it writes: the before-picture
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
// the phone simply being put down.
//
// WHICH EDGES, and why one gesture is still one run. The strip's height moves
// on five occasions, and `why` names whichever one opened the run: a photo
// cancelled, the strip appearing under the first pick, a second square growing
// it, the display finally going at the end of a close beat, and a send carrying
// every square away. Several of those land inside one gesture — a cancel ends
// on the very display change that would otherwise be its own edge — so a run
// already in flight refuses every later edge outright. One gesture, one run,
// and the beat that follows an edge is described by the run that edge started
// rather than chopped between two.
//
// ARMED ONLY ON A LIVE SCROLL. A drawer edge with the conversation standing
// still is the ordinary case and has never once failed, so a run only starts
// when a thread scroll arrived within the arming window below. The gate is
// answered before anything is read, so an edge that does not arm costs no
// layout at all — which matters more now than it did when only the ✕ could arm
// one, since picking a photo passes through here every time.
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
// flush, not an extra one. The rows are found by bisection rather than by
// walking the conversation, so the reads a reading spends grow with the height
// of the view and only logarithmically with the length of the history; the
// section below has the whole of that reasoning, and the first record this
// channel ever produced as the argument for it.
//
// TO REMOVE, every call site: delete this file and tests/blankprobe.test.ts; in
// main.ts delete the blankprobe import line, the blankProbeFollow registration
// beside watchFollowTail, the blankProbeSettle call in settleTail, and the
// three blankProbeEdge calls — the thumbnail's ✕ handler, showPending and
// dismissSent — along with the drawerSeats counter beside gapSlides and the
// wasOpen and drawerMoved lines showPending decides its edge from; in hold.ts
// delete the "thread-blank" entry with its paragraph in the
// post-now list; in web/app.py delete the "holddiag blank" digest block; and
// delete the thread-blank test in tests/test_holddiag.py. Nothing else refers
// to any of it.

import { holdDiagRecord } from "./hold";

/** a thread scroll this recently means the glide was still running under the
    edge; anything older is a drawer moving on a conversation standing still */
export const BLANK_ARM_MS = 250;

/** the scheduled moments, in ms from the edge. The edge itself and the frame
    after it are taken on sight, so they are not offsets and are not listed. */
export const BLANK_OFFSETS = [130, 400, 700] as const;

/** names, in order, for every reading a run can take */
export const BLANK_MOMENTS = ["edge", "frame", "mid", "beat", "rest", "touch", "after"] as const;

export type BlankMoment = (typeof BLANK_MOMENTS)[number];

/** every way the strip's height moves, as the record names the one that armed
    the run: a square cancelled, the strip appearing under the first pick, a
    later square growing it, the display going at the end of a close, and a send
    taking every square away */
export const BLANK_EDGES = ["cancel", "open", "grow", "shut", "sent"] as const;

export type BlankEdge = (typeof BLANK_EDGES)[number];

/** with no touch by this long after the edge the run gives up and ships without
    its pair, rather than sitting in the ring waiting for a finger */
export const BLANK_WAIT_MS = 8000;

// --- finding the band ---------------------------------------------------------
// The first record this channel produced in the wild was worthless, and the way
// it was worthless is the reason this section is written the way it is. The
// thread held 656 children, the scroll sat around the middle of its range with
// no overscroll, and every one of the seven readings said vis 0. That reads as a
// blank screen. It was not one: the walk began at the top of the list and gave
// up at a cap of five hundred, hundreds of rows short of the view, so the zero
// meant "never arrived" and was indistinguishable from "nothing there". An
// instrument that answers a question it never reached is worse than one that
// stays silent, because this one answered convincingly.
//
// So the walk no longer starts at the top. The rows of a column flex are laid
// out in document order, top to bottom, which makes their offsets monotonic in
// the index — so the band can be found by bisection and only its neighbourhood
// ever looked at. Cost is logarithmic in the conversation and linear in the
// height of the view, which is the property that matters: a long history is
// precisely the situation being measured, so nothing here may get slower as one
// accumulates.
//
// Bisection over hit testing. elementFromPoint would find the band in one call
// and need no monotonicity at all, and it was rejected: it answers with whatever
// is painted at a point, so an overlay sitting over the thread would misdirect
// it, and more to the point it leans on the hit-testing path at the moment this
// probe exists to ask whether the drawing path is sound. Geometry read off the
// layout tree does not share anything with the fault under suspicion.
//
// The monotonicity this leans on is worth stating, because it is the one thing
// that could quietly stop being true. The thread is a column flex whose rows are
// ordinary in-flow items; the only transform any of them carries is the peek's
// horizontal translate, which cannot reorder them vertically. Nothing in the
// thread is absolutely positioned. If that ever changes, the bisection lands in
// the wrong place — so it never reports a bare number: an answer it could not
// reach comes back as null with the reason beside it.

/** children one sample may resolve before it declares it could not reach an
    answer. A bisection over a two thousand message thread spends about eleven,
    a tall viewport's worth of rows about twenty, and the neighbours a handful:
    the budget is generous, and — the whole point — it does not move when the
    conversation gets longer. */
export const BAND_LOOK_CAP = 64;

/** how many boxless children the search will step over while looking for the
    row just above the band before it gives up on naming one */
export const BAND_BACK_LOOK = 6;

/** a row's vertical extent, in the same coordinates as the band it is tested
    against — viewport coordinates everywhere here, since what is being asked
    is whether the thing is where the eye was pointed */
export interface RowBox {
  top: number;
  bottom: number;
}

/**
 * Is this row something the reader could have seen?
 *
 * A row has to have height of its own, and the overlap is strict at both edges.
 * Both rules exist for one reason: a thread whose rows had collapsed to nothing
 * would still have every one of them sitting at a plausible offset, and a count
 * that took those would report a healthy conversation for the exact screen this
 * probe was built to explain.
 */
export function rowVisible(r: RowBox, top: number, bottom: number): boolean {
  return r.bottom > r.top && r.bottom > top && r.top < bottom;
}

/** how the search reads the scroller: a count of children and a way to resolve
    the laid-out rows inside one. Handed in, so the bisection is pinned on plain
    arrays and the DOM half is pinned by source. */
export interface BandSource {
  n(): number;
  /** the laid-out rows this child holds, top to bottom; empty when it holds
      none, which is what a grouping wrapper or a hidden subtree looks like */
  at(i: number): RowBox[];
}

/** why the search stopped, and whether its count may be believed */
export type BandWhy = "ok" | "empty" | "capped" | "unresolved";

export interface BandFound {
  /** rows overlapping the band — null, always, when the search did not reach an
      answer, so a zero can only ever mean the reader really had nothing to see */
  vis: number | null;
  bw: BandWhy;
  look: number; // children resolved: the cost this reading actually paid
  /** laid-out rows resolved in the band's neighbourhood: the nearest one above
      it, every one overlapping it, and the first one below. Deliberately a local
      quantity rather than a length of the conversation, which kids already
      carries for free — this one says how much the probe had in front of it when
      it answered. */
  rows: number;
  top1: number | null; // first visible row's top, relative to the band's own top
  botN: number | null; // last visible row's bottom, same coordinates
  h1: number | null; // first visible row's height
  /** The neighbourhood, which is what makes a genuine vis 0 readable at all.
      nearT is where the nearest row that is NOT below the band ends, nearB
      where the nearest row below it begins, both in the band's own coordinates,
      and nearH is the height of whichever of the two was found. A collapsed row
      sitting inside the band lands on nearT with a positive offset, which is
      why it is named for the side rather than for being above.

      Read together they separate the three things a blank screen could be:
      rows present but nowhere near the view is a scroll sitting in a hole; rows
      right against the band with no height at all is a collapsed list; rows
      right against the band at a normal height, with vis 0, is a contradiction
      worth knowing about. None of the three is an unpainted screen, which is
      the answer this probe is really trying to arrive at by elimination. */
  nearT: number | null;
  nearB: number | null;
  nearH: number | null;
}

export function findBand(
  src: BandSource,
  top: number,
  bottom: number,
  cap: number = BAND_LOOK_CAP,
): BandFound {
  let look = 0;
  const blank: BandFound = {
    vis: null, bw: "unresolved", look: 0, rows: 0,
    top1: null, botN: null, h1: null, nearT: null, nearB: null, nearH: null,
  };
  const n = src.n();
  // an empty scroller is an answer, and a plain one: there is nothing to see
  // because there is nothing there, which kids agrees with for free
  if (n <= 0) return { ...blank, vis: 0, bw: "empty" };

  const at = (i: number): RowBox[] | null => {
    if (look >= cap) return null;
    look += 1;
    return src.at(i);
  };

  // Bisection for the first child holding a row whose bottom clears the band's
  // top. Children that hold no row at all cannot answer the comparison, so the
  // probe steps forward to the next one that can; every index stepped over is
  // boxless and therefore can never be the row being looked for, which is what
  // keeps the skip from losing the answer.
  let lo = 0;
  let hi = n;
  let capped = false;
  let resolved = false;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    let j = mid;
    let got: RowBox[] | null = null;
    while (j < hi) {
      const rows = at(j);
      if (rows === null) {
        capped = true;
        break;
      }
      if (rows.length > 0) {
        got = rows;
        break;
      }
      j += 1;
    }
    if (capped) break;
    if (!got) {
      hi = mid; // nothing resolvable in [mid, hi): the answer is to the left
      continue;
    }
    resolved = true;
    if (got[got.length - 1].bottom > top) hi = j;
    else lo = j + 1;
  }
  if (capped) return { ...blank, bw: "capped", look };
  if (!resolved) return { ...blank, look }; // nothing in the list has a box

  let rows = 0;
  let nearAbove: RowBox | null = null;
  let nearBelow: RowBox | null = null;

  // the row just above the band, so a view that has landed in a gap still says
  // what is behind it
  for (let i = lo - 1, tried = 0; i >= 0 && tried < BAND_BACK_LOOK; i -= 1, tried += 1) {
    const got = at(i);
    if (got === null) return { ...blank, bw: "capped", look };
    if (got.length === 0) continue;
    rows += 1;
    nearAbove = got[got.length - 1];
    break;
  }

  // and forward from the landing index: everything overlapping, then the first
  // row past the foot, which ends the search
  const seen: RowBox[] = [];
  for (let i = lo; i < n; i += 1) {
    const got = at(i);
    if (got === null) return { ...blank, bw: "capped", look };
    let past = false;
    for (const r of got) {
      rows += 1;
      if (rowVisible(r, top, bottom)) {
        seen.push(r);
        continue;
      }
      if (r.top >= bottom) {
        nearBelow ??= r;
        past = true;
      } else if (!nearAbove || r.bottom > nearAbove.bottom) {
        nearAbove = r; // a zero-height row at the landing index still says where
      }
    }
    if (past) break;
  }

  const first = seen[0] ?? null;
  const last = seen[seen.length - 1] ?? null;
  const nearer = nearBelow && !nearAbove ? nearBelow : nearAbove;
  return {
    vis: seen.length,
    bw: "ok",
    look,
    rows,
    top1: first ? Math.round(first.top - top) : null,
    botN: last ? Math.round(last.bottom - top) : null,
    h1: first ? Math.round(first.bottom - first.top) : null,
    nearT: nearAbove ? Math.round(nearAbove.bottom - top) : null,
    nearB: nearBelow ? Math.round(nearBelow.top - top) : null,
    nearH: nearer ? Math.round(nearer.bottom - nearer.top) : null,
  };
}

/** what one moment reads off the shell. Handed in rather than reached for, the
    same split the tail-gap frame uses, so the assembly below is pinned without
    a DOM and the walk that feeds it is pinned by source. */
export interface BlankReader {
  sh(): number;
  st(): number;
  ch(): number;
  /** the search for the rows standing in the thread's own visible band, already
      resolved against it — the reader owns the band's edges because they are its
      geometry, and findBand owns everything decided from them */
  band(): BandFound;
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
  vis: number | null;
  bw: BandWhy;
  look: number;
  top1: number | null;
  botN: number | null;
  h1: number | null;
  nearT: number | null;
  nearB: number | null;
  nearH: number | null;
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
    rows: band.rows,
    vis: band.vis,
    bw: band.bw,
    look: band.look,
    top1: band.top1,
    botN: band.botN,
    h1: band.h1,
    nearT: band.nearT,
    nearB: band.nearB,
    nearH: band.nearH,
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
  /** the drawer's height is about to move. Starts a run and takes the edge
      reading, or refuses — because the conversation was not moving, or because
      a run is already describing the beat this edge belongs to; true when a run
      actually began. */
  edge(why: BlankEdge, at: number, sinceScrollMs: number): boolean;
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
  let why: BlankEdge = "cancel";
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
      why, // which of the drawer's edges opened this run
      t0: Math.round(t0),
      // whether the pair either side of the repair was actually caught; a run
      // that gave up says so rather than looking like one that had no touch
      paired: frames.some((f) => f.w === "after"),
      f: frames,
    };
  };

  return {
    edge(kind: BlankEdge, at: number, sinceScrollMs: number): boolean {
      // A cancel ends on the very display change that would otherwise be an
      // edge of its own, and a pick that opens the strip is followed by the
      // settle's own frames: a later edge inside a run belongs to the beat that
      // run is already describing, and restarting on it would throw away the
      // before-picture the run exists for.
      if (live) return false;
      if (!(sinceScrollMs >= 0) || sinceScrollMs > BLANK_ARM_MS) return false;
      why = kind;
      t0 = at;
      next = 0;
      sawFrame = false;
      repairAt = -1;
      done = false;
      frames = [];
      counts = { sc: 0, set: 0, setMoved: 0 };
      // the before-picture is the run's reason for existing: with no shell to
      // take it from there is nothing worth opening a run for
      if (!take("edge", at)) return false;
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

/** the laid-out rows one child of the thread holds, top to bottom.
 *
 * An element's client rects answer both questions at once, which is what keeps
 * this to a single read apiece: no rects at all means no box, so the child is
 * either one of the display:contents groupings the rows sit inside or a hidden
 * subtree, and the rows, if there are any, are its own children.
 *
 * The descent is one level deep, which is the shape the thread actually has —
 * groupings are flat and hold rows directly. A grouping nested deeper than that
 * would resolve to nothing here, and the search treats a child it cannot resolve
 * as a child it cannot resolve: it steps over it, and if it can never resolve
 * anything it says so rather than reporting a count it did not earn.
 */
function rowsIn(el: Element): RowBox[] {
  const own = el.getClientRects();
  if (own.length > 0) return [{ top: own[0].top, bottom: own[0].bottom }];
  const out: RowBox[] = [];
  for (const kid of Array.from(el.children)) {
    const r = kid.getClientRects();
    if (r.length > 0) out.push({ top: r[0].top, bottom: r[0].bottom });
  }
  return out;
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
      const source: BandSource = {
        n: () => thread.childElementCount,
        at: (i) => {
          const el = thread.children[i];
          return el ? rowsIn(el) : [];
        },
      };
      return findBand(source, box.top, box.bottom);
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

/** the drawer's height is about to move; sinceScrollMs is how long ago the
    thread last scrolled, and it is answered before anything is read */
export function blankProbeEdge(why: BlankEdge, sinceScrollMs: number): void {
  if (!probe.edge(why, performance.now(), sinceScrollMs)) return;
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
