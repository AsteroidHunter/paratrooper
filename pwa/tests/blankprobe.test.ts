// Pins for the TEMP blank-thread probe (src/blankprobe.ts).
//
// The probe exists because a blank message area cannot be caught from inside
// the page: script cannot read the compositor, so the only honest instrument is
// one that clears the other two suspects. Everything pinned here follows from
// that. The band arithmetic is held exactly, because vis is the reading the
// whole question turns on and a count that is loose at the edges would let a
// list of collapsed rows read as a healthy one. The lifecycle is held on
// synthetic timestamps, including the pair either side of the repair and the
// give-up that ships a run nobody ever came back to. And the probe's own
// weight is held by source: it may read, since geometry is the question, but it
// may not write, and its walk may not wander.
//
// The wiring pins follow the split scrolljank.test.ts and flight.test.ts use
// for code that boots a real shell at import time.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BLANK_ARM_MS,
  BLANK_MOMENTS,
  BLANK_OFFSETS,
  BLANK_WAIT_MS,
  ROW_SCAN_CAP,
  bandRead,
  blankFrame,
  createBlankProbe,
} from "../src/blankprobe";
import type { BlankCounts, BlankFrame, BlankReader, RowBox } from "../src/blankprobe";

const probeSrc = readFileSync(new URL("../src/blankprobe.ts", import.meta.url), "utf8");
const mainSrc = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const holdSrc = readFileSync(new URL("../src/hold.ts", import.meta.url), "utf8");

// a conversation as the reader sees it: a 700px band with nine rows in it and
// twenty-eight above, which is the shape the failing gesture was reported in
const BAND_TOP = 100;
const BAND_BOTTOM = 800;

function rowsAt(tops: number[], height = 44): RowBox[] {
  return tops.map((top) => ({ top, bottom: top + height }));
}

function reader(over: Partial<BlankReader> = {}): BlankReader {
  return {
    sh: () => 4329,
    st: () => 2180,
    ch: () => 700,
    band: () => ({
      top: BAND_TOP,
      bottom: BAND_BOTTOM,
      rows: rowsAt([-200, -100, 120, 200, 280]),
      scan: 12,
      cap: false,
    }),
    kids: () => 168,
    pend: () => ({ h: 76, d: "flex" }),
    anims: () => ({ app: 0, thr: 0 }),
    classes: () => ({ app: "kb", thr: "dragging" }),
    peek: () => "0px",
    follow: () => false,
    ...over,
  };
}

const counts: BlankCounts = { sc: 3, set: 24, setMoved: 0 };

describe("the band: which rows are standing where the reader is looking", () => {
  it("counts only rows overlapping the band, and names the first and the last", () => {
    const seen = bandRead(rowsAt([-200, -100, 120, 400, 900]), BAND_TOP, BAND_BOTTOM);
    expect(seen.vis).toBe(2); // 120 and 400; -100 ends at -56, 900 starts past the foot
    expect(seen.top1).toBe(20); // relative to the band's own top, not the screen's
    expect(seen.botN).toBe(344);
    expect(seen.h1).toBe(44);
  });

  it("a row straddling the top edge counts: part of it is on screen", () => {
    expect(bandRead(rowsAt([BAND_TOP - 20]), BAND_TOP, BAND_BOTTOM).vis).toBe(1);
  });

  it("a row straddling the foot counts for the same reason", () => {
    expect(bandRead(rowsAt([BAND_BOTTOM - 4]), BAND_TOP, BAND_BOTTOM).vis).toBe(1);
  });

  it("a row resting exactly on either edge is not visible", () => {
    expect(bandRead(rowsAt([BAND_TOP - 44]), BAND_TOP, BAND_BOTTOM).vis).toBe(0);
    expect(bandRead(rowsAt([BAND_BOTTOM]), BAND_TOP, BAND_BOTTOM).vis).toBe(0);
  });

  it("a row collapsed to no height is not visible wherever it sits", () => {
    // the reading this field must never give: a thread whose rows had collapsed
    // would still have every one of them at a plausible offset, and counting
    // those would report a healthy conversation for the very screen in question
    expect(bandRead(rowsAt([300], 0), BAND_TOP, BAND_BOTTOM).vis).toBe(0);
    expect(bandRead(rowsAt([120, 300, 500], 0), BAND_TOP, BAND_BOTTOM)).toEqual({
      vis: 0, top1: null, botN: null, h1: null,
    });
  });

  it("no rows at all reports nothing rather than a zero anyone could misread", () => {
    expect(bandRead([], BAND_TOP, BAND_BOTTOM)).toEqual({
      vis: 0, top1: null, botN: null, h1: null,
    });
  });
});

