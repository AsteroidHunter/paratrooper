// The playground's wiring: the part main.ts owns in the real app.
//
// It is deliberately the SAME shape as main.ts's spring seam (that file's lines
// around measureSpring / applySpring / springPump / armSpring / springFinger /
// liftSpring), because the shape is load-bearing:
//
//   - geometry is read ONCE per gesture, never per frame;
//   - scrollTop is read once per animation frame, and the scroll event is only
//     a wake-up, because a phone delivers scroll late and sparsely;
//   - the end-spring's modelled overscroll is ADDED to the position the field
//     reads, so a rubber band reaches the field as ordinary scrolling;
//   - each displacement is written as the compositor-only `translate` longhand,
//     and a row whose value has not changed is not written again;
//   - a settled thread carries no inline translate at all and schedules no
//     frames.
//
// What main.ts has that this does not: the hold-off (springBlocked) and the
// scroll-ownership era (springown.ts). Both exist to keep the field out of the
// way of motions the APP owns - send flights, pins, keyboard lifts, the resume
// landing. This tool has no such motions: the only thing that moves the
// scroller is the reader, or one of the scripted gestures below, which drives
// the very same handlers. Nothing boots, authenticates, fetches or registers a
// worker.

import "./bubbles.css";
import "./tool.css";
import { buildThread, laidOutRows } from "./thread";
import { createTunedSpringField } from "./springfield";
import { createEndSpring } from "./vendor/endspring";
import { createTravellingSettle } from "./travelsettle";
import { createRipple } from "./ripple";
import { createCarry } from "./carry";
import { openGesture, takesScrollBack } from "./gesture";
import type { ScrollReading } from "./gesture";
import type { SpringRow } from "./vendor/springscroll";
import { defaultTuning, exportTuning, importTuning } from "./tuning";
import type { Tuning } from "./tuning";
import { mountControls } from "./controls";
import type { DemoKind, Frame } from "./controls";
import { configFor, hasReferenceLag } from "./presets";
import type { SpringEngine, EndModel } from "./engine";
import { createHistoryEnd, createHistorySpring } from "./history/adapters";
import { mountDrawer } from "./drawer";
import { registerPlaygroundWorker } from "./install";

const STORE_KEY = "bubble-animation-tool.tuning.v2";

/** the desktop drag has no engine momentum behind it, so the tool supplies one:
    scroll speed decays with this time constant after the button comes up */
const COAST_TAU_MS = 325;

const thread = document.getElementById("thread") as HTMLElement;
const stage = document.getElementById("stage") as HTMLElement;
const appVer = document.getElementById("appver") as HTMLElement;
const panelRoot = document.getElementById("panelbody") as HTMLElement;
const panelEl = document.getElementById("panel") as HTMLElement;
const panelToggle = document.getElementById("paneltoggle") as HTMLButtonElement;
const panelClose = document.getElementById("panelclose") as HTMLButtonElement;
const scrim = document.getElementById("scrim") as HTMLElement;

// ---- tuning ------------------------------------------------------------------
// ONE object for the life of the page. The panel keeps a reference to it, the
// field and the settle read it every frame, so it is written in place and never
// replaced - a reset copies values in rather than handing out a new object.
const tuning = defaultTuning();

function applyTuning(next: Tuning): void {
  Object.assign(tuning.field, next.field);
  Object.assign(tuning.travel, next.travel);
  Object.assign(tuning.ripple, next.ripple);
  tuning.config = next.config;
}

/** what this file stored before the build picker existed, when the only choice
    was the two modes. Read only when there is no v2 value, and never written. */
const STORE_KEY_V1 = "bubble-animation-tool.tuning.v1";

const stored = (() => {
  try {
    // v2 first and on its own: a reader who has used the picker has a v2 value,
    // and an older v1 value left beside it is history, not a preference. The
    // fallback only ever fires for someone who used version one and has not
    // touched this one, whose two modes importTuning still understands.
    const now = window.localStorage.getItem(STORE_KEY);
    if (now !== null) return now;
    return window.localStorage.getItem(STORE_KEY_V1);
  } catch {
    return null;
  }
})();
if (stored) {
  const loaded = importTuning(stored);
  if (loaded) applyTuning(loaded);
}
function save(): void {
  try {
    window.localStorage.setItem(STORE_KEY, exportTuning(tuning));
  } catch {
    /* private mode, a full quota: the tool works fine without it */
  }
}

