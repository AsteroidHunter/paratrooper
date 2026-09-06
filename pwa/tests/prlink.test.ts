// The one tappable thing the agent writes: the pull request address in a pr
// bubble.
//
// That address is content. It arrives over the same channel as the reply text,
// and the bubble was turning it into a link whatever it said, so anything the
// agent could be talked into writing was a link the owner could tap on his
// phone. A link is the one element on this screen that takes the reader
// somewhere, so it is the one that has to be checked against something the
// message cannot influence — and the only such thing is the repository this
// service publishes to, which the server states and the phone asks for.
//
// The rule runs here rather than being read: main.ts is the app's entry point
// and importing it would boot the whole app, so the block is cut out by name
// and run in a VM, the way logoutbox.test.ts and push.test.ts do it.
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

const REPO = "https://github.com/AsteroidHunter/webpage";

let script = "";

beforeAll(async () => {
  const block = sourceBetween(
    "// --- which pull request links may be tapped",
    "function thumbUrl(",
  );
  script = (await transformWithEsbuild(block, "prlink.ts", { loader: "ts" })).code;
});

interface HarnessOptions {
  repoUrl?: unknown;
  ok?: boolean;
  throws?: boolean;
  token?: string;
  prSeqs?: number[];
}

function harness(options: HarnessOptions = {}) {
  const rerendered: number[] = [];
  const asked: string[] = [];
  const store = new Map<number, { kind: string }>(
    (options.prSeqs ?? []).map((seq) => [seq, { kind: "pr" }]),
  );
  store.set(99, { kind: "done" }); // a non-pr row, which must never be redrawn
  const context: Record<string, unknown> = {
    token: options.token ?? "app-token",
    authHeaders: () => ({ Authorization: "Bearer app-token" }),
    store,
    rerender: (seq: number) => void rerendered.push(seq),
    fetch: async (url: string) => {
      asked.push(url);
      if (options.throws) throw new Error("offline");
      const named = Object.prototype.hasOwnProperty.call(options, "repoUrl");
      return {
        ok: options.ok ?? true,
        json: async () => ({ repo_url: named ? options.repoUrl : REPO }),
      };
    },
  };
  runInNewContext(script, context);
  return {
    asked,
    rerendered,
    load: () => (context.loadPrLinkPrefix as () => Promise<void>)(),
    linkable: (url: string) => (context.isSiteRepoLink as (u: string) => boolean)(url),
  };
}

describe("only the configured repository's own addresses become links", () => {
  it("links nothing until the server has said which repository this is", async () => {
    const h = harness();
    expect(h.linkable(`${REPO}/pull/12`)).toBe(false); // closed before the answer
    await h.load();
    expect(h.linkable(`${REPO}/pull/12`)).toBe(true);
  });

  it("asks the authenticated route, once, and only while signed in", async () => {
    const h = harness();
    await h.load();
    expect(h.asked).toEqual(["/api/config"]);
    const out = harness({ token: "" });
    await out.load();
    expect(out.asked).toEqual([]); // signed out: nothing to ask with
  });

  it("refuses every address that is not inside that repository", async () => {
    const h = harness();
    await h.load();
    for (const url of [
      "https://github.com/someone-else/other/pull/1",
      // the neighbour whose name merely starts the same way: the boundary is
      // the separator, not the letters
      `${REPO}-evil/pull/1`,
      "https://github.com.evil.example/AsteroidHunter/webpage/pull/1",
      "https://evil.example/https://github.com/AsteroidHunter/webpage/pull/1",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "",
    ]) {
      expect(h.linkable(url), url).toBe(false);
    }
  });

  it("stays closed when the answer does not arrive or names no repository", async () => {
    for (const options of [
      { ok: false },
      { throws: true },
      { repoUrl: null },
      { repoUrl: "" },
      { repoUrl: 42 },
    ]) {
      const h = harness(options);
      await h.load();
      expect(h.linkable(`${REPO}/pull/12`), JSON.stringify(options)).toBe(false);
    }
  });

  it("redraws the pr bubbles already on screen once the answer lands", async () => {
    const h = harness({ prSeqs: [4, 7] });
    await h.load();
    expect(h.rerendered).toEqual([4, 7]); // and never the done row beside them
    await h.load(); // the same answer twice redraws nothing
    expect(h.rerendered).toEqual([4, 7]);
  });

  it("takes a trailing slash off the configured address before matching", async () => {
    const h = harness({ repoUrl: `${REPO}///` });
    await h.load();
    expect(h.linkable(`${REPO}/pull/12`)).toBe(true);
    expect(h.linkable(`${REPO}-evil/pull/1`)).toBe(false);
  });
});

describe("the bubble asks before it makes a link", () => {
  const renderPr = /function renderPr\(([\s\S]*?)\n}\n/.exec(main)?.[1] ?? "";

  it("makes an anchor only for an address the rule allows", () => {
    expect(renderPr, "renderPr not found").not.toBe("");
    expect(renderPr).toContain("if (url && isSiteRepoLink(url))");
    // one anchor in the whole row, and it is inside that branch
    expect(renderPr.match(/createElement\("a"\)/g)).toHaveLength(1);
    const branch = renderPr.slice(
      renderPr.indexOf("if (url && isSiteRepoLink(url))"),
      renderPr.indexOf("} else if (url) {"),
    );
    expect(branch).toContain('createElement("a")');
  });

  it("shows a refused address as plain text rather than dropping it", () => {
    const plain = renderPr.slice(
      renderPr.indexOf("} else if (url) {"),
      renderPr.indexOf("} else {"),
    );
    expect(plain).toContain('div.append("Opened a PR: ", url)');
    expect(plain).not.toContain("createElement");
    // appended as a text node, never as markup
    expect(plain).not.toContain("innerHTML");
  });
});
