// Pins for the TEMP hold diagnostic (src/hold.ts, bottom block): the state
// machine's trail must name every decision (parks, clock resets, and releases
// with their exact reason) because the device session is reconstructed from
// this trail alone. Pure recorder assertions first; the DOM observers and the
// POST are gated off outside the real shell, so the recorder tests never see
// them — the upload's own staging (defer through gestures, ride idle, land on
// hide) is driven at the bottom through a booted fake shell, the split
// scrolljank.test.ts uses.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUIET_MS, createReplyHold, holdDiagEvents, holdDiagReset } from "../src/hold";

interface Frame {
  seq: number;
}

function harness() {
  const rendered: Frame[] = [];
  const hold = createReplyHold<Frame>((f) => rendered.push(f));
  return { rendered, hold };
}

const names = (): string[] => holdDiagEvents().map((e) => e.ev);
const last = (ev: string) => [...holdDiagEvents()].reverse().find((e) => e.ev === ev);

beforeEach(() => {
  vi.useFakeTimers();
  holdDiagReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("hold diagnostic trail", () => {
  it("records park, clock resets, and a quiet release with its reason", () => {
    const { hold } = harness();
    hold.typed();
    hold.maybeHold(5, { seq: 5 });
    vi.advanceTimersByTime(2000);
    hold.typed(); // clock reset while holding
    vi.advanceTimersByTime(QUIET_MS);
    expect(names()).toEqual(["typed", "held", "typed", "release", "render"]);
    expect(last("held")?.d).toMatchObject({ seq: 5, held: 1 });
    expect(last("typed")?.d).toMatchObject({ held: 1, sinceKey: 2000 });
    expect(last("release")?.d).toMatchObject({ reason: "quiet", held: 1 });
    expect(last("render")?.d).toMatchObject({ seq: 5, route: "hold-release" });
  });

  it("names a send release 'send' and a bypassed frame 'pass'", () => {
    const { hold } = harness();
    hold.typed();
    hold.maybeHold(5, { seq: 5 });
    hold.flush(); // the send path
    expect(last("release")?.d).toMatchObject({ reason: "send", held: 1 });
    hold.maybeHold(6, { seq: 6 }); // clock zeroed by flush: renders via the caller
    expect(last("pass")?.d).toMatchObject({ seq: 6, sinceKey: -1 });
  });

  it("records reset with the count of frames it dropped unrendered", () => {
    const { hold } = harness();
    hold.typed();
    hold.maybeHold(5, { seq: 5 });
    hold.maybeHold(6, { seq: 6 });
    hold.reset();
    expect(last("reset")?.d).toMatchObject({ dropped: 2 });
  });

  it("keeps only the newest events once the ring cap is reached", () => {
    const { hold } = harness();
    for (let i = 0; i < 700; i++) hold.typed();
    expect(holdDiagEvents().length).toBe(600);
    expect(holdDiagEvents()[0].d).toMatchObject({ sinceKey: 0 }); // oldest survivors, not the first keys
  });

  it("changes nothing about hold behavior: held frames still release in order", () => {
    const { rendered, hold } = harness();
    hold.typed();
    hold.maybeHold(9, { seq: 9 });
    hold.maybeHold(5, { seq: 5 });
    vi.advanceTimersByTime(QUIET_MS);
    expect(rendered.map((f) => f.seq)).toEqual([5, 9]);
  });
});

// The upload's staging. The scroll-jank sweep caught the old inline upload as
// the ONE nameable stall in the data — 2.2s of one session's gestures were the
// trail stringifying itself — so the send now waits out the gesture gate
// scrolljank.ts hands down and then rides an idle turn, re-asking the gate
// there because engines grant idle turns in a gesture's between-frame slack.
// Nothing here can lose a record (the payload is always the whole ring), and
// going hidden lands a parked upload at once with keepalive, the
// cacheWrites.flush() rule. Driven through a booted fake shell because the
// stages only exist inside one; timers and idle turns are held by hand.
describe("the trail's upload: never inside a gesture, idle after it, landed on hide", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function boot(idle?: (cb: () => void) => void) {
    vi.resetModules();
    const listeners = new Map<string, ((e: unknown) => void)[]>();
    const doc = {
      visibilityState: "visible",
      getElementById: (id: string) => (id === "app" ? {} : null),
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), fn]);
      },
    };
    vi.stubGlobal("document", doc);
    const posts: { body: string; keepalive: unknown }[] = [];
    vi.stubGlobal("fetch", (_url: unknown, init: { body: string; keepalive?: boolean }) => {
      posts.push({ body: init.body, keepalive: init.keepalive });
      return Promise.resolve({ ok: true });
    });
    if (idle) vi.stubGlobal("requestIdleCallback", idle);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const hold = await import("../src/hold");
    return { hold, doc, listeners, posts };
  }

  const hide = (
    doc: { visibilityState: string },
    listeners: Map<string, ((e: unknown) => void)[]>,
  ): void => {
    doc.visibilityState = "hidden";
    for (const fn of listeners.get("visibilitychange") ?? []) fn({});
  };

  it("with no gesture on, the settle alone still posts — the old cadence holds", async () => {
    const { hold, posts } = await boot();
    hold.holdDiagRecord("release", { reason: "quiet", held: 0 });
    vi.advanceTimersByTime(601); // no requestIdleCallback here: the macrotask fallback
    expect(posts).toHaveLength(1);
    expect(posts[0].keepalive).toBe(false); // keepalive is the hide flush's alone
    const payload = JSON.parse(posts[0].body);
    expect(payload.events.some((e: { ev: string }) => e.ev === "release")).toBe(true);
  });

  it("a post armed mid-gesture parks for the whole gesture, then goes once", async () => {
    const { hold, posts } = await boot();
    let live = true;
    hold.holdDiagGesture(() => live);
    hold.holdDiagRecord("release", { reason: "quiet", held: 0 });
    vi.advanceTimersByTime(600); // the settle passes but the gesture is on
    expect(posts).toHaveLength(0);
    vi.advanceTimersByTime(5000); // it keeps parking as long as the gesture lasts
    expect(posts).toHaveLength(0);
    live = false;
    vi.advanceTimersByTime(251); // the next re-ask finds it clear and sends
    expect(posts).toHaveLength(1);
    const payload = JSON.parse(posts[0].body);
    expect(payload.events.some((e: { ev: string }) => e.ev === "release")).toBe(true);
    vi.advanceTimersByTime(5000); // parked once, sent once: no echo afterwards
    expect(posts).toHaveLength(1);
  });

  it("an idle turn granted inside a NEW gesture declines and re-parks", async () => {
    let idleCb: (() => void) | null = null;
    const { hold, posts } = await boot((cb) => {
      idleCb = cb;
    });
    let live = false;
    hold.holdDiagGesture(() => live);
    hold.holdDiagRecord("release", { reason: "quiet", held: 0 });
    vi.advanceTimersByTime(600); // clear at the settle: booked onto the idle queue
    expect(posts).toHaveLength(0);
    live = true; // a gesture rises before the engine grants the turn
    idleCb?.();
    idleCb = null;
    expect(posts).toHaveLength(0); // the turn re-asked the gate and stood down
    live = false;
    vi.advanceTimersByTime(251); // the parking loop it re-armed books a new turn
    expect(posts).toHaveLength(0);
    idleCb?.();
    expect(posts).toHaveLength(1);
  });

  it("going hidden lands a parked upload NOW, keepalive on, the hide mark aboard", async () => {
    const { hold, doc, listeners, posts } = await boot();
    let live = true;
    hold.holdDiagGesture(() => live);
    hold.holdDiagRecord("release", { reason: "quiet", held: 0 });
    vi.advanceTimersByTime(600); // parked behind the gesture
    expect(posts).toHaveLength(0);
    hide(doc, listeners); // mid-gesture, even: blocking matters to nobody now
    expect(posts).toHaveLength(1);
    expect(posts[0].keepalive).toBe(true);
    const events = JSON.parse(posts[0].body).events;
    expect(events.at(-1)).toMatchObject({ ev: "vis", d: { state: "hidden" } });
  });

  it("a hide with nothing parked posts nothing: the flush is a landing, not a beacon", async () => {
    const { hold, doc, listeners, posts } = await boot();
    hold.holdDiagRecord("release", { reason: "quiet", held: 0 });
    vi.advanceTimersByTime(601); // delivered the ordinary way
    expect(posts).toHaveLength(1);
    hide(doc, listeners);
    expect(posts).toHaveLength(1); // nothing owed, nothing sent
  });
});
