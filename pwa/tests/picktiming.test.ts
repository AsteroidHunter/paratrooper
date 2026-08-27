// Pins for the TEMP pick-timing recorder (src/picktiming.ts). The instrument
// exists to locate a reported pause between the picker's confirm and the photo
// showing up in the tray, so the pins hold the four things a verdict rests on:
// the record's shape, the step ORDER (a timeline whose steps could arrive out
// of order would name the wrong step), the file-kind tagging that tells a
// camera shot from a screenshot, and the promise that the instrument cannot
// itself slow the path it times, held by source scan and by a spy-wrapped run
// of the real wiring. The wiring pins follow the split scrolljank.test.ts and
// shelldiag.test.ts use for code that boots a real shell.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PICK_STEPS, createPickClock, pickKind } from "../src/picktiming";
import type { PickStep } from "../src/picktiming";
import type { JankStamp } from "../src/jankledger";

const pickSrc = readFileSync(new URL("../src/picktiming.ts", import.meta.url), "utf8");
const holdSrc = readFileSync(new URL("../src/hold.ts", import.meta.url), "utf8");
const shellSrc = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
const mainSrc = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

// a clock over an injected ledger; empty by default so no test leaks stamps
const clockWith = (stamps: JankStamp[] = []) => createPickClock(() => stamps);

const shot = { type: "image/heic", name: "IMG_4021.HEIC", size: 2_481_923 };
const screenshot = { type: "image/png", name: "IMG_4022.PNG", size: 318_004 };

type Rec = {
  n: number;
  from: string;
  t0: number;
  total: number;
  s: Record<string, number>;
  nf: number;
  f: { kind: string; bytes: number; w?: number; h?: number }[];
  blk: { lt: number; long: number; ledMs: number; led?: [string, number][] };
};

/** one ordinary pick, every step at the offset given, ending at the paint */
function runPick(
  clock: ReturnType<typeof clockWith>,
  at: Partial<Record<PickStep, number>> = {},
  file = shot,
): Rec | null {
  const off: Record<PickStep, number> = {
    handler: 1, meta: 1, url: 2, elem: 3, seat: 4, open: 6,
    sync: 8, laid: 24, decode: 700, reveal: 701, paint: 717,
    ...at,
  };
  clock.start(1000);
  clock.step("handler", 1000 + off.handler);
  clock.file(file, 1000 + off.meta);
  for (const name of ["url", "elem", "seat", "open", "sync", "laid"] as const) {
    clock.step(name, 1000 + off[name]);
  }
  clock.step("decode", 1000 + off.decode);
  clock.dims(4032, 3024);
  clock.step("reveal", 1000 + off.reveal);
  clock.step("paint", 1000 + off.paint);
  return clock.finish(1000 + off.paint) as Rec | null;
}

