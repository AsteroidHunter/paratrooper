// A refused photo has to say so.
//
// The server now turns two kinds of upload away — one past the size cap, one
// whose bytes are not a photo whatever the file is called — and both come back
// as a plain sentence written for the owner. Before this the phone showed only
// the failed bubble and its Try Again, which for a refusal is an offer to be
// told no again in the same words nobody had seen the first time.
//
// A service that fell over is different: that is worth retrying, and the failed
// bubble already covers it. So the sentence is shown for a decision about the
// file (4xx) and never for a 5xx.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";
import { transformWithEsbuild } from "vite";

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

function sourceBetween(start: string, end: string): string {
  const at = main.indexOf(start);
  const until = main.indexOf(end, at + start.length);
  expect(at, `missing ${start}`).toBeGreaterThanOrEqual(0);
  expect(until, `missing ${end}`).toBeGreaterThan(at);
  return main.slice(at, until);
}

let script = "";

beforeAll(async () => {
  const block = sourceBetween("async function showUploadRefusal(", "async function transmit(");
  script = (await transformWithEsbuild(block, "refusal.ts", { loader: "ts" })).code;
});

function harness() {
  const bubbles: string[] = [];
  const context: Record<string, unknown> = {
    localBubble: (_role: string, cls: string, text: string) => void bubbles.push(`${cls}:${text}`),
  };
  runInNewContext(script, context);
  return {
    bubbles,
    show: (status: number, body: unknown) =>
      (context.showUploadRefusal as (r: unknown) => Promise<void>)({
        status,
        json: async () => {
          if (body instanceof Error) throw body;
          return body;
        },
      }),
  };
}

describe("the server's refusal reaches the screen", () => {
  it("shows the sentence the server wrote, for a decision about this file", async () => {
    const h = harness();
    await h.show(413, { detail: "That photo is bigger than 25 MB, so it was not sent." });
    await h.show(415, { detail: "That is not a photo I can open, so it was not sent." });
    expect(h.bubbles).toEqual([
      "error:⚠ That photo is bigger than 25 MB, so it was not sent.",
      "error:⚠ That is not a photo I can open, so it was not sent.",
    ]);
  });

  it("says nothing extra about a service that fell over, or an accepted upload", async () => {
    const h = harness();
    await h.show(500, { detail: "internal" });
    await h.show(502, { detail: "bad gateway" });
    await h.show(200, { inbox_key: "k" });
    expect(h.bubbles).toEqual([]);
  });

  it("does not invent a message when the refusal carries none", async () => {
    const h = harness();
    await h.show(413, {});
    await h.show(415, new Error("not JSON"));
    expect(h.bubbles).toEqual([]);
  });
});

describe("the send path asks before it gives up on the photo", () => {
  const transmit = /async function transmit\(([\s\S]*?)\n}\n/.exec(main)?.[1] ?? "";

  it("shows the refusal, then marks the send failed as it always did", () => {
    expect(transmit, "transmit not found").not.toBe("");
    // the upload's own refusal branch, not the network catch above it
    const branch = transmit.slice(transmit.indexOf("if (!r.ok) {"));
    const refusal = branch.slice(0, branch.indexOf("keys.push("));
    expect(refusal).toContain("await showUploadRefusal(r);");
    expect(refusal.indexOf("await showUploadRefusal(r);")).toBeLessThan(
      refusal.indexOf("return markFailed(w, text, files);"),
    );
    // and only for the upload: a refused /api/send still says nothing extra
    const send = transmit.slice(transmit.indexOf('fetch("/api/send"'));
    expect(send).not.toContain("showUploadRefusal");
  });
});
