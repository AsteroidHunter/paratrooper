// ===================== TEMP DIAGNOSTIC (remove after the pick-timing session) =====================
// Pick-timing recorder. The owner reports a noticeable pause between the blue
// check in the iOS picker and the photo showing up in the tray, and nobody has
// ever measured that window, so no step of it can be named yet. This channel
// stamps the whole stretch step by step and tags each photo with what it is, so
// about ten ordinary picks are enough for the slow step to name itself.
//
// WHERE THE CLOCK STARTS, and what it can never see. Zero is the file input's
// change event: that is the first instant the app can know a file was chosen.
// Everything before it (the tap on the check mark, the picker's own dismissal,
// WebKit copying the photo out of the photo library and handing over a File)
// happens inside iOS with no callback of any kind into the page, so the app
// cannot observe it and this recorder does not pretend to. If the whole stretch
// below turns out to be small on device, the pause lives in that invisible
// stretch and belongs to iOS, and that is itself the answer. The record carries
// `from` so a log line says what its own zero was.
//
// THE STEPS, in the order the app performs them, each stamped with
// performance.now() and reported as an offset in ms from zero:
//   handler : the app's pick handler entered, so the shell-to-app hop is visible
//   meta    : the file's own facts read (type, name, byte size)
//   url     : the blob url made for the file
//   elem    : the img made, its src assigned and the pixel wait armed
//   seat    : the square inserted into the tray
//   open    : the drawer switched on and the tail settled behind it
//   sync    : the whole synchronous pick work returned
//   laid    : the frame carrying that work has been painted (see below)
//   decode  : the pixel wait settled, so the photo is decoded
//   reveal  : the placeholder came off the square
//   paint   : the frame carrying the picture has been painted (see below)
// Total is the paint offset: check mark seen by the app, to picture on screen.
//
// WHY laid AND paint ARE DOUBLE ANIMATION FRAMES rather than a guess. A frame
// callback registered now runs BEFORE the next frame is painted, so its own
// timestamp is too early to claim anything is on screen. The callback after it
// runs at the start of the frame after that, by which time the frame carrying
// the change has been painted. Two frames is therefore the earliest honest
// moment, and it is a clock read, not a measurement of pixels.
//
// FILE FACTS, one entry per file in the pick: kind, byte size, and the pixel
// dimensions once the decode reports them. The owner wants camera shots told
// apart from screenshots; kind plus w and h is the honest way to do that
// without inventing a classifier, since a screenshot arrives as a png at the
// screen's own pixel size while a camera shot arrives as heic or jpeg at the
// sensor's, and bytes separates them again by an order of magnitude. Note that
// kind is what ARRIVED: iOS may transcode a library heic to jpeg on the way in,
// so this names the file the app was handed, not the one in the library.
//
// BLOCKED TIME. The stretch is mostly waiting, so the record has to say whether
// the main thread was actually held. Two push-based sources, neither of which
// reads anything: the activity ledger in jankledger.ts, reused exactly as it
// stands (it is built to take stamps from any path and this file only adds
// them), and a longtask observer. The scroll-jank recorder keeps its longtask
// entries private to itself, and prying them out would mean changing a file
// this session is not allowed to change, so a second observer runs here; two
// observers on the same entry type cost nothing between deliveries.
//
// CLOCK-ONLY, like the scroll-jank recorder and for the same reason: an
// instrument that reads geometry cannot time a path without disturbing it.
// There is no layout read of any kind in this file, and no DOM access at all:
// the machine takes plain numbers and the file facts arrive as three
// primitives, so picktiming.test.ts pins the property by source.
//
// ONE RECORD PER PICK, on the "pick-timing" channel, which is what keeps ten
// picks readable inside the digest's twenty-record clip. A pick that chooses
// several photos at once still ships one record: every step keeps its FIRST
// stamp, so the timeline describes the first photo to reach the screen, and nf
// says how many came with it. A photo removed or sent before it draws never
// reaches its reveal and ships nothing; the next pick's start clears it away.
//
// TO REMOVE, every call site: delete this file and tests/picktiming.test.ts; in
// shell.ts delete the picktiming import and the pickTimingStart line at the top
// of the change listener in bindInputSignals; in main.ts delete the picktiming
// import line, the "handler" and "sync" steps and the pickTimingLaid call in
// the bindPicker callback, the "open" step in showPending, the pickTimingFile
// call, the "url", "elem", "seat", "decode" and "reveal" steps, the
// pickTimingDims call and the pickTimingPainted call in stagePick, and the two
// jankSpan pairs named "pick-sync" and "pick-open" (the naturalSize read beside
// pickTimingDims goes with them); in hold.ts delete the "pick-timing"
// entry with its paragraph in the post-now list; in web/app.py delete the
// "holddiag pick" digest block; and delete the pick-timing test in
// tests/test_holddiag.py. Nothing else refers to any of it. One ordering note
// for whoever removes things: this file imports jankledger.ts, so it must go
// before or together with the scroll-jank block that owns that file.

