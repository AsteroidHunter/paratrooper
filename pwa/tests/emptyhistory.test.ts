// The older-history spinner in a chat that opened empty, in a chat that starts
// at its first message, and in a short chat that fits on the screen (their own
// sections, further down).
//
// The spinner is a row above the oldest message that says "older history
// exists". styles.css shows it the moment the thread holds any row at all, and
// only drainOlder takes it out, once loadOlder has marked the top reached.
// loadOlder pages back from the oldest message the phone holds, so in a chat
// that opened empty it had nothing to page from at the one settle that asks it,
// and nothing asked again after the first send: the ring spun over the first
// message until something scroll-like came along.
//
// The answer now comes from the server instead: the tail probe every socket
// sends when it opens. An empty answer means nothing older can ever exist,
// because every message after it is newer, so the top is marked reached before a
// first message can show the ring. Only the server's answer counts (a phone
// whose saved copy was wiped still loads the full history), only for the socket
// still open (a reconnect or a login replaces it), and a later socket that finds
// messages hands the question back to the ordinary page check.
//
// These cases run the app's own code for all of that, cut out of main.ts by name
// and run together in one VM context the way profile.test.ts does it: the
// socket, the tail probe, the replay settle, the older-history fetch and drain,
// the cold open's saved-copy paint, logout, and the fresh shell's history reset. The harness owns only what sits
// underneath: a server with an AUTOINCREMENT seq and the history endpoint's
// paging rule, a socket, a thread box holding rows and the spinner, and a clock.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";
import { transformWithEsbuild } from "vite";
import { createBootGate } from "../src/bootgate";

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

function sourceBetween(start: string, end: string): string {
  const at = main.indexOf(start);
  const until = main.indexOf(end, at + start.length);
  expect(at, `missing ${start}`).toBeGreaterThanOrEqual(0);
  expect(until, `missing ${end}`).toBeGreaterThan(at);
  return main.slice(at, until);
}

let script = "";

// `lastSeq`, `oldestSeq`, `historyDone`, `lastScrollAt`, `threadTouching` and `ws` are lexical
// bindings, invisible from outside the script. The probe is appended inside it,
// so the harness reads and moves the app's own cursors rather than copies.
const PROBE = `
globalThis.__probe = {
  get lastSeq() { return lastSeq; },
  set lastSeq(v) { lastSeq = v; },
  get oldestSeq() { return oldestSeq; },
  set oldestSeq(v) { oldestSeq = v; },
  get historyDone() { return historyDone; },
  set lastScrollAt(v) { lastScrollAt = v; },
  set threadTouching(v) { threadTouching = v; },
  get ws() { return ws; },
};
`;

beforeAll(async () => {
  const blocks = [
    // the cursors, the older-history bank and the socket state
    sourceBetween("let lastSeq = 0;", "// The client-side event store"),
    sourceBetween("function leaveChat(): void {", "// --- chat shell"),
    // renderChat's fresh-shell reset, the older-history lines of it
    "function freshShell(): void {\n" +
      sourceBetween(
        "  replyHold.reset(); // parked frames die with the old shell",
        '  setFollowTail(true, "fresh-shell");',
      ) +
      "}\n",
    sourceBetween("// --- older history (recent-first", "// --- pending attachments"),
    sourceBetween(
      "async function probeReplayTail(",
      "// After the settle, ask the server for its newest page ONCE",
    ),
    sourceBetween("function applyReplay(", "// A truly fresh open must LAND"),
    sourceBetween("function connect(): void {", "let closeProbeBusy"),
    sourceBetween("function dropSocket(): void {", "/** true if this resume replaced the socket */"),
    // the cold open's saved-copy paint, which connects when it is done
    sourceBetween("async function bootFromCache(): Promise<void> {", "\nif (token) {"),
  ];
  script =
    (await transformWithEsbuild(blocks.join("\n"), "emptyhistory.ts", { loader: "ts" })).code +
    PROBE;
});

// --- what sits underneath ----------------------------------------------------

interface Frame {
  seq: number;
  role: string;
  kind: string;
  payload: string;
}

/** The server's one thread: seqs never reused, pages cut the way messages_page cuts them. */
class Server {
  rows: Frame[] = [];
  private next = 1;
  add(role: "user" | "agent" = "agent"): Frame {
    const f = { seq: this.next++, role, kind: role === "user" ? "text" : "done", payload: "hi" };
    this.rows.push(f);
    return f;
  }
  addMany(n: number): void {
    for (let i = 0; i < n; i++) this.add(i % 2 ? "agent" : "user");
  }
  /** the newest `limit` rows below the cursor, oldest first */
  page(before: number, limit: number): Frame[] {
    return this.rows.filter((r) => r.seq < before).slice(-limit);
  }
  /** what the socket replays on connect: the newest 50 for since=0, else everything after */
  replay(since: number): Frame[] {
    return since === 0 ? this.rows.slice(-50) : this.rows.filter((r) => r.seq > since);
  }
}

class FakeSpin {
  bye = false;
  attached = true;
  classList = {
    add: (c: string) => {
      if (c === "bye") this.bye = true;
    },
    contains: (c: string) => c === "bye" && this.bye,
  };
  remove(): void {
    this.attached = false;
  }
}

