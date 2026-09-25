// Which deployment shape is answering, and what the phone is allowed to show.
//
// One code base, two deployment shapes. The full one keeps a board and its
// replies can carry a board preview and a pull request with a Publish button;
// the plain one is a chat with photos and web search and produces neither. The
// phone learns which from /api/health, and the difficulty is entirely about
// timing: the cached thread paints BEFORE the socket opens, the health call is
// started from ws.onopen and is not awaited, and a kind with no renderer falls
// back to a text bubble. So the rules pinned here are behavioural, not textual:
//
//   * a confirmed profile is restored before the first cached frame is applied;
//   * without one, the board artifacts are withheld and normal chat still works;
//   * health arriving late reconciles exactly those frames, from the store, with
//     no frame re-ingested and no cursor moved;
//   * a profile that changes (a reconnect to a different deployment shape) is
//     adopted and repainted the same way;
//   * offline keeps the confirmed answer, because it was this deployment's own.
//
// main.ts boots a real shell at import and cannot load under node, so the two
// blocks are cut out by name and run together in one VM context, the way
// prlink.test.ts and logoutbox.test.ts do it. Running them together is the
// point: renderInto here is the real renderInto, calling the real filter.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";
import { transformWithEsbuild } from "vite";
import { SCHEMA_VERSION } from "../src/threadcache";

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

function sourceBetween(start: string, end: string): string {
  const at = main.indexOf(start);
  const until = main.indexOf(end, at + start.length);
  expect(at, `missing ${start}`).toBeGreaterThanOrEqual(0);
  expect(until, `missing ${end}`).toBeGreaterThan(at);
  return main.slice(at, until);
}

let profileBlock = "";
let renderBlock = "";
let healthBlock = "";
let bootBlock = "";
let promptsBlock = "";

// `let profile` and `const PROMPTS` are lexical bindings, so they are invisible
// from outside the script even though the functions beside them are not. The
// probe is appended INSIDE the same script and reads the real bindings through a
// getter, so the tests observe the app's own state rather than a copy of it.
const PROBE = `
globalThis.__probe = {
  get profile() { return profile; },
  kinds: PINBOARD_KINDS,
  key: PROFILE_KEY,
};
`;

beforeAll(async () => {
  const ts = async (code: string, name: string) =>
    (await transformWithEsbuild(code, name, { loader: "ts" })).code;
  profileBlock = await ts(
    sourceBetween(
      "// --- which deployment shape is answering",
      "// finished-reply hold (hold.ts owns the state machine)",
    ),
    "profile.ts",
  );
  renderBlock = await ts(
    sourceBetween("function renderSystemLine(", "function chip("),
    "renderers.ts",
  );
  healthBlock = await ts(
    sourceBetween("async function checkServerVersion(", "// The socket never announces"),
    "health.ts",
  );
  bootBlock = await ts(
    sourceBetween("async function bootFromCache(", "if (token) {"),
    "boot.ts",
  );
  promptsBlock =
    (await ts(sourceBetween("const PROMPTS = [", "const TOKEN_KEY"), "prompts.ts")) +
    "\nglobalThis.__prompts = PROMPTS;\n";
});

// --- the fake DOM the renderers draw into ------------------------------------
// Minimal on purpose (dots.test.ts holds the same trade): the renderers only
// append, set text and read classes, and a real DOM would hide which of those
// each one did.

class FakeEl {
  tag: string;
  className = "";
  textContent = "";
  kids: FakeEl[] = [];
  attrs: Record<string, unknown> = {};
  dataset: Record<string, string> = {};
  disabled = false;
  listeners: string[] = [];
  constructor(tag: string) {
    this.tag = tag;
  }
  appendChild(child: FakeEl): FakeEl {
    this.kids.push(child);
    return child;
  }
  append(...parts: unknown[]): void {
    for (const part of parts) {
      if (part instanceof FakeEl) this.kids.push(part);
      else this.textContent += String(part);
    }
  }
  replaceChildren(): void {
    this.kids = [];
    this.textContent = "";
  }
  addEventListener(name: string): void {
    this.listeners.push(name);
  }
  get childElementCount(): number {
    return this.kids.length;
  }
  get firstElementChild(): FakeEl | null {
    return this.kids[0] ?? null;
  }
  // what the tests read: everything this wrapper drew, flattened
  drawn(): string {
    return [this.textContent, ...this.kids.map((k) => `${k.tag}:${k.className}:${k.drawn()}`)]
      .join("|");
  }
}

