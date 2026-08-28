// The photo send flight's geometry (src/gather.ts), and the composite main.ts
// builds out of it: gather into one bundle, carry into the seats, crop opening
// all the way. main.ts writes the boxes, so the simulator below mirrors that
// arithmetic exactly and the properties are checked on the numbers a frame
// would actually be painted from.
import { describe, expect, it } from "vitest";
import {
  DECK_STEP_PX,
  GATHER_MS,
  SHOT_BEND,
  bundleSeats,
  coverBox,
  elbowBox,
  elbowPath,
  gatherMsFor,
  shotLeg,
} from "../src/gather";
import { FLIGHT_MS, flightEase, morphBox } from "../src/shift";
import type { MorphBox } from "../src/shift";
import { zoomClipInset } from "../src/zoom";

const THUMB = 64; // styles.css .pthumb img: the hard square a pick waits in

const square = (left: number, top: number, size = THUMB): MorphBox => ({
  left, top, width: size, height: size,
});

// the strip lays its squares in a wrapping row, 0.75rem in and 0.4rem apart
const strip = (n: number, top = 700): MorphBox[] =>
  Array.from({ length: n }, (_, i) => square(12 + i * (THUMB + 6.4), top));

const area = (b: MorphBox): number => b.width * b.height;
const centre = (b: MorphBox): [number, number] => [b.left + b.width / 2, b.top + b.height / 2];

const union = (boxes: MorphBox[]): MorphBox => {
  const left = Math.min(...boxes.map((b) => b.left));
  const top = Math.min(...boxes.map((b) => b.top));
  const right = Math.max(...boxes.map((b) => b.left + b.width));
  const bottom = Math.max(...boxes.map((b) => b.top + b.height));
  return { left, top, width: right - left, height: bottom - top };
};

describe("gatherMsFor: a lone photo has no arrangement to change", () => {
  it("one photo skips the gather outright", () => {
    expect(gatherMsFor(1)).toBe(0);
  });

  it("two or more photos gather first", () => {
    expect(gatherMsFor(2)).toBe(GATHER_MS);
    expect(gatherMsFor(3)).toBe(GATHER_MS);
    expect(gatherMsFor(9)).toBe(GATHER_MS);
  });

  it("no photos at all is not a flight", () => {
    expect(gatherMsFor(0)).toBe(0);
  });

  it("the gather stays a short beat beside the carry it precedes", () => {
    expect(GATHER_MS).toBeGreaterThan(0);
    expect(GATHER_MS).toBeLessThan(FLIGHT_MS / 2);
  });
});

describe("bundleSeats: the squares cluster into one deck", () => {
  it("a lone square's bundle IS that square, so its gather moves nothing", () => {
    const only = square(12, 700);
    expect(bundleSeats([only])).toEqual([only]);
  });

  it("nothing picked, nothing to gather", () => {
    expect(bundleSeats([])).toEqual([]);
  });

  it("the deck sits on the middle of the picked squares", () => {
    const squares = strip(3);
    const seats = bundleSeats(squares);
    const [sx, sy] = centre(union(squares));
    const [bx, by] = centre(union(seats));
    expect(bx).toBeCloseTo(sx, 6);
    expect(by).toBeCloseTo(sy, 6);
  });

  it("gathering collapses a strip-wide group down to one square plus a shoulder", () => {
    const squares = strip(3);
    const before = union(squares);
    const after = union(bundleSeats(squares));
    expect(before.width).toBeCloseTo(THUMB * 3 + 6.4 * 2, 6); // three across the strip
    expect(after.width).toBeCloseTo(THUMB + DECK_STEP_PX * 2, 6); // one object
    expect(after.height).toBeCloseTo(THUMB + DECK_STEP_PX * 2, 6);
    expect(area(after)).toBeLessThan(area(before) / 2);
  });

  it("every seat keeps its own square's size: a gather is a move, not a resize", () => {
    for (const seat of bundleSeats(strip(4))) {
      expect(seat.width).toBe(THUMB);
      expect(seat.height).toBe(THUMB);
    }
  });

  it("the deck steps by one shoulder per photo, down and right with the index", () => {
    const seats = bundleSeats(strip(4));
    for (let i = 1; i < seats.length; i++) {
      expect(seats[i].left - seats[i - 1].left).toBeCloseTo(DECK_STEP_PX, 6);
      expect(seats[i].top - seats[i - 1].top).toBeCloseTo(DECK_STEP_PX, 6);
    }
  });

  it("the deck is symmetric about the middle for odd and for even counts", () => {
    for (const n of [2, 3, 4, 5]) {
      const squares = strip(n);
      const seats = bundleSeats(squares);
      const [cx, cy] = centre(union(squares));
      const [dx, dy] = centre(union(seats));
      expect(dx).toBeCloseTo(cx, 6);
      expect(dy).toBeCloseTo(cy, 6);
    }
  });

  it("squares wrapped onto a second line still gather to the middle of the group", () => {
    const squares = [square(12, 640), square(82.4, 640), square(12, 710)];
    const seats = bundleSeats(squares);
    const [cx, cy] = centre(union(seats));
    expect(cx).toBeCloseTo((44 + 114.4 + 44) / 3, 6);
    expect(cy).toBeCloseTo((672 + 672 + 742) / 3, 6);
  });

  it("a wider shoulder spreads the deck and nothing else", () => {
    const squares = strip(3);
    const tight = union(bundleSeats(squares, 1));
    const loose = union(bundleSeats(squares, 8));
    expect(loose.width - tight.width).toBeCloseTo((8 - 1) * 2, 6);
    expect(centre(loose)).toEqual(centre(tight));
  });
});

