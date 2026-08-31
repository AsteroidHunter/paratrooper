// Pins for the compose-bar resize decision (src/viewport.ts). The bug that
// motivated this: the bar growing a line shrank the thread, the browser held
// scrollTop, and the frame-late observer re-pin painted the slip first — the
// viewport bounce. The decision is synchronous so the wiring can adjust the
// thread between the height write and the same frame's paint.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAUSE_MS, createDownButton } from "../src/downbtn";
import {
  NEAR_BOTTOM_PX,
  compensationFor,
  flightOverflow,
  followFlipDecision,
  giveUpTarget,
  nearBottomOf,
} from "../src/viewport";

describe("compensationFor", () => {
  it("bar grows at the bottom -> pin-bottom (the last reply stays in view)", () => {
    expect(compensationFor(39, 61, true)).toBe("pin-bottom");
  });

  it("bar grows while reading history -> give-up (the box must not eat the last line)", () => {
    expect(compensationFor(39, 61, false)).toBe("give-up");
  });

  it("bar shrinks at the bottom (send collapse) -> pin-bottom", () => {
    expect(compensationFor(120, 39, true)).toBe("pin-bottom");
  });

  it("bar shrinks while reading history -> keep-position (nothing was covered)", () => {
    expect(compensationFor(120, 39, false)).toBe("keep-position");
  });

  it("no height change -> none, wherever the user is", () => {
    expect(compensationFor(39, 39, true)).toBe("none");
    expect(compensationFor(39, 39, false)).toBe("none");
  });
});

// His second report: "the growing box eats the previously sent message". The
// thread's box shrinks from the BOTTOM by whatever the bar gained, so the
// thread has to hand back exactly that many pixels of scroll or the line that
// sat on that edge is clipped away under the bar.
describe("giveUpTarget: the thread gives up exactly the height the box gains", () => {
  it("one grown line: the thread scrolls down by exactly that many pixels", () => {
    expect(giveUpTarget(400, 39, 62, 900)).toBe(423); // 62 - 39 = 23
  });

  it("at the tail the give-up IS the bottom pin: same landing, no overshoot", () => {
    // sitting exactly at the old bottom (max 500); the bar grows 23, so the
    // shrunken box raises the max to 523 and both arms want 523
    const grown = 62 - 39;
    expect(giveUpTarget(500, 39, 62, 500 + grown)).toBe(523);
  });

  it("the cap frame (fifth line, 108 -> 120) gives up the partial 12px it really gained", () => {
    expect(giveUpTarget(300, 108, 120, 900)).toBe(312);
  });

  it("never past the thread's own range", () => {
    expect(giveUpTarget(890, 39, 62, 900)).toBe(900);
    expect(giveUpTarget(10, 120, 39, 900)).toBe(0);
  });

  it("no growth, no movement", () => {
    expect(giveUpTarget(400, 62, 62, 900)).toBe(400);
  });
});

// The device slip: shove/pin scroll events read "away", followTail flipped
// false, and every later growth line picked keep-position — compounding until
// a three-line message sat fully hidden. While composing, only a genuine
// gesture may turn following off.
describe("followFlipDecision", () => {
  it("at the bottom -> follow, regardless of focus or gesture", () => {
    expect(followFlipDecision(true, true, false)).toBe("follow");
    expect(followFlipDecision(true, false, false)).toBe("follow");
    expect(followFlipDecision(true, true, true)).toBe("follow");
  });

  it("away without composer focus -> unfollow (the shipped rule, untouched)", () => {
    expect(followFlipDecision(false, false, false)).toBe("unfollow");
    expect(followFlipDecision(false, false, true)).toBe("unfollow");
  });

  it("away while composing with a real gesture -> unfollow (reading history)", () => {
    expect(followFlipDecision(false, true, true)).toBe("unfollow");
  });

  it("away while composing with NO gesture -> hold: a shove or our own pin", () => {
    expect(followFlipDecision(false, true, false)).toBe("hold");
  });
});