interface Frame {
  seq: number;
  kind?: string;
  role?: string;
  payload?: unknown;
  ts?: string;
}

interface HarnessOptions {
  stored?: string | null; // the raw localStorage record, before the boot
  host?: string;
  frames?: Frame[]; // what the cold-open cache holds
  health?: { version?: unknown; profile?: unknown } | "offline";
}

const SHOT = "data:image/png;base64,iVBORw0KGgo=";

// the app's own live state, read through the probe appended to its script
function probe(context: Record<string, unknown>): { profile: string | null; kinds: string[] } {
  return context.__probe as { profile: string | null; kinds: string[] };
}

function harness(options: HarnessOptions = {}) {
  const host = options.host ?? "paratrooper.example";
  const storage = new Map<string, string>();
  if (options.stored != null) storage.set("paratrooper_profile", options.stored);

  const store = new Map<number, Frame>();
  const wrappers = new Map<number, FakeEl>();
  const applied: Frame[] = [];
  const profileAtFirstApply: Array<string | null> = [];
  const rerendered: number[] = [];
  const asked: string[] = [];
  const logged: string[] = [];
  const scrolls: string[] = [];
  const reseats: number[] = [];
  const writes: string[] = [];
  let connected = false;

  // renderInto's collaborators, stubbed to record rather than draw
  const context: Record<string, unknown> = {
    console: { log: (line: string) => logged.push(String(line)) },
    location: { host, protocol: "https:" },
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    },
    JSON,
    store,
    document: {
      createElement: (tag: string) => new FakeEl(tag),
      getElementById: (id: string) => (id === "thread" ? new FakeEl("div") : null),
    },
    atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
    Date,
    performance: { now: () => 0 },
    requestAnimationFrame: (fn: () => void) => void fn(),
    setTimeout,
    // --- renderer collaborators
    rowEl: (wrapper: FakeEl, role: string, kind: string) => {
      const row = new FakeEl("div");
      row.className = `${role} ${kind}`;
      return wrapper.appendChild(row);
    },
    renderUser: (_m: Frame, wrapper: FakeEl) => {
      const row = new FakeEl("div");
      row.className = "user text";
      wrapper.appendChild(row);
    },
    isDuplicateAgentText: () => false,
    followTail: true,
    scrollToBottom: () => void scrolls.push("bottom"),
    // the springs are told when the reconcile corrects the position, so that
    // write is not read as a finger's (profilescroll.test.ts has the interaction)
    springReseat: (dy: number) => void reseats.push(dy),
    // and every app write says so beside itself, announced or not, so a burst
    // of them is never credited to a reader (springown.ts)
    noteSpringAppWrite: () => void writes.push("app"),
    openLightbox: () => {},
    prUrl: (payload: unknown) =>
      typeof payload === "object" && payload !== null
        ? String((payload as { url?: string }).url ?? "")
        : String(payload ?? ""),
    isSiteRepoLink: () => true,
    isPublished: () => false,
    prNumber: () => 1,
    publish: async () => {},
    // --- boot collaborators
    armBootFrameGuard: () => {},
    holdDiagRecord: () => {},
    cacheGet: async () => (options.frames ? { lastSeq: 9, frames: options.frames } : null),
    THREAD_ID: "default",
    CACHE_SCHEMA_VERSION: SCHEMA_VERSION,
    suppressAnim: false,
    lastSeq: 0,
    tailGen: 0,
    scrollGhostWrite: () => {},
    settleLoadingScreen: async () => {},
    noteThreadStart: () => {}, // the older-messages spinner (emptyhistory.test.ts), nothing here
    connect: () => void (connected = true),
    // --- health collaborators
    __BUILT_AT__: "built",
    __SERVER_VERSION__: "abc1234",
    maybeSelfRefresh: () => {},
    fetch: async (url: string) => {
      asked.push(url);
      if (options.health === "offline") throw new Error("offline");
      return { ok: true, json: async () => options.health ?? { version: "abc1234" } };
    },
  };

  // the two paths a frame reaches the screen by, in the shapes main.ts uses
  context.rerender = (seq: number) => {
    rerendered.push(seq);
    const wrapper = wrappers.get(seq);
    const frame = store.get(seq);
    if (!wrapper || !frame) return;
    wrapper.replaceChildren();
    (context.renderInto as (w: FakeEl, m: Frame) => void)(wrapper, frame);
  };
  context.applyEvent = (m: Frame) => {
    profileAtFirstApply.push(probe(context).profile);
    applied.push(m);
    store.set(m.seq, m);
    const wrapper = new FakeEl("div");
    wrapper.dataset.seq = String(m.seq);
    wrappers.set(m.seq, wrapper);
    (context.renderInto as (w: FakeEl, m: Frame) => void)(wrapper, m);
  };

  runInNewContext(
    `${profileBlock}\n${renderBlock}\n${healthBlock}\n${bootBlock}\n${PROBE}`,
    context,
  );

  return {
    context,
    store,
    wrappers,
    applied,
    profileAtFirstApply,
    rerendered,
    asked,
    logged,
    reseats,
    storage,
    connected: () => connected,
    profile: () => probe(context).profile,
    boot: () => (context.bootFromCache as () => Promise<void>)(),
    health: () => (context.checkServerVersion as () => Promise<void>)(),
    apply: (m: Frame) => (context.applyEvent as (m: Frame) => void)(m),
    drawn: (seq: number) => wrappers.get(seq)?.drawn() ?? "",
    empty: (seq: number) => (wrappers.get(seq)?.childElementCount ?? 0) === 0,
  };
}

