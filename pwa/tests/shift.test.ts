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
import {
  ENTER_RISE_PX,
  FLIGHT_EASE,
  FLIGHT_EASE_POINTS,
  FLIGHT_MS,
  FLIGHT_SLACK_MS,
  MORPH_TEXT_IN,
  MORPH_TEXT_OUT,
  accentAlpha,
  barTextAlpha,
  bubbleTextAlpha,
  flightEase,
  morphBox,
  morphCorners,
  newbornEnter,
  shiftParticipates,
  stampRidesFlight,
} from "../src/shift";

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

  it("the CSS string and the solved curve share the same control points", () => {
    expect(FLIGHT_EASE).toBe(`cubic-bezier(${FLIGHT_EASE_POINTS.join(", ")})`);
  });
});

// The two lost frames. An animation armed mid-task starts its clock before
// the next paint, and this front-loaded ease turns that frame or two into
// 43-60px of a 244px flight already spent on the first frame anyone sees.
// The slack is the measured cure: on device the loss went to exactly zero
// with two frames of runway, held on screen by a backwards fill.
describe("FLIGHT_SLACK_MS: the first painted frame is the true start", () => {
  it("covers the arm-to-paint gap: two 60Hz frames, and not much more", () => {
    expect(FLIGHT_SLACK_MS).toBeGreaterThanOrEqual(33); // two frames at 60Hz
    expect(FLIGHT_SLACK_MS).toBeLessThanOrEqual(50); // a held start, never a felt pause
  });

  it("stays a sliver of the beat, so the flight still reads as one motion", () => {
    expect(FLIGHT_SLACK_MS).toBeLessThanOrEqual(FLIGHT_MS / 8);
  });
});

describe("flightEase — the browser's curve, solved for the morph's rAF frames", () => {
  it("pins the endpoints, clamped past them", () => {
    expect(flightEase(0)).toBe(0);
    expect(flightEase(1)).toBe(1);
    expect(flightEase(-0.2)).toBe(0);
    expect(flightEase(1.3)).toBe(1);
  });

  it("monotone inside [0,1]: the no-overshoot rule holds numerically too", () => {
    let prev = 0;
    for (let i = 1; i <= 100; i++) {
      const y = flightEase(i / 100);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1);
      prev = y;
    }
  });

  it("decelerates: most of the travel lands early, like the CSS twin", () => {
    expect(flightEase(0.35)).toBeGreaterThan(0.8);
    expect(flightEase(0.5)).toBeGreaterThan(flightEase(0.35));
  });
});

describe("morph box math — shape by geometry, never by scale", () => {
  const bar = { left: 12, top: 700, width: 360, height: 39 };
  const seat = { left: 200, top: 620, width: 180, height: 39 };

  it("p=0 is the bar and p=1 is the seat, exactly", () => {
    expect(morphBox(bar, seat, 0)).toEqual(bar);
    expect(morphBox(bar, seat, 1)).toEqual(seat);
  });

  it("mid-flight is the straight mix of the two boxes", () => {
    const half = morphBox(bar, seat, 0.5);
    expect(half.left).toBeCloseTo(106);
    expect(half.top).toBeCloseTo(660);
    expect(half.width).toBeCloseTo(270);
    expect(half.height).toBeCloseTo(39);
  });

  it("corners travel each on their own (the 4px tail corner)", () => {
    expect(morphCorners(18, [18, 18, 4, 18], 0)).toEqual([18, 18, 18, 18]);
    expect(morphCorners(18, [18, 18, 4, 18], 1)).toEqual([18, 18, 4, 18]);
    expect(morphCorners(18, [18, 18, 4, 18], 0.5)).toEqual([18, 18, 11, 18]);
  });
});

