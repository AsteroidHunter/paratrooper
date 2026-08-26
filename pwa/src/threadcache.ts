// Cold-open thread cache (the on-disk half of the one-paint boot in main.ts).
// One IndexedDB record per thread: the newest raw ServerMsg frames verbatim
// plus the lastSeq replay cursor. Boot reads it and applies every frame in a
// single task before any network, so the first content paint is the finished,
// bottom-pinned thread; the socket then connects with since=lastSeq and its
// replay dedups against the same frames by seq. Raw IndexedDB in the outbox.ts
// mold — screenshot frames carry data-URI payloads far past any localStorage
// quota, and a lost cache must only ever cost the old streaming boot.
//
// Its own database, not outbox.ts's: the two modules open independently, and
// a version bump here must never fail the outbox's open (IndexedDB rejects an
// open below the database's current version).
//
// Versioning is wholesale: a record whose schema stamp does not match is
// deleted on read and the boot proceeds cacheless — frames from an old wire
// shape must never reach applyEvent. Every read and write swallows its own
// errors: iOS can refuse IndexedDB entirely in private mode.

// TEMP DIAGNOSTIC (scroll-jank, scrolljank.ts owns the banner): one stamped
// span in put below, around the store call where the frames are cloned
import { jankSpan } from "./jankledger";

const DB_NAME = "paratrooper-threadcache";
const DB_VERSION = 1;
const STORE = "thread";

// bump on any change to the cached frame shape or its meaning; mismatched
// records are dropped wholesale on read
// 2: attachment_dims/attachment_blurhashes joined the frame shape; era-1
//    records lack them and render photos squished with no blur preview
export const SCHEMA_VERSION = 2;

// mirrors the server's fresh-login replay window (web/app.py limit=50), so a
// cached boot and a replayed boot build identical DOM
export const CACHE_FRAMES = 50;

export const WRITE_DEBOUNCE_MS = 3000;

// one cached thread. frames are the caller's raw ServerMsg objects, stored
// verbatim; this module never looks inside them.
export interface ThreadSnapshot<F = unknown> {
  id: string;
  lastSeq: number;
  frames: F[];
}

type StoredRecord = ThreadSnapshot & { schema: number };

// The open is attempted once and its result (a handle, or null when IndexedDB
// is unavailable or refused) is cached for the session. A null handle turns
// every op below into a safe no-op.
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDB(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null); // private mode can throw synchronously on open
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

// resolves when the write transaction COMMITS (durability), not merely when the
// request succeeds; any failure resolves quietly so the caller is never thrown
function write(db: IDBDatabase, op: (store: IDBObjectStore) => void): Promise<void> {
  return new Promise((resolve) => {
    let t: IDBTransaction;
    try {
      t = db.transaction(STORE, "readwrite");
    } catch {
      resolve();
      return;
    }
    t.oncomplete = () => resolve();
    t.onerror = () => resolve();
    t.onabort = () => resolve();
    try {
      op(t.objectStore(STORE));
    } catch {
      resolve(); // e.g. a clone error on an unstorable frame
    }
  });
}

function readOne(db: IDBDatabase, id: string): Promise<StoredRecord | null> {
  return new Promise((resolve) => {
    let req: IDBRequest;
    try {
      req = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
    } catch {
      resolve(null);
      return;
    }
    req.onsuccess = () => resolve((req.result as StoredRecord | undefined) ?? null);
    req.onerror = () => resolve(null);
  });
}

// insert or overwrite the thread's one record, stamped with the current
// schema and trimmed to the newest CACHE_FRAMES frames
export async function put(snapshot: ThreadSnapshot): Promise<void> {
  const db = await openDB();
  if (!db) return;
  const record: StoredRecord = {
    id: snapshot.id,
    schema: SCHEMA_VERSION,
    lastSeq: snapshot.lastSeq,
    frames: snapshot.frames.slice(-CACHE_FRAMES),
  };
  await write(db, (store) => {
    const jankT0 = performance.now(); // TEMP DIAGNOSTIC (scroll-jank): the put clones every frame synchronously here
    store.put(record);
    jankSpan("cache-put", jankT0); // TEMP DIAGNOSTIC (scroll-jank)
  });
}

// the thread's cached snapshot, or null when there is none. A record from
// another schema era (or one that lost its shape) is deleted here, wholesale,
// and reads back as null — the boot proceeds cacheless.
export async function get<F = unknown>(id: string): Promise<ThreadSnapshot<F> | null> {
  const db = await openDB();
  if (!db) return null;
  const rec = await readOne(db, id);
  if (!rec) return null;
  if (rec.schema !== SCHEMA_VERSION || !Array.isArray(rec.frames)
      || typeof rec.lastSeq !== "number") {
    await write(db, (store) => {
      store.delete(id);
    });
    return null;
  }
  return { id: rec.id, lastSeq: rec.lastSeq, frames: rec.frames as F[] };
}

// drop the thread's record (logout); a missing id is a no-op
export async function del(id: string): Promise<void> {
  const db = await openDB();
  if (!db) return;
  await write(db, (store) => {
    store.delete(id);
  });
}

// --- write scheduling (pure, injectable timer base — unit-tested) -------------
// The cache is rewritten debounced, not per apply: a replay burst lands fifty
// frames in one beat and must cost one write, a few seconds after the last.
// bump() marks the snapshot dirty and re-arms; flush() writes immediately but
// ONLY when dirty (visibilitychange-hidden fires on every backgrounding, and
// an unchanged thread must not rewrite megabytes of frames each time).

export interface WriteScheduler {
  /** the store changed: (re)arm the debounced write */
  bump(): void;
  /** going hidden: write NOW if a bump is pending, else do nothing */
  flush(): void;
  /** logout: drop any pending write without running it */
  cancel(): void;
}

export function createWriteScheduler(
  writeNow: () => void,
  debounceMs: number = WRITE_DEBOUNCE_MS,
): WriteScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function cancel(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return {
    bump(): void {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        writeNow();
      }, debounceMs);
    },
    flush(): void {
      if (!timer) return; // nothing changed since the last write
      cancel();
      writeNow();
    },
    cancel,
  };
}
