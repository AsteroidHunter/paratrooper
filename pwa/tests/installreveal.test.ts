// Pins for the install face's reveal (src/installreveal.ts): the order the
// five messages arrive in, the second the dots hold on their own before the
// first one, the cadence between the rest, which bubble carries the tail, and
// the one collapse — a phone asking for less motion gets the whole face at
// once. Pure arithmetic, so it is checked as arithmetic: no DOM, no timers,
// no browser. main.ts arms a timer per step and is pinned separately
// (installsteps.test.ts).
import { describe, expect, it } from "vitest";
import {
  REVEAL_CADENCE_MS,
  REVEAL_CLOSE_MS,
  REVEAL_LEAD_MS,
  revealSteps,
} from "../src/installreveal";

/** the five the card sends */
const FIVE = 5;

const named = (count = FIVE, reduced = false): string[] =>
  revealSteps(count, reduced).map((s) => (s.part === "message" ? `message ${s.index}` : s.part));

const at = (count = FIVE, reduced = false): number[] =>
  revealSteps(count, reduced).map((s) => s.at);

describe("the run arrives in one order", () => {
  it("dots, then the five in the order they are done in, then the line under them", () => {
    expect(named()).toEqual([
      "dots",
      "message 0",
      "message 1",
      "message 2",
      "message 3",
      "message 4",
      "statement",
    ]);
  });

  it("every step is dated from the start, and the dates only go forwards", () => {
    const times = at();
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
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
    expect(revealSteps(FIVE)[0]).toMatchObject({ at: 0, part: "dots" });
  });

  it("the first message is a full second behind them", () => {
    expect(REVEAL_LEAD_MS).toBe(1000);
    const first = revealSteps(FIVE).find((s) => s.part === "message")!;
    expect(first.at).toBe(REVEAL_LEAD_MS);
  });

  it("the rest follow at one steady cadence, each read before the next lands", () => {
    const messages = revealSteps(FIVE).filter((s) => s.part === "message");
    const gaps = messages.slice(1).map((s, i) => s.at - messages[i].at);
    expect(gaps).toEqual([
      REVEAL_CADENCE_MS,
      REVEAL_CADENCE_MS,
      REVEAL_CADENCE_MS,
      REVEAL_CADENCE_MS,
    ]);
    // the owner's own number: 0.56 seconds between messages, asked for after
    // four tenths (the five as one flurry) and then nine tenths. Pinned to the
    // number, because the number is what was asked for.
    expect(REVEAL_CADENCE_MS).toBe(560);
  });

  it("the closing line comes a beat after the last message, not with it", () => {
    const steps = revealSteps(FIVE);
    const last = steps.filter((s) => s.part === "message").pop()!;
    const statement = steps[steps.length - 1];
    expect(statement.at - last.at).toBe(REVEAL_CLOSE_MS);
    // and that beat is longer than the cadence, so the line reads as the end
    // of the run rather than as a sixth message. It stayed at nine tenths when
    // the cadence moved to 0.56: the owner's words were about the gap between
    // messages, not this one.
    expect(REVEAL_CLOSE_MS).toBeGreaterThan(REVEAL_CADENCE_MS);
    expect(REVEAL_CLOSE_MS).toBe(900);
  });

  it("the whole thing is in at a little over four seconds", () => {
    // one second of dots, four gaps of the cadence, one close: 1000 + 4 * 560 + 900
    expect(at().pop()).toBe(4140);
    expect(at().pop()).toBe(REVEAL_LEAD_MS + (FIVE - 1) * REVEAL_CADENCE_MS + REVEAL_CLOSE_MS);
  });
});

describe("how each piece arrives", () => {
  it("only the first message takes the dots' box over", () => {
    const morphs = revealSteps(FIVE).filter((s) => s.entrance === "morph");
    expect(morphs).toHaveLength(1);
    expect(morphs[0]).toMatchObject({ part: "message", index: 0 });
  });

  it("the later four wear the chat's own bubble entrance", () => {
    const rest = revealSteps(FIVE).filter((s) => s.part === "message" && s.index > 0);
    expect(rest.map((s) => s.entrance)).toEqual(["pop", "pop", "pop", "pop"]);
  });

  it("the dots simply appear, the way Messages' indicator does", () => {
    expect(revealSteps(FIVE)[0].entrance).toBe("none");
  });

  it("the line under the run fades, and is the only thing that does", () => {
    const fades = revealSteps(FIVE).filter((s) => s.entrance === "fade");
    expect(fades.map((s) => s.part)).toEqual(["statement"]);
  });

  it("no dots between the later messages: the run is typed once", () => {
    expect(revealSteps(FIVE).filter((s) => s.part === "dots")).toHaveLength(1);
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

  it("there are no dots: an indicator that never blinks is just a box", () => {
    expect(named(FIVE, true)).toEqual([
      "message 0",
      "message 1",
      "message 2",
      "message 3",
      "message 4",
      "statement",
    ]);
  });

  it("the same content arrives either way — the same steps, at another clock", () => {
    const shown = named();
    expect(named(FIVE, true)).toEqual(shown.filter((name) => name !== "dots"));
    // and the tail is still the fifth bubble's, motion or no motion
    expect(revealSteps(FIVE, true).filter((s) => s.tail).map((s) => s.index)).toEqual([FIVE - 1]);
  });
});

describe("the count is the list's, not a number written twice", () => {
  it("three messages schedule three, on the same lead and the same cadence", () => {
    expect(named(3)).toEqual(["dots", "message 0", "message 1", "message 2", "statement"]);
    expect(at(3)).toEqual([
      0,
      REVEAL_LEAD_MS,
      REVEAL_LEAD_MS + REVEAL_CADENCE_MS,
      REVEAL_LEAD_MS + 2 * REVEAL_CADENCE_MS,
      REVEAL_LEAD_MS + 2 * REVEAL_CADENCE_MS + REVEAL_CLOSE_MS,
    ]);
  });

  it("no messages at all is the line on its own, with nothing to wait for", () => {
    expect(named(0)).toEqual(["statement"]);
    expect(at(0)).toEqual([0]);
  });
});