describe("one reading: exactly its fields, rounded, off the injected reader", () => {
  it("carries the geometry, the band, the strip, the animations and the counters", () => {
    const f = blankFrame("beat", 401.4, reader(), counts);
    expect(f).toEqual({
      w: "beat",
      ms: 401,
      st: 2180,
      sh: 4329,
      ch: 700,
      over: 0,
      kids: 168,
      rows: 5,
      vis: 3,
      top1: 20,
      botN: 224,
      h1: 44,
      scan: 12,
      cap: false,
      pendH: 76,
      pendD: "flex",
      anA: 0,
      anT: 0,
      app: "kb",
      thr: "dragging",
      peek: "0px",
      ft: false,
      sc: 3,
      set: 24,
      setMoved: 0,
    });
  });

  it("overhang is the scroll past the end of its own range, never negative", () => {
    const past = blankFrame("beat", 0, reader({ st: () => 4000 }), counts);
    expect(past.over).toBe(371); // 4000 against a 4329 content in a 700 box
    expect(blankFrame("beat", 0, reader({ st: () => 10 }), counts).over).toBe(0);
  });

  it("a conversation shorter than its box reports no overhang from the arithmetic", () => {
    const short = reader({ sh: () => 400, st: () => 0, ch: () => 700 });
    expect(blankFrame("tap", 0, short, counts).over).toBe(0);
  });
});

