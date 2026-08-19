// Paratrooper PWA — message the pinboard agent. Vanilla TS + DOM (lightest build).
// Same-origin /api + /ws (the FastAPI service serves this bundle in production).
import "./styles.css";
import { createBootGate } from "./bootgate";
import { caretCountsAsComposing } from "./caret";
import { moveTypingAfter, placeTyping } from "./dots";
import { createDownButton, createGlide } from "./downbtn";
import type { Glide } from "./downbtn";
import { createReplyHold, holdDiagRecord } from "./hold";
import { receiptFor } from "./receipts";
import { FLIGHT_EASE, FLIGHT_MS, shiftParticipates } from "./shift";
import { bindPicker, bindSendShield, currentFileInput, initShell, reconcile } from "./shell";
import { installStartupImage } from "./splash";
import {
  RESHOVE_WINDOW_MS,
  USER_SCROLL_INTENT_MS,
  compensationFor,
  followFlipDecision,
  kbvvCounterDecision,
  shoveResponse,
} from "./viewport";
import { del as outboxDelete, getAll as outboxGetAll, put as outboxPut } from "./outbox";
import type { OutboxRecord } from "./outbox";

declare const __BUILT_AT__: string;
declare const __SERVER_VERSION__: string; // server commit this bundle was built against

const APP_VERSION = "0.1.78"; // collapse-first send flight deploy, bumped so the build is verifiable

// compose placeholder: one of these, picked at random each time the chat
// renders — app-voice dispatch prompts, ellipses spaced per Akash's spec
const PROMPTS = [
  "Dispatch for HQ?",
  "Wire your orders …",
  "Carrier pigeon inbound …",
  "Balloon's up …",
  "Over the top …",
  "Sortie at dawn …",
  "From the trenches …",
  "Telegram for the board?",
  "Drop from the biplane …",
  "Signal the aerodrome …",
];

const TOKEN_KEY = "paratrooper_token";
const THREAD_ID = "default"; // single user, single thread in v1
let token = localStorage.getItem(TOKEN_KEY) ?? "";
let lastSeq = 0;
let oldestSeq = 0; // lowest seq applied; the ?before= cursor for older pages
let loadingOlder = false;
// Older-history pipeline (the iMessage feel without a virtual list): pages are
// FETCHED ahead into a bank and INSERTED only at glide boundaries — writing
// scrollTop mid-glide fights iOS momentum (the v0.1.53 jerk), and demanding
// long total silence starves (the v0.1.54 nothing-ever-loads). Boundaries come
// from the browser's own scrollend signal where available; the banked pages
// have their own cursor (fetchCursor) so several can queue before any insert
// advances oldestSeq.
const HISTORY_PAGE = 25;
const HISTORY_BANK = 3; // pages fetched ahead ≈ 6+ screens of ready runway
let pendingOlder: ServerMsg[][] = [];
let fetchCursor = 0; // min seq fetched so far; 0 = follow oldestSeq
let historyDone = false; // the server returned an empty page: true top reached
let threadTouching = false; // finger on the thread: never insert under it
let lastScrollAt = 0; // scroll events still arriving = momentum still running
let ws: WebSocket | null = null;
let closingOnPurpose = false; // logout: suppress the auto-reconnect
let restoredOutbox = false; // once-per-session guard for the durable-outbox restore

// The client-side event store: seq → ThreadEvent, THE display truth. Apply is
// idempotent (duplicate seqs no-op — reconnect replays and zombie-socket
// re-deliveries vanish here) and ordered (older pages and out-of-order frames
// insert in position). The DOM is a projection of this map, never the state.
const store = new Map<number, ServerMsg>();

// finished-reply hold (hold.ts owns the state machine): a "done" landing while
// Akash is mid-keystroke parks until 7s of composer quiet, an emptied box, or
// a send. Release renders through the one applyEvent path below, so seq
// ordering and idempotence hold unchanged — and nothing survives a reload
// (the reply is in server history; that's the point).
const replyHold = createReplyHold<ServerMsg>((m) => applyEvent(m));

// jump-chevron visibility (downbtn.ts owns the state machine): it appears only
// after 4s of scroll stillness while away from the bottom — never because new
// content landed. The scroll handler feeds it, this one callback drives the
// class; live lookup, so renderChat re-renders can't strand a stale element.
const downBtn = createDownButton((show) =>
  document.getElementById("jump")?.classList.toggle("show", show),
);

// boot-replay ledger (bootgate.ts owns it): the honest replay marker. Every
// socket frame at or below the server's tail-at-connect is backlog and must
// never animate, however late it arrives; frames above it are genuinely new
// and do. connect() re-arms it per socket and feeds it the tail probe.
const bootGate = createBootGate();

// The canonical ThreadEvent frame — one shape for live pushes, socket replay,
// and history pages alike. Ephemeral kinds (working/typing) ride without a seq.
interface ServerMsg {
  seq?: number;
  thread_id?: string;
  role?: "user" | "agent" | "system";
  kind?: string | null; // ResultKind or system kind; absent/null on user messages
  payload?: unknown; // any JSON value; message text is a plain string
  attachments?: string[];
  attachment_dims?: ([number, number] | null)[]; // thumb sizes, index-aligned; null = legacy row
  ts?: string; // ISO-8601, server clock (live and replay alike)
}

const app = document.getElementById("app")!;
initShell(app); // keyboard/focus/picker state converges through shell.ts

// editor hold-brighten: while a finger rests on the pill its face brightens
// evenly (one flat veil, styles.css .field::before — overlay opacity only,
// nothing positional) and fades back on release. Skipped during the settling
// window — a held tap must not brighten a switched-off box. Module-level with
// live lookups, like the menu-close below, so re-renders can't stack listeners.
document.addEventListener(
  "pointerdown",
  (e) => {
    const t = e.target;
    if (t instanceof HTMLElement && t.id === "text" && !app.classList.contains("settling")) {
      t.parentElement?.classList.add("glow");
    }
  },
  true,
);
const unglow = (): void => document.querySelector(".field.glow")?.classList.remove("glow");
document.addEventListener("pointerup", unglow, true);
document.addEventListener("pointercancel", unglow, true);

// settings dropdown: any tap outside it (or its button) closes it. Bound once
// at module level with live lookups, so renderChat re-renders can't stack
// stale listeners.
document.addEventListener(
  "pointerdown",
  (e) => {
    const menu = document.getElementById("menu");
    if (!menu?.classList.contains("open")) return;
    const gear = document.getElementById("settings");
    if (e.target instanceof Node && (menu.contains(e.target) || gear?.contains(e.target))) return;
    menu.classList.remove("open");
  },
  true,
);

// --- kb-vv keyboard-mode counter (the typing-view creep) ----------------------
// Deploy-log evidence (2026-08): with the keyboard in a kb-vv mode, each
// composer line made iOS reveal-shove (snapback door window, y 45-52,
// recurring), the vv door stood aside by design, and the view crept upward
// with zero effective correction. The counter below engages UNDER kb-vv:
// viewport.ts decides (zero-baseline pans and window scrolls are displacement,
// nonzero-baseline pans are the keyboard's own math, never twice inside the
// re-shove window, dormant past the session cap), this runner acts — the snap
// is the same window.scrollTo(0,0) the shell itself uses when leaving kb-vv,
// so no new writer of shell state exists. A yield arms ONE trailing settle
// attempt: when the burst quiets, a single snap restores canonical zero
// without fighting iOS mid-burst. Every engagement records a vv-counter with
// the displacement it saw, so the next device session reads back from deploy
// logs whether the counter engaged and won.
let vvLastCounterAt = -Infinity; // performance.now() of the last counter snap
let vvCounterActs = 0; // snaps this keyboard session; the cap ends the fight
let vvPanBaseline = -1; // the session's settled pan; -1 = not latched yet
let vvHeightChangedAt = -Infinity; // vv height moved: keyboard geometry in motion
let vvSettleTimer: ReturnType<typeof setTimeout> | null = null;

function vvCounterSessionReset(): void {
  vvCounterActs = 0;
  vvPanBaseline = -1;
  if (vvSettleTimer) clearTimeout(vvSettleTimer);
  vvSettleTimer = null;
}

function armVvSettle(): void {
  if (vvSettleTimer) clearTimeout(vvSettleTimer);
  vvSettleTimer = setTimeout(() => {
    vvSettleTimer = null;
    runVvCounter("settle", true); // records even a clean verdict: the burst's end state
  }, RESHOVE_WINDOW_MS + 80);
}

// alwaysRecord: the autosize preempt and the settle probe record even a clean
// "none" verdict — the trail must show the counter ENGAGED, not just that it
// won; the shove doors record only when there is displacement to name.
function runVvCounter(trigger: string, alwaysRecord = false): void {
  const vv = window.visualViewport;
  if (!vv || !app.classList.contains("kb-vv")) return;
  if (vvPanBaseline < 0) vvPanBaseline = Math.round(vv.offsetTop); // first tracked look
  const focused = document.activeElement?.id === "text";
  const wy = Math.round(window.scrollY);
  const pan = Math.round(vv.offsetTop);
  const geomMoving = performance.now() - vvHeightChangedAt < 150;
  const act = kbvvCounterDecision(
    focused, geomMoving, wy, pan, vvPanBaseline,
    performance.now() - vvLastCounterAt, vvCounterActs,
  );
  if (act === "none" && !alwaysRecord) return;
  // how far the caret row's box sits past the visual viewport's bottom edge
  // (>0 = spilled: iOS has a reason to shove; <=0 = inside: it does not)
  const field = document.querySelector(".field")?.getBoundingClientRect();
  const spill = field ? Math.round(field.bottom - (vv.offsetTop + vv.height)) : 0;
  holdDiagRecord("vv-counter", {
    trigger, act, y: wy, top: pan, base: vvPanBaseline, spill,
  });
  if (act === "snap") {
    vvLastCounterAt = performance.now();
    vvCounterActs++;
    window.scrollTo(0, 0); // clears scroll AND pan, the shell's own leave-write
  } else if (act === "yield") {
    armVvSettle(); // one trailing correction once the burst quiets
  }
}

