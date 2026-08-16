// Round-trip pins for the durable outbox (src/outbox.ts), the store that lets a
// failed send survive an app close. IndexedDB is absent in the node test env, so
// fake-indexeddb supplies it; a fresh IDBFactory per test isolates the DB.
import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import type { OutboxRecord } from "../src/outbox";

// The module caches its open-DB promise, so a clean factory needs a fresh module
// import. Re-import per test gives each case an empty store.
async function freshOutbox() {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  return import("../src/outbox");
}

function bytes(...vals: number[]): ArrayBuffer {
  return new Uint8Array(vals).buffer;
}

function rec(over: Partial<OutboxRecord> = {}): OutboxRecord {
  return { id: "id-1", text: "hi", files: [], ts: 1000, ...over };
}

describe("outbox put/getAll/del", () => {
  let outbox: Awaited<ReturnType<typeof freshOutbox>>;
  beforeEach(async () => {
    outbox = await freshOutbox();
  });

  it("put then getAll round-trips a text-only record", async () => {
    await outbox.put(rec({ id: "a", text: "hello" }));
    expect(await outbox.getAll()).toEqual([rec({ id: "a", text: "hello" })]);
  });

  it("round-trips a record with file bytes intact", async () => {
    const buf = bytes(1, 2, 3, 255, 0, 42);
    await outbox.put(rec({ id: "img", files: [{ name: "p.jpg", type: "image/jpeg", buf }] }));
    const all = await outbox.getAll();
    expect(all).toHaveLength(1);
    const f = all[0].files[0];
    expect(f.name).toBe("p.jpg");
    expect(f.type).toBe("image/jpeg");
    expect([...new Uint8Array(f.buf)]).toEqual([1, 2, 3, 255, 0, 42]);
  });

  it("del removes one record and leaves the rest", async () => {
    await outbox.put(rec({ id: "a" }));
    await outbox.put(rec({ id: "b" }));
    await outbox.del("a");
    expect((await outbox.getAll()).map((r) => r.id)).toEqual(["b"]);
  });

  it("put with an existing id overwrites (a retry re-persist stays single)", async () => {
    await outbox.put(rec({ id: "a", text: "first" }));
    await outbox.put(rec({ id: "a", text: "second" }));
    const all = await outbox.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].text).toBe("second");
  });

  it("getAll on an empty store is []", async () => {
    expect(await outbox.getAll()).toEqual([]);
  });

  it("del of a missing id is a no-op", async () => {
    await outbox.put(rec({ id: "a" }));
    await outbox.del("nope");
    expect((await outbox.getAll()).map((r) => r.id)).toEqual(["a"]);
  });

  it("keeps multiple records and preserves each after a targeted delete", async () => {
    await outbox.put(rec({ id: "a", ts: 3 }));
    await outbox.put(rec({ id: "b", ts: 1 }));
    await outbox.put(rec({ id: "c", ts: 2 }));
    await outbox.del("b");
    const ids = (await outbox.getAll()).map((r) => r.id).sort();
    expect(ids).toEqual(["a", "c"]);
  });
});