describe("shotLeg: two legs on one clock", () => {
  it("a gather of zero is already carrying on the first frame", () => {
    expect(shotLeg(0, 0, FLIGHT_MS)).toEqual({ leg: "carry", f: 0, done: false });
    expect(shotLeg(FLIGHT_MS / 2, 0, FLIGHT_MS).leg).toBe("carry");
  });

  it("the gather owns the clock until it is spent", () => {
    expect(shotLeg(0, GATHER_MS, FLIGHT_MS)).toEqual({ leg: "gather", f: 0, done: false });
    expect(shotLeg(GATHER_MS / 2, GATHER_MS, FLIGHT_MS).f).toBeCloseTo(0.5, 6);
    expect(shotLeg(GATHER_MS - 0.01, GATHER_MS, FLIGHT_MS).leg).toBe("gather");
  });

  it("the handover is exact: the gather's end and the carry's start share the instant", () => {
    expect(shotLeg(GATHER_MS, GATHER_MS, FLIGHT_MS)).toEqual({
      leg: "carry", f: 0, done: false,
    });
  });

  it("the carry ends the flight and stays ended", () => {
    expect(shotLeg(GATHER_MS + FLIGHT_MS, GATHER_MS, FLIGHT_MS)).toEqual({
      leg: "carry", f: 1, done: true,
    });
    expect(shotLeg(9999, GATHER_MS, FLIGHT_MS)).toEqual({ leg: "carry", f: 1, done: true });
  });

  it("a clock read before its own zero never runs the curve backwards", () => {
    expect(shotLeg(-5, GATHER_MS, FLIGHT_MS).f).toBe(0);
    expect(shotLeg(-5, 0, FLIGHT_MS).f).toBe(0);
  });

  it("no carry to run means there is nothing left to wait for once the gather is spent", () => {
    expect(shotLeg(0, GATHER_MS, 0).leg).toBe("gather");
    expect(shotLeg(GATHER_MS, GATHER_MS, 0)).toEqual({ leg: "carry", f: 1, done: true });
    expect(shotLeg(0, 0, 0)).toEqual({ leg: "carry", f: 1, done: true });
  });
});

