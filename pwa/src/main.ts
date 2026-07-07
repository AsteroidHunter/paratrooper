// Paratrooper PWA — message the pinboard agent. Vanilla TS + DOM (lightest build).
// Same-origin /api + /ws (the FastAPI service serves this bundle in production).
import "./styles.css";

declare const __BUILT_AT__: string;

const TOKEN_KEY = "paratrooper_token";
const THREAD_ID = "default"; // single user, single thread in v1
let token = localStorage.getItem(TOKEN_KEY) ?? "";
let lastSeq = 0;
let ws: WebSocket | null = null;
let closingOnPurpose = false; // logout: suppress the auto-reconnect

interface ServerMsg {
  seq?: number;
  role?: "user" | "agent" | "system";
  body?: string;
  attachments?: string[];
  kind?: string | null;
  payload?: unknown;
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
      <span class="title">Paratrooper</span>
      <button id="reset" class="ghost" title="Forget token">⎋</button>
    </header>
    <main id="thread" class="thread">
      <div class="empty">Send a photo, link, or song to update the board. 🪂</div>
    </main>
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

// --- rendering ---------------------------------------------------------------

function bubble(role: string, cls: string): HTMLDivElement {
  threadEl().querySelector(".empty")?.remove(); // clear the empty-state hint
  const div = document.createElement("div");
  div.className = `msg ${role} ${cls}`;
  threadEl().appendChild(div);
  threadEl().scrollTop = threadEl().scrollHeight;
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

function render(m: ServerMsg): void {
  const role = m.role ?? "agent";
  if (role === "user") {
    const div = bubble("user", "text");
    div.textContent = m.body ?? "";
    (m.attachments ?? []).forEach(() => div.appendChild(chip("📎 photo")));
    lastAgentText = "";
    return;
  }
  const kind = m.kind ?? "log";
  const value = (typeof m.payload === "string" ? m.payload : undefined) ?? m.body ?? "";
  if (kind === "done" || kind === "error") hideTyping();
  if (kind === "done" && !value.trim()) return; // job-complete signal, text already shown
  if ((kind === "log" || kind === "done") && value.trim() && value.trim() === lastAgentText) {
    return; // consecutive duplicate of the same reply
  }
  if (kind === "log" || kind === "done") lastAgentText = value.trim();
  if (role === "system") {
    bubble("system", "line").textContent = value || "✓";
    return;
  }
  if (kind === "screenshot" && value) {
    const div = bubble("agent", "shot");
    const img = document.createElement("img");
    img.src = value;
    img.alt = "board preview";
    div.appendChild(img);
  } else if (kind === "pr") {
    const url = prUrl(m.payload, m.body);
    const div = bubble("agent", "pr");
    div.innerHTML = url ? `Opened a PR: <a href="${url}" target="_blank" rel="noopener">${url}</a>` : "Opened a PR.";
    const publishBtn = document.createElement("button");
    publishBtn.textContent = "Publish";
    publishBtn.className = "publish";
    publishBtn.addEventListener("click", () => void publish(url ?? ""));
    div.appendChild(publishBtn);
  } else if (kind === "error") {
    bubble("agent", "error").textContent = `⚠ ${value}`;
  } else {
    // the agent's words — a real received bubble (log and done alike)
    bubble("agent", "text").textContent = value;
  }
}

function chip(label: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = "filechip";
  s.textContent = label;
  return s;
}

// --- typing indicator ---------------------------------------------------------

function showTyping(): void {
  if (document.getElementById("typing")) return;
  const el = document.createElement("div");
  el.id = "typing";
  el.className = "msg agent typing";
  el.innerHTML = "<span></span><span></span><span></span>";
  const t = document.getElementById("thread");
  if (t) {
    t.appendChild(el);
    t.scrollTop = t.scrollHeight;
  }
}

function hideTyping(): void {
  document.getElementById("typing")?.remove();
}

// --- networking --------------------------------------------------------------

function connect(): void {
  closingOnPurpose = false;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/ws?token=${encodeURIComponent(token)}&thread=${THREAD_ID}&since=${lastSeq}`;
  ws = new WebSocket(url);
  ws.onmessage = (e) => {
    if (!document.getElementById("thread")) return; // gate is showing; don't consume
    const m = JSON.parse(e.data) as ServerMsg;
    if (m.seq && m.seq > lastSeq) lastSeq = m.seq;
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
    div.appendChild(img);
  }
  if (text) render({ role: "user", body: text, attachments: [] });
  showTyping();
  textEl.value = "";
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
    const resp = await fetch("/api/send", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ thread_id: THREAD_ID, text, attachments: keys }),
    });
    if (!resp.ok) {
      hideTyping();
      bubble("agent", "error").textContent = `⚠ not sent (${resp.status})`;
      return;
    }
    const { seq } = await resp.json();
    if (seq && seq > lastSeq) lastSeq = seq; // our own message: don't re-replay it
  } finally {
    sendBtn.disabled = false;
  }
}

async function publish(pr: string): Promise<void> {
  await fetch("/api/publish", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ thread_id: THREAD_ID, pr }),
  });
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