// --- the at-bottom verdict under a send flight --------------------------------
// The chevron appearing right after a send, which he then had to tap away. The
// fresh bubble is translated DOWN to the compose field and released, CSS counts
// transformed overflow as scrollable area, and so scrollHeight carries the part
// of that translate hanging past the thread's own bottom padding for the whole
// beat. Nothing subtracted it where the verdict was read, so a reader sitting
// exactly on the bottom was told he was hundreds of pixels above it.
//
// The stand-in below is the load-bearing part: a thread pinned to its TRUE
// bottom (send() pins before it launches anything) whose scrollHeight then
// carries the flight's tax. Without it these tests would pass either way.

const PAD_B = 8; // the thread's own bottom padding
const CLIENT = 620; // the thread box on a phone with the keyboard down
const CONTENT = 4000; // everything laid out inside it

function pinnedThreadFlying(translateY: number): {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
  overflow: number;
} {
  const overflow = flightOverflow(translateY, PAD_B);
  return {
    scrollTop: CONTENT - CLIENT, // send() pinned here before the launch
    clientHeight: CLIENT,
    scrollHeight: CONTENT + overflow, // and the flight inflated it afterwards
    overflow,
  };
}

// his six sends today, by the bubble's measured travel
const FLIPPED = [575.1, 362.5, 362.3, 213.3]; // follow went off within ~30ms
const HELD = [135.8, 63.3]; // these two never did

describe("flightOverflow: what the flying bubble adds to the thread's height", () => {
  it("is the translate past the thread's own bottom padding", () => {
    expect(flightOverflow(575.1, PAD_B)).toBeCloseTo(567.1, 10);
    expect(flightOverflow(213.3, PAD_B)).toBeCloseTo(205.3, 10);
  });

  it("is never negative: a bubble still inside the padding taxes nothing", () => {
    expect(flightOverflow(4, PAD_B)).toBe(0);
    expect(flightOverflow(0, PAD_B)).toBe(0); // the landed frame
  });
});

describe("nearBottomOf: a flight in the air cannot move the bottom", () => {
  it("the window stays at 150 — his travel reached 575, and widening retires the chevron", () => {
    expect(NEAR_BOTTOM_PX).toBe(150);
  });

  it("without the subtraction, his four long sends read as away from the bottom", () => {
    for (const dy of FLIPPED) {
      const t = pinnedThreadFlying(dy);
      expect(nearBottomOf(t.scrollHeight, t.scrollTop, t.clientHeight)).toBe(false);
    }
  });

  it("without it his two short ones still read at the bottom — the threshold, exactly", () => {
    for (const dy of HELD) {
      const t = pinnedThreadFlying(dy);
      expect(nearBottomOf(t.scrollHeight, t.scrollTop, t.clientHeight)).toBe(true);
    }
  });

  it("with it, all six read at the bottom, because that is where he was sitting", () => {
    for (const dy of [...FLIPPED, ...HELD]) {
      const t = pinnedThreadFlying(dy);
      expect(nearBottomOf(t.scrollHeight, t.scrollTop, t.clientHeight, t.overflow)).toBe(true);
    }
  });

  it("a reader who really does scroll away mid-flight still reads away", () => {
    // the subtraction must not pin the answer to true: this is the whole reason
    // the verdict stays a live measurement instead of a held pre-flight one
    const t = pinnedThreadFlying(575.1);
    expect(nearBottomOf(t.scrollHeight, t.scrollTop - 400, t.clientHeight, t.overflow)).toBe(false);
  });

  it("with no flight up it is the plain reading it always was", () => {
    expect(nearBottomOf(4000, 3380, 620)).toBe(true);
    expect(nearBottomOf(4000, 3230, 620)).toBe(false); // 150 out, on the nose
    expect(nearBottomOf(4000, 3231, 620)).toBe(true);
  });
});