const confirmed = (p: string, host = "paratrooper.example", extra = {}) =>
  JSON.stringify({ era: 1, host, thread: "default", cacheSchema: SCHEMA_VERSION, profile: p, ...extra });

const reply = (seq: number, text = "sure thing"): Frame => ({ seq, kind: "done", payload: text });
const shot = (seq: number): Frame => ({ seq, kind: "screenshot", payload: SHOT });
const pr = (seq: number): Frame => ({
  seq,
  kind: "pr",
  payload: { branch: "paratrooper/x", url: "https://github.com/o/r/pull/3" },
});

describe("the compose placeholders", () => {
  it("are the nine generic lines, with the one naming the board gone", () => {
    const context: Record<string, unknown> = {};
    runInNewContext(promptsBlock, context);
    const prompts = context.__prompts as string[];
    expect(prompts).toEqual([
      "Dispatch for HQ?",
      "Wire your orders …",
      "Carrier pigeon inbound …",
      "Balloon's up …",
      "Over the top …",
      "Sortie at dawn …",
      "From the trenches …",
      "Drop from the biplane …",
      "Signal the aerodrome …",
    ]);
    expect(prompts).toHaveLength(9);
    for (const line of prompts) expect(line.toLowerCase()).not.toContain("board");
  });
});

describe("a cold open with nothing remembered", () => {
  it("paints the chat and withholds the board artifacts until health answers", async () => {
    const h = harness({ frames: [reply(1), shot(2), pr(3)] });
    await h.boot();

    expect(h.profile()).toBeNull(); // an explicit unknown, not a guess
    expect(h.applied.map((m) => m.seq)).toEqual([1, 2, 3]); // every frame ingested
    expect(h.drawn(1)).toContain("agent text"); // normal chat is unaffected
    expect(h.empty(2)).toBe(true); // no board preview on an unknown deployment
    expect(h.empty(3)).toBe(true); // and no Publish button either
    // the withheld frames are still frames: store and cursor are untouched
    expect([...h.store.keys()]).toEqual([1, 2, 3]);
    expect(h.context.lastSeq).toBe(9);
    expect(h.connected()).toBe(true);
  });

  it("never prints a withheld artifact as a text bubble", async () => {
    // the failure this whole filter exists for: removing a renderer entry alone
    // falls through to renderAgentText, which would paint the data URI
    const h = harness({ frames: [shot(2)] });
    await h.boot();
    expect(h.drawn(2)).not.toContain("iVBORw0KGgo");
    expect(h.drawn(2)).toBe("");
  });
});