describe("the run: armed on a live glide, seven moments, the pair, the give-up", () => {
  const live = (r: BlankReader = reader()) => createBlankProbe(() => r);

  it("a cancel with the conversation standing still arms nothing at all", () => {
    const p = live();
    expect(p.tap(1000, BLANK_ARM_MS + 1)).toBe(false);
    expect(p.live()).toBe(false);
    p.frame(1016);
    expect(p.poll(20_000)).toBeNull();
  });

  it("a scroll inside the arming window opens a run and takes the before-picture", () => {
    const p = live();
    expect(p.tap(1000, BLANK_ARM_MS)).toBe(true);
    expect(p.live()).toBe(true);
  });

  it("a run with no shell to read refuses rather than opening on nothing", () => {
    const p = createBlankProbe(() => null);
    expect(p.tap(1000, 10)).toBe(false);
    expect(p.live()).toBe(false);
  });

  it("a second cancel inside an open run belongs to the run already running", () => {
    const p = live();
    p.tap(1000, 10);
    expect(p.tap(1100, 10)).toBe(false);
  });

  it("the moments land in order, each once, at its own offset", () => {
    const p = live();
    p.tap(1000, 10);
    p.frame(1016); // the frame after the tap
    p.frame(1033);
    p.frame(1140); // past 130
    p.frame(1300);
    p.frame(1405); // past 400
    p.frame(1710); // past 700
    p.scrolled(3000); // the repair's first half
    p.frame(3016); // and its second
    const rec = p.poll(3020) as { f: BlankFrame[]; paired: boolean; n: number };
    expect(rec.f.map((f) => f.w)).toEqual([...BLANK_MOMENTS]);
    expect(rec.f.map((f) => f.ms)).toEqual([0, 16, 140, 405, 710, 2000, 2016]);
    expect(rec.paired).toBe(true);
    expect(rec.n).toBe(1);
  });

  it("the repair is refused until the beat is fully past, so a mid-beat scroll is not it", () => {
    const p = live();
    p.tap(1000, 10);
    p.frame(1016);
    p.scrolled(1100); // momentum still running: counted, but not the repair
    p.frame(1140);
    p.scrolled(1200);
    p.frame(1405);
    const early = p.poll(1500);
    expect(early).toBeNull();
    p.frame(1710); // rest: now the beat is behind us
    p.touched(2000);
    p.frame(2016);
    const rec = p.poll(2020) as { f: BlankFrame[] };
    expect(rec.f.map((f) => f.w)).toEqual([...BLANK_MOMENTS]);
    expect(rec.f[5].ms).toBe(1000); // the touch, not either of the two scrolls
  });

  it("a finger and a scroll are the same repair; whichever lands first owns it", () => {
    const p = live();
    p.tap(1000, 10);
    for (const at of [1016, 1140, 1405, 1710]) p.frame(at);
    p.touched(2000);
    p.scrolled(2004); // the scroll the finger caused must not take it a second time
    p.frame(2016);
    const rec = p.poll(2020) as { f: BlankFrame[] };
    expect(rec.f.filter((f) => f.w === "touch")).toHaveLength(1);
    expect(rec.f.filter((f) => f.w === "after")).toHaveLength(1);
  });

  it("a run nobody comes back to gives up and ships what it has, saying so", () => {
    const p = live();
    p.tap(1000, 10);
    for (const at of [1016, 1140, 1405, 1710]) p.frame(at);
    expect(p.poll(1000 + BLANK_WAIT_MS)).toBeNull();
    const rec = p.poll(1000 + BLANK_WAIT_MS + 1) as { f: BlankFrame[]; paired: boolean };
    expect(rec.paired).toBe(false);
    expect(rec.f.map((f) => f.w)).toEqual(["tap", "frame", "mid", "beat", "rest"]);
  });

  it("the record ships exactly once, and the next armed cancel numbers itself", () => {
    const p = live();
    p.tap(1000, 10);
    for (const at of [1016, 1140, 1405, 1710]) p.frame(at);
    p.touched(2000);
    p.frame(2016);
    expect(p.poll(2020)).not.toBeNull();
    expect(p.live()).toBe(false);
    expect(p.poll(2100)).toBeNull();
    p.tap(9000, 10);
    for (const at of [9016, 9140, 9405, 9710]) p.frame(at);
    p.touched(9900);
    p.frame(9916);
    expect((p.poll(9920) as { n: number }).n).toBe(2);
  });

  it("the counters belong to the run: scrolls seen, settles run, and which moved", () => {
    const p = live();
    p.settled(true); // before the tap: not this run's business
    p.tap(1000, 10);
    for (let i = 0; i < 24; i += 1) p.settled(i === 7);
    p.scrolled(1050);
    p.scrolled(1100);
    p.frame(1016);
    const rec = p.poll(1020);
    expect(rec).toBeNull();
    p.frame(1140);
    p.frame(1405);
    p.frame(1710);
    p.touched(2000);
    p.frame(2016);
    const out = p.poll(2020) as { f: BlankFrame[] };
    const last = out.f[out.f.length - 1];
    expect(last.set).toBe(24);
    expect(last.setMoved).toBe(1);
    expect(last.sc).toBe(2);
  });

  it("a slow frame that crosses two offsets at once still takes both readings", () => {
    // the phone stalling is the weather this probe works in: a run must not
    // lose a moment because one callback was late enough to cover two
    const p = live();
    p.tap(1000, 10);
    p.frame(1016);
    p.frame(1800); // past 130, 400 and 700 in a single callback
    p.touched(2000);
    p.frame(2016);
    const rec = p.poll(2020) as { f: BlankFrame[] };
    expect(rec.f.map((f) => f.w)).toEqual([...BLANK_MOMENTS]);
    expect(rec.f.slice(2, 5).every((f) => f.ms === 800)).toBe(true);
  });

  it("the scheduled offsets are the three the banner names, in order", () => {
    expect([...BLANK_OFFSETS]).toEqual([130, 400, 700]);
    expect(BLANK_OFFSETS.length).toBe(BLANK_MOMENTS.length - 4); // tap, frame, touch, after
  });
});