// ---- the models --------------------------------------------------------------
// The current build's field reads its numbers live, so a slider moving mid-drag
// never costs a gesture. A HISTORICAL field cannot: those factories freeze their
// constants at construction, exactly as the app built them, and the honest way
// to serve a moved slider is to build the field again rather than to reach
// inside a copy that must stay byte-identical. So the swap is explicit, and it
// waits for a quiet moment (ensureEngine) rather than cutting a live gesture in
// half.
const liveField = createTunedSpringField(() => tuning.field);
const travel = createTravellingSettle();
const ripple = createRipple();
let engine: SpringEngine = liveField;
let endSpring: EndModel = createEndSpring();
/** the numbers the current engine was BUILT with, so a change can be spotted */
let builtWith = { config: tuning.config, tau: 0, divisor: 0, strain: 0 };
let enginePending = false;

/** true while the current build is the one this tool was written around: only
    then is there a vertex and a window for the travelling settle to read */
function onCurrentField(): boolean {
  return engine === liveField;
}

function buildEngine(): void {
  const entry = configFor(tuning.config);
  builtWith = {
    config: tuning.config,
    tau: tuning.field.tau,
    divisor: tuning.field.divisor,
    strain: tuning.field.strain,
  };
  enginePending = false;
  if (entry.spring === "current") {
    engine = liveField;
    endSpring = createEndSpring();
  } else {
    engine = createHistorySpring(entry, {
      tau: tuning.field.tau,
      divisor: tuning.field.divisor,
      strain: tuning.field.strain,
    });
    endSpring = createHistoryEnd(entry);
  }
  travel.reset();
  ripple.reset();
  engine.measure(rowBoxes);
}

/** a historical field whose sliders have moved is rebuilt the moment nothing is
    in the air; the current field needs none of this */
function ensureEngine(): void {
  if (!enginePending || onCurrentField()) return;
  if (engine.armed() || engine.active() || endSpring.active()) return;
  buildEngine();
}

// ---- the row table -----------------------------------------------------------
let rowEls: HTMLElement[] = [];
let rowBoxes: SpringRow[] = [];
let applied = new Set<number>();
let written = new Map<number, string>();
let threadTop = 0;
let clientH = 0;
let maxScroll = 0;
let dirty = true;

function measure(): void {
  rowEls = laidOutRows(thread);
  written = new Map(); // nothing is known-written on a fresh reading
  threadTop = thread.getBoundingClientRect().top;
  clientH = thread.clientHeight;
  // offsetTop and offsetHeight are layout, so a translate cannot move them and
  // the seats are honest whenever this runs. scrollHeight is NOT: a row
  // carrying a downward translate inflates it, and the end marker would then
  // move under the end model. So the limit is only re-read when the thread is
  // actually sitting flat, and the last flat reading stands until it is.
  if (applied.size === 0) maxScroll = Math.max(thread.scrollHeight - thread.clientHeight, 0);
  rowBoxes = rowEls.map((el) => ({ top: el.offsetTop, height: el.offsetHeight }));
  engine.measure(rowBoxes);
  dirty = false;
}

// ---- writing -----------------------------------------------------------------
// The compositor-only longhand, and no write for a row whose value has not
// changed. A settled thread ends with no inline translate anywhere.
function applyDisplacements(disp: Map<number, number>): void {
  for (const [i, dy] of disp) {
    const el = rowEls[i];
    if (!el) continue;
    const px = `0 ${dy.toFixed(2)}px`;
    if (written.get(i) === px) continue;
    written.set(i, px);
    el.style.translate = px;
  }
  for (const i of applied) {
    if (disp.has(i)) continue;
    written.delete(i);
    const el = rowEls[i];
    if (!el) continue;
    el.style.removeProperty("translate");
    if (!el.getAttribute("style")) el.removeAttribute("style");
  }
  applied = new Set(disp.keys());
}