const ROW = 60;
const SPIN = 40;

/** The thread box: rows (keyed or the send's own unkeyed one), the spinner, a clamped scrollTop. */
class FakeThread {
  rows: Array<number | "local"> = [];
  spin = new FakeSpin();
  clientHeight = 600;
  private top = 0;
  get scrollHeight(): number {
    return (this.spin.attached && !this.spin.bye ? SPIN : 0) + this.rows.length * ROW;
  }
  get scrollTop(): number {
    return this.top;
  }
  set scrollTop(v: number) {
    this.top = Math.max(0, Math.min(v, Math.max(0, this.scrollHeight - this.clientHeight)));
  }
  /** the one selector main.ts asks the box: is any row on screen? */
  querySelector(selector: string): object | null {
    expect(selector).toBe(".evt");
    return this.rows.length ? {} : null;
  }
  /** what the two spinner rules in styles.css decide (pinned at the bottom of this file) */
  get spinnerShowing(): boolean {
    return this.spin.attached && !this.spin.bye && this.rows.length > 0;
  }
}

class FakeSocket {
  static all: FakeSocket[] = [];
  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeSocket.all.push(this);
  }
  close(): void {
    this.closed = true;
  }
  since(): number {
    return Number(new URL(this.url.replace(/^wss?:/, "https:")).searchParams.get("since"));
  }
}

interface Parked {
  url: string;
  before: number;
  answer: Frame[] | "fail";
  resolve: (r: unknown) => void;
}

interface Probe {
  lastSeq: number;
  oldestSeq: number;
  historyDone: boolean;
  lastScrollAt: number;
  threadTouching: boolean;
  ws: FakeSocket | null;
}

const PROBE_BEFORE = Number.MAX_SAFE_INTEGER;
const tick = () => new Promise((r) => setImmediate(r));

