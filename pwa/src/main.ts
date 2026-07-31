// Paratrooper PWA — message the pinboard agent. Vanilla TS + DOM (lightest build).
// Same-origin /api + /ws (the FastAPI service serves this bundle in production).
import "./styles.css";
import { receiptFor } from "./receipts";
import { bindPicker, currentFileInput, initShell, setShellLogger } from "./shell";
import { initTapLog } from "./taplog";

declare const __BUILT_AT__: string;
declare const __SERVER_VERSION__: string; // server commit this bundle was built against

const APP_VERSION = "0.1.61-dbg"; // spinner redrawn as a smooth-tail activity ring (the border spinner read as sliced)

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

// The client-side event store: seq → ThreadEvent, THE display truth. Apply is
// idempotent (duplicate seqs no-op — reconnect replays and zombie-socket
// re-deliveries vanish here) and ordered (older pages and out-of-order frames
// insert in position). The DOM is a projection of this map, never the state.
const store = new Map<number, ServerMsg>();

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
// taplog BEFORE initShell: its raw-event listeners must register first so
// each raw line renders above the shell decision it triggered
setShellLogger(initTapLog());
initShell(app); // keyboard/focus/picker state converges through shell.ts

// editor hold-glow (iMessage): the pill brightens while a finger rests on it
// and fades back on release. Skipped during the settling window — a held tap
// must not glow a switched-off box. Module-level with live lookups, like the
// menu-close below, so re-renders can't stack listeners.
// the glow's light spot sits at the finger: --gx/--gy feed the overlay's
// radial gradient (styles.css .field::before) and track while held
function aimGlow(field: HTMLElement, e: PointerEvent): void {
  const r = field.getBoundingClientRect();
  field.style.setProperty("--gx", `${e.clientX - r.left}px`);
  field.style.setProperty("--gy", `${e.clientY - r.top}px`);
}
document.addEventListener(
  "pointerdown",
  (e) => {
    const t = e.target;
    if (t instanceof HTMLElement && t.id === "text" && !app.classList.contains("settling")) {
      const field = t.parentElement;
      if (field) {
        aimGlow(field, e);
        field.classList.add("glow");
      }
    }
  },
  true,
);
document.addEventListener(
  "pointermove",
  (e) => {
    const field = document.querySelector<HTMLElement>(".field.glow");
    if (field) aimGlow(field, e);
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
      <div class="empty">Send a photo, link, or song to update the board. 🪂</div>
    </main>
    <button type="button" id="jump" class="jump" title="Jump to latest">↓</button>
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
  // compose grows with content like iMessage (1 -> ~5 lines, then inner scroll)
  const textEl = document.getElementById("text") as HTMLTextAreaElement;
  const autosize = (): void => {
    textEl.style.height = "auto";
    // exact fit = nothing to scroll-bounce. The textarea is borderless now
    // (the .field wrapper carries the glass), so scrollHeight IS the full
    // border-box need — the old +2 border compensation would reopen the gap
    textEl.style.height = `${Math.min(textEl.scrollHeight, 120)}px`;
  };
  textEl.addEventListener("input", () => {
    autosize();
    refreshSend();
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
  thread.addEventListener("scroll", () => {
    // the ONE place following flips: away from the bottom = reading history,
    // back at the bottom = following again (programmatic pins land here too)
    followTail = nearBottom();
    if (followTail) document.getElementById("jump")?.classList.remove("show");
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
    document.getElementById("jump")!.classList.remove("show");
    followTail = true;
    scrollToBottom(true);
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
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      peeking = null;
      threadTouching = true; // no history inserts under a resting finger
    },
    { passive: true },
  );
  thread.addEventListener(
    "touchmove",
    (e) => {
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
  oldestSeq = 0;
  pendingOlder = []; // banked pages hold stale seqs from the old session
  fetchCursor = 0;
  historyDone = false;
  followTail = true;
  threadObserver?.disconnect(); // the old shell's thread element is gone
  threadObserver?.observe(thread);
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
let followTail = true;

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
  else threadEl().appendChild(wrapper);
  if (wrapper.childElementCount > 0) threadEl().querySelector(".empty")?.remove();
  decorate();
  // pinned-viewport handling for older pages lives in loadOlder; only tail
  // applies drive the scroll/chevron rules
  if (isTail && wrapper.childElementCount > 0) {
    if (m.role === "user") followTail = true; // your own message snaps you back
    if (followTail) scrollToBottom();
    else document.getElementById("jump")?.classList.add("show");
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

function updateReceipt(): void {
  document.getElementById("receipt")?.remove();
  const r = receiptFor(store.values());
  if (!r) return;
  const wrapper = wrapperFor(r.seq);
  if (!wrapper) return; // newest sent message sits above the loaded window
  const el = document.createElement("div");
  el.id = "receipt";
  el.className = "receipt";
  el.textContent = r.state;
  wrapper.appendChild(el);
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
    t.appendChild(el);
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

// The socket never announces "replay finished", and the old fixed 600ms guess
// let slow replays leak animated glides onto the opening screen. Instead:
// quiet-for-400ms means settled — every replay frame pushes the deadline back,
// so however long the backlog takes, the thread builds with instant pins and
// only starts animating once it is genuinely done.
let settleTimer: ReturnType<typeof setTimeout> | null = null;
function settleAnim(): void {
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    suppressAnim = false;
    // boot settled: probe the history bank once — a short thread never
    // scrolls, so without this the spinner would sit unresolved forever
    tryApplyOlder();
  }, 400);
}

function connect(): void {
  closingOnPurpose = false;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/ws?token=${encodeURIComponent(token)}&thread=${THREAD_ID}&since=${lastSeq}`;
  suppressAnim = true; // the catch-up replay must not animate or glide
  ws = new WebSocket(url);
  ws.onopen = () => {
    settleAnim(); // covers the empty-thread case where no frames arrive
    // every (re)connect re-checks version: a deploy drops the socket, so the
    // reconnect is exactly when a live page may have gone stale
    void checkServerVersion();
  };
  ws.onmessage = (e) => {
    if (!document.getElementById("thread")) return; // gate is showing; don't consume
    const m = JSON.parse(e.data) as ServerMsg;
    if (m.seq && suppressAnim) settleAnim(); // replay still pouring: hold the pins instant
    if (!m.seq) {
      // ephemeral kinds bypass the store: they are presence, not history.
      // (working is keyed now — the stored row drives the Read receipt)
      if (m.kind === "typing") showTyping(); // dots self-expire if it wasn't for you
      return;
    }
    applyEvent(m); // live, replayed, and paged frames all take the same path
  };
  ws.onclose = () => {
    if (closingOnPurpose || !token) return; // logout: stay closed
    setTimeout(connect, 2000); // dropped: reconnect; catch-up via ?since=
  };
}

// iMessage send flight: the fresh bubble lifts out of the compose field and
// springs up into its thread seat. FLIP — the bubble is laid out in its final
// spot, instantly translated back to the field's rect, then released on a
// spring ease. Right edges are pinned (both are right-aligned); replayed and
// received bubbles keep their ordinary entrance.
function flyFromField(wrapper: HTMLElement): void {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const field = document.querySelector(".field");
  const msgs = wrapper.querySelectorAll<HTMLElement>(".msg");
  if (!field || !msgs.length) return;
  const start = field.getBoundingClientRect();
  msgs.forEach((msg) => {
    const end = msg.getBoundingClientRect();
    const dx = start.right - end.right;
    const dy = start.top - end.top;
    msg.style.transition = "none";
    msg.style.transform = `translate(${dx}px, ${dy}px)`;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        msg.style.transition = "transform 0.45s cubic-bezier(0.2, 0.9, 0.3, 1.08)";
        msg.style.transform = "";
        msg.addEventListener(
          "transitionend",
          () => {
            msg.style.transition = "";
          },
          { once: true },
        );
      });
    });
  });
}

// client-local bubbles (optimistic sends, network-failure notices) live in
// unkeyed .evt wrappers at the tail — outside the store unless ACKed into it
function localWrapper(role: string): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "evt";
  wrapper.dataset.ts = String(Date.now());
  wrapper.dataset.role = role;
  threadEl().appendChild(wrapper);
  threadEl().querySelector(".empty")?.remove();
  return wrapper;
}

function localBubble(role: string, cls: string, text: string): void {
  const w = localWrapper(role);
  rowEl(w, role, cls, Date.now()).textContent = text;
  decorate();
  if (role === "user") followTail = true;
  if (followTail) scrollToBottom();
  else document.getElementById("jump")?.classList.add("show");
}

async function send(): Promise<void> {
  const textEl = document.getElementById("text") as HTMLTextAreaElement;
  const sendBtn = document.getElementById("sendbtn") as HTMLButtonElement;
  const text = textEl.value.trim();
  const files = [...pendingFiles];
  if (!text && files.length === 0) return;

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
  followTail = true; // sending snaps you to the tail
  scrollToBottom(true); // instant pin: the flight is the only motion
  flyFromField(w);
  textEl.value = "";
  textEl.style.height = "auto"; // collapse the auto-grown compose bar
  pendingFiles = [];
  renderPending();

  sendBtn.disabled = true; // no double-fire while the network work runs
  try {
    const keys: string[] = [];
    for (const file of files) {
      const fd = new FormData();
      fd.append("file", file);
      let r: Response;
      try {
        r = await fetch("/api/upload", { method: "POST", headers: authHeaders(), body: fd });
      } catch (e) {
        hideTyping();
        localBubble("agent", "error", `⚠ not sent — upload of ${file.name} failed: ${e}`);
        return;
      }
      if (!r.ok) {
        hideTyping();
        localBubble("agent", "error",
          `⚠ not sent — upload of ${file.name} failed (${r.status} ${r.statusText})`);
        return;
      }
      keys.push((await r.json()).inbox_key);
    }
    let resp: Response;
    try {
      resp = await fetch("/api/send", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: THREAD_ID, text, attachments: keys }),
      });
    } catch (e) {
      hideTyping();
      localBubble("agent", "error", `⚠ not sent, server unreachable: ${e}`);
      return;
    }
    if (!resp.ok) {
      hideTyping();
      localBubble("agent", "error", `⚠ not sent (${resp.status})`);
      return;
    }
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
  } finally {
    sendBtn.disabled = false;
  }
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

if (token) {
  renderChat();
  connect(); // ws.onopen runs the version check; see checkServerVersion
} else {
  renderTokenGate();
}
