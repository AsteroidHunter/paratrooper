// The row and stamp labels (stamplabel.ts): the same strings the per-call
// toLocale* methods gave, from formatters built once, and the check that
// spares decorate() from rebuilding a stamp that already reads right.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LABEL_FORMATS_TTL_MS, fmtStampDay, fmtTime, stampReads } from "../src/stamplabel";

const here = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(join(here, "../src/main.ts"), "utf8");

function fnBody(name: string): string {
  const start = main.indexOf(`function ${name}(`);
  expect(start, `main.ts has no ${name}`).toBeGreaterThan(-1);
  return main.slice(start, main.indexOf("\n}", start));
}

/** the labels exactly as main.ts used to make them, one formatter per call */
function oldTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function oldDay(ms: number, now: Date): string {
  const d = new Date(ms);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString([], { weekday: "long" });
  return d.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

const HOUR = 3_600_000;

describe("the labels read exactly as before", () => {
  it("a row's time matches toLocaleTimeString across two years of hours", () => {
    for (let t = Date.UTC(2025, 0, 1); t < Date.UTC(2027, 0, 1); t += 7.3 * HOUR) {
      expect(fmtTime(t)).toBe(oldTime(t));
    }
  });

  it("a stamp's day matches the old rule: Today, Yesterday, a weekday, then the date", () => {
    const now = new Date(2026, 8, 27, 15, 0);
    for (let back = 0; back < 800; back += 1) {
      const t = now.getTime() - back * 9.5 * HOUR;
      expect(fmtStampDay(t, now), `${back}`).toBe(oldDay(t, now));
    }
    expect(fmtStampDay(now.getTime(), now)).toBe("Today");
    expect(fmtStampDay(now.getTime() - 24 * HOUR, now)).toBe("Yesterday");
  });
});

describe("the formatters are built once, not once per label", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.resetModules();
  });

  async function freshModuleCountingBuilds(): Promise<{
    mod: typeof import("../src/stamplabel");
    built: () => number;
  }> {
    vi.resetModules();
    let built = 0;
    const Real = Intl.DateTimeFormat;
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (this: unknown, ...args) {
      built++;
      return new Real(...(args as ConstructorParameters<typeof Real>));
    } as unknown as typeof Intl.DateTimeFormat);
    const mod = await import("../src/stamplabel");
    return { mod, built: () => built };
  }

  it("a thousand labels build the four formatters once", async () => {
    const { mod, built } = await freshModuleCountingBuilds();
    const now = new Date(2026, 8, 27, 15, 0);
    for (let i = 0; i < 1000; i++) {
      mod.fmtTime(now.getTime() - i * HOUR);
      mod.fmtStampDay(now.getTime() - i * 5 * HOUR, now);
    }
    expect(built()).toBe(4);
  });

  it("the set is rebuilt once it is a minute old, so a new time zone is picked up", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 27, 15, 0));
    const { mod, built } = await freshModuleCountingBuilds();
    mod.fmtTime(Date.now());
    expect(built()).toBe(4);
    vi.advanceTimersByTime(LABEL_FORMATS_TTL_MS - 1000);
    mod.fmtTime(Date.now());
    expect(built()).toBe(4); // still fresh
    vi.advanceTimersByTime(2000);
    mod.fmtTime(Date.now());
    expect(built()).toBe(8); // a minute old: built again
  });
});

describe("stampReads: is this stamp already right?", () => {
  const node = (nodeName: string, textContent: string) => ({ nodeName, textContent });
  const stamp = (...nodes: { nodeName: string; textContent: string }[]) => ({ childNodes: nodes });

  it("a stamp reading the day in bold and then the time is right", () => {
    expect(stampReads(stamp(node("B", "Today"), node("#text", " 2:31 PM")), "Today", " 2:31 PM")).toBe(true);
  });

  it("anything else is rebuilt: a new stamp, another day, another time, another shape", () => {
    expect(stampReads(stamp(), "Today", " 2:31 PM")).toBe(false);
    expect(stampReads(stamp(node("B", "Yesterday"), node("#text", " 2:31 PM")), "Today", " 2:31 PM")).toBe(false);
    expect(stampReads(stamp(node("B", "Today"), node("#text", " 2:32 PM")), "Today", " 2:31 PM")).toBe(false);
    expect(stampReads(stamp(node("#text", "Today"), node("#text", " 2:31 PM")), "Today", " 2:31 PM")).toBe(false);
    expect(
      stampReads(stamp(node("B", "Today"), node("#text", " 2:31 PM"), node("#text", "")), "Today", " 2:31 PM"),
    ).toBe(false);
  });
});

describe("the wiring in main.ts", () => {
  it("labels come from stamplabel.ts and nothing in main.ts builds a formatter per call", () => {
    expect(main).toContain('import { fmtStampDay, fmtTime, stampReads } from "./stamplabel";');
    expect(main).not.toMatch(/function fmtTime\(|function fmtStampDay\(/);
    expect(main).not.toMatch(/toLocale(Time|Date)?String\(/);
  });

  it("decorate() rebuilds a stamp only when it reads wrong, and re-seats it only when it moved", () => {
    const dec = fnBody("decorate");
    expect(dec).toContain("if (!stampReads(stamp, dayText, timeText)) {");
    expect(dec).toContain("stamp.replaceChildren(day, timeText);");
    expect(dec).toContain("if (w.firstChild !== stamp) w.prepend(stamp);");
    expect(dec).not.toMatch(/^\s*w\.prepend\(stamp\);/m);
  });
});