// ---- continuity across a live change -----------------------------------------
// carry.ts owns it: what is on screen minus what the new numbers want, decayed
// rather than stepped. Sliders, the mode switch and a gesture opening on rows
// that are still off their seats all go through this one door.
const carry = createCarry();

function noteChange(): void {
  carry.note();
  // a historical field froze its constants when it was built, so a moved slider
  // only reaches it through a rebuild
  if (
    !onCurrentField() &&
    (tuning.field.tau !== builtWith.tau ||
      tuning.field.divisor !== builtWith.divisor ||
      tuning.field.strain !== builtWith.strain)
  ) {
    enginePending = true;
    ensureEngine();
  }
  save();
  pump();
}

/** the picker moved: a different build is a different field, and swapping one
    under a running gesture would be a lie about what is on screen */
function noteConfig(): void {
  freezeAll();
  buildEngine();
  save();
  paintReadout();
}

// ---- the desktop coast -------------------------------------------------------
let coast: { v: number; last: number } | null = null;

function startCoast(v: number, now: number): void {
  if (Math.abs(v) < 0.06) return;
  coast = { v, last: now };
}

function stepCoast(now: number): void {
  if (!coast) return;
  const dt = Math.max(now - coast.last, 0);
  coast.last = now;
  const before = thread.scrollTop;
  thread.scrollTop = before + coast.v * dt;
  coast.v *= Math.exp(-dt / COAST_TAU_MS);
  // the end was reached and the position refused to move: the coast is spent,
  // and whatever is left of it belongs to the end model, not to this
  if (Math.abs(coast.v) < 0.02 || (dt > 0 && thread.scrollTop === before && coast.v !== 0)) coast = null;
}

// ---- the pump ----------------------------------------------------------------
let raf = 0;
let lastPumpMs: number | null = null;
let lastReadout = 0;

function needsFrames(): boolean {
  return (
    engine.active() ||
    endSpring.active() ||
    travel.active() ||
    ripple.active() ||
    carry.active() ||
    coast !== null ||
    script !== null
  );
}

function pump(): void {
  if (raf) return;
  raf = requestAnimationFrame(step);
}

function step(now: number): void {
  raf = 0;
  if (dirty) measure();
  ensureEngine();
  const dt = lastPumpMs === null ? 0 : Math.max(now - lastPumpMs, 0);
  lastPumpMs = now;

  if (script) runScript(now);
  stepCoast(now);

  // END-SPRING SEAM: the modelled overscroll is 0 unless the thread is sitting
  // on an end, and it is ADDED to the position, so a bounce reaches the field as
  // ordinary scrolling. Which end model runs is the selected build's own - the
  // four oldest builds had none at all and their ends simply stop.
  const over = endSpring.frame(now, thread.scrollTop, maxScroll, clientH);
  const st = thread.scrollTop + over;
  engine.frame(now, st);
  // what the pump has read, kept so a gesture opening into a scroll that is
  // ALREADY moving can be given the speed it actually has rather than starting
  // from a lone baseline (gesture.ts explains why that matters for a wheel)
  recent.push({ t: now, s: st });
  if (recent.length > 2) recent.shift();

  const placed = engine.displacements();
  // While the current field is on, the travelling settle is advanced on EVERY
  // frame whichever of the two is showing, so they are always in step and the
  // buttons blend rather than restart. A historical build has no vertex and no
  // window to give it, and the settle is an experiment ON the current field, so
  // it is stood down rather than fed something it was not built for.
  // The two experiments both ride ON the current field, so both are advanced on
  // EVERY current-field frame, whichever is showing, and they stay in step with
  // the drive rather than restarting when the reader turns to one. A historical
  // build has no vertex and no window to give them, so they are stood down.
  let travelled: Map<number, number> | null = null;
  let rippled: Map<number, number> | null = null;
  if (onCurrentField()) {
    const win = liveField.window();
    const common = {
      nowMs: now,
      dt,
      fieldLag: liveField.lag(),
      phase: liveField.phase(),
      vertexY: liveField.vertex(),
      scrollTop: st,
      clientH: liveField.viewport() || clientH,
      rows: rowBoxes,
      lo: win ? win.lo : 0,
      hi: win ? win.hi : -1,
    };
    travelled = travel.frame({ ...common, tune: tuning.travel, field: tuning.field });
    rippled = ripple.frame({ ...common, tune: tuning.ripple, field: tuning.field });
  } else {
    if (travel.active()) travel.reset();
    if (ripple.active()) ripple.reset();
  }

  const shown =
    tuning.config === "travelling" && travelled !== null
      ? travelled
      : tuning.config === "ripple" && rippled !== null
        ? rippled
        : placed;
  applyDisplacements(carry.blend(shown, dt));

  if (now - lastReadout > 90) {
    lastReadout = now;
    paintReadout();
  }
  if (needsFrames()) pump();
  else {
    lastPumpMs = null;
    paintReadout();
  }
}

