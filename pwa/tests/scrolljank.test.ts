// Pins for the TEMP scroll-jank recorder (src/scrolljank.ts, src/jankledger.ts).
// What matters about this probe is the promise it was built on: clock-only
// inside scroll windows. It times the thread's scrolling with two independent
// cadences and names what ran inside the long frames, and it must be incapable
// of adding the delay it measures, so the pins here hold three things: the
// pure window machine's whole lifecycle on synthetic timestamps, the
// attribution math against injected ledgers and longtask entries, and the
// clock-only property itself, by source scan and by a spy-wrapped simulated
// gesture driven through the real wiring. The wiring pins follow the split
// flight.test.ts and shelldiag.test.ts use for code that boots a real shell.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INPUT_LINK_MS,
  LONG_GAP_MS,
  SCROLL_QUIET_MS,
  WORST_GAPS,
  createJankMachine,
} from "../src/scrolljank";
import type { JankGap } from "../src/scrolljank";
import { JANK_STAMP_KEEP, jankLedgerReset, jankSpan, jankStamps } from "../src/jankledger";
import type { JankStamp } from "../src/jankledger";

const jankSrc = readFileSync(new URL("../src/scrolljank.ts", import.meta.url), "utf8");
const ledgerSrc = readFileSync(new URL("../src/jankledger.ts", import.meta.url), "utf8");
const holdSrc = readFileSync(new URL("../src/hold.ts", import.meta.url), "utf8");
const shellSrc = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
const mainSrc = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const cacheSrc = readFileSync(new URL("../src/threadcache.ts", import.meta.url), "utf8");

// a machine over an injected ledger; empty by default so no test leaks stamps
const machineWith = (stamps: JankStamp[] = []) => createJankMachine(() => stamps);

type Rec = {
  n: number;
  t0: number;
  dur: number;
  raf: number;
  sc: number;
  long: number;
  stallN: number;
  stallMs: number;
  ltSup: number;
  ltMs: number;
  worst: JankGap[];
};

