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
// span in diagPost below, so an upload that lands mid-scroll names itself
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
// ring buffer here and is POSTed to the server, where a plain curl reads it
// back (see /api/debug/holddiag in web/app.py). The state-machine hooks above
// record unconditionally (pure array pushes, read by tests through
// holdDiagEvents); the DOM observers and the POSTs switch on only inside the
// real shell (static #app present), so node/vitest stay inert. Key records
// carry event/inputType names only, never typed characters, because the debug
// route is unauthenticated. TO REMOVE: delete this block and
// the holdDiagRecord calls above, plus the matching TEMP DIAGNOSTIC block and
// holddiag log lines in web/app.py and web/batching.py, and the keyboard and
// picker probe block at the bottom of shell.ts, which rides this same trail.

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
  // below. kb-close and kb-glide fire at the edge itself and would settle at
  // ~600ms, which is the tighter window of the two. A slower phone simply
  // posts mid-run and the rest rides the next post: the payload is the whole
  // ring buffer, not a delta, so nothing is ever lost, only later.
  //
  // "shell-pin" stays out for the opposite reason: it fires ~470ms after the
  // close, inside a window some earlier mark already armed, and arming there
  // would only push that post later.
  //
  // "close-slack" is IN for kb-edge's reason at longer range: the record is
  // built when its run ends, about four seconds after the close, past every
  // window an earlier mark could have armed, so without arming here it would
  // sit until some unrelated mark happened by. At most two records per close
  // (the batched timeline, and a touch pair landing after it), so no churn.
  //
  // "scroll-jank" is IN for close-slack's reason at gesture range: its one
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
  if (
    ev === "held" || ev === "release" || ev === "pass" || ev === "reset" ||
    ev === "snapback" || ev === "followtail" || ev === "flight" ||
    ev === "retract-sent" || ev === "retract-applied" || ev === "shell-size" ||
    ev === "kb-close" || ev === "send-motion" || ev === "receipt-hold" ||
    ev === "boot-motion" || ev === "boot-repin" || ev === "boot-blank" ||
    ev === "grow-blink" || ev === "kb-shove" ||
    ev === "kb-focusing" || ev === "kb-glide" || ev === "kb-edge" ||
    ev === "pick-anchor" || ev === "tail-gap" || ev === "close-slack" ||
    ev === "scroll-jank" || ev === "tail-settle" || ev === "pick-timing"
  ) {
    diagPost();
  }
}

function diagPost(): void {
  if (!diagPostsOn) return;
  if (diagPostTimer) clearTimeout(diagPostTimer);
  // short settle: one release posts once, not once per rendered frame
  diagPostTimer = setTimeout(() => {
    diagPostTimer = null;
    const jankT0 = performance.now(); // TEMP DIAGNOSTIC (scroll-jank): the upload's sync cost starts here
    const payload = {
      ts: new Date().toISOString(),
      build: typeof __BUILT_AT__ === "string" ? __BUILT_AT__ : "unknown",
      events: diagTrail.slice(),
    };
    void fetch("/api/debug/holddiag", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {
      /* diagnostic only: a failed post must never disturb the app */
    });
    jankSpan("diag-post", jankT0); // TEMP DIAGNOSTIC (scroll-jank): copy, stringify and send-off spanned
  }, 600);
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
