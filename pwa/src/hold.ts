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

export const QUIET_MS = 7000;

export interface ReplyHold<T> {
  /** a composer keystroke happened (content irrelevant — any keypress counts) */
  typed(): void;
  /** park a frame if he's mid-composition; true = held, caller must not render */
  maybeHold(seq: number, frame: T): boolean;
  /** render everything held, in seq order, right now, and end composing (the send path) */
  flush(): void;
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

  return { typed, maybeHold, flush, holding: () => held.size > 0, reset };
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
// holddiag log lines in web/app.py and web/batching.py.

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
  // session posts even when the hold itself never engages
  if (
    ev === "held" || ev === "release" || ev === "pass" || ev === "reset" ||
    ev === "snapback" || ev === "followtail" || ev === "flight"
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