describe("window lifecycle: opens on input that scrolls, extends, closes on quiet", () => {
  it("a tap that never scrolls ships nothing, and a scroll after it stays out", () => {
    const m = machineWith();
    m.touchDown(0);
    m.touchUp();
    expect(m.active()).toBe(true); // armed, tentatively
    expect(m.poll(INPUT_LINK_MS + 1)).toBeNull();
    expect(m.active()).toBe(false); // the tap expired unconfirmed
    m.scroll(INPUT_LINK_MS + 100); // programmatic move with no fresh input
    expect(m.active()).toBe(false);
    expect(m.poll(INPUT_LINK_MS + 3000)).toBeNull();
  });

  it("touch then scroll opens at the touch and closes one quiet second after the last scroll", () => {
    const m = machineWith();
    m.touchDown(1000);
    m.scroll(1100);
    m.scroll(1150);
    m.touchUp();
    expect(m.poll(1150 + SCROLL_QUIET_MS - 1)).toBeNull();
    const rec = m.poll(1150 + SCROLL_QUIET_MS) as Rec;
    expect(rec).not.toBeNull();
    expect(rec.n).toBe(1);
    expect(rec.t0).toBe(1000); // the window starts at the INPUT, not the first scroll
    expect(rec.dur).toBe(150);
    expect(rec.sc).toBe(2);
    expect(m.active()).toBe(false);
  });

  it("wheel arms a window exactly like a touch does", () => {
    const m = machineWith();
    m.wheel(0);
    m.scroll(20);
    const rec = m.poll(20 + SCROLL_QUIET_MS) as Rec;
    expect(rec.t0).toBe(0);
    expect(rec.sc).toBe(1);
  });

  it("a scroll with no input behind it opens nothing: pins and heals stay out", () => {
    const m = machineWith();
    m.scroll(500);
    m.scroll(600);
    expect(m.active()).toBe(false);
    expect(m.poll(5000)).toBeNull();
  });

  it("momentum extends the window well past the input link horizon", () => {
    const m = machineWith();
    m.wheel(0);
    for (let t = 100; t <= 3000; t += 100) m.scroll(t); // far past INPUT_LINK_MS
    expect(m.poll(3000 + SCROLL_QUIET_MS - 1)).toBeNull();
    const rec = m.poll(3000 + SCROLL_QUIET_MS) as Rec;
    expect(rec.dur).toBe(3000);
    expect(rec.n).toBe(1); // one gesture, however long it glides
  });

  it("overlapping input extends the window: a finger down defers the close", () => {
    const m = machineWith();
    m.touchDown(0);
    m.scroll(50);
    m.touchUp();
    m.scroll(300); // momentum
    m.touchDown(600); // caught mid-glide: the same window
    expect(m.poll(1400)).toBeNull(); // quiet has passed, but the finger is down
    m.scroll(700);
    m.touchUp();
    expect(m.poll(700 + SCROLL_QUIET_MS - 1)).toBeNull();
    const rec = m.poll(700 + SCROLL_QUIET_MS) as Rec;
    expect(rec.n).toBe(1);
    expect(rec.dur).toBe(700);
    expect(rec.sc).toBe(3);
  });

  it("a resting finger keeps the tentative arm alive until it lifts", () => {
    const m = machineWith();
    m.touchDown(0);
    expect(m.poll(INPUT_LINK_MS + 2000)).toBeNull();
    expect(m.active()).toBe(true); // held down: still waiting for the drag
    m.scroll(4000);
    m.touchUp();
    const rec = m.poll(4000 + SCROLL_QUIET_MS) as Rec;
    expect(rec.t0).toBe(0);
    expect(rec.dur).toBe(4000);
  });

  it("the record ships exactly once, and the next gesture numbers itself", () => {
    const m = machineWith();
    m.wheel(0);
    m.scroll(10);
    expect(m.poll(10 + SCROLL_QUIET_MS)).not.toBeNull();
    expect(m.poll(10 + SCROLL_QUIET_MS + 1)).toBeNull();
    m.wheel(5000);
    m.scroll(5010);
    m.scroll(5040);
    const rec = m.poll(5040 + SCROLL_QUIET_MS) as Rec;
    expect(rec.n).toBe(2);
    expect(rec.sc).toBe(2); // its own counters, not the first gesture's
  });
});