function paintReadout(): void {
  const entry = configFor(tuning.config);
  // the two experiments both report a released/waiting front; a built-in build
  // reports its own phase and reference lag. `staged` is whichever experiment is
  // on screen, or null for a real build.
  const staged =
    tuning.config === "travelling" ? travel : tuning.config === "ripple" ? ripple : null;
  // the bar's version line, where the app puts APP_VERSION: the build actually
  // running, so the shell never says 0.3.151 over 0.3.121's springs
  appVer.textContent = entry.experimental ? entry.label.toLowerCase() : `v${entry.version}`;
  const moving = applied.size;
  const name = entry.experimental ? entry.label.toLowerCase() : `v${entry.version}`;
  const phase = staged ? staged.state() : engine.phase();
  const lag = staged ? staged.signal() : engine.lag();
  const named = staged === null && hasReferenceLag(entry);
  const front = staged ? staged.front() : { released: 0, total: 0 };
  panel.readout(
    `${name} · ${phase} · ` +
      `${named ? "reference lag" : "largest offset"} ${lag.toFixed(1)} px · ` +
      (staged
        ? `${front.released}/${front.total} rows released, ${Math.round(staged.spread().max)} ms still to wait`
        : named
          ? "one reference for every row"
          : "a spring of its own for every row") +
      ` · ${moving} row${moving === 1 ? "" : "s"} off its seat`,
  );
}

// ---- gestures ----------------------------------------------------------------
// main.ts's armSpring / springFinger / liftSpring, minus the hold-off.
let fingerY: number | null = null;
// the last two positions the pump read, and when a real gesture act last
// happened. Both feed gesture.ts, which owns the rule.
let recent: ScrollReading[] = [];
let lastGestureAt = -Infinity;

function armSpring(touchY: number | null, fingerDown: boolean): void {
  fingerY = touchY;
  // A gesture opening on rows that are still off their seats. The field's own
  // park covers the case where it is still armed (the vertex stands until the
  // new finger really drags), but the travelling settle outlives the field: its
  // spring can still be running after the lag has reached rest and the gesture
  // was dropped. Re-seating the vertex under a new finger then moves every row
  // at once, which is the one thing the park exists to prevent. Reconciling
  // takes the difference and decays it instead.
  if (!engine.armed() && applied.size > 0) carry.note();
  if (dirty || !engine.armed()) measure();
  ensureEngine();
  // A FRESH gesture, decided before openGesture is told anything. A wheel
  // re-arms on every tick, and the two things that follow both turn on this.
  const freshGesture = !engine.armed();
  const openAt = thread.scrollTop + endSpring.over();
  openGesture(engine, {
    clientH,
    threadTop,
    anchorScreenY: touchY,
    fingerDown,
    nowMs: performance.now(),
    scrollTop: openAt,
    recent,
  });
  // A build whose arm step takes the delta reference gets it HERE, inside the
  // handler, and ONLY when the gesture is new.
  //
  // THE SECOND HALF IS A FIXTURE ADAPTATION AND IS LABELLED AS ONE. 0.3.121's
  // armSpring re-took that reference on every arm, and a wheel arms on every
  // tick. An independent observer ran the untouched module through that exact
  // sequence on real Chromium events and measured what this tool measured: a
  // passive wheel handler sees an ALREADY-ADVANCED scrollTop (a wheel at 10362
  // followed by a scroll at 10362), so the reference is re-taken at the very
  // position the next frame will report, the delta between them is nothing, and
  // 480 px of wheel moves no row at all. That is the old controller's own
  // behaviour under today's wheel delivery, not a defect in its physics and not
  // a mistake in the copy - the pointer path, which arms once and then moves
  // the scroll itself, was never affected.
  //
  // So this is not a faithful replay of that controller on a wheel. It is the
  // admission rule the WIRING applies so the entry is usable here, in the same
  // place and for the same reason gesture.ts already adapts wheel admission for
  // the current field: a fresh gesture takes a reference, a continuing one
  // keeps the one it has. presets.ts says so on the entry itself.
  if (freshGesture) engine.rebase?.(openAt);
  endSpring.begin(fingerDown, touchY);
  pump();
}

