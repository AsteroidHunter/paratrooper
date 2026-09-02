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
  MAX_CLOSE_RESTORES,
  SETTLE_BURST_GAP_MS,
  boxSettled,
  createSettleBurst,
  maxScrollTop,
  restoreMark,
  restoreVerdict,
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

  // The close does not happen in one hop: the strip eases its height down over a
  // beat, IN the flex column, so the thread's box grows a little on each of those
  // frames and each one is delivered to the thread's ResizeObserver after layout
  // and before paint. Walking those frames is what the settle actually does now
  // that nothing corrects up front.
  describe("the close as it really runs: frame by frame, nothing up front", () => {
    // the strip's height on each frame the observer is delivered; the tap's own
    // frame is not among them, because on it nothing has moved yet
    const EASE = [70, 56, 41, 27, 14, 5, 0];

    const walk = (from: number, follow: boolean): { st: number; ch: number }[] => {
      const out: { st: number; ch: number }[] = [];
      let st = from;
      for (const h of EASE.slice(1)) {
        const ch = REST_BOX - h;
        st = settleBottom({ sh: CONTENT, st, ch }, follow).top;
        out.push({ st, ch });
      }
      return out;
    };

    it("the view never moves up on any frame: every step gives room back", () => {
      // the up-jump he reported can only come from a write that RAISES scrollTop,
      // and the close's own frames only ever lower it
      const steps = walk(seated, true);
      let prev = seated;
      for (const f of steps) {
        expect(f.st).toBeLessThanOrEqual(prev);
        prev = f.st;
      }
    });

    it("the last message keeps exactly the same room under it, all the way down", () => {
      for (const f of walk(seated, true)) {
        expect(roomUnderLast(f.st, f.ch)).toBe(PAD);
      }
    });

    it("and the walk ends on the true end, with no band left under the message", () => {
      const end = walk(seated, true).at(-1)!;
      expect(end.ch).toBe(REST_BOX);
      expect(end.st).toBe(TRUE_END);
      expect(tailOverhang({ sh: CONTENT, st: end.st, ch: REST_BOX })).toBe(0);
      expect(roomUnderLast(end.st, REST_BOX)).toBe(PAD);
    });

    it("a reader up in the history rides it out without being pulled to the tail", () => {
      const steps = walk(1200, false);
      for (const f of steps) expect(f.st).toBe(1200);
      // and he still has no band: his place was never near the end to begin with
      expect(tailOverhang({ sh: CONTENT, st: 1200, ch: REST_BOX })).toBe(0);
    });

    it("a reader sitting on the OLD end is clamped down, never left past it", () => {
      const steps = walk(seated, false);
      expect(steps.at(-1)!.st).toBe(TRUE_END);
      expect(tailOverhang({ sh: CONTENT, st: steps.at(-1)!.st, ch: REST_BOX })).toBe(0);
    });
  });
});

// The other half of the same band: the CONVERSATION shrinks rather than the box.
// The typing dots are appended at the tail, the view is pinned to the bottom
// while they show, and their removal takes their height out from under that
// position. No box moves, so no ResizeObserver anywhere sees it, and until the
// settle was wired to the removal nothing wrote the scroll again, so the dots'
// height stayed on screen as white under the last message.
describe("the conversation's own content shrinks: the dots leaving", () => {
  const DOTS = 44; // the typing row: three blinking spans in a bubble
  const withDots = CONTENT;
  const withoutDots = CONTENT - DOTS;
  const pinned = maxScrollTop(withDots, REST_BOX); // following, so sitting on the end

  it("the dots' own height is left past the end the moment they go", () => {
    expect(tailOverhang({ sh: withoutDots, st: pinned, ch: REST_BOX })).toBe(DOTS);
  });

  it("the box never changed, which is why nothing else could have caught it", () => {
    // same clientHeight either side: a ResizeObserver on the thread watches this
    // number and it did not move
    expect(maxScrollTop(withDots, REST_BOX) - maxScrollTop(withoutDots, REST_BOX)).toBe(DOTS);
  });

  it("following the tail, the view comes back by exactly the dots", () => {
    const plan = settleBottom({ sh: withoutDots, st: pinned, ch: REST_BOX }, true);
    expect(plan.mode).toBe("follow");
    expect(plan.top).toBe(pinned - DOTS);
    expect(plan.over).toBe(DOTS);
    expect(tailOverhang({ sh: withoutDots, st: plan.top, ch: REST_BOX })).toBe(0);
  });

  it("a reader up in the history is not yanked down to the dots' absence", () => {
    const plan = settleBottom({ sh: withoutDots, st: 1200, ch: REST_BOX }, false);
    expect(plan.mode).toBe("clamp");
    expect(plan.top).toBe(1200);
    expect(plan.moved).toBe(false);
  });

  it("and is clamped only by the part of his place that stopped existing", () => {
    const plan = settleBottom({ sh: withoutDots, st: pinned, ch: REST_BOX }, false);
    expect(plan.mode).toBe("clamp");
    expect(plan.top).toBe(maxScrollTop(withoutDots, REST_BOX));
    expect(plan.over).toBe(DOTS);
  });

  it("content GROWING needs nothing: a bigger range cannot strand a position", () => {
    // why the named sites are the shrinks and not every content change
    const plan = settleBottom({ sh: withDots + 200, st: pinned, ch: REST_BOX }, false);
    expect(plan.moved).toBe(false);
    expect(plan.over).toBe(0);
  });
});

