// The chat list: the panel that slides in from the left edge of the screen, or
// opens from the header's left button, and lists every chat, newest activity
// first. Each row is a chat's title (its first message, or "New chat"), a
// one-line preview of its newest message, that message's time, and a dot while
// the chat holds replies not yet on screen. The plus at the top makes a new
// chat and opens it. The word "drawer" is already taken in this code for the
// photo tray above the compose bar (#pending), so this is the chat list in
// code, and never a drawer.
//
// Two halves, the downbtn.ts shape: pure rules first (which chat a boot opens,
// the list's order, the time label, the pull's verdict, where a released drag
// settles), unit-tested directly; then the DOM wiring, a factory main.ts
// drives. Switching chats is main.ts's business (the socket, the store, the
// fresh shell); this module only asks for it through `choose`.
//
// Where it lives: inside #app, as its last child, absolutely positioned over
// the whole box. #app is the box the keyboard shell keeps corrected while the
// keyboard is up (shell.ts writes --shell-top and --shell-h onto it), so the
// list is never laid against a viewport the shell has moved. It sits outside
// .lift and .bar, whose transform and backdrop filter would otherwise contain
// it. renderChat rebuilds #app wholesale, so mount() runs after every render
// and the list rebuilds itself from the state held here.
//
// The gestures: the pull from the edge is decided inside the thread's own
// touch handlers (main.ts), which already own the one non-passive touchmove in
// the app, so nothing new listens on the document and nothing competes with the
// keyboard shell or the compose bar's swipe. The close drag listens on the
// list itself, which only takes touches while it is open.

export const DEFAULT_THREAD = "default";

// the service's own bound on a chat id (models.py THREAD_ID_PATTERN): it mints
// 16 hex characters, and a ':' would be misread by its channel names
const THREAD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isThreadId(value: unknown): value is string {
  return typeof value === "string" && THREAD_ID_RE.test(value);
}

/**
 * The chat a boot opens: the one a notification tap named (?thread=), else the
 * one open last time, else the chat that existed before there were chats.
 */
export function bootThread(search: string, stored: string | null): string {
  let asked: string | null = null;
  try {
    asked = new URLSearchParams(search).get("thread");
  } catch {
    asked = null;
  }
  if (isThreadId(asked)) return asked;
  if (isThreadId(stored)) return stored;
  return DEFAULT_THREAD;
}

/** One row of the list, as GET /api/threads serves it. */
export interface ChatSummary {
  id: string;
  title: string;
  preview: string;
  updated: string; // ISO-8601
  unread: number;
}

/** The service's answer, checked row by row; null when it is not a list at all. */
export function readChats(body: unknown): ChatSummary[] | null {
  const rows = (body as { threads?: unknown } | null)?.threads;
  if (!Array.isArray(rows)) return null;
  const out: ChatSummary[] = [];
  for (const r of rows as Array<Record<string, unknown>>) {
    if (!r || !isThreadId(r.id)) continue;
    out.push({
      id: r.id,
      title: typeof r.title === "string" && r.title ? r.title : "New chat",
      preview: typeof r.preview === "string" ? r.preview : "",
      updated: typeof r.updated === "string" ? r.updated : "",
      unread: typeof r.unread === "number" && r.unread > 0 ? Math.floor(r.unread) : 0,
    });
  }
  return out;
}

function stamp(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : -Infinity;
}

