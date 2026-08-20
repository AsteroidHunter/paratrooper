// Paratrooper PWA — message the pinboard agent. Vanilla TS + DOM (lightest build).
// Same-origin /api + /ws (the FastAPI service serves this bundle in production).
import "./styles.css";
import { createBootGate } from "./bootgate";
import { caretCountsAsComposing } from "./caret";
import { moveTypingAfter, placeTyping } from "./dots";
import { createDownButton, createGlide } from "./downbtn";
import type { Glide } from "./downbtn";
import { createReplyHold, holdDiagRecord } from "./hold";
import { photoBox } from "./photobox";
import { createPhotoQueue, nearMargin } from "./photolazy";
import { receiptFor } from "./receipts";
import {
  ENTER_RISE_PX,
  FLIGHT_EASE,
  FLIGHT_MS,
  accentAlpha,
  barTextAlpha,
  bubbleTextAlpha,
  flightEase,
  morphBox,
  morphCorners,
  newbornEnter,
  shiftParticipates,
} from "./shift";
import type { MorphBox } from "./shift";
import { zoomClipCuts, zoomClipInset, zoomFit, zoomReturn } from "./zoom";
import {
  bindPicker,
  bindSendShield,
  closeCorrectionNeeded,
  currentFileInput,
  initShell,
  watchKeyboard,
} from "./shell";
import { installSplashCover, installStartupImage } from "./splash";
import {
  USER_SCROLL_INTENT_MS,
  compensationFor,
  followFlipDecision,
  giveUpTarget,
} from "./viewport";
import { del as outboxDelete, getAll as outboxGetAll, put as outboxPut } from "./outbox";
import type { OutboxRecord } from "./outbox";
import {
  CACHE_FRAMES,
  createWriteScheduler,
  del as cacheDel,
  get as cacheGet,
  put as cachePut,
} from "./threadcache";

declare const __BUILT_AT__: string;
declare const __SERVER_VERSION__: string; // server commit this bundle was built against

const APP_VERSION = "0.3.2"; // legacy thumb dims backfill, bumped so the build is verifiable

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
// Replay batching (one-commit catch-up): while the boot ledger says the
// backlog is still streaming, socket replay frames buffer here instead of
// touching the DOM, and the caughtUp edge applies the whole buffer in ONE
// task (commitReplayBuffer) — a cold open or an away-for-days catch-up lands
// as one discrete update, never a bubble-by-bubble movie. The fallback timer
// closes the ledger with whatever arrived if the tail probe never answers:
// buffered frames must not sit invisible behind a hung request.
let replayBuffer: ServerMsg[] = [];
let replayBufferMax = 0; // highest buffered seq; counts toward the caught-up cursor
let probeFallback: ReturnType<typeof setTimeout> | null = null;
const PROBE_FALLBACK_MS = 5000; // past any believable probe round trip; only a hang trips it

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
const replyHold = createReplyHold<ServerMsg>((m) => {
  applyEvent(m);
  // a released frame can be the last uncovered piece of a catch-up backlog:
  // the ledger must get its chance to latch on it (a no-op once settled)
  replaySettle();
});

// jump-chevron visibility (downbtn.ts owns the state machine): it appears only
// after 4s of scroll stillness while away from the bottom — never because new
// content landed. The scroll handler feeds it, this one callback drives the
// class; live lookup, so renderChat re-renders can't strand a stale element.
const downBtn = createDownButton((show) =>
  document.getElementById("jump")?.classList.toggle("show", show),
);

// the keyboard gate (shell.ts owns the edge, downbtn.ts the rule): up takes
// the chevron down, and the down edge is one nudge with the same followTail
// verdict the scroll handler feeds it, so the ordinary stillness window
// decides whether it comes back
watchKeyboard((up) => downBtn.keyboard(up, followTail));

// boot-replay ledger (bootgate.ts owns it): the honest replay marker. Every
// socket frame at or below the server's tail-at-connect is backlog and must
// never animate, however late it arrives; frames above it are genuinely new
// and do. connect() re-arms it per socket and feeds it the tail probe.
const bootGate = createBootGate();

// cold-open thread cache (threadcache.ts owns the record): the newest
// CACHE_FRAMES stored frames verbatim plus the lastSeq cursor, rewritten
// debounced after applies and flushed when the app goes hidden. Boot reads it
// back and paints the whole thread in one task before any network touches the
// visible path (bootFromCache below); logout deletes it.
function writeThreadCache(): void {
  if (!token || store.size === 0) return; // an empty snapshot must never clobber a good one
  const seqs = [...store.keys()].sort((a, b) => a - b).slice(-CACHE_FRAMES);
  void cachePut({ id: THREAD_ID, lastSeq, frames: seqs.map((s) => store.get(s)!) });
}
const cacheWrites = createWriteScheduler(writeThreadCache);

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

// The one defensive snap-back left, and only OUTSIDE a keyboard session. The
// shell itself never scrolls (styles.css — html/body are overflow:hidden at
// 100vh with touch-action:none, #app is inset-pinned, only .thread scrolls),
// yet iOS can still programmatically scroll the WINDOW to "reveal" a focused
// composer — e.g. a focus tap's reveal landing before the keyboard is provably
// up, the gap the focus blink (styles.css) exists to close. The composer is
// always fully visible in our layout, so a window scroll while it holds focus
// with NO keyboard is iOS fighting the shell: snap it straight back, same
// frame (snapping to 0 refires "scroll" once with scrollY already 0, so it
// cannot loop). WITH the keyboard up (.kb) the shell owns the whole affair
// (shell.ts): it rides the visual viewport, refuses to track a scroll-sourced
// growth shove (clearing it in its own frame, with a yield guard so the
// retired counter's window war cannot restart), and corrects residue once at
// close.
window.addEventListener(
  "scroll",
  () => {
    if (document.activeElement?.id !== "text") return;
    if (app.classList.contains("kb")) return; // close-time correction owns keyboard residue
    if (window.scrollX !== 0 || window.scrollY !== 0) {
      holdDiagRecord("snapback", {
        door: "window", x: Math.round(window.scrollX), y: Math.round(window.scrollY),
      });
      window.scrollTo(0, 0);
    }
  },
  { passive: true },
);

// vv-geom: the trail's record of every visual-viewport move while the composer
// is focused — how the device reads keyboard geometry back from deploy logs.
// Purely a recorder: the shell tracks the viewport (shell.ts sizes it on this
// same event) instead of any door fighting it. Registered AFTER initShell, so
// reconcile has already applied .kb and the shell box for this event by the
// time the state is read.
if (window.visualViewport) {
  const vv = window.visualViewport;
  const vvRecord = (src: string): void => {
    if (document.activeElement?.id !== "text") return;
    holdDiagRecord("vv-geom", {
      src, h: Math.round(vv.height), top: Math.round(vv.offsetTop),
      ih: window.innerHeight, kb: app.classList.contains("kb"),
    });
  };
  vv.addEventListener("resize", () => vvRecord("resize"));
  vv.addEventListener("scroll", () => vvRecord("scroll"));
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
    cacheWrites.cancel(); // a pending write must not resurrect the record deleted next
    void cacheDel(THREAD_ID); // the cached thread is credentialed content
    if (probeFallback) clearTimeout(probeFallback);
    probeFallback = null;
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
    autosize(true); // typed: the blink protects this keystroke whether or not it grew a line
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
    // then a damped-spring settle into the landing, never a teleport step.
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
  flightsUp = 0; // airborne flights died with the old shell (late settles floor at 0)
  receiptPending = false;
  restoredOutbox = false; // a fresh shell re-reads the durable outbox
  threadObserver?.disconnect(); // the old shell's thread element is gone
  threadObserver?.observe(thread);
  watchPhotos(thread); // history photos load off THIS thread box's proximity
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
// settling on a damped spring (downbtn.ts owns the physics)
// — never behavior:"smooth", whose duration scales with distance and
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

// The one-frame opacity blink that makes iOS skip its caret-reveal scroll (the
// verified ios-chat/kiding mechanism; styles.css focus-blink runs the same
// thing off :focus). Driven through WAAPI so re-triggering it never touches
// that :focus animation (flyFromField leans on the same WebKit property), and
// the previous blink is cancelled first so fast typing stacks nothing.
let composerBlink: Animation | null = null;

function blinkComposer(el: HTMLElement): void {
  composerBlink?.cancel();
  composerBlink = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 20 });
}

