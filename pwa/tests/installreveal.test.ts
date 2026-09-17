// Pins for the install face's reveal (src/installreveal.ts): the order the
// five messages arrive in, the second the dots hold on their own before the
// first one, the dots coming up again under every message and holding before
// they become the next, the cadence between landings, which bubble carries the
// tail, and the one collapse — a phone asking for less motion gets the whole
// face at once. Pure arithmetic, so it is checked as arithmetic: no DOM, no
// timers, no browser. main.ts arms a timer per step and is pinned separately
// (installsteps.test.ts).
import { describe, expect, it } from "vitest";
import { ARRIVE_MS } from "../src/arrival";
import {
  REVEAL_CADENCE_MS,
  REVEAL_CLOSE_MS,
  REVEAL_HOLD_MS,
  REVEAL_LEAD_MS,
  REVEAL_SETTLE_MS,
  revealSteps,
} from "../src/installreveal";

/** the five the card sends */
const FIVE = 5;

const named = (count = FIVE, reduced = false): string[] =>
  revealSteps(count, reduced).map((s) =>
    s.part === "statement" ? s.part : `${s.part} ${s.index}`,
  );

const at = (count = FIVE, reduced = false): number[] =>
  revealSteps(count, reduced).map((s) => s.at);

const messages = (count = FIVE, reduced = false) =>
  revealSteps(count, reduced).filter((s) => s.part === "message");
const dots = (count = FIVE, reduced = false) =>
  revealSteps(count, reduced).filter((s) => s.part === "dots");