function springFinger(touchY: number): void {
  if (!engine.armed()) armSpring(touchY, true);
  engine.anchor(touchY);
  endSpring.finger(touchY);
  fingerY = touchY;
  if (engine.armed()) pump();
}

function liftSpring(): void {
  endSpring.lift();
  engine.lift();
  // a finger that pulled past the end and then held still lets the lag melt, so
  // the field disarms and the bounce that is about to run would move nothing
  if (endSpring.active() && !engine.armed()) armSpring(fingerY, false);
  if (engine.armed() || endSpring.active()) pump();
}

function freezeAll(): void {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  lastPumpMs = null;
  coast = null;
  engine.freeze();
  endSpring.freeze();
  travel.reset();
  ripple.reset();
  carry.reset();
  recent = [];
  applyDisplacements(new Map());
}

// every real gesture act stamps the clock a bare scroll event is judged against
function noteGesture(): void {
  lastGestureAt = performance.now();
}

// touch: the phone path, wired exactly as main.ts wires it
thread.addEventListener(
  "touchstart",
  (e) => {
    cancelScript();
    coast = null;
    noteGesture();
    armSpring(e.touches[0].clientY, true);
  },
  { passive: true },
);
thread.addEventListener(
  "touchmove",
  (e) => {
    noteGesture();
    springFinger(e.touches[0].clientY);
  },
  { passive: true },
);
const touchEnd = (): void => liftSpring();
thread.addEventListener("touchend", touchEnd);
thread.addEventListener("touchcancel", touchEnd);

// A wheel has no finger: the field anchors on the viewport centre, exactly as
// main.ts arms it. The tick fires BEFORE the browser applies the scroll, which
// is what makes a gesture opened here able to measure the travel that tick is
// about (gesture.ts).
thread.addEventListener(
  "wheel",
  () => {
    cancelScript();
    coast = null;
    noteGesture();
    armSpring(null, false);
  },
  { passive: true },
);

// The scroll event is a wake-up, and the one place a DROPPED gesture is taken
// back. A no-finger gesture disarms itself on the first quiet frame while the
// lag is still at rest, and a desktop delivers scroll updates at about half the
// frame rate, so a wheel or a scrollbar drag can lose its gesture in the middle
// of a scroll that is plainly still moving. main.ts has springown.ts deciding
// whose motion an event is, because the app has its own writes to tell apart;
// here the only writer is the reader, so the question is just whether a real
// gesture act happened recently (gesture.ts takesScrollBack).
thread.addEventListener("scroll", () => {
  // a scripted gesture drives the handlers itself and writes the scroll itself;
  // its own events must not re-open anything behind its back
  if (
    script === null &&
    takesScrollBack({
      armed: engine.armed(),
      fingerDown: dragging,
      nowMs: performance.now(),
      lastGestureAt,
    })
  ) {
    armSpring(fingerY, false);
  }
  if (engine.armed() || endSpring.active()) pump();
});

// desktop drag: press and pull the transcript the way a thumb would. The real
// app gives a non-touch pointer the no-finger path (a scrollbar drag), which is
// right for the app and useless for feeling a braked stop, so a press INSIDE the
// content is treated here as a finger - same handlers, same braking rule - while
// a press on the scrollbar keeps the app's own behaviour.
let dragging = false;
let dragLastY = 0;
let dragLastT = 0;
let dragVel = 0;