// The harm, end to end: verdict -> follow flip -> chevron. The keyboard is DOWN
// on these sends (the chevron is gated shut while it is up, so its appearing at
// all says so), which means the composer is unfocused and an away reading needs
// no gesture to turn following off.
describe("the chevron right after a send", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function chevronAfter(atBottom: boolean): boolean {
    let shown = false;
    const btn = createDownButton((v) => {
      shown = v;
    });
    const flip = followFlipDecision(atBottom, false, false);
    btn.scrolled(flip === "follow");
    vi.advanceTimersByTime(PAUSE_MS + 50); // he sits still, as he does after sending
    return shown;
  }

  it("the inflated reading unfollows and surfaces the chevron over a reader who never moved", () => {
    const t = pinnedThreadFlying(575.1);
    const raw = nearBottomOf(t.scrollHeight, t.scrollTop, t.clientHeight);
    expect(followFlipDecision(raw, false, false)).toBe("unfollow");
    expect(chevronAfter(raw)).toBe(true);
  });

  it("the subtracted reading keeps following on and the chevron down", () => {
    const t = pinnedThreadFlying(575.1);
    const fixed = nearBottomOf(t.scrollHeight, t.scrollTop, t.clientHeight, t.overflow);
    expect(followFlipDecision(fixed, false, false)).toBe("follow");
    expect(chevronAfter(fixed)).toBe(false);
  });
});

// --- source pins on the main.ts wiring ----------------------------------------

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/main.ts"),
  "utf8",
);

// read inside each test, never at describe level: a pin for a function that does
// not exist yet must fail as its own test, not take the whole file down with it
function fnBody(name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("\n}", start);
  return src.slice(start, end);
}

describe("at-bottom wiring: the reading site subtracts what the flight adds", () => {
  it("nearBottom goes through the shared verdict with the flight handed in", () => {
    const body = fnBody("nearBottom");
    expect(body).toContain(
      "nearBottomOf(t.scrollHeight, t.scrollTop, t.clientHeight, flightInflation(t))",
    );
    expect(body).not.toContain("150"); // the window is viewport.ts's to name
  });

  it("the inflation is read off the live transforms, the recorder's own way", () => {
    const body = fnBody("flightInflation");
    expect(body).toContain("new DOMMatrixReadOnly(tr).f");
    expect(body).toContain("paddingBottom");
    expect(body).toContain("flightOverflow(");
    expect(body).toContain("if (airborneRows.size === 0) return 0"); // nothing flying, nothing read
  });

  it("every flying row registers, and every way a flight can end takes it back off", () => {
    const fly = fnBody("flyFromField");
    expect(fly).toContain("airborneRows.add(msg)");
    expect(fly.indexOf("airborneRows.add(msg)")).toBeLessThan(fly.indexOf("anim.finished"));
    expect(fly.match(/airborneRows\.delete\(msg\)/g)).toHaveLength(2); // finish AND cancel
  });

  it("the bar-morph registers nothing: its shell is fixed and inflates no height", () => {
    expect(fnBody("armFieldMorph")).not.toContain("airborneRows");
  });

  it("a fresh shell forgets rows belonging to a thread that is gone", () => {
    expect(src).toContain("airborneRows.clear()");
  });

  it("the chevron is still fed followTail, not a second fresh reading", () => {
    // feeding downBtn its own nearBottom() would mask this symptom and leave the
    // inflated reading to bite somewhere else
    expect(src).toContain("downBtn.scrolled(followTail)");
  });
});

// The mid-typing shove doors and the kb-vv counter were retired with the
// vv-sized shell (shell.ts owns keyboard geometry; its close-time correction,
// heal, and growth-time shove decisions are pinned in shell.test.ts).

// --- TEMP DIAGNOSTIC pins: the room under the last message (tail-gap) ---------
//
// The screenshot showed the conversation ending at its last bubble with about a
// screen and a half of nothing beneath it, while the census read one of every
// element and the at-bottom verdict read true. This probe measures the only
// quantity that can make all three true at once, so what it must not do is
// invent one: no zero where an element is missing, no gap conjured by a send
// still in the air, and no write of any kind on a thread it is measuring.

import { laidOutRows, rowName, tailGapFrame } from "../src/viewport";
import type { TailReader } from "../src/viewport";
import { FLIGHT_MS } from "../src/shift";

function tailReader(over: Partial<Record<keyof TailReader, unknown>> = {}): TailReader {
  const base = { sh: 4000, st: 3200, ch: 800, pad: 12, air: 0, lastBottom: 3988, rows: 40 };
  return {
    sh: () => (over.sh as number) ?? base.sh,
    st: () => (over.st as number) ?? base.st,
    ch: () => (over.ch as number) ?? base.ch,
    pad: () => (over.pad as number) ?? base.pad,
    air: () => (over.air as number) ?? base.air,
    lastBottom: () => (over.lastBottom as number) ?? base.lastBottom,
    rows: () => (over.rows as number) ?? base.rows,
    below: () => (over.below as string | null) ?? null,
  };
}

