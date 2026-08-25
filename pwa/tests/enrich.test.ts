// Pins for the richer-duplicate repair (src/enrich.ts) and its main.ts wiring.
// The rule itself is pure and runs directly; main.ts boots a real shell at
// import and cannot load under node, so the wiring (applyEvent's duplicate
// branch, the send ACK read-back, the reconcile page) is held by source pins,
// the flight.test.ts way.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { enrichFrame } from "../src/enrich";

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

  it("the send path repair: the synthesized ACK frame becomes the server row", () => {
    // transmit stores this shape on ACK (seq, role, payload, attachments,
    // client ts) and adoptServerFrame fetches the authoritative row; the merge
    // must come out as the server's frame, its ts and attachment fields included
    const synthesized = { seq: 7, role: "user", payload: "pic",
      attachments: ["k1"], ts: "2026-01-01T00:00:00" };
    const server = { seq: 7, role: "user", payload: "pic", attachments: ["k1"],
      attachment_dims: dims, attachment_blurhashes: hashes,
      ts: "2026-01-01T00:00:02" };
    expect(enrichFrame(synthesized, server)).toEqual(server);
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

describe("wiring: the send path reads the authoritative frame back", () => {
  it("a photo send's ACK adoption kicks off the read-back; text-only does not", () => {
    expect(fnBody("transmit")).toMatch(
      /cacheWrites\.bump\(\);[\s\S]{0,600}if \(keys\.length\) void adoptServerFrame\(seq\)/,
    );
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