thread.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "touch") return; // the touch handlers own that path
  cancelScript();
  coast = null;
  noteGesture();
  // a press on the scrollbar gutter is not a grab of the content
  const onScrollbar = e.clientX > thread.getBoundingClientRect().left + thread.clientWidth;
  if (onScrollbar) {
    armSpring(e.clientY, false);
    return;
  }
  dragging = true;
  dragLastY = e.clientY;
  dragLastT = performance.now();
  dragVel = 0;
  thread.setPointerCapture(e.pointerId);
  thread.classList.add("grabbing");
  armSpring(e.clientY, true);
  e.preventDefault();
});

thread.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  noteGesture();
  const now = performance.now();
  const dy = e.clientY - dragLastY;
  // 1:1, the content follows the pointer: pulling DOWN shows older messages
  thread.scrollTop -= dy;
  const dt = now - dragLastT;
  if (dt > 0) {
    const v = -dy / dt; // px/ms of scrollTop
    dragVel = dragVel === 0 ? v : dragVel * 0.6 + v * 0.4;
  }
  dragLastY = e.clientY;
  dragLastT = now;
  springFinger(e.clientY);
});

const dragEnd = (e: PointerEvent): void => {
  if (!dragging) return;
  dragging = false;
  thread.classList.remove("grabbing");
  if (thread.hasPointerCapture(e.pointerId)) thread.releasePointerCapture(e.pointerId);
  // a press that ended a while after the last move was a hold, not a flick
  if (performance.now() - dragLastT < 90) startCoast(dragVel, performance.now());
  liftSpring();
  pump();
};
thread.addEventListener("pointerup", dragEnd);
thread.addEventListener("pointercancel", dragEnd);

// ---- the repeatable gestures -------------------------------------------------
// Scripted, but not simulated: every stage below calls the same armSpring /
// springFinger / liftSpring the finger and the pointer call, and moves the same
// scrollTop, so the field sees a gesture it cannot tell from a real one. The
// point is repeatability - same place, same speed, same stop - so two settings
// can be compared instead of remembered.
const DEMO_SPEED = 1.5; // px/ms of scrollTop: a firm, ordinary drag
const DEMO_HOLD_MS = 900; // long enough for the slowest legal settle to finish
const DEMO_COAST_MS = 260; // how long a flick coasts before the catch

interface Script {
  kind: DemoKind;
  stage: number;
  started: boolean;
  stageAt: number;
  scroll0: number;
  finger0: number;
  travelPx: number;
  driveMs: number;
}
let script: Script | null = null;

function cancelScript(): void {
  if (!script) return;
  script = null;
  panel.demoBusy(false);
}

function startDemo(kind: DemoKind): void {
  freezeAll();
  measure();
  const travelPx = Math.min(420, Math.max(clientH * 0.5, 120));
  const driveMs = travelPx / DEMO_SPEED;
  // start in the middle of the thread, so neither direction runs out of room
  thread.scrollTop = Math.round(maxScroll * 0.5);
  const down = kind === "down";
  const finger0 = down ? clientH * 0.2 : kind === "reverse" ? clientH * 0.62 : clientH * 0.8;
  script = {
    kind,
    stage: 0,
    started: false, // the first frame stamps the clock and lands the finger
    stageAt: 0,
    scroll0: thread.scrollTop,
    finger0,
    travelPx,
    driveMs,
  };
  panel.demoBusy(true);
  pump();
}