describe("morph text crossfade — the rewrap cover", () => {
  it("the bar text is gone before the bubble text begins: no double-text frame", () => {
    expect(MORPH_TEXT_OUT).toBeLessThan(MORPH_TEXT_IN);
  });

  it("bar text: full at launch, gone early", () => {
    expect(barTextAlpha(0)).toBe(1);
    expect(barTextAlpha(MORPH_TEXT_OUT)).toBe(0);
    expect(barTextAlpha(1)).toBe(0);
  });

  it("bubble text: absent until the settle, full exactly at landing", () => {
    expect(bubbleTextAlpha(0)).toBe(0);
    expect(bubbleTextAlpha(MORPH_TEXT_IN)).toBe(0);
    expect(bubbleTextAlpha(1)).toBe(1);
  });

  it("the accent face is solid before the bubble text starts: white lands on blue, never glass", () => {
    expect(accentAlpha(0)).toBe(0);
    expect(accentAlpha(MORPH_TEXT_IN)).toBe(1);
    expect(accentAlpha(1)).toBe(1);
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

describe("stampRidesFlight: the send's stamp belongs to the flight, not the enter", () => {
  it("a newborn stamp over a newborn photo row rides", () => {
    expect(stampRidesFlight(false, true, true)).toBe(true);
  });

  it("a text send's stamp still enters: no shot row, no ride", () => {
    expect(stampRidesFlight(false, true, false)).toBe(false);
  });

  it("only stamps ride this rule; rows have their own owners", () => {
    expect(stampRidesFlight(false, false, true)).toBe(false);
  });

  it("anything the measure pass saw is the FLIP's, as everywhere else", () => {
    expect(stampRidesFlight(true, true, true)).toBe(false);
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
    const fly = send.indexOf("flyFromField(w, morph)");
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
    const tray = send.indexOf("dismissSent()");
    expect(grace).toBeGreaterThan(-1);
    expect(grace).toBeLessThan(clear); // the grace mark still covers the clear
    expect(clear).toBeLessThan(collapse); // clear, then the height re-derive
    // the tray's exit is geometry too: dismissSent takes the strip out of the
    // flow in this same frame, and its close is pure paint after that
    expect(collapse).toBeLessThan(tray);
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
    const fly = send.indexOf("flyFromField(w, morph)");
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

describe("flight slack wiring: the armed clock waits for the first paint", () => {
  const fly = fnBody("flyFromField");

  it("the photo row's FLIP carries the slack and holds its start through it", () => {
    expect(fly).toContain(
      '{ duration: FLIGHT_MS, easing: FLIGHT_EASE, delay: FLIGHT_SLACK_MS, fill: "backwards" }',
    );
  });

  it("the stamp rides the same options, so the pair cannot start apart", () => {
    expect(fly.match(/delay: FLIGHT_SLACK_MS, fill: "backwards"/g)).toHaveLength(2);
  });
});

// The sent photo's date stamp. It entered as a newborn (the 10px fade above),
// which parked it at its final seat, about a fifth visible on its first
// painted frame, drifting 10px while its own row crossed hundreds: a stamp
// hovering over an empty box for the whole flight. It rides its row now.
describe("stamp-ride wiring: the stamp moves with its row, fading from zero", () => {
  const fly = fnBody("flyFromField");
  const begin = fnBody("beginSiblingShift");

  it("the flight animates the wrapper's own stamp on the first row's travel", () => {
    expect(fly).toContain(':scope > .stamp');
    expect(fly).toContain('translate(${rideDx}px, ${rideDy}px)');
    expect(fly).toContain('{ opacity: 1, transform: "none" }');
  });

  it("fades from nothing, and the slack makes the nothing actually paint", () => {
    expect(fly).toContain("opacity: 0");
    expect(fly.indexOf("delay: FLIGHT_SLACK_MS", fly.indexOf(":scope > .stamp")))
      .toBeGreaterThan(-1);
  });

  it("the enter stands down for it: one element, one owner", () => {
    expect(begin).toContain("stampRidesFlight(");
    expect(begin).toContain("stampOverNewbornShot(el, before)");
    // and the rule reads the row kind, so a text send's stamp still enters
    expect(fnBody("stampOverNewbornShot")).toContain(".msg.shot");
  });

  it("stays pure presentation: no receipt gate, no at-bottom inflation entry", () => {
    // the ride ends with its row and moves nothing the ledgers watch; the row
    // beneath it already registers the deeper translate for nearBottom
    const stampAt = fly.indexOf(":scope > .stamp");
    expect(fly.indexOf("flightsUp++", stampAt)).toBe(-1);
    expect(fly.indexOf("airborneRows.add", stampAt)).toBe(-1);
  });

  it("records the ride on the flight channel with its travel", () => {
    expect(fly).toContain('phase: "stamp-ride"');
    expect(fly).toMatch(/phase: "stamp-ride",\s*dx:.*dy:/s);
  });
});
