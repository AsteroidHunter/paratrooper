// ===================== TEMP DIAGNOSTIC (remove after the keyboard-restore session) =====================
// The scroll writes nobody in this app made.
//
// The correction beside it (viewport.ts, restoreVerdict) takes back a position
// the thread cannot legitimately hold after a keyboard close, and the case for
// locating that unrequested write inside the engine is an argument from absence:
// every scroll writer in this app records what it wrote, and on the frame the
// scroller jumped 386px past its own end none of them had recorded anything.
// An argument from absence is exactly as good as the completeness of the list it
// is drawn from, and that list is thirteen call sites across three files. This
// channel turns it into a measurement: the app states what it asked the scroll
// to do, the position is looked at, and a move no statement of ours accounts for
// is written down with everything needed to locate it — where it went, how far
// past the end that is, whether it landed on the bottom the range had while the
// keyboard was up, what the app's last intention was and how long ago, and
// whether a gesture was under way at all.
//
// The next occurrence then reads one of two ways. `want` well behind, `wms` in
// the hundreds and `to` equal to `pre` is WebKit handing back the offset it
// remembered from before the dismissal, which is what the correction assumes.
// Anything else — a `to` matching no intention, a ghost with no keyboard close
// anywhere near it — is a writer of ours that never announced itself, and the
// record says which look caught it and what the app thought it had asked for.
//
// WHAT COUNTS AS EXPLAINED: an intention, never a recency. A write explains the
// moves that CLOSE ON WHAT IT ASKED FOR — the position is no further from the
// requested top than the last look was — for as long as one of our own rides
// could still be landing (GHOST_RIDE_MS), and it explains nothing else, however
// recently it was made. Both halves of that are load-bearing. The forgiving
// half is what an animated ride looks like from outside: the smooth pin a live
// message asks for arrives over a beat, monotonically, and a rule that wanted
// the target reached at once would call every frame of its landing a ghost. The
// strict half is the whole reason the channel can locate an unrequested move.
// On the trail the restore landed SIXTEEN MILLISECONDS after a settle of
// ours, so any rule that let a fresh write vouch for whatever happened next
// would have explained away precisely the event it exists to catch. That
// settle asked for 6151 and the scroller went to 6537; asking for one number
// does not account for another.
//
// A stale write does not explain a position by matching it either, and that
// refusal is the same point from the other side: the pin taken while the
// keyboard was up wrote exactly the number this bug hands back. It rides the
// record instead, as pre.
//
// WHICH WRITES ANNOUNCE THEMSELVES, and the two that do not. Every site in
// main.ts that puts a number into the thread's scrollTop calls in with the top
// it asked for — the settle, the bottom pin, the chevron's ride, the keep-view
// fix, the compose bar's give-up, the history drain, an out-of-order replay, the
// boot guard's re-pin and the cached thread's re-assert — and scrollghost.test
// pins that the list has no holes by walking the source for scroll writes. The
// other two are deliberately silent, and for one reason: they SAVE a value, do
// something to layout, and put the same value straight back, all inside one
// synchronous task (mirror.ts around the compose box's fit, shell.ts around the
// stuck-viewport heal's display:none reflow). A scroll event is dispatched at
// the next rendering opportunity and the looks below ride frames and scroll
// events, so no look can land between such a pair: what they leave behind is the
// number that was already there, and a write that changes nothing needs no
// explaining.
//
// WHAT IT COSTS. Nothing of its own. The looks ride two places the numbers are
// already in hand — the thread's own scroll handler, which reads them for the
// at-bottom verdict, and the post-close frames, where the correction reads them
// anyway — so there is no observer, no clock and no geometry read anywhere in
// this file. The writes are two assignments each. And an unexplained RUN is one
// record, not one per event: a scroll gesture is unexplained from the app's side
// by definition, so the first move of a run decides, the rest fold into it, and
// a run that began under a finger is not recorded at all.
//
// TO REMOVE, every call site: delete this file and tests/scrollghost.test.ts; in
// main.ts delete the scrollghost import, the ghostCtx helper, the
// scrollGhostWrite calls in settleTail, scrollToBottom, startGlide, keepView,
// autosize, drainOlder, applyReplay, armBootFrameGuard and bootFromCache's
// re-assert, and the two scrollGhostLook calls (the thread's scroll handler and
// fixCloseTail); in hold.ts delete the "scroll-ghost" entry with its paragraph
// in the post-now list; and in web/app.py drop "scroll-ghost" from the viewport
// tuple and from the ghost digest block, whose kb-restore half stays with the
// correction. Nothing else refers to any of it.

import { holdDiagRecord } from "./hold";
import { tailOverhang } from "./viewport";
import type { BottomGeometry } from "./viewport";

/** scrollTop is written in whole pixels and read back sub-pixel; a move this
    small is the engine rounding, not a move */
export const GHOST_TOL_PX = 2;

/** how long a write of ours can still be landing, and so still explain a
    position closing on the top it asked for */