function harness(options: { pageAge?: number } = {}) {
  // how old the page is when the harness starts, as performance.now() reads it
  const pageAge = options.pageAge ?? 1_000_000;
  const server = new Server();
  const store = new Map<number, Frame>();
  const shell: { thread: FakeThread | null } = { thread: new FakeThread() };
  const parked: Parked[] = [];
  const asked: number[] = []; // every history cursor asked for, the probe's included
  const timers = new Map<number, { at: number; run: () => void }>();
  let clock = 0;
  let nextTimer = 1;
  let failNextProbe = false;
  let saved: { id: string; lastSeq: number; frames: Frame[] } | null = null; // the phone's saved copy
  // what the screen showed at each paint: the browser paints only between tasks
  const paints: Array<{ rows: number; showing: boolean }> = [];

  const context: Record<string, unknown> = {
    // the page and the host
    document: {
      getElementById: (id: string) => {
        const t = shell.thread; // null while the sign-in card is up
        if (!t) return null;
        if (id === "thread") return t;
        if (id === "histspin") return t.spin.attached ? t.spin : null;
        return null;
      },
    },
    location: { protocol: "https:", host: "paratrooper.example" },
    localStorage: { removeItem: () => {} },
    performance: { now: () => pageAge + clock },
    setTimeout: (run: () => void, ms = 0) => {
      const id = nextTimer++;
      timers.set(id, { at: clock + ms, run });
      return id;
    },
    clearTimeout: (id: number | null) => {
      if (id != null) timers.delete(id);
    },
    WebSocket: FakeSocket,
    fetch: async (url: string) => {
      const q = new URL(url, "https://paratrooper.example");
      const before = Number(q.searchParams.get("before"));
      const limit = Number(q.searchParams.get("limit"));
      asked.push(before);
      // the query runs when the request lands; only the answer can be late
      const fail = before === PROBE_BEFORE && failNextProbe;
      if (fail) failNextProbe = false;
      const answer: Frame[] | "fail" = fail ? "fail" : server.page(before, limit);
      return new Promise((resolve) => parked.push({ url, before, answer, resolve }));
    },
    // the app's state that lives outside the cut blocks
    token: "tok",
    TOKEN_KEY: "paratrooper_token",
    THREAD_ID: "default",
    store,
    bootGate: createBootGate(),
    suppressAnim: true,
    pinInstant: false,
    pushNotifications: null,
    prLinkPrefix: null,
    KEEPALIVE_FRAME: "p",
    // collaborators the cut blocks call, none of which decides anything here
    threadEl: () => shell.thread,
    authHeaders: () => ({}),
    applyEvent: (m: Frame) => {
      // applyEvent's store and cursor lines, the only part of it this code reads
      if (!m.seq || store.has(m.seq)) return;
      store.set(m.seq, m);
      const p = probe();
      const isTail = m.seq > p.lastSeq;
      if (m.seq > p.lastSeq) p.lastSeq = m.seq;
      if (p.oldestSeq === 0 || m.seq < p.oldestSeq) p.oldestSeq = m.seq;
      const t = shell.thread;
      if (!t) return;
      t.rows.push(m.seq);
      if (isTail) t.scrollTop = t.scrollHeight; // the open follows the tail down
    },
    replyHold: { maybeHold: () => false, reset: () => {} },
    replayAnimates: () => false,
    loadingScreen: { lifted: () => true },
    pageVisible: () => true,
    sendPresence: () => {},
    checkServerVersion: async () => {},
    bootSettlePin: async () => {},
    reconcileRetracts: async () => {},
    applyRetract: () => {},
    showTyping: () => {},
    probeAfterClose: () => {},
    unregisterPushOnLogout: () => {},
    cacheWrites: { cancel: () => {} },
    cacheDel: async () => {},
    holdDiagRecord: () => {},
    springReseat: () => {},
    scrollGhostWrite: () => {},
    jankSpan: () => {},
    // bootFromCache's collaborators: the saved record, the pin, and nothing else that decides
    cacheGet: async () => saved,
    armBootFrameGuard: () => {},
    restoreProfile: () => null,
    profile: null,
    scrollToBottom: () => {
      const t = shell.thread;
      if (t) t.scrollTop = t.scrollHeight;
    },
    tailGen: 0,
    requestAnimationFrame: () => 0,
    noteSpringAppWrite: () => {},
    settleLoadingScreen: async () => {},
  };
  runInNewContext(script, context);
  const probe = () => context.__probe as Probe;
  const call = (name: string) => (context[name] as () => unknown)();
  const thread = () => shell.thread!;
  const socket = () => FakeSocket.all[FakeSocket.all.length - 1];

  /** a frame reaches the screen: the spinner as the thread box now stands */
  function paint(): void {
    const t = shell.thread;
    if (t) paints.push({ rows: t.rows.length, showing: t.spinnerShowing });
  }

  /** answer only what is parked right now, and let those answers run */
  async function step(): Promise<void> {
    for (const p of parked.splice(0)) release(p);
    await tick();
    paint();
  }

  /** answer every parked request, and everything they chain, until quiet */
  async function flush(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      await tick();
      paint();
      if (!parked.length) return;
      for (const p of parked.splice(0)) release(p);
    }
    throw new Error("history requests never went quiet");
  }

  function release(p: Parked): void {
    p.resolve(
      p.answer === "fail"
        ? { ok: false, json: async () => ({}) }
        : { ok: true, json: async () => ({ messages: p.answer }) },
    );
  }

  /** run the clock forward, firing every timer that falls due */
  function advance(ms: number): void {
    const until = clock + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      clock = due[1].at;
      due[1].run();
      paint();
    }
    clock = until;
  }

  return {
    server,
    store,
    asked,
    parked,
    probe,
    thread,
    socket,
    flush,
    step,
    advance,
    failNextProbe: () => void (failNextProbe = true),
    /** the phone's saved copy, applied before the socket connects (bootFromCache) */
    cached(frames: Frame[]): void {
      for (const m of frames) (context.applyEvent as (m: Frame) => void)(m);
      thread().scrollTop = thread().scrollHeight; // pinned to the bottom
    },
    connect: () => call("connect"),
    paints,
    /** the cold open with a saved copy: bootFromCache paints it, then connects */
    async boot(frames: Frame[]): Promise<void> {
      paint(); // the fresh shell, before the saved copy is read
      saved = { id: "default", lastSeq: Math.max(0, ...frames.map((f) => f.seq)), frames };
      await (context.bootFromCache as () => Promise<void>)();
      paint();
    },
    /** the handshake completes: onopen asks the probe, then the replay streams in, a task a frame */
    open(): void {
      const s = socket();
      s.onopen?.();
      paint();
      for (const f of server.replay(s.since())) {
        s.onmessage?.({ data: JSON.stringify(f) });
        paint();
      }
    },
    /** a live frame on the open socket */
    deliver(f: Frame): void {
      socket().onmessage?.({ data: JSON.stringify(f) });
      paint();
    },
    /** the socket died; the blind two-second retry opens the next one */
    drop(): void {
      socket().onclose?.();
      advance(2000);
    },
    logout(): void {
      call("leaveChat");
      shell.thread = null; // the sign-in card replaced the shell
    },
    login(): void {
      context.token = "tok";
      shell.thread = new FakeThread(); // renderChat's new shell, spinner included
      store.clear(); // the same reset's first line, above the cut
      call("freshShell");
      (context.bootGate as ReturnType<typeof createBootGate>).reset(); // and its replay ledger
      call("connect");
    },
    /** the send's own bubble: an unkeyed .evt row at the tail (localWrapper) */
    send(): void {
      thread().rows.push("local");
      paint();
    },
    /** the server accepted it: the ACK keys the row and moves both cursors */
    ack(): Frame {
      const f = server.add("user");
      store.set(f.seq, f);
      const p = probe();
      if (f.seq > p.lastSeq) p.lastSeq = f.seq;
      if (p.oldestSeq === 0 || f.seq < p.oldestSeq) p.oldestSeq = f.seq;
      const at = thread().rows.indexOf("local");
      if (at >= 0) thread().rows[at] = f.seq;
      paint();
      return f;
    },
    /** a finger on the thread: nothing may land under it */
    fingerDown(): void {
      probe().threadTouching = true;
    },
    /** the lift, as the touchend handler does it: a boundary check 200 ms later */
    fingerUp(): void {
      probe().threadTouching = false;
      (context.setTimeout as (run: () => void, ms: number) => number)(
        context.tryApplyOlder as () => void,
        200,
      );
      advance(200);
    },
    /** the reader scrolls to `top` and the glide ends: the scroll handler, then scrollend */
    scrollTo(top: number): void {
      thread().scrollTop = top;
      if (thread().scrollTop < 1200) void (context.loadOlder as () => Promise<void>)();
      probe().lastScrollAt = 0;
      call("tryApplyOlder");
      paint();
    },
    /** a scroll event with the glide still running: the scroll handler's work, no boundary */
    glide(top: number): void {
      thread().scrollTop = top;
      if (thread().scrollTop < 1200) void (context.loadOlder as () => Promise<void>)();
      probe().lastScrollAt = (context.performance as { now: () => number }).now();
      paint();
    },
    /** a boundary check that finds the glide still running (the lift's timer, say) */
    check(): void {
      call("tryApplyOlder");
      paint();
    },
    /** the glide ends: scrollend, with nothing else moving */
    glideEnds(): void {
      probe().lastScrollAt = 0;
      call("tryApplyOlder");
      paint();
    },
  };
}