import { holdDiagRecord } from "./hold";
import { jankStamps } from "./jankledger";
import type { JankStamp } from "./jankledger";

/** the steps, in the order the app performs them; the record's keys follow this */
export const PICK_STEPS = [
  "handler",
  "meta",
  "url",
  "elem",
  "seat",
  "open",
  "sync",
  "laid",
  "decode",
  "reveal",
  "paint",
] as const;

export type PickStep = (typeof PICK_STEPS)[number];

/** the file facts serve two questions at once: how big the job was, and what
    kind of photo it was. kind and bytes come from the file itself; w and h
    arrive later, from the decode. A png at the screen's own size is a
    screenshot; a heic or jpeg at sensor size is a camera shot. */
export interface PickFacts {
  kind: string;
  bytes: number;
  w?: number;
  h?: number;
}

/** the slice of a File this recorder reads: three primitives, nothing else, so
    nothing here can touch layout and the tests need no DOM */
export interface PickFile {
  type: string;
  name: string;
  size: number;
}

const FILE_KEEP = 8; // facts held per pick; nf still counts them all
const TASK_KEEP = 32; // longtask entries held; at 50ms apiece this spans seconds
const LED_KEEP = 6; // ledger names carried, heaviest first

/** what the app was handed, named from the mime type first and the file name
    second, since iOS sometimes hands over a file with an empty type */
export function pickKind(type: string, name: string): string {
  const t = (type || "").toLowerCase();
  const n = (name || "").toLowerCase();
  const is = (mime: string, ...exts: string[]): boolean =>
    t.includes(mime) || exts.some((e) => n.endsWith(e));
  if (is("heic", ".heic")) return "heic";
  if (is("heif", ".heif")) return "heif";
  if (is("jpeg", ".jpg", ".jpeg") || t.includes("jpg")) return "jpeg";
  if (is("png", ".png")) return "png";
  if (is("gif", ".gif")) return "gif";
  if (is("webp", ".webp")) return "webp";
  if (t.startsWith("video/")) return "video";
  return t || "other";
}

export interface PickClock {
  /** the change event: zero for everything below */
  start(t: number): void;
  /** stamp one step; the first stamp of a name wins, later ones are ignored */
  step(name: PickStep, t: number): void;
  /** one file of this pick, with its facts; also stamps meta */
  file(f: PickFile, t: number): void;
  /** the pixel size of the first file, once the decode has reported it */
  dims(w: number, h: number): void;
  /** one longtask observer entry (startTime, duration) */
  longtask(start: number, dur: number): void;
  /** a pick is being timed right now */
  open(): boolean;
  /** stamp paint and close: the finished record, or null when there is none */
  finish(t: number): Record<string, unknown> | null;
}