describe("long gaps: over the threshold on either clock, streamed then kept worst-first", () => {
  it("a clean cadence flags nothing on either clock", () => {
    const m = machineWith();
    m.wheel(0);
    m.scroll(10);
    for (let i = 1; i <= 20; i += 1) {
      m.frame(10 + i * 16.7);
      m.scroll(10 + i * 33);
    }
    const rec = m.poll(10 + 20 * 33 + SCROLL_QUIET_MS) as Rec;
    expect(rec.long).toBe(0);
    expect(rec.worst).toEqual([]);
    expect(rec.raf).toBe(20);
    expect(rec.sc).toBe(21);
  });

  it("a frame gap lands with its length, its clock, and where it began", () => {
    const m = machineWith();
    m.wheel(0);
    m.scroll(10);
    m.frame(20);
    m.frame(36);
    m.frame(156); // 120ms without a frame
    const rec = m.poll(10 + SCROLL_QUIET_MS) as Rec;
    expect(rec.long).toBe(1);
    expect(rec.worst).toEqual([{ ms: 120, at: 36, clock: "raf" }]);
    expect("led" in rec.worst[0]).toBe(false); // nothing overlapped: no empty fields
    expect("lt" in rec.worst[0]).toBe(false);
  });

  it("exactly the threshold is not long; just over it is", () => {
    const m = machineWith();
    m.wheel(0);
    m.scroll(10);
    m.frame(100);
    m.frame(100 + LONG_GAP_MS); // exactly 34: two clean 60fps frames
    m.frame(100 + LONG_GAP_MS + 35); // 35 over nothing: long
    const rec = m.poll(10 + SCROLL_QUIET_MS) as Rec;
    expect(rec.long).toBe(1);
    expect(rec.worst[0].ms).toBe(35);
  });

  it("scroll-event gaps carry the sc clock", () => {
    const m = machineWith();
    m.wheel(0);
    m.scroll(10);
    m.scroll(40);
    m.scroll(240); // 200ms without a scroll event mid-gesture
    m.scroll(270);
    const rec = m.poll(270 + SCROLL_QUIET_MS) as Rec;
    expect(rec.long).toBe(1);
    expect(rec.worst[0]).toMatchObject({ ms: 200, at: 40, clock: "sc" });
  });

  it("a stall between the input and the first scroll is caught: the window opens at the touch", () => {
    // the shape the prime suspect would leave: work inside the first
    // touchstart after a keyboard close stalls frames BEFORE scrolling starts
    const m = machineWith();
    m.touchDown(0);
    m.frame(10);
    m.frame(140); // 130ms stalled under the finger, no scroll yet
    m.scroll(150);
    m.touchUp();
    const rec = m.poll(150 + SCROLL_QUIET_MS) as Rec;
    expect(rec.long).toBe(1);
    expect(rec.worst[0]).toMatchObject({ ms: 130, at: 10, clock: "raf" });
  });

  it("worst keeps ten biggest-first while long counts every one", () => {
    const m = machineWith();
    m.wheel(0);
    let t = 5;
    m.scroll(t);
    for (let i = 0; i < 14; i += 1) {
      t += 40 + i; // gaps 40..53, every one long
      m.scroll(t);
    }
    const rec = m.poll(t + SCROLL_QUIET_MS) as Rec;
    expect(rec.long).toBe(14);
    expect(rec.worst).toHaveLength(WORST_GAPS);
    expect(rec.worst[0].ms).toBe(53);
    expect(rec.worst[9].ms).toBe(44);
    const sizes = rec.worst.map((g) => g.ms);
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
    // the totals outlive keep-worst: all fourteen gaps' time, not the ten kept
    expect(rec.stallN).toBe(14);
    expect(rec.stallMs).toBe(651); // 40+41+..+53
  });

  it("a stall both clocks expose totals once, however many gaps it wrote", () => {
    const m = machineWith();
    m.wheel(0);
    m.scroll(10);
    m.frame(20);
    m.frame(150); // the raf clock exposes 20..150
    m.scroll(150); // and the sc clock exposes 10..150 of the same stall
    const rec = m.poll(150 + SCROLL_QUIET_MS) as Rec;
    expect(rec.long).toBe(2); // counted per clock, as ever
    expect(rec.stallN).toBe(1); // but it was ONE stall
    expect(rec.stallMs).toBe(130); // its time counted once, not summed twice
  });

  it("a second stall past the first counts and totals separately", () => {
    const m = machineWith();
    m.wheel(0);
    m.scroll(10);
    m.frame(20);
    m.frame(100); // 80ms
    m.frame(116);
    m.frame(216); // 100ms, clear of the first
    const rec = m.poll(10 + SCROLL_QUIET_MS) as Rec;
    expect(rec.stallN).toBe(2);
    expect(rec.stallMs).toBe(180);
  });

  it("a stall in the settle second after the last scroll still counts, marked past dur", () => {
    // jank right after the gesture is signal, not noise: glide-boundary work
    // lands exactly there, and at past dur names the stall a settle one
    const m = machineWith();
    m.wheel(0);
    m.scroll(10);
    m.scroll(20);
    m.frame(30);
    m.frame(500); // 470ms stalled while the thread comes to rest
    const rec = m.poll(20 + SCROLL_QUIET_MS) as Rec;
    expect(rec.dur).toBe(20);
    expect(rec.long).toBe(1);
    expect(rec.worst[0].ms).toBe(470);
    expect(rec.worst[0].at).toBeGreaterThan(rec.dur);
  });
});

