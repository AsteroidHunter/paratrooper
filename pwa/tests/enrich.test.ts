// Pins for the richer-duplicate repair (src/enrich.ts) and its main.ts wiring.
// The rule itself is pure and runs directly; main.ts boots a real shell at
// import and cannot load under node, so the wiring (applyEvent's duplicate
// branch, the send ACK read-back, the reconcile page) is held by source pins,
// the flight.test.ts way.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ackFrame, enrichFrame } from "../src/enrich";

const dims = [[320, 240]] as [number, number][];
const hashes = ["LEHV6nWB2yk8"];

describe("enrichFrame: a richer re-delivery upgrades, anything else drops", () => {
  it("a re-delivery carrying both attachment fields the stored frame lacks merges", () => {
    const cur = { seq: 5, role: "user", payload: "pic", attachments: ["k1"] };
    const next = { ...cur, attachment_dims: dims, attachment_blurhashes: hashes };
    expect(enrichFrame(cur, next)).toEqual(next);
  });

  it("an identical duplicate (neither side has the fields) is dropped: null", () => {
    const cur = { seq: 5, role: "agent", payload: "hi" };
    expect(enrichFrame(cur, { ...cur })).toBeNull();
  });

  it("a duplicate of an already-rich frame gains nothing: null", () => {
    const cur = { seq: 5, payload: "pic", attachment_dims: dims,
      attachment_blurhashes: hashes };
    expect(enrichFrame(cur, { ...cur })).toBeNull();
  });

  it("a POORER re-delivery (fields missing that the stored frame has) is dropped", () => {
    const cur = { seq: 5, payload: "pic", attachment_dims: dims,
      attachment_blurhashes: hashes };
    const next = { seq: 5, payload: "pic" };
    expect(enrichFrame(cur, next)).toBeNull();
  });

  it("a partial gain merges without losing the stored copy's other field", () => {
    const cur = { seq: 5, payload: "pic", attachment_blurhashes: hashes };
    const next = { seq: 5, payload: "pic", attachment_dims: dims };
    expect(enrichFrame(cur, next)).toEqual({ seq: 5, payload: "pic",
      attachment_dims: dims, attachment_blurhashes: hashes });
  });

  it("a null ENTRY is the undecodable marker, not a missing field: still a gain", () => {
    const cur = { seq: 5, payload: "pic" };
    const next = { seq: 5, payload: "pic", attachment_dims: [null],
      attachment_blurhashes: [null] };
    expect(enrichFrame(cur, next)).toEqual(next);
  });

  it("the skew fallback's repair: the synthesized frame becomes the server row", () => {
    // when the guard below turns a bare ACK down, transmit stores this shape
    // (seq, role, payload, attachments, client ts) and adoptServerFrame fetches
    // the authoritative row; the merge must come out as the server's frame, its
    // ts and attachment fields included, so even the fallback heals a photo send
    const synthesized = { seq: 7, role: "user", payload: "pic",
      attachments: ["k1"], ts: "2026-01-01T00:00:00" };
    const server = { seq: 7, role: "user", payload: "pic", attachments: ["k1"],
      attachment_dims: dims, attachment_blurhashes: hashes,
      ts: "2026-01-01T00:00:02" };
    expect(enrichFrame(synthesized, server)).toEqual(server);
  });
});