type Harness = ReturnType<typeof harness>;

/** Read up to the top again and again until the spinner has gone, noting what showed. */
async function readToTheTop(h: Harness): Promise<{ showingWhileOlderLeft: boolean[] }> {
  const showingWhileOlderLeft: boolean[] = [];
  for (let i = 0; i < 40 && h.thread().spin.attached; i++) {
    const olderLeft = h.server.rows.some((r) => !h.store.has(r.seq));
    if (olderLeft) showingWhileOlderLeft.push(h.thread().spinnerShowing);
    h.scrollTo(0);
    await h.flush();
    h.advance(300); // the farewell's collapse, then the removal
  }
  return { showingWhileOlderLeft };
}

const olderPageCursors = (h: Harness) => h.asked.filter((b) => b !== PROBE_BEFORE);
const allSeqs = (h: Harness) => h.server.rows.map((r) => r.seq);
const heldSeqs = (h: Harness) => [...h.store.keys()].sort((a, b) => a - b);

// --- a chat that opened empty ---------------------------------------------------

describe("a chat that opened empty", () => {
  it("shows no spinner once the first message is sent", async () => {
    FakeSocket.all = [];
    const h = harness();
    h.connect();
    h.open();
    await h.flush();
    expect(h.probe().historyDone).toBe(true); // the server said empty: the top is reached

    h.send();
    expect(h.thread().rows).toEqual(["local"]); // the thread holds a row: the rule would show it
    expect(h.thread().spinnerShowing).toBe(false);
    h.ack();
    expect(h.thread().spinnerShowing).toBe(false);
    h.advance(300);
    expect(h.thread().spin.attached).toBe(false); // gone from the page, not just hidden
    expect(olderPageCursors(h)).toEqual([]); // and no older page was ever asked for
  });

  it("shows no spinner after the reply arrives either, or after a scroll", async () => {
    FakeSocket.all = [];
    const h = harness();
    h.connect();
    h.open();
    await h.flush();
    h.send();
    h.ack();
    const reply = h.server.add("agent");
    h.deliver(reply); // live: above the empty tail the probe reported
    expect(h.store.has(reply.seq)).toBe(true);
    expect(h.thread().rows).toEqual([1, 2]);
    expect(h.thread().spinnerShowing).toBe(false);
    h.scrollTo(0); // a scroll-like check changes nothing now
    await h.flush();
    expect(h.thread().spinnerShowing).toBe(false);
    expect(olderPageCursors(h)).toEqual([]);
  });

  it("an empty answer that lands after the socket already settled still takes it out", async () => {
    FakeSocket.all = [];
    const h = harness();
    h.connect();
    h.open(); // the probe is out and hangs
    h.advance(5000); // the fallback closes the ledger at what arrived: nothing
    expect(h.probe().historyDone).toBe(false); // the phone's own copy decided nothing
    await h.flush(); // the hung probe finally answers: empty
    h.advance(300);
    expect(h.probe().historyDone).toBe(true);
    expect(h.thread().spin.attached).toBe(false);
    h.send();
    expect(h.thread().spinnerShowing).toBe(false);
  });

  it("an empty answer in the page's first 140 ms still takes it out, glide gate or not", async () => {
    FakeSocket.all = [];
    const h = harness({ pageAge: 80 }); // a fast local open: the gate reads the start as a scroll
    h.connect();
    h.open();
    await h.flush();
    h.send();
    expect(h.thread().spinnerShowing).toBe(false);
    h.advance(300);
    expect(h.thread().spin.attached).toBe(false);
  });

  it("a saved copy the server no longer has: marked, no page asked for, out through the drain", async () => {
    FakeSocket.all = [];
    const h = harness();
    const gone = new Server();
    gone.addMany(40);
    h.cached(gone.rows.slice(-30)); // rows on screen (11..40), from a server since wiped
    expect(h.thread().spinnerShowing).toBe(true);
    h.connect();
    h.open();
    await h.flush();
    expect(h.probe().historyDone).toBe(true);
    expect(h.thread().spinnerShowing).toBe(false); // the settle's own drain
    expect(olderPageCursors(h)).toEqual([]);
  });

  it("with rows on screen the spinner still waits for a boundary, never leaving under a finger", async () => {
    FakeSocket.all = [];
    const h = harness();
    const gone = new Server();
    gone.addMany(40);
    h.cached(gone.rows.slice(-30));
    h.fingerDown(); // reading the saved copy as the socket settles
    h.connect();
    h.open();
    await h.flush();
    expect(h.probe().historyDone).toBe(true);
    expect(h.thread().spinnerShowing).toBe(true); // the drain waits, as every drain does
    h.fingerUp();
    expect(h.thread().spinnerShowing).toBe(false);
  });

  it("a failed probe marks nothing: only the server's own answer counts", async () => {
    FakeSocket.all = [];
    const h = harness();
    h.failNextProbe();
    h.connect();
    h.open();
    await h.flush();
    expect(h.probe().historyDone).toBe(false);
  });
});