// compose grows with content like iMessage (1 -> ~5 lines, then inner scroll)
// and collapses on send. Every such resize moves the thread's bottom edge, so
// the compensation happens HERE, synchronously between the height write and
// this frame's paint — viewport.ts decides. Waiting for the threadObserver
// alone painted the slipped frame first (the visible bounce), and mid-history
// nothing compensated at all. At the tail this pins instantly, so the
// observer's later scrollToBottom(true) hits an already-correct scrollTop and
// moves nothing; a mid-history GROWTH hands back exactly the pixels the bar
// took, so the newest message is never left under it; atBottom is read BEFORE
// the resize, while the distance to the bottom still means what the user last
// saw. `typed` marks the keystroke path (the input handler) apart from the
// re-derives that share this function (a width change, the send collapse).
function autosize(typed = false): void {
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
  // publish the pill's live height: the jump chevron seats itself off it
  // (styles.css .jump), so it clears the box at one line and at the five-line
  // cap alike instead of off a written-down single-line constant. The pill is
  // the textarea's parent and carries no padding or border of its own, so this
  // read costs nothing beyond the reflow the line above already forced.
  const pill = textEl.parentElement;
  if (pill) app.style.setProperty("--field-h", `${pill.offsetHeight}px`);
  // EVERY keystroke hands iOS a caret to reveal, and it scrolls the whole page
  // one step to do it (the typing-test shove: vv.offsetTop 362 -> 412, 412px
  // piled up by close). Blinking only on GROWTH protected the first character
  // of each line and nothing after it, and stopped protecting anything at all
  // once the box hit its 120px cap around the fifth line, where the height
  // never changes again: exactly his report. So while the keyboard is up every
  // keystroke blinks, and a growth still blinks even before .kb has latched
  // (the focusing window's first line). Composer focus is required either way:
  // the reveal is a focus behavior.
  const grew = newHeight > oldHeight;
  const kbUp = app.classList.contains("kb");
  if (document.activeElement === textEl && (grew || (typed && kbUp))) {
    blinkComposer(textEl);
    holdDiagRecord("grow-blink", {
      why: grew ? "grow" : "key", oldH: oldHeight, newH: newHeight, kb: kbUp,
    });
  }
  const decision = compensationFor(oldHeight, newHeight, atBottom);
  if (decision === "pin-bottom") {
    scrollToBottom(true); // instant: the resize and the re-pin paint as one
  } else if (decision === "give-up") {
    // the thread yields exactly the height the bar gained, in the same frame:
    // its box just shrank from the bottom, so without this the line that sat
    // on that edge (the message he just sent) is clipped away under the bar
    t.scrollTop = giveUpTarget(t.scrollTop, oldHeight, newHeight, t.scrollHeight - t.clientHeight);
  }
  holdDiagRecord("autosize", {
    oldH: oldHeight, newH: newHeight, ft: followTail, nb, atB: atBottom,
    dec: decision, stB: Math.round(stBefore), stA: Math.round(t.scrollTop),
  });
  // no shell work here: the bar and the thread split a shell box that only
  // the visual viewport sizes (shell.ts), so composer growth is pure
  // shell-internal layout: the scroll write above is the whole compensation
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
      const born = stamp === null;
      if (!stamp) {
        stamp = document.createElement("div");
        stamp.className = "stamp";
      }
      const day = document.createElement("b");
      day.textContent = fmtStampDay(at);
      stamp.replaceChildren(day, ` ${fmtTime(at)}`);
      w.prepend(stamp);
      // a stamp born on a LIVE arrival enters like the bubble it rides above
      // (the .anim row): the same fade-up the send path gives its newborn
      // stamp, so a reply that opens a new hour never pops. Replay, history
      // pages, and rerenders run under suppressAnim and render no .anim rows,
      // so they stay static — the bootgate rules hold untouched. The send
      // path's own wrapper renders suppressed (no .anim), so its stamp is
      // entered once, by shift play, never here.
      if (born && !suppressAnim && w.querySelector(".msg.anim")) {
        enterNewborn(stamp);
        holdDiagRecord("flight", { phase: "enter", n: 1, src: "live" });
      }
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
  cacheWrites.bump(); // the cold-open snapshot trails every applied frame, debounced
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

// --- history photos load when the reader nears them (photolazy.ts) ------------
// The ledger parks each history photo's url; this is the proximity signal that
// releases it. The root is the THREAD, not the window: the thread is the only
// thing that scrolls here, so a window-rooted observer (or the browser's own
// loading="lazy" heuristic, which reads the viewport) would answer about the
// wrong box. The reach is named and explicit: one screen of the thread's own
// height, applied above and below, so a photo starts loading about a screen
// before it reaches the eye whichever way the reader is going. Horizontal
// margin stays 0; nothing scrolls sideways.
//
// One observer per shell, rebuilt in renderChat because the root element is
// rebuilt there and the margin is measured from the fresh box. Each photo is
// released exactly once and then dropped from the observer: a photo that has
// its pixels can never need them again.
let photoObserver: IntersectionObserver | null = null;

const photoQueue = createPhotoQueue<HTMLImageElement>(
  "IntersectionObserver" in window ? (img) => photoObserver?.observe(img) : null,
);

function watchPhotos(thread: HTMLElement): void {
  photoObserver?.disconnect(); // the old shell's photos died with its DOM
  photoQueue.reset();
  if (!("IntersectionObserver" in window)) return; // every photo loads eagerly instead
  const margin = nearMargin(thread.clientHeight || window.innerHeight);
  photoObserver = new IntersectionObserver(
    (entries, obs) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        obs.unobserve(e.target);
        photoQueue.release(e.target as HTMLImageElement);
      }
    },
    { root: thread, rootMargin: `${margin}px 0px` },
  );
}