// Pure state machine in the scroll-jank and shell mold: timestamps in, one
// record out, injectable ledger, no timers of its own and nothing of the
// document touched, so the whole lifecycle is unit-tested with plain numbers.
export function createPickClock(
  ledger: () => readonly JankStamp[] = jankStamps,
): PickClock {
  let live = false;
  let t0 = 0;
  let picks = 0;
  let nf = 0;
  let facts: PickFacts[] = [];
  let marks = new Map<PickStep, number>();
  const tasks: { s: number; d: number }[] = []; // lifetime ring, like the ledger
  let taskCursor = 0;

  const overlap = (aStart: number, aEnd: number, bStart: number, bEnd: number): number =>
    Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));

  // Built at the paint, which is the one moment everything is in: the ledger
  // and the longtask observer are both push-based, and by the paint every span
  // and every entry that overlapped the stretch has been delivered.
  const build = (end: number): Record<string, unknown> => {
    picks += 1;
    const s: Record<string, number> = {};
    for (const name of PICK_STEPS) {
      const at = marks.get(name);
      if (at !== undefined) s[name] = Math.round(at - t0);
    }
    let lt = 0;
    let long = 0;
    for (const task of tasks) {
      const inside = overlap(task.s, task.s + task.d, t0, end);
      if (inside > 0) {
        lt += inside;
        long += 1;
      }
    }
    const byName = new Map<string, number>();
    for (const span of ledger()) {
      const inside = overlap(span.start, span.end, t0, end);
      if (inside > 0) byName.set(span.name, (byName.get(span.name) ?? 0) + inside);
    }
    let ledMs = 0;
    for (const ms of byName.values()) ledMs += ms;
    const led: [string, number][] = [...byName.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, LED_KEEP)
      .map(([name, ms]) => [name, Math.round(ms)]);
    const blk: Record<string, unknown> = {
      lt: Math.round(lt),
      long,
      ledMs: Math.round(ledMs),
    };
    if (led.length > 0) blk.led = led;
    return {
      n: picks,
      from: "input-change", // the app's earliest sight of the confirm; see the banner
      t0: Math.round(t0),
      total: Math.round(end - t0),
      s,
      nf,
      f: facts,
      blk,
    };
  };

  return {
    start(t: number): void {
      live = true;
      t0 = t;
      nf = 0;
      facts = [];
      marks = new Map();
    },
    step(name: PickStep, t: number): void {
      if (!live || marks.has(name)) return;
      // A stamp older than this pick's own zero came from the pick before it: a
      // frame callback armed by the last pick can still be in the queue when a
      // new one starts. Dropping it here is what makes a negative offset
      // impossible, so the timeline can only ever read forwards.
      if (t < t0) return;
      marks.set(name, t);
    },
    file(f: PickFile, t: number): void {
      if (!live) return;
      nf += 1;
      if (facts.length < FILE_KEEP) {
        facts.push({ kind: pickKind(f.type, f.name), bytes: f.size });
      }
      if (!marks.has("meta")) marks.set("meta", t);
    },
    dims(w: number, h: number): void {
      if (!live || facts.length === 0) return;
      if (facts[0].w !== undefined) return; // the first photo's, like every other step
      facts[0].w = w;
      facts[0].h = h;
    },
    longtask(s: number, d: number): void {
      const entry = { s, d };
      if (tasks.length < TASK_KEEP) tasks.push(entry);
      else tasks[taskCursor] = entry;
      taskCursor = (taskCursor + 1) % TASK_KEEP;
    },
    open(): boolean {
      return live;
    },
    finish(t: number): Record<string, unknown> | null {
      // a change event that brought no file, or a pick whose square left the
      // tray before it drew, has nothing to say and ships nothing
      if (!live || nf === 0) return null;
      if (!marks.has("paint")) marks.set("paint", Math.max(t, t0));
      live = false;
      return build(marks.get("paint") as number);
    },
  };
}

// --- wiring (real shell only; node and vitest drive the machine directly) -----
// One clock for the app's life, since one pick is timed at a time and a fresh
// start clears whatever the last one left behind. Every export below is a
// stamp: it assigns numbers and returns, so no call site's control flow can
// depend on it and none of them can fail.
const clock = createPickClock();

/** the file input's change event fired: the app's first sight of the confirm */
export function pickTimingStart(t: number = performance.now()): void {
  clock.start(t);
}

export function pickTimingStep(name: PickStep, t: number = performance.now()): void {
  clock.step(name, t);
}

export function pickTimingFile(f: PickFile, t: number = performance.now()): void {
  clock.file(f, t);
}

export function pickTimingDims(w: number, h: number): void {
  clock.dims(w, h);
}

// the two frame stamps. The second callback runs after the frame carrying the
// change was painted, which is the earliest the app may honestly say it is on
// screen (the banner has the whole reason). Armed only while a pick is being
// timed, so neither of these ever adds a frame callback to an idle app.
function afterPaintedFrame(then: (t: number) => void): void {
  if (typeof requestAnimationFrame !== "function") return;
  requestAnimationFrame(() => requestAnimationFrame((ts) => then(ts)));
}

/** the synchronous pick work is done: stamp the frame that carries its layout */
export function pickTimingLaid(): void {
  if (!clock.open()) return;
  afterPaintedFrame((ts) => clock.step("laid", ts));
}

/** the placeholder is off the square: stamp the frame that carries the picture,
    then close the pick and ship its one record */
export function pickTimingPainted(): void {
  if (!clock.open()) return;
  afterPaintedFrame((ts) => {
    clock.step("paint", ts);
    const rec = clock.finish(ts);
    if (rec) holdDiagRecord("pick-timing", rec);
  });
}

// longtask entries are push-based and cost nothing between deliveries, so the
// observer runs for the app's whole life; buffered picks up entries from before
// it started too. An engine without the type lands in the catch and the
// record's blocked fields simply stay at zero.
function startPickTiming(): void {
  if (typeof document === "undefined" || document.getElementById("app") === null) return;
  if (typeof PerformanceObserver === "undefined") return;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) clock.longtask(entry.startTime, entry.duration);
    }).observe({ type: "longtask", buffered: true });
  } catch {
    /* no longtask on this engine: the step offsets carry the verdict alone */
  }
}
startPickTiming();
// =================== END TEMP DIAGNOSTIC (remove after the pick-timing session) ===================