// --- chats that open with messages: exactly as before ---------------------------

describe("a chat that opens with messages", () => {
  it("still shows the spinner while older pages exist and loads them as before", async () => {
    FakeSocket.all = [];
    const h = harness();
    h.server.addMany(120);
    h.cached(h.server.rows.slice(-30)); // the saved copy holds 91..120
    h.connect();
    expect(h.socket().since()).toBe(120);
    h.open(); // nothing newer to replay
    await h.flush();
    expect(h.probe().historyDone).toBe(false); // a thread with messages is loadOlder's question
    expect(h.thread().spinnerShowing).toBe(true);

    const { showingWhileOlderLeft } = await readToTheTop(h);
    expect(showingWhileOlderLeft.length).toBeGreaterThan(0);
    expect(showingWhileOlderLeft.every(Boolean)).toBe(true); // up the whole way
    expect(olderPageCursors(h)).toEqual([91, 66, 41, 16]); // one page of 25 at a time
    expect(heldSeqs(h)).toEqual(allSeqs(h)); // every message reached
    expect(h.probe().historyDone).toBe(true); // the true top, found by paging
    expect(h.thread().spin.attached).toBe(false); // and only then does the spinner go
  });

  it("a phone whose saved copy is empty, against a server with messages, loads them normally", async () => {
    FakeSocket.all = [];
    const h = harness();
    h.server.addMany(80);
    h.connect(); // nothing saved: since=0
    expect(h.socket().since()).toBe(0);
    h.open(); // the server replays its newest 50: 31..80
    await h.flush();
    expect(h.probe().historyDone).toBe(false); // the probe found messages: no mark
    expect(heldSeqs(h)[0]).toBe(31);
    expect(h.thread().spinnerShowing).toBe(true);

    const { showingWhileOlderLeft } = await readToTheTop(h);
    expect(showingWhileOlderLeft.every(Boolean)).toBe(true);
    expect(olderPageCursors(h)).toEqual([31, 6]);
    expect(heldSeqs(h)).toEqual(allSeqs(h));
    expect(h.thread().spin.attached).toBe(false);
  });

  it("a reconnect never marks the top reached while older pages remain", async () => {
    FakeSocket.all = [];
    const h = harness();
    h.server.addMany(120);
    h.cached(h.server.rows.slice(-30));
    h.connect();
    h.open();
    await h.flush();
    h.scrollTo(0); // one page in
    await h.flush();
    h.drop(); // the socket goes; the retry replays from lastSeq
    expect(h.socket().since()).toBe(120);
    h.open();
    await h.flush();
    expect(h.probe().historyDone).toBe(false);
    expect(h.thread().spinnerShowing).toBe(true);
    await readToTheTop(h);
    expect(heldSeqs(h)).toEqual(allSeqs(h));
  });
});

// --- a chat that starts at its first message: the spinner never shows -----------
//
// The server numbers messages from 1 and never gives a number out twice, so a
// phone that holds seq 1 holds the thread's first message: nothing older can
// exist, whatever a page or a probe says. The phone settles that itself, in the
// same task as the rows that would turn the spinner on (the saved copy's paint,
// the replay's one commit, a socket frame), so the spinner is gone before any
// paint and never plays a farewell (the collapse is on screen for a quarter
// second, even when it starts in the same task as the rows). It used to be
// painted with the saved copy and taken out only once the socket settled, or at
// a scroll boundary.

/** every paint with a row on screen, and whether the spinner showed in it */
const paintsWithRows = (h: Harness) => h.paints.filter((p) => p.rows > 0);
const neverShown = (h: Harness) => {
  expect(paintsWithRows(h).length).toBeGreaterThan(0);
  expect(paintsWithRows(h).filter((p) => p.showing)).toEqual([]);
  expect(h.thread().spin.attached).toBe(false); // out of the page ...
  expect(h.thread().spin.bye).toBe(false); // ... outright: a farewell's collapse is itself on screen
};

