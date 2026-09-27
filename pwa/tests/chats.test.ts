// Multiple chats on the phone: the chat list's rules (chatlist.ts), the keying
// of the failed-send outbox and the saved-thread cache by chat, and the main.ts
// wiring that switches chats. main.ts boots a real shell at import and cannot
// load under node, so its wiring is held by source pins, the way
// threadcache.test.ts holds the boot order.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import {
  DEFAULT_THREAD,
  EDGE_PX,
  FLICK,
  bootThread,
  chatTimeLabel,
  closeVerdict,
  isThreadId,
  orderChats,
  pullVerdict,
  readChats,
  settlesOpen,
  unreadElsewhere,
} from "../src/chatlist";
import type { ChatSummary } from "../src/chatlist";
import { forThread } from "../src/outbox";
import type { OutboxRecord } from "../src/outbox";

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

function fnBody(name: string): string {
  const at = main.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
  expect(at, `missing function ${name}`).toBeGreaterThan(-1);
  const next = main.slice(at + 1).search(/\n(?:async )?function |\nconst |\nlet /);
  return main.slice(at, next === -1 ? undefined : at + 1 + next);
}

const chat = (id: string, updated: string, unread = 0): ChatSummary => ({
  id, title: id, preview: "", updated, unread,
});

// --- which chat a boot opens ---------------------------------------------------

describe("the chat a boot opens", () => {
  it("is the one a notification tap named, then the one open last, then the default", () => {
    expect(bootThread("?thread=0123456789abcdef", "abc")).toBe("0123456789abcdef");
    expect(bootThread("", "abc")).toBe("abc");
    expect(bootThread("", null)).toBe(DEFAULT_THREAD);
    expect(DEFAULT_THREAD).toBe("default");
  });

  it("never takes an id the service would refuse", () => {
    expect(bootThread("?thread=a:b", null)).toBe(DEFAULT_THREAD);
    expect(bootThread("?thread=../x", "also:bad")).toBe(DEFAULT_THREAD);
    expect(isThreadId("x".repeat(65))).toBe(false);
    expect(isThreadId("")).toBe(false);
    expect(isThreadId(42)).toBe(false);
    expect(isThreadId("0123456789abcdef")).toBe(true);
  });
});

// --- the list ---------------------------------------------------------------------

describe("the chat list's order", () => {
  it("is newest activity first, whatever order the rows came in", () => {
    const list = [
      chat("old", "2026-09-01T00:00:00+00:00"),
      chat("newest", "2026-09-03T00:00:00+00:00"),
      chat("middle", "2026-09-02T00:00:00+00:00"),
    ];
    expect(orderChats(list).map((c) => c.id)).toEqual(["newest", "middle", "old"]);
  });

  it("settles a tie by id, so two refreshes never swap rows", () => {
    const at = "2026-09-01T00:00:00+00:00";
    const a = orderChats([chat("b", at), chat("a", at)]).map((c) => c.id);
    const b = orderChats([chat("a", at), chat("b", at)]).map((c) => c.id);
    expect(a).toEqual(["a", "b"]);
    expect(b).toEqual(a);
  });

  it("puts a row with no readable time last rather than guessing", () => {
    const list = [chat("unknown", "not a time"), chat("known", "2026-01-01T00:00:00Z")];
    expect(orderChats(list).map((c) => c.id)).toEqual(["known", "unknown"]);
  });

  it("does not reorder the caller's array", () => {
    const list = [chat("a", "2026-01-01T00:00:00Z"), chat("b", "2026-02-01T00:00:00Z")];
    orderChats(list);
    expect(list.map((c) => c.id)).toEqual(["a", "b"]);
  });
});

describe("reading the service's list", () => {
  it("keeps well-formed rows and drops ones with an unusable id", () => {
    const got = readChats({
      threads: [
        { id: "default", title: "hi", preview: "yo", updated: "2026-01-01T00:00:00Z", unread: 2 },
        { id: "a:b", title: "bad id" },
        { id: "0123456789abcdef", title: "", preview: null, updated: 5, unread: -1 },
      ],
    });
    expect(got).toEqual([
      { id: "default", title: "hi", preview: "yo", updated: "2026-01-01T00:00:00Z", unread: 2 },
      { id: "0123456789abcdef", title: "New chat", preview: "", updated: "", unread: 0 },
    ]);
  });

  it("is null for anything that is not a list", () => {
    expect(readChats(null)).toBeNull();
    expect(readChats({ threads: "no" })).toBeNull();
  });
});

