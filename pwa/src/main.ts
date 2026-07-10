// Paratrooper PWA — message the pinboard agent. Vanilla TS + DOM (lightest build).
// Same-origin /api + /ws (the FastAPI service serves this bundle in production).
import "./styles.css";

declare const __BUILT_AT__: string;

const APP_VERSION = "0.1.7";

const TOKEN_KEY = "paratrooper_token";
const THREAD_ID = "default"; // single user, single thread in v1
let token = localStorage.getItem(TOKEN_KEY) ?? "";
let lastSeq = 0;
let oldestSeq = 0; // lowest seq rendered; the ?before= cursor for older pages
let loadingOlder = false;
let ws: WebSocket | null = null;
let closingOnPurpose = false; // logout: suppress the auto-reconnect

interface ServerMsg {
  seq?: number;
  role?: "user" | "agent" | "system";
  body?: string;
  attachments?: string[];
  kind?: string | null;
  payload?: unknown;
  ts?: string; // ISO-8601 on replayed history; live results carry none (client clock is fine)
}

const app = document.getElementById("app")!;

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
        <img class="avatar" src="/icon-192.png" alt="" />
        <span class="title">Paratrooper <span class="ver">v${APP_VERSION}</span></span>
      </div>
      <button id="reset" class="ghost" title="Forget token">⎋</button>
    </header>
    <main id="thread" class="thread">
      <div class="empty">Send a photo, link, or song to update the board. 🪂</div>
    </main>
    <button type="button" id="jump" class="jump" title="Jump to latest">↓</button>
    <div id="pending" class="pending"></div>
    <form id="compose" class="compose">
      <button type="button" id="attach" class="attach" title="Add photo">＋</button>
      <input id="files" type="file" accept="image/*" multiple hidden />
      <textarea id="text" rows="1" placeholder="Message Paratrooper…"></textarea>
      <button type="submit" id="sendbtn" class="send">↑</button>
    </form>`;
  document.getElementById("reset")!.addEventListener("click", () => {
    localStorage.removeItem(TOKEN_KEY);
    token = "";
    lastSeq = 0; // full replay on next login
    closingOnPurpose = true;
    ws?.close();
    ws = null;
    renderTokenGate();
  });
  const filesEl = document.getElementById("files") as HTMLInputElement;
  document.getElementById("attach")!.addEventListener("click", () => filesEl.click());
  filesEl.addEventListener("change", () => {
    pendingFiles.push(...Array.from(filesEl.files ?? []));
    filesEl.value = ""; // allow re-picking the same file
    renderPending();
  });
  document.getElementById("compose")!.addEventListener("submit", (e) => {
    e.preventDefault();
    void send();
  });
  // compose grows with content like iMessage (1 -> ~5 lines, then inner scroll)
  const textEl = document.getElementById("text") as HTMLTextAreaElement;
  textEl.addEventListener("input", () => {
    textEl.style.height = "auto";
    textEl.style.height = `${Math.min(textEl.scrollHeight, 120)}px`;
  });
  const thread = document.getElementById("thread")!;
  thread.addEventListener("scroll", () => {
    if (nearBottom()) document.getElementById("jump")?.classList.remove("show");
    if (thread.scrollTop < 40) void loadOlder(); // pull at top -> older page
  });
  document.getElementById("jump")!.addEventListener("click", () => {
    document.getElementById("jump")!.classList.remove("show");
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
  };
  thread.addEventListener("touchend", endPeek);
  thread.addEventListener("touchcancel", endPeek);
  // fresh thread DOM: reset run/stamp/pagination tracking
  lastBubbleSide = null;
  lastBubbleAt = 0;
  lastStampAt = 0;
  oldestSeq = 0;
}

// --- older history (recent-first: the socket sends a window, we page back) ----

async function loadOlder(): Promise<void> {
  if (loadingOlder || oldestSeq <= 1) return; // 0 = nothing rendered yet, 1 = at the top
  loadingOlder = true;
  try {
    const r = await fetch(`/api/history/${THREAD_ID}?before=${oldestSeq}&limit=50`, {
      headers: authHeaders(),
    });
    if (!r.ok) return;
    const { messages } = (await r.json()) as { messages: ServerMsg[] };
    if (!messages.length) {
      oldestSeq = 1; // top of thread reached; stop asking
      return;
    }
    const t = threadEl();
    // rebuild: render the older page into the emptied thread, then re-attach
    // the existing bubbles and put the viewport back where it was
    const keep = document.createDocumentFragment();
    while (t.firstChild) keep.appendChild(t.firstChild);
    const prevScroll = t.scrollTop;
    const prevSide = lastBubbleSide;
    const prevAt = lastBubbleAt;
    const prevStamp = lastStampAt;
    const prevSuppress = suppressAnim;
    lastBubbleSide = null;
    lastBubbleAt = 0;
    lastStampAt = 0;
    suppressAnim = true;
    for (const m of messages) {
      if (m.seq && (oldestSeq === 0 || m.seq < oldestSeq)) oldestSeq = m.seq;
      render(m);
    }
    lastBubbleSide = prevSide;
    lastBubbleAt = prevAt;
    lastStampAt = prevStamp;
    suppressAnim = prevSuppress;
    const olderHeight = t.scrollHeight;
    t.appendChild(keep);
    t.scrollTop = olderHeight + prevScroll; // previously-visible row stays put
  } finally {
    loadingOlder = false;
  }
}

// --- pending attachments (picked but not yet sent) -----------------------------

let pendingFiles: File[] = [];

function renderPending(): void {
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
// lines break runs.
let lastBubbleSide: string | null = null;
let lastBubbleAt = 0;
const RUN_GAP_MS = 60_000;

// centered "Today 2:31 PM" stamps at conversation gaps, like iMessage
let lastStampAt = 0;
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

function maybeStamp(at: number): void {
  if (at - lastStampAt <= STAMP_GAP_MS) return;
  lastStampAt = at;
  const s = document.createElement("div");
  s.className = "stamp";
  const day = document.createElement("b");
  day.textContent = fmtStampDay(at);
  s.append(day, ` ${fmtTime(at)}`);
  threadEl().appendChild(s);
}

// entrance animation + smooth scroll are for LIVE messages only; a reconnect
// replaying fifty bubbles must not pop each one
let suppressAnim = true;

function bubble(role: string, cls: string, tsMs?: number): HTMLDivElement {
  threadEl().querySelector(".empty")?.remove(); // clear the empty-state hint
  const wasNear = nearBottom();
  const at = tsMs ?? Date.now();
  maybeStamp(at);
  const cont =
    (role === "user" || role === "agent") &&
    role === lastBubbleSide &&
    at - lastBubbleAt < RUN_GAP_MS;
  lastBubbleSide = role === "system" ? null : role;
  lastBubbleAt = at;
  // each bubble sits in a full-width .row so the peek-time label can pin to
  // the screen's right edge (clipped by the thread until the pull reveals it)
  const row = document.createElement("div");
  row.className = `row ${role}${cont ? " cont" : ""}`;
  if (role !== "system") row.dataset.time = fmtTime(at);
  const div = document.createElement("div");
  div.className = `msg ${role} ${cls}${suppressAnim ? "" : " anim"}`;
  row.appendChild(div);
  threadEl().appendChild(row);
  if (wasNear || role === "user") scrollToBottom();
  else document.getElementById("jump")?.classList.add("show");
  return div;
}

function prUrl(payload: unknown, body?: string): string | null {
  if (payload && typeof payload === "object" && "url" in payload) {
    return String((payload as { url: unknown }).url);
  }
  const raw = typeof payload === "string" ? payload : body ?? "";
  try {
    const parsed = JSON.parse(raw);
    return parsed.url ?? null;
  } catch {
    return raw.startsWith("http") ? raw : null;
  }
}

let lastAgentText = "";

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

function render(m: ServerMsg): void {
  const role = m.role ?? "agent";
  const tsMs = m.ts ? Date.parse(m.ts) : undefined;
  if (role === "user") {
    // photos render as their own frameless bubbles (same shape as the send
    // echo); pre-thumbnail history 404s and falls back to the old chip
    (m.attachments ?? []).forEach((key) => {
      const div = bubble("user", "shot", tsMs);
      const img = document.createElement("img");
      img.src = thumbUrl(key);
      img.alt = "photo";
      img.onload = () => {
        if (nearBottom()) scrollToBottom();
      };
      img.onerror = () => {
        div.classList.replace("shot", "text");
        div.appendChild(chip("📎 photo"));
        img.remove();
      };
      img.addEventListener("click", () => openLightbox(img.src));
      div.appendChild(img);
    });
    if (m.body) {
      const div = bubble("user", "text", tsMs);
      div.textContent = m.body;
    }
    lastAgentText = "";
    return;
  }
  const kind = m.kind ?? "log";
  const value = (typeof m.payload === "string" ? m.payload : undefined) ?? m.body ?? "";
  if (kind === "job") return; // internal enqueue marker, not a message
  if (kind === "working") {
    setReceipt("Read"); // the agent has picked it up; otherwise silence
    return;
  }
  if (kind === "typing") {
    showTyping(); // the agent is writing (dots self-expire if it wasn't for you)
    return;
  }
  if (kind === "done" || kind === "error") {
    hideTyping();
  } else {
    hideTyping(); // a bubble replaces the dots
  }
  if (kind === "done" && !value.trim()) return; // job-complete signal, text already shown
  if ((kind === "log" || kind === "done") && value.trim() && value.trim() === lastAgentText) {
    return; // consecutive duplicate of the same reply
  }
  if (kind === "log" || kind === "done") lastAgentText = value.trim();
  if (role === "system") {
    bubble("system", "line", tsMs).textContent = value || "✓";
    return;
  }
  if (kind === "screenshot" && value) {
    const div = bubble("agent", "shot", tsMs);
    const img = document.createElement("img");
    img.src = value;
    img.alt = "board preview";
    img.onload = () => scrollToBottom(); // height lands after decode
    img.addEventListener("click", () => openLightbox(value));
    div.appendChild(img);
  } else if (kind === "pr") {
    const url = prUrl(m.payload, m.body);
    const div = bubble("agent", "pr", tsMs);
    div.innerHTML = url ? `Opened a PR: <a href="${url}" target="_blank" rel="noopener">${url}</a>` : "Opened a PR.";
    const publishBtn = document.createElement("button");
    publishBtn.textContent = "Publish";
    publishBtn.className = "publish";
    publishBtn.addEventListener("click", () => void publish(url ?? "", publishBtn));
    div.appendChild(publishBtn);
  } else if (kind === "error") {
    bubble("agent", "error", tsMs).textContent = `⚠ ${value}`;
  } else {
    // the agent's words — a real received bubble (log and done alike)
    bubble("agent", "text", tsMs).textContent = value;
  }
}

function chip(label: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = "filechip";
  s.textContent = label;
  return s;
}

// --- delivery receipt (single stamp under the most recent sent message) --------

function setReceipt(state: "Delivered" | "Read"): void {
  const t = document.getElementById("thread");
  if (!t) return;
  document.getElementById("receipt")?.remove();
  const el = document.createElement("div");
  el.id = "receipt";
  el.className = "receipt";
  el.textContent = state;
  // sits under the last user bubble; if the dots are up, keep them below it
  const typing = document.getElementById("typing");
  if (typing) t.insertBefore(el, typing);
  else t.appendChild(el);
  if (nearBottom()) scrollToBottom();
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
    if (nearBottom()) scrollToBottom();
  }
}

function hideTyping(): void {
  if (typingExpiry) clearTimeout(typingExpiry);
  typingExpiry = null;
  document.getElementById("typing")?.remove();
}

// --- networking --------------------------------------------------------------

function connect(): void {
  closingOnPurpose = false;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/ws?token=${encodeURIComponent(token)}&thread=${THREAD_ID}&since=${lastSeq}`;
  suppressAnim = true; // the catch-up replay must not animate or glide
  ws = new WebSocket(url);
  ws.onopen = () => setTimeout(() => (suppressAnim = false), 600);
  ws.onmessage = (e) => {
    if (!document.getElementById("thread")) return; // gate is showing; don't consume
    const m = JSON.parse(e.data) as ServerMsg;
    if (m.seq && m.seq > lastSeq) lastSeq = m.seq;
    if (m.seq && (oldestSeq === 0 || m.seq < oldestSeq)) oldestSeq = m.seq;
    render(m);
  };
  ws.onclose = () => {
    if (closingOnPurpose || !token) return; // logout: stay closed
    setTimeout(connect, 2000); // dropped: reconnect; catch-up via ?since=
  };
}