// iOS caret-shove counter: the shell itself never scrolls (styles.css —
// html/body are overflow:hidden at 100vh, #app is inset-pinned, only .thread
// scrolls), but iOS still programmatically scrolls the WINDOW to "reveal" the
// caret when the composer grows a line, shoving the header off-screen and the
// last reply out of view. The composer is always fully visible in our layout,
// so any window scroll while it holds focus is iOS fighting the shell — snap
// it straight back, same frame. shell.ts owns the kb-vv keyboard pans (it
// translates the app WITH them on the same event) and zeroes window scroll
// when leaving those modes; this door covers the document scroller, and the
// vv guard below covers the pans no keyboard mode owns. Snapping to 0 refires
// "scroll" once with scrollY already 0, so it cannot loop. UNDER kb-vv the
// unconditional snap is exactly the recorded re-shove loop — there the door
// routes through the rate-limited counter above instead.
window.addEventListener(
  "scroll",
  () => {
    if (document.activeElement?.id !== "text") return;
    if (window.scrollX !== 0 || window.scrollY !== 0) {
      if (app.classList.contains("kb-vv")) {
        runVvCounter("window");
        return;
      }
      holdDiagRecord("snapback", {
        door: "window", x: Math.round(window.scrollX), y: Math.round(window.scrollY),
      });
      window.scrollTo(0, 0);
    }
  },
  { passive: true },
);

// The shove's SECOND door: iOS can also reveal the caret by panning the
// VISUAL viewport (vv.offsetTop goes nonzero) — no window scroll event fires,
// so the snap-back above never sees it, and shell.ts only clears the pan when
// leaving the kb-vv modes. viewport.ts decides which pans are shoves (a pure
// pan while focused with the shell not tracking) versus legitimate keyboard
// geometry; countering runs inside the vv event itself, before the next
// paint. Registered AFTER initShell, so shell's reconcile has already applied
// or withheld kb-vv for this same event by the time the guard reads the
// class. Every geometry change while focused is recorded, countered or not.
if (window.visualViewport) {
  const vv = window.visualViewport;
  let prevVvHeight = vv.height;
  const vvGuard = (src: string): void => {
    const heightChanged = Math.abs(vv.height - prevVvHeight) > 1;
    prevVvHeight = vv.height;
    // counter session bookkeeping runs on EVERY event, focused or not: the
    // keyboard leaving (a blur, a mode drop) must reset the session, and a
    // height change while tracked re-latches the pan baseline — a settling
    // keyboard's own pan must never later read as drift
    const tracking = app.classList.contains("kb-vv");
    if (!tracking) vvCounterSessionReset();
    else if (heightChanged) {
      vvHeightChangedAt = performance.now();
      vvPanBaseline = Math.round(vv.offsetTop);
    }
    if (document.activeElement?.id !== "text") return;
    holdDiagRecord("vv-geom", {
      src, h: Math.round(vv.height), top: Math.round(vv.offsetTop),
      ih: window.innerHeight, kbvv: tracking,
    });
    if (shoveResponse(tracking, vv.offsetTop, heightChanged) === "snap") {
      holdDiagRecord("snapback", { door: "vv-pan", top: Math.round(vv.offsetTop) });
      window.scrollTo(0, 0);
    }
    // kb-vv no longer stands aside: a pure pan drifting off a zero baseline
    // (the overlay-mode creep the logs caught) is neutralized here, rate-
    // limited so the correction cannot become the re-shove loop
    if (tracking) runVvCounter(src === "resize" ? "vv-resize" : "vv-scroll");
  };
  vv.addEventListener("resize", () => vvGuard("resize"));
  vv.addEventListener("scroll", () => vvGuard("scroll"));
}

// caret moves and text selection count as composing for the reply hold: a
// reply must not land mid-thumb-drag any more than mid-keystroke.
// selectionchange fires document-wide (and once per keystroke too — the input
// listener already fed the clock then, a second reset is harmless), so it is
// gated to the focused composer and to a grace window after our own composer
// writes (the send-path clear echoes a selectionchange that must not undo
// flush — caret.ts explains); recorded under its own name so the trail tells
// selection activity from text changes.
let composerWroteAt = -Infinity; // performance.now() of the last programmatic value write
document.addEventListener("selectionchange", () => {
  if (!caretCountsAsComposing(document.activeElement?.id, performance.now() - composerWroteAt)) {
    return;
  }
  holdDiagRecord("caret");
  replyHold.typed();
});

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

// --- token gate --------------------------------------------------------------

function renderTokenGate(): void {
  app.innerHTML = `
    <div class="gate">
      <h1>Paratrooper</h1>
      <p>Enter your access token to connect.</p>
      <input id="token-input" type="password" placeholder="access token" autocomplete="off" />
      <button id="token-save">Connect</button>
      <p class="buildstamp">ui build ${__BUILT_AT__}</p>
    </div>`;
  const input = document.getElementById("token-input") as HTMLInputElement;
  document.getElementById("token-save")!.addEventListener("click", () => {
    const value = input.value.trim();
    if (!value) return;
    token = value;
    localStorage.setItem(TOKEN_KEY, value);
    renderChat();
    connect();
  });
}

// --- chat shell --------------------------------------------------------------

function renderChat(): void {
  app.innerHTML = `
    <header class="bar">
      <div class="contact">
        <img class="avatar" src="/topbar-logo.png" alt="" />
        <div class="ident">
          <span class="title">Paratrooper</span>
          <span class="ver">v${APP_VERSION}</span>
        </div>
      </div>
      <div class="settings">
        <button type="button" id="settings" class="gearbtn" title="Settings" aria-label="Settings"></button>
        <div id="menu" class="menu">
          <button type="button" id="logout" class="menu-item">Log Out</button>
        </div>
      </div>
    </header>
    <div id="confirm" class="confirm">
      <div class="confirm-card">
        <p class="confirm-msg">Are you sure you want to log out?</p>
        <div class="confirm-row">
          <button type="button" id="confirm-no" class="confirm-no">No</button>
          <button type="button" id="confirm-yes" class="confirm-yes">Yes</button>
        </div>
      </div>
    </div>
    <main id="thread" class="thread">
      <div id="histspin" class="histspin" aria-hidden="true"><span class="ring"></span></div>
    </main>
    <div id="pending" class="pending"></div>
    <form id="compose" class="compose">
      <button type="button" id="attach" class="attach" title="Attach">＋</button>
      <input id="files" type="file" accept="image/*" multiple
        class="filepick" tabindex="-1" aria-hidden="true" />
      <div class="field">
        <textarea id="text" rows="1"
          placeholder="${PROMPTS[Math.floor(Math.random() * PROMPTS.length)]}"></textarea>
        <button type="submit" id="sendbtn" class="send">↑</button>
      </div>
      <button type="button" id="jump" class="jump" title="Jump to latest"><span
        class="jump-glyph">↓</span></button>
    </form>`;
  document.getElementById("settings")!.addEventListener("click", () => {
    document.getElementById("menu")!.classList.toggle("open");
  });
  // Log Out is gated behind an iOS-style confirm so a stray tap can't log out:
  // No (safe, bold blue) dismisses; Yes (destructive red) actually logs out.
  const confirmEl = document.getElementById("confirm")!;
  document.getElementById("logout")!.addEventListener("click", () => {
    document.getElementById("menu")!.classList.remove("open");
    confirmEl.classList.add("open");
  });
  confirmEl.addEventListener("click", (e) => {
    if (e.target === confirmEl) confirmEl.classList.remove("open"); // backdrop tap = No
  });
  document.getElementById("confirm-no")!.addEventListener("click", () => {
    confirmEl.classList.remove("open");
  });
  document.getElementById("confirm-yes")!.addEventListener("click", () => {
    localStorage.removeItem(TOKEN_KEY);
    token = "";
    lastSeq = 0; // full replay on next login
    closingOnPurpose = true;
    ws?.close();
    ws = null;
    renderTokenGate();
  });
  const filesEl = document.getElementById("files") as HTMLInputElement;
  // ＋/picker focus choreography (preventDefault rules, parked-focus cleanup,
  // swapping in a virgin input per present) lives in shell.ts; here only the
  // app concern: collect picks into the tray. Read the CURRENT input rather
  // than the one bound above — shell.ts replaces the element between presents.
  bindPicker(filesEl, document.getElementById("attach")!, () => {
    const el = currentFileInput();
    pendingFiles.push(...Array.from(el?.files ?? []));
    if (el) el.value = ""; // allow re-picking the same file
    renderPending();
  });
  document.getElementById("compose")!.addEventListener("submit", (e) => {
    e.preventDefault();
    void send();
  });
  // the ↑ must not steal focus from the textarea (that collapsed the keyboard
  // on every send); the shield mirrors the ＋'s, and shell.ts owns the rule
  bindSendShield(document.getElementById("sendbtn")!);
  // compose auto-grow lives in autosize() (module level, by the scroll
  // helpers): it resizes the box AND compensates the thread's scroll in the
  // same frame, so send() can route its bar collapse through the same path
  const textEl = document.getElementById("text") as HTMLTextAreaElement;
  textEl.addEventListener("input", () => {
    autosize();
    refreshSend();
    replyHold.typed(); // composing = keystroke freshness; content is irrelevant
  });
  // the editor's width moves when the ＋ yields/reclaims its slot (styles.css
  // .kb): existing text re-wraps at the new width, so its height must be
  // re-derived or the box keeps a stale line count (too tall widening, an
  // inner scrollbar shrinking back). Width-gated so our own height writes
  // above can't loop the observer.
  let lastTextWidth = 0;
  if ("ResizeObserver" in window) {
    new ResizeObserver(() => {
      if (textEl.clientWidth === lastTextWidth) return;
      lastTextWidth = textEl.clientWidth;
      autosize();
    }).observe(textEl);
  }
  const thread = document.getElementById("thread")!;
  // glide boundaries come from the browser's own scrollend where it exists
  // (Safari 26.2+ — a real "scrolling finished" signal, momentum included);
  // older engines fall back to a scroll-quiet debounce
  const hasScrollend = "onscrollend" in thread;
  let restTimer: ReturnType<typeof setTimeout> | null = null;
  // gesture evidence feeding userScrollIntent(): wheel and pointer cover the
  // desktop paths (scrollbar drags land pointerdown on the thread), touch is
  // marked in the peek handlers below. Every real gesture also takes the
  // scroll back from a running tap glide — the user always wins mid-flight.
  thread.addEventListener("wheel", () => {
    cancelGlide();
    lastGestureAt = performance.now();
  }, { passive: true });
  thread.addEventListener("pointerdown", () => {
    cancelGlide();
    lastGestureAt = performance.now();
  });
  thread.addEventListener("scroll", () => {
    // the ONE place following flips: away from the bottom = reading history,
    // back at the bottom = following again (programmatic pins land here too).
    // While the composer is focused, an away reading needs a real gesture to
    // unfollow — shove/pin scroll events hold the line (viewport.ts explains)
    const flip = followFlipDecision(
      nearBottom(), document.activeElement?.id === "text", userScrollIntent(),
    );
    if (flip === "follow") setFollowTail(true, "scroll-bottom");
    else if (flip === "unfollow") setFollowTail(false, "scroll-away");
    else holdDiagRecord("ft-suppress", { st: Math.round(thread.scrollTop) });
    downBtn.scrolled(followTail); // away restarts its 4s stillness window; bottom hides it
    // start BANKING older pages while the user is still ~1.5 screens away —
    // inserts happen separately, at glide boundaries
    if (thread.scrollTop < 1200) void loadOlder();
    lastScrollAt = performance.now();
    if (!hasScrollend) {
      if (restTimer) clearTimeout(restTimer);
      restTimer = setTimeout(() => {
        lastScrollAt = 0;
        tryApplyOlder();
      }, 100);
    }
  });
  if (hasScrollend) {
    thread.addEventListener("scrollend", () => {
      lastScrollAt = 0; // the browser says the glide is over — authoritative
      tryApplyOlder();
    });
  }
  document.getElementById("jump")!.addEventListener("click", () => {
    downBtn.bottomReached(); // hides now; the landing's own scroll event agrees
    setFollowTail(true, "jump");
    // one continuous ride (downbtn.ts): flat cruise speed however far up,
    // braking only inside two screens of the landing, never a teleport step.
    // Mid-glide scroll events read !nearBottom and flip followTail off, so the
    // followTail-gated instant pins cannot cut the glide short; the landing's
    // own scroll event re-derives followTail=true as usual.
    startGlide();
  });
  // swipe-left to peek per-message times (iMessage): a decisively LEFTWARD
  // hold-and-drag pulls the thread with tanh resistance, revealing the time
  // rail the thread normally clips; anything else stays native scrolling
  let startX = 0;
  let startY = 0;
  let peeking: boolean | null = null; // null = gesture direction undecided
  thread.addEventListener(
    "touchstart",
    (e) => {
      cancelGlide(); // a finger down owns the scroll; the tap glide yields
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      peeking = null;
      threadTouching = true; // no history inserts under a resting finger
      lastGestureAt = performance.now();
    },
    { passive: true },
  );
  thread.addEventListener(
    "touchmove",
    (e) => {
      lastGestureAt = performance.now();
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (peeking === null) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        peeking = dx < 0 && Math.abs(dx) > Math.abs(dy) * 1.5;
        if (peeking) thread.classList.add("dragging");
      }
      if (!peeking) return;
      e.preventDefault(); // we own this gesture; vertical scroll stays native
      // resistance: tracks the finger at first, then fights back toward 64px
      const pull = 64 * Math.tanh(Math.max(-dx, 0) / 110);
      thread.style.setProperty("--peek", `-${pull.toFixed(1)}px`);
    },
    { passive: false },
  );
  const endPeek = () => {
    thread.classList.remove("dragging");
    thread.style.setProperty("--peek", "0px");
    threadTouching = false;
    // a release with no glide (a still hold) fires no scroll/scrollend —
    // check shortly after; the lastScrollAt gate skips real glides. NO special
    // at-top fast path: a release at the top starts the rubber-band snap-back,
    // which is itself a scroll animation — writing into it was the teleport.
    // scrollend fires after the bounce settles and lands the page then.
    setTimeout(tryApplyOlder, 200);
  };
  thread.addEventListener("touchend", endPeek);
  thread.addEventListener("touchcancel", endPeek);
  // fresh thread DOM: the store must match (login/logout re-renders the shell)
  store.clear();
  replyHold.reset(); // parked frames die with the old shell; replay re-delivers
  oldestSeq = 0;
  pendingOlder = []; // banked pages hold stale seqs from the old session
  fetchCursor = 0;
  historyDone = false;
  setFollowTail(true, "fresh-shell");
  downBtn.bottomReached(); // fresh shell opens pinned: no chevron, no pending timer
  bootGate.reset(); // fresh shell: replay ledger re-arms, the first settle owns the pin
  restoredOutbox = false; // a fresh shell re-reads the durable outbox
  threadObserver?.disconnect(); // the old shell's thread element is gone
  threadObserver?.observe(thread);
  // rebuild any failed sends persisted from a prior session; async and marked
  // .restored so the server replay (kicked off right after) stays above them
  void restoreOutbox();
}

