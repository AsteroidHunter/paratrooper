// Pins for the send-flight polish: the overshooting spring is gone (one clean
// decelerating ease inside the owner's 350-450ms band, shared by the flight
// and the sibling shift), the white-strip fix is wired in the one order that
// works — measure before insert, cancel the old shift set, pin first,
// transforms second — and content BORN with a send (the newborn gap stamp)
// enters on that same beat instead of materializing. The pure half (shift.ts)
// is unit-tested directly; the main.ts wiring is source-pinned like
// flight.test.ts, because main.ts boots a real shell at import and cannot
// load under node.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENTER_RISE_PX, FLIGHT_EASE, FLIGHT_MS, newbornEnter, shiftParticipates } from "../src/shift";

describe("flight motion constants", () => {
  it("the beat sits inside the owner's 350-450ms band", () => {
    expect(FLIGHT_MS).toBeGreaterThanOrEqual(350);
    expect(FLIGHT_MS).toBeLessThanOrEqual(450);
  });

  it("the ease is a cubic-bezier with no overshoot (every y at or below 1)", () => {
    const m = FLIGHT_EASE.match(
      /^cubic-bezier\(\s*([\d.]+)\s*,\s*([\d.-]+)\s*,\s*([\d.]+)\s*,\s*([\d.-]+)\s*\)$/,
    );
    expect(m).not.toBeNull();
    const [, x1, y1, x2, y2] = m!.map(Number);
    expect(y1).toBeLessThanOrEqual(1); // >1 was the spring's bounce
    expect(y2).toBeLessThanOrEqual(1);
    expect(y1).toBeGreaterThanOrEqual(0); // and no anticipation dip either
    expect(y2).toBeGreaterThanOrEqual(0);
    expect(x1).toBeLessThan(x2); // decelerating: fast launch, soft landing
  });
});

describe("shiftParticipates — which preceding elements ride the shift", () => {
  const view = { top: 100, bottom: 800 };

  it("an element that did not move up is out (no gap to close)", () => {
    expect(shiftParticipates(300, 340, 0, view.top, view.bottom)).toBe(false);
    expect(shiftParticipates(300, 340, 0.4, view.top, view.bottom)).toBe(false);
    expect(shiftParticipates(300, 340, -20, view.top, view.bottom)).toBe(false);
  });

  it("a visible element that moved up rides", () => {
    expect(shiftParticipates(600, 640, 48, view.top, view.bottom)).toBe(true);
  });

  it("an element far above the viewport moves invisibly: out", () => {
    // even at its glide start (delta below its new spot) it never enters view
    expect(shiftParticipates(-500, -460, 48, view.top, view.bottom)).toBe(false);
  });

  it("an element just above the top edge whose glide path crosses in rides", () => {
    // new spot above view, but it STARTS delta lower — visible at launch
    expect(shiftParticipates(60, 90, 48, view.top, view.bottom)).toBe(true);
  });

  it("an element below the viewport bottom is out", () => {
    expect(shiftParticipates(900, 940, 48, view.top, view.bottom)).toBe(false);
  });
});

describe("newbornEnter — content born with the send rides the same beat", () => {
  it("a newborn that does not carry the flight enters (the gap stamp case)", () => {
    expect(newbornEnter(false, false)).toBe(true);
  });

  it("anything the measure pass saw belongs to the FLIP shift, never the enter", () => {
    expect(newbornEnter(true, false)).toBe(false);
  });

  it("the flying bubble's own rows are the flight's — no double treatment", () => {
    expect(newbornEnter(false, true)).toBe(false);
    expect(newbornEnter(true, true)).toBe(false);
  });

  it("the rise stays small, inside the 8-12px family of the pop-in", () => {
    expect(ENTER_RISE_PX).toBeGreaterThanOrEqual(8);
    expect(ENTER_RISE_PX).toBeLessThanOrEqual(12);
  });
});

// --- main.ts wiring pins (source-read, like flight.test.ts) -------------------

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

describe("flyFromField uses the shared clean ease", () => {
  const body = fnBody("flyFromField");

  it("animates on FLIGHT_MS / FLIGHT_EASE, spring gone for good", () => {
    expect(body).toContain("duration: FLIGHT_MS, easing: FLIGHT_EASE");
    expect(body).not.toContain("1.08");
    expect(body).not.toContain("450");
  });
});