describe("coverBox: the box behind a 64px cover crop", () => {
  it("a landscape photo overflows sideways and is centred on the square", () => {
    const box = coverBox(square(0, 0), 4032, 3024);
    expect(box.height).toBeCloseTo(THUMB, 6); // the short side is what covers
    expect(box.width).toBeCloseTo((THUMB * 4032) / 3024, 6);
    expect(box.left).toBeCloseTo(-(box.width - THUMB) / 2, 6); // equal overhang both sides
    expect(box.top).toBeCloseTo(0, 6);
  });

  it("a portrait photo overflows up and down instead", () => {
    const box = coverBox(square(0, 0), 3024, 4032);
    expect(box.width).toBeCloseTo(THUMB, 6);
    expect(box.height).toBeCloseTo((THUMB * 4032) / 3024, 6);
    expect(box.top).toBeCloseTo(-(box.height - THUMB) / 2, 6);
  });

  it("a square photo fills the square exactly, nothing cropped", () => {
    expect(coverBox(square(10, 20), 1000, 1000)).toEqual(square(10, 20));
  });

  it("the box always contains the square: that IS covering it", () => {
    for (const [w, h] of [[4032, 3024], [3024, 4032], [1170, 2532], [800, 800]]) {
      const s = square(12, 700);
      const b = coverBox(s, w, h);
      expect(b.left).toBeLessThanOrEqual(s.left + 1e-9);
      expect(b.top).toBeLessThanOrEqual(s.top + 1e-9);
      expect(b.left + b.width).toBeGreaterThanOrEqual(s.left + s.width - 1e-9);
      expect(b.top + b.height).toBeGreaterThanOrEqual(s.top + s.height - 1e-9);
    }
  });

  it("a photo with no dimensions yet falls back to the square it stands in", () => {
    expect(coverBox(square(5, 6), 0, 0)).toEqual(square(5, 6));
  });

  it("the box travels with the square and keeps its size", () => {
    const a = coverBox(square(0, 0), 4032, 3024);
    const b = coverBox(square(70, 9), 4032, 3024);
    expect(b.width).toBeCloseTo(a.width, 6);
    expect(b.height).toBeCloseTo(a.height, 6);
    expect(b.left - a.left).toBeCloseTo(70, 6);
    expect(b.top - a.top).toBeCloseTo(9, 6);
  });
});

// --- the composite: what a frame is actually painted from ----------------------
// main.ts armShotMorph writes, per photo per frame, a BOX (where the whole
// photo sits) and a CUT (the window onto it). The simulator below is that same
// arithmetic; every property after it is read off the frames it produces.

interface Frame {
  box: MorphBox;
  cut: MorphBox;
}

// The bend is a parameter here and a constant in main.ts, so the same
// simulator can be run against the square corner and against the diagonal and
// the shipped value can be measured beside both of them.
function flight(
  squares: MorphBox[],
  seats: MorphBox[],
  nat: [number, number],
  bend: number = SHOT_BEND,
): (elapsed: number) => Frame[] {
  const bundle = bundleSeats(squares);
  const gatherMs = gatherMsFor(squares.length);
  return (elapsed: number): Frame[] => {
    const at = shotLeg(elapsed, gatherMs, FLIGHT_MS);
    const p = flightEase(at.f);
    const onward = at.leg === "carry";
    const path = onward ? elbowPath(p, bend) : null; // the gather has no corner
    return squares.map((s, i) => {
      const from = onward ? bundle[i] : s;
      const to = onward ? seats[i] : bundle[i];
      const cover = coverBox(from, nat[0], nat[1]);
      return {
        cut: path ? elbowBox(from, to, p, path) : morphBox(from, to, p),
        box: path
          ? elbowBox(cover, to, p, path)
          : morphBox(cover, coverBox(to, nat[0], nat[1]), p),
      };
    });
  };
}

const NAT: [number, number] = [4032, 3024]; // a phone camera's landscape photo
// three stacked rows in the thread: .msg caps at 75% of a 390px row
const SEAT_W = 390 * 0.75;
const SEAT_H = (SEAT_W * NAT[1]) / NAT[0];
const seatsFor = (n: number, top = 300): MorphBox[] =>
  Array.from({ length: n }, (_, i) => ({
    left: 390 - 12 - SEAT_W, top: top + i * SEAT_H, width: SEAT_W, height: SEAT_H,
  }));

const sweep = (ms: number, steps = 60): number[] =>
  Array.from({ length: steps + 1 }, (_, i) => (ms * i) / steps);