// --- older history (recent-first: the socket sends a window, we page back) ----

// FETCH half: banks the next page and never touches the DOM. Chains itself
// until the bank is full or the server says there is nothing older. The
// spinner is NOT wired to this — it marks "more history exists", sitting in
// the content above the oldest message (see #histspin), like the reference.
async function loadOlder(): Promise<void> {
  if (loadingOlder || historyDone || pendingOlder.length >= HISTORY_BANK) return;
  if (oldestSeq === 0) return; // nothing applied yet: no cursor to page from
  const before = fetchCursor || oldestSeq;
  if (before <= 1) {
    historyDone = true;
    return;
  }
  loadingOlder = true;
  try {
    const r = await fetch(`/api/history/${THREAD_ID}?before=${before}&limit=${HISTORY_PAGE}`, {
      headers: authHeaders(),
    });
    if (!r.ok) return;
    const { messages } = (await r.json()) as { messages: ServerMsg[] };
    if (!messages.length) {
      historyDone = true; // true top; the spinner comes out on the next drain
    } else {
      pendingOlder.push(messages);
      fetchCursor = Math.min(...messages.map((m) => m.seq ?? before));
    }
  } finally {
    loadingOlder = false;
  }
  // a completed fetch may land ONLY for someone visibly waiting at the
  // spinner — landing on every fetch while parked streamed the whole thread
  // in 25s ("too many per turn"); everyone else gets pages at glide ends
  if (threadEl().scrollTop <= 50) tryApplyOlder();
  if (!historyDone && pendingOlder.length < HISTORY_BANK) void loadOlder(); // keep banking
}

// INSERT half: lands ONE page per glide boundary — the bank is for readiness,
// not for dumping ("users notice jumps way more than slow loading"); 75-message
// slabs were review-rejected. Older events feed the same apply path as live
// frames — they insert in position by seq; only the viewport needs pinning
// around the height change, and doing THAT between glides is the whole point.
// The spinner leaves only WITH the final page (or an empty-handed done probe),
// riding the same pin so the goodbye can't shift the view either.
function drainOlder(): void {
  const spin = document.getElementById("histspin");
  const page = pendingOlder.shift();
  const dropSpin = historyDone && pendingOlder.length === 0 && spin !== null;
  if (!page && !dropSpin) return;
  const t = threadEl();
  const prevScroll = t.scrollTop;
  const prevHeight = t.scrollHeight;
  const prevSuppress = suppressAnim;
  suppressAnim = true; // a page of history must not pop bubble-by-bubble
  if (page) for (const m of page) applyEvent(m);
  suppressAnim = prevSuppress;
  t.scrollTop = prevScroll + (t.scrollHeight - prevHeight); // visible row stays put
  if (dropSpin) {
    // the farewell happens at scrollTop~0 where the pin cannot compensate for
    // height removed above (it can't go negative) — an abrupt remove() shoved
    // the view every time. Collapse it smoothly outside the pin instead.
    spin.classList.add("bye");
    setTimeout(() => spin.remove(), 300);
  }
}

// the boundary gate: no finger down and the glide over (scrollend sets
// lastScrollAt to 0 before calling; the debounce fallback relies on the
// timestamp). Doubling as the prober: after draining — or on short threads
// that can't scroll at all — it tops the bank back up.
function tryApplyOlder(): void {
  if (threadTouching) return;
  if (performance.now() - lastScrollAt < 140) return; // glide still running
  drainOlder();
  if (!historyDone && threadEl().scrollTop < 1200) void loadOlder();
}

// --- pending attachments (picked but not yet sent) -----------------------------

let pendingFiles: File[] = [];

// the ↑ lives inside the field and exists only while there is something to
// send (text or staged files), like iMessage; every path that changes either
// one funnels through the input handler or renderPending, which both call this
function refreshSend(): void {
  const btn = document.getElementById("sendbtn");
  const text = document.getElementById("text") as HTMLTextAreaElement | null;
  if (!btn || !text) return;
  btn.classList.toggle("show", text.value.trim().length > 0 || pendingFiles.length > 0);
}

function renderPending(): void {
  refreshSend(); // staged files count toward "something to send"
  const box = document.getElementById("pending");
  if (!box) return;
  box.innerHTML = "";
  pendingFiles.forEach((f, i) => {
    const wrap = document.createElement("div");
    wrap.className = "pthumb";
    const img = document.createElement("img");
    img.src = URL.createObjectURL(f);
    img.onload = () => URL.revokeObjectURL(img.src);
    const x = document.createElement("button");
    x.type = "button";
    x.className = "pthumb-x";
    x.textContent = "✕";
    x.addEventListener("click", () => {
      pendingFiles.splice(i, 1);
      renderPending();
    });
    wrap.append(img, x);
    box.appendChild(wrap);
  });
  box.style.display = pendingFiles.length ? "flex" : "none";
}

const threadEl = () => document.getElementById("thread")!;

// --- scrolling: glide when following the tail, chevron when reading history ----

// stick-to-bottom (the WICG chat pattern): while following the tail, EVERY
// late height change — an image decoding, the keyboard shrinking the shell,
// the compose bar growing — re-pins the bottom. Following ends only when the
// user scrolls away (the scroll handler derives it) and resumes at the bottom;
// a moment-of-apply nearBottom() check can't do this, because a tall image
// above the fold pushes the bottom out of its threshold and pinning dies.
// While the composer is FOCUSED, "scrolls away" additionally requires a real
// gesture (viewport.ts followFlipDecision): a caret shove, its snap-back, or
// our own pin writes fire away-reading scroll events too, and letting those
// flip following off is what let each new composer line slip the view a
// little further on device. Every flip is recorded with its trigger.
let followTail = true;

function setFollowTail(next: boolean, trigger: string): void {
  if (next !== followTail) holdDiagRecord("followtail", { to: next, trigger });
  followTail = next;
}

// genuine-gesture evidence for the scroll handler: a finger currently on the
// thread, or wheel/pointer/touch activity inside the intent window. Starts
// at -Infinity so a boot-time scroll event can never read as a gesture.
let lastGestureAt = -Infinity;

function userScrollIntent(): boolean {
  return threadTouching || performance.now() - lastGestureAt < USER_SCROLL_INTENT_MS;
}

// re-pin when the THREAD BOX resizes (keyboard up/down, compose growth);
// content growth inside it re-pins via applyEvent and image onload hooks
const threadObserver =
  "ResizeObserver" in window
    ? new ResizeObserver(() => {
        if (followTail) scrollToBottom(true);
      })
    : null;

function nearBottom(): boolean {
  const t = threadEl();
  return t.scrollHeight - t.scrollTop - t.clientHeight < 150;
}

function scrollToBottom(force = false): void {
  const t = threadEl();
  // replay bursts (suppressAnim) jump instantly; live messages glide
  t.scrollTo({ top: t.scrollHeight, behavior: suppressAnim || force ? "auto" : "smooth" });
}