describe("ackFrame: the ACK's frame is adopted, a bare ACK is turned down", () => {
  // what /api/send answers with now: the finished frame plus its status
  const ack = {
    status: "buffered", seq: 7, thread_id: "d", role: "user", payload: "pic",
    attachments: ["k1"], attachment_dims: dims, attachment_blurhashes: hashes,
    ts: "2026-01-01T00:00:02+00:00",
  };

  it("yields the frame alone: the status is the ACK's, never the frame's", () => {
    const { status, ...frame } = ack;
    expect(status).toBe("buffered");
    expect(ackFrame(ack)).toEqual(frame);
    expect(ackFrame(ack)).not.toHaveProperty("status");
  });

  it("the adopted frame is the server's row, its server-clock ts included", () => {
    const adopted = ackFrame(ack)!;
    expect(adopted.ts).toBe(ack.ts); // never a client clock
    expect(adopted.attachment_dims).toEqual(dims);
    expect(adopted.attachment_blurhashes).toEqual(hashes);
  });

  it("DEPLOY SKEW: an old server's bare ACK yields null, so nothing is stored", () => {
    expect(ackFrame({ status: "buffered", seq: 7 })).toBeNull();
  });

  it("half a frame is not a frame: role without ts, or ts without role", () => {
    expect(ackFrame({ status: "buffered", seq: 7, ts: ack.ts })).toBeNull();
    expect(ackFrame({ status: "buffered", seq: 7, role: "user" })).toBeNull();
  });

  it("an empty or wrongly typed role or ts is turned down as well", () => {
    expect(ackFrame({ role: "", ts: ack.ts })).toBeNull();
    expect(ackFrame({ role: "user", ts: "" })).toBeNull();
    expect(ackFrame({ role: 7, ts: ack.ts })).toBeNull();
    expect(ackFrame({ role: "user", ts: 1735689600 })).toBeNull();
    expect(ackFrame({ role: null, ts: null })).toBeNull();
  });

  it("the guard reads fields only: it never mutates the answer it was given", () => {
    const before = { ...ack };
    ackFrame(ack);
    expect(ack).toEqual(before);
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

describe("wiring: applyEvent repairs a stored seq instead of always dropping", () => {
  const apply = fnBody("applyEvent");

  it("a duplicate seq routes through enrichStored, then still returns", () => {
    expect(apply).toMatch(/if \(store\.has\(seq\)\) \{[\s\S]{0,300}enrichStored\(m\);\s*\n\s*return;/);
  });

  it("the duplicate branch never reaches the DOM work below it", () => {
    expect(apply.indexOf("enrichStored(m)")).toBeGreaterThan(-1);
    expect(apply.indexOf("enrichStored(m)")).toBeLessThan(apply.indexOf("createElement"));
  });
});

describe("wiring: enrichStored is store-and-snapshot only", () => {
  const body = fnBody("enrichStored");

  it("adopts the merge the rule yields and bumps the snapshot", () => {
    expect(body).toContain("enrichFrame(cur, m)");
    expect(body).toContain("store.set(seq, merged)");
    expect(body).toContain("cacheWrites.bump()");
  });

  it("never re-renders: the session keeps what it drew, the next boot gains", () => {
    expect(body).not.toMatch(/createElement|renderInto|rerender|scrollTo/);
  });
});

describe("wiring: the send path stores the server's own frame", () => {
  const body = fnBody("transmit");

  it("the whole answer is read, not just its seq, and run past the guard", () => {
    expect(body).toContain("const ack = (await resp.json())");
    expect(body).toContain("const served: ServerMsg | null = ackFrame(ack)");
    expect(body).toContain("if (served) store.set(seq, served)");
  });

  it("no frame is synthesized unless the guard turned the ACK down", () => {
    expect(body).toMatch(
      /if \(served\) store\.set\(seq, served\);\s*\n\s*else \{[\s\S]{0,700}ts: new Date\(\)\.toISOString\(\),/,
    );
  });

  it("the one surviving client clock is called out where it lives", () => {
    expect(body).toMatch(/deploy skew:[\s\S]{0,600}CLIENT clock[\s\S]{0,400}new Date\(\)/);
  });

  it("the ACKed frame still enters the cold-open snapshot", () => {
    expect(body).toContain("cacheWrites.bump()");
  });
});

describe("wiring: the read-back survives only as the skew fallback", () => {
  const body = fnBody("transmit");

  it("an adopted frame asks for nothing more: no second request on the normal path", () => {
    expect(body).toContain("if (!served && keys.length) void adoptServerFrame(seq)");
    expect(body.match(/adoptServerFrame/g)).toHaveLength(1); // that gated one, and no other
  });

  it("the read-back is the only place the send path touches history", () => {
    expect(body).not.toContain("api/history");
    expect(fnBody("adoptServerFrame")).toContain("api/history");
  });

  it("the read-back fetches exactly the ACKed row from the history endpoint", () => {
    const adopt = fnBody("adoptServerFrame");
    expect(adopt).toMatch(/api\/history\/\$\{THREAD_ID\}\?before=\$\{seq \+ 1\}&limit=1/);
    expect(adopt).toContain("messages.find((f) => f.seq === seq)");
    expect(adopt).toContain("enrichStored(m)");
  });

  it("a failed read-back stays quiet (the reconcile page is the second chance)", () => {
    expect(fnBody("adoptServerFrame")).toMatch(/catch \{\s*\n\s*return;/);
  });
});

describe("wiring: the reconcile page also heals stored frames", () => {
  it("every row of the newest page gets its chance at the stored copy", () => {
    expect(fnBody("reconcileRetracts")).toContain("for (const m of messages) enrichStored(m)");
  });
});