describe("the probe's own weight, pinned by source", () => {
  const WRITES =
    /\.style\.|setProperty|classList|setAttribute|removeAttribute|innerHTML|textContent\s*=|appendChild|insertBefore|replaceChild|\.remove\(|scrollTo\(|scrollTop\s*=[^=]|\.animate\(|\.focus\(|\.blur\(/;

  it("it reads and never writes: no style, no class, no node, no scroll", () => {
    expect(probeSrc).not.toMatch(WRITES);
  });

  it("it can never cancel, delay or reorder the gesture it watches", () => {
    expect(probeSrc).not.toMatch(/preventDefault|stopPropagation/);
    const opts = probeSrc.match(/\{ capture: true, passive: true \}/g) ?? [];
    expect(opts).toHaveLength(2); // scroll and touchstart, both passive capture
  });

  it("the row walk is bounded at both ends: a cap, and a stop at the foot of the view", () => {
    expect(ROW_SCAN_CAP).toBeGreaterThan(0);
    expect(probeSrc).toContain("if (scan >= ROW_SCAN_CAP)");
    expect(probeSrc).toContain("if (r.top >= bottom)");
    // and a clipped count says so, so it can never be read as a small one
    expect(probeSrc).toContain("cap = true");
  });

  it("one client-rect read per element answers both questions the walk asks", () => {
    // no box means a display:contents grouping or a hidden subtree, and the
    // same call hands back the box when there is one: two reads apiece would
    // double the walk for nothing
    expect(probeSrc).toContain("const rects = el.getClientRects()");
    expect(probeSrc).not.toContain("el.getBoundingClientRect()");
  });

  it("the strip's own numbers are read off the strip, never off the thread", () => {
    expect(probeSrc).toContain("pending.offsetHeight");
  });
});

describe("wiring and call sites, pinned by source across the stamped files", () => {
  it("thread-blank is in hold.ts's post-now list: a run's record posts without waiting", () => {
    expect(holdSrc).toMatch(/ev === "thread-blank"/);
  });

  it("the before-picture is taken before anything on the cancel path changes", () => {
    const click = mainSrc.slice(mainSrc.indexOf('x.addEventListener("click"'));
    const tap = click.indexOf("blankProbeTap(performance.now() - lastScrollAt)");
    const splice = click.indexOf("pendingFiles.splice(at, 1)");
    expect(tap).toBeGreaterThan(-1);
    expect(tap).toBeLessThan(splice);
  });

  it("the settle counter is bumped from the one settle, and reads nothing", () => {
    expect(mainSrc).toContain("blankProbeSettle(plan.moved)");
  });

  it("the follow flag is registered rather than tracked here", () => {
    expect(mainSrc).toContain("blankProbeFollow(() => followTail)");
  });

  it("the banner's TO REMOVE names every file it reaches into, so deleting is reading", () => {
    const note = /TO REMOVE, every call site:[\s\S]*?any of it\./.exec(probeSrc)?.[0] ?? "";
    for (const named of [
      "main.ts",
      "hold.ts",
      "web/app.py",
      "test_holddiag.py",
      "blankprobe.test.ts",
    ]) {
      expect([named, note.includes(named)]).toEqual([named, true]);
    }
  });
});

describe("an armed cancel through the real wiring, with a fake shell under it", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("ships one thread-blank record with the pair either side of the repair", async () => {
    vi.resetModules();

    // a thread holding two grouping wrappers, each with two rows; the second
    // wrapper's rows sit past the foot of the view, so the walk must stop there
    const row = (top: number, height = 44) => ({
      children: [],
      getClientRects: () => [{ top, bottom: top + height }],
    });
    const wrap = (...kids: unknown[]) => ({ children: kids, getClientRects: () => [] });
    const thread = {
      id: "thread",
      className: "thread",
      scrollHeight: 4329,
      scrollTop: 2180,
      clientHeight: 700,
      childElementCount: 168,
      children: [wrap(row(120), row(200)), wrap(row(900), row(980))],
      getBoundingClientRect: () => ({ top: 100, bottom: 800 }),
      getAnimations: () => [],
      closest: (sel: string) => (sel === "#thread" ? thread : null),
    };
    const app = { id: "app", className: "kb", getAnimations: () => [{}] };
    const pending = { id: "pending", offsetHeight: 76 };
    const byId: Record<string, unknown> = { thread, app, pending };

    const listeners = new Map<string, ((e: unknown) => void)[]>();
    const options = new Map<string, unknown>();
    vi.stubGlobal("document", {
      getElementById: (id: string) => byId[id] ?? null,
      addEventListener: (type: string, fn: (e: unknown) => void, opts?: unknown) => {
        listeners.set(type, [...(listeners.get(type) ?? []), fn]);
        options.set(type, opts);
      },
    });
    const rafQueue: (() => void)[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      rafQueue.push(cb);
      return 1;
    });
    vi.stubGlobal("getComputedStyle", () => ({
      display: "flex",
      getPropertyValue: () => "0px",
    }));
    vi.stubGlobal("fetch", () => Promise.resolve({ ok: true }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    let clock = 5000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const tick = (ms: number): void => {
      clock += ms;
      vi.advanceTimersByTime(ms);
    };
    const runFrame = (): void => rafQueue.shift()?.();
    const fire = (type: string, e: unknown): void => {
      for (const fn of listeners.get(type) ?? []) fn(e);
    };

    const hold = await import("../src/hold");
    const probe = await import("../src/blankprobe");
    probe.blankProbeFollow(() => false);

    for (const type of ["scroll", "touchstart"]) {
      expect([type, options.get(type)]).toEqual([type, { capture: true, passive: true }]);
    }

    // a cancel with the glide still running, then the whole beat, then the
    // finger that brings the conversation back
    probe.blankProbeTap(40);
    for (const at of [16, 120, 270, 300]) {
      tick(at);
      runFrame();
      fire("scroll", { target: thread });
    }
    tick(400);
    runFrame(); // rest
    tick(1200);
    fire("touchstart", { target: thread });
    tick(16);
    runFrame();

    const recs = hold.holdDiagEvents().filter((e) => e.ev === "thread-blank");
    expect(recs).toHaveLength(1);
    const d = recs[0].d as { n: number; paired: boolean; f: BlankFrame[] };
    expect(d.n).toBe(1);
    expect(d.paired).toBe(true);
    expect(d.f.map((f) => f.w)).toEqual([...BLANK_MOMENTS]);

    // the reading the whole question turns on, off a real walk: two rows in
    // the band, the two past the foot never looked at, and the wrappers walked
    // through rather than counted
    const tap = d.f[0];
    expect(tap.vis).toBe(2);
    expect(tap.rows).toBe(2);
    expect(tap.top1).toBe(20);
    expect(tap.kids).toBe(168);
    expect(tap.cap).toBe(false);
    // both wrappers, both rows inside the band, and the first row past the foot,
    // which is the one that ended the walk; the row after it is never looked at
    expect(tap.scan).toBe(5);
    expect(tap.st).toBe(2180);
    expect(tap.pendH).toBe(76);
    expect(tap.pendD).toBe("flex");
    expect(tap.anA).toBe(1); // an animation on the shell root is the dangerous one
    expect(tap.anT).toBe(0);
    expect(tap.app).toBe("kb");
    expect(tap.peek).toBe("0px");

    // the pair either side of the touch reads the same, which is the shape that
    // says the repair was a repaint and nothing in the page moved
    const [touch, after] = d.f.slice(5);
    expect(after.vis).toBe(touch.vis);
    expect(after.st).toBe(touch.st);
    expect(after.rows).toBe(touch.rows);

    // the pump ends itself once the run is over
    runFrame();
    expect(rafQueue).toHaveLength(0);
  });

  it("a cancel with the conversation at rest records nothing and holds no frame", async () => {
    vi.resetModules();
    vi.stubGlobal("document", {
      getElementById: (id: string) => (id === "app" ? { id: "app" } : null),
      addEventListener: () => {},
    });
    const rafQueue: (() => void)[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      rafQueue.push(cb);
      return 1;
    });
    vi.stubGlobal("fetch", () => Promise.resolve({ ok: true }));
    vi.useFakeTimers();
    const hold = await import("../src/hold");
    const probe = await import("../src/blankprobe");
    probe.blankProbeTap(BLANK_ARM_MS + 1);
    vi.advanceTimersByTime(BLANK_WAIT_MS + 2000);
    expect(hold.holdDiagEvents().filter((e) => e.ev === "thread-blank")).toHaveLength(0);
    expect(rafQueue).toHaveLength(0);
  });
});