describe("the record: one per pick, exactly its fields, offsets from the change event", () => {
  it("carries n, from, t0, total, the steps, the file facts and the blocked summary", () => {
    const rec = runPick(clockWith())!;
    expect(Object.keys(rec).sort()).toEqual(
      ["blk", "f", "from", "n", "nf", "s", "t0", "total"].sort(),
    );
    expect(rec.n).toBe(1);
    expect(rec.t0).toBe(1000);
    // the record says what its own zero was: the app's earliest sight of the
    // confirm, with everything before it belonging to iOS
    expect(rec.from).toBe("input-change");
  });

  it("total is the whole stretch, change event to the picture painted", () => {
    const rec = runPick(clockWith())!;
    expect(rec.total).toBe(717);
    expect(rec.s.paint).toBe(717);
  });

  it("every step is an offset in whole ms from the change event, not a clock value", () => {
    const rec = runPick(clockWith())!;
    expect(rec.s.handler).toBe(1);
    expect(rec.s.decode).toBe(700);
    for (const ms of Object.values(rec.s)) expect(Number.isInteger(ms)).toBe(true);
  });

  it("offsets round rather than truncate, so a step never reads as earlier than it was", () => {
    const clock = clockWith();
    clock.start(0);
    clock.file(shot, 0.6);
    clock.step("paint", 10.4);
    const rec = clock.finish(10.4) as Rec;
    expect(rec.s.meta).toBe(1);
    expect(rec.total).toBe(10);
  });

  it("picks number themselves across a session and each ships exactly once", () => {
    const clock = clockWith();
    expect(runPick(clock)!.n).toBe(1);
    expect(clock.finish(9999)).toBeNull(); // the pick is closed; nothing more to say
    expect(runPick(clock)!.n).toBe(2);
  });

  it("a change event that brought no file ships nothing", () => {
    const clock = clockWith();
    clock.start(0);
    clock.step("handler", 1);
    clock.step("paint", 9);
    expect(clock.finish(9)).toBeNull();
  });

  it("a pick still open reports itself open, and a finished one does not", () => {
    const clock = clockWith();
    expect(clock.open()).toBe(false);
    clock.start(0);
    expect(clock.open()).toBe(true);
    clock.file(shot, 0);
    clock.step("paint", 5);
    clock.finish(5);
    expect(clock.open()).toBe(false);
  });

  it("stamps outside a pick are dropped: nothing accumulates between picks", () => {
    const clock = clockWith();
    clock.step("open", 50); // a tray close, long after the last pick
    clock.file(shot, 50);
    expect(clock.open()).toBe(false);
    const rec = runPick(clock)!;
    expect(rec.nf).toBe(1);
    expect(rec.s.open).toBe(6);
  });
});

