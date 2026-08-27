// The band of empty white under the last message, both of the ways it showed
// up on his phone, held here as arithmetic.
//
// Both are the same failure: the scroller's usable range is its content less
// its box, so anything that changes the BOX moves the end of that range, and a
// position that was the end under the old box is PAST the end under the new
// one. Safari hands an out-of-range position back rather than clamping it, so
// it stays readable and stays on screen as white until something writes over
// it. One of the two heals itself seconds later when the engine gets round to
// reconciling; the other never does.
//
//   the keyboard leaving. Numbers off his trail: 4329 of content in a 624 box
//   ends at 3705, and the stuck position was 4091, which is that same content
//   less the 238 of box the keyboard had left it. The close that failed had a
//   send flight still in the air, and a flight ends by asking for a scroll
//   whose target was measured while the keyboard was up.
//
//   the photo drawer being cancelled. The strip is about 70px (a 64px
//   thumbnail plus 0.4rem of top padding) and it hands every one of them back
//   to the thread as it collapses, so the end of the range walks up by exactly
//   the drawer and the band is exactly the drawer's height.
//
// The decision half is pure (src/viewport.ts) and pinned directly below. The
// wiring lives in main.ts, which boots a real shell at import time and cannot
// load under node, so those pins read the source, the same split flight.test.ts
// and photobox.test.ts use.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SETTLE_SLOP_PX,
  maxScrollTop,
  needsSettle,
  settleBottom,
  settleMark,
  tailOverhang,
} from "../src/viewport";

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

// his trail, the close that left the band
const CONTENT = 4329;
const OPEN_BOX = 238; // thread clientHeight with the keyboard up
const REST_BOX = 624; // and once it has gone
const STUCK = CONTENT - OPEN_BOX; // 4091: the end of the keyboard-era range
const TRUE_END = CONTENT - REST_BOX; // 3705: the end of the range he is actually in

// the photo drawer: a 64px thumbnail plus 0.4rem of top padding
const DRAWER = 70;

describe("maxScrollTop: the end of the range", () => {
  it("is the content less the box", () => {
    expect(maxScrollTop(CONTENT, REST_BOX)).toBe(TRUE_END);
    expect(maxScrollTop(CONTENT, OPEN_BOX)).toBe(STUCK);
  });

  it("never goes negative on a conversation shorter than its box", () => {
    // scrollHeight never drops below clientHeight, but a box measured mid-glide
    // can read taller for a frame; the end of the range is still the top
    expect(maxScrollTop(400, 624)).toBe(0);
  });
});

describe("keyboard close with a flight still in the air", () => {
  const g = { sh: CONTENT, st: STUCK, ch: REST_BOX };

  it("the position the flight left behind is past the end by the band he sees", () => {
    expect(tailOverhang(g)).toBe(386);
  });

  it("following the tail lands on the end computed from the FRESH box", () => {
    const plan = settleBottom(g, true);
    expect(plan.mode).toBe("follow");
    expect(plan.top).toBe(TRUE_END);
    expect(plan.over).toBe(386);
    expect(plan.moved).toBe(true);
  });

  it("the corrected position is inside the range, so nothing is left to heal", () => {
    const plan = settleBottom(g, true);
    expect(tailOverhang({ ...g, st: plan.top })).toBe(0);
  });

  it("a healthy close, with the position already at the true end, writes nothing", () => {
    const plan = settleBottom({ sh: CONTENT, st: TRUE_END, ch: REST_BOX }, true);
    expect(plan.top).toBe(TRUE_END);
    expect(plan.over).toBe(0);
    expect(plan.moved).toBe(false);
  });
});

describe("keyboard open: the same choke point, the other edge", () => {
  it("the box shrinking cannot strand a position, and the tail still follows", () => {
    // the range only gets longer, so there is no overhang to correct: the work
    // on this edge is the re-pin, from the numbers the smaller box produces
    const plan = settleBottom({ sh: CONTENT, st: TRUE_END, ch: OPEN_BOX }, true);
    expect(plan.over).toBe(0);
    expect(plan.top).toBe(STUCK);
  });

  it("a reader up in the history keeps his place while the keyboard rises", () => {
    const plan = settleBottom({ sh: CONTENT, st: 1200, ch: OPEN_BOX }, false);
    expect(plan.top).toBe(1200);
    expect(plan.moved).toBe(false);
  });
});