describe("tail-gap — the empty room under the last message, as one number", () => {
  it("a healthy thread ends where its last message ends: no room, gap zero", () => {
    const f = tailGapFrame("settle", tailReader());
    expect(f.gap).toBe(0);
    expect(f.below).toBeNull();
    expect(f.atB).toBe(true);
  });

  it("his symptom: a screen and a half of room reads as the gap, not as at-bottom noise", () => {
    // last row ends at 2800 in a 4000-tall content, thread 800 tall
    const f = tailGapFrame("settle", tailReader({ lastBottom: 2800, below: "div.spacer" }));
    expect(f.gap).toBe(1188); // 4000 - 0 air - 12 pad - 2800
    expect(f.below).toBe("div.spacer"); // and the probe names what is sitting in it
  });

  it("room with nothing in it stays reported: the height is the thread's own box", () => {
    const f = tailGapFrame("settle", tailReader({ lastBottom: 2800 }));
    expect(f.gap).toBe(1188);
    expect(f.below).toBeNull();
  });

  it("a send still in the air does not fake a gap: its inflation comes back off", () => {
    // scrollHeight carries 300px of translated bubble that is not layout
    const flying = tailGapFrame("settle", tailReader({ sh: 4300, air: 300 }));
    expect(flying.gap).toBe(0);
    expect(flying.air).toBe(300);
  });

  it("the padding the design puts there is not counted as empty room", () => {
    expect(tailGapFrame("settle", tailReader({ pad: 120, sh: 4108 })).gap).toBe(0);
  });

  it("the at-bottom verdict rides the shared reading, flight subtracted", () => {
    const away = tailGapFrame("settle", tailReader({ st: 0 }));
    expect(away.atB).toBe(false);
    expect(nearBottomOf(4000, 0, 800, 0)).toBe(false); // the same call, spelled out
  });

  it("a missing element lands as null, never a zero a reader would take for a measurement", () => {
    const f = tailGapFrame("late", tailReader({ sh: NaN, lastBottom: NaN, pad: NaN }));
    expect(f.gap).toBeNull();
    expect(f.sh).toBeNull();
    expect(f.lastB).toBeNull();
    expect(f.pad).toBeNull();
    expect(f.atB).toBeNull(); // no guess about where he was
  });

  it("a gone flight reader contributes nothing rather than poisoning the gap", () => {
    const f = tailGapFrame("settle", tailReader({ air: NaN }));
    expect(f.air).toBe(0);
    expect(f.gap).toBe(0);
  });

  it("keeps a tenth of a pixel and names which of the two readings it is", () => {
    const f = tailGapFrame("late", tailReader({ lastBottom: 3987.44 }));
    expect(f.gap).toBe(0.6);
    expect(f.when).toBe("late");
  });

  it("a conversation too short to fill the box says so, instead of looking like the bug", () => {
    // scrollHeight never drops below clientHeight, so two messages in an
    // 800-tall thread report 500-odd pixels of room under the last one — true,
    // and nothing to do with his white space. gap alone cannot tell them apart.
    const tiny = tailGapFrame("settle", tailReader({ sh: 800, st: 0, lastBottom: 280 }));
    expect(tiny.gap).toBe(508);
    expect(tiny.short).toBe(true);
    expect(tailGapFrame("settle", tailReader()).short).toBe(false); // a full thread
  });

  it("content that exactly fills the box is not short", () => {
    expect(tailGapFrame("settle", tailReader({ sh: 800, st: 0, lastBottom: 788 })).short).toBe(
      false,
    );
  });

  it("no rows to measure leaves the verdict unclaimed rather than guessed", () => {
    expect(tailGapFrame("settle", tailReader({ lastBottom: NaN })).short).toBeNull();
  });

  // The room the OTHER way, and the one the keyboard-close readings are really
  // about: not space under the last message inside the scroller, but the
  // scroller sitting past the end of its own range, which is the white strip
  // between the conversation and the compose bar. Every line of this trail
  // carried the three numbers it takes to work that out and none of them
  // carried the answer.
  it("a thread inside its own range has nothing past the end", () => {
    expect(tailGapFrame("settle", tailReader()).over).toBe(0);
    expect(tailGapFrame("settle", tailReader({ st: 0 })).over).toBe(0);
  });

  it("his close: the strip is on the line instead of being derived from it", () => {
    // 6775 of content in a 624 box ends at 6151; the offset handed back was
    // 6537, that same content less the 238 of box the keyboard had left it
    const stuck = tailGapFrame("kb-close", tailReader({ sh: 6775, st: 6537, ch: 624 }));
    expect(stuck.over).toBe(386);
    expect(stuck.when).toBe("kb-close");
  });

  it("keeps a tenth of a pixel, like every other number on the line", () => {
    expect(tailGapFrame("kb-close-late", tailReader({ sh: 4000, st: 3200.4, ch: 800 })).over).toBe(
      0.4,
    );
  });

  it("a missing reading lands as null rather than a zero that reads as healthy", () => {
    expect(tailGapFrame("kb-close", tailReader({ sh: NaN })).over).toBeNull();
    expect(tailGapFrame("kb-close", tailReader({ ch: NaN })).over).toBeNull();
  });
});