/** Newest activity first; the id settles a tie, so the order never flickers. */
export function orderChats(list: readonly ChatSummary[]): ChatSummary[] {
  return [...list].sort(
    (a, b) => stamp(b.updated) - stamp(a.updated) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** Unread replies in every chat but the one on screen: the header button's number. */
export function unreadElsewhere(list: readonly ChatSummary[], current: string): number {
  return list.reduce((n, c) => (c.id === current ? n : n + c.unread), 0);
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * The time beside a chat, the way Messages words it: the clock for today,
 * "Yesterday", the weekday within the week, a short date beyond that. Local
 * time, written out by hand so it reads the same on every engine.
 */
export function chatTimeLabel(iso: string, now: Date): string {
  const t = new Date(iso);
  if (!Number.isFinite(t.getTime())) return "";
  const dayOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  // rounded, so a day that is 23 or 25 hours long (clock changes) still counts as one
  const days = Math.round((dayOf(now) - dayOf(t)) / 86_400_000);
  if (days <= 0) {
    const h = t.getHours();
    const m = String(t.getMinutes()).padStart(2, "0");
    return `${h % 12 || 12}:${m} ${h < 12 ? "AM" : "PM"}`;
  }
  if (days === 1) return "Yesterday";
  if (days < 7) return WEEKDAYS[t.getDay()];
  return `${t.getMonth() + 1}/${t.getDate()}/${String(t.getFullYear()).slice(-2)}`;
}

// how close to the left edge a touch must start to be a pull (Messages' own
// back swipe starts in about this band)
export const EDGE_PX = 20;
// travel below which a gesture has no direction yet (the thread's peek uses the same)
export const DECIDE_PX = 10;
// how much more sideways than vertical a move must be to count as sideways
// (the peek's own ratio, so the two gestures agree on what "sideways" is)
const SIDEWAYS = 1.5;
// release speed, in px per ms, that decides a drag whatever its distance
export const FLICK = 0.35;

/** "drag" claims the gesture, "pass" leaves it to the thread, null is not yet known. */
export type Verdict = "drag" | "pass" | null;

/** A touch on the thread: does it pull the list in from the left edge? */
export function pullVerdict(startX: number, dx: number, dy: number): Verdict {
  if (startX > EDGE_PX) return "pass";
  if (Math.abs(dx) < DECIDE_PX && Math.abs(dy) < DECIDE_PX) return null;
  return dx > 0 && dx > Math.abs(dy) * SIDEWAYS ? "drag" : "pass";
}

/** A touch on the open list: does it push the list back out to the left? */
export function closeVerdict(dx: number, dy: number): Verdict {
  if (Math.abs(dx) < DECIDE_PX && Math.abs(dy) < DECIDE_PX) return null;
  return dx < 0 && -dx > Math.abs(dy) * SIDEWAYS ? "drag" : "pass";
}

/**
 * Where a released drag settles. `shown` is how much of the panel is on
 * screen, `velocity` is px/ms with opening positive. A flick decides by its
 * direction; a slow release by whether more than half the panel is out.
 */
export function settlesOpen(shown: number, width: number, velocity: number): boolean {
  if (velocity > FLICK) return true;
  if (velocity < -FLICK) return false;
  return shown > width / 2;
}

// --- the DOM ------------------------------------------------------------------

export interface ChatListDeps {
  /** the chat on screen */
  current(): string;
  /** open this chat (main.ts openThread); the list closes over it */
  choose(id: string): void;
  /** GET /api/threads, read through readChats; null when it could not be had */
  fetchList(): Promise<ChatSummary[] | null>;
  /** POST /api/threads; null when the service could not make one */
  create(): Promise<ChatSummary | null>;
  /** false while the list must not open (the photo picker's settling window) */
  canOpen(): boolean;
  /** the list is about to cover the chat: put the keyboard away */
  opening(): void;
  now?(): Date;
}

export interface ChatList {
  /** build the list into a freshly rendered #app and bind its header button */
  mount(app: HTMLElement): void;
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** ask the service for the list again and redraw it and the header count */
  refresh(): Promise<void>;
  /** another chat has news (the socket's nudge frame): refresh, coalesced */
  nudged(): void;
  /** logout: drop the list and close */
  forget(): void;
  /** the thread's touch handlers, in order: a touch began at x */
  pullStart(x: number): void;
  /** a move; true while the pull owns the gesture (the caller prevents the scroll) */
  pullMove(dx: number, dy: number): boolean;
  /** the touch ended or was cancelled */
  pullEnd(): void;
}

const NUDGE_MS = 250;

interface Drag {
  kind: "pull" | "close";
  startX: number;
  startY: number;
  verdict: Verdict;
  width: number;
  shown: number;
  lastX: number;
  lastT: number;
  velocity: number;
}

export function createChatList(deps: ChatListDeps): ChatList {
  let chats: ChatSummary[] = [];
  let shownOpen = false;
  let root: HTMLElement | null = null;
  let panel: HTMLElement | null = null;
  let scrim: HTMLElement | null = null;
  let rows: HTMLElement | null = null;
  let button: HTMLElement | null = null;
  let creating = false;
  let asked = 0; // the newest refresh; an older answer landing late is dropped
  let nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  let drag: Drag | null = null;
  let justMounted = false; // mounted open this frame: a close waits for one paint

  const now = (): Date => (deps.now ? deps.now() : new Date());

  function paintButton(): void {
    if (!button) return;
    const n = unreadElsewhere(chats, deps.current());
    const count = button.querySelector<HTMLElement>(".chatsbtn-count");
    if (count) {
      count.textContent = n > 99 ? "99+" : String(n);
      count.hidden = n === 0;
    }
    button.setAttribute("aria-label", n ? `Chats, ${n} unread` : "Chats");
  }

  function rowFor(chat: ChatSummary): HTMLElement {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "chat-row";
    row.dataset.thread = chat.id;
    row.setAttribute("role", "listitem");
    if (chat.id === deps.current()) {
      row.classList.add("is-current");
      row.setAttribute("aria-current", "true");
    }
    if (chat.unread > 0 && chat.id !== deps.current()) row.classList.add("is-unread");
    const dot = document.createElement("span");
    dot.className = "chat-dot";
    dot.setAttribute("aria-hidden", "true");
    const body = document.createElement("span");
    body.className = "chat-body";
    const top = document.createElement("span");
    top.className = "chat-top";
    const title = document.createElement("span");
    title.className = "chat-title";
    title.textContent = chat.title;
    const time = document.createElement("span");
    time.className = "chat-time";
    time.textContent = chatTimeLabel(chat.updated, now());
    top.append(title, time);
    const preview = document.createElement("span");
    preview.className = "chat-preview";
    preview.textContent = chat.preview || " ";
    body.append(top, preview);
    row.append(dot, body);
    row.addEventListener("click", () => {
      if (chat.id === deps.current()) close();
      else deps.choose(chat.id);
    });
    return row;
  }

  function paintRows(): void {
    if (!rows) return;
    rows.replaceChildren(...chats.map(rowFor));
  }

  function paint(): void {
    paintRows();
    paintButton();
  }

  function place(shown: number): void {
    if (!panel || !scrim || !drag) return;
    panel.style.transform = `translateX(${(shown - drag.width).toFixed(1)}px)`;
    scrim.style.opacity = (shown / Math.max(drag.width, 1)).toFixed(3);
  }

  function setOpen(next: boolean): void {
    if (next && !shownOpen) {
      deps.opening();
      void refresh();
    }
    shownOpen = next;
    if (!root) return;
    root.classList.toggle("open", next);
    root.inert = !next;
    root.setAttribute("aria-hidden", next ? "false" : "true");
    if (panel) panel.style.transform = "";
    if (scrim) scrim.style.opacity = "";
  }

  function open(): void {
    if (shownOpen || !deps.canOpen()) return;
    setOpen(true);
  }

  function close(): void {
    if (!shownOpen) return;
    if (justMounted) {
      // built open this very frame (a switch re-rendered the shell under it):
      // let that frame paint first, so the close is a slide and not a vanish
      requestAnimationFrame(() => requestAnimationFrame(() => setOpen(false)));
      shownOpen = false;
      return;
    }
    setOpen(false);
  }

  function beginDrag(kind: Drag["kind"], x: number, y: number): void {
    drag = {
      kind, startX: x, startY: y, verdict: null,
      width: 0, shown: 0, lastX: x, lastT: performance.now(), velocity: 0,
    };
  }

  // the drag has claimed the gesture: measure once, and let the panel follow
  function claim(d: Drag): void {
    d.width = panel?.getBoundingClientRect().width || 300;
    root?.classList.add("dragging");
    if (root) root.inert = false;
  }

  function follow(d: Drag, x: number): void {
    const t = performance.now();
    const dt = t - d.lastT;
    if (dt > 0) d.velocity = (x - d.lastX) / dt;
    d.lastX = x;
    d.lastT = t;
    const dx = x - d.startX;
    const shown = d.kind === "pull" ? dx : d.width + dx;
    d.shown = Math.max(0, Math.min(d.width, shown));
    place(d.shown);
  }

  function release(d: Drag): void {
    root?.classList.remove("dragging");
    const openNow = settlesOpen(d.shown, d.width, d.velocity);
    if (openNow && !shownOpen) setOpen(true);
    else if (!openNow && shownOpen) setOpen(false);
    else setOpen(shownOpen); // back where it was, from wherever the finger left it
  }

  async function refresh(): Promise<void> {
    const mine = ++asked;
    const got = await deps.fetchList().catch(() => null);
    if (mine !== asked || !got) return;
    chats = orderChats(got);
    paint();
  }

  function bindListGestures(el: HTMLElement): void {
    el.addEventListener(
      "touchstart",
      (e) => {
        if (!shownOpen || e.touches.length !== 1) return;
        beginDrag("close", e.touches[0].clientX, e.touches[0].clientY);
      },
      { passive: true },
    );
    el.addEventListener(
      "touchmove",
      (e) => {
        const d = drag;
        if (!d || d.kind !== "close" || d.verdict === "pass") return;
        const x = e.touches[0].clientX;
        if (d.verdict === null) {
          d.verdict = closeVerdict(x - d.startX, e.touches[0].clientY - d.startY);
          if (d.verdict !== "drag") return;
          claim(d);
        }
        e.preventDefault(); // sideways: the panel follows, the list does not scroll
        follow(d, x);
      },
      { passive: false },
    );
    const end = (): void => {
      const d = drag;
      drag = null;
      if (d && d.kind === "close" && d.verdict === "drag") release(d);
    };
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
  }

  function mount(app: HTMLElement): void {
    const el = document.createElement("div");
    el.className = "chats";
    el.id = "chats";
    const back = document.createElement("div");
    back.className = "chats-scrim";
    back.addEventListener("click", () => close());
    const side = document.createElement("nav");
    side.className = "chats-panel";
    side.setAttribute("aria-label", "Chats");
    const head = document.createElement("div");
    head.className = "chats-head";
    const heading = document.createElement("span");
    heading.className = "chats-title";
    heading.textContent = "Chats";
    const plus = document.createElement("button");
    plus.type = "button";
    plus.className = "chats-new";
    plus.title = "New chat";
    plus.setAttribute("aria-label", "New chat");
    plus.addEventListener("click", () => {
      if (creating) return;
      creating = true;
      plus.disabled = true;
      void deps.create().then(
        (made) => {
          creating = false;
          plus.disabled = false;
          if (!made) return;
          chats = orderChats([made, ...chats.filter((c) => c.id !== made.id)]);
          paint();
          deps.choose(made.id);
        },
        () => {
          creating = false;
          plus.disabled = false;
        },
      );
    });
    head.append(heading, plus);
    const list = document.createElement("div");
    list.className = "chats-list";
    list.setAttribute("role", "list");
    side.append(head, list);
    el.append(back, side);
    bindListGestures(el);
    root = el;
    panel = side;
    scrim = back;
    rows = list;
    drag = null;
    if (shownOpen) {
      // a switch re-rendered the shell while the list was open: come back open,
      // with no entrance, and let the close that follows play from there
      el.classList.add("open", "instant");
      justMounted = true;
      requestAnimationFrame(() => {
        el.classList.remove("instant");
        justMounted = false;
      });
    }
    el.inert = !shownOpen;
    el.setAttribute("aria-hidden", shownOpen ? "false" : "true");
    app.appendChild(el);
    button = app.querySelector<HTMLElement>("#chats-btn");
    button?.addEventListener("click", () => open());
    paint();
  }

  return {
    mount,
    open,
    close,
    isOpen: () => shownOpen,
    refresh,
    nudged(): void {
      if (nudgeTimer) clearTimeout(nudgeTimer);
      nudgeTimer = setTimeout(() => {
        nudgeTimer = null;
        void refresh();
      }, NUDGE_MS);
    },
    forget(): void {
      chats = [];
      asked += 1; // an answer still in flight belongs to the session that left
      shownOpen = false;
      drag = null;
      // the sign-in card replaced the shell these belonged to
      root = panel = scrim = rows = button = null;
    },
    pullStart(x: number): void {
      drag = null;
      if (shownOpen) return;
      beginDrag("pull", x, 0);
    },
    pullMove(dx: number, dy: number): boolean {
      const d = drag;
      if (!d || d.kind !== "pull" || d.verdict === "pass") return false;
      if (d.verdict === null) {
        d.verdict = pullVerdict(d.startX, dx, dy);
        if (d.verdict === "drag" && !deps.canOpen()) d.verdict = "pass";
        if (d.verdict !== "drag") return false;
        claim(d);
      }
      follow(d, d.startX + dx);
      return true;
    },
    pullEnd(): void {
      const d = drag;
      drag = null;
      if (d && d.kind === "pull" && d.verdict === "drag") release(d);
    },
  };
}