describe("the header button's count", () => {
  it("counts unread replies in every chat but the one on screen", () => {
    const list = [chat("a", "", 2), chat("b", "", 3), chat("c", "", 0)];
    expect(unreadElsewhere(list, "a")).toBe(3);
    expect(unreadElsewhere(list, "b")).toBe(2);
    expect(unreadElsewhere(list, "elsewhere")).toBe(5);
  });
});

describe("the time beside a chat", () => {
  // local times throughout: the label is read in the phone's own time zone
  const now = new Date(2026, 8, 27, 15, 30); // Sunday 27 Sep 2026, 3:30 PM
  const at = (d: Date) => d.toISOString();

  it("is the clock for today", () => {
    expect(chatTimeLabel(at(new Date(2026, 8, 27, 9, 5)), now)).toBe("9:05 AM");
    expect(chatTimeLabel(at(new Date(2026, 8, 27, 0, 0)), now)).toBe("12:00 AM");
    expect(chatTimeLabel(at(new Date(2026, 8, 27, 12, 1)), now)).toBe("12:01 PM");
    expect(chatTimeLabel(at(new Date(2026, 8, 27, 15, 29)), now)).toBe("3:29 PM");
  });

  it("is Yesterday, then the weekday, then a short date", () => {
    expect(chatTimeLabel(at(new Date(2026, 8, 26, 23, 59)), now)).toBe("Yesterday");
    expect(chatTimeLabel(at(new Date(2026, 8, 24, 8, 0)), now)).toBe("Thursday");
    expect(chatTimeLabel(at(new Date(2026, 8, 21, 8, 0)), now)).toBe("Monday");
    expect(chatTimeLabel(at(new Date(2026, 8, 20, 8, 0)), now)).toBe("9/20/26");
    expect(chatTimeLabel(at(new Date(2025, 11, 31, 8, 0)), now)).toBe("12/31/25");
  });

  it("says nothing for a time it cannot read", () => {
    expect(chatTimeLabel("", now)).toBe("");
    expect(chatTimeLabel("soon", now)).toBe("");
  });
});

// --- the gestures -------------------------------------------------------------------

describe("the pull from the left edge", () => {
  it("claims a decisive rightward move that started at the edge", () => {
    expect(pullVerdict(4, 30, 3)).toBe("drag");
    expect(pullVerdict(EDGE_PX, 30, 0)).toBe("drag");
  });

  it("waits while the move is too small to have a direction", () => {
    expect(pullVerdict(4, 6, 4)).toBeNull();
  });

  it("leaves everything else to the thread", () => {
    expect(pullVerdict(EDGE_PX + 1, 60, 0)).toBe("pass"); // not at the edge
    expect(pullVerdict(4, 20, 18)).toBe("pass"); // more diagonal than sideways
    expect(pullVerdict(4, 0, 40)).toBe("pass"); // a scroll
    expect(pullVerdict(4, -30, 0)).toBe("pass"); // leftward is the time peek's
  });

  it("closes on a decisive leftward move on the open list, and scrolls on anything else", () => {
    expect(closeVerdict(-30, 4)).toBe("drag");
    expect(closeVerdict(-4, 3)).toBeNull();
    expect(closeVerdict(0, 30)).toBe("pass");
    expect(closeVerdict(30, 0)).toBe("pass");
  });

  it("settles by flick direction, else by whether more than half is out", () => {
    expect(settlesOpen(40, 300, FLICK + 0.1)).toBe(true);
    expect(settlesOpen(260, 300, -(FLICK + 0.1))).toBe(false);
    expect(settlesOpen(160, 300, 0)).toBe(true);
    expect(settlesOpen(140, 300, 0.1)).toBe(false);
  });
});

// --- the outbox and the cache, keyed by chat -----------------------------------------