describe("the flight as one object", () => {
  const squares = strip(3);
  const seats = seatsFor(3);
  const at = flight(squares, seats, NAT);
  const gatherEnd = GATHER_MS;
  const end = GATHER_MS + FLIGHT_MS;

  it("the first frame is the strip exactly as it stands: nothing jumps on launch", () => {
    at(0).forEach((f, i) => {
      expect(f.cut.left).toBeCloseTo(squares[i].left, 6);
      expect(f.cut.top).toBeCloseTo(squares[i].top, 6);
      expect(f.cut.width).toBeCloseTo(THUMB, 6);
      expect(f.cut.height).toBeCloseTo(THUMB, 6);
    });
  });

  it("the gather ends on the deck and the carry starts on it: no jump at the handover", () => {
    const before = at(gatherEnd - 0.001);
    const after = at(gatherEnd);
    before.forEach((f, i) => {
      expect(f.cut.left).toBeCloseTo(after[i].cut.left, 3);
      expect(f.cut.top).toBeCloseTo(after[i].cut.top, 3);
      expect(f.box.left).toBeCloseTo(after[i].box.left, 3);
      expect(f.box.width).toBeCloseTo(after[i].box.width, 3);
    });
  });

  it("the group's footprint shrinks to one object over the gather and never re-spreads", () => {
    let last = Infinity;
    for (const t of sweep(gatherEnd)) {
      const w = union(at(t).map((f) => f.cut)).width;
      expect(w).toBeLessThanOrEqual(last + 1e-6);
      last = w;
    }
    expect(last).toBeCloseTo(THUMB + DECK_STEP_PX * 2, 3);
  });

  it("the carry leaves as one object: the whole group starts inside one square's span", () => {
    const start = union(at(gatherEnd).map((f) => f.cut));
    expect(start.width).toBeCloseTo(THUMB + DECK_STEP_PX * 2, 3);
    expect(start.height).toBeCloseTo(THUMB + DECK_STEP_PX * 2, 3);
  });

  it("the object only ever climbs and only ever grows: nothing doubles back", () => {
    // the L turns the travel sideways at the end but it never reverses either
    // axis, and the top edge is still climbing as the last of the width
    // arrives, because the box grows about its own middle
    let prevTop = Infinity;
    let prevW = -Infinity;
    for (const t of sweep(end).filter((t) => t >= gatherEnd)) {
      const u = union(at(t).map((f) => f.cut));
      expect(u.top).toBeLessThanOrEqual(prevTop + 1e-6);
      expect(u.width).toBeGreaterThanOrEqual(prevW - 1e-6);
      prevTop = u.top;
      prevW = u.width;
    }
  });

  it("the picture is never stretched: its own shape holds on every frame", () => {
    // both ends of the carry are the photo's true ratio (the cover box by
    // construction, the seat because the thread reserves it from the same two
    // numbers), so interpolating the box can only ever pass through that ratio
    const want = NAT[0] / NAT[1];
    for (const t of sweep(end, 120)) {
      for (const f of at(t)) {
        expect(f.box.width / f.box.height).toBeCloseTo(want, 6);
      }
    }
  });

  it("every photo lands on its own seat, uncropped, on the last frame", () => {
    at(end).forEach((f, i) => {
      expect(f.cut.left).toBeCloseTo(seats[i].left, 6);
      expect(f.cut.top).toBeCloseTo(seats[i].top, 6);
      expect(f.cut.width).toBeCloseTo(seats[i].width, 6);
      expect(f.cut.height).toBeCloseTo(seats[i].height, 6);
      const cut = zoomClipInset(f.box, f.cut);
      expect(cut.top + cut.right + cut.bottom + cut.left).toBeCloseTo(0, 6);
    });
  });
});