// --- the defect this probe shipped with ---------------------------------------
//
// Every direct child of #thread is a .evt wrapper and styles.css gives those
// `display: contents`, which means no box at all. Checked in Chromium and in
// WebKit rather than assumed: a wrapper returns zero client rects, a
// zero-sized getBoundingClientRect, and offsetHeight 0, while the .row inside
// it returns one rect and its real height.
//
// The first cut of the probe measured t.lastElementChild, so the last message's
// bottom collapsed onto the thread's own top edge and the gap came back at
// roughly the height of the box — about one screen — on ANY thread whatsoever.
// That is almost exactly the symptom under investigation, so the probe would
// have read as confirmation of the bug rather than as a measurement of it.
//
// The stand-in below is the load-bearing part: wrappers with no geometry around
// rows that have some. Without it these tests pass either way.

type Fake = {
  tagName: string;
  id: string;
  className: string;
  children: Fake[];
  firstElementChild: Fake | null;
  getClientRects: () => { length: number };
  getBoundingClientRect: () => { top: number };
  offsetHeight: number;
};

function node(
  tag: string,
  className: string,
  kids: Fake[] = [],
  box: { top: number; height: number } | null = null,
  id = "",
): Fake {
  return {
    tagName: tag.toUpperCase(),
    id,
    className,
    children: kids,
    firstElementChild: kids[0] ?? null,
    // the display:contents signature, exactly as both engines report it
    getClientRects: () => ({ length: box ? 1 : 0 }),
    getBoundingClientRect: () => ({ top: box ? box.top : 0 }),
    offsetHeight: box ? box.height : 0,
  };
}

const PAD = 12.8; // the thread's own padding, top and bottom
const THREAD_H = 731; // the thread box on a 390x844 phone, keyboard down
const ROW_H = 88.8; // a two-line bubble, as Chromium lays one out
const ROW_GAP = 2; // .thread's flex gap

type Spec = { className: string; inner?: string; id?: string; bare?: boolean; height?: number };

function bubbles(n: number): Spec[] {
  return Array.from({ length: n }, (_, i) => {
    const role = i % 2 ? "user" : "agent";
    return { className: `row ${role}`, inner: `msg ${role} text` };
  });
}

/**
 * A thread laid out the way the app lays one out, scrolled to its end the way
 * send() leaves it. `room` is scrollable height under the last row with no
 * element in it, which is the shape of the reported symptom.
 */