describe("the content settle's wiring", () => {
  it("goes through the one settle, so it obeys the one follow-versus-clamp rule", () => {
    expect(fnBody("settleContent")).toContain("settleTail(`content-${what}`)");
  });

  it("hides the dots and settles, in that order, and only when there were dots", () => {
    const hide = fnBody("hideTyping");
    expect(hide).toContain('const dots = document.getElementById("typing")');
    expect(hide).toContain("if (!dots) return");
    expect(hide.indexOf("dots.remove()")).toBeLessThan(hide.indexOf('settleContent("typing")'));
  });

  it("showTyping's pin has an answer on the way out now", () => {
    expect(fnBody("showTyping")).toContain("if (followTail) scrollToBottom()");
    expect(fnBody("hideTyping")).toContain("settleContent(");
  });

  it("the other two whole-block removals settle as well", () => {
    expect(fnBody("applyRetract")).toContain('settleContent("retract")');
    expect(fnBody("deleteFailed")).toContain('settleContent("delete")');
  });

  it("every content settle carries its own trigger name onto the trail", () => {
    const names = [...src.matchAll(/settleContent\("([a-z]+)"\)/g)].map((m) => m[1]);
    expect(names.sort()).toEqual(["delete", "retract", "typing"]);
  });

  it("nothing here waits on a clock, and nothing reads a scroll event", () => {
    expect(fnBody("settleContent")).not.toContain("setTimeout");
    expect(fnBody("settleContent")).not.toContain("requestAnimationFrame");
    expect(fnBody("hideTyping")).not.toContain("setTimeout(settleContent");
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

describe("the settle corrects itself in one pass", () => {
  it("a corrected position has no overhang left to correct", () => {
    const g = { sh: CONTENT, st: STUCK, ch: REST_BOX };
    const plan = settleBottom(g, false);
    expect(tailOverhang({ ...g, st: plan.top })).toBe(0);
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
    // following the tail means pinning it, with one exception: a resume
    // landing, where the pin is either the write iOS hands straight back or a
    // teleport past a ride already on its way there, so the reader's own rule
    // (clamp) applies instead until the landing is over (resume.ts)
    expect(settle).toContain("settleBottom(g, followTail && !resumeHolding())");
    // never a number carried in from the caller: that is the whole bug
    expect(settle).not.toContain("plan.top +");
  });

  it("the write is instant, and only a landing with nothing to correct holds it", () => {
    expect(settle).toContain('t.scrollTo({ top: plan.top, behavior: "auto" })');
    // The one gate, and it is the resume landing's: while the phone is still
    // restoring the scroll, a write that lands on the value already there is
    // still a scroll request to an engine mid-restore, and there is no smooth
    // scroll to cancel in that stretch anyway because scrollToBottom stands
    // aside for the landing too. Everywhere else it stays unconditional, which
    // is what kills a smooth scroll aimed at the old box.
    expect(settle).toContain("const write = plan.moved || !resumeHolding()");
    // and a real correction is never skipped, landing or not
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

  it("the send's close names its collapse, because it really is one hop", () => {
    // the strip leaves the LAYOUT on the tap (position: fixed), so the thread
    // has the whole drawer's room back in this frame and the settle answers a
    // change that has already happened
    const sent = fnBody("dismissSent");
    expect(sent).toContain('box.style.position = "fixed"');
    expect(sent.indexOf('box.style.position = "fixed"')).toBeLessThan(
      sent.indexOf('settleTail("drawer-close")'),
    );
  });

  it("the ✕'s cancel corrects nothing up front: its drawer is still standing", () => {
    // The ✕'s close eases IN the flex column over a beat, so on the tap's own
    // frame the drawer is at full height and there is nothing yet to correct.
    // A settle here could only pull a following view the last of its slack down
    // to the exact end, and following holds anywhere within NEAR_BOTTOM_PX. That
    // pull, followed by the per-frame settles walking the view back down as the
    // drawer actually went, IS the jump up and the fall he reported.
    expect(fnBody("dismissPick")).not.toContain("settleTail(");
    // the per-frame observer carries it instead, and showPending closes the run
    expect(src).toContain('new ResizeObserver(() => settleTail("box", true))');
    expect(fnBody("dismissPick")).toContain("showPending()");
  });

  it("the ✕'s close still eases inside the column, which is what makes it per-frame", () => {
    // if this close ever left the layout the way the send's does, the thread
    // would take the drawer back in one hop and there would be no frames for
    // the observer to ride
    const pick = fnBody("dismissPick");
    expect(pick).toContain("trayClosing = box.animate(trayClose(box.offsetHeight, padTop), beat)");
    expect(pick).not.toContain("box.style.position");
  });

  it("the scroller's own scroll events carry no clamp of any kind", () => {
    // A clamp asked on every scroll event cannot tell the fault from a rubber
    // band stretch or from one of our own glides landing, and cutting those was
    // a shipped regression. The geometry signals own this instead.
    const handler = src.indexOf('thread.addEventListener("scroll"');
    expect(handler).toBeGreaterThan(-1);
    const body = src.slice(handler, handler + 1200);
    expect(body).not.toContain("needsSettle({");
    expect(body).not.toContain("settleTail(");
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

// ===================== TEMP DIAGNOSTIC (remove after the blank-thread session) =====================
// Pins for the per-frame settles' summary (src/viewport.ts createSettleBurst,
// and its wiring in settleTail).
//
// A box that eases rather than hops settles on every frame of the ease, and
// those passes carry a quiet flag: unless one of them corrected an overhang or
// cut a ride, they recorded nothing. That left the photo drawer's close — about
// two dozen scroll writes inside four hundred milliseconds — as the one stretch
// of this app with no trail behind it, which is exactly the stretch a blank
// message area was reported in. Recording each pass instead would put two dozen
// marks on a bounded digest tail and push everything else off it, so what is
// pinned here is that a run folds into ONE mark, that the mark keeps the four
// things the run is asked about, and that a run cannot be split in half or
// joined to the next one.
describe("the quiet settles, folded into one mark per run", () => {
  const geom = (st: number, sh = CONTENT, ch = REST_BOX) => ({ sh, st, ch });
  const plan = (top: number, st: number, over = 0) => ({
    mode: "clamp" as const,
    top,
    over,
    moved: top !== st,
  });

  it("nothing open hands back nothing", () => {
    expect(createSettleBurst().take()).toBeNull();
  });

  it("the drawer's whole beat becomes one mark: the writes, and that none moved", () => {
    // the shape under suspicion: the strip hands its height back frame by
    // frame, every frame settles, and with the reader up in the history each
    // write lands on the position it just read
    const b = createSettleBurst();
    for (let i = 0; i < 24; i += 1) {
      expect(b.add("box", geom(2180), plan(2180, 2180), 1000 + i * 16)).toBeNull();
    }
    const mark = b.take();
    expect(mark).toEqual({
      via: "box",
      n: 24,
      moved: 0,
      from: 2180,
      to: 2180,
      over: 0,
      ms: 368,
      sh: CONTENT,
      ch: REST_BOX,
    });
  });

  it("a write that actually moved the reader is counted apart from one that did not", () => {
    const b = createSettleBurst();
    b.add("box", geom(STUCK), plan(TRUE_END, STUCK, 386), 1000);
    b.add("box", geom(TRUE_END), plan(TRUE_END, TRUE_END), 1016);
    b.add("box", geom(TRUE_END), plan(TRUE_END, TRUE_END), 1032);
    const mark = b.take();
    expect(mark?.n).toBe(3);
    expect(mark?.moved).toBe(1);
    // where it stood at the first write and at the last, so the run's whole
    // travel reads off one line
    expect(mark?.from).toBe(STUCK);
    expect(mark?.to).toBe(TRUE_END);
    // and the worst band any single write took back, not the last one's
    expect(mark?.over).toBe(386);
  });

  it("the box's own numbers are the run's last, so the change it caused is legible", () => {
    const b = createSettleBurst();
    b.add("box", geom(2180, CONTENT, OPEN_BOX), plan(2180, 2180), 1000);
    b.add("box", geom(2180, CONTENT, REST_BOX), plan(2180, 2180), 1016);
    expect(b.take()).toMatchObject({ sh: CONTENT, ch: REST_BOX });
  });

  it("a gap wider than two frames ends the run and hands it back as the next one opens", () => {
    const b = createSettleBurst();
    b.add("box", geom(2180), plan(2180, 2180), 1000);
    b.add("box", geom(2180), plan(2180, 2180), 1016);
    // a separate box change, well after the first ease finished
    const ended = b.add("box", geom(1400), plan(1400, 1400), 1016 + SETTLE_BURST_GAP_MS + 1);
    expect(ended?.n).toBe(2);
    expect(ended?.from).toBe(2180);
    const next = b.take();
    expect(next?.n).toBe(1);
    expect(next?.from).toBe(1400);
  });

  it("a frame's own cadence cannot split a beat: exactly the gap still belongs to it", () => {
    const b = createSettleBurst();
    b.add("box", geom(2180), plan(2180, 2180), 1000);
    expect(b.add("box", geom(2180), plan(2180, 2180), 1000 + SETTLE_BURST_GAP_MS)).toBeNull();
    expect(b.take()?.n).toBe(2);
  });

  it("a single stray quiet pass is still a run of one, never dropped", () => {
    const b = createSettleBurst();
    b.add("box", geom(2180), plan(2180, 2180), 1000);
    expect(b.take()).toMatchObject({ n: 1, ms: 0 });
  });
});

describe("the settle's wiring: quiet passes kept, loud ones still first-class", () => {
  const body = fnBody("settleTail");

  it("a pass with nothing to report folds into the run instead of vanishing", () => {
    expect(body).toContain("tailBurstFold(via, g, plan)");
  });

  it("a louder settle closes the run first, so the beat reads before its ending", () => {
    expect(body.indexOf("tailBurstClose()")).toBeLessThan(
      body.indexOf('holdDiagRecord("tail-settle", settleMark('),
    );
  });

  it("both shapes ride the one channel, which the server now has a block for", () => {
    expect(src).toContain('holdDiagRecord("tail-settle", mark)');
    const app = readFileSync(new URL("../../src/paratrooper/web/app.py", import.meta.url), "utf8");
    expect(app).toContain('e.get("ev") == "tail-settle"');
  });

  it("the fold reads no geometry of its own: it is handed what the settle read", () => {
    const fold = fnBody("tailBurstFold");
    expect(fold).not.toMatch(/scrollTop|scrollHeight|clientHeight|getBoundingClientRect/);
  });

  it("the backstop timer cannot outlive the run it was armed for", () => {
    expect(fnBody("tailBurstClose")).toContain("clearTimeout(tailBurstTimer)");
    expect(fnBody("tailBurstFold")).toContain("clearTimeout(tailBurstTimer)");
  });
});
// =================== END TEMP DIAGNOSTIC (remove after the blank-thread session) ===================

// --- the keyboard's parting shot ----------------------------------------------
//
// The third way the same band opens, and the only one nothing of ours caused.
// The v0.3.58 trail, two occurrences and one close in the same session that did
// not reproduce: at the close transition's end, ms 208, the scroller sat at
// 6151, which is its 6775 of content less the 624 of box the keyboard had just
// given back. ONE FRAME LATER, ms 224, it read 6537 — that same content less
// the 238 of box it had while the keyboard was up — and stayed there through
// the 600ms and 2100ms readings. Nothing of ours wrote it: every scroll writer
// in the app records itself and none had.
//
// So the numbers below are his, and what is pinned is that the correction can
// only fire on a state the scroller can never legitimately hold, that it stands
// aside for the two states that LOOK like it (a box still easing, a finger on
// the glass), and that it lands on the same place whichever way following
// happens to be pointing.
const REST_SH = 6775; // his content
const OPEN_CH = 238; // thread box with the keyboard up
const REST_CH = 624; // and once it has gone
const BACK_END = REST_SH - REST_CH; // 6151: where the close correctly landed
const STALE_END = REST_SH - OPEN_CH; // 6537: what came back one frame later
const PAST_END = { sh: REST_SH, st: STALE_END, ch: REST_CH };

describe("boxSettled: the difference between the fault and an ordinary frame", () => {
  it("the same box twice over is a box that is not easing", () => {
    expect(boxSettled(PAST_END, { ...PAST_END, st: BACK_END })).toBe(true); // only the scroll moved
  });

  it("a box mid-glide is not settled, whichever of its numbers moved", () => {
    expect(boxSettled(PAST_END, { ...PAST_END, ch: 600 })).toBe(false);
    expect(boxSettled(PAST_END, { ...PAST_END, sh: 6700 })).toBe(false);
  });

  it("a first look has nothing to compare against and says so", () => {
    expect(boxSettled(PAST_END, null)).toBe(false);
  });
});

describe("the correction: only ever a position that cannot exist", () => {
  it("his frame: 386px past an end the scroller cannot hold is corrected", () => {
    expect(tailOverhang(PAST_END)).toBe(386);
    expect(restoreVerdict(PAST_END, true, 0, false)).toBe("fix");
  });

  it("sitting exactly on the end is not the fault, and neither is sitting inside it", () => {
    expect(restoreVerdict({ ...PAST_END, st: BACK_END }, true, 0, false)).toBe("none");
    expect(restoreVerdict({ ...PAST_END, st: 200 }, true, 0, false)).toBe("none");
    expect(restoreVerdict({ ...PAST_END, st: 0 }, true, 0, false)).toBe("none");
  });

  it("a thread shorter than its own box has an end of zero and is never past it", () => {
    expect(restoreVerdict({ sh: 400, st: 0, ch: 624 }, true, 0, false)).toBe("none");
  });

  it("every frame of the shell's glide home stands aside for the settle it owns", () => {
    // the box grew this frame, so the position that was on the old end is past
    // the new one for the instant before the thread's resize observer answers
    expect(restoreVerdict(PAST_END, false, 0, false)).toBe("moving");
  });

  it("a gesture owns the scroll, rubber band and all", () => {
    expect(restoreVerdict(PAST_END, true, 0, true)).toBe("held");
  });

  it("two writers cannot fight over one number: the budget stands the app down", () => {
    expect(restoreVerdict(PAST_END, true, MAX_CLOSE_RESTORES - 1, false)).toBe("fix");
    expect(restoreVerdict(PAST_END, true, MAX_CLOSE_RESTORES, false)).toBe("spent");
  });

  it("the place it goes back to is the same one whichever way following points", () => {
    // this is what lets the correction BE the settle rather than a new writer
    expect(settleBottom(PAST_END, true).top).toBe(BACK_END);
    expect(settleBottom(PAST_END, false).top).toBe(BACK_END);
    expect(tailOverhang({ ...PAST_END, st: BACK_END })).toBe(0);
  });
});

describe("what the correction leaves on the trail", () => {
  const mark = restoreMark("frame", "fix", 224.4, PAST_END, 1, STALE_END);

  it("names the strip he can see, and how long after the close it was caught", () => {
    expect(mark.over).toBe(386);
    expect(mark.ms).toBe(224);
    expect(mark.via).toBe("frame");
    expect(mark.act).toBe("fix");
    expect(mark.n).toBe(1);
  });

  it("states the accusation as a number: the bottom the keyboard-era box made", () => {
    // from equal to pre is the pre-dismissal position handed back, which no box
    // change and no write of ours can produce
    expect(mark.from).toBe(STALE_END);
    expect(mark.pre).toBe(STALE_END);
    expect(mark.to).toBe(BACK_END);
    expect(mark.sh).toBe(REST_SH);
    expect(mark.ch).toBe(REST_CH);
  });

  it("a close whose thread was never measured says -1 rather than a coordinate", () => {
    expect(restoreMark("gap", "fix", 600, PAST_END, 1, -1).pre).toBe(-1);
  });

  it("carries whole pixels, so a fractional read is still one number", () => {
    const m = restoreMark("late", "spent", 2100.6, { sh: 6774.6, st: 6537.4, ch: 623.5 }, 5, 0);
    expect(m.from).toBe(6537);
    expect(m.sh).toBe(6775);
    expect(m.ch).toBe(624);
    expect(m.ms).toBe(2101);
    expect(m.act).toBe("spent");
  });
});

describe("the correction's wiring in main.ts", () => {
  const fix = fnBody("fixCloseTail");
  const start = fnBody("closeTailStart");

  it("the window opens on the close edge and is cancelled by the next open", () => {
    const edge = src.slice(src.indexOf("watchKeyboard((up)"), src.indexOf("bootGate"));
    expect(edge).toContain("if (up) closeTailStop();");
    expect(edge).toContain("else closeTailStart();");
    // before the settle on that same edge, so the bottom it remembers is the
    // one the keyboard-era box made
    expect(edge.indexOf("closeTailStart()")).toBeLessThan(edge.indexOf("settleTail(via)"));
  });

  it("remembers the end of the range as it stood with the keyboard still up", () => {
    expect(start).toContain("maxScrollTop(t.scrollHeight, t.clientHeight)");
    expect(start).toContain("closeFixes = 0");
  });

  it("the frames are bounded by a clock AND a count, and a newer edge owns them", () => {
    expect(src).toContain("const CLOSE_TAIL_MS = 600");
    expect(src).toContain("const CLOSE_TAIL_FRAMES = 90");
    expect(start).toContain("if (run !== closeRun) return");
    expect(start).toContain("i < CLOSE_TAIL_FRAMES && performance.now() - t0 < CLOSE_TAIL_MS");
  });

  it("reads the three numbers once and decides through viewport.ts", () => {
    expect(fix).toContain("const g = { sh: t.scrollHeight, st: t.scrollTop, ch: t.clientHeight }");
    expect(fix).toContain("restoreVerdict(g, settled, closeFixes, gesture)");
    expect(fix).toContain("boxSettled(g, closeBox)");
  });

  it("stands aside for a finger on the frames, and for a fling at the late looks", () => {
    // the dismissing tap is itself inside the intent window, so the frames can
    // only ask about a finger that is down NOW; by 600ms and 2100ms that tap's
    // window has expired and intent means a fling, whose rubber band at the
    // bottom reads exactly like the fault
    expect(fix).toContain(
      'const gesture = threadTouching || (via !== "frame" && userScrollIntent())',
    );
  });

  it("writes through the one settle, so it obeys the one follow-versus-clamp rule", () => {
    expect(fix).toContain('settleTail("kb-restore")');
    // and nothing else in it touches the scroll
    expect(fix).not.toMatch(/scrollTop\s*=/);
    expect(fix).not.toContain("scrollTo(");
  });

  it("records the fault before correcting it, so the trail reads in order", () => {
    expect(fix.indexOf('holdDiagRecord(\n    "kb-restore"')).toBeLessThan(
      fix.indexOf('settleTail("kb-restore")'),
    );
  });

  it("the ordinary states of a close leave no record at all", () => {
    expect(fix).toContain('if (act === "none" || act === "moving" || act === "held") return');
    expect(fix).toContain('if (act === "spent" && closeFixes > MAX_CLOSE_RESTORES) return');
  });

  it("the close's two later checkpoints ask the same question again", () => {
    const gap = fnBody("recordTailGapNow");
    expect(gap).toContain('fixCloseTail(i === 0 ? "gap" : "late")');
    expect(src).toContain("const TAIL_GAP_AT_MS = [SEND_MOTION_WINDOW_MS, 2100] as const");
    // after both readings, so what they describe is the state before the write
    expect(gap.indexOf("tailGapFrame(")).toBeLessThan(gap.indexOf("fixCloseTail("));
  });

  it("nothing outside a close's own window can reach the correction", () => {
    expect(fix).toContain("if (closeAt < 0) return");
    expect(fnBody("closeTailStop")).toContain("closeAt = -1");
    // and the scroller's own scroll events still carry no clamp (the regression
    // the note at the top of the handler describes)
    const handler = src.indexOf('thread.addEventListener("scroll"');
    expect(src.slice(handler, handler + 1400)).not.toContain("fixCloseTail(");
  });
});