describe("the crop opening out", () => {
  const squares = strip(3);
  const seats = seatsFor(3);
  const at = flight(squares, seats, NAT);
  const end = GATHER_MS + FLIGHT_MS;

  it("the first frame shows the middle of the photo and nothing else", () => {
    const [f] = at(0);
    const inset = zoomClipInset(f.box, f.cut);
    expect(inset.left).toBeGreaterThan(0); // a landscape photo is cut on the sides
    expect(inset.right).toBeCloseTo(inset.left, 6); // and cut equally
    expect(inset.top).toBeCloseTo(0, 6);
    expect(area(f.cut) / area(f.box)).toBeLessThan(0.8); // most of it is hidden
  });

  it("the cut is never wider than the picture, so no frame paints past its own edge", () => {
    for (const t of sweep(end, 120)) {
      for (const f of at(t)) {
        const i = zoomClipInset(f.box, f.cut);
        expect(i.top).toBeGreaterThanOrEqual(0);
        expect(i.right).toBeGreaterThanOrEqual(0);
        expect(i.bottom).toBeGreaterThanOrEqual(0);
        expect(i.left).toBeGreaterThanOrEqual(0);
        expect(f.box.left).toBeLessThanOrEqual(f.cut.left + 1e-6);
        expect(f.box.left + f.box.width).toBeGreaterThanOrEqual(
          f.cut.left + f.cut.width - 1e-6,
        );
      }
    }
  });

  it("the share of the photo on show only ever grows, from a crop to the whole thing", () => {
    let last = -Infinity;
    for (const t of sweep(end, 120)) {
      const [f] = at(t);
      const shown = area(f.cut) / area(f.box);
      expect(shown).toBeGreaterThanOrEqual(last - 1e-9);
      last = shown;
    }
    expect(last).toBeCloseTo(1, 6);
  });

  it("the crop holds still through the gather and opens only on the carry", () => {
    const shown = (t: number): number => {
      const [f] = at(t);
      return area(f.cut) / area(f.box);
    };
    expect(shown(GATHER_MS / 2)).toBeCloseTo(shown(0), 6);
    expect(shown(GATHER_MS)).toBeCloseTo(shown(0), 6);
    expect(shown(GATHER_MS + FLIGHT_MS / 2)).toBeGreaterThan(shown(0) + 0.05);
  });

  it("a portrait photo opens top and bottom instead of left and right", () => {
    const tall: [number, number] = [3024, 4032];
    const one = flight([square(12, 700)], seatsFor(1), tall);
    const [f] = one(0);
    const i = zoomClipInset(f.box, f.cut);
    expect(i.top).toBeGreaterThan(0);
    expect(i.bottom).toBeCloseTo(i.top, 6);
    expect(i.left).toBeCloseTo(0, 6);
  });
});

describe("one photo: the same flight minus the gather", () => {
  const squares = strip(1);
  const seats = seatsFor(1);
  const at = flight(squares, seats, NAT);

  it("the first frame is already moving, not waiting out a gather", () => {
    const start = at(0)[0];
    const soon = at(16)[0];
    expect(start.cut.left).toBeCloseTo(squares[0].left, 6);
    expect(soon.cut.top).toBeLessThan(start.cut.top); // already climbing
    expect(soon.cut.width).toBeGreaterThan(start.cut.width); // already growing
  });

  it("the whole thing is over in one carry, with no gather spent first", () => {
    const landed = at(FLIGHT_MS)[0];
    expect(landed.cut.left).toBeCloseTo(seats[0].left, 6);
    expect(landed.cut.width).toBeCloseTo(seats[0].width, 6);
    expect(zoomClipInset(landed.box, landed.cut).left).toBeCloseTo(0, 6);
  });

  it("its bundle is its own square, so the gather would have moved it nowhere", () => {
    expect(bundleSeats(squares)).toEqual(squares);
  });

  it("its crop opens from the first frame, not from the gather's end", () => {
    const shown = (t: number): number => {
      const f = at(t)[0];
      return area(f.cut) / area(f.box);
    };
    expect(shown(GATHER_MS)).toBeGreaterThan(shown(0) + 0.05);
  });
});

// --- the L: straight up first, then across ------------------------------------
// The carry's path. Not a diagonal off the compose bar but a rise and then a
// run, with the corner between the two rounded rather than square. elbowPath
// is the whole shape and SHOT_BEND is the only number in it.