describe("step ordering: the timeline is the path, in the order the app walks it", () => {
  it("PICK_STEPS runs from the change event's handler to the painted frame", () => {
    expect([...PICK_STEPS]).toEqual([
      "handler", "meta", "url", "elem", "seat", "open",
      "sync", "laid", "decode", "reveal", "paint",
    ]);
  });

  it("the record's own keys follow PICK_STEPS, whatever order the stamps arrived", () => {
    const clock = clockWith();
    clock.start(0);
    // stamped back to front on purpose: the record must not inherit call order
    clock.step("paint", 90);
    clock.step("reveal", 80);
    clock.step("decode", 70);
    clock.file(shot, 5);
    clock.step("handler", 1);
    const rec = clock.finish(90) as Rec;
    expect(Object.keys(rec.s)).toEqual(["handler", "meta", "decode", "reveal", "paint"]);
  });

  it("a normal pick's offsets never go backwards from one step to the next", () => {
    const rec = runPick(clockWith())!;
    const seen = PICK_STEPS.filter((name) => rec.s[name] !== undefined).map((n) => rec.s[n]);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it("a step missing from a pick is simply absent, and the rest still line up", () => {
    const clock = clockWith();
    clock.start(0);
    clock.file(shot, 1);
    clock.step("url", 2);
    clock.step("paint", 40);
    const rec = clock.finish(40) as Rec;
    expect(Object.keys(rec.s)).toEqual(["meta", "url", "paint"]);
    expect(rec.total).toBe(40);
  });

  it("the first stamp of a step wins: a later call cannot move a step forward", () => {
    const clock = clockWith();
    clock.start(0);
    clock.file(shot, 1);
    clock.step("open", 6);
    clock.step("open", 400); // a tray close mid-pick must not rewrite the opening
    clock.step("paint", 500);
    const rec = clock.finish(500) as Rec;
    expect(rec.s.open).toBe(6);
  });

  it("a square that leaves the tray mid-decode never reaches a paint, so it stays open", () => {
    const clock = clockWith();
    clock.start(0);
    clock.file(shot, 1);
    clock.step("decode", 700); // the pixels landed, but the square was gone by then
    // the pick path calls finish only from the painted frame, which this pick
    // never reaches; the clock simply stays open until the next pick clears it
    expect(clock.open()).toBe(true);
    clock.start(2000);
    clock.file(shot, 2001);
    clock.step("paint", 2050);
    const next = clock.finish(2050) as Rec;
    expect(next.s.decode).toBeUndefined(); // the abandoned pick left nothing behind
    expect(next.n).toBe(1); // and it never shipped, so this is the first record
  });

  it("a frame callback left over from the last pick cannot stamp the next one", () => {
    const clock = clockWith();
    clock.start(1000);
    clock.file(shot, 1001);
    clock.step("laid", 990); // armed before this pick's zero: it belongs to the last one
    clock.step("paint", 1100);
    const rec = clock.finish(1100) as Rec;
    expect(rec.s.laid).toBeUndefined();
    // and with it gone the timeline can only read forwards
    const seen = PICK_STEPS.filter((n) => rec.s[n] !== undefined).map((n) => rec.s[n]);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });
});

describe("file facts: what kind of photo it was, and how big", () => {
  it("a camera shot is named by its kind, its bytes and its sensor pixels", () => {
    const rec = runPick(clockWith())!;
    expect(rec.nf).toBe(1);
    expect(rec.f).toEqual([{ kind: "heic", bytes: 2_481_923, w: 4032, h: 3024 }]);
  });

  it("a screenshot carries the same three fields, which is what tells them apart", () => {
    const clock = clockWith();
    clock.start(0);
    clock.file(screenshot, 1);
    clock.dims(1179, 2556); // the phone's own screen, portrait: not a sensor
    clock.step("paint", 60);
    const rec = clock.finish(60) as Rec;
    expect(rec.f).toEqual([{ kind: "png", bytes: 318_004, w: 1179, h: 2556 }]);
  });

  it("pixel dimensions ride along only once they are known", () => {
    const clock = clockWith();
    clock.start(0);
    clock.file(shot, 1);
    clock.step("paint", 60);
    const rec = clock.finish(60) as Rec;
    expect(rec.f).toEqual([{ kind: "heic", bytes: 2_481_923 }]);
  });

  it("dims belong to the first photo and a second report cannot overwrite them", () => {
    const clock = clockWith();
    clock.start(0);
    clock.file(shot, 1);
    clock.dims(4032, 3024);
    clock.dims(100, 100);
    clock.step("paint", 60);
    expect((clock.finish(60) as Rec).f[0]).toMatchObject({ w: 4032, h: 3024 });
  });

  it("a pick of several photos ships one record, with every file's facts on it", () => {
    const clock = clockWith();
    clock.start(0);
    clock.file(shot, 1);
    clock.file(screenshot, 2);
    clock.step("paint", 900);
    const rec = clock.finish(900) as Rec;
    expect(rec.nf).toBe(2);
    expect(rec.f.map((f) => f.kind)).toEqual(["heic", "png"]);
  });

  it("a huge multi-select still ships a bounded record, with nf counting them all", () => {
    const clock = clockWith();
    clock.start(0);
    for (let i = 0; i < 30; i += 1) clock.file(shot, 1);
    clock.step("paint", 900);
    const rec = clock.finish(900) as Rec;
    expect(rec.nf).toBe(30);
    expect(rec.f).toHaveLength(8);
  });
});

describe("kind tagging: the mime type first, the file name when iOS sends none", () => {
  it("names the camera formats", () => {
    expect(pickKind("image/heic", "IMG_1.HEIC")).toBe("heic");
    expect(pickKind("image/heif", "IMG_1.heif")).toBe("heif");
    expect(pickKind("image/jpeg", "IMG_1.JPG")).toBe("jpeg");
  });

  it("names the screenshot format", () => {
    expect(pickKind("image/png", "IMG_1.PNG")).toBe("png");
  });

  it("falls back to the file name when the type arrives empty", () => {
    expect(pickKind("", "IMG_1.HEIC")).toBe("heic");
    expect(pickKind("", "shot.jpeg")).toBe("jpeg");
    expect(pickKind("", "grab.png")).toBe("png");
  });

  it("case never decides the answer, on either side", () => {
    expect(pickKind("IMAGE/HEIC", "x")).toBe("heic");
    expect(pickKind("", "X.PnG")).toBe("png");
  });

  it("names the rest without pretending to know more than it does", () => {
    expect(pickKind("image/gif", "a.gif")).toBe("gif");
    expect(pickKind("image/webp", "a.webp")).toBe("webp");
    expect(pickKind("video/quicktime", "a.mov")).toBe("video");
    expect(pickKind("application/pdf", "a.pdf")).toBe("application/pdf");
    expect(pickKind("", "a.bin")).toBe("other");
  });
});

describe("blocked time: what held the main thread while the picture was coming", () => {
  it("a quiet stretch reports nothing blocked", () => {
    const rec = runPick(clockWith())!;
    expect(rec.blk).toEqual({ lt: 0, long: 0, ledMs: 0 });
  });

  it("ledger spans inside the stretch name themselves with their ms, heaviest first", () => {
    const rec = runPick(
      clockWith([
        { name: "pick-open", start: 1006, end: 1186 },
        { name: "shot-drawn", start: 1660, end: 1700 },
      ]),
    )!;
    expect(rec.blk.led).toEqual([["pick-open", 180], ["shot-drawn", 40]]);
    expect(rec.blk.ledMs).toBe(220);
  });

  it("a span outside the stretch stays off the record", () => {
    const rec = runPick(clockWith([{ name: "cache-write", start: 100, end: 200 }]))!;
    expect(rec.blk.ledMs).toBe(0);
    expect(rec.blk.led).toBeUndefined();
  });

  it("a span straddling the edge counts only the part inside the stretch", () => {
    const rec = runPick(clockWith([{ name: "boot", start: 900, end: 1050 }]))!;
    expect(rec.blk.led).toEqual([["boot", 50]]);
  });

  it("two spans of one name add up under that name", () => {
    const rec = runPick(
      clockWith([
        { name: "cache-put", start: 1100, end: 1130 },
        { name: "cache-put", start: 1300, end: 1320 },
      ]),
    )!;
    expect(rec.blk.led).toEqual([["cache-put", 50]]);
  });

  it("the ledger list is bounded, and keeps the heaviest names", () => {
    const spans: JankStamp[] = [];
    for (let i = 0; i < 12; i += 1) {
      spans.push({ name: `job${i}`, start: 1100, end: 1100 + i + 1 });
    }
    const rec = runPick(clockWith(spans))!;
    expect(rec.blk.led).toHaveLength(6);
    expect(rec.blk.led![0]).toEqual(["job11", 12]);
  });

  it("longtask ms are clipped to the stretch and counted", () => {
    const clock = clockWith();
    clock.longtask(950, 100); // half of it lands before the change event
    clock.longtask(1200, 80);
    const rec = runPick(clock)!;
    expect(rec.blk.lt).toBe(130);
    expect(rec.blk.long).toBe(2);
  });

  it("longtasks entirely outside the stretch contribute nothing", () => {
    const clock = clockWith();
    clock.longtask(100, 90);
    clock.longtask(5000, 90);
    const rec = runPick(clock)!;
    expect(rec.blk).toEqual({ lt: 0, long: 0, ledMs: 0 });
  });

  it("the longtask ring never grows with session length", () => {
    const clock = clockWith();
    for (let i = 0; i < 200; i += 1) clock.longtask(1100 + i, 1);
    const rec = runPick(clock)!;
    expect(rec.blk.long).toBeLessThanOrEqual(32);
  });
});

describe("clock-only, pinned by source: the instrument cannot cause the pause", () => {
  const FORBIDDEN =
    /getBoundingClientRect|getComputedStyle|getClientRects|elementFromPoint|scrollTop|scrollHeight|scrollLeft|scrollWidth|offsetHeight|offsetWidth|offsetTop|offsetLeft|clientHeight|clientWidth|clientTop|clientLeft|innerHeight|innerWidth|naturalWidth|naturalHeight/;

  it("the recorder contains no layout read of any kind, comments included", () => {
    expect(pickSrc).not.toMatch(FORBIDDEN);
  });

  it("it touches no node at all: the only document call is the shell check", () => {
    const uses = pickSrc.match(/document\.[a-zA-Z]+/g) ?? [];
    expect(uses).toEqual(["document.getElementById"]);
    expect(pickSrc).not.toMatch(/createElement|appendChild|classList|querySelector|\.style\./);
  });

  it("it registers no listener, so it can never delay or cancel an event", () => {
    expect(pickSrc).not.toMatch(/addEventListener|preventDefault|stopPropagation/);
  });

  it("the file facts are three primitives, so a File is never held or measured", () => {
    expect(pickSrc).toMatch(/export interface PickFile \{\n\s*type: string;\n\s*name: string;\n\s*size: number;\n\}/);
  });

  it("the painted-frame stamps are frame timestamps, never a read inside the frame", () => {
    expect(pickSrc).toMatch(/requestAnimationFrame\(\(\) => requestAnimationFrame\(\(ts\) => then\(ts\)\)\)/);
  });

  it("no frame callback is ever armed while no pick is being timed", () => {
    const armings = pickSrc.match(/if \(!clock\.open\(\)\) return;\n\s*afterPaintedFrame/g) ?? [];
    expect(armings).toHaveLength(2); // the laid stamp and the painted one
  });
});

describe("wiring and stamps, pinned by source across the stamped files", () => {
  it("the clock starts at the file input's change event, before anything else runs", () => {
    expect(shellSrc).toMatch(/addEventListener\("change", \(\) => \{[\s\S]*?pickTimingStart\(\);\n\s*sessionDone\(\);/);
  });

  it("the app's own steps are stamped where the app performs them", () => {
    expect(mainSrc).toContain('pickTimingStep("handler")');
    expect(mainSrc).toContain("pickTimingFile(file)");
    expect(mainSrc).toContain('pickTimingStep("url")');
    expect(mainSrc).toContain('pickTimingStep("elem")');
    expect(mainSrc).toContain('pickTimingStep("seat")');
    expect(mainSrc).toContain('pickTimingStep("open")');
    expect(mainSrc).toContain('pickTimingStep("sync")');
    expect(mainSrc).toContain("pickTimingLaid()");
    expect(mainSrc).toContain('pickTimingStep("decode")');
    expect(mainSrc).toContain('pickTimingStep("reveal")');
    expect(mainSrc).toContain("pickTimingPainted()");
  });

  it("the url step sits on the line after the url is made, not before it", () => {
    expect(mainSrc).toMatch(/const url = URL\.createObjectURL\(file\);\n\s*pickTimingStep\("url"\)/);
  });

  it("the seat step sits after the square is actually in the tray", () => {
    expect(mainSrc).toMatch(/box\.appendChild\(wrap\);[^\n]*\n\s*pickTimingStep\("seat"\)/);
  });

  it("the reveal step sits after the placeholder comes off, and closes the pick", () => {
    expect(mainSrc).toMatch(
      /wrap\.classList\.remove\("undrawn"\);\n\s*pickTimingStep\("reveal"\);[^\n]*\n\s*pickTimingPainted\(\)/,
    );
  });

  it("the decode step is stamped before the removed-or-sent return, so it is never lost", () => {
    expect(mainSrc).toMatch(
      /pickTimingStep\("decode"\);[\s\S]{0,600}?if \(picks\.get\(file\) !== pick\) return;/,
    );
  });

  it("the two heavier pick jobs stamp the activity ledger, unchanged as it stands", () => {
    expect(mainSrc).toContain('jankSpan("pick-sync", jankT0)');
    expect(mainSrc).toContain('jankSpan("pick-open", jankT0)');
  });

  it("pick-timing is in hold.ts's post-now list: a pick's record posts without waiting", () => {
    expect(holdSrc).toMatch(/ev === "pick-timing"/);
  });

  it("the banner says plainly what the clock cannot see before its own zero", () => {
    expect(pickSrc).toMatch(/WHERE THE CLOCK STARTS[\s\S]*?happens inside iOS with no callback of any kind into the page/);
  });

  it("the banner's TO REMOVE names every call site, so deleting is reading", () => {
    const note = /TO REMOVE, every call site:[\s\S]*?scroll-jank block that owns that file\./.exec(pickSrc)?.[0] ?? "";
    for (const named of [
      "picktiming.test.ts",
      "shell.ts",
      "main.ts",
      "hold.ts",
      "web/app.py",
      "test_holddiag.py",
      "pick-sync",
      "pick-open",
    ]) {
      expect([named, note.includes(named)]).toEqual([named, true]);
    }
  });
});

describe("a simulated pick through the real wiring, geometry spied shut", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("ships one pick-timing record and never once reads geometry", async () => {
    vi.resetModules();

    // every geometry road leads to this spy; the pin is that it stays at zero
    const geometry = vi.fn();
    const app: Record<string, unknown> = { id: "app" };
    for (const p of ["offsetHeight", "clientHeight", "scrollTop", "scrollHeight"]) {
      Object.defineProperty(app, p, {
        get: () => {
          geometry(p);
          return 0;
        },
      });
    }
    // a shell present enough for the diagnostic trail to switch itself on, so
    // the record travels the same route it does on the phone
    vi.stubGlobal("document", {
      getElementById: (id: string) => (id === "app" ? app : null),
      addEventListener: () => {},
      body: {},
    });
    vi.stubGlobal("fetch", () => Promise.resolve());

    const frames: ((ts: number) => void)[] = [];
    vi.stubGlobal("requestAnimationFrame", (fn: (ts: number) => void) => {
      frames.push(fn);
      return frames.length;
    });
    // no longtask support on this stub engine: the step offsets carry it alone
    vi.stubGlobal("PerformanceObserver", undefined);

    const hold = await import("../src/hold");
    const mod = await import("../src/picktiming");
    hold.holdDiagReset();

    const nowSpy = vi.spyOn(performance, "now");
    const runFrames = (a: number, b: number): void => {
      const queued = frames.splice(0, frames.length);
      for (const f of queued) f(a);
      const inner = frames.splice(0, frames.length);
      for (const f of inner) f(b);
    };

    nowSpy.mockReturnValue(1000);
    mod.pickTimingStart();
    nowSpy.mockReturnValue(1002);
    mod.pickTimingStep("handler");
    mod.pickTimingFile({ type: "image/heic", name: "IMG_9.HEIC", size: 2_000_000 });
    nowSpy.mockReturnValue(1010);
    mod.pickTimingStep("sync");
    mod.pickTimingLaid();
    runFrames(1016, 1032); // the frame the drawer's layout rides, then the one after
    nowSpy.mockReturnValue(1700);
    mod.pickTimingStep("decode");
    mod.pickTimingDims(4032, 3024);
    mod.pickTimingStep("reveal");
    mod.pickTimingPainted();
    expect(hold.holdDiagEvents().filter((e) => e.ev === "pick-timing")).toHaveLength(0);
    runFrames(1716, 1732); // the record lands only once the picture's frame is painted

    const shipped = hold.holdDiagEvents().filter((e) => e.ev === "pick-timing");
    expect(shipped).toHaveLength(1);
    const rec = shipped[0].d as unknown as Rec;
    expect(rec.total).toBe(732);
    expect(rec.s).toEqual({
      handler: 2, meta: 2, sync: 10, laid: 32, decode: 700, reveal: 700, paint: 732,
    });
    expect(rec.f).toEqual([{ kind: "heic", bytes: 2_000_000, w: 4032, h: 3024 }]);
    expect(geometry).not.toHaveBeenCalled();
  });

  it("arms no frame callback at all when no pick is being timed", async () => {
    vi.resetModules();
    const frames: ((ts: number) => void)[] = [];
    vi.stubGlobal("document", { getElementById: () => null });
    vi.stubGlobal("requestAnimationFrame", (fn: (ts: number) => void) => {
      frames.push(fn);
      return frames.length;
    });
    const mod = await import("../src/picktiming");
    mod.pickTimingLaid();
    mod.pickTimingPainted();
    expect(frames).toHaveLength(0);
  });
});