// --- tap-to-zoom: the photo grows out of its spot and shrinks back into it ----
// The lightbox copy launches from the tapped photo's exact box and corner
// radius and flies to the fitted centered box zoom.ts computes, which it then
// KEEPS: the resting size has exactly one source, and a resize while the photo
// is open re-runs that same source rather than letting a second one in (the
// copy's own note at restBox below has the whole story), the backdrop fading in
// alongside. The geometry is real box
// interpolation on the send-flight's beat and ease, driven per rAF frame like
// the send morph (morphBox/flightEase — never transform scale, which would
// squash the corner circles). The thread photo hides beneath the copy for the
// whole zoom — two identical images a frame apart read as a doubling — and is
// handed back byte-clean as the copy lands home. The copy also inherits the
// photo's own cut: the thread paints nothing outside its scrolling box, so a
// photo half behind the top bar or the compose bar ends at that edge, and the
// copy is clipped to the same box (opening to the whole screen over the flight,
// since the resting zoom covers both bars). Dismissal re-reads the
// photo's rect at that moment: the thread may have scrolled or gained rows
// while zoomed, and the copy must land where the photo IS. A spot scrolled
// off-screen gets the edge return (shrink toward its direction while fading);
// a spot whose row is gone gets the center fade (zoom.ts decides). Records
// ride the flight channel like every other motion.
function openLightbox(src: string, from?: HTMLImageElement): void {
  if (document.querySelector(".lightbox")) return; // a double-tap must not stack overlays
  const overlay = document.createElement("div");
  overlay.className = "lightbox";
  const back = document.createElement("div");
  back.className = "lightbox-back";
  overlay.appendChild(back);
  const img = document.createElement("img");
  img.src = src;
  overlay.appendChild(img);
  document.body.appendChild(overlay);
  if (!from?.naturalWidth) {
    // nothing decoded to grow from (a not-yet-loaded optimistic blob): the
    // plain overlay, instant both ways
    overlay.addEventListener("click", () => overlay.remove());
    return;
  }
  const boxOf = (r: DOMRect): MorphBox => ({
    left: r.left, top: r.top, width: r.width, height: r.height,
  });
  const writeBox = (b: MorphBox): void => {
    img.style.left = `${b.left}px`;
    img.style.top = `${b.top}px`;
    img.style.width = `${b.width}px`;
    img.style.height = `${b.height}px`;
  };
  // The copy is cut where the real photo is cut (zoom.ts explains the rule):
  // the thread is its own scrolling box, so a photo half behind the top bar or
  // the compose bar ends at that box's edge, while the copy is a sheet over the
  // whole screen and would paint across the bar unless it is cut to match. The
  // cut travels with the flight — thread box at the thread end, whole screen at
  // the open end — and only the copy is ever cut: the backdrop and the resting
  // photo still cover both bars.
  const clipper = from.closest(".thread"); // where the photo's own cut comes from
  const screenBox = (): MorphBox => ({
    left: 0, top: 0, width: window.innerWidth, height: window.innerHeight,
  });
  const threadBox = (): MorphBox =>
    clipper ? boxOf(clipper.getBoundingClientRect()) : screenBox();
  // the cut last written, so a mid-flight turn home keeps it (freeze writes the
  // launch one below, before any frame paints)
  let clipNow = screenBox();
  const writeClip = (b: MorphBox, clip: MorphBox): void => {
    clipNow = clip;
    const i = zoomClipInset(b, clip);
    if (!zoomClipCuts(i)) {
      img.style.removeProperty("clip-path"); // nothing to cut: no cut at all
      return;
    }
    img.style.clipPath = `inset(${i.top.toFixed(1)}px ${i.right.toFixed(1)}px ` +
      `${i.bottom.toFixed(1)}px ${i.left.toFixed(1)}px)`;
  };
  // the copy owns its geometry while airborne: absolute in the overlay's
  // fixed box (viewport coordinates), the resting max-* fit released so the
  // interpolated box is never clamped mid-flight (a tall screenshot's height
  // crosses 92vh on the way in)
  const freeze = (b: MorphBox, radius: number, clip: MorphBox): void => {
    img.style.position = "absolute";
    img.style.maxWidth = "none";
    img.style.maxHeight = "none";
    writeBox(b);
    img.style.borderRadius = `${radius.toFixed(1)}px`;
    writeClip(b, clip); // the launch frame is cut before it ever paints
  };
  let raf = 0;
  // the send morph's driver shape (armFieldMorph): eased box and corner
  // writes per frame, fades riding the clock, and the landed frame painting
  // once BEFORE the settle so the swap can never read as a snap
  const fly = (
    a: MorphBox, b: MorphBox, rA: number, rB: number, cA: MorphBox, cB: MorphBox,
    fade: (f: number) => void, settle: () => void,
  ): void => {
    if (raf) cancelAnimationFrame(raf);
    const t0 = performance.now();
    const step = (now: number): void => {
      raf = 0;
      const f = Math.min((now - t0) / FLIGHT_MS, 1);
      const p = flightEase(f);
      const box = morphBox(a, b, p);
      writeBox(box);
      img.style.borderRadius = `${morphCorners(rA, [rB], p)[0].toFixed(1)}px`;
      writeClip(box, morphBox(cA, cB, p)); // the cut rides the same beat and ease
      fade(f);
      if (f < 1) raf = requestAnimationFrame(step);
      else raf = requestAnimationFrame(settle);
    };
    raf = requestAnimationFrame(step);
  };
  const fromBox = boxOf(from.getBoundingClientRect());
  const fromRadius = parseFloat(getComputedStyle(from).borderTopLeftRadius) || 0;
  const restRadius = parseFloat(getComputedStyle(img).borderTopLeftRadius) || 0;
  // THE one source of the resting size. It used to be two: this fit, off
  // window.innerWidth/innerHeight, and the css max-width 96vw / max-height 92vh
  // the copy fell back to when the landing frame dropped its inline style. The
  // width halves agree; the height halves need not, because innerHeight shrinks
  // with the keyboard in two of iOS 26's three modes and can stay stuck short
  // after it (shell.ts) while vh keeps measuring the full screen. A portrait
  // photo is the one whose fit flips from the width term to the height term
  // when they part, which is why portrait alone resized on that frame and
  // landscape never did. The flight's landed box now simply STANDS: the inline
  // geometry is never dropped, so the css rule (still the sizing for an
  // undecoded copy, which never flies) can never re-fit a flown one, and the
  // close leg's rect read is that same landed box.
  const restBox = (): MorphBox =>
    zoomFit(from.naturalWidth, from.naturalHeight, window.innerWidth, window.innerHeight);
  const to = restBox();
  // A box that stands has to be re-aimed by hand when the viewport moves, so a
  // rotation or any other resize re-runs that same one source while the copy is
  // at rest. Never mid-flight: a flight owns its own frames.
  let atRest = false;
  const refit = (): void => {
    if (!atRest) return;
    const b = restBox();
    writeBox(b);
    writeClip(b, screenBox()); // the resting cut is re-measured with it, and cuts nothing
  };
  window.addEventListener("resize", refit);
  // TEMP DIAGNOSTIC (hold.ts trail, flight channel): the two resting sizes side
  // by side on the landing frame. One is what the flight stands on, off
  // innerWidth/innerHeight; the other is what the css max-* rule would have
  // re-fitted to, off a live measurement of the 100vw/100vh those percentages
  // resolve against. A device session shows in the deploy log whether the pair
  // ever parts and by how much, instead of the question being argued.
  const restDiag = (b: MorphBox): void => {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;" +
      "visibility:hidden;pointer-events:none";
    document.body.appendChild(probe);
    const unit = probe.getBoundingClientRect();
    probe.remove();
    const css = zoomFit(from.naturalWidth, from.naturalHeight, unit.width, unit.height);
    holdDiagRecord("flight", {
      phase: "zoom-rest",
      iw: Math.round(window.innerWidth), ih: Math.round(window.innerHeight),
      vw: Math.round(unit.width), vh: Math.round(unit.height),
      w: Math.round(b.width), h: Math.round(b.height),
      cssW: Math.round(css.width), cssH: Math.round(css.height),
    });
  };
  const openFrom = threadBox(); // measured with the box reads above, before any write
  freeze(fromBox, fromRadius, openFrom);
  back.style.opacity = "0";
  from.style.opacity = "0"; // the copy IS the photo until it lands back home
  holdDiagRecord("flight", {
    phase: "zoom-open",
    dx: Math.round((to.left - fromBox.left) * 10) / 10,
    dy: Math.round((to.top - fromBox.top) * 10) / 10,
    dw: Math.round(to.width - fromBox.width),
    dh: Math.round(to.height - fromBox.height),
  });
  fly(fromBox, to, fromRadius, restRadius, openFrom, screenBox(), (f) => {
    back.style.opacity = String(f);
  }, () => {
    // The landed geometry stands. Only the backdrop hands itself back to css;
    // the copy keeps the box the flight wrote, so nothing gets a second say on
    // this frame. The refit answers a viewport that moved DURING the flight,
    // out of that same one source, and is a no-op when it did not.
    back.removeAttribute("style");
    atRest = true;
    refit();
    restDiag(restBox()); // the box that now stands, re-read from the one source
  });
  let closing = false;
  overlay.addEventListener("click", () => {
    if (closing) return;
    closing = true;
    atRest = false; // the close flight owns the geometry from here, not the refit
    // the spot is re-read NOW, not remembered from the open
    const origin = from.isConnected ? boxOf(from.getBoundingClientRect()) : null;
    const cur = boxOf(img.getBoundingClientRect());
    const ret = zoomReturn(origin, cur, window.innerWidth, window.innerHeight);
    const curRadius = parseFloat(getComputedStyle(img).borderTopLeftRadius) || 0;
    const endRadius = ret.mode === "exact"
      ? parseFloat(getComputedStyle(from).borderTopLeftRadius) || 0
      : curRadius;
    const back0 = back.style.opacity ? parseFloat(back.style.opacity) : 1;
    const clipFrom = clipNow; // a mid-open tap turns home from the cut it has now
    // the cut closes back onto the thread's box, so the landed frame is cut
    // exactly like the photo it uncovers and the handover moves no pixel. The
    // other two modes have no photo to land on and dissolve on their way out of
    // the screen, so their cut stays open and the exit is the one it always was.
    const clipTo = ret.mode === "exact" ? threadBox() : screenBox();
    freeze(cur, curRadius, clipFrom); // a mid-open tap turns home from wherever the copy is
    holdDiagRecord("flight", {
      phase: "zoom-close",
      mode: ret.mode,
      dx: Math.round((ret.box.left - cur.left) * 10) / 10,
      dy: Math.round((ret.box.top - cur.top) * 10) / 10,
      dw: Math.round(ret.box.width - cur.width),
      dh: Math.round(ret.box.height - cur.height),
    });
    fly(cur, ret.box, curRadius, endRadius, clipFrom, clipTo, (f) => {
      back.style.opacity = String(back0 * (1 - f));
      if (ret.mode !== "exact") img.style.opacity = String(1 - f); // no spot to land on: dissolve
    }, () => {
      // the landed copy painted exactly over the photo once; now, one task:
      // the photo back, the copy gone — no frame holds both, none holds neither
      window.removeEventListener("resize", refit); // nothing left to re-aim
      from.style.removeProperty("opacity");
      if (!from.getAttribute("style")) from.removeAttribute("style");
      overlay.remove();
    });
  });
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
    img.alt = "photo";
    img.onload = () => {
      photoQueue.arrived(img); // the grey box comes off with the first pixels
      // decoded height lands late; re-pin INSTANTLY — a layout completion must
      // never glide (the opening-scroll motion he flagged came from these)
      if (followTail) scrollToBottom(true);
    };
    img.onerror = () => {
      photoQueue.arrived(img); // no pixels are coming; the chip replaces the box
      div.classList.replace("shot", "text");
      div.appendChild(chip("📎 photo"));
      img.remove();
    };
    img.addEventListener("click", () => openLightbox(img.src, img));
    // the url is PARKED, not fetched (photolazy.ts): a photo far from the
    // screen never opens a connection, and the box reserved above sits grey
    // with a ring in it until the reader comes within a screen of it
    photoQueue.hold(img, thumbUrl(key));
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
  img.addEventListener("click", () => openLightbox(value, img));
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

// A MOVE to a newer sent message is that same fade with the travel in the
// middle: the stamp fades out where it stands, crosses while it is invisible,
// and fades back in under the newer bubble. It never snaps to the new seat,
// which is the one thing the real messages app never does. data-travel says
// which beat a move is on: "fade" while the label is still on its way to
// opacity 0, "dark" once it is there and the crossing is owed. The crossing
// itself must cost the thread no height (receiptTravel below).

// build a fresh receipt: an .rc text layer inside the #receipt box, plus the
// one persistent handler that drives every later flip. Reaching opacity 0 (the
// rc-hide fade-out just finished) swaps the now-invisible text to the newest
// target and releases the fade back in. If a move is owed, the crossing runs
// first instead and releases the fade itself. Reaching opacity 1 is the end,
// no work.
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
    if (el.dataset.travel) return receiptTravel(el); // a move is owed: cross still dark
    layer.classList.remove("rc-hide"); // fade the new word in
  });
  el.appendChild(layer);
  return el;
}