describe("health answering after the paint", () => {
  it("pins a PR-only reveal at the tail without waiting for any image load", async () => {
    const h = harness({ frames: [reply(1), pr(2)], health: { profile: "pinboard" } });
    await h.boot();
    const pins: boolean[] = [];
    h.context.scrollToBottom = (force: boolean) => pins.push(force);
    await h.health();
    expect(pins).toEqual([true]);
    expect(h.reseats).toEqual([]); // the shared bottom pin owns that position
    expect(h.applied.map(m => m.seq)).toEqual([1, 2]);
    expect(h.context.suppressAnim).toBe(false);
  });

  it("compensates the total height change above a surviving history row", async () => {
    const h = harness({
      frames: [reply(1), pr(2), shot(3), reply(4)], health: { profile: "pinboard" },
    });
    await h.boot();
    h.context.followTail = false;
    let contentTop = 750;
    const thread = {
      scrollTop: 500,
      getBoundingClientRect: () => ({ top: 100 }),
      querySelectorAll: () => [row],
    };
    const row = {
      parentElement: { dataset: { seq: "4" } },
      isConnected: true,
      getBoundingClientRect: () => ({
        top: contentTop - thread.scrollTop, bottom: contentTop - thread.scrollTop + 40, height: 40,
      }),
    };
    const document = h.context.document as { getElementById: (id: string) => unknown };
    document.getElementById = id => id === "thread" ? thread : null;
    const repaint = h.context.rerender as (seq: number) => void;
    h.context.rerender = (seq: number) => {
      repaint(seq);
      contentTop += seq === 2 ? 70 : 200;
    };
    const before = row.getBoundingClientRect().top;
    await h.health();
    expect(thread.scrollTop).toBe(770);
    expect(row.getBoundingClientRect().top).toBe(before);
    expect(h.reseats).toEqual([270]); // and the springs heard about that write
    expect(h.rerendered).toEqual([2, 3]);
    expect(h.applied).toHaveLength(4);
    expect(h.context.lastSeq).toBe(9);
    expect(h.context.suppressAnim).toBe(false);
  });

  it("reconciles exactly the artifact frames when the answer is pinboard", async () => {
    const h = harness({
      frames: [reply(1), shot(2), pr(3), reply(4)],
      health: { version: "abc1234", profile: "pinboard" },
    });
    await h.boot();
    expect(h.empty(2)).toBe(true);

    await h.health();

    expect(h.profile()).toBe("pinboard");
    expect(h.rerendered).toEqual([2, 3]); // and not the two ordinary replies
    expect(h.drawn(2)).toContain("agent shot");
    expect(h.drawn(3)).toContain("agent pr");
    // nothing was re-ingested and no cursor moved while presentation caught up
    expect(h.applied.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
    expect(h.context.lastSeq).toBe(9);
    expect(h.asked).toEqual(["/api/health"]);
  });

  it("leaves them withheld when the answer is plain, and repaints nothing", async () => {
    const h = harness({
      frames: [reply(1), shot(2), pr(3)],
      health: { version: "abc1234", profile: "plain" },
    });
    await h.boot();
    await h.health();

    expect(h.profile()).toBe("plain");
    expect(h.rerendered).toEqual([]); // already withheld: there is nothing to redraw
    expect(h.empty(2)).toBe(true);
    expect(h.empty(3)).toBe(true);
    expect(h.drawn(1)).toContain("agent text"); // the chat itself is untouched
  });

  it("remembers the answer for the next cold open, scoped to this deployment", async () => {
    const h = harness({ health: { version: "v", profile: "plain" } });
    await h.boot();
    await h.health();
    expect(JSON.parse(h.storage.get("paratrooper_profile") as string)).toEqual({
      era: 1,
      host: "paratrooper.example",
      thread: "default",
      cacheSchema: SCHEMA_VERSION,
      profile: "plain",
    });
  });

  it("treats a missing or unknown profile word as no answer at all", async () => {
    for (const body of [
      { version: "v" },
      { version: "v", profile: null },
      { version: "v", profile: "board" },
      { version: "v", profile: 7 },
      { version: "v", profile: "" },
    ]) {
      const h = harness({ frames: [shot(2)], health: body });
      await h.boot();
      await h.health();
      expect(h.profile(), JSON.stringify(body)).toBeNull();
      expect(h.empty(2), JSON.stringify(body)).toBe(true);
      expect(h.storage.has("paratrooper_profile")).toBe(false);
    }
  });

  it("says which profile it is talking to in the one boot log line", async () => {
    const h = harness({ health: { version: "abc1234", profile: "plain" } });
    await h.boot();
    await h.health();
    expect(h.logged.join(" ")).toContain("profile plain");

    const unknown = harness({ health: { version: "abc1234" } });
    await unknown.boot();
    await unknown.health();
    expect(unknown.logged.join(" ")).toContain("profile unknown");
  });
});

describe("a cold open with the profile already confirmed", () => {
  it("paints the board artifacts in the first pass, before any network", async () => {
    const h = harness({ stored: confirmed("pinboard"), frames: [reply(1), shot(2), pr(3)] });
    await h.boot();

    expect(h.profile()).toBe("pinboard");
    // the point: the profile was already in hand when the FIRST frame was applied
    expect(h.profileAtFirstApply).toEqual(["pinboard", "pinboard", "pinboard"]);
    expect(h.drawn(2)).toContain("agent shot");
    expect(h.drawn(3)).toContain("agent pr");
    expect(h.rerendered).toEqual([]); // one paint, no repaint
    expect(h.asked).toEqual([]); // and nothing was asked to get there
  });

  it("keeps that answer when health cannot be reached", async () => {
    const h = harness({
      stored: confirmed("pinboard"),
      frames: [shot(2)],
      health: "offline",
    });
    await h.boot();
    await h.health();

    expect(h.profile()).toBe("pinboard"); // this deployment's own earlier answer
    expect(h.drawn(2)).toContain("agent shot");
    expect(h.rerendered).toEqual([]);
  });

  it("withholds the artifacts when the remembered plain answer stands offline", async () => {
    const h = harness({ stored: confirmed("plain"), frames: [reply(1), shot(2)], health: "offline" });
    await h.boot();
    await h.health();
    expect(h.profile()).toBe("plain");
    expect(h.drawn(1)).toContain("agent text"); // offline chat still reads normally
    expect(h.empty(2)).toBe(true);
  });

  it("ignores a record from another host, another era, or another shape", async () => {
    for (const stored of [
      confirmed("pinboard", "someone-else.example"),
      confirmed("pinboard", "paratrooper.example", { thread: "another-thread" }),
      confirmed("pinboard", "paratrooper.example", { cacheSchema: SCHEMA_VERSION - 1 }),
      confirmed("pinboard", "paratrooper.example", { thread: null }),
      JSON.stringify({ era: 1, host: "paratrooper.example", profile: "pinboard" }),
      JSON.stringify({ era: 99, host: "paratrooper.example", profile: "pinboard" }),
      JSON.stringify({ era: 1, host: "paratrooper.example", profile: "board" }),
      JSON.stringify({ era: 1, host: "paratrooper.example" }),
      "not json at all",
      "",
    ]) {
      const h = harness({ stored, frames: [shot(2)] });
      await h.boot();
      expect(h.profile(), stored).toBeNull();
      expect(h.empty(2), stored).toBe(true);
    }
  });
});

describe("the profile changing under a running app", () => {
  it("takes the artifacts away when a reconnect says plain", async () => {
    const h = harness({
      stored: confirmed("pinboard"),
      frames: [reply(1), shot(2), pr(3)],
      health: { version: "abc1234", profile: "plain" },
    });
    await h.boot();
    expect(h.drawn(2)).toContain("agent shot");

    await h.health(); // every (re)connect re-checks health

    expect(h.profile()).toBe("plain");
    expect(h.rerendered).toEqual([2, 3]);
    expect(h.empty(2)).toBe(true);
    expect(h.empty(3)).toBe(true);
    expect(h.drawn(1)).toContain("agent text");
    expect(JSON.parse(h.storage.get("paratrooper_profile") as string).profile).toBe("plain");
  });

  it("repaints nothing when a reconnect repeats the answer it already had", async () => {
    const h = harness({
      stored: confirmed("pinboard"),
      frames: [shot(2), pr(3)],
      health: { version: "abc1234", profile: "pinboard" },
    });
    await h.boot();
    await h.health();
    await h.health();
    expect(h.rerendered).toEqual([]);
    expect(h.drawn(2)).toContain("agent shot");
  });

  it("draws a live artifact correctly once the profile is known", async () => {
    const h = harness({ health: { version: "abc1234", profile: "pinboard" } });
    await h.boot();
    await h.health();
    h.apply(shot(11)); // arriving live, after the answer
    expect(h.drawn(11)).toContain("agent shot");

    const plain = harness({ health: { version: "abc1234", profile: "plain" } });
    await plain.boot();
    await plain.health();
    plain.apply(shot(12));
    expect(plain.empty(12)).toBe(true);
    plain.apply(reply(13, "found it"));
    expect(plain.drawn(13)).toContain("agent text");
  });
});