describe("elbowPath: the rise leads, the run follows", () => {
  const many = sweep(1, 400); // the eased progress, end to end

  it("both legs start and finish with the carry, and neither runs backwards", () => {
    expect(elbowPath(0)).toEqual({ up: 0, across: 0 });
    expect(elbowPath(1)).toEqual({ up: 1, across: 1 });
    let prev = elbowPath(0);
    for (const p of many) {
      const now = elbowPath(p);
      expect(now.up).toBeGreaterThanOrEqual(prev.up - 1e-12);
      expect(now.across).toBeGreaterThanOrEqual(prev.across - 1e-12);
      prev = now;
    }
  });

  it("the rise is ahead of the run at every moment in between", () => {
    for (const p of many) {
      const { up, across } = elbowPath(p);
      expect(up).toBeGreaterThanOrEqual(across - 1e-12);
    }
    expect(elbowPath(0.5).up).toBeGreaterThan(elbowPath(0.5).across + 0.5);
  });

  it("the run has not begun while the rise is still on its straight stretch", () => {
    const opens = (1 - SHOT_BEND) / 2;
    expect(elbowPath(opens).across).toBe(0);
    expect(elbowPath(opens - 0.05).across).toBe(0);
    expect(elbowPath(opens).up).toBeGreaterThan(0.5); // over half the height already
  });

  it("the rise is spent while the run still has better than a third to make", () => {
    const spent = (1 + SHOT_BEND) / 2;
    expect(elbowPath(spent).up).toBe(1);
    expect(elbowPath(spent + 0.05).up).toBe(1);
    expect(elbowPath(spent).across).toBeLessThan(0.66);
    expect(elbowPath(spent).across).toBeGreaterThan(0); // and it is already under way
  });

  it("the corner IS the overlap: moments where both legs are moving at once", () => {
    const both = many.filter((p) => {
      const { up, across } = elbowPath(p);
      return up > 0 && up < 1 && across > 0 && across < 1;
    });
    expect(both.length).toBeGreaterThan(many.length / 20);
    // a square corner has no such moment: the rise is finished before the run
    // is allowed to start, which is the stop and turn nobody wants
    const square = many.filter((p) => {
      const { up, across } = elbowPath(p, 0);
      return up > 0 && up < 1 && across > 0 && across < 1;
    });
    expect(square).toHaveLength(0);
  });

  it("the bend at its limit is the diagonal again: one motion on both axes", () => {
    for (const p of many) {
      const { up, across } = elbowPath(p, 1);
      expect(up).toBeCloseTo(across, 12);
    }
  });

  it("a bend outside its range is clamped, never divided by nothing", () => {
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      expect(elbowPath(p, -3)).toEqual(elbowPath(p, 0));
      expect(elbowPath(p, 9)).toEqual(elbowPath(p, 1));
      expect(Number.isFinite(elbowPath(p, -3).up)).toBe(true);
      expect(Number.isFinite(elbowPath(p, 9).across)).toBe(true);
    }
  });

  it("the shipped bend leaves a straight stretch on each leg and a turn between", () => {
    expect(SHOT_BEND).toBeGreaterThan(0); // not a square corner
    expect(SHOT_BEND).toBeLessThan(1); // not the diagonal
    expect(SHOT_BEND).toBeLessThan(0.5); // each leg keeps more straight than turn
    expect(elbowPath((1 - SHOT_BEND) / 2).up).toBeGreaterThan(0.5);
    expect(elbowPath((1 + SHOT_BEND) / 2).across).toBeLessThan(0.5);
  });
});

describe("elbowBox: the legs move the middle, the shared progress sizes the box", () => {
  const from = square(12, 700);
  const to: MorphBox = { left: 85.5, top: 300, width: 292.5, height: 219.375 };

  it("the ends are exact: it leaves the square and lands on the seat", () => {
    expect(elbowBox(from, to, 0, { up: 0, across: 0 })).toEqual(from);
    expect(elbowBox(from, to, 1, { up: 1, across: 1 })).toEqual(to);
  });

  it("the size rides the shared progress and neither leg can touch it", () => {
    for (const p of sweep(1, 40)) {
      for (const at of [{ up: 0, across: 0 }, { up: 1, across: 0 }, { up: 1, across: 1 }]) {
        const b = elbowBox(from, to, p, at);
        expect(b.width).toBeCloseTo(from.width + (to.width - from.width) * p, 9);
        expect(b.height).toBeCloseTo(from.height + (to.height - from.height) * p, 9);
      }
    }
  });

  it("a stalled leg stalls the middle, not an edge: the rise stays straight", () => {
    // the same progress at two different points of the run, the rise held: the
    // middle must not have moved sideways by so much as a pixel, even though
    // the box has grown around it
    const a = elbowBox(from, to, 0.4, { up: 0.9, across: 0 });
    const b = elbowBox(from, to, 0.4, { up: 0.4, across: 0 });
    expect(centre(a)[0]).toBeCloseTo(centre(from)[0], 9);
    expect(centre(b)[0]).toBeCloseTo(centre(from)[0], 9);
    expect(a.left).toBeCloseTo(b.left, 9); // and the grown box is still centred
  });
});