// the jump tap's glide: one rAF-driven ride, full cruise speed while far out,
// braking inside two screens of the landing (downbtn.ts owns the velocity
// rule) — never behavior:"smooth", whose duration scales with distance and
// sails for seconds over a long thread, and never a teleport hop. The live
// bottom and container height are re-read every frame, so content landing
// mid-glide grows the remaining distance and the plan re-opens the throttle,
// still ending exactly at the true bottom; any real gesture on the thread
// (wheel, pointer, touch — the handlers in renderChat) cancels it mid-flight.
let glide: Glide | null = null;
let glideRaf = 0;

function cancelGlide(): void {
  glide?.cancel();
  glide = null;
  if (glideRaf) cancelAnimationFrame(glideRaf);
  glideRaf = 0;
}

function startGlide(): void {
  cancelGlide();
  const run = createGlide(performance.now());
  glide = run;
  // float cursor: the DOM rounds scrollTop writes, and the brake's shrinking
  // steps would round away to a stall — the fractional position lives here
  let pos = threadEl().scrollTop;
  const step = (now: number): void => {
    const t = document.getElementById("thread");
    if (!t || run.cancelled()) return; // shell torn down, or a gesture took over
    pos += run.step(now, t.scrollHeight - t.clientHeight - pos, t.clientHeight);
    t.scrollTop = pos;
    if (run.done()) {
      glide = null;
      glideRaf = 0;
      return;
    }
    glideRaf = requestAnimationFrame(step);
  };
  glideRaf = requestAnimationFrame(step);
}

// compose grows with content like iMessage (1 -> ~5 lines, then inner scroll)
// and collapses on send. Every such resize moves the thread's bottom edge, so
// the compensation happens HERE, synchronously between the height write and
// this frame's paint — viewport.ts decides. Waiting for the threadObserver
// alone painted the slipped frame first (the visible bounce), and mid-history
// nothing compensated at all. At the tail this pins instantly, so the
// observer's later scrollToBottom(true) hits an already-correct scrollTop and
// moves nothing; keep-position is deliberately no write (viewport.ts explains
// the geometry); atBottom is read BEFORE the resize, while the distance to
// the bottom still means what the user last saw.
function autosize(): void {
  const textEl = document.getElementById("text") as HTMLTextAreaElement | null;
  if (!textEl) return;
  const t = threadEl();
  const oldHeight = textEl.offsetHeight;
  const nb = nearBottom();
  const atBottom = followTail || nb;
  const stBefore = t.scrollTop;
  textEl.style.height = "auto";
  // exact fit = nothing to scroll-bounce. The textarea is borderless now
  // (the .field wrapper carries the glass), so scrollHeight IS the full
  // border-box need — the old +2 border compensation would reopen the gap
  textEl.style.height = `${Math.min(textEl.scrollHeight, 120)}px`;
  const newHeight = textEl.offsetHeight;
  const decision = compensationFor(oldHeight, newHeight, atBottom);
  if (decision === "pin-bottom") {
    scrollToBottom(true); // instant: the resize and the re-pin paint as one
  }
  holdDiagRecord("autosize", {
    oldH: oldHeight, newH: newHeight, ft: followTail, nb, atB: atBottom,
    dec: decision, stB: Math.round(stBefore), stA: Math.round(t.scrollTop),
  });
  // kb-vv preempt (the cause, not the symptom): a composer height change is
  // exactly what makes iOS reveal-shove. Converge the shell NOW, in the same
  // frame as the height write — reconcile() is the shell's own one writer, so
  // --vv-top/--vv-height are fresh and the caret row is back inside the
  // visual viewport before iOS's reveal check can find it hidden — then run
  // the counter over any displacement already on the books, recording even a
  // clean verdict so the trail shows the preempt engaged.
  if (newHeight !== oldHeight && app.classList.contains("kb-vv")
      && document.activeElement?.id === "text") {
    reconcile();
    runVvCounter("autosize", true);
  }
}

// --- rendering ---------------------------------------------------------------