describe("failed sends come back only in their own chat", () => {
  const rec = (id: string, thread?: string): OutboxRecord => ({
    id, text: id, files: [], ts: 1, ...(thread ? { thread } : {}),
  });

  it("filters by chat, and a record from before chats existed is the default chat's", () => {
    const records = [rec("old"), rec("d", "default"), rec("x", "0123456789abcdef")];
    expect(forThread(records, "default").map((r) => r.id)).toEqual(["old", "d"]);
    expect(forThread(records, "0123456789abcdef").map((r) => r.id)).toEqual(["x"]);
    expect(forThread(records, "other")).toEqual([]);
  });

  it("is written with the chat the send belongs to", () => {
    expect(fnBody("persistFailed")).toContain("outboxPut({ id, text, files: stored, ts, thread })");
    expect(fnBody("markFailed")).toContain("w.dataset.thread ?? THREAD_ID");
    expect(fnBody("restoreOutbox")).toContain("outboxForThread(await outboxGetAll(), THREAD_ID)");
  });
});

describe("the saved-thread cache per chat", () => {
  async function freshCache() {
    globalThis.indexedDB = new IDBFactory();
    vi.resetModules();
    return import("../src/threadcache");
  }

  it("keeps one record per chat, and logout clears every one of them", async () => {
    const cache = await freshCache();
    const frame = (seq: number) => ({ seq, role: "agent", kind: "done", payload: `p${seq}` });
    await cache.put({ id: "default", lastSeq: 2, frames: [frame(1), frame(2)] });
    await cache.put({ id: "0123456789abcdef", lastSeq: 3, frames: [frame(3)] });
    expect((await cache.get("default"))?.frames).toEqual([frame(1), frame(2)]);
    expect((await cache.get("0123456789abcdef"))?.lastSeq).toBe(3);
    await cache.clear();
    expect(await cache.get("default")).toBeNull();
    expect(await cache.get("0123456789abcdef")).toBeNull();
  });

  it("writes under the chat on screen and reads the chat being opened", () => {
    expect(fnBody("writeThreadCache")).toContain("cachePut({ id: THREAD_ID");
    expect(fnBody("bootFromCache")).toContain("cacheGet<ServerMsg>(THREAD_ID)");
  });
});

// --- switching chats in main.ts -------------------------------------------------------

describe("switching chats", () => {
  const open = fnBody("openThread");

  it("is the only writer of the chat on screen after boot", () => {
    expect(main).toMatch(/\nlet THREAD_ID = bootThread\(location\.search, localStorage\.getItem\(THREAD_KEY\)\);/);
    const writes = [...main.matchAll(/\n\s+THREAD_ID = /g)].length;
    // openThread's own, and logout's return to the default chat
    expect(writes).toBe(2);
    expect(fnBody("leaveChat")).toContain("THREAD_ID = DEFAULT_THREAD;");
  });

  it("lands the leaving chat's snapshot before anything moves", () => {
    expect(open.indexOf("cacheWrites.flush()")).toBeGreaterThan(-1);
    expect(open.indexOf("cacheWrites.flush()")).toBeLessThan(open.indexOf("THREAD_ID = id"));
  });

  it("closes the leaving chat's socket on purpose, with no retry left armed", () => {
    const at = open.indexOf("closingOnPurpose = true");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(open.indexOf("dropSocket()"));
    expect(open).toContain("if (retryTimer) clearTimeout(retryTimer);");
    expect(open).toContain("if (probeFallback) clearTimeout(probeFallback);");
  });

  it("moves the epoch and the cursor, then runs the fresh shell and the cold open", () => {
    const epoch = open.indexOf("threadEpoch += 1");
    const shell = open.indexOf("renderChat()");
    const boot = open.indexOf("bootFromCache()");
    expect(epoch).toBeGreaterThan(-1);
    expect(epoch).toBeLessThan(shell);
    expect(open.indexOf("lastSeq = 0")).toBeLessThan(shell);
    expect(shell).toBeLessThan(boot);
    expect(open).toContain("pendingFiles = []"); // staged photos stay with their chat's shell
  });

  it("keeps the session's own setup across a switch", () => {
    const render = main.slice(main.indexOf("function renderChat()"), main.indexOf("async function loadOlder("));
    expect(render).toMatch(/if \(!switchingChat\) \{[\s\S]*?armPushDialogEntrance\(\);[\s\S]*?startPushNotifications\(\);[\s\S]*?loadPrLinkPrefix\(\)/);
    expect(open).toMatch(/switchingChat = true;[\s\S]*?renderChat\(\);[\s\S]*?switchingChat = false;/);
  });

  it("keeps the profile this deployment already confirmed", () => {
    expect(fnBody("bootFromCache")).toContain("profile = restoreProfile() ?? profile;");
  });

  it("drops every answer that comes back for the chat that was left", () => {
    for (const name of ["loadOlder", "probeReplayTail", "reconcileRetracts", "transmit", "restoreOutbox"]) {
      const body = fnBody(name);
      expect(body, name).toContain("const epoch = threadEpoch");
      expect(body, name).toContain("epoch !== threadEpoch");
    }
  });

  it("sends to the chat the message was written in, even if the screen has moved on", () => {
    const body = fnBody("transmit");
    expect(body).toContain("const thread = THREAD_ID;");
    expect(body).toContain("thread_id: thread,");
    expect(body).not.toContain("thread_id: THREAD_ID");
  });

  it("clears every chat's saved copy and the remembered chat on logout", () => {
    const body = fnBody("leaveChat");
    expect(body).toContain("void cacheClear()");
    expect(body).toContain("localStorage.removeItem(THREAD_KEY)");
    expect(body).toContain("chats.forget()");
  });

  it("opens the chat a notification tap names, running or not", () => {
    expect(main).toMatch(/data\?\.kind === "open-thread" && isThreadId\(data\.thread\)\) openThread\(data\.thread\)/);
    const boot = main.slice(main.lastIndexOf("if (token) {"));
    expect(boot.indexOf("keepBootThread()")).toBeLessThan(boot.indexOf("renderChat()"));
    expect(fnBody("keepBootThread")).toContain("history.replaceState");
  });
});