describe("the run arrives in one order: dots, message, dots, message", () => {
  it("the dots come up before every one of the five, then the line under them", () => {
    expect(named()).toEqual([
      "dots 0",
      "message 0",
      "dots 1",
      "message 1",
      "dots 2",
      "message 2",
      "dots 3",
      "message 3",
      "dots 4",
      "message 4",
      "statement",
    ]);
  });

  it("every step is dated from the start, and the dates only go forwards", () => {
    const times = at();
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
  });

  it("each dots step is for the message right after it, and sits in that message's row", () => {
    const steps = revealSteps(FIVE);
    for (let i = 0; i < steps.length - 1; i++) {
      if (steps[i].part !== "dots") continue;
      expect(steps[i + 1]).toMatchObject({ part: "message", index: steps[i].index });
    }
    expect(dots().map((s) => s.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it("the statement is last, and nothing is scheduled after it", () => {
    const steps = revealSteps(FIVE);
    const last = steps[steps.length - 1];
    expect(last.part).toBe("statement");
    expect(Math.max(...steps.map((s) => s.at))).toBe(last.at);
  });
});

describe("the clock", () => {
  it("the dots are the first frame, not something that waits for one", () => {
    expect(revealSteps(FIVE)[0]).toMatchObject({ at: 0, part: "dots", index: 0 });
  });

  it("the first message is a full second behind them, unchanged", () => {
    expect(REVEAL_LEAD_MS).toBe(1000);
    const first = messages()[0];
    expect(first.at).toBe(REVEAL_LEAD_MS);
  });

  it("the messages land at one steady cadence, each read before the next lands", () => {
    const lands = messages().map((s) => s.at);
    const gaps = lands.slice(1).map((t, i) => t - lands[i]);
    expect(gaps).toEqual([
      REVEAL_CADENCE_MS,
      REVEAL_CADENCE_MS,
      REVEAL_CADENCE_MS,
      REVEAL_CADENCE_MS,
    ]);
    // the beat the owner approved after seeing four tenths: nine tenths of a
    // second from one landing to the next, so each one is read as it lands
    // rather than the five arriving as one flurry. Pinned to the number,
    // because the number is the pace that was approved.
    expect(REVEAL_CADENCE_MS).toBe(900);
    expect(lands).toEqual([1000, 1900, 2800, 3700, 4600]);
  });

  it("inside each beat: the message lands, a settle, the dots come up and hold", () => {
    const steps = revealSteps(FIVE);
    for (let i = 1; i < FIVE; i++) {
      const landed = steps.find((s) => s.part === "message" && s.index === i - 1)!;
      const up = steps.find((s) => s.part === "dots" && s.index === i)!;
      const next = steps.find((s) => s.part === "message" && s.index === i)!;
      expect(up.at - landed.at).toBe(REVEAL_SETTLE_MS);
      expect(next.at - up.at).toBe(REVEAL_HOLD_MS);
    }
    // and the two halves are the cadence: nothing is spelled twice
    expect(REVEAL_SETTLE_MS + REVEAL_HOLD_MS).toBe(REVEAL_CADENCE_MS);
    expect(dots().map((s) => s.at)).toEqual([0, 1300, 2200, 3100, 4000]);
  });

  it("the settle is longer than the morph, so a box has finished growing before the dots appear under it", () => {
    expect(REVEAL_SETTLE_MS).toBeGreaterThan(ARRIVE_MS);
    // and not by much: the dots come up as the box lands, the way they do in
    // Messages when the next line is already being typed
    expect(REVEAL_SETTLE_MS - ARRIVE_MS).toBeLessThanOrEqual(50);
    expect(REVEAL_SETTLE_MS).toBe(300);
  });

  it("the dots are the greater part of every gap: the run reads as typed, not dealt", () => {
    expect(REVEAL_HOLD_MS).toBeGreaterThan(REVEAL_CADENCE_MS / 2);
    expect(REVEAL_HOLD_MS).toBe(600);
    // the lead before the first message is the longest hold of all, and is
    // the only one not cut from the cadence
    expect(REVEAL_LEAD_MS).toBeGreaterThan(REVEAL_HOLD_MS);
  });

  it("the closing line comes a beat after the last message, not with it", () => {
    const steps = revealSteps(FIVE);
    const last = messages().pop()!;
    const statement = steps[steps.length - 1];
    expect(statement.at - last.at).toBe(REVEAL_CLOSE_MS);
    // and that beat is the cadence's own, so the line reads as the end of the
    // same run rather than as a sixth message that came early
    expect(REVEAL_CLOSE_MS).toBe(REVEAL_CADENCE_MS);
    expect(REVEAL_CLOSE_MS).toBe(900);
    // no dots before the line: it is not a message and nobody types it
    expect(steps[steps.length - 2].part).toBe("message");
  });

  it("the whole thing is in at five and a half seconds, as it was", () => {
    // one second of dots, four gaps of the cadence, one close: 1000 + 4 * 900 + 900
    expect(at().pop()).toBe(5500);
    expect(at().pop()).toBe(REVEAL_LEAD_MS + (FIVE - 1) * REVEAL_CADENCE_MS + REVEAL_CLOSE_MS);
  });
});

describe("how each piece arrives", () => {
  it("every message takes the dots' box over: the chat's own reply arrival, five times", () => {
    expect(messages().map((s) => s.entrance)).toEqual(["morph", "morph", "morph", "morph", "morph"]);
  });

  it("no message pops in: the pop was the second entrance the morph replaces", () => {
    for (const step of revealSteps(FIVE)) expect(step.entrance).not.toBe("pop");
  });

  it("the dots simply appear, every time, the way Messages' indicator does", () => {
    expect(dots().map((s) => s.entrance)).toEqual(["none", "none", "none", "none", "none"]);
  });

  it("the line under the run fades, and is the only thing that does", () => {
    const fades = revealSteps(FIVE).filter((s) => s.entrance === "fade");
    expect(fades.map((s) => s.part)).toEqual(["statement"]);
  });

  it("one dots step per message, no more: the dots come up once for each", () => {
    expect(dots()).toHaveLength(FIVE);
  });
});

describe("the tail hangs under the last bubble and nowhere else", () => {
  it("exactly one message carries it, and it is the fifth", () => {
    const tails = revealSteps(FIVE).filter((s) => s.tail);
    expect(tails).toHaveLength(1);
    expect(tails[0]).toMatchObject({ part: "message", index: FIVE - 1 });
  });

  it("neither the dots nor the closing line is ever the run's tail", () => {
    for (const step of revealSteps(FIVE)) {
      if (step.part !== "message") expect(step.tail).toBe(false);
    }
  });

  it("the tail follows the count rather than the number five", () => {
    expect(revealSteps(3).filter((s) => s.tail).map((s) => s.index)).toEqual([2]);
    expect(revealSteps(1).filter((s) => s.tail).map((s) => s.index)).toEqual([0]);
  });
});

describe("a phone asking for less motion is given the face, not the show", () => {
  it("every piece is there at zero", () => {
    expect(at(FIVE, true)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("nothing has an entrance, so nothing moves on the way in", () => {
    for (const step of revealSteps(FIVE, true)) expect(step.entrance).toBe("none");
  });

  it("there are no dots at all: an indicator that never blinks is just a box", () => {
    expect(named(FIVE, true)).toEqual([
      "message 0",
      "message 1",
      "message 2",
      "message 3",
      "message 4",
      "statement",
    ]);
    expect(dots(FIVE, true)).toHaveLength(0);
  });

  it("the same content arrives either way — the same steps, at another clock", () => {
    const shown = named();
    expect(named(FIVE, true)).toEqual(shown.filter((name) => !name.startsWith("dots")));
    // and the tail is still the fifth bubble's, motion or no motion
    expect(revealSteps(FIVE, true).filter((s) => s.tail).map((s) => s.index)).toEqual([FIVE - 1]);
  });
});

describe("the count is the list's, not a number written twice", () => {
  it("three messages schedule three, on the same lead, cadence and hold", () => {
    expect(named(3)).toEqual([
      "dots 0",
      "message 0",
      "dots 1",
      "message 1",
      "dots 2",
      "message 2",
      "statement",
    ]);
    expect(at(3)).toEqual([
      0,
      REVEAL_LEAD_MS,
      REVEAL_LEAD_MS + REVEAL_CADENCE_MS - REVEAL_HOLD_MS,
      REVEAL_LEAD_MS + REVEAL_CADENCE_MS,
      REVEAL_LEAD_MS + 2 * REVEAL_CADENCE_MS - REVEAL_HOLD_MS,
      REVEAL_LEAD_MS + 2 * REVEAL_CADENCE_MS,
      REVEAL_LEAD_MS + 2 * REVEAL_CADENCE_MS + REVEAL_CLOSE_MS,
    ]);
  });

  it("one message is the lead, the message and the close: no hold anywhere", () => {
    expect(named(1)).toEqual(["dots 0", "message 0", "statement"]);
    expect(at(1)).toEqual([0, REVEAL_LEAD_MS, REVEAL_LEAD_MS + REVEAL_CLOSE_MS]);
  });

  it("no messages at all is the line on its own, with nothing to wait for", () => {
    expect(named(0)).toEqual(["statement"]);
    expect(at(0)).toEqual([0]);
  });
});