describe("the L as it is painted: one photo and several", () => {
  for (const n of [1, 3]) {
    const label = n === 1 ? "one photo" : "three photos";
    const squares = strip(n);
    const seats = seatsFor(n);
    const at = flight(squares, seats, NAT);
    const start = bundleSeats(squares)[0]; // where the carry begins, gather or not
    const carry = gatherMsFor(n); // the clock instant the carry starts

    // how much of the carry's two legs the first photo's middle has made
    const made = (t: number): { up: number; across: number } => {
      const [cx, cy] = centre(at(t)[0].cut);
      const [fx, fy] = centre(start);
      const [tx, ty] = centre(seats[0]);
      return { up: (cy - fy) / (ty - fy), across: (cx - fx) / (tx - fx) };
    };
    const when = (reached: (m: { up: number; across: number }) => boolean): number => {
      for (const t of sweep(FLIGHT_MS, 400)) if (reached(made(carry + t))) return carry + t;
      return NaN; // never reached: every reading off it fails, which is the point
    };

    it(`${label}: the middle goes straight up before it goes sideways at all`, () => {
      const startX = centre(start)[0];
      let rose = 0;
      for (const t of sweep(FLIGHT_MS, 400)) {
        const [cx, cy] = centre(at(carry + t)[0].cut);
        if (Math.abs(cx - startX) > 0.01) break; // the run has picked up
        rose = centre(start)[1] - cy;
      }
      const whole = centre(start)[1] - centre(seats[0])[1];
      expect(rose / whole).toBeGreaterThan(0.5); // over half the height, dead straight
    });

    it(`${label}: the rise is spent before the run is half made`, () => {
      expect(made(when((m) => m.across >= 0.5)).up).toBeGreaterThan(0.99);
    });

    it(`${label}: the run is barely begun when the rise is nearly done`, () => {
      expect(made(when((m) => m.up >= 0.9)).across).toBeLessThan(0.25);
    });

    it(`${label}: the path leaves the straight line it replaced, on the rise's side`, () => {
      const [fx, fy] = centre(start);
      const [tx, ty] = centre(seats[0]);
      const vx = tx - fx;
      const vy = ty - fy;
      const len = Math.hypot(vx, vy);
      let worst = 0;
      for (const t of sweep(FLIGHT_MS, 400)) {
        const [cx, cy] = centre(at(carry + t)[0].cut);
        const off = ((cx - fx) * vy - (cy - fy) * vx) / len;
        if (Math.abs(off) > Math.abs(worst)) worst = off;
      }
      expect(worst).toBeGreaterThan(0); // above the line, which is the rise's side
      // a fifth of the whole line's length away from it at the widest: a bow
      // this deep cannot be mistaken for the diagonal it replaced
      expect(worst / len).toBeGreaterThan(0.2);
    });

    it(`${label}: the bend at its limit puts the path back on that straight line`, () => {
      const straight = flight(squares, seats, NAT, 1);
      const [fx, fy] = centre(start);
      const [tx, ty] = centre(seats[0]);
      const vx = tx - fx;
      const vy = ty - fy;
      for (const t of sweep(FLIGHT_MS, 60)) {
        const [cx, cy] = centre(straight(carry + t)[0].cut);
        expect(((cx - fx) * vy - (cy - fy) * vx) / Math.hypot(vx, vy)).toBeCloseTo(0, 9);
      }
    });

    it(`${label}: the corner is rounded, not square: it never stops to turn`, () => {
      // per-frame travel of the middle at 60Hz. A square corner has the rise
      // finish before the run starts, so one frame in the turn crawls; the
      // rounded corner has the run already moving as the rise runs out.
      const pace = (bend: number): { peak: number; slowest: number } => {
        const play = flight(squares, seats, NAT, bend);
        const pts: [number, number][] = [];
        for (let ms = 0; ms <= FLIGHT_MS; ms += 1000 / 60) {
          pts.push(centre(play(carry + ms)[0].cut));
        }
        const hop = pts
          .slice(1)
          .map((q, i) => Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1]));
        // the turn is made in the carry's first quarter; the rest is the
        // ease's own tail, which is slow on any path and proves nothing
        const turn = hop.filter((_, i) => ((i + 1) * 1000) / 60 <= FLIGHT_MS / 4);
        return { peak: Math.max(...hop), slowest: Math.min(...turn) };
      };
      const sharp = pace(0);
      const round = pace(SHOT_BEND);
      expect(sharp.slowest / sharp.peak).toBeLessThan(0.15); // a stop, in a word
      expect(round.slowest / round.peak).toBeGreaterThan(0.15);
      expect(round.slowest).toBeGreaterThan(sharp.slowest * 1.4);
    });

    it(`${label}: the size change is spread over both legs, not crammed into one`, () => {
      const grown = (t: number): number =>
        (at(t)[0].cut.width - start.width) / (seats[0].width - start.width);
      const spent = when((m) => m.up >= 1); // the rise's end
      expect(grown(spent)).toBeGreaterThan(0.35); // the rise did not hold a thumbnail up
      expect(grown(spent)).toBeLessThan(0.85); // nor did it arrive full size with a slide left
      expect(grown(carry + FLIGHT_MS)).toBeCloseTo(1, 9);
    });
  }
});