function buildThread(specs: Spec[], room = 0) {
  let y = PAD; // content coordinate of the next row's top
  const placed = specs.map((s) => {
    const box = { top: y, height: s.height ?? ROW_H };
    y += box.height + ROW_GAP;
    return { s, box };
  });
  y -= placed.length ? ROW_GAP : 0; // no gap after the last row
  const sh = Math.max(y + room + PAD, THREAD_H); // and never below the box itself
  const st = Math.max(0, sh - THREAD_H); // pinned to the end
  const kids = placed.map(({ s, box }) => {
    const seen = { top: box.top - st, height: box.height }; // viewport coordinates
    const inner = s.inner ? [node("div", s.inner, [], seen)] : [];
    const el = node("div", s.className, inner, seen, s.id ?? "");
    return s.bare ? el : node("div", "evt", [el]); // display: contents, no box
  });
  const t = node("main", "thread", kids, null, "thread") as unknown as Element;
  // main.ts's seatBottom, written out: the row's viewport top, less the
  // thread's own, plus how far the thread is scrolled, plus the row's height.
  // A source pin below holds main.ts to this same formula.
  const bottom = (el: unknown): number => {
    const f = el as Fake;
    return f.getBoundingClientRect().top - 0 + st + f.offsetHeight;
  };
  return { t, sh, st, ch: THREAD_H, pad: PAD, bottom };
}

function readOf(b: ReturnType<typeof buildThread>, sentFromEnd = 1): TailReader {
  const rows = laidOutRows(b.t);
  const last = rows[rows.length - 1];
  const sent = rows[rows.length - sentFromEnd];
  return {
    sh: () => b.sh,
    st: () => b.st,
    ch: () => b.ch,
    pad: () => b.pad,
    air: () => 0,
    lastBottom: () => (last ? b.bottom(last) : NaN),
    rows: () => rows.length,
    below: () => {
      if (!sent) return null;
      const floor = b.bottom(sent);
      for (const r of rows) if (b.bottom(r) > floor + 1) return rowName(r);
      return null;
    },
  };
}

describe("laidOutRows: the boxes, never the wrappers around them", () => {
  it("a thread of .evt wrappers reports the rows inside them", () => {
    const rows = laidOutRows(buildThread(bubbles(3)).t);
    expect(rows).toHaveLength(3);
    for (const r of rows) expect((r as unknown as Fake).className).toContain("row");
  });

  it("a wrapper is never one of them: it has no box to measure", () => {
    const rows = laidOutRows(buildThread(bubbles(3)).t);
    expect(rows.some((r) => (r as unknown as Fake).className === "evt")).toBe(false);
  });

  it("a bare child with a box IS a row: the typing dots sit in the thread directly", () => {
    const b = buildThread([
      ...bubbles(2),
      { className: "msg agent typing", id: "typing", bare: true },
    ]);
    expect(laidOutRows(b.t)).toHaveLength(3);
  });

  it("a wrapper whose event rendered nothing contributes nothing", () => {
    const t = {
      children: [
        { children: [], className: "evt", getClientRects: () => ({ length: 0 }) },
        ...(laidOutRows(buildThread(bubbles(1)).t) as unknown[]),
      ],
    } as unknown as Element;
    expect(laidOutRows(t)).toHaveLength(1);
  });

  it("counts stamps and receipts too: they are rows the thread lays out", () => {
    const b = buildThread([
      { className: "stamp", height: 24 },
      ...bubbles(2),
      { className: "receipt", height: 18 },
    ]);
    expect(laidOutRows(b.t)).toHaveLength(4);
  });
});