describe("sibling shift wiring — the order that kills the white strip", () => {
  const send = fnBody("send");
  const begin = fnBody("beginSiblingShift");

  it("send measures before the wrapper exists, pins first, transforms second", () => {
    const measure = send.indexOf("beginSiblingShift()");
    const wrapper = send.indexOf('localWrapper("user")');
    const pin = send.indexOf("scrollToBottom(true)");
    const play = send.indexOf("shift.play()");
    const fly = send.indexOf("flyFromField(w)");
    expect(measure).toBeGreaterThan(-1);
    expect(measure).toBeLessThan(wrapper); // before-rects predate the insert
    expect(pin).toBeLessThan(play); // the pin fires first
    expect(play).toBeLessThan(fly); // then the shift, then the flight
  });

  it("a fresh launch collapses the composer first (the mid-flight drag fix)", () => {
    // a multi-line send used to clear + autosize AFTER the launch: the bar
    // shrank 82 -> 39 mid-flight and the pin riding the resize moved the
    // fresh bubble's seat under it. On a fresh launch the collapse (clear,
    // autosize, pending tray) now precedes the measure and the flight, so
    // the launch measures final geometry and departs from the collapsed bar.
    const grace = send.indexOf("composerWroteAt = performance.now()");
    const clear = send.indexOf('textEl.value = ""');
    const collapse = send.indexOf("autosize()");
    const tray = send.indexOf("renderPending()");
    expect(grace).toBeGreaterThan(-1);
    expect(grace).toBeLessThan(clear); // the grace mark still covers the clear
    expect(clear).toBeLessThan(collapse); // clear, then the height re-derive
    expect(collapse).toBeLessThan(tray); // the tray collapse is geometry too
    const freshCollapse = send.indexOf("collapseBar();");
    const measure = send.indexOf("beginSiblingShift()");
    expect(freshCollapse).toBeGreaterThan(-1);
    expect(freshCollapse).toBeLessThan(measure); // settled bar, then before-rects
  });

  it("a resized bar on a fresh launch waits out its re-pin (no pin mid-air)", () => {
    // the threadObserver's pin for the bar resize lands after the launch
    // frame's rAF callbacks and reads a scrollHeight inflated by the flying
    // bubble's translate — so a fresh send whose bar resized waits two rAFs
    // (collapse painted, honest re-pin done) before measuring and launching
    const wait = send.indexOf("requestAnimationFrame");
    const freshCollapse = send.indexOf("collapseBar();");
    const measure = send.indexOf("beginSiblingShift()");
    expect(wait).toBeGreaterThan(freshCollapse);
    expect(wait).toBeLessThan(measure);
    expect(send.slice(wait)).toMatch(/requestAnimationFrame\(\(\) => requestAnimationFrame/);
  });

  it("composing onto a live flight keeps the shipped order (collapse last)", () => {
    // a collapse landing between the measure and the launch would lower the
    // field and shrink the sibling deltas, tearing a band open between the
    // riding first bubble and the departing second one — so a send within
    // FLIGHT_MS of the last launch defers the collapse past the launch
    const fly = send.indexOf("flyFromField(w)");
    const airborneCollapse = send.lastIndexOf("collapseBar();");
    expect(send).toContain("lastLaunchAt < FLIGHT_MS"); // the airborne test
    expect(send).toContain("if (airborne) collapseBar();");
    expect(airborneCollapse).toBeGreaterThan(fly);
  });

  it("before-tops are measured with mid-flight transforms still applied", () => {
    // measure first, cancel second: a second rapid send composes from where
    // the first shift visually is instead of snapping
    const measure = begin.indexOf("getBoundingClientRect()");
    const cancel = begin.indexOf("a.cancel()");
    expect(measure).toBeGreaterThan(-1);
    expect(cancel).toBeGreaterThan(measure);
  });

  it("the new set replaces the registry, so consecutive sends compose cleanly", () => {
    expect(begin).toContain("shiftAnims = []");
    expect(begin).toContain("shiftAnims.push(");
  });

  it("shift rows animate on the flight's own beat and ease", () => {
    expect(begin).toContain("duration: FLIGHT_MS, easing: FLIGHT_EASE");
    expect(begin).toContain("shiftParticipates(");
  });

  it("records the shift start with the measured delta, and the away skip", () => {
    expect(begin).toContain('phase: "shift-start"');
    expect(begin).toMatch(/delta:.*rows/s);
    expect(begin).toContain('phase: "shift-skip"');
  });
});

describe("newborn enter wiring — born content never materializes mid-motion", () => {
  const begin = fnBody("beginSiblingShift");
  const enter = fnBody("enterNewborn");

  it("the enter fades up from the rise to rest, on the shared beat and ease", () => {
    expect(enter).toContain("opacity: 0");
    expect(enter).toContain("translateY(${ENTER_RISE_PX}px)");
    expect(enter).toContain('{ opacity: 1, transform: "none" }');
    expect(enter).toContain("duration: FLIGHT_MS, easing: FLIGHT_EASE");
  });

  it("play walks the true tail, so the new wrapper's own stamp is in reach", () => {
    // the old walk stopped above the wrapper — exactly why the stamp was
    // never animated in any build
    expect(begin).not.toContain("laidOutTail(w)");
    expect(begin.match(/laidOutTail\(\)/g)).toHaveLength(2);
  });

  it("newborns take the enter branch before the FLIP can see them", () => {
    const decide = begin.indexOf("newbornEnter(");
    const flip = begin.indexOf("shiftParticipates(");
    expect(decide).toBeGreaterThan(-1);
    expect(decide).toBeLessThan(flip);
    expect(begin).toContain("enterNewborn(el)");
  });

  it("the flying bubble is excluded by its .msg cargo", () => {
    expect(begin).toContain('el.querySelector(".msg")');
    expect(begin).toContain('el.classList.contains("msg")');
  });

  it("records the enter phase with the newborn count, even a zero", () => {
    expect(begin).toContain('phase: "enter"');
    expect(begin).toContain("n: entered");
  });
});

describe("live-arrival stamps — the receive side of the same enter", () => {
  const dec = fnBody("decorate");

  it("a stamp born beside a live .anim row enters; replay/history stay static", () => {
    expect(dec).toContain("enterNewborn(stamp)");
    expect(dec).toContain("!suppressAnim");
    expect(dec).toContain('querySelector(".msg.anim")');
  });

  it("only a freshly created stamp enters — a refreshed one never re-pops", () => {
    expect(dec).toContain("born && !suppressAnim");
    expect(dec).toContain("const born = stamp === null");
  });

  it("records the live enter on the trail", () => {
    expect(dec).toContain('src: "live"');
  });
});