describe("the chat list's wiring", () => {
  it("has a header button in the bar's empty left column", () => {
    const bar = main.indexOf('<header class="bar">');
    const header = main.slice(bar, main.indexOf('<div class="contact">', bar));
    expect(header).toContain('id="chats-btn"');
    expect(css).toMatch(/\.chatsbtn \{[\s\S]*?grid-column: 1;/);
  });

  it("is mounted into every rendered shell after the markup", () => {
    const render = main.slice(main.indexOf("function renderChat()"), main.indexOf("async function loadOlder("));
    expect(render).toContain("chats.mount(app);");
    expect(render.indexOf("chats.mount(app);")).toBeGreaterThan(render.indexOf("app.innerHTML"));
  });

  it("decides the edge pull in the thread's own touch handlers, before the peek", () => {
    const render = main.slice(main.indexOf("function renderChat()"), main.indexOf("async function loadOlder("));
    expect(render).toContain("chats.pullStart(startX)");
    const pull = render.indexOf("if (chats.pullMove(dx, dy)) {");
    expect(pull).toBeGreaterThan(-1);
    expect(pull).toBeLessThan(render.indexOf("if (peeking === null) {"));
    expect(render).toContain("chats.pullEnd()");
  });

  it("refreshes on every socket open and on the service's nudge", () => {
    const connect = fnBody("connect");
    expect(connect).toContain("void chats.refresh();");
    expect(connect).toContain('else if (m.kind === "threads") chats.nudged();');
  });

  it("puts the keyboard away with a blur, and never opens in the picker's window", () => {
    expect(main).toMatch(/canOpen: \(\) => Boolean\(token\) && !app\.classList\.contains\("settling"\)/);
    expect(main).toMatch(/active\.id === "text"\) active\.blur\(\)/);
  });

  it("stays out of the keyboard shell: no document touch listener, no keyboard hook", () => {
    const list = readFileSync(new URL("../src/chatlist.ts", import.meta.url), "utf8");
    expect(list).not.toMatch(/document\.addEventListener|window\.addEventListener/);
    expect(list).not.toMatch(/watchKeyboard|watchLift|--kb-/);
    expect(css).not.toMatch(/\.chats[^{]*\{[^}]*transition:[^}]*(top|height)/);
  });
});