// iMessage clustering: consecutive same-sender bubbles inside RUN_GAP_MS form a
// run — continuations tighten spacing and the sender-side top corner. System
// lines break runs. Runs and gap stamps are DERIVED from the ordered store by
// decorate() — no mutable tracking, so pagination and out-of-order inserts
// need no save/restore dance.
const RUN_GAP_MS = 60_000;
const STAMP_GAP_MS = 60 * 60_000;

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function fmtStampDay(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString([], { weekday: "long" });
  return d.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

// entrance animation + smooth scroll are for LIVE messages only; a reconnect
// replaying fifty bubbles must not pop each one
let suppressAnim = true;

// Each event renders into one .evt wrapper (display: contents — invisible to
// the thread's flex layout, so rows/stamps stay direct flex items visually).
// The wrapper is the unit of ordering (data-seq), idempotent re-render, and
// removal; optimistic send bubbles are unkeyed wrappers at the tail until ACK.

function eventWrappers(): HTMLElement[] {
  return Array.from(threadEl().querySelectorAll<HTMLElement>(".evt"));
}

function wrapperFor(seq: number): HTMLElement | null {
  return threadEl().querySelector<HTMLElement>(`.evt[data-seq="${seq}"]`);
}

function rowEl(wrapper: HTMLElement, role: string, cls: string, at: number): HTMLDivElement {
  // each bubble sits in a full-width .row so the peek-time label can pin to
  // the screen's right edge (clipped by the thread until the pull reveals it)
  const row = document.createElement("div");
  row.className = `row ${role}`;
  if (role !== "system") row.dataset.time = fmtTime(at);
  const div = document.createElement("div");
  div.className = `msg ${role} ${cls}${suppressAnim ? "" : " anim"}`;
  row.appendChild(div);
  wrapper.appendChild(row);
  return div;
}

// decorate(): one pure fold over the rendered wrappers in DOM order — sets
// run-continuation classes and owns the gap stamps. Same result no matter what
// order events arrived in.
function decorate(): void {
  let prevSide: string | null = null;
  let prevAt = 0;
  let lastStampAt = 0;
  for (const w of eventWrappers()) {
    const rows = Array.from(w.querySelectorAll<HTMLElement>(":scope > .row"));
    if (!rows.length) {
      w.querySelector(":scope > .stamp")?.remove(); // event renders nothing
      continue;
    }
    const at = Number(w.dataset.ts || 0);
    const role = w.dataset.role ?? "agent";
    // gap stamp: shown when >1h since the previous stamp, owned by the wrapper
    let stamp = w.querySelector<HTMLElement>(":scope > .stamp");
    if (at - lastStampAt > STAMP_GAP_MS) {
      if (!stamp) {
        stamp = document.createElement("div");
        stamp.className = "stamp";
      }
      const day = document.createElement("b");
      day.textContent = fmtStampDay(at);
      stamp.replaceChildren(day, ` ${fmtTime(at)}`);
      w.prepend(stamp);
      lastStampAt = at;
    } else {
      stamp?.remove();
    }
    for (const row of rows) {
      const cont =
        (role === "user" || role === "agent") && role === prevSide && at - prevAt < RUN_GAP_MS;
      row.classList.toggle("cont", cont);
      prevSide = role === "system" ? null : role;
      prevAt = at;
    }
  }
}

// applyEvent(): THE one path every keyed frame takes — live push, reconnect
// replay, and older history pages alike. Idempotent by seq, ordered by seq.
function applyEvent(m: ServerMsg): void {
  const seq = m.seq;
  if (!seq || store.has(seq)) return; // duplicate delivery no-ops
  const prevMax = lastSeq;
  store.set(seq, m);
  if (seq > lastSeq) lastSeq = seq;
  if (oldestSeq === 0 || seq < oldestSeq) oldestSeq = seq;
  const isTail = prevMax === 0 || seq > prevMax;

  if (isTail && m.role !== "user" && m.kind !== "job") hideTyping(); // a bubble replaces the dots
  const wrapper = document.createElement("div");
  wrapper.className = "evt";
  wrapper.dataset.seq = String(seq);
  renderInto(wrapper, m);
  // insert in seq order among keyed wrappers; a tail seq lands at the absolute
  // end so in-flight optimistic (unkeyed) bubbles keep their place above it
  const next = eventWrappers().find((w) => w.dataset.seq && Number(w.dataset.seq) > seq);
  if (next) threadEl().insertBefore(wrapper, next);
  else {
    // restored failed bubbles (a prior session's unsent sends) sit at the very
    // tail; a keyed frame that would append past them slots in just above them,
    // so replayed history and live events never land beneath an old failure
    const restored = threadEl().querySelector<HTMLElement>(".evt.restored");
    if (restored) threadEl().insertBefore(wrapper, restored);
    else threadEl().appendChild(wrapper);
    // live dots stay below the newest content: a user frame landing during
    // them (agent replies removed them above) moves them back behind it,
    // same frame, a plain structural reorder (dots.ts)
    moveTypingAfter(threadEl(), wrapper);
  }
  decorate();
  // pinned-viewport handling for older pages lives in loadOlder; only tail
  // applies drive the scroll rule (the chevron is scroll-pause-only, downbtn.ts)
  if (isTail && wrapper.childElementCount > 0) {
    if (m.role === "user") setFollowTail(true, "apply-user"); // your own message snaps you back
    if (followTail) scrollToBottom();
  }
  if (m.kind === "published") flipCorrelatedPr(m);
  updateReceipt(); // any event can move the watermark (user row, job row, working)
}

// re-render one event's wrapper in place (e.g. its pr button state changed)
function rerender(seq: number): void {
  const w = wrapperFor(seq);
  const m = store.get(seq);
  if (!w || !m) return;
  const prevSuppress = suppressAnim;
  suppressAnim = true; // a state flip must not replay the entrance pop
  w.replaceChildren();
  renderInto(w, m);
  suppressAnim = prevSuppress;
  decorate();
}

function prUrl(payload: unknown): string | null {
  // live pr events carry {branch, url}; the migration parsed legacy JSON-in-body
  // rows into the same shape, so a bare-url string is the only other real case
  if (payload && typeof payload === "object" && "url" in payload) {
    return String((payload as { url: unknown }).url);
  }
  if (typeof payload === "string" && payload.startsWith("http")) return payload;
  return null;
}

function thumbUrl(key: string): string {
  return `/api/thumb/${encodeURIComponent(key)}?token=${encodeURIComponent(token)}`;
}

function openLightbox(src: string): void {
  const overlay = document.createElement("div");
  overlay.className = "lightbox";
  const img = document.createElement("img");
  img.src = src;
  overlay.appendChild(img);
  overlay.addEventListener("click", () => overlay.remove());
  document.body.appendChild(overlay);
}

// --- pr ↔ published correlation (Publish button state survives replay) --------

function prNumber(payload: unknown): number | null {
  const url = prUrl(payload);
  const m = url?.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
}

function publishedNumber(m: ServerMsg): number | null {
  if (m.kind !== "published" || typeof m.payload !== "string") return null;
  const hit = m.payload.match(/#(\d+)/);
  return hit ? Number(hit[1]) : null;
}

function isPublished(num: number | null): boolean {
  if (num === null) return false;
  for (const m of store.values()) if (publishedNumber(m) === num) return true;
  return false;
}

// a published event resolving an already-rendered pr bubble flips its button
function flipCorrelatedPr(published: ServerMsg): void {
  const num = publishedNumber(published);
  if (num === null) return;
  for (const [seq, m] of store) {
    if (m.kind === "pr" && prNumber(m.payload) === num) rerender(seq);
  }
}

// consecutive-duplicate agent text (log/done) is display noise — derived from
// the store predecessor, superseding the old lastAgentText mutable global.
// Also hides the deploy-overlap double-persist case (same text, two seqs).
function isDuplicateAgentText(seq: number, text: string): boolean {
  const seqs = Array.from(store.keys()).sort((a, b) => a - b);
  for (let i = seqs.indexOf(seq) - 1; i >= 0; i--) {
    const prev = store.get(seqs[i])!;
    if (prev.role === "user") return false; // a user turn resets the run
    const prevText = typeof prev.payload === "string" ? prev.payload.trim() : "";
    if (prev.role === "agent" && (prev.kind === "log" || prev.kind === "done") && prevText) {
      return prevText === text;
    }
  }
  return false;
}

// --- per-kind renderers: DOM = pure projection of one stored event -------------

type Renderer = (m: ServerMsg, wrapper: HTMLElement, at: number, value: string) => void;

function renderUser(m: ServerMsg, wrapper: HTMLElement, at: number, value: string): void {
  // photos render as their own frameless bubbles (same shape as the send
  // echo); pre-thumbnail history 404s and falls back to the old chip
  (m.attachments ?? []).forEach((key, i) => {
    const div = rowEl(wrapper, "user", "shot", at);
    const img = document.createElement("img");
    // reserve the box BEFORE any pixels arrive: an unsized image is 0-tall
    // until decode, and its late growth shoves the scroll position (the
    // residual history-landing jump). Server sends each thumb's real size;
    // legacy rows without one get a fixed 4:3 frame, cover-cropped.
    const dims = m.attachment_dims?.[i];
    if (dims) {
      img.width = dims[0];
      img.height = dims[1];
    } else {
      img.width = 240;
      img.height = 180;
      img.style.aspectRatio = "4 / 3"; // lock the box even after decode
      img.style.objectFit = "cover";
    }
    img.src = thumbUrl(key);
    img.alt = "photo";
    img.onload = () => {
      // decoded height lands late; re-pin INSTANTLY — a layout completion must
      // never glide (the opening-scroll motion he flagged came from these)
      if (followTail) scrollToBottom(true);
    };
    img.onerror = () => {
      div.classList.replace("shot", "text");
      div.appendChild(chip("📎 photo"));
      img.remove();
    };
    img.addEventListener("click", () => openLightbox(img.src));
    div.appendChild(img);
  });
  if (value) rowEl(wrapper, "user", "text", at).textContent = value;
}

function renderSystemLine(_m: ServerMsg, wrapper: HTMLElement, at: number, value: string): void {
  rowEl(wrapper, "system", "line", at).textContent = value || "✓";
}

// PNG dimensions read straight from a data-URI's first 24 bytes (signature +
// IHDR width/height) — no image decode needed, so the box can be reserved for
// every stored screenshot, legacy included. Null when it isn't a PNG.
function pngDims(dataUri: string): [number, number] | null {
  const start = dataUri.indexOf(",") + 1;
  if (start <= 0) return null;
  try {
    const head = atob(dataUri.slice(start, start + 32)); // 32 b64 chars = 24 bytes
    if (head.length < 24 || head.slice(12, 16) !== "IHDR") return null;
    const u32 = (o: number) =>
      ((head.charCodeAt(o) << 24) | (head.charCodeAt(o + 1) << 16) |
        (head.charCodeAt(o + 2) << 8) | head.charCodeAt(o + 3)) >>> 0;
    const w = u32(16);
    const h = u32(20);
    return w > 0 && h > 0 ? [w, h] : null;
  } catch {
    return null;
  }
}

function renderScreenshot(_m: ServerMsg, wrapper: HTMLElement, at: number, value: string): void {
  if (!value) return;
  const div = rowEl(wrapper, "agent", "shot", at);
  const img = document.createElement("img");
  // reserve the box before decode — the last unsized images shoving the scroll
  const dims = pngDims(value);
  if (dims) {
    img.width = dims[0];
    img.height = dims[1];
  }
  img.src = value;
  img.alt = "board preview";
  img.onload = () => {
    if (followTail) scrollToBottom(true); // height lands after decode; never glide
  };
  img.addEventListener("click", () => openLightbox(value));
  div.appendChild(img);
}

function renderPr(m: ServerMsg, wrapper: HTMLElement, at: number): void {
  const url = prUrl(m.payload);
  const div = rowEl(wrapper, "agent", "pr", at);
  if (url) {
    div.append("Opened a PR: ");
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = url;
    div.appendChild(a);
  } else {
    div.textContent = "Opened a PR.";
  }
  const btn = document.createElement("button");
  btn.className = "publish";
  if (isPublished(prNumber(m.payload))) {
    btn.textContent = "Published ✓"; // resolved by a correlated published event
    btn.disabled = true;
  } else {
    btn.textContent = "Publish";
    btn.addEventListener("click", () => void publish(url ?? "", btn));
  }
  div.appendChild(btn);
}

function renderError(_m: ServerMsg, wrapper: HTMLElement, at: number, value: string): void {
  rowEl(wrapper, "agent", "error", at).textContent = `⚠ ${value}`;
}

function renderAgentText(m: ServerMsg, wrapper: HTMLElement, at: number, value: string): void {
  const kind = m.kind ?? "log";
  if (kind === "done" && !value.trim()) return; // job-complete signal, text already shown
  if ((kind === "log" || kind === "done") && m.seq && value.trim()
      && isDuplicateAgentText(m.seq, value.trim())) {
    return; // consecutive duplicate of the same reply
  }
  rowEl(wrapper, "agent", "text", at).textContent = value;
}

const agentRenderers: Record<string, Renderer> = {
  screenshot: renderScreenshot,
  pr: renderPr,
  error: renderError,
};

function renderInto(wrapper: HTMLElement, m: ServerMsg): void {
  const role = m.role ?? "agent";
  const at = m.ts ? Date.parse(m.ts) : Date.now();
  const value = typeof m.payload === "string" ? m.payload : "";
  wrapper.dataset.ts = String(at);
  wrapper.dataset.role = role;
  if (role === "user") return renderUser(m, wrapper, at, value);
  // internal markers, not messages: job = enqueue bookkeeping, working = the
  // pickup watermark the receipt derives from
  if (m.kind === "job" || m.kind === "working") return;
  if (role === "system") return renderSystemLine(m, wrapper, at, value);
  return (agentRenderers[m.kind ?? "log"] ?? renderAgentText)(m, wrapper, at, value);
}

function chip(label: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = "filechip";
  s.textContent = label;
  return s;
}

// --- delivery receipt (single stamp under the most recent sent message) --------
// Derived from the STORED thread, never from transient signals, so a reopen
// replays the same label (message persisted -> Delivered; its job picked up,
// per the stored working row -> Read). Anchored inside the newest sent
// message's wrapper, so it stays under that bubble when replies land below.

// The label flip (Delivered -> Read) is a two-phase opacity fade. The current
// word fades fully out, its text is swapped only once the layer is invisible,
// then the new word fades back in. The swap runs on the layer's transitionend,
// when opacity has already reached 0, never on a timer, so the text can never
// change while any of it still shows. It is smooth by construction, with no
// per-device timing. The fade lives on an inner .rc layer (opacity only,
// caret-safe) so the receipt's own transform transition for swipe-peek (the
// :where rule in styles.css) is left untouched.

// build a fresh receipt: an .rc text layer inside the #receipt box, plus the
// one persistent handler that drives every later flip. Reaching opacity 0 (the
// rc-hide fade-out just finished) swaps the now-invisible text to the newest
// target and releases the fade back in; reaching opacity 1 is the end, no work.
function buildReceipt(state: string): HTMLElement {
  const el = document.createElement("div");
  el.id = "receipt";
  el.className = "receipt";
  el.dataset.state = state;
  const layer = document.createElement("span");
  layer.className = "rc";
  layer.textContent = state;
  layer.addEventListener("transitionend", (e) => {
    if (e.propertyName !== "opacity" || !layer.classList.contains("rc-hide")) return;
    layer.textContent = el.dataset.state ?? ""; // swapped while fully invisible
    layer.classList.remove("rc-hide"); // fade the new word in
  });
  el.appendChild(layer);
  return el;
}

function updateReceipt(): void {
  const r = receiptFor(store.values());
  const wrapper = r ? wrapperFor(r.seq) : null;
  const existing = document.getElementById("receipt");
  if (!r || !wrapper) {
    existing?.remove(); // nothing to stamp, or the newest sent message sits above the loaded window
    return;
  }
  if (existing && existing.parentElement === wrapper) {
    // Same bubble, so only the LABEL can have changed: fade it, don't snap it.
    // dataset.state holds the newest TARGET label. A repeat call with the same
    // target no-ops (no stacked fades), and the transitionend swap reads it so
    // the latest state always wins even if it changes mid-fade.
    if (existing.dataset.state !== r.state) {
      existing.dataset.state = r.state;
      // fade fully out; the persistent handler swaps the text and fades it back
      // in once the layer is invisible. Re-adding rc-hide mid-fade is a harmless
      // no-op, so repeat flips never stack.
      existing.querySelector<HTMLElement>(".rc")?.classList.add("rc-hide");
    }
    if (followTail) scrollToBottom();
    return;
  }
  existing?.remove(); // the anchor moved to a new bubble: fresh stamp, no dip
  wrapper.appendChild(buildReceipt(r.state));
  if (followTail) scrollToBottom();
}

// --- typing indicator (dots = the agent is COMPOSING text, like iMessage) ------
// Dots self-expire: the agent's internal notes also count as "composing" but
// never become messages, so dots that lead nowhere fade out on their own.

let typingExpiry: ReturnType<typeof setTimeout> | null = null;

function showTyping(): void {
  if (typingExpiry) clearTimeout(typingExpiry);
  typingExpiry = setTimeout(hideTyping, 15000);
  if (document.getElementById("typing")) return;
  const el = document.createElement("div");
  el.id = "typing";
  el.className = "msg agent typing";
  el.innerHTML = "<span></span><span></span><span></span>";
  const t = document.getElementById("thread");
  if (t) {
    placeTyping(t, el); // after the newest content, above restored failures (dots.ts)
    if (followTail) scrollToBottom();
  }
}

function hideTyping(): void {
  if (typingExpiry) clearTimeout(typingExpiry);
  typingExpiry = null;
  document.getElementById("typing")?.remove();
}

// --- networking --------------------------------------------------------------

// Version-skew guard: a service-worker-cached bundle can outlive the server it
// was built against (wire/schema changes ride deploys). On mismatch, drop the
// SW caches and reload ONCE per server version — navigations are network-first,
// so the reload fetches the freshly deployed bundle.
const REFRESHED_KEY = "paratrooper_refreshed_for";

// full-screen "Updating …" cover for the version swap: with cache-first opens
// the stale UI paints instantly, so a silent mid-use reload would read as a
// strange flip — this branded beat explains it instead
function showUpdating(): void {
  if (document.getElementById("updating")) return;
  const el = document.createElement("div");
  el.id = "updating";
  el.className = "updating";
  el.innerHTML = `
    <img src="/topbar-logo.png" alt="" />
    <div class="up-title">Updating …</div>
    <div class="updots"><span></span><span></span><span></span></div>`;
  document.body.appendChild(el);
}

function maybeSelfRefresh(server: string): void {
  if (__SERVER_VERSION__ === "dev" || server === "dev") return; // local dev
  if (server === __SERVER_VERSION__) return; // bundle matches the server
  if (sessionStorage.getItem(REFRESHED_KEY) === server) return; // already tried
  sessionStorage.setItem(REFRESHED_KEY, server);
  showUpdating();
  const cleared =
    "caches" in window
      ? caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      : Promise.resolve([]);
  void cleared
    .catch(() => {})
    // warm refetch: repopulate the shell cache with the NEW page before
    // reloading, so the reload paints instantly from cache under the overlay
    // instead of showing white while the network round-trips
    .then(() => fetch("/").catch(() => {}))
    .then(() => location.reload());
}

async function checkServerVersion(): Promise<void> {
  try {
    const r = await fetch("/api/health");
    const v = String((await r.json()).version ?? "");
    console.log(`paratrooper ui ${__BUILT_AT__} built@${__SERVER_VERSION__} / server ${v}`);
    if (v) maybeSelfRefresh(v);
  } catch {
    /* offline: the cached shell is all there is anyway */
  }
}

// The socket never announces "replay finished", and replay re-sends the
// exact live frame shape — but the backlog is by definition everything at or
// below the server's newest seq at connect. One tiny history query (newest
// row only, the same endpoint the client already pages with) learns that seq
// the moment the socket opens; bootgate.ts holds it as the per-frame replay
// marker. Until the probe answers, every frame counts as replay — stillness
// is the safe default. On failure the ledger closes at whatever has arrived:
// a socket that can't reach the server is dying anyway, and its reconnect
// re-probes.
async function probeReplayTail(): Promise<void> {
  let tail: number;
  try {
    const r = await fetch(
      `/api/history/${THREAD_ID}?before=${Number.MAX_SAFE_INTEGER}&limit=1`,
      { headers: authHeaders() },
    );
    if (!r.ok) throw new Error(String(r.status));
    const { messages } = (await r.json()) as { messages: ServerMsg[] };
    // pages are oldest-first, so the newest row — the backlog's ceiling — is last
    tail = messages.length ? (messages[messages.length - 1].seq ?? 0) : 0;
  } catch {
    tail = lastSeq;
  }
  bootGate.tailKnown(tail);
  replaySettle();
}

// the backlog is fully applied (the ledger's caught-up edge, once per
// socket): animations come on, and the boot settle runs — this used to hang
// off a 400ms quiet timer that late replay frames could outlive
function replaySettle(): void {
  if (!bootGate.caughtUp(lastSeq)) return;
  suppressAnim = false;
  // settled: probe the history bank once — a short thread never scrolls, so
  // without this the spinner would sit unresolved forever
  tryApplyOlder();
  void bootSettlePin();
}

// replay frames NEVER animate and NEVER animated-scroll, however late they
// arrive. A straggler that a live frame overtook is no longer the tail: it
// inserts above the fold with the bottom pin compensating in the same frame
// (drainOlder's own pattern), so the settled view just gains content out of
// sight with zero visible motion. Tail frames pin instantly via the usual
// followTail path (suppressAnim makes that pin behavior:"auto").
function applyReplay(m: ServerMsg): void {
  const prevSuppress = suppressAnim;
  suppressAnim = true;
  const t = threadEl();
  const prevScroll = t.scrollTop;
  const prevHeight = t.scrollHeight;
  const isTail = (m.seq ?? 0) > lastSeq;
  applyEvent(m);
  if (!isTail) t.scrollTop = prevScroll + (t.scrollHeight - prevHeight); // visible row stays put
  suppressAnim = prevSuppress;
}

// A truly fresh open must LAND at the very bottom with zero visible motion.
// The replay's per-frame pins can die early — an unsized image (a non-PNG
// screenshot, a restored-outbox blob) growing the thread between one pin and
// that pin's own scroll event makes the event read "away from the bottom"
// and flip followTail off, and every later re-pin hook is followTail-gated —
// so the first settle of each shell (and only the first: reconnect settles
// must never yank a reader; bootgate.ts keeps that ledger) forces every
// still-pending thread image to decode (decode() resolves after load+decode,
// so all late height is in), then pins one final time without any gate. The
// pin's own scroll event re-derives followTail=true through the one usual
// place.
async function bootSettlePin(): Promise<void> {
  if (!document.getElementById("thread")) return;
  if (!bootGate.claimSettlePin()) return;
  const pending = Array.from(threadEl().querySelectorAll<HTMLImageElement>("img"))
    .filter((img) => !img.complete);
  // bounded wait: a slow thumb fetch must not stall the settle — anything
  // landing later re-pins through the usual followTail onload hooks (and
  // sized images shift nothing anyway)
  await Promise.race([
    Promise.allSettled(pending.map((img) => img.decode())),
    new Promise((r) => setTimeout(r, 1200)),
  ]);
  scrollToBottom(true); // a settled layout must not glide
}

function connect(): void {
  closingOnPurpose = false;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/ws?token=${encodeURIComponent(token)}&thread=${THREAD_ID}&since=${lastSeq}`;
  suppressAnim = true; // the catch-up replay must not animate or glide
  bootGate.reconnect(); // a new backlog is inbound: everything is replay again
  ws = new WebSocket(url);
  ws.onopen = () => {
    void probeReplayTail(); // the honest marker: the server's tail at connect
    // every (re)connect re-checks version: a deploy drops the socket, so the
    // reconnect is exactly when a live page may have gone stale
    void checkServerVersion();
  };
  ws.onmessage = (e) => {
    if (!document.getElementById("thread")) return; // gate is showing; don't consume
    const m = JSON.parse(e.data) as ServerMsg & { retract_seq?: number };
    // a take-back frame: the server deleted this reply on the owner's send.
    // Checked before the seq gate — the frame carries no top-level seq on
    // purpose (a stale bundle drops it as ephemeral instead of rendering it).
    if (m.kind === "retract" && typeof m.retract_seq === "number") {
      applyRetract(m.retract_seq);
      return;
    }
    if (!m.seq) {
      // ephemeral kinds bypass the store: they are presence, not history.
      // (working is keyed now — the stored row drives the Read receipt)
      if (m.kind === "typing") showTyping(); // dots self-expire if it wasn't for you
      return;
    }
    // the finished reply must not land under his thumbs: mid-composition it
    // parks in the hold and renders after 7s of quiet (or on empty/send)
    if (m.role === "agent" && m.kind === "done" && replyHold.maybeHold(m.seq, m)) return;
    // every socket frame that passes (or bypasses) the hold is visible in the
    // trail with its kind — a rendered seq with no ws-apply record came from
    // some other route (history page, hold release, optimistic ACK)
    holdDiagRecord("ws-apply", { seq: m.seq, kind: m.kind ?? null, role: m.role ?? null });
    if (bootGate.isReplay(m.seq)) {
      applyReplay(m); // backlog: never an entrance pop, never an animated scroll
    } else {
      suppressAnim = false; // a genuinely new message: the boot era is over
      applyEvent(m);
    }
    replaySettle();
  };
  ws.onclose = () => {
    if (closingOnPurpose || !token) return; // logout: stay closed
    setTimeout(connect, 2000); // dropped: reconnect; catch-up via ?since=
  };
}

// A retract frame landed: the server deleted this reply at the owner's send
// (another client's take-back — or our own echoing back, already clean).
// Remove every trace wherever it lives: a still-parked hold entry, the store
// row, the rendered bubble. All three misses is the clean-echo case and a
// no-op; the trail records what was actually found so the round-trip reads
// back from the deploy logs.
function applyRetract(seq: number): void {
  const wasHeld = replyHold.drop(seq);
  const hadStore = store.delete(seq);
  const w = wrapperFor(seq);
  if (w) {
    w.remove();
    decorate();
    updateReceipt();
  }
  holdDiagRecord("retract-applied", {
    seq, bubble: w !== null, stored: hadStore, held: wasHeld,
  });
}

// iMessage send flight: the fresh bubble lifts out of the compose field and
// springs up into its thread seat. FLIP — the bubble is laid out in its final
// spot, instantly translated back to the field's rect, then released on a
// spring ease. Right edges are pinned (both are right-aligned); replayed and
// received bubbles keep their ordinary entrance. The flight must always play
// (standing order) — no reduced-motion gate. Every invocation leaves a trail
// record with the measured per-bubble dx/dy and the animation's start and
// finish/cancel, so a device session where nothing visibly moved shows WHY
// (near-zero deltas are themselves the finding).
function flyFromField(wrapper: HTMLElement): void {
  const field = document.querySelector(".field");
  const msgs = wrapper.querySelectorAll<HTMLElement>(".msg");
  holdDiagRecord("flight", { phase: "invoke", msgs: msgs.length, field: field !== null });
  if (!field || !msgs.length) return;
  const start = field.getBoundingClientRect();
  msgs.forEach((msg, i) => {
    const end = msg.getBoundingClientRect();
    const dx = start.right - end.right;
    const dy = start.top - end.top;
    // Web Animations API, not a transition: the start state lives inside the
    // animation itself, so WebKit cannot coalesce the two style writes into
    // one and silently skip the motion (which is what killed the old
    // transition + double-rAF version on iOS). The beat and ease are shared
    // with the sibling shift (shift.ts) — one motion, no overshoot.
    const anim = msg.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
      { duration: FLIGHT_MS, easing: FLIGHT_EASE },
    );
    holdDiagRecord("flight", {
      phase: "start", i, dx: Math.round(dx * 10) / 10, dy: Math.round(dy * 10) / 10,
    });
    anim.finished.then(
      () => holdDiagRecord("flight", { phase: "finish", i }),
      () => holdDiagRecord("flight", { phase: "cancel", i }),
    );
  });
}

// --- send-time sibling shift (the white-strip fix; shift.ts holds the why) ----
// The instant bottom pin on a send teleports the older content up by the new
// bubble's height while the bubble is still down at the field — a bare strip
// under the older message for the whole flight. FLIP over the preceding rows:
// each candidate's position is measured BEFORE the insert (with any mid-shift
// transform still applied, so a second rapid send starts every row from where
// it visually is), the running shift set is cancelled, the insert and the pin
// land, positions are measured again, and each row that moved animates from
// its old spot to its new one on the flight's own beat and ease.

const SHIFT_MAX_TARGETS = 40; // a couple of screens; the shift is a tail affair

let shiftAnims: Animation[] = [];

// the elements the thread actually lays out (the .evt wrappers are
// display:contents shells): rows, stamps, receipts, failure labels, spinner,
// dots. Walked newest-first from the tail (or from just above `stopBefore`),
// bounded — the shift only ever concerns the last screen or two.
function laidOutTail(stopBefore: Element | null): HTMLElement[] {
  const out: HTMLElement[] = [];
  let n = stopBefore ? stopBefore.previousElementSibling : threadEl().lastElementChild;
  for (; n && out.length < SHIFT_MAX_TARGETS; n = n.previousElementSibling) {
    if (!(n instanceof HTMLElement)) continue;
    if (n.classList.contains("evt")) {
      for (let i = n.children.length - 1; i >= 0 && out.length < SHIFT_MAX_TARGETS; i--) {
        const c = n.children[i];
        if (c instanceof HTMLElement) out.push(c);
      }
    } else {
      out.push(n);
    }
  }
  return out;
}

function beginSiblingShift(): { play(w: HTMLElement): void } {
  // eligibility is the pre-send view: pinned (or near) the bottom. A send from
  // deep in history pins with an intentional jump cut — animating THAT would
  // turn the instant pin into a slow scroll of the whole distance.
  const eligible = followTail || nearBottom();
  const before = new Map<HTMLElement, number>();
  if (eligible) {
    for (const el of laidOutTail(null)) before.set(el, el.getBoundingClientRect().top);
  }
  // measured first, cancelled second: the before-tops keep the mid-flight
  // visual truth, and everything from here through play() is one synchronous
  // task — nothing paints in the cancelled state
  for (const a of shiftAnims) a.cancel();
  shiftAnims = [];
  return {
    play(w: HTMLElement): void {
      if (!eligible) {
        holdDiagRecord("flight", { phase: "shift-skip", reason: "away" });
        return;
      }
      const view = threadEl().getBoundingClientRect();
      let maxDelta = 0;
      let rows = 0;
      for (const el of laidOutTail(w)) {
        const beforeTop = before.get(el);
        if (beforeTop === undefined) continue; // born by this send; nothing to close
        const r = el.getBoundingClientRect();
        const delta = beforeTop - r.top;
        if (!shiftParticipates(r.top, r.bottom, delta, view.top, view.bottom)) continue;
        shiftAnims.push(el.animate(
          [{ transform: `translateY(${delta}px)` }, { transform: "none" }],
          { duration: FLIGHT_MS, easing: FLIGHT_EASE },
        ));
        if (delta > maxDelta) maxDelta = delta;
        rows++;
      }
      holdDiagRecord("flight", {
        phase: "shift-start", delta: Math.round(maxDelta * 10) / 10, rows,
      });
    },
  };
}

// client-local bubbles (optimistic sends, network-failure notices) live in
// unkeyed .evt wrappers at the tail — outside the store unless ACKed into it
function localWrapper(role: string): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "evt";
  wrapper.dataset.ts = String(Date.now());
  wrapper.dataset.role = role;
  threadEl().appendChild(wrapper);
  // a send during visible dots must stack under the previous message with the
  // dots below it, not land beneath them — same-frame reorder (dots.ts)
  moveTypingAfter(threadEl(), wrapper);
  return wrapper;
}

function localBubble(role: string, cls: string, text: string): void {
  const w = localWrapper(role);
  rowEl(w, role, cls, Date.now()).textContent = text;
  decorate();
  if (role === "user") setFollowTail(true, "local-user");
  if (followTail) scrollToBottom();
}

// when the last send's flight left the field: a send composing onto a still-
// airborne flight must stay one synchronous composition (see send()), while a
// fresh send may wait out the composer collapse first
let lastLaunchAt = -Infinity;

async function send(): Promise<void> {
  const textEl = document.getElementById("text") as HTMLTextAreaElement;
  const sendBtn = document.getElementById("sendbtn") as HTMLButtonElement;
  const text = textEl.value.trim();
  const files = [...pendingFiles];
  if (!text && files.length === 0) return;

  // the take-back: a reply still held unseen when he sends must vanish for
  // good — the send outran it, and the rerun's next reply answers everything.
  // take() hands the parked frames over UNRENDERED and zeroes the composing
  // clock exactly as flush() did (the textarea clear below fires no input
  // event; a reply arriving moments later must render immediately). The taken
  // seqs ride the send body so the server deletes the rows; they re-render
  // only if the send fails (below), because then the server never took them.
  const taken = replyHold.take();
  const retractSeqs = taken.map(([seq]) => seq);
  if (retractSeqs.length) holdDiagRecord("retract-sent", { seqs: retractSeqs });

  // clear the field and collapse the auto-grown bar (and the pending tray)
  // through the one compensated path; called at a branch-dependent moment
  const collapseBar = (): void => {
    composerWroteAt = performance.now(); // the clear's selectionchange is ours, not composing
    textEl.value = "";
    autosize();
    pendingFiles = [];
    renderPending();
  };

  // WHEN the bar collapses is the mid-flight drag fix. On a FRESH launch it
  // collapses BEFORE anything measures: collapsing after the launch shrank a
  // multi-line composer mid-flight (82 -> 39 on device) and the pin riding
  // that resize slid the fresh bubble's seat 51px underneath it — the landing
  // read as a drag. And when the bar actually resized, take off on the frame
  // after next: the threadObserver re-pin for the resize is delivered after
  // the launch frame's rAF callbacks, and by then the flight transform holds
  // the bubble below the content edge — scrollHeight counts transformed
  // overflow, so that pin overshoots by the bubble's translate and the
  // shrinking overflow then drags the pinned scroller (the seat) for the rest
  // of the flight (Chrome traces in /tmp/m217-evidence/). Two rAFs put the
  // collapse's paint and its honest re-pin fully before the launch, so no
  // bottom pin fires while the bubble is in the air. One-line sends are
  // untouched (39 -> 39, no height write, no pin, no wait).
  //
  // Composing onto a still-AIRBORNE flight (a rapid second send) instead
  // keeps the whole task in the shipped order, collapse after the launch:
  // a collapse landing between the measure and the launch would lower the
  // field AND shrink the sibling deltas, opening a band between the riding
  // first bubble and the departing second one (measured at ~2x the bar
  // delta); the deferred collapse's own re-pin residue is bounded by the
  // remaining translate and decays with it.
  const airborne = performance.now() - lastLaunchAt < FLIGHT_MS;
  if (!airborne) {
    const fieldHBefore = textEl.offsetHeight;
    collapseBar();
    if (textEl.offsetHeight !== fieldHBefore || files.length > 0) {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
  }

  // the white-strip fix measures the older content BEFORE anything is
  // inserted; the pin below fires first, then play() starts the transforms
  const shift = beginSiblingShift();

  // INSTANT feedback on tap: one optimistic wrapper appears immediately; the
  // uploads/POST happen behind it. On ACK the wrapper adopts the server seq,
  // so a later replay of the same event no-ops instead of duplicating.
  // suppressAnim while rendering: the send flight below owns the entrance —
  // the pop-in animation would fight its transform.
  const prevSuppress = suppressAnim;
  suppressAnim = true;
  const w = localWrapper("user");
  for (const file of files) {
    const div = rowEl(w, "user", "shot", Date.now());
    const img = document.createElement("img");
    img.src = URL.createObjectURL(file);
    img.addEventListener("click", () => openLightbox(img.src));
    div.appendChild(img);
  }
  if (text) rowEl(w, "user", "text", Date.now()).textContent = text;
  suppressAnim = prevSuppress;
  decorate();
  setFollowTail(true, "send"); // sending snaps you to the tail
  scrollToBottom(true); // instant pin first; the transforms below play over it
  shift.play(w); // preceding rows glide from their old spot: no white strip
  flyFromField(w);
  lastLaunchAt = performance.now();
  if (airborne) collapseBar(); // the shipped order when a flight is already up

  sendBtn.disabled = true; // no double-fire while the network work runs
  try {
    await transmit(w, text, files, retractSeqs);
  } finally {
    sendBtn.disabled = false;
  }
  // the send FAILED (every transmit failure path lands in markFailed, which
  // registers the wrapper): the server never took the held replies back, so
  // they render after all — ABOVE the failed bubble, the same reply-then-
  // failure order a reload rebuilds (history replays the reply; the failed
  // send restores below it). applyEvent appends the keyed reply at the tail,
  // so the unkeyed failed wrapper is re-appended after it to restore order.
  if (taken.length && failedSends.has(w)) {
    for (const [seq, frame] of taken) {
      holdDiagRecord("render", { seq, route: "send-fail" });
      applyEvent(frame);
    }
    threadEl().appendChild(w);
    decorate();
    if (followTail) scrollToBottom();
  }
}

// The network half of a send — uploads, then POST /api/send — shared by the
// first attempt and every Try Again, so a retry takes the exact same path,
// ACK/seq adoption included. Any failure marks the wrapper failed (iMessage
// treatment below) instead of raising a separate error bubble; the typed text
// and File objects stay held for the next retry. retractSeqs ride the FIRST
// attempt only: a retry follows a failure, and the failure path already
// rendered the held replies (the server still has their rows).
async function transmit(
  w: HTMLElement, text: string, files: File[], retractSeqs: number[] = [],
): Promise<void> {
  const keys: string[] = [];
  for (const file of files) {
    const fd = new FormData();
    fd.append("file", file);
    let r: Response;
    try {
      r = await fetch("/api/upload", { method: "POST", headers: authHeaders(), body: fd });
    } catch {
      return markFailed(w, text, files);
    }
    if (!r.ok) return markFailed(w, text, files);
    keys.push((await r.json()).inbox_key);
  }
  let resp: Response;
  try {
    resp = await fetch("/api/send", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        thread_id: THREAD_ID, text, attachments: keys, retract_seqs: retractSeqs,
      }),
    });
  } catch {
    return markFailed(w, text, files);
  }
  if (!resp.ok) return markFailed(w, text, files);
  // the server accepted this send: drop any durable failed-copy for this wrapper
  // and release its tail-pinning marker (it is a real keyed bubble now)
  if (w.dataset.outboxId) void outboxDelete(w.dataset.outboxId);
  w.classList.remove("restored");
  const { seq } = (await resp.json()) as { seq?: number };
  if (seq) {
    if (store.has(seq)) {
      w.remove(); // a reconnect replay beat the ACK; the keyed wrapper won
      decorate();
    } else {
      // upgrade in place: the optimistic wrapper becomes the event's wrapper
      w.dataset.seq = String(seq);
      store.set(seq, {
        seq, role: "user", payload: text, attachments: keys,
        ts: new Date().toISOString(),
      });
      if (seq > lastSeq) lastSeq = seq; // our own message: don't re-replay it
      if (oldestSeq === 0 || seq < oldestSeq) oldestSeq = seq;
    }
  }
  updateReceipt(); // the server has it: the stored row now derives Delivered
}

// --- failed sends (iMessage): the bubble STAYS, marked by a red !-in-circle
// to its right and a small red "Not Delivered" underneath. The payload (text +
// File objects) is held in memory, keyed by the wrapper, so each failed send
// retries independently, and is mirrored to an on-disk outbox (outbox.ts) keyed
// by a stable id, so it now also survives closing the app: on the next open the
// records are read back and rebuilt as failed bubbles (see restoreOutbox).

const failedSends = new Map<HTMLElement, { id: string; text: string; files: File[] }>();

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `ob-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// persist a failed send's bytes for durability across an app close. Fire and
// forget: reading the File bytes or the IndexedDB write can fail on iOS, and a
// failed persist must never break the in-memory failed-send UI above it.
function persistFailed(id: string, ts: number, text: string, files: File[]): void {
  void (async () => {
    try {
      const stored: OutboxRecord["files"] = [];
      for (const f of files) {
        stored.push({ name: f.name, type: f.type, buf: await f.arrayBuffer() });
      }
      await outboxPut({ id, text, files: stored, ts });
    } catch {
      /* storage is best-effort; the in-memory failed send still stands */
    }
  })();
}

function markFailed(w: HTMLElement, text: string, files: File[]): void {
  // stable id per logical failed send, reused across retries (kept on the
  // wrapper so a re-failure overwrites its record rather than duplicating it)
  const id = w.dataset.outboxId ?? newId();
  w.dataset.outboxId = id;
  failedSends.set(w, { id, text, files });
  // persist with the wrapper's own send time so a restored record keeps its
  // original timestamp instead of drifting forward on each re-persist
  persistFailed(id, Number(w.dataset.ts) || Date.now(), text, files);
  w.classList.add("failed");
  if (w.querySelector(".sendfail-badge")) return; // already marked (re-failure)
  // badge on the last bubble's row, absolutely positioned in the column the
  // .failed row padding frees — no flex children, so bubble geometry holds.
  // No entrance animation: the badge just appears, like the reference.
  const rows = w.querySelectorAll<HTMLElement>(":scope > .row");
  const lastRow = rows[rows.length - 1];
  if (!lastRow) return;
  const badge = document.createElement("button");
  badge.type = "button";
  badge.className = "sendfail-badge";
  badge.textContent = "!";
  badge.setAttribute("aria-label", "Not Delivered — options");
  badge.addEventListener("click", () => openFailSheet(w));
  lastRow.appendChild(badge);
  const label = document.createElement("div");
  label.className = "sendfail";
  label.textContent = "Not Delivered";
  label.addEventListener("click", () => openFailSheet(w));
  w.appendChild(label);
  if (followTail) scrollToBottom(); // the label adds height under the bubble
}

// drops the failure UI and the held payload — used by a successful/in-flight
// retry (transmit re-marks if it fails again) and by Delete
function clearFailed(w: HTMLElement): void {
  const id = w.dataset.outboxId; // kept on the wrapper so a re-failure reuses it
  if (id) void outboxDelete(id); // drop the durable copy alongside the in-memory one
  failedSends.delete(w);
  w.classList.remove("failed");
  w.querySelector(".sendfail-badge")?.remove();
  w.querySelector(":scope > .sendfail")?.remove();
}

function retrySend(w: HTMLElement): void {
  const held = failedSends.get(w);
  if (!held) return;
  clearFailed(w); // badge/label hide while the retry is in flight
  void transmit(w, held.text, held.files); // success adopts the seq; failure re-marks
}

function deleteFailed(w: HTMLElement): void {
  clearFailed(w);
  // release the object URLs backing the optimistic image previews
  w.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
    if (img.src.startsWith("blob:")) URL.revokeObjectURL(img.src);
  });
  w.remove();
  decorate();
}

// --- durable outbox restore: a prior session's failed sends -------------------
// On boot (and re-login) the persisted failed sends are read back and rebuilt as
// failed bubbles at the tail, reusing the optimistic-bubble body and the same
// markFailed treatment. Marked .restored so applyEvent keeps replayed history
// and live frames above them; Try Again and Delete then behave exactly as for a
// live failed send, and Try Again reuses the same transmit path (seq/ACK
// adoption included) so a restored retry cannot double-send.
async function restoreOutbox(): Promise<void> {
  if (restoredOutbox) return; // once per session; a reconnect must not re-add them
  restoredOutbox = true;
  let records: OutboxRecord[];
  try {
    records = await outboxGetAll();
  } catch {
    return; // a broken or unavailable store must never block boot
  }
  if (!records.length || !document.getElementById("thread")) return;
  records.sort((a, b) => a.ts - b.ts); // oldest first: appended in order at the tail
  const prevSuppress = suppressAnim;
  suppressAnim = true; // a batch of restored bubbles must not pop one by one
  for (const rec of records) {
    const files = rec.files.map((f) => new File([f.buf], f.name, { type: f.type }));
    const w = localWrapper("user");
    w.classList.add("restored");
    w.dataset.outboxId = rec.id; // reuse the stored id, not a fresh one
    w.dataset.ts = String(rec.ts); // markFailed re-persists with this same ts (no drift)
    for (const file of files) {
      const div = rowEl(w, "user", "shot", rec.ts);
      const img = document.createElement("img");
      img.src = URL.createObjectURL(file);
      img.onload = () => {
        // blob decode lands after this batch's final pin; re-pin like every
        // other image kind, instantly — a layout completion must never glide
        if (followTail) scrollToBottom(true);
      };
      img.addEventListener("click", () => openLightbox(img.src));
      div.appendChild(img);
    }
    if (rec.text) rowEl(w, "user", "text", rec.ts).textContent = rec.text;
    markFailed(w, rec.text, files); // red badge + Not Delivered + in-memory entry
  }
  suppressAnim = prevSuppress;
  decorate();
  if (followTail) scrollToBottom(true);
}

// tapping the badge or label opens a bottom action sheet — the log-out
// confirm's visual language (safe default bold/blue, destructive red) in
// Apple's bottom-anchored shape: Try Again / Delete, Cancel on its own card
function openFailSheet(w: HTMLElement): void {
  if (document.querySelector(".sheet")) return; // one sheet at a time
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  const dismiss = (): void => {
    sheet.classList.remove("open");
    setTimeout(() => sheet.remove(), 150); // matches the .sheet fade
  };
  const mk = (label: string, cls: string, fn: () => void): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = label;
    b.addEventListener("click", () => {
      dismiss();
      fn();
    });
    return b;
  };
  const card = document.createElement("div");
  card.className = "sheet-card";
  card.append(
    mk("Try Again", "sheet-item", () => retrySend(w)),
    mk("Delete", "sheet-item sheet-danger", () => deleteFailed(w)),
  );
  sheet.append(card, mk("Cancel", "sheet-cancel", () => {}));
  sheet.addEventListener("click", (e) => {
    if (e.target === sheet) dismiss(); // backdrop tap = Cancel
  });
  document.body.appendChild(sheet);
  requestAnimationFrame(() => sheet.classList.add("open")); // let the fade run
}