describe("photo drawer cancelled: the band that never heals", () => {
  // the thread while the drawer stands, and once it has gone
  const withDrawer = { sh: CONTENT, ch: REST_BOX - DRAWER };
  const seated = maxScrollTop(withDrawer.sh, withDrawer.ch); // sitting at the end of it
  // the last message ends at the content's own end less the thread's bottom
  // padding; the thread is a flex column above the drawer, so its bottom edge
  // is what the drawer gives back
  const PAD = 12;
  const lastBottom = CONTENT - PAD;
  const roomUnderLast = (st: number, ch: number): number => ch - (lastBottom - st);

  it("the drawer's whole height is left past the end the moment it collapses", () => {
    expect(tailOverhang({ sh: CONTENT, st: seated, ch: REST_BOX })).toBe(DRAWER);
  });

  it("untouched, the room under the last message grows by exactly the drawer", () => {
    // the band he reports, and the reason it is always the same size
    expect(roomUnderLast(seated, withDrawer.ch)).toBe(PAD);
    expect(roomUnderLast(seated, REST_BOX)).toBe(PAD + DRAWER);
  });

  it("the height the drawer gives back is handed straight to the scroll", () => {
    const plan = settleBottom({ sh: CONTENT, st: seated, ch: REST_BOX }, true);
    expect(plan.top).toBe(seated - DRAWER);
    expect(plan.over).toBe(DRAWER);
  });

  it("so the last message does not move: same room under it, and no band", () => {
    const plan = settleBottom({ sh: CONTENT, st: seated, ch: REST_BOX }, true);
    expect(roomUnderLast(plan.top, REST_BOX)).toBe(roomUnderLast(seated, withDrawer.ch));
    expect(tailOverhang({ sh: CONTENT, st: plan.top, ch: REST_BOX })).toBe(0);
  });

  it("opening the drawer is the same arithmetic mirrored: room under it stays put", () => {
    const open = settleBottom({ sh: CONTENT, st: TRUE_END, ch: withDrawer.ch }, true);
    expect(open.top).toBe(TRUE_END + DRAWER);
    expect(roomUnderLast(open.top, withDrawer.ch)).toBe(PAD);
  });
});

describe("a reader up in the history is clamped, never yanked", () => {
  it("a place that still exists is left exactly where he put it", () => {
    const plan = settleBottom({ sh: CONTENT, st: 1200, ch: REST_BOX }, false);
    expect(plan.mode).toBe("clamp");
    expect(plan.top).toBe(1200);
    expect(plan.moved).toBe(false);
    expect(plan.over).toBe(0);
  });

  it("a place that no longer exists is pulled back to the nearest one that does", () => {
    const plan = settleBottom({ sh: CONTENT, st: STUCK, ch: REST_BOX }, false);
    expect(plan.top).toBe(TRUE_END);
    expect(plan.over).toBe(386);
  });

  it("the clamp never walks him past the top of the conversation", () => {
    const plan = settleBottom({ sh: 400, st: 120, ch: 624 }, false);
    expect(plan.top).toBe(0);
  });
});

describe("the scroll watchdog", () => {
  it("an out-of-range position is work; the same position in range is not", () => {
    expect(needsSettle({ sh: CONTENT, st: STUCK, ch: REST_BOX })).toBe(true);
    expect(needsSettle({ sh: CONTENT, st: TRUE_END, ch: REST_BOX })).toBe(false);
    expect(needsSettle({ sh: CONTENT, st: 1200, ch: REST_BOX })).toBe(false);
  });

  it("sub-pixel rounding is not a band", () => {
    expect(SETTLE_SLOP_PX).toBe(1);
    expect(needsSettle({ sh: CONTENT, st: TRUE_END + 0.4, ch: REST_BOX })).toBe(false);
    expect(needsSettle({ sh: CONTENT, st: TRUE_END + 1, ch: REST_BOX })).toBe(true);
  });

  it("its own correction reads clean, so it cannot fire itself again", () => {
    const g = { sh: CONTENT, st: STUCK, ch: REST_BOX };
    const plan = settleBottom(g, false);
    expect(needsSettle({ ...g, st: plan.top })).toBe(false);
  });
});

