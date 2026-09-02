// Reply hold — the finished reply must not land under Akash's thumbs.
//
// When the agent's final reply (a keyed "done" frame) arrives while he is
// actively composing — ANY keystroke within the last QUIET_MS, the composer's
// text plays no role (space-mash and backspacing to empty are still typing) —
// its RENDER is parked here instead of shoving the thread mid-keystroke. It
// releases (through the caller's normal apply path, so ordering and
// idempotence rules hold unchanged) when QUIET_MS passes with no keystroke,
// or via flush() on send — BEFORE the outgoing bubble, so the live view shows
// the same reply-then-your-message order the store replays after a reload.
// flush() also ends composing: after a send he is by definition not typing,
// so a fast next reply renders immediately instead of riding the pre-send
// keystrokes' stale quiet window.
//
// Purely visual and purely live-view: the reply is already persisted
// server-side, so nothing is held across a reload — history simply shows it.
//
// Same shape as the shell/splash modules: a pure state machine (unit-tested,
// injectable clock, no DOM) beneath a one-line wiring in main.ts.

// TEMP DIAGNOSTIC (scroll-jank, scrolljank.ts owns the banner): one stamped
// span in diagPostSend below, so an upload that lands mid-scroll names itself
// — it did, which is why the upload now waits out gestures (diagPost's stages)
import { jankSpan } from "./jankledger";

export const QUIET_MS = 7000;

export interface ReplyHold<T> {
  /** a composer keystroke happened (content irrelevant — any keypress counts) */
  typed(): void;
  /** park a frame if he's mid-composition; true = held, caller must not render */
  maybeHold(seq: number, frame: T): boolean;
  /** render everything held, in seq order, right now, and end composing (the send path) */
  flush(): void;
  /** the take-back send path: hand over everything held UNRENDERED, seq order,
      and end composing exactly like flush() — the caller sends the seqs so the
      server deletes the rows, and re-renders only if that send fails */
  take(): [number, T][];
  /** a server retract deleted this seq: drop it unrendered if parked here */
  drop(seq: number): boolean;
  holding(): boolean;
  /** new shell/session: drop parked frames unrendered (replay covers them) */
  reset(): void;
}