describe("the text send's path is not on this L", () => {
  // The bar morph (main.ts armFieldMorph) interpolates its box with the SAME
  // morphBox and the SAME flightEase the photo flight uses, so anything the L
  // did to either of those would drag the text send along with it. The owner
  // asked for the photo and only the photo. These hold the bar on the straight
  // line it has always travelled.
  const bar: MorphBox = { left: 12, top: 690, width: 366, height: 44 };
  const seat: MorphBox = { left: 150, top: 320, width: 228, height: 38 };

  it("the bar's box is the one eased fraction on every axis, every frame", () => {
    for (const f of sweep(1, 200)) {
      const p = flightEase(f);
      const b = morphBox(bar, seat, p);
      expect(b.left).toBeCloseTo(bar.left + (seat.left - bar.left) * p, 9);
      expect(b.top).toBeCloseTo(bar.top + (seat.top - bar.top) * p, 9);
      expect(b.width).toBeCloseTo(bar.width + (seat.width - bar.width) * p, 9);
      expect(b.height).toBeCloseTo(bar.height + (seat.height - bar.height) * p, 9);
    }
  });

  it("its middle never leaves the straight line between the two rects", () => {
    const [fx, fy] = centre(bar);
    const [tx, ty] = centre(seat);
    const vx = tx - fx;
    const vy = ty - fy;
    for (const f of sweep(1, 200)) {
      const [cx, cy] = centre(morphBox(bar, seat, flightEase(f)));
      expect(((cx - fx) * vy - (cy - fy) * vx) / Math.hypot(vx, vy)).toBeCloseTo(0, 9);
    }
  });

  it("the corner lives in the legs, not in the helper both sends share", () => {
    // feeding elbowBox the shared progress on both legs reproduces morphBox to
    // the pixel, which can only be true while the L is entirely in the legs
    for (const p of sweep(1, 40)) {
      const bent = elbowBox(bar, seat, p, { up: p, across: p });
      const flat = morphBox(bar, seat, p);
      expect(bent.left).toBeCloseTo(flat.left, 9);
      expect(bent.top).toBeCloseTo(flat.top, 9);
      expect(bent.width).toBeCloseTo(flat.width, 9);
      expect(bent.height).toBeCloseTo(flat.height, 9);
    }
  });
});