describe("what the settle leaves on the trail", () => {
  it("names the signal that called and the band it corrected", () => {
    const g = { sh: CONTENT, st: STUCK, ch: REST_BOX };
    const mark = settleMark("kb-close", g, settleBottom(g, true), true, 1);
    expect(mark.via).toBe("kb-close");
    expect(mark.over).toBe(386);
    expect(mark.cut).toBe(true);
    expect(mark.mode).toBe("follow");
    expect(mark.from).toBe(STUCK);
    expect(mark.to).toBe(TRUE_END);
    expect(mark.sh).toBe(CONTENT);
    expect(mark.ch).toBe(REST_BOX);
    // the field that told his failing closes from his healthy ones
    expect(mark.air).toBe(1);
  });

  it("says when no animation was taken down with it, and nothing was flying", () => {
    const g = { sh: CONTENT, st: seatedDrawer(), ch: REST_BOX };
    const mark = settleMark("drawer-close", g, settleBottom(g, true), false);
    expect(mark.via).toBe("drawer-close");
    expect(mark.over).toBe(DRAWER);
    expect(mark.cut).toBe(false);
    expect(mark.air).toBe(0);
  });

  it("carries whole pixels, so a fractional read is still one number", () => {
    const g = { sh: CONTENT + 0.4, st: STUCK + 0.6, ch: REST_BOX };
    const mark = settleMark("scroll-watchdog", g, settleBottom(g, true), false);
    expect(Number.isInteger(mark.from)).toBe(true);
    expect(Number.isInteger(mark.to)).toBe(true);
    expect(Number.isInteger(mark.over)).toBe(true);
  });
});

function seatedDrawer(): number {
  return maxScrollTop(CONTENT, REST_BOX - DRAWER);
}

describe("the wiring in main.ts", () => {
  const settle = fnBody("settleTail");

  it("the settle reads the geometry itself and decides through viewport.ts", () => {
    expect(settle).toContain("t.scrollHeight");
    expect(settle).toContain("t.clientHeight");
    expect(settle).toContain("settleBottom(g, followTail)");
    // never a number carried in from the caller: that is the whole bug
    expect(settle).not.toContain("plan.top +");
  });

  it("the write is instant and unconditional, which is what kills a smooth one", () => {
    expect(settle).toContain('t.scrollTo({ top: plan.top, behavior: "auto" })');
    // no gate between the plan and the write
    const plan = settle.indexOf("const plan =");
    const write = settle.indexOf("t.scrollTo(");
    expect(settle.slice(plan, write)).not.toContain("if (plan.moved) return");
  });

  it("an animated ride the app is running is cancelled when there is real work", () => {
    expect(settle).toContain("const cut = plan.moved ? cancelTailRide() : false");
    expect(fnBody("cancelTailRide")).toContain("cancelGlide()");
  });

  it("every settle supersedes a scroll write deferred before it", () => {
    expect(settle).toContain("tailGen++");
    expect(src).toContain("const armed = tailGen;");
    expect(src).toContain("if (el && armed === tailGen)");
  });

  it("records the trigger, the overhang, the cancellation and the flights", () => {
    expect(settle).toContain(
      'holdDiagRecord("tail-settle", settleMark(via, g, plan, cut, flightsUp))',
    );
  });

  it("a per-frame caller leaves a record only when it actually corrected something", () => {
    expect(settle).toContain("if (!quiet || plan.over > 0 || cut)");
  });
});

describe("the signals that call it", () => {
  it("the keyboard edge, in the viewport event and again on the next frame", () => {
    const gate = src.slice(src.indexOf("watchKeyboard((up) => {"));
    const body = gate.slice(0, gate.indexOf("\n});"));
    expect(body).toContain('const via = up ? "kb-open" : "kb-close"');
    expect(body).toContain("settleTail(via);");
    expect(body).toContain("requestAnimationFrame(() => settleTail(via))");
  });

  it("the thread's own box resize, which is every frame of a box that eases", () => {
    expect(src).toContain('new ResizeObserver(() => settleTail("box", true))');
  });

  it("the drawer, both ways, on the frame its display flips", () => {
    expect(fnBody("showPending")).toContain(
      'settleTail(open ? "drawer-open" : "drawer-close")',
    );
  });

  it("the drawer's cancel and its send close both name their collapse", () => {
    expect(fnBody("dismissPick")).toContain('settleTail("drawer-close")');
    expect(fnBody("dismissSent")).toContain('settleTail("drawer-close")');
  });

  it("the scroller's own scroll events carry the watchdog", () => {
    const handler = src.indexOf('thread.addEventListener("scroll"');
    expect(handler).toBeGreaterThan(-1);
    const body = src.slice(handler, handler + 1200);
    expect(body).toContain("needsSettle({");
    expect(body).toContain('settleTail("scroll-watchdog")');
  });

  it("nothing here waits on a clock", () => {
    const settle = fnBody("settleTail");
    expect(settle).not.toContain("setTimeout");
    expect(fnBody("showPending")).not.toContain("setTimeout");
  });

  it("the stylesheet gives the scroller no scroll-behavior of its own", () => {
    // the settle's write is instant because nothing overrides it in CSS; a
    // smooth scroll-behavior here would turn the one cancelling write into
    // another animation to be cancelled, and both bands would come back
    // the property itself, not overscroll-behavior, which the thread does set
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    expect(css).not.toMatch(/(?<![-\w])scroll-behavior\s*:/);
  });
});
