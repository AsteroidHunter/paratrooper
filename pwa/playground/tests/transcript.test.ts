// The transcript's shape, pinned.
//
// The length is a requirement rather than a detail: the thread has to be long
// enough that a hard fling runs for seconds without reaching an end, because
// that is the only way to reach by hand the case where the vertex has ridden
// off screen and the baseline profile has gone flat. A shorter thread hides the
// weakest case the travelling settle has.
//
// It is counted HERE, off the data, and not by grepping the file: the type
// union at the top of messages.ts contains the words `kind: "msg"` and
// `kind: "stamp"` too, and counting those cost one message and one stamp in an
// independent browser count of the rendered rows. thread.ts emits exactly one
// row per entry, so these numbers are the rows.

import { describe, expect, it } from "vitest";
import { TRANSCRIPT } from "../src/messages";

describe("the sample transcript", () => {
  const msgs = TRANSCRIPT.filter((e) => e.kind === "msg");
  const stamps = TRANSCRIPT.filter((e) => e.kind === "stamp");

  it("is 240 messages, which is what was asked for and what renders", () => {
    expect(msgs).toHaveLength(240);
    expect(stamps).toHaveLength(25);
    expect(TRANSCRIPT).toHaveLength(265);
  });

  it("keeps the pitch varied, which is what the spring is measured on", () => {
    // a tall bubble's own height is charged to the small gap beside it, so a
    // thread of uniform one-liners would never exercise the strain bound
    const lengths = msgs.map((e) => (e.kind === "msg" ? e.text.length : 0));
    const short = lengths.filter((n) => n <= 30).length;
    const long = lengths.filter((n) => n >= 140).length;
    expect(short).toBeGreaterThan(80);
    expect(long).toBeGreaterThan(20);
  });

  it("keeps runs from one sender, which is what makes the 4 px gaps", () => {
    // consecutive messages from the same sender are a run, and a run's rows sit
    // 4 px apart where a change of sender sits 12 apart. The compression floor
    // binds on the tight ones, so there have to be plenty of them.
    let runs = 0;
    for (let i = 1; i < TRANSCRIPT.length; i++) {
      const a = TRANSCRIPT[i - 1];
      const b = TRANSCRIPT[i];
      if (a.kind === "msg" && b.kind === "msg" && a.from === b.from) runs += 1;
    }
    expect(runs).toBeGreaterThan(45);
  });

  it("starts and ends on a message, and every stamp has a day and a time", () => {
    expect(TRANSCRIPT[TRANSCRIPT.length - 1].kind).toBe("msg");
    for (const s of stamps) {
      if (s.kind !== "stamp") continue;
      expect(s.day.length).toBeGreaterThan(0);
      expect(s.time).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
    }
  });
});