describe("a chat that starts at its first message never shows the spinner", () => {
  it.each([
    ["from the saved copy", true, 1_000_000],
    ["from the server's replay", false, 1_000_000],
    ["from the saved copy, settling in the page's first 140 ms", true, 80],
    ["from the server's replay, settling in the page's first 140 ms", false, 80],
  ] as const)("a 4-message chat opened %s", async (_, saved, pageAge) => {
    FakeSocket.all = [];
    const h = harness({ pageAge });
    h.server.addMany(4); // two sent, two received
    if (saved) {
      await h.boot(h.server.rows); // painted before the socket even opens
      expect(h.thread().spin.attached).toBe(false);
    } else {
      h.connect();
    }
    h.open();
    await h.flush();
    h.advance(300);
    expect(h.thread().rows).toEqual([1, 2, 3, 4]);
    neverShown(h);
    expect(h.probe().historyDone).toBe(true);
    expect(olderPageCursors(h)).toEqual([]);
  });

  it.each([
    ["from the saved copy", true],
    ["from the server's replay", false],
  ] as const)("a 40-message chat opened %s, read to the top under a finger", async (_, saved) => {
    FakeSocket.all = [];
    const h = harness();
    h.server.addMany(40); // taller than the screen, first message included
    if (saved) await h.boot(h.server.rows);
    else h.connect();
    h.open();
    await h.flush();
    h.fingerDown();
    h.glide(0); // dragged all the way up
    h.check();
    h.fingerUp();
    h.glideEnds();
    await h.flush();
    neverShown(h);
    expect(olderPageCursors(h)).toEqual([]);
  });

  it("through a reconnect and a new reply", async () => {
    FakeSocket.all = [];
    const h = harness();
    h.server.addMany(4);
    await h.boot(h.server.rows);
    h.open();
    await h.flush();
    h.drop(); // the socket goes; the retry replays from lastSeq
    const reply = h.server.add("agent");
    h.open(); // the reply comes back in the catch-up
    await h.flush();
    h.deliver(h.server.add("agent")); // and one more, live
    h.advance(300);
    expect(h.thread().rows).toEqual([1, 2, 3, 4, reply.seq, reply.seq + 1]);
    neverShown(h);
  });

  it("after sending, and after the answer", async () => {
    FakeSocket.all = [];
    const h = harness();
    h.server.addMany(4);
    await h.boot(h.server.rows);
    h.open();
    await h.flush();
    h.send();
    h.ack();
    h.deliver(h.server.add("agent"));
    h.advance(300);
    expect(h.thread().rows).toEqual([1, 2, 3, 4, 5, 6]);
    neverShown(h);
  });

  it("after a logout and a login, in the new shell's own spinner", async () => {
    FakeSocket.all = [];
    const h = harness();
    h.server.addMany(4);
    await h.boot(h.server.rows);
    h.open();
    await h.flush();
    h.logout();
    h.login(); // a fresh shell, spinner and all, and a full replay
    h.open();
    await h.flush();
    h.advance(300);
    expect(h.thread().rows).toEqual([1, 2, 3, 4]);
    neverShown(h);
  });

  it("when the thread's first message arrives live, with the server's answer still out", async () => {
    FakeSocket.all = [];
    const h = harness();
    h.connect();
    h.open(); // an empty thread; this probe hangs
    const hung = h.parked.splice(0);
    h.advance(5000); // the fallback closes the ledger at nothing
    const first = h.server.add("user"); // sent from another device
    h.deliver(first);
    expect(h.thread().rows).toEqual([first.seq]);
    h.parked.push(...hung); // the empty answer lands at last
    await h.flush();
    h.advance(300);
    neverShown(h);
  });
});

// --- a short chat whose oldest message is above the first ------------------------
//
// Here the phone can't tell on its own whether older messages exist (the first
// ones may have been taken back, or not loaded yet), so the older-history check
// asks the server, and the spinner shows while it does. Two things once kept it
// up until a touch in a chat too short to scroll: the check drained before it
// learned the answer, and in the page's first 140 ms the glide gate shut the
// check before it asked anything at all.

describe("a short chat whose oldest message is above the first", () => {
  it.each([
    ["", 1_000_000],
    [", settling in the page's first 140 ms", 80],
  ] as const)(
    "whose first messages were taken back asks once and loses it untouched%s",
    async (_, pageAge) => {
      FakeSocket.all = [];
      const h = harness({ pageAge });
      h.server.addMany(6);
      h.server.rows = h.server.rows.slice(2); // seqs 1 and 2 are gone: the oldest held is 3
      h.connect();
      h.open();
      await h.flush();
      expect(h.thread().rows).toEqual([3, 4, 5, 6]);
      expect(olderPageCursors(h)).toEqual([3]); // one empty page says the top is reached
      expect(h.thread().spinnerShowing).toBe(false);
      h.advance(300);
      expect(h.thread().spin.attached).toBe(false);
    },
  );

  it("from a saved copy it shows while the server is asked, as before", async () => {
    FakeSocket.all = [];
    const h = harness();
    h.server.addMany(6);
    h.server.rows = h.server.rows.slice(2);
    await h.boot(h.server.rows);
    expect(h.thread().spinnerShowing).toBe(true); // the copy can't answer for seqs 1 and 2
    h.open();
    await h.flush();
    expect(olderPageCursors(h)).toEqual([3]);
    expect(h.thread().spinnerShowing).toBe(false); // the empty page takes it out, untouched
  });

  it("a finger resting on it holds the farewell until the lift, then it goes", async () => {
    FakeSocket.all = [];
    const h = harness();
    h.server.addMany(6);
    h.server.rows = h.server.rows.slice(2);
    h.cached(h.server.rows);
    h.fingerDown(); // on the thread as the socket settles
    h.connect();
    h.open();
    await h.flush();
    expect(h.thread().spinnerShowing).toBe(true); // nothing leaves under a finger
    expect(olderPageCursors(h)).toEqual([]); // nor is anything asked under one
    h.fingerUp(); // the lift's check asks ...
    await h.flush(); // ... and the empty page takes it out
    expect(olderPageCursors(h)).toEqual([3]);
    expect(h.thread().spinnerShowing).toBe(false);
    h.advance(300);
    expect(h.thread().spin.attached).toBe(false);
  });

  it.each([
    ["", 1_000_000],
    [", settling in the page's first 140 ms", 80],
  ] as const)(
    "a short chat that does have older messages shows the spinner while they come%s",
    async (_, pageAge) => {
      FakeSocket.all = [];
      const h = harness({ pageAge });
      h.server.addMany(100);
      h.cached(h.server.rows.slice(-4)); // the saved copy holds 97..100 and fits on the screen
      h.connect();
      h.open();
      await h.step(); // the probe answers, the socket settles, the older page goes out
      expect(h.parked.map((p) => p.before)).toEqual([97]);
      expect(h.probe().historyDone).toBe(false);
      expect(h.thread().spinnerShowing).toBe(true); // older messages exist: it spins
      await h.step(); // the page comes back to a reader at the spinner, and lands
      expect(heldSeqs(h)[0]).toBe(72);
      expect(h.thread().spinnerShowing).toBe(true); // and older still exist
      const { showingWhileOlderLeft } = await readToTheTop(h);
      expect(showingWhileOlderLeft.every(Boolean)).toBe(true);
      expect(heldSeqs(h)).toEqual(allSeqs(h));
      expect(h.thread().spin.attached).toBe(false);
      expect(h.thread().spin.bye).toBe(true); // the page that brought seq 1 kept its farewell
    },
  );
});