export function createReplyHold<T>(
  render: (frame: T) => void,
  quietMs: number = QUIET_MS,
  now: () => number = Date.now,
): ReplyHold<T> {
  let lastKeyAt = 0; // 0 = no keystroke since session start / last send
  const held = new Map<number, T>(); // keyed by seq: a reconnect re-delivery no-ops
  let timer: ReturnType<typeof setTimeout> | null = null;

  // "actively composing" is pure keystroke freshness: a keypress within the
  // last quietMs. What the composer CONTAINS is irrelevant — space-mash and a
  // backspaced-to-empty box are still typing ("any keypress counts as typing")
  const composing = (): boolean => lastKeyAt !== 0 && now() - lastKeyAt < quietMs;
  const sinceKey = (): number => (lastKeyAt === 0 ? -1 : now() - lastKeyAt);

  function disarm(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function arm(): void {
    disarm();
    // the window counts from the LAST keystroke, not from the frame's arrival
    timer = setTimeout(() => release("quiet"), Math.max(0, quietMs - (now() - lastKeyAt)));
  }

  function release(reason: "quiet" | "send"): void {
    disarm();
    // the send path: after a send he is not composing, so zero the freshness
    // clock even when nothing is parked — otherwise the pre-send keystrokes
    // would wrongly park a fast reply for up to quietMs after the send
    lastKeyAt = 0;
    holdDiagRecord("release", { reason, held: held.size });
    if (held.size === 0) return;
    const frames = [...held.entries()].sort(([a], [b]) => a - b);
    held.clear();
    for (const [seq, f] of frames) {
      holdDiagRecord("render", { seq, route: "hold-release" });
      render(f);
    }
  }

  function flush(): void {
    release("send");
  }

  function take(): [number, T][] {
    disarm();
    // like release("send"): after a send he is by definition not composing
    lastKeyAt = 0;
    const frames = [...held.entries()].sort(([a], [b]) => a - b);
    held.clear();
    holdDiagRecord("release", { reason: "take", held: frames.length });
    return frames;
  }

  function drop(seq: number): boolean {
    if (!held.delete(seq)) return false;
    holdDiagRecord("drop", { seq, held: held.size });
    if (held.size === 0) disarm(); // nothing left to release; no stray timer fire
    return true;
  }

  function typed(): void {
    holdDiagRecord("typed", { held: held.size, sinceKey: sinceKey() });
    lastKeyAt = now();
    if (held.size > 0) arm(); // still typing: keep deferring, a full quiet window again
  }

  function maybeHold(seq: number, frame: T): boolean {
    // while anything is already parked, later frames park too — releasing them
    // out of order would pop a newer bubble above a still-held older one
    if (held.size === 0 && !composing()) {
      holdDiagRecord("pass", { seq, sinceKey: sinceKey() });
      return false;
    }
    held.set(seq, frame);
    holdDiagRecord("held", { seq, held: held.size, sinceKey: sinceKey() });
    if (!timer) arm();
    return true;
  }

  function reset(): void {
    holdDiagRecord("reset", { dropped: held.size });
    disarm();
    held.clear();
    lastKeyAt = 0;
  }

  return { typed, maybeHold, flush, take, drop, holding: () => held.size > 0, reset };
}

// ===================== TEMP DIAGNOSTIC (remove after the hold session) =====================
// Reply-hold release probe, same shape as the removed history-spinner one
// (74b0095). The iPhone has no reachable console, so the hold's event trail
// (every observed composer key with its event type, every clock reset, every
// park, every release with its exact reason, every rendered bubble) rides a
// ring buffer here and is POSTed to the server, where a curl bearing the app
// token reads it back (see /api/debug/holddiag in web/app.py). The
// state-machine hooks above record unconditionally (pure array pushes, read by
// tests through holdDiagEvents); the DOM observers and the POSTs switch on only
// inside the real shell (static #app present), so node/vitest stay inert. Key
// records carry event/inputType names only, never typed characters. The route
// they ride to is behind that token now, but the practice stands on its own: a
// trail that never holds what was typed cannot leak it, whatever happens to the
// gate in front of it or to the deploy logs it is copied into. TO REMOVE:
// delete this block, the holdDiagRecord calls above and the holdDiagAuth wiring
// in main.ts, plus the matching TEMP DIAGNOSTIC block and holddiag log lines in
// web/app.py and web/batching.py, and the keyboard and picker probe block at
// the bottom of shell.ts, which rides this same trail.

declare const __BUILT_AT__: string;

export interface HoldDiagEvent {
  t: number; // Date.now() at record time
  ev: string;
  d?: Record<string, unknown>;
}

const DIAG_MAX = 600; // ~150 keystrokes of tail: a whole test exchange fits
const diagTrail: HoldDiagEvent[] = [];
let diagPostsOn = false;
let diagPostTimer: ReturnType<typeof setTimeout> | null = null;

// The debug route is gated on the app token now, so the post has to wear the
// same Authorization header the rest of the app does. The shell hands its own
// header builder down rather than this block reading the stored token a second
// time: one place still owns that token, so a logout that clears it is felt
// here too, and a copy of the read cannot drift out of step with it. Left
// unhanded — outside the real shell, where nothing posts anyway — the post
// simply goes bare and the server refuses it, which is the same silent nothing
// any other failed post has always been.
let diagAuthHeaders: (() => Record<string, string>) | null = null;

export function holdDiagAuth(headers: () => Record<string, string>): void {
  diagAuthHeaders = headers;
}

// TEMP DIAGNOSTIC (scroll-jank, scrolljank.ts owns the banner): the gesture
// gate, handed down like the auth builder above and for the same reason — the
// recorder owns the definition of "a scroll gesture is on" and one place must
// keep owning it. The upload below asks it before doing any of its work: the
// copy+stringify ran to multi-hundred-ms blocks on device, and the jank data
// showed those blocks landing inside the very gestures the trail was built to
// measure. Unhanded — outside the real shell, or with the recorder removed —
// the gate reads as never-live and the upload simply never parks.
let diagGestureLive: (() => boolean) | null = null;

export function holdDiagGesture(live: () => boolean): void {
  diagGestureLive = live;
}

export function holdDiagEvents(): readonly HoldDiagEvent[] {
  return diagTrail;
}

export function holdDiagReset(): void {
  diagTrail.length = 0;
}

export function holdDiagRecord(ev: string, d?: Record<string, unknown>): void {
  diagTrail.push(d ? { t: Date.now(), ev, d } : { t: Date.now(), ev });
  if (diagTrail.length > DIAG_MAX) diagTrail.splice(0, diagTrail.length - DIAG_MAX);
  // the moments worth a snapshot: a park, any release path, a bypass render —
  // and the viewport/flight marks (main.ts records them onto this same trail:
  // a snap-back fired, following flipped, a send flight ran), so a slip
  // session posts even when the hold itself never engages.
  // "kb-fall" and "kb-rise" are deliberately absent: one keyboard edge writes
  // thirty of them, and something else on that same edge always arms the post,
  // so the whole run rides it without churning a timer per frame.
  //
  // "kb-edge" is IN, and it is the one that makes the frame trails arrive
  // WHOLE. It fires from the edge's first frame, about 20ms in, so the post it
  // arms lands ~620ms after the edge, past the last close frame at 60fps; the
  // raise's longer thinned tail outruns that post, and its late frames simply
  // ride the next armed mark (a shove clear or the close), whole-ring as
  // below. kb-close fires at the edge itself and would settle at ~600ms, which
  // is the tighter window of the two; kb-lift's landing record fires one
  // keyboard animation later and re-arms the post, so the landing and the
  // frames leading to it arrive together. A slower phone simply
  // posts mid-run and the rest rides the next post: the payload is the whole
  // ring buffer, not a delta, so nothing is ever lost, only later.
  //
  // "shell-pin" stays out for the opposite reason: it fires ~470ms after the
  // close, inside a window some earlier mark already armed, and arming there
  // would only push that post later.
  //
  // "scroll-jank" is IN at gesture range: its one
  // record is built about a second after the last scroll of a gesture, past
  // any window an earlier mark could have armed, and one record per gesture
  // means arming here cannot churn. TEMP DIAGNOSTIC (scroll-jank): remove
  // this entry and this paragraph with the scrolljank.ts block.
  //
  // "pick-timing" is IN so the channel does not depend on some other mark
  // happening to fire near it. Its one record is built a frame after the picked
  // photo appears, and nothing on the pick path is guaranteed to arm a post
  // there, so without this entry a whole pick's timeline could sit in the ring
  // until something unrelated came along. One record per pick means arming here
  // cannot churn. TEMP DIAGNOSTIC (pick-timing): remove this entry and this
  // paragraph with the picktiming.ts block.
  //
  // "tail-settle" is IN because one of the two moments it exists for arms
  // nothing else at all: cancelling a picked photo is a tap on a tray button,
  // with no keyboard edge and no send anywhere near it, so without this the
  // whole correction would sit in the ring until something unrelated happened
  // by. A box that changes over a beat writes a short burst of them and the
  // settle below folds a burst into one post, so this cannot churn either.
  //
  // "scroll-ghost" is IN because a scroll nobody wrote can land in a stretch
  // where nothing else records at all, which is exactly the stretch that makes
  // it worth having. An unexplained RUN is one record, not one per event, so a
  // gesture cannot churn it either. TEMP DIAGNOSTIC (scroll-ghost): remove that
  // entry and this paragraph with the scrollghost.ts block. "lift-pad" is IN
  // beside "kb-lift" for the same reason the landing is: it is the one scroll
  // write the keyboard asks for, made once per landing, and it must arrive on
  // the same post as the landing that asked for it.
  //
  // "thread-blank" is IN for the same reason and more sharply: its record is
  // built at the first touch AFTER the photo cancel that armed it, which may be
  // seconds later and with nothing else happening anywhere near it, so nothing
  // else can be relied on to arm the post. One record per armed cancel, and a
  // cancel only arms one while the conversation is still gliding, so it cannot
  // churn. TEMP DIAGNOSTIC (blank-thread): remove this entry and this paragraph
  // with the blankprobe.ts block.
  //
  // "resume" is IN because the whole point of it is being readable in a deploy
  // log after the fact: it is one record per return to the screen (two at the
  // most, when a message lands inside the landing window), it says whether the
  // socket was replaced and whether the bottom was taken and why, and a resume
  // that goes wrong is exactly the case where nothing else on the trail fires
  // near it — a banner tap on a quiet thread arms no keyboard edge, no send and
  // no picker. One record per resume means arming here cannot churn.
  //
  // "resume-ride" is IN alongside it, for the half the edge mark cannot carry.
  // The landing's whole answer is in the TIMING — how long the phone held the
  // scroll before it let go, how far the ride then had to go, and whether it
  // reached the bottom — and every one of those numbers is only known some
  // hundreds of milliseconds AFTER the resume record armed its post. Two
  // records per return at the very most, arriving one beat apart, so this
  // cannot churn either.
  if (
    ev === "held" || ev === "release" || ev === "pass" || ev === "reset" ||
    ev === "snapback" || ev === "followtail" || ev === "flight" ||
    ev === "retract-sent" || ev === "retract-applied" || ev === "shell-size" ||
    ev === "kb-close" || ev === "send-motion" || ev === "receipt-hold" ||
    ev === "boot-motion" || ev === "boot-repin" || ev === "boot-blank" ||
    ev === "grow-blink" || ev === "kb-shove" ||
    ev === "kb-focusing" || ev === "kb-lift" || ev === "lift-pad" || ev === "kb-edge" ||
    ev === "pick-anchor" || ev === "tail-gap" ||
    ev === "scroll-jank" || ev === "tail-settle" || ev === "pick-timing" ||
    ev === "thread-blank" || ev === "scroll-ghost" ||
    ev === "resume" || ev === "resume-ride"
  ) {
    diagPost();
  }
}

// The upload runs in stages now, because it used to run whole inside the
// settle timer and the scroll-jank data caught it there: the copy+stringify of
// a full ring is multi-hundred-ms work on device, and it was landing inside
// gestures — the one stall in a whole sweep's worth of blocks that could name
// itself. So: the settle timer only ASKS for the upload; the ask waits out any
// live scroll gesture (the gate scrolljank.ts hands down, quiet tail
// included), then rides an idle callback so the send lands in slack rather
// than in front of the next frame; and the idle callback asks the gate once
// more, because a new gesture can rise while the turn is waited for and
// engines run idle callbacks in a gesture's between-frame slack. None of this
// can lose a record: the payload is always the whole ring, so a parked post
// simply carries more when it finally goes — and going hidden mid-park lands
// it immediately (diagPostHide below), where blocking matters to nobody.
const DIAG_SETTLE_MS = 600; // one release posts once, not once per rendered frame
const DIAG_RETRY_MS = 250; // re-ask cadence while a gesture holds the send back
let diagPostIdleQueued = false; // an idle send is booked; new marks ride it free

function diagPost(): void {
  if (!diagPostsOn) return;
  if (diagPostTimer) clearTimeout(diagPostTimer);
  // short settle: one release posts once, not once per rendered frame
  diagPostTimer = setTimeout(diagPostWhenClear, DIAG_SETTLE_MS);
}

function diagPostWhenClear(): void {
  diagPostTimer = null;
  if (diagGestureLive?.()) {
    // mid-gesture: park. The ring is whole, so nothing is lost, only later.
    diagPostTimer = setTimeout(diagPostWhenClear, DIAG_RETRY_MS);
    return;
  }
  if (diagPostIdleQueued) return; // the booked send will carry everything anyway
  diagPostIdleQueued = true;
  // idle where the engine has it; a plain macrotask where it does not
  if (typeof requestIdleCallback === "function") requestIdleCallback(diagPostIdle);
  else setTimeout(diagPostIdle, 0);
}

function diagPostIdle(): void {
  diagPostIdleQueued = false;
  if (diagGestureLive?.()) {
    // a gesture rose while the turn was waited for: back to parking
    if (!diagPostTimer) diagPostTimer = setTimeout(diagPostWhenClear, DIAG_RETRY_MS);
    return;
  }
  // a settle timer still pending covers records this payload is about to
  // carry anyway; anything recorded after the slice below arms its own post
  if (diagPostTimer) clearTimeout(diagPostTimer);
  diagPostTimer = null;
  diagPostSend(false);
}

// going hidden with an upload parked anywhere in the stages: land it NOW, the
// cacheWrites.flush() rule — the page may freeze before any timer or idle
// callback runs again, and mid-gesture blocking matters to nobody on the way
// out. keepalive lets the send outlive the page. (A booked idle callback that
// still fires later re-sends the same whole ring; latest-wins upstream makes
// that a non-event.)
function diagPostHide(): void {
  if (!diagPostTimer && !diagPostIdleQueued) return; // nothing parked: already posted
  if (diagPostTimer) clearTimeout(diagPostTimer);
  diagPostTimer = null;
  diagPostIdleQueued = false;
  diagPostSend(true);
}

function diagPostSend(hiding: boolean): void {
  const jankT0 = performance.now(); // TEMP DIAGNOSTIC (scroll-jank): the upload's sync cost starts here
  const payload = {
    ts: new Date().toISOString(),
    build: typeof __BUILT_AT__ === "string" ? __BUILT_AT__ : "unknown",
    events: diagTrail.slice(),
  };
  // Building the header is the one step here that runs someone else's code,
  // so it is the one step that could throw where nothing is watching. A
  // diagnostic that cannot name itself is a non-event; a diagnostic that
  // throws on the way out is an app bug. It goes bare instead and the server
  // refuses it, which costs the same nothing a dropped post always cost.
  let headers: Record<string, string> = { "Content-Type": "application/json" };
  try {
    if (diagAuthHeaders) headers = { ...headers, ...diagAuthHeaders() };
  } catch {
    /* no header to be had; the bare post below is the fallback */
  }
  void fetch("/api/debug/holddiag", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    keepalive: hiding, // the hide flush must outlive the page; nothing else needs it
  }).catch(() => {
    /* diagnostic only: a failed post must never disturb the app */
  });
  jankSpan("diag-post", jankT0); // TEMP DIAGNOSTIC (scroll-jank): copy, stringify and send-off spanned
}