// The invisible beat of a move. The label has just reached opacity 0, so the
// stamp can cross to the newer bubble with none of it showing, provided the
// crossing moves nothing else. It does not: updateReceipt re-parents the SAME
// element, and re-appending an already-attached node is one DOM move, never a
// detach followed by an insert, so the stamp's box is never absent from the
// thread and the thread's height is identical before and after. The only
// element whose position genuinely differs between the two layouts is the
// newer bubble's seat, one stamp-height higher once the stamp sits below it
// rather than above it; the sibling shift glides that hop on the shared beat
// instead of letting it jump under an invisible label. While a flight is still
// airborne the move parks instead, because opening a shift here would cancel
// the flight's own glide, and flightSettled applies the move inside the shift
// it already opens.
function receiptTravel(el: HTMLElement): void {
  el.dataset.travel = "dark";
  holdDiagRecord("receipt-hold", { phase: "dark", flights: flightsUp });
  if (flightsUp > 0) return updateReceipt(); // parks on the gate; flightSettled lands it
  const shift = beginSiblingShift();
  updateReceipt();
  shift.play();
}

function updateReceipt(): void {
  const r = receiptFor(store.values());
  const wrapper = r ? wrapperFor(r.seq) : null;
  const existing = document.getElementById("receipt");
  if (!r || !wrapper) {
    if (!existing) return;
    // the bare removal shifts every row above the stamp exactly like a
    // relocation does — a flight in progress parks it on the same slot
    if (flightsUp > 0) {
      receiptPending = true;
      holdDiagRecord("receipt-hold", { phase: "park" });
      return;
    }
    existing.remove(); // nothing to stamp, or the newest sent message sits above the loaded window
    return;
  }
  const layer = existing?.querySelector<HTMLElement>(".rc") ?? null;
  if (existing && existing.parentElement === wrapper) {
    // Same bubble, so only the LABEL can have changed: fade it, don't snap it.
    // dataset.state holds the newest TARGET label. A repeat call with the same
    // target no-ops (no stacked fades), and the transitionend swap reads it so
    // the latest state always wins even if it changes mid-fade.
    if (existing.dataset.travel) {
      // a move was owed and the anchor came back under this bubble (a replay
      // took the newer wrapper away): drop it, show the label where it is
      delete existing.dataset.travel;
      existing.dataset.state = r.state;
      layer?.classList.remove("rc-hide");
    } else if (existing.dataset.state !== r.state) {
      existing.dataset.state = r.state;
      // fade fully out; the persistent handler swaps the text and fades it back
      // in once the layer is invisible. Re-adding rc-hide mid-fade is a harmless
      // no-op, so repeat flips never stack.
      layer?.classList.add("rc-hide");
    }
    if (followTail) scrollToBottom();
    return;
  }
  // The anchor is moving to a newer bubble. Beat one: fade out where it stands.
  // Opacity only, nothing in the layout touched, so this starts the moment the
  // move is known, mid-flight included, which is what leaves the label already
  // dark by the time the bubble lands. Beats two and three (cross, fade in) run
  // off the layer's transitionend at opacity 0, through receiptTravel. A repeat
  // call re-arms the same beat: rc-hide is already on, the running fade owns it.
  // Replay bursts (suppressAnim) never fade, since no transition would run to
  // end one, so they fall through to the immediate rebuild below.
  if (existing && layer && existing.dataset.travel !== "dark" && !suppressAnim) {
    existing.dataset.state = r.state; // the newest target word, swapped while dark
    existing.dataset.travel = "fade";
    layer.classList.add("rc-hide");
    holdDiagRecord("receipt-hold", { phase: "fade" });
    return;
  }
  // On a fast connection the send ACK lands mid-flight (real ACKs in 50-200ms
  // against the 400ms beat), and crossing the ~18px stamp then, out from under
  // the previous bubble and in under the flying one, jolts the landing seat and
  // everything above it while the bubble is airborne: the end-of-send bounce.
  // Park the move until the flight settles; flightSettled applies it. The gate
  // is the live animation count, so sends with no flight (and ACKs landing
  // after touchdown) keep the immediate path.
  if (flightsUp > 0) {
    receiptPending = true;
    holdDiagRecord("receipt-hold", { phase: "park" });
    return;
  }
  if (existing && layer && existing.dataset.travel === "dark") {
    // Beat two: cross while invisible. appendChild on an ALREADY-ATTACHED node
    // is a single DOM move, so the stamp's box never leaves the thread and no
    // height is lost in between. No row can drop into a gap the label is not
    // there to explain. Beat three releases the fade in the same task, so the
    // label comes back up under the newer bubble.
    delete existing.dataset.travel;
    existing.dataset.state = r.state;
    layer.textContent = r.state;
    wrapper.appendChild(existing);
    // re-parenting rebuilds the layer's resolved style, and a style resolved
    // for the first time never transitions. Read it back at opacity 0 first so
    // the browser has a value to start FROM, then release the class.
    void layer.offsetHeight;
    layer.classList.remove("rc-hide");
    holdDiagRecord("receipt-hold", { phase: "travel" });
    if (followTail) scrollToBottom();
    return;
  }
  existing?.remove(); // nothing to carry across: the first stamp, or a replay snap
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
    tail = Math.max(lastSeq, replayBufferMax); // whatever has arrived, buffered included
  }
  bootGate.tailKnown(tail);
  replaySettle();
}

// the backlog is fully covered — applied or buffered — (the ledger's
// caught-up edge, once per socket): the buffered catch-up commits as ONE
// task, animations come on, and the boot settle runs — this used to hang off
// a 400ms quiet timer that late replay frames could outlive
function replaySettle(): void {
  if (!document.getElementById("thread")) return; // the gate replaced the shell mid-flight
  if (!bootGate.caughtUp(Math.max(lastSeq, replayBufferMax))) return;
  commitReplayBuffer(); // the whole catch-up lands here, in this same task
  suppressAnim = false;
  // settled: probe the history bank once — a short thread never scrolls, so
  // without this the spinner would sit unresolved forever
  tryApplyOlder();
  void bootSettlePin();
  // one cheap look back at the newest page: a reply retracted while the app
  // was closed (or the socket was down — retract frames are ephemeral) must
  // not survive on screen just because the cache or the store replayed it
  void reconcileRetracts();
}