// --- chats that can scroll keep every boundary rule ------------------------------

describe("a chat that can scroll still waits for a scroll boundary", () => {
  it("with its first messages taken back, the farewell waits out a finger and a glide", async () => {
    FakeSocket.all = [];
    const h = harness();
    h.server.addMany(45);
    h.server.rows = h.server.rows.slice(5); // 6..45 replay; nothing older is left
    h.connect();
    h.open();
    await h.flush();
    expect(h.thread().scrollTop).toBeGreaterThanOrEqual(1200); // pinned far from the top
    expect(h.probe().historyDone).toBe(false);
    expect(h.thread().spinnerShowing).toBe(true);

    h.fingerDown();
    h.glide(0); // dragged to the top: the check goes out ...
    await h.flush(); // ... and its empty page comes back under the finger
    expect(olderPageCursors(h)).toEqual([6]);
    expect(h.probe().historyDone).toBe(true);
    h.check();
    expect(h.thread().spinnerShowing).toBe(true); // not under a finger
    h.probe().threadTouching = false; // lifted, and the glide rides on
    h.glide(0);
    h.check();
    expect(h.thread().spinnerShowing).toBe(true); // not mid-glide either
    h.glideEnds();
    expect(h.thread().spinnerShowing).toBe(false); // the boundary takes it out
  });

  it("a chat a little taller than the screen leaves it for the next boundary", async () => {
    FakeSocket.all = [];
    const h = harness();
    h.server.addMany(17);
    h.server.rows = h.server.rows.slice(2); // 3..17: taller than the screen, pinned 340 px down
    h.connect();
    h.open();
    await h.flush();
    expect(h.thread().scrollTop).toBeGreaterThan(50);
    expect(olderPageCursors(h)).toEqual([3]); // the settle's check asked, and heard nothing older
    expect(h.probe().historyDone).toBe(true);
    expect(h.thread().spinnerShowing).toBe(true); // above the fold, waiting as it always did
    h.glide(0);
    h.check();
    expect(h.thread().spinnerShowing).toBe(true); // mid-glide: still waiting
    h.glideEnds();
    expect(h.thread().spinnerShowing).toBe(false);
  });

  it("an 80-message chat settling in the page's first 140 ms opens and pages as before", async () => {
    FakeSocket.all = [];
    const h = harness({ pageAge: 80 });
    h.server.addMany(80);
    h.connect();
    h.open();
    await h.flush();
    expect(h.probe().historyDone).toBe(false);
    expect(heldSeqs(h)[0]).toBe(31);
    expect(h.thread().spinnerShowing).toBe(true);
    expect(olderPageCursors(h)).toEqual([]); // nothing asked until the reader scrolls
    const { showingWhileOlderLeft } = await readToTheTop(h);
    expect(showingWhileOlderLeft.length).toBeGreaterThan(0);
    expect(showingWhileOlderLeft.every(Boolean)).toBe(true);
    expect(olderPageCursors(h)).toEqual([31, 6]);
    expect(heldSeqs(h)).toEqual(allSeqs(h));
    expect(h.thread().spin.attached).toBe(false);
    expect(h.thread().spin.bye).toBe(true); // it left by the farewell, as before
  });

  it("older pages still land one per boundary, never under a finger or mid-glide", async () => {
    FakeSocket.all = [];
    const h = harness();
    h.server.addMany(120);
    h.cached(h.server.rows.slice(-30)); // 91..120
    h.connect();
    h.open();
    await h.flush();
    h.fingerDown();
    h.glide(0); // at the top under a finger: the fetch goes out, the page banks
    await h.flush();
    expect(heldSeqs(h)[0]).toBe(91); // banked, not landed
    expect(h.thread().spinnerShowing).toBe(true);
    h.probe().threadTouching = false;
    h.glide(0);
    h.check();
    expect(heldSeqs(h)[0]).toBe(91); // mid-glide: still banked
    h.glideEnds();
    expect(heldSeqs(h)[0]).toBe(66); // one page at the boundary
    expect(h.thread().spinnerShowing).toBe(true);
  });
});