describe("tail-gap on a real thread shape: rows measured, wrappers walked past", () => {
  it("a healthy thread, last row flush to the bottom, reports no room", () => {
    const b = buildThread(bubbles(24));
    const f = tailGapFrame("settle", readOf(b));
    expect(Math.abs(f.gap as number)).toBeLessThanOrEqual(1);
    expect(f.atB).toBe(true);
    expect(f.short).toBe(false);
    expect(f.below).toBeNull();
  });

  it("THE DEFECT: measuring the last wrapper invents a screen-tall gap on that same thread", () => {
    // what the first cut did: t.lastElementChild is a .evt, its seat collapses
    // to the thread's top edge, and the answer is the box height less its own
    // padding no matter what the conversation looks like
    const b = buildThread(bubbles(24));
    const wrapper = (b.t as unknown as Fake).children[23];
    expect(wrapper.className).toBe("evt");
    const wrapped = tailGapFrame("settle", {
      ...readOf(b),
      lastBottom: () => b.bottom(wrapper),
    });
    expect(wrapped.gap).toBeCloseTo(THREAD_H - PAD, 1); // 718.2: one screen of nothing
    expect(wrapped.gap as number).toBeGreaterThan(600);
  });

  it("the same wrapper reading is screen-tall on a five-message thread too", () => {
    // the tell that it is not a measurement: the answer does not move with the
    // conversation, because nothing about the conversation is in it
    const short = buildThread(bubbles(5));
    const wrapper = (short.t as unknown as Fake).children[4];
    const f = tailGapFrame("settle", { ...readOf(short), lastBottom: () => short.bottom(wrapper) });
    expect(f.gap).toBeCloseTo(THREAD_H - PAD, 1);
  });

  it("real room under the last row reports the size of the room", () => {
    const b = buildThread(bubbles(24), 240);
    expect(tailGapFrame("settle", readOf(b)).gap).toBeCloseTo(240, 1);
  });

  it("and it tracks the room rather than the box: 60, 240, 900", () => {
    for (const room of [60, 240, 900]) {
      expect(tailGapFrame("settle", readOf(buildThread(bubbles(24), room))).gap).toBeCloseTo(
        room,
        1,
      );
    }
  });

  it("rows counts what the thread lays out, not how many events it holds", () => {
    // one wrapper carrying a gap stamp above its bubble: 24 children, 25 rows
    const b = buildThread([{ className: "stamp", height: 24 }, ...bubbles(23)]);
    expect((b.t as unknown as Fake).children).toHaveLength(24);
    expect(tailGapFrame("settle", readOf(b)).rows).toBe(24);
    const wide = buildThread([...bubbles(24), { className: "receipt", height: 18 }]);
    expect(tailGapFrame("settle", readOf(wide)).rows).toBe(25);
  });

  it("the dots under his newest bubble are named, not filtered out", () => {
    // an agent composing under the last message is real occupied room and a
    // genuine finding; the reading is anchored on the message he just sent, so
    // anything laid out below it gets named
    const b = buildThread([
      ...bubbles(24),
      { className: "msg agent typing", id: "typing", bare: true, height: 40 },
    ]);
    const f = tailGapFrame("settle", readOf(b, 2)); // his bubble, dots beneath it
    expect(f.below).toBe("div#typing.msg.agent.typing");
    expect(Math.abs(f.gap as number)).toBeLessThanOrEqual(1); // the dots are not empty room
  });

  it("nothing under the last message reads null, and the gap then belongs to the box", () => {
    const f = tailGapFrame("settle", readOf(buildThread(bubbles(24), 240)));
    expect(f.below).toBeNull();
    expect(f.gap).toBeCloseTo(240, 1);
  });

  it("a two-message thread is short, not symptomatic", () => {
    const f = tailGapFrame("settle", readOf(buildThread(bubbles(2))));
    expect(f.short).toBe(true);
    expect(f.gap as number).toBeGreaterThan(400); // honest, and not his bug
  });

  it("an empty thread measures nothing rather than reporting a screen of room", () => {
    const f = tailGapFrame("settle", readOf(buildThread([])));
    expect(f.lastB).toBeNull();
    expect(f.gap).toBeNull();
    expect(f.rows).toBe(0);
  });
});

describe("rowName: specific enough to act on", () => {
  it("names the row and the bubble it holds, since the kind lives on the bubble", () => {
    const b = buildThread(bubbles(2));
    expect(rowName(laidOutRows(b.t)[1])).toBe("div.row.user > div.msg.user.text");
  });

  it("carries the id when there is one, and the dots are found by theirs", () => {
    const b = buildThread([{ className: "msg agent typing", id: "typing", bare: true }]);
    expect(rowName(laidOutRows(b.t)[0])).toBe("div#typing.msg.agent.typing");
  });

  it("every class, not just the first: .row.user.cont is a different finding to .row.user", () => {
    const b = buildThread([{ className: "row user cont" }]);
    expect(rowName(laidOutRows(b.t)[0])).toBe("div.row.user.cont");
  });
});