// the batching half of the cold-open fix: the buffered backlog applies in one
// synchronous task, oldest first, through the same silent applyReplay path a
// straggler takes — one decorate'd DOM state, one bottom pin, one paint,
// whether it is three frames after an hour away or fifty after a reinstall
function commitReplayBuffer(): void {
  const frames = replayBuffer;
  replayBuffer = [];
  replayBufferMax = 0;
  frames.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  for (const m of frames) applyReplay(m);
  holdDiagRecord("batch-commit", { n: frames.length });
}

// After the settle, ask the server for its newest page ONCE and drop any
// stored seq inside that page's span the server no longer has: a take-back
// that happened while this client was closed or disconnected never sent us
// its retract frame (retracts are ephemeral broadcasts), so the cached reply
// would otherwise stand forever. Bounded to the page's own span — seqs above
// it may be frames landing this instant, seqs below it are beyond one cheap
// fetch — and removal rides the same applyRetract path a live take-back uses.
async function reconcileRetracts(): Promise<void> {
  let messages: ServerMsg[];
  try {
    const r = await fetch(
      `/api/history/${THREAD_ID}?before=${Number.MAX_SAFE_INTEGER}&limit=${HISTORY_PAGE}`,
      { headers: authHeaders() },
    );
    if (!r.ok) return;
    ({ messages } = (await r.json()) as { messages: ServerMsg[] });
  } catch {
    return; // reconcile is best-effort; the next settle gets another look
  }
  if (!document.getElementById("thread")) return;
  const present = new Set(messages.map((m) => m.seq ?? 0).filter((s) => s > 0));
  if (!present.size) return; // an empty page bounds nothing: drop nothing
  const lo = Math.min(...present);
  const hi = Math.max(...present);
  const dropped = [...store.keys()].filter((s) => s >= lo && s <= hi && !present.has(s));
  if (!dropped.length) return;
  holdDiagRecord("reconcile-drop", { seqs: dropped });
  for (const s of dropped) applyRetract(s);
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
  void settleSplashCover(); // a cacheless boot's first paint is this one
}