async function send(): Promise<void> {
  const textEl = document.getElementById("text") as HTMLTextAreaElement;
  const sendBtn = document.getElementById("sendbtn") as HTMLButtonElement;
  const text = textEl.value.trim();
  const files = [...pendingFiles];
  if (!text && files.length === 0) return;

  // INSTANT feedback on tap: bubbles + typing dots appear immediately; the
  // uploads/POST happen behind them. A failure is reported as an error bubble.
  for (const file of files) {
    const div = bubble("user", "shot");
    const img = document.createElement("img");
    img.src = URL.createObjectURL(file);
    img.addEventListener("click", () => openLightbox(img.src));
    div.appendChild(img);
  }
  if (text) render({ role: "user", body: text, attachments: [] });
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
        bubble("agent", "error").textContent = `⚠ not sent — upload of ${file.name} failed: ${e}`;
        return;
      }
      if (!r.ok) {
        hideTyping();
        bubble("agent", "error").textContent =
          `⚠ not sent — upload of ${file.name} failed (${r.status} ${r.statusText})`;
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
      bubble("agent", "error").textContent = `⚠ not sent, server unreachable: ${e}`;
      return;
    }
    if (!resp.ok) {
      hideTyping();
      bubble("agent", "error").textContent = `⚠ not sent (${resp.status})`;
      return;
    }
    const { seq } = await resp.json();
    if (seq && seq > lastSeq) lastSeq = seq; // our own message: don't re-replay it
    setReceipt("Delivered"); // the server has it
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
      bubble("agent", "error").textContent = `⚠ publish failed, server unreachable: ${e}`;
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
      bubble("agent", "error").textContent = `⚠ publish failed: ${detail}`;
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

window.visualViewport?.addEventListener("resize", () => window.scrollTo(0, 0));

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
  connect();
  void fetch("/api/health").then(async (r) => {
    const v = (await r.json()).version;
    console.log(`paratrooper ui ${__BUILT_AT__} / server ${v}`);
  });
} else {
  renderTokenGate();
}