// One entry of TAIL_GAP_AT_MS as the milliseconds it really is. The first is
// spelled with the send window's name, so resolve that name out of main.ts too
// rather than hardcoding 600: if the window ever moves under the flight this
// pin fails, which is the whole point of it.
function delayMs(entry: string): number {
  if (/^\d+(?:\.\d+)?$/.test(entry)) return Number(entry);
  const named = src.match(new RegExp(`const ${entry} = (\\d+(?:\\.\\d+)?)`));
  expect(named, `${entry} is not a number declared in main.ts`).not.toBeNull();
  return Number(named![1]);
}

describe("tail-gap wiring: measured where he sees it, and writing nothing", () => {
  it("fires on every send, beside the motion recorder", () => {
    expect(src).toContain("recordTailGap(msgs[msgs.length - 1])");
  });

  it("both readings wait for the flight to land: a mid-flight number is not the gap", () => {
    const at = src.match(/TAIL_GAP_AT_MS = \[([^\]]+)\]/);
    expect(at).not.toBeNull();
    const delays = at![1].split(",").map((s) => delayMs(s.trim()));
    expect(delays).toHaveLength(2);
    for (const d of delays) expect(d).toBeGreaterThan(FLIGHT_MS);
  });

  it("the second reading sits well past the first: a late photo changes the height", () => {
    const at = src.match(/TAIL_GAP_AT_MS = \[([^\]]+)\]/)![1];
    const [first, second] = at.split(",").map((s) => s.trim());
    expect(first).toBe("SEND_MOTION_WINDOW_MS"); // the window already proven to cover a send
    expect(Number(second)).toBeGreaterThan(2000);
  });

  it("a second send re-arms rather than stacking a timer per send", () => {
    expect(fnBody("recordTailGap")).toContain("clearTimeout(tailGapTimers.pop())");
  });

  it("the probe only reads: nothing in it writes a scroll, a style or a class", () => {
    const body = fnBody("recordTailGap") + fnBody("firstBelow") + fnBody("seatBottom");
    expect(body).not.toMatch(/\.scrollTop\s*=/);
    expect(body).not.toMatch(/\.style\./);
    expect(body).not.toMatch(/classList\.(add|remove|toggle)/);
    expect(body).not.toMatch(/scrollTo\(/);
  });

  it("the last row's bottom strips running transforms rather than trusting the rect", () => {
    // a bubble mid-flight or mid-shift is translated; its rect is where it is
    // flying, not where the conversation ends
    expect(fnBody("seatBottom")).toContain("seatTop(row)");
  });

  it("every element it measures is a laid-out row, never a boxless wrapper", () => {
    // the defect: t.lastElementChild is a .evt, display: contents, no box,
    // and the gap that falls out of one is a screen tall on any thread at all
    const body = fnBody("recordTailGap");
    expect(body).toContain("laidOutRows(t)");
    expect(body).not.toContain("lastElementChild");
    expect(body).toContain("const last = rows[rows.length - 1]");
  });

  it("rows counts the rows the thread lays out, not the events it holds", () => {
    expect(fnBody("recordTailGap")).toContain("rows: () => rows.length");
    expect(fnBody("recordTailGap")).not.toContain("childElementCount");
  });

  it("no rows at all reports null, never a zero taken for a measurement of nothing", () => {
    expect(fnBody("recordTailGap")).toContain("last ? seatBottom(t, last) : NaN");
  });

  it("what sits below is asked of the message he just sent, and walks real rows", () => {
    const rec = fnBody("recordTailGap");
    expect(rec).toContain('msg.closest<HTMLElement>(".row")'); // the bubble's own row
    expect(rec).toContain("firstBelow(t, rows, sent)");
    const below = fnBody("firstBelow");
    expect(below).toContain("for (const row of rows)");
    expect(below).toContain("rowName(row)"); // named, not just tag plus first class
    expect(below).not.toMatch(/typing/); // the dots are a finding, not noise to filter
  });

  it("one walk feeds every row field, so the record describes one instant", () => {
    const rec = fnBody("recordTailGap");
    expect(rec.match(/laidOutRows\(/g)).toHaveLength(1);
  });

  it("the record reaches the phone's trail immediately instead of waiting for a later send", () => {
    const hold = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../src/hold.ts"),
      "utf8",
    );
    expect(hold).toContain('ev === "tail-gap"');
  });
});