export const GHOST_RIDE_MS = 1500;

/** unexplained moves closer together than this are one run, and one record */
export const GHOST_RUN_GAP_MS = 150;

/** the two questions a look asks, as plain numbers */
export interface GhostLook {
  from: number; // where the scroll stood at the previous look
  to: number; // where it stands now
  want: number; // the top the app's last write asked for; -1 = it never has
  writeMs: number; // how long ago that write was
  runMs: number; // since the last unexplained move; Infinity = no run open
  touching: boolean; // a finger is on the thread right now
}

export type GhostVerdict = "still" | "explained" | "gesture" | "run" | "ghost";

export function ghostVerdict(look: GhostLook): GhostVerdict {
  if (Math.abs(look.to - look.from) <= GHOST_TOL_PX) return "still";
  // an intention accounts for the moves that close on it, and for nothing else
  if (
    look.want >= 0 &&
    look.writeMs < GHOST_RIDE_MS &&
    Math.abs(look.to - look.want) <= Math.abs(look.from - look.want)
  ) {
    return "explained";
  }
  // the order matters: a run that began under a finger stays that run after the
  // finger lifts, so momentum and its rubber band never surface as ghosts
  if (look.runMs <= GHOST_RUN_GAP_MS) return "run";
  return look.touching ? "gesture" : "ghost";
}

/** what the app knows that the numbers do not */
export interface GhostContext {
  pre: number; // the end of the range while the keyboard was last up; -1 = none
  kms: number; // ms since that close; -1 = there has not been one
  gest: boolean; // a real gesture was under way (the intent window)
  touching: boolean; // a finger is on the thread at this instant
}

export type GhostMark = {
  at: string; // which look caught it: the scroller's own event, or a frame
  from: number;
  to: number;
  over: number; // how far past the end of the range it landed
  pre: number;
  stale: boolean; // it landed exactly on the keyboard-era bottom
  via: string; // the app's last intended write, by name; "" = there was none
  want: number;
  wms: number; // how long ago it was asked for
  kms: number;
  gest: boolean;
};

export function ghostMark(
  at: string,
  g: BottomGeometry,
  look: GhostLook,
  via: string,
  ctx: GhostContext,
): GhostMark {
  const to = Math.round(look.to);
  const pre = Math.round(ctx.pre);
  return {
    at,
    from: Math.round(look.from),
    to,
    over: Math.round(tailOverhang(g)),
    pre,
    // the accusation as a fact rather than a subtraction: the position the
    // scroller could hold before the box grew, handed back after it did
    stale: pre >= 0 && Math.abs(to - pre) <= GHOST_TOL_PX,
    via,
    want: Math.round(look.want),
    wms: Number.isFinite(look.writeMs) ? Math.round(look.writeMs) : -1,
    kms: Math.round(ctx.kms),
    gest: ctx.gest,
  };
}

export interface ScrollWatch {
  /** the app asked the scroll to end up at `top`; `via` names the writer */
  wrote(via: string, top: number): void;
  /** look at where it actually is; hands back the record when nothing explains it */
  look(at: string, g: BottomGeometry, ctx: GhostContext): GhostMark | null;
}

// A factory with an injectable clock, the shape the picker lifecycle and the
// jank machine use, so the whole lifecycle is pinned on synthetic timestamps and
// the module below is one instance of it.
export function createScrollWatch(now: () => number = () => performance.now()): ScrollWatch {
  let seen = -1; // the scrollTop as of the last look; -1 = none taken yet
  let via = "";
  let want = -1;
  let wroteAt = -Infinity;
  let runAt = -Infinity;
  return {
    wrote(name: string, top: number): void {
      via = name;
      want = top;
      wroteAt = now();
    },
    look(at: string, g: BottomGeometry, ctx: GhostContext): GhostMark | null {
      const t = now();
      if (seen < 0) {
        seen = g.st; // the first look has nothing to compare against
        return null;
      }
      const look: GhostLook = {
        from: seen,
        to: g.st,
        want,
        writeMs: t - wroteAt,
        runMs: t - runAt,
        touching: ctx.touching,
      };
      seen = g.st;
      const verdict = ghostVerdict(look);
      if (verdict === "still" || verdict === "explained") return null;
      runAt = t; // a gesture and a ghost alike keep the run open
      return verdict === "ghost" ? ghostMark(at, g, look, via, ctx) : null;
    },
  };
}

const watch = createScrollWatch();

/** the app's own scroll writes, as intentions: called at every site that writes
    the thread's scrollTop, with the top that site asked for */
export function scrollGhostWrite(via: string, top: number): void {
  watch.wrote(via, top);
}

/** one look, from a site that already holds the scroller's three numbers */
export function scrollGhostLook(at: string, g: BottomGeometry, ctx: GhostContext): void {
  const mark = watch.look(at, g, ctx);
  if (mark) holdDiagRecord("scroll-ghost", mark);
}
// =================== END TEMP DIAGNOSTIC (remove after the keyboard-restore session) ===================