/** one frame of a scripted gesture; writes scrollTop and drives the handlers */
function runScript(now: number): void {
  const s = script;
  if (!s) return;
  if (!s.started) {
    s.started = true;
    s.stageAt = now;
    s.scroll0 = thread.scrollTop;
    armSpring(threadTop + s.finger0, true);
    springFinger(threadTop + s.finger0);
    return;
  }
  const t = now - s.stageAt;
  const nextStage = (): void => {
    s.stage += 1;
    s.stageAt = now;
    s.scroll0 = thread.scrollTop;
  };
  // one leg of a drag: scrollTop moves at DEMO_SPEED and the finger moves with
  // it, which is what a 1:1 drag is
  const drive = (dir: 1 | -1, fromFinger: number, ms: number): void => {
    const gone = Math.min(t, ms) * DEMO_SPEED;
    thread.scrollTop = s.scroll0 + dir * gone;
    springFinger(threadTop + fromFinger - dir * gone);
  };

  if (s.kind === "up" || s.kind === "down") {
    const dir: 1 | -1 = s.kind === "up" ? 1 : -1;
    if (s.stage === 0) {
      drive(dir, s.finger0, s.driveMs);
      if (t >= s.driveMs) nextStage();
      return;
    }
    if (s.stage === 1) {
      // the stop: the finger stays on the glass and stops travelling, which is
      // the braked stop the field is measured on
      springFinger(threadTop + s.finger0 - dir * s.travelPx);
      if (t >= DEMO_HOLD_MS) nextStage();
      return;
    }
    liftSpring();
    cancelScript();
    return;
  }

  if (s.kind === "reverse") {
    const leg = s.driveMs * 0.6;
    if (s.stage === 0) {
      drive(1, s.finger0, leg);
      if (t >= leg) nextStage();
      return;
    }
    if (s.stage === 1) {
      // straight into the other direction with no pause: the sign of the lag
      // has to cross zero under a live gesture
      drive(-1, s.finger0 - s.travelPx * 0.6, leg);
      if (t >= leg) nextStage();
      return;
    }
    if (s.stage === 2) {
      springFinger(threadTop + s.finger0);
      if (t >= DEMO_HOLD_MS) nextStage();
      return;
    }
    liftSpring();
    cancelScript();
    return;
  }

  // "catch": fling, let it coast, then land a finger on the moving thread
  if (s.stage === 0) {
    drive(1, s.finger0, s.driveMs);
    if (t >= s.driveMs) {
      liftSpring();
      startCoast(DEMO_SPEED, now);
      nextStage();
    }
    return;
  }
  if (s.stage === 1) {
    if (t >= DEMO_COAST_MS) {
      coast = null; // the finger landing owns the scroller from here
      armSpring(threadTop + clientH * 0.45, true);
      nextStage();
    }
    return;
  }
  if (s.stage === 2) {
    // the finger is down and has not travelled: the field calls that braking
    springFinger(threadTop + clientH * 0.45);
    if (t >= DEMO_HOLD_MS) nextStage();
    return;
  }
  liftSpring();
  cancelScript();
}

// ---- panel -------------------------------------------------------------------
const panel = mountControls(panelRoot, {
  tuning,
  onChange: noteChange,
  onConfig: noteConfig,
  onReset: () => {
    applyTuning(defaultTuning());
    panel.refresh();
    noteConfig();
    noteChange();
  },
  onDemo: startDemo,
  onFrame: setFrame,
});

function setFrame(frame: Frame): void {
  stage.dataset.frame = frame;
  freezeAll();
  dirty = true;
  requestAnimationFrame(() => {
    measure();
  });
}

// The drawer owns the panel's visibility and the swipe that opens it. The one
// thing the wiring has to hand it is what a committed swipe means to the
// THREAD: the finger that pulled the panel in was, until that moment, a finger
// on the transcript, and the field is still holding the rows behind it. So the
// gesture is lifted exactly as a touchend lifts it, and the settle runs while
// the panel slides in rather than after the reader has let go of it.
mountDrawer({
  panel: panelEl,
  scrim,
  toggle: panelToggle,
  close: panelClose,
  canvas: stage,
  onOpen: () => {
    liftSpring();
    pump();
  },
});

// ---- start -------------------------------------------------------------------
registerPlaygroundWorker(); // the Home Screen page's own worker, at its own scope
buildThread(thread);
measure();
buildEngine(); // a stored tuning may name a historical build
thread.scrollTop = Math.round(maxScroll * 0.6);
panel.refresh();
paintReadout();

let resizeRaf = 0;
window.addEventListener("resize", () => {
  dirty = true;
  if (resizeRaf) return;
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0;
    freezeAll();
    measure();
  });
});