describe("attribution: ledger spans and longtask entries, matched at close", () => {
  it("a ledger span overlapping a worst gap names itself on it", () => {
    const m = machineWith([{ name: "slack-read", start: 100, end: 180 }]);
    m.wheel(0);
    m.scroll(10);
    m.frame(20);
    m.frame(150); // the gap spans 20..150; the span sits inside it
    const rec = m.poll(10 + SCROLL_QUIET_MS) as Rec;
    expect(rec.worst[0].led).toEqual(["slack-read"]);
  });

  it("a span outside the gap stays off it", () => {
    const m = machineWith([{ name: "cache-put", start: 400, end: 500 }]);
    m.wheel(0);
    m.scroll(10);
    m.frame(20);
    m.frame(150);
    const rec = m.poll(10 + SCROLL_QUIET_MS) as Rec;
    expect("led" in rec.worst[0]).toBe(false);
  });

  it("a span that only touches the gap's edge does not count as inside it", () => {
    const m = machineWith([
      { name: "before", start: 0, end: 20 }, // ends exactly where the gap begins
      { name: "after", start: 150, end: 200 }, // begins exactly where it ends
    ]);
    m.wheel(0);
    m.scroll(10);
    m.frame(20);
    m.frame(150);
    const rec = m.poll(10 + SCROLL_QUIET_MS) as Rec;
    expect("led" in rec.worst[0]).toBe(false);
  });

  it("two spans of one name land once: names, not a span list", () => {
    const m = machineWith([
      { name: "slack-read", start: 30, end: 60 },
      { name: "slack-read", start: 80, end: 120 },
      { name: "diag-post", start: 100, end: 140 },
    ]);
    m.wheel(0);
    m.scroll(10);
    m.frame(20);
    m.frame(150);
    const rec = m.poll(10 + SCROLL_QUIET_MS) as Rec;
    expect(rec.worst[0].led).toEqual(["slack-read", "diag-post"]);
  });

  it("longtask ms are clipped to the gap and to the window", () => {
    const m = machineWith();
    m.longtask(100, 100); // 100..200: half inside the 20..150 gap
    m.wheel(0);
    m.scroll(10);
    m.frame(20);
    m.frame(150);
    const rec = m.poll(10 + SCROLL_QUIET_MS) as Rec;
    expect(rec.worst[0].lt).toBe(50);
    expect(rec.ltMs).toBe(100); // the whole task sits inside the window
  });

  it("longtask entries from before the window contribute nothing", () => {
    const m = machineWith();
    m.longtask(-500, 100);
    m.wheel(0);
    m.scroll(10);
    const rec = m.poll(10 + SCROLL_QUIET_MS) as Rec;
    expect(rec.ltMs).toBe(0);
  });

  it("ltSup says whether an ltMs of zero was innocence or blindness", () => {
    // the field the phone data forced: every device record read ltMs 0, and
    // nothing said whether the gestures were clean or the engine simply has no
    // longtask type (it has none — the wiring's catch ate the difference)
    const blind = machineWith();
    blind.wheel(0);
    blind.scroll(10);
    expect((blind.poll(10 + SCROLL_QUIET_MS) as Rec).ltSup).toBe(0);
    const sighted = machineWith();
    sighted.longtaskOn(); // the wiring saw the entry type in supportedEntryTypes
    sighted.wheel(0);
    sighted.scroll(10);
    const rec = sighted.poll(10 + SCROLL_QUIET_MS) as Rec;
    expect(rec.ltSup).toBe(1);
    expect(rec.ltMs).toBe(0); // now an honest zero: it looked and found nothing
  });
});