function connect(): void {
  closingOnPurpose = false;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/ws?token=${encodeURIComponent(token)}&thread=${THREAD_ID}&since=${lastSeq}`;
  suppressAnim = true; // the catch-up replay must not animate or glide
  bootGate.reconnect(); // a new backlog is inbound: everything is replay again
  replayBuffer = []; // an old socket's unfinished catch-up re-delivers via since=
  replayBufferMax = 0;
  if (probeFallback) clearTimeout(probeFallback);
  // the probe can hang, not just fail: past this bound the ledger closes at
  // whatever arrived — tailPending() keeps the timeout from ever lowering a
  // ceiling the probe DID establish (a slow big replay must finish buffering)
  probeFallback = setTimeout(() => {
    probeFallback = null;
    if (!bootGate.tailPending()) return;
    bootGate.tailKnown(Math.max(lastSeq, replayBufferMax));
    replaySettle();
  }, PROBE_FALLBACK_MS);
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
      if (bootGate.settled()) {
        applyReplay(m); // a post-settle straggler: silent, pinned, per-frame
      } else {
        // the streaming catch-up: buffered, committed as ONE task on the
        // caughtUp edge (commitReplayBuffer) — the browser may paint between
        // socket tasks, so per-frame applies are a visible movie by definition
        replayBuffer.push(m);
        if (m.seq > replayBufferMax) replayBufferMax = m.seq;
      }
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
  if (hadStore) cacheWrites.bump(); // the deleted reply must leave the cold-open snapshot too
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

// --- send-flight receipt hold (the end-of-send bounce's last mover) -----------
// While any send-flight animation is airborne, layout-mutating receipt work
// (a relocation to a new bubble, a bare removal) parks in receiptPending — a
// recompute flag, not a snapshot: the apply derives from the store fresh, so
// whatever landed meanwhile wins — and lands when the LAST flight settles,
// finish and cancel alike, so a torn-down flight still gets its stamp. The
// apply rides the sibling-shift machinery: the relocation is height-neutral
// (the stamp's 18px move from above the seat to below it), so no scroll write
// fires, and the seat's hop glides on the shared beat. A moving stamp is the
// SAME element re-parented, so the walk reads it as an existing row that went
// down, not a newborn: its own fade owns its entrance. Only a first-ever stamp
// is a newborn here, and that one fades up into place.
let flightsUp = 0; // send-flight animations still airborne
let receiptPending = false; // updateReceipt work parked until the flights settle

function flightSettled(): void {
  if (flightsUp > 0) flightsUp--;
  if (flightsUp > 0 || !receiptPending) return;
  receiptPending = false;
  if (!document.getElementById("thread")) return; // shell torn down mid-flight
  holdDiagRecord("receipt-hold", { phase: "apply" });
  const shift = beginSiblingShift();
  updateReceipt();
  shift.play();
}

// --- the send morph: the bar leaves the box (his order) -----------------------
// The true iMessage send is not the finished bubble translated down to the
// field — it is the BAR: a shell the typing box's exact rect, pill, face, and
// as-typed text, which lifts out of the composer and compresses into the
// bubble's box while it rises, landing on the seat. The shell is a
// fixed-position element in <body>: the thread is a scroll container, so
// anything inside it is clipped at the thread's box and could never stand
// over the field — and a fixed shell's per-frame layout is its own, touching
// nothing in the thread (no transformed overflow inflating scrollHeight, the
// old flight's known tax). Its box is real geometry (left/top/width/height
// plus per-corner radius), never transform scale: scale would squash the
// corner circles and the glyphs. The real bubble holds its seat in layout the
// whole time, hidden, and takes over in the shell's landing frame — the
// thread's layout after touchdown is exactly what it would have been with no
// flight at all. armFieldMorph is called BEFORE the composer collapse (the
// shell must snapshot the bar while the text is still in it; the collapse
// then happens beneath the opaque shell, so no bare-field frame ever paints),
// and launch() runs in send()'s insert task like the old flight did.

interface FieldMorph {
  launch(msg: HTMLElement): void;
  launched(): boolean;
  cancel(): void;
}

const MORPH_CORNER_PROPS = [
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomRightRadius",
  "borderBottomLeftRadius",
] as const;

function armFieldMorph(textEl: HTMLTextAreaElement): FieldMorph | null {
  const field = document.querySelector(".field");
  if (!field) return null;
  const barRect = field.getBoundingClientRect();
  const bar = {
    left: barRect.left, top: barRect.top, width: barRect.width, height: barRect.height,
  };
  const textRect = textEl.getBoundingClientRect();
  const barRadius = parseFloat(getComputedStyle(field).borderTopLeftRadius) || 18;
  const shell = document.createElement("div");
  shell.className = "morph";
  const writeBox = (b: { left: number; top: number; width: number; height: number }): void => {
    shell.style.left = `${b.left}px`;
    shell.style.top = `${b.top}px`;
    shell.style.width = `${b.width}px`;
    shell.style.height = `${b.height}px`;
  };
  writeBox(bar);
  shell.style.borderRadius = `${barRadius}px`;
  const layer = (cls: string): HTMLDivElement => {
    const el = document.createElement("div");
    el.className = cls;
    shell.appendChild(el);
    return el;
  };
  layer("morph-face-under");
  layer("morph-face-bar");
  const accent = layer("morph-face-accent");
  // the bar's text: cloned at the textarea's exact offset, width, padding, and
  // inner scroll, so the shell's first painted frame is indistinguishable from
  // the box it lifts out of
  const barText = layer("morph-text-bar");
  barText.style.left = `${textRect.left - bar.left}px`;
  barText.style.top = `${textRect.top - bar.top}px`;
  barText.style.width = `${textRect.width}px`;
  barText.style.padding = getComputedStyle(textEl).padding;
  barText.style.transform = `translateY(${-textEl.scrollTop}px)`;
  barText.textContent = textEl.value;
  const bubbleText = layer("morph-text-bubble"); // geometry lands at launch
  document.body.appendChild(shell);
  holdDiagRecord("flight", {
    phase: "morph-arm", barW: Math.round(bar.width), barH: Math.round(bar.height),
  });
  let raf = 0;
  let up = false;
  const settle = (msg: HTMLElement, phase: string): void => {
    // hand the seat back to the real bubble, byte-clean: the flight was pure
    // presentation, so the landed thread must carry no trace of it
    msg.style.removeProperty("opacity");
    if (!msg.getAttribute("style")) msg.removeAttribute("style");
    shell.remove();
    holdDiagRecord("flight", { phase });
    flightSettled();
  };
  return {
    launched: () => up,
    cancel(): void {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      shell.remove(); // never launched: nothing hidden, nothing airborne
    },
    launch(msg: HTMLElement): void {
      up = true;
      const seat0 = msg.getBoundingClientRect();
      const style = getComputedStyle(msg);
      const corners = MORPH_CORNER_PROPS.map((prop) => parseFloat(style[prop]) || 0);
      // the bubble's laid-out text, locked to the seat's width so it wraps
      // exactly as the real bubble did — the landing swap is pixel-identical
      bubbleText.style.width = `${seat0.width}px`;
      bubbleText.textContent = msg.textContent;
      msg.style.opacity = "0"; // the shell IS the bubble until it lands
      flightsUp++;
      holdDiagRecord("flight", {
        phase: "morph-launch",
        dx: Math.round((bar.left + bar.width - seat0.right) * 10) / 10,
        dy: Math.round((bar.top - seat0.top) * 10) / 10,
        toW: Math.round(seat0.width), toH: Math.round(seat0.height),
      });
      const t0 = performance.now();
      const step = (now: number): void => {
        raf = 0;
        if (!msg.isConnected) return settle(msg, "morph-cancel"); // replay/teardown took the seat
        const f = Math.min((now - t0) / FLIGHT_MS, 1);
        const p = flightEase(f);
        // the seat is re-read every frame: a second send's pin-and-shift (or a
        // reply landing mid-flight) moves it, and the shell must land on the
        // seat as it IS, not as it was at launch — the tracking the old FLIP
        // translate got for free by riding the element itself
        const seat = msg.getBoundingClientRect();
        writeBox(morphBox(
          bar,
          { left: seat.left, top: seat.top, width: seat.width, height: seat.height },
          p,
        ));
        shell.style.borderRadius =
          morphCorners(barRadius, corners, p).map((c) => `${c.toFixed(1)}px`).join(" ");
        accent.style.opacity = String(accentAlpha(f));
        barText.style.opacity = String(barTextAlpha(f));
        bubbleText.style.opacity = String(bubbleTextAlpha(f));
        if (f < 1) {
          raf = requestAnimationFrame(step);
        } else {
          // the landed box paints once (shell and bubble now pixel-identical),
          // THEN the swap — settling in the write's own frame could drop the
          // landing frame under load and read as a snap
          raf = requestAnimationFrame(() => settle(msg, "morph-finish"));
        }
      };
      raf = requestAnimationFrame(step);
    },
  };
}

// iMessage send flight: the fresh bubble lifts out of the compose field and
// rises into its thread seat. The TEXT row rides the morph above — the bar
// itself compressing into the bubble; photo rows keep the FLIP translate (the
// bubble laid out in its final spot, instantly translated back to the field's
// rect, then released), because the bar never contained the photos — they
// stage in the pending tray, and a bar morphing into a photo would be a
// motion with no referent. Replayed and received bubbles keep their ordinary
// entrance. The flight must always play (standing order) — no reduced-motion
// gate. Every invocation leaves a trail record with the measured per-bubble
// dx/dy and the animation's start and finish/cancel, so a device session
// where nothing visibly moved shows WHY (near-zero deltas are themselves the
// finding).
function flyFromField(wrapper: HTMLElement, morph: FieldMorph | null = null): void {
  const field = document.querySelector(".field");
  const msgs = wrapper.querySelectorAll<HTMLElement>(".msg");
  holdDiagRecord("flight", { phase: "invoke", msgs: msgs.length, field: field !== null });
  if (!field || !msgs.length) {
    morph?.cancel();
    return;
  }
  const start = field.getBoundingClientRect();
  msgs.forEach((msg, i) => {
    if (morph && msg.classList.contains("text")) {
      morph.launch(msg);
      return;
    }
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
    flightsUp++;
    holdDiagRecord("flight", {
      phase: "start", i, dx: Math.round(dx * 10) / 10, dy: Math.round(dy * 10) / 10,
    });
    anim.finished.then(
      () => {
        holdDiagRecord("flight", { phase: "finish", i });
        flightSettled();
      },
      () => {
        holdDiagRecord("flight", { phase: "cancel", i });
        flightSettled();
      },
    );
  });
  if (morph && !morph.launched()) morph.cancel(); // no text row rendered: no seat to morph into
  recordSendMotion(msgs[msgs.length - 1]);
}

// ===================== TEMP DIAGNOSTIC (remove after the hold session) =====================
// Send-window motion recorder, riding the same holddiag trail as the reply-hold
// probe (hold.ts explains the ring and the POST). From flight start until
// SEND_MOTION_WINDOW_MS after it, every animation frame compares the thread's
// scrollTop and scrollHeight and the flying bubble's landing-seat top — its
// rect with the running transform stripped, so the SEAT is measured, not the
// bubble flying toward it — against the previous frame; any move past 1px
// lands one send-motion record naming the mover, capped so a busy window
// cannot flood the ring. If the owner still sees end-of-send movement after
// the receipt hold, this trail names the frame and the moved quantity.

const SEND_MOTION_WINDOW_MS = 600; // the 400ms beat plus a landing tail
const SEND_MOTION_MAX = 40; // records per window, not frames
let sendMotionRaf = 0;

// the seat: the bubble's viewport top with every running translate stripped,
// its own flight transform and any FLIP riding an ancestor row alike — layout
// truth, not the bubble flying toward it. The strip walks to the thread so
// the sibling-shift's row transforms cannot masquerade as seat motion.
function seatTop(msg: HTMLElement): number {
  let top = msg.getBoundingClientRect().top;
  for (let el: HTMLElement | null = msg; el && el.id !== "thread"; el = el.parentElement) {
    const t = getComputedStyle(el).transform;
    if (t !== "none") top -= new DOMMatrixReadOnly(t).f;
  }
  return top;
}

function recordSendMotion(msg: HTMLElement): void {
  if (sendMotionRaf) cancelAnimationFrame(sendMotionRaf); // a rapid second send re-arms the window
  const t0 = performance.now();
  let recorded = 0;
  let prev: [number, number, number] | null = null;
  const step = (): void => {
    sendMotionRaf = 0;
    const t = document.getElementById("thread");
    if (!t || !msg.isConnected) return; // shell torn down, or a replay replaced the wrapper
    // the flight's own translate holds the bubble below the content edge, and
    // scrollHeight counts that transformed overflow (the send() collapse
    // comment has the history) — subtract the part poking past the thread's
    // own bottom padding, so the height channel reports only real layout
    // growth, not the flight deflating frame by frame
    const tr = getComputedStyle(msg).transform;
    const pad = parseFloat(getComputedStyle(t).paddingBottom) || 0;
    const overflow = tr === "none" ? 0 : Math.max(0, new DOMMatrixReadOnly(tr).f - pad);
    const cur: [number, number, number] = [t.scrollTop, t.scrollHeight - overflow, seatTop(msg)];
    if (prev) {
      (["scroll", "height", "seat"] as const).forEach((name, i) => {
        const delta = cur[i] - prev![i];
        if (Math.abs(delta) > 1 && recorded < SEND_MOTION_MAX) {
          recorded++;
          holdDiagRecord("send-motion", {
            at: Math.round(performance.now() - t0), moved: name,
            delta: Math.round(delta * 10) / 10,
          });
        }
      });
    }
    prev = cur;
    if (performance.now() - t0 < SEND_MOTION_WINDOW_MS) {
      sendMotionRaf = requestAnimationFrame(step);
    }
  };
  sendMotionRaf = requestAnimationFrame(step);
}
// =================== END TEMP DIAGNOSTIC (remove after the hold session) ===================

// ===================== TEMP DIAGNOSTIC (remove after the cold-open session) =====================
// Boot-window motion recorder, riding the holddiag trail like the send-window
// one above. The 4-of-5 cold-open drop is the app frame settling after the
// cached paint, and only the device knows WHICH quantity settles late: from
// module init until BOOT_MOTION_TAIL_MS past the first content paint, every
// animation frame reads the shell box, the safe-area paddings as consumed
// (computed style on the header and compose bar, where env() actually lands),
// the document and thread scroll positions, the thread's scrollHeight, the
// first message's viewport top, and the visual viewport's offset and height.
// Any channel that moved past 1px lands one boot-motion record naming the
// mover and the distance, capped so a busy boot cannot flood the ring — the
// next device session's deploy logs then name the culprit precisely.

const BOOT_MOTION_TAIL_MS = 2000; // sampling continues this long past first content
const BOOT_MOTION_LEAD_MAX_MS = 15000; // content never painted (token gate): stop
const BOOT_MOTION_MAX = 60; // records for the whole window, not frames

function bootMotionChannels(): Record<string, number | null> {
  const shell = document.getElementById("app");
  const box = shell ? shell.getBoundingClientRect() : null;
  const bar = document.querySelector(".bar");
  const compose = document.getElementById("compose");
  const thread = document.getElementById("thread");
  // .evt wrappers are display:contents (no box of their own): the first
  // LAID-OUT descendant — the stamp or row the first message paints — is the
  // honest "where does content start" reading
  const first = thread?.querySelector(".evt > *");
  const vv = window.visualViewport;
  return {
    "shell-top": box ? box.top : null,
    "shell-h": box ? box.height : null,
    "inset-top": bar ? parseFloat(getComputedStyle(bar).paddingTop) : null,
    "inset-bottom": compose ? parseFloat(getComputedStyle(compose).paddingBottom) : null,
    "doc-scroll": window.scrollY,
    "thread-scroll": thread ? thread.scrollTop : null,
    "thread-sh": thread ? thread.scrollHeight : null,
    "first-msg-top": first ? first.getBoundingClientRect().top : null,
    "vv-top": vv ? vv.offsetTop : null,
    "vv-h": vv ? vv.height : null,
  };
}

function startBootMotion(): void {
  if (typeof document === "undefined" || document.getElementById("app") === null) return;
  const t0 = performance.now();
  let contentAt = 0;
  let recorded = 0;
  let prev: Record<string, number | null> | null = null;
  const step = (): void => {
    const nowMs = performance.now();
    if (!contentAt && document.querySelector("#thread .evt")) contentAt = nowMs;
    const cur = bootMotionChannels();
    if (prev) {
      for (const [name, v] of Object.entries(cur)) {
        const was = prev[name];
        if (v === null || was === null || was === undefined) continue; // channel absent: not motion
        const delta = v - was;
        if (Math.abs(delta) > 1 && recorded < BOOT_MOTION_MAX) {
          recorded++;
          holdDiagRecord("boot-motion", {
            at: Math.round(nowMs - t0), moved: name,
            delta: Math.round(delta * 10) / 10, v: Math.round(v * 10) / 10,
          });
        }
      }
    }
    prev = cur;
    const done = contentAt
      ? nowMs - contentAt > BOOT_MOTION_TAIL_MS
      : nowMs - t0 > BOOT_MOTION_LEAD_MAX_MS;
    if (!done) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
startBootMotion();
// =================== END TEMP DIAGNOSTIC (remove after the cold-open session) ===================

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
// dots. Walked newest-first from the tail, bounded — the shift only ever
// concerns the last screen or two.
function laidOutTail(): HTMLElement[] {
  const out: HTMLElement[] = [];
  let n = threadEl().lastElementChild;
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

// entrance for elements BORN with the motion (no before-rect to FLIP from):
// the newborn fades up into the space the glide opened, on the flight's own
// beat and ease, so nothing materializes at full size mid-animation. Created
// in the same task as the insert, so the element never paints pre-animation
// (the same WebKit-proof property flyFromField leans on). Its LAYOUT space
// still opens in one frame — the glide above covers it while the occupant
// fades in, so the space itself is never bare.
function enterNewborn(el: HTMLElement): void {
  el.animate(
    [
      { opacity: 0, transform: `translateY(${ENTER_RISE_PX}px)` },
      { opacity: 1, transform: "none" },
    ],
    { duration: FLIGHT_MS, easing: FLIGHT_EASE },
  );
}

function beginSiblingShift(): { play(): void } {
  // eligibility is the pre-send view: pinned (or near) the bottom. A send from
  // deep in history pins with an intentional jump cut — animating THAT would
  // turn the instant pin into a slow scroll of the whole distance.
  const eligible = followTail || nearBottom();
  const before = new Map<HTMLElement, number>();
  if (eligible) {
    for (const el of laidOutTail()) before.set(el, el.getBoundingClientRect().top);
  }
  // measured first, cancelled second: the before-tops keep the mid-flight
  // visual truth, and everything from here through play() is one synchronous
  // task — nothing paints in the cancelled state
  for (const a of shiftAnims) a.cancel();
  shiftAnims = [];
  return {
    play(): void {
      if (!eligible) {
        holdDiagRecord("flight", { phase: "shift-skip", reason: "away" });
        return;
      }
      const view = threadEl().getBoundingClientRect();
      let maxDelta = 0;
      let rows = 0;
      let entered = 0;
      // the walk starts at the true tail, not above the send's wrapper: the
      // newborn stamp decorate() just created lives INSIDE it, above the
      // flying rows, and send() is synchronous from measure through play, so
      // everything unseen at measure time was born with this send
      for (const el of laidOutTail()) {
        const beforeTop = before.get(el);
        const carriesFlight = el.classList.contains("msg") || el.querySelector(".msg") !== null;
        if (newbornEnter(beforeTop !== undefined, carriesFlight)) {
          enterNewborn(el); // born with this send: it fades up on the same beat
          entered++;
          continue;
        }
        if (beforeTop === undefined) continue; // the flying rows: the flight owns them
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
      holdDiagRecord("flight", { phase: "enter", n: entered });
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

// --- the sent photo's seat, reserved before the row lands ---------------------
// A photo row inserted with no size is zero tall until its pixels decode, and
// send() pins the thread to the bottom immediately after the insert, so that pin
// used to land on a bubble that had not grown yet; the decode then grew the row
// downward and the photo came to rest as a thin top sliver under the compose
// bar. The file's own pixels are therefore read FIRST: the element and its blob
// URL are made here and its load awaited, so the row can be laid out at full
// height before anything measures, pins, or flies.
//
// The read is deadlined. A file that never reports a size must not hold the
// optimistic bubble back, because instant feedback on tap outranks a perfect
// seat; a read that fails or runs late yields no size and the row falls back to
// the old unsized behaviour, re-pinning when the pixels land like every other
// photo kind. Every outcome lands on the flight trail, so a device session says
// whether the seat was reserved and at what size.

const SHOT_DIMS_MS = 350; // a local blob reports its size in a few ms; this is the safety valve

interface Shot {
  img: HTMLImageElement;
  nat: [number, number] | null; // the file's own pixels, null when unknown
}

function prepareShot(file: File): Promise<Shot> {
  const img = document.createElement("img");
  img.src = URL.createObjectURL(file);
  return new Promise<Shot>((resolve) => {
    let timer = 0;
    let settled = false;
    const settle = (why: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const nat: [number, number] | null =
        img.naturalWidth > 0 && img.naturalHeight > 0
          ? [img.naturalWidth, img.naturalHeight]
          : null;
      holdDiagRecord("flight", {
        phase: "shot-dims", why, w: nat ? nat[0] : 0, h: nat ? nat[1] : 0,
      });
      resolve({ img, nat });
    };
    timer = window.setTimeout(() => settle("late"), SHOT_DIMS_MS);
    img.addEventListener("load", () => settle("load"), { once: true });
    img.addEventListener("error", () => settle("error"), { once: true });
  });
}

// the width one .row spans: the thread's content box, since rows are its direct
// flex children (the .evt wrappers are display:contents and have no box)
function threadContentWidth(): number {
  const t = threadEl();
  const cs = getComputedStyle(t);
  return t.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
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

  // the photos' own pixels (prepareShot explains the seat they buy), started
  // here so the read overlaps the composer collapse below instead of adding to
  // it; awaited further down, before anything is measured or inserted
  const shots = files.map(prepareShot);

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
  // the morph shell snapshots the bar BEFORE the collapse empties it — rect,
  // pill, and the typed text, standing over the field — so the collapse (and
  // its re-pin wait) happens beneath the shell and no bare-field frame ever
  // paints; the launch itself still runs after the collapse, in the insert
  // task below. Photo-only sends arm nothing: the bar never contained them.
  const morph = text ? armFieldMorph(textEl) : null;
  if (!airborne) {
    const fieldHBefore = textEl.offsetHeight;
    collapseBar();
    if (textEl.offsetHeight !== fieldHBefore || files.length > 0) {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
  }

  // the last wait: from here down send() is one synchronous task (measure,
  // insert, pin, launch), so every photo's size and the width its bubble gets
  // to share must be in hand NOW. A size arriving after the pin is the sliver.
  const ready = files.length ? await Promise.all(shots) : [];
  const rowW = files.length ? threadContentWidth() : 0;

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
  for (const shot of ready) {
    const div = rowEl(w, "user", "shot", Date.now());
    const img = shot.img;
    if (shot.nat) {
      // the seat: the aspect ratio through the width/height attributes (the
      // stylesheet's height:auto reads it) and the used width from the bubble's
      // share of the row. That is the box the photo still occupies once it
      // paints, so the pin below has nothing left to grow past.
      const box = photoBox(shot.nat[0], shot.nat[1], rowW);
      img.width = shot.nat[0];
      img.height = shot.nat[1];
      img.style.width = `${box.width}px`;
      holdDiagRecord("flight", {
        phase: "shot-reserve",
        w: Math.round(box.width * 10) / 10, h: Math.round(box.height * 10) / 10,
      });
    } else {
      // nothing to reserve: the old unsized row, whose late growth re-pins the
      // bottom the way every other photo kind does
      img.onload = () => {
        if (followTail) scrollToBottom(true);
      };
    }
    img.addEventListener("click", () => openLightbox(img.src, img));
    div.appendChild(img);
  }
  if (text) rowEl(w, "user", "text", Date.now()).textContent = text;
  suppressAnim = prevSuppress;
  decorate();
  setFollowTail(true, "send"); // sending snaps you to the tail
  scrollToBottom(true); // instant pin first; the transforms below play over it
  shift.play(); // preceding rows glide, newborn stamps fade up: no white strip, no pop
  flyFromField(w, morph);
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
      cacheWrites.bump(); // the ACKed send enters the cold-open snapshot like any applied frame
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
      img.addEventListener("click", () => openLightbox(img.src, img));
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
  else cacheWrites.flush(); // hidden: the pending snapshot lands before iOS can freeze the page
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

// The app's OWN copy of that launch image, over its own first frames. The
// phone's image dies the moment the web view takes the page, which is before
// the thread has laid out, so the copy (same splashLayout, same paintSplash,
// identical by construction) covers the handoff and fades once the thread has
// settled. splash.ts owns the lift rule and the cap; this side only reports the
// settle below and lands the lift on the diagnostic trail.
const splashCover = installSplashCover("/splash-logo.png", (why) =>
  holdDiagRecord("splash-cover", { lift: why }),
);

// The cover's settle signal: the boot's messages have been laid out for a frame
// and every image the thread painted has finished loading. Called from the
// cached paint and, on a cacheless boot, from the socket's first settle; the
// cover ignores every call after the first, and its own cap lifts it whatever
// happens here.
async function settleSplashCover(): Promise<void> {
  if (splashCover.lifted()) return;
  const t = document.getElementById("thread");
  if (!t) {
    splashCover.settled(); // no thread to wait on (the token gate)
    return;
  }
  await new Promise<void>((r) => requestAnimationFrame(() => r())); // laid out and painted
  const pending = Array.from(t.querySelectorAll<HTMLImageElement>("img"))
    .filter((img) => !img.complete);
  await Promise.allSettled(pending.map((img) => img.decode()));
  splashCover.settled();
}

// Launch frame settle (the 4-of-5 cold-open drop): iOS standalone can publish
// its final frame AFTER the cached paint — the layout viewport growing into
// its real height, or the splash handoff leaving the visual viewport panned —
// and the only boot-time coverage was thread-box resizes (threadObserver) and
// a window snap-back gated on composer focus (the module-level scroll
// listener), so a launch settle moved the whole pinned thread in plain sight.
// For this window after boot, every window/visual-viewport geometry event
// clears launch displacement (the keyboard close pass's own conditional
// write, shell.ts closeCorrectionNeeded) and re-pins the thread bottom, in
// the event's own task so the settle and the correction paint together.
// Keyboard sessions are excluded: once the composer holds focus the shell
// owns vv events (shell.ts) and the close-time pass owns displacement — this
// guard must never become a second mid-typing fighter.
const FRAME_SETTLE_MS = 2000;

function armBootFrameGuard(): void {
  const onGeometry = (src: string): void => {
    if (document.activeElement?.id === "text") return; // shell.ts owns focus geometry
    if (app.classList.contains("kb")) return;
    const x = Math.round(window.scrollX);
    const y = Math.round(window.scrollY);
    const top = Math.round(window.visualViewport?.offsetTop ?? 0);
    const snap = closeCorrectionNeeded(x, y, top);
    // clears scroll AND pan on the unscrollable document (cannot loop: the
    // write refires scroll once with everything already 0)
    if (snap) window.scrollTo(0, 0);
    const t = document.getElementById("thread");
    let repin = false;
    if (t && followTail) {
      repin = t.scrollHeight - t.scrollTop - t.clientHeight >= 1;
      if (repin) t.scrollTop = t.scrollHeight; // instant: a settle must not glide
    }
    if (snap || repin) holdDiagRecord("boot-repin", { src, x, y, top, snap, repin });
  };
  const vv = window.visualViewport;
  const subs: Array<[EventTarget, string, EventListener]> = [
    [window, "resize", () => onGeometry("resize")],
    [window, "scroll", () => onGeometry("scroll")],
  ];
  if (vv) {
    subs.push([vv, "resize", () => onGeometry("vv-resize")]);
    subs.push([vv, "scroll", () => onGeometry("vv-scroll")]);
  }
  for (const [target, ev, fn] of subs) target.addEventListener(ev, fn);
  setTimeout(() => {
    for (const [target, ev, fn] of subs) target.removeEventListener(ev, fn);
  }, FRAME_SETTLE_MS);
}

// Cold open, the one-paint boot: the shell has rendered; now the cached
// thread (threadcache.ts) lands BEFORE any network. Every cached frame goes
// through the one applyEvent path in a single task with animations
// suppressed, the bottom pins instantly, and the bottom is re-pinned from
// FRESH geometry on the next frame — Safari sometimes swallows the first
// scrollTop write after a fresh DOM build, and a frame settling between the
// pin and that paint must not be re-asserted stale — then the socket
// connects with since=lastSeq. On the common open (nothing new) the replay
// is empty and nothing on screen ever moves; anything newer buffers and
// lands as commitReplayBuffer's one update. The ledger needs no special
// case: the probe's tail sits at or above the cached cursor, so every
// cached seq classifies as replay by construction. A missing, mismatched,
// or unreadable record simply means the old cacheless boot.
async function bootFromCache(): Promise<void> {
  armBootFrameGuard(); // the settle window opens with the boot, cache or not
  const t0 = performance.now();
  const cached = await cacheGet<ServerMsg>(THREAD_ID).catch(() => null);
  const readMs = Math.round(performance.now() - t0);
  const t = document.getElementById("thread");
  if (cached && cached.frames.length && t) {
    holdDiagRecord("cache-read", { frames: cached.frames.length, ms: readMs });
    const prevSuppress = suppressAnim;
    suppressAnim = true; // cached frames are history: no pops, no glides
    for (const m of cached.frames) applyEvent(m);
    suppressAnim = prevSuppress;
    if (cached.lastSeq > lastSeq) lastSeq = cached.lastSeq; // a retracted tail still advances the cursor
    scrollToBottom(true);
    requestAnimationFrame(() => {
      const el = document.getElementById("thread");
      // the swallowed-first-write re-assert, from live geometry: writing the
      // captured value back re-pinned a frame iOS had already re-sized under it
      if (el) el.scrollTop = el.scrollHeight;
    });
    holdDiagRecord("cache-applied", { lastSeq, ms: Math.round(performance.now() - t0) });
    void settleSplashCover(); // the cached thread is the first paint: the cover can go
  } else {
    holdDiagRecord("cache-read", { frames: 0, ms: readMs });
  }
  connect(); // ws.onopen runs the version check; see checkServerVersion
}

if (token) {
  renderChat();
  void bootFromCache(); // the cached thread paints first, then the socket connects
} else {
  renderTokenGate();
  void settleSplashCover(); // no thread on this path: the cover holds its minimum and goes
}