// Passive observers only; nothing here feeds the hold or the app. The key
// listeners sit on document in the capture phase, so they see the composer's
// events no matter when renderChat rebuilds the textarea; the mutation
// observer records every landed bubble, whatever route delivered it, so a
// rendered agent seq with no preceding held/render/pass record is a delivery
// that bypassed the hold.
function startHoldDiag(): void {
  if (typeof document === "undefined" || document.getElementById("app") === null) return;
  diagPostsOn = true;
  const composerKey = (e: Event): void => {
    const t = e.target;
    if (!(t instanceof HTMLElement) || t.id !== "text") return;
    const d: Record<string, unknown> = { type: e.type };
    const it = (e as InputEvent).inputType;
    if (it) d.it = it;
    if (e.type === "keydown") {
      const k = (e as KeyboardEvent).key;
      d.k = k.length > 1 ? k : "char"; // key NAMES only, never typed characters
    }
    holdDiagRecord("key", d);
  };
  for (const type of ["beforeinput", "input", "keydown", "compositionstart", "compositionend"]) {
    document.addEventListener(type, composerKey, true);
  }
  document.addEventListener(
    "focusin",
    (e) => {
      if (e.target instanceof HTMLElement && e.target.id === "text") holdDiagRecord("focus");
    },
    true,
  );
  document.addEventListener(
    "focusout",
    (e) => {
      if (e.target instanceof HTMLElement && e.target.id === "text") holdDiagRecord("blur");
    },
    true,
  );
  document.addEventListener("visibilitychange", () => {
    holdDiagRecord("vis", { state: document.visibilityState });
    // a parked upload must not die with the page (deferral's one debt)
    if (document.visibilityState === "hidden") diagPostHide();
  });
  if ("MutationObserver" in globalThis) {
    new MutationObserver((muts) => {
      for (const m of muts) {
        m.addedNodes.forEach((n) => {
          if (!(n instanceof HTMLElement)) return;
          if (n.classList.contains("evt")) {
            holdDiagRecord("dom-add", { seq: n.dataset.seq ?? "local", role: n.dataset.role });
          } else if (n.id === "typing") {
            holdDiagRecord("dots-on");
          }
        });
        m.removedNodes.forEach((n) => {
          if (n instanceof HTMLElement && n.id === "typing") holdDiagRecord("dots-off");
        });
      }
    }).observe(document.body, { childList: true, subtree: true });
  }
}
startHoldDiag();
// =================== END TEMP DIAGNOSTIC (remove after the hold session) ===================
