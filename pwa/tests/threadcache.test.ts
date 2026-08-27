// Pins for the cold-open thread cache (src/threadcache.ts) and its main.ts
// wiring. Round-trips run on fake-indexeddb (a fresh factory per test); the
// schema-drop cases plant records by raw IndexedDB access, so the pins also
// hold the record to its physical home (db paratrooper-threadcache, store
// thread). The scheduler is pure and runs on fake timers. main.ts boots a
// real shell at import and cannot load under node, so the boot order — shell,
// cached frames in ONE task, instant pin plus the rAF re-assert, socket LAST —
// is held by source pins, the flight.test.ts way.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";

// The module caches its open-DB promise, so a clean factory needs a fresh
// module import. Re-import per test gives each case an empty store.
async function freshCache() {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  return import("../src/threadcache");
}

const frame = (seq: number) => ({ seq, role: "agent", kind: "log", payload: `p${seq}` });

// raw access to the record's physical home, bypassing the module's guards —
// how a schema-era record or a corrupted row actually comes to exist on disk
const DB = "paratrooper-threadcache";
const STORE = "thread";

function rawOpen(): Promise<IDBDatabase> {
  return new Promise((resolve) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

async function rawPut(rec: Record<string, unknown>): Promise<void> {
  const db = await rawOpen();
  await new Promise<void>((resolve) => {
    const t = db.transaction(STORE, "readwrite");
    t.objectStore(STORE).put(rec);
    t.oncomplete = () => resolve();
  });
  db.close();
}

async function rawGet(id: string): Promise<unknown> {
  const db = await rawOpen();
  const out = await new Promise((resolve) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(undefined);
  });
  db.close();
  return out;
}

describe("threadcache put/get/del round-trips", () => {
  let cache: Awaited<ReturnType<typeof freshCache>>;
  beforeEach(async () => {
    cache = await freshCache();
  });

  it("put then get round-trips frames verbatim with the lastSeq cursor", async () => {
    const frames = [frame(1), frame(2), frame(3)];
    await cache.put({ id: "default", lastSeq: 3, frames });
    expect(await cache.get("default")).toEqual({ id: "default", lastSeq: 3, frames });
  });

  it("get with no record is null (first ever run: the cacheless boot)", async () => {
    expect(await cache.get("default")).toBeNull();
  });

  it("put keeps only the newest CACHE_FRAMES frames", async () => {
    const frames = Array.from({ length: cache.CACHE_FRAMES + 5 }, (_, i) => frame(i + 1));
    await cache.put({ id: "default", lastSeq: 55, frames });
    const got = await cache.get<{ seq: number }>("default");
    expect(got?.frames).toHaveLength(cache.CACHE_FRAMES);
    expect(got?.frames[0].seq).toBe(6); // the oldest five fell off, the tail survived
    expect(got?.frames[cache.CACHE_FRAMES - 1].seq).toBe(55);
  });

  it("put overwrites the thread's one record, never accumulates", async () => {
    await cache.put({ id: "default", lastSeq: 1, frames: [frame(1)] });
    await cache.put({ id: "default", lastSeq: 2, frames: [frame(1), frame(2)] });
    expect((await cache.get("default"))?.lastSeq).toBe(2);
  });

  it("a record from another schema era is dropped wholesale on read", async () => {
    await rawPut({ id: "default", schema: cache.SCHEMA_VERSION + 1, lastSeq: 9,
      frames: [frame(9)] });
    expect(await cache.get("default")).toBeNull();
    expect(await rawGet("default")).toBeUndefined(); // deleted, not just skipped
  });

  it("an era-1 record (frames without the attachment fields) is discarded", async () => {
    // the bump itself: era-1 photo frames lack attachment_dims and
    // attachment_blurhashes, so the whole store is dropped once and the boot
    // rebuilds from the server's healed rows
    expect(cache.SCHEMA_VERSION).toBeGreaterThan(1);
    await rawPut({ id: "default", schema: 1, lastSeq: 9,
      frames: [{ seq: 9, role: "user", payload: "pic", attachments: ["k1"] }] });
    expect(await cache.get("default")).toBeNull();
    expect(await rawGet("default")).toBeUndefined();
  });

  it("a record that lost its shape (frames not an array) is dropped too", async () => {
    await rawPut({ id: "default", schema: cache.SCHEMA_VERSION, lastSeq: 9, frames: "no" });
    expect(await cache.get("default")).toBeNull();
    expect(await rawGet("default")).toBeUndefined();
  });

  it("a record without a numeric lastSeq cursor is dropped too", async () => {
    await rawPut({ id: "default", schema: cache.SCHEMA_VERSION, frames: [frame(1)] });
    expect(await cache.get("default")).toBeNull();
    expect(await rawGet("default")).toBeUndefined();
  });

  it("del removes the record (logout); a missing id is a no-op", async () => {
    await cache.put({ id: "default", lastSeq: 1, frames: [frame(1)] });
    await cache.del("default");
    expect(await cache.get("default")).toBeNull();
    await cache.del("default"); // second delete: quiet
  });

  it("records are stamped with the current schema on disk", async () => {
    await cache.put({ id: "default", lastSeq: 1, frames: [frame(1)] });
    expect(await rawGet("default")).toMatchObject({ schema: cache.SCHEMA_VERSION });
  });
});

describe("write scheduler — debounced after applies, flush only when dirty", () => {
  let cache: Awaited<ReturnType<typeof freshCache>>;
  beforeEach(async () => {
    cache = await freshCache();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("bump writes once, a debounce after the LAST bump of a burst", () => {
    const writes = vi.fn();
    const s = cache.createWriteScheduler(writes, 3000);
    s.bump();
    vi.advanceTimersByTime(2000);
    s.bump(); // a replay burst keeps bumping; the write trails the last apply
    vi.advanceTimersByTime(2999);
    expect(writes).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it("flush writes immediately when a bump is pending and disarms the timer", () => {
    const writes = vi.fn();
    const s = cache.createWriteScheduler(writes, 3000);
    s.bump();
    s.flush(); // going hidden mid-debounce
    expect(writes).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(writes).toHaveBeenCalledTimes(1); // no second write from the dead timer
  });

  it("flush with nothing pending writes nothing (every backgrounding is a flush)", () => {
    const writes = vi.fn();
    const s = cache.createWriteScheduler(writes, 3000);
    s.flush();
    s.bump();
    vi.advanceTimersByTime(3000);
    s.flush(); // clean again: the debounced write already landed
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it("cancel drops the pending write without running it (logout)", () => {
    const writes = vi.fn();
    const s = cache.createWriteScheduler(writes, 3000);
    s.bump();
    s.cancel();
    vi.advanceTimersByTime(10_000);
    s.flush(); // cancel also cleared the dirty state: still nothing
    expect(writes).not.toHaveBeenCalled();
  });
});

// --- main.ts wiring pins (source-read, like flight.test.ts) -------------------

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/main.ts"),
  "utf8",
);

function fnBody(name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("\n}", start);
  return src.slice(start, end);
}

describe("boot order — shell, cached frames in one task, pin, THEN the socket", () => {
  const boot = fnBody("bootFromCache");

  it("the token boot renders the shell and routes through bootFromCache, not connect", () => {
    const gate = src.lastIndexOf("if (token) {");
    const tail = src.slice(gate);
    expect(tail.indexOf("renderChat()")).toBeGreaterThan(-1);
    expect(tail.indexOf("renderChat()")).toBeLessThan(tail.indexOf("bootFromCache()"));
    expect(tail).not.toMatch(/renderChat\(\);\s*\n\s*connect\(\)/);
  });

  it("cached frames apply through the one applyEvent path with animations suppressed", () => {
    expect(boot).toContain("suppressAnim = true");
    expect(boot).toContain("for (const m of cached.frames) applyEvent(m)");
  });

  it("applies come before the pin, the pin before the rAF re-assert, the socket last", () => {
    const apply = boot.indexOf("applyEvent(m)");
    const pin = boot.indexOf("scrollToBottom(true)");
    const reassert = boot.indexOf("requestAnimationFrame");
    const socket = boot.indexOf("connect()");
    expect(apply).toBeGreaterThan(-1);
    expect(apply).toBeLessThan(pin);
    expect(pin).toBeLessThan(reassert);
    expect(reassert).toBeLessThan(socket);
    // the re-assert re-pins from LIVE geometry (the Safari swallowed-first-
    // write quirk, minus the stale captured value that re-pinned a frame iOS
    // had already re-sized) — never a fresh smooth scroll
    expect(boot).toMatch(/requestAnimationFrame[\s\S]{0,600}scrollTop = el\.scrollHeight/);
    // and it stands down entirely if a bottom-geometry settle has answered for
    // a fresher box in between (main.ts settleTail, tailsettle.test.ts)
    expect(boot).toContain("armed === tailGen");
    expect(boot).not.toContain("scrollTop = pinned");
  });

  it("the cached cursor advances lastSeq so connect() asks since=cachedLastSeq", () => {
    expect(boot).toContain("if (cached.lastSeq > lastSeq) lastSeq = cached.lastSeq");
    expect(fnBody("connect")).toContain("since=${lastSeq}");
  });

  it("the trail names the read and the apply (cache-read, cache-applied)", () => {
    expect(boot).toMatch(/holdDiagRecord\("cache-read", \{ frames: cached\.frames\.length/);
    expect(boot).toContain('holdDiagRecord("cache-applied"');
    // a cacheless boot still records the read, so the trail tells (a) from (b)
    expect(boot).toMatch(/holdDiagRecord\("cache-read", \{ frames: 0/);
  });
});

describe("boot frame-settle guard — the launch settle re-pins in its own task", () => {
  const guard = fnBody("armBootFrameGuard");
  const boot = fnBody("bootFromCache");

  it("armed at the top of the boot, before the cache read", () => {
    expect(boot.indexOf("armBootFrameGuard()")).toBeGreaterThan(-1);
    expect(boot.indexOf("armBootFrameGuard()")).toBeLessThan(boot.indexOf("cacheGet"));
  });

  it("covers window and visual-viewport geometry, and expires with its window", () => {
    for (const src of ['"resize"', '"scroll"', '"vv-resize"', '"vv-scroll"']) {
      expect(guard).toContain(src);
    }
    expect(guard).toContain("removeEventListener");
    expect(src).toContain("const FRAME_SETTLE_MS = 2000");
  });

  it("clears launch displacement through the close pass's own conditional write", () => {
    // closeCorrectionNeeded is the shipped displacement verdict (shell.ts);
    // the guard must never invent a second rule
    expect(guard).toContain("closeCorrectionNeeded(x, y, top)");
    expect(guard).toMatch(/if \(snap\) window\.scrollTo\(0, 0\)/);
  });

  it("re-pins instantly, followTail-gated, never a glide", () => {
    expect(guard).toContain("t && followTail");
    expect(guard).toContain("t.scrollTop = t.scrollHeight");
    expect(guard).not.toContain("smooth");
  });

  it("keyboard sessions are excluded: the shell owns focus geometry", () => {
    expect(guard).toContain('activeElement?.id === "text"');
    expect(guard).toContain('classList.contains("kb")');
  });

  it("every correction lands on the trail as boot-repin", () => {
    expect(guard).toContain('holdDiagRecord("boot-repin"');
  });
});

describe("boot-window motion recorder (TEMP, rides the holddiag trail)", () => {
  const channels = fnBody("bootMotionChannels");
  const rec = fnBody("startBootMotion");
  const holdSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../src/hold.ts"),
    "utf8",
  );

  it("starts at module init, before the boot lines", () => {
    const start = src.indexOf("startBootMotion();");
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(src.lastIndexOf("if (token) {"));
  });

  it("samples the frame quantities the drop could hide in", () => {
    for (const name of [
      '"shell-top"', '"shell-h"', '"inset-top"', '"inset-bottom"',
      '"doc-scroll"', '"thread-scroll"', '"thread-sh"', '"first-msg-top"',
      '"vv-top"', '"vv-h"',
    ]) {
      expect(channels).toContain(name);
    }
    // the insets are read as CONSUMED (computed style on header and compose),
    // not as raw env() text
    expect(channels).toContain("getComputedStyle(bar).paddingTop");
    expect(channels).toContain("getComputedStyle(compose).paddingBottom");
    // .evt is display:contents (no box): the first laid-out descendant speaks
    expect(channels).toContain('querySelector(".evt > *")');
  });

  it("names the mover past a 1px threshold and caps the ring", () => {
    expect(rec).toContain("Math.abs(delta) > 1");
    expect(rec).toContain("recorded < BOOT_MOTION_MAX");
    expect(rec).toContain('holdDiagRecord("boot-motion"');
    expect(rec).toMatch(/moved: name/);
    expect(src).toContain("const BOOT_MOTION_MAX = 60");
  });

  it("the window runs from init until the tail past first content, bounded", () => {
    expect(src).toContain("const BOOT_MOTION_TAIL_MS = 2000");
    expect(src).toContain("const BOOT_MOTION_LEAD_MAX_MS = 15000");
    expect(rec).toContain("nowMs - contentAt > BOOT_MOTION_TAIL_MS");
    expect(rec).toContain("nowMs - t0 > BOOT_MOTION_LEAD_MAX_MS");
  });

  it("the new record names trigger the diag post", () => {
    expect(holdSrc).toContain('ev === "boot-motion"');
    expect(holdSrc).toContain('ev === "boot-repin"');
  });
});

describe("write wiring — debounced after applies, flushed on hidden, gone on logout", () => {
  it("applyEvent bumps the debounced snapshot after every applied frame", () => {
    expect(fnBody("applyEvent")).toContain("cacheWrites.bump()");
  });

  it("a retract leaves the snapshot too: applyRetract bumps when it removed a row", () => {
    expect(fnBody("applyRetract")).toMatch(/if \(hadStore\) cacheWrites\.bump\(\)/);
  });

  it("an ACKed send enters the snapshot: transmit bumps on seq adoption", () => {
    expect(fnBody("transmit")).toContain("cacheWrites.bump()");
  });

  it("going hidden flushes the pending snapshot", () => {
    expect(src).toMatch(/visibilitychange[\s\S]{0,200}cacheWrites\.flush\(\)/);
  });

  it("logout cancels the pending write and deletes the record", () => {
    const logout = src.indexOf('getElementById("confirm-yes")');
    const gate = src.indexOf("renderTokenGate()", logout);
    const between = src.slice(logout, gate);
    expect(between.indexOf("cacheWrites.cancel()")).toBeGreaterThan(-1);
    // cancel BEFORE delete: a pending write must not resurrect the record
    expect(between.indexOf("cacheWrites.cancel()")).toBeLessThan(
      between.indexOf("cacheDel(THREAD_ID)"),
    );
  });

  it("the snapshot is the newest CACHE_FRAMES stored frames plus the cursor", () => {
    const body = fnBody("writeThreadCache");
    expect(body).toContain("slice(-CACHE_FRAMES)");
    expect(body).toContain("lastSeq");
    // an empty snapshot must never clobber a good record
    expect(body).toMatch(/store\.size === 0\) return/);
  });
});