describe("the record: one per gesture, exactly its fields, rounded", () => {
  it("carries exactly n, t0, dur, raf, sc, long, stallN, stallMs, ltSup, ltMs, worst", () => {
    const m = machineWith();
    m.wheel(0.4);
    m.scroll(10.6);
    m.scroll(30.4);
    const rec = m.poll(30.4 + SCROLL_QUIET_MS) as Rec;
    expect(Object.keys(rec)).toEqual([
      "n", "t0", "dur", "raf", "sc", "long", "stallN", "stallMs", "ltSup", "ltMs", "worst",
    ]);
    expect(rec.t0).toBe(0);
    expect(rec.dur).toBe(30);
    expect(rec.raf).toBe(0);
    expect(rec.sc).toBe(2);
    expect(rec.long).toBe(0);
    // the totals ride EVERY record, a stall-free gesture included: a clean
    // drive must read as zeroes the probe wrote, never as fields it skipped
    expect(rec.stallN).toBe(0);
    expect(rec.stallMs).toBe(0);
    expect(rec.ltSup).toBe(0);
    expect(rec.ltMs).toBe(0);
    expect(rec.worst).toEqual([]);
  });

  it("a worst entry carries ms, at, clock and only earns led and lt", () => {
    const m = machineWith([{ name: "x", start: 30, end: 60 }]);
    m.wheel(0);
    m.scroll(10);
    m.frame(20);
    m.frame(150);
    const rec = m.poll(10 + SCROLL_QUIET_MS) as Rec;
    expect(Object.keys(rec.worst[0])).toEqual(["ms", "at", "clock", "led"]);
  });
});

describe("the activity ledger: a fixed ring of named spans", () => {
  beforeEach(() => {
    jankLedgerReset();
  });

  it("a span records its name and both ends", () => {
    jankSpan("cache-write", 5, 9);
    expect(jankStamps()).toEqual([{ name: "cache-write", start: 5, end: 9 }]);
  });

  it("end defaults to the clock at call time", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(42);
    jankSpan("diag-post", 40);
    now.mockRestore();
    expect(jankStamps()[0]).toEqual({ name: "diag-post", start: 40, end: 42 });
  });

  it("the ring never grows past its cap and keeps the newest spans", () => {
    for (let i = 0; i < JANK_STAMP_KEEP + 6; i += 1) jankSpan(String(i), i, i + 1);
    const names = jankStamps().map((s) => s.name);
    expect(names).toHaveLength(JANK_STAMP_KEEP);
    expect(names).not.toContain("0");
    expect(names).not.toContain("5");
    expect(names).toContain("6");
    expect(names).toContain(String(JANK_STAMP_KEEP + 5));
  });
});