// --- the empty answer is only ever the current socket's, for the current shell ---

describe("an empty answer is only trusted for the socket that asked", () => {
  it.each(["before", "after"] as const)(
    "a stale empty answer from a replaced socket, landing %s the new one's, marks nothing",
    async (order) => {
      FakeSocket.all = [];
      const h = harness();
      h.connect();
      h.open(); // the server is empty; this probe hangs
      const stale = h.parked.splice(0);
      h.drop();
      h.server.addMany(120); // meanwhile, written from elsewhere
      h.open(); // since=0: the newest 50, 71..120
      if (order === "after") {
        await h.step(); // the new probe answers: 120 messages
        h.scrollTo(0); // and the first older page goes out
      }
      h.parked.unshift(...stale); // the old socket's empty answer lands now
      await h.flush();
      const { showingWhileOlderLeft } = await readToTheTop(h);
      expect(showingWhileOlderLeft.length).toBeGreaterThan(0);
      expect(showingWhileOlderLeft.every(Boolean)).toBe(true);
      expect(heldSeqs(h)).toEqual(allSeqs(h)); // every older page still came in
    },
  );

  it("an empty answer asked before a logout marks nothing after the next login", async () => {
    FakeSocket.all = [];
    const h = harness();
    h.connect();
    h.open(); // the server is empty; this probe hangs
    const stale = h.parked.splice(0);
    h.logout();
    h.server.addMany(120);
    h.login();
    h.open();
    await h.step(); // the new probe: 120 messages
    h.scrollTo(0); // the first older page goes out
    h.parked.unshift(...stale); // and the old session's empty answer lands first
    await h.flush();
    const { showingWhileOlderLeft } = await readToTheTop(h);
    expect(showingWhileOlderLeft.length).toBeGreaterThan(0);
    expect(showingWhileOlderLeft.every(Boolean)).toBe(true);
    expect(heldSeqs(h)).toEqual(allSeqs(h));
  });

  it("a login after an empty session starts the question over", async () => {
    FakeSocket.all = [];
    const h = harness();
    h.connect();
    h.open();
    await h.flush();
    expect(h.probe().historyDone).toBe(true);
    h.logout();
    h.server.addMany(80);
    h.login();
    expect(h.probe().historyDone).toBe(false); // the fresh shell's reset
    h.open();
    await h.flush();
    expect(h.thread().spinnerShowing).toBe(true);
    await readToTheTop(h);
    expect(heldSeqs(h)).toEqual(allSeqs(h));
  });

  it("messages sent from elsewhere while this phone was away still load after a reconnect", async () => {
    FakeSocket.all = [];
    const h = harness();
    h.connect();
    h.open();
    await h.flush();
    expect(h.probe().historyDone).toBe(true); // opened empty
    h.drop(); // away, and the socket went with it
    h.server.addMany(70); // a whole conversation on another device
    expect(h.socket().since()).toBe(0);
    h.open(); // the newest 50 come back: 21..70
    await h.flush();
    expect(h.probe().historyDone).toBe(false); // handed back to the page check
    for (let i = 0; i < 5; i++) {
      h.scrollTo(0);
      await h.flush();
    }
    expect(olderPageCursors(h)).toEqual([21]);
    expect(heldSeqs(h)).toEqual(allSeqs(h)); // 1..20 paged in as usual
    expect(h.probe().historyDone).toBe(true);
  });

  it("a reconnect that still finds the thread empty keeps it marked", async () => {
    FakeSocket.all = [];
    const h = harness();
    h.connect();
    h.open();
    await h.flush();
    h.drop();
    h.open();
    await h.flush();
    expect(h.probe().historyDone).toBe(true);
    h.send();
    expect(h.thread().spinnerShowing).toBe(false);
  });
});

// --- what the harness's spinner model stands on ---------------------------------

describe("the spinner rules the harness models", () => {
  it("the spinner is the first row of the thread box", () => {
    expect(main).toMatch(
      /<main id="thread" class="thread">\s*<div id="histspin" class="histspin"/,
    );
  });

  it("it shows as soon as the thread holds any row, and the farewell collapses it", () => {
    const flat = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(flat).toMatch(/\.histspin \{[^}]*display: none;/);
    expect(flat).toMatch(/\.thread:has\(\.evt\) \.histspin \{ display: flex; \}/);
    const bye = /\.histspin\.bye \{([^}]*)\}/.exec(flat)?.[1] ?? "";
    expect(bye).toMatch(/max-height: 0;/);
    expect(bye).toMatch(/opacity: 0;/);
  });

  it("the send's own bubble is an .evt row, so it alone would turn the spinner on", () => {
    expect(main).toMatch(/function localWrapper\([\s\S]{0,200}wrapper\.className = "evt";/);
  });
});