let publishing = false;

async function publish(pr: string, btn: HTMLButtonElement): Promise<void> {
  if (publishing) return; // one merge at a time; repeat taps do nothing
  publishing = true;
  btn.disabled = true;
  btn.textContent = "Publishing…";
  try {
    let resp: Response;
    try {
      resp = await fetch("/api/publish", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: THREAD_ID, pr }),
      });
    } catch (e) {
      localBubble("agent", "error", `⚠ publish failed, server unreachable: ${e}`);
      btn.disabled = false;
      btn.textContent = "Publish";
      return;
    }
    if (!resp.ok) {
      let detail = `${resp.status} ${resp.statusText}`;
      try {
        detail = (await resp.json()).detail ?? detail;
      } catch {
        /* keep the status text */
      }
      localBubble("agent", "error", `⚠ publish failed: ${detail}`);
      btn.disabled = false;
      btn.textContent = "Publish";
      return;
    }
    btn.textContent = "Published ✓"; // stays disabled; server also pushes a stamp
  } finally {
    publishing = false;
  }
}

// --- web push (Phase 6): subscribe, re-register on every reopen -------------

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(new ArrayBuffer(raw.length)); // explicit ArrayBuffer -> BufferSource
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function setupPush(reg: ServiceWorkerRegistration): Promise<void> {
  if (!("PushManager" in window) || !token) return;
  let key: string | null;
  try {
    const r = await fetch("/api/push/key", { headers: authHeaders() });
    if (!r.ok) return;
    key = (await r.json()).key;
  } catch {
    return;
  }
  if (!key) return; // push not configured server-side
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    if (Notification.permission === "denied") return;
    if ((await Notification.requestPermission()) !== "granted") return;
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
  }
  await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(sub),
  });
}

// --- boot --------------------------------------------------------------------

// opening (or returning to) the app clears the home-screen unread badge
function clearBadge(): void {
  if ("clearAppBadge" in navigator) void navigator.clearAppBadge().catch(() => {});
  navigator.serviceWorker?.controller?.postMessage("badge-clear");
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") clearBadge();
});
clearBadge();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("/sw.js");
      await setupPush(reg);
    } catch {
      /* push/SW are best-effort */
    }
  });
}

// paint this device's iOS launch image once per load (see splash.ts): the same
// top-bar logo centered on white, sized to the current screen. No-ops off iOS.
installStartupImage("/splash-logo.png"); // full-res cut-out; the 140px topbar file pixelates at splash size

if (token) {
  renderChat();
  connect(); // ws.onopen runs the version check; see checkServerVersion
} else {
  renderTokenGate();
}