describe("clock-only, pinned by source: the recorder cannot measure its own weather", () => {
  const FORBIDDEN =
    /getBoundingClientRect|getComputedStyle|getClientRects|elementFromPoint|scrollTop|scrollHeight|scrollLeft|scrollWidth|offsetHeight|offsetWidth|offsetTop|offsetLeft|clientHeight|clientWidth|clientTop|clientLeft|innerHeight|innerWidth/;

  it("neither recorder file contains a geometry read of any kind, comments included", () => {
    expect(jankSrc).not.toMatch(FORBIDDEN);
    expect(ledgerSrc).not.toMatch(FORBIDDEN);
  });

  it("every listener is capture-phase and passive: it can never delay the gesture", () => {
    const registrations = jankSrc.match(/addEventListener\(\s*"[a-z]+"/g) ?? [];
    expect(registrations).toHaveLength(5); // touchstart, touchend, touchcancel, wheel, scroll
    const opts = jankSrc.match(/\{ capture: true, passive: true \}/g) ?? [];
    expect(opts.length).toBe(5);
    expect(jankSrc).not.toMatch(/preventDefault|stopPropagation/);
  });

  it("the frame clocks are the callback's own timestamps, never a read inside the frame", () => {
    expect(jankSrc).toMatch(/machine\.frame\(ts\)/);
    expect(jankSrc).toMatch(/machine\.scroll\(e\.timeStamp\)/);
  });
});

describe("wiring and stamps, pinned by source across the stamped files", () => {
  it("scroll-jank is in hold.ts's post-now list: a gesture's record posts without waiting", () => {
    expect(holdSrc).toMatch(/ev === "scroll-jank"/);
  });

  it("the thread-cache write stamps both halves: the snapshot build and the clone", () => {
    expect(mainSrc).toContain('jankSpan("cache-write", jankT0)');
    expect(cacheSrc).toContain('jankSpan("cache-put", jankT0)');
  });

  it("the photo decode's landing work and the trail upload stamp themselves", () => {
    expect(mainSrc).toContain('jankSpan("shot-drawn", jankT0)');
    expect(holdSrc).toContain('jankSpan("diag-post", jankT0)');
  });

  it("every scroll-back suspect stamps itself: the unattributed blocks' short list", () => {
    // the sweep's verdict: 78.5% of sampled block time carried no name, and
    // only stamped paths can earn one — so the paths a scroll back actually
    // runs all stamp now (the history landing, the per-frame decorate fold,
    // the photo queue's release batch, the pixels' landing, the tail settle)
    expect(mainSrc).toContain('jankSpan("drain-older", jankT0)');
    expect(mainSrc).toContain('jankSpan("decorate", jankT0)');
    expect(mainSrc).toContain('jankSpan("photo-release", jankT0)');
    expect(mainSrc).toContain('jankSpan("photo-load", jankT0)');
    expect(mainSrc).toContain('jankSpan("settle-tail", jankT0)');
  });

  it("the wiring hands hold.ts the gesture gate, and reads longtask support honestly", () => {
    // the recorder owns "a gesture is on"; the trail's upload defers on it
    expect(jankSrc).toContain("holdDiagGesture(() => machine.active())");
    // ltSup comes from supportedEntryTypes, not from observe() not throwing
    expect(jankSrc).toMatch(/supportedEntryTypes\?\.includes\("longtask"\)/);
  });

  it("main.ts boots the recorder on import", () => {
    expect(mainSrc).toContain('import "./scrolljank"');
  });

  it("the banner's TO REMOVE names every stamped file, so deleting is reading", () => {
    const note = /TO REMOVE, every call site:[\s\S]*?any of\n\/\/ it\./.exec(jankSrc)?.[0] ?? "";
    for (const named of [
      "jankledger.ts",
      "main.ts",
      "hold.ts",
      "threadcache.ts",
      "web/app.py",
      "test_holddiag.py",
      "scrolljank.test.ts",
    ]) {
      expect([named, note.includes(named)]).toEqual([named, true]);
    }
  });
});

describe("a simulated gesture through the real wiring, geometry spied shut", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("ships one attributed scroll-jank record and never once reads geometry", async () => {
    vi.resetModules();

    // every geometry road leads to this spy; the pin is that it stays at zero
    const geometry = vi.fn();
    const trap = (obj: Record<string, unknown>, props: string[]): void => {
      for (const p of props) {
        Object.defineProperty(obj, p, {
          get: () => {
            geometry(p);
            return 0;
          },
        });
      }
    };
    const thread: Record<string, unknown> = {
      id: "thread",
      closest: (sel: string) => (sel === "#thread" ? thread : null),
      getBoundingClientRect: () => {
        geometry("rect");
        return {};
      },
    };
    trap(thread, ["scrollTop", "scrollHeight", "clientHeight", "offsetHeight", "offsetTop"]);

    const listeners = new Map<string, ((e: unknown) => void)[]>();
    const options = new Map<string, unknown>();
    const fakeDoc = {
      getElementById: (id: string) => (id === "app" ? {} : null),
      addEventListener: (type: string, fn: (e: unknown) => void, opts?: unknown) => {
        listeners.set(type, [...(listeners.get(type) ?? []), fn]);
        options.set(type, opts);
      },
    };
    const rafQueue: ((ts: number) => void)[] = [];
    let observed: ((list: { getEntries(): { startTime: number; duration: number }[] }) => void) |
      null = null;
    vi.stubGlobal("document", fakeDoc);
    // fake ONLY the timer pair: the default set fakes requestAnimationFrame
    // too, marching frames at an ideal 16ms cadence that would paper over the
    // very stall this test stages
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.stubGlobal("requestAnimationFrame", (cb: (ts: number) => void) => {
      rafQueue.push(cb);
      return 1;
    });
    vi.stubGlobal(
      "getComputedStyle",
      (() => {
        geometry("style");
        return {};
      }) as unknown,
    );
    vi.stubGlobal("fetch", () => Promise.resolve({ ok: true }));
    vi.stubGlobal(
      "PerformanceObserver",
      class {
        static supportedEntryTypes = ["longtask"]; // an engine that really has it
        constructor(cb: (list: { getEntries(): { startTime: number; duration: number }[] }) => void) {
          observed = cb;
        }
        observe(): void {}
      },
    );

    let clock = 10_000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const tick = (ms: number): void => {
      clock += ms;
      vi.advanceTimersByTime(ms);
    };
    const fire = (type: string, e: unknown): void => {
      for (const fn of listeners.get(type) ?? []) fn(e);
    };
    const runFrame = (): void => {
      rafQueue.shift()?.(clock);
    };

    const hold = await import("../src/hold");
    const ledger = await import("../src/jankledger");
    await import("../src/scrolljank");

    // the promise the wiring makes: passive capture on all five listeners
    for (const type of ["touchstart", "touchend", "touchcancel", "wheel", "scroll"]) {
      expect([type, options.get(type)]).toEqual([type, { capture: true, passive: true }]);
    }

    // the gesture: a touch, six clean frames with scrolls, then a 120ms stall
    // on BOTH clocks with a ledger span and a longtask inside it
    fire("touchstart", { timeStamp: clock, target: thread });
    for (let i = 0; i < 6; i += 1) {
      tick(16);
      runFrame();
      fire("scroll", { timeStamp: clock, target: thread });
    }
    tick(120); // the stall: no frame, no scroll, from 10096 to 10216
    runFrame();
    fire("scroll", { timeStamp: clock, target: thread });
    ledger.jankSpan("slack-read", 10_100, 10_210);
    observed?.({ getEntries: () => [{ startTime: 10_100, duration: 100 }] });
    fire("touchend", {});
    tick(1300); // the fallback close fires with requestAnimationFrame starved

    const recs = hold.holdDiagEvents().filter((e) => e.ev === "scroll-jank");
    expect(recs).toHaveLength(1);
    const d = recs[0].d as Rec;
    expect(d.n).toBe(1);
    expect(d.t0).toBe(10_000);
    expect(d.dur).toBe(216);
    expect(d.raf).toBe(7);
    expect(d.sc).toBe(7);
    expect(d.long).toBe(2); // the stall showed on BOTH clocks
    expect(d.stallN).toBe(1); // and the totals counted it once
    expect(d.stallMs).toBe(120);
    expect(d.ltSup).toBe(1); // the stub engine advertises longtask, so 0 would mean clean
    expect(d.ltMs).toBe(100);
    expect(d.worst[0]).toEqual({
      ms: 120,
      at: 96,
      clock: "raf",
      led: ["slack-read"],
      lt: 100,
    });
    expect(d.worst[1]).toMatchObject({ ms: 120, at: 96, clock: "sc" });

    // the pump chain ends itself once the machine is idle again
    runFrame();
    expect(rafQueue).toHaveLength(0);

    // and the whole gesture, stall and close included, read no geometry at all
    expect(geometry).not.toHaveBeenCalled();
  });

  it("a scroll whose target is not the thread never opens a window", async () => {
    vi.resetModules();
    const listeners = new Map<string, ((e: unknown) => void)[]>();
    vi.stubGlobal("document", {
      getElementById: (id: string) => (id === "app" ? {} : null),
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), fn]);
      },
    });
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("fetch", () => Promise.resolve({ ok: true }));
    vi.stubGlobal(
      "PerformanceObserver",
      class {
        observe(): void {}
      },
    );
    vi.useFakeTimers();
    const hold = await import("../src/hold");
    await import("../src/scrolljank");
    const fire = (type: string, e: unknown): void => {
      for (const fn of listeners.get(type) ?? []) fn(e);
    };
    // another scroller in the shell, and a gesture that starts outside the thread
    fire("touchstart", { timeStamp: 0, target: { id: "menu", closest: () => null } });
    fire("scroll", { timeStamp: 10, target: { id: "menu" } });
    vi.advanceTimersByTime(5000);
    expect(hold.holdDiagEvents().filter((e) => e.ev === "scroll-jank")).toHaveLength(0);
  });
});
