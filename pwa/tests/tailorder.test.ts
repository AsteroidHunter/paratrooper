// Pins for the thread's order rule (src/tailorder.ts) and its wiring in
// main.ts.
//
// The device report: a message failed, a later one was sent and landed BELOW
// it, and Try Again on the failed one stored a brand new message numbered
// after the later one while leaving the bubble where it stood. The screen then
// read one order and a reload read another, and the delivery stamp jumped up
// under a bubble that was no longer the newest sent one.
//
// The rule is one line: accepted messages by number, then the unsent ones in
// the order they came to rest. Two of the three places that reorder the thread
// already kept it (a frame landing above a failure, a restored outbox row
// rebuilt at the tail); a user send did not. The pure half is exercised
// directly below, sequence by sequence, with the invariant checked after every
// single step; the main.ts half is source-pinned the way flight.test.ts and
// receipthold.test.ts hold theirs, because main.ts boots a real shell at
// import and cannot load under node.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { afterSend, inReloadOrder, reloadOrder, seatBefore } from "../src/tailorder";
import type { Standing } from "../src/tailorder";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/main.ts"), "utf8");

function fnBody(name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `main.ts has no ${name}`).toBeGreaterThan(-1);
  const end = src.indexOf("\n}", start);
  return src.slice(start, end);
}

// --- the pure rule ----------------------------------------------------------

const row = (seq: number | null, failed = false): Standing => ({ seq, failed });

describe("seatBefore — where one row belongs", () => {
  it("an accepted row sits above every larger number", () => {
    const rows = [row(1), row(2), row(9), row(5)];
    expect(seatBefore(rows, 3)).toBe(rows[2]); // seq 5 goes above seq 9
  });

  it("an accepted row sits above the whole unsent band", () => {
    const rows = [row(1), row(null, true), row(4)];
    expect(seatBefore(rows, 2)).toBe(rows[1]);
  });

  it("the common retry moves nothing: the newest number is already last", () => {
    const rows = [row(1), row(2), row(3)];
    expect(seatBefore(rows, 2)).toBeNull();
  });

  it("an unsent row sinks below accepted rows that landed under it", () => {
    const rows = [row(null, true), row(7)];
    expect(seatBefore(rows, 0)).toBeNull(); // past seq 7, to the end
  });

  it("an unsent row keeps its place among the other unsent ones", () => {
    const rows = [row(null, true), row(9), row(null, true)];
    expect(seatBefore(rows, 0)).toBe(rows[2]); // below seq 9, above the other failure
  });

  it("an unsent row never climbs over an accepted row above it", () => {
    const rows = [row(3), row(null, true)];
    expect(seatBefore(rows, 1)).toBeNull();
  });

  it("a row still in the air stays exactly where the send seated it", () => {
    const rows = [row(4), row(null), row(null, true)];
    expect(seatBefore(rows, 1)).toBe(rows[2]); // its own next sibling: no move
  });
});

describe("reloadOrder / inReloadOrder — what a reload rebuilds", () => {
  it("accepted rows by number, then the unsent ones in their own order", () => {
    const a = row(null, true);
    const b = row(null, true);
    const rows = [row(7), a, row(2), b];
    expect(reloadOrder(rows)).toEqual([rows[2], rows[0], a, b]);
  });

  it("a row still in the air is left out: a reload cannot show it", () => {
    const flying = row(null);
    expect(reloadOrder([row(1), flying])).toEqual([{ seq: 1, failed: false }]);
    expect(inReloadOrder([row(1), flying])).toBe(true);
  });

  it("the bug's arrangement is exactly what it flags", () => {
    // the failed bubble above a message the server numbered before it
    expect(inReloadOrder([row(null, true), row(9)])).toBe(false);
    expect(inReloadOrder([row(9), row(null, true)])).toBe(true);
  });
});

describe("afterSend — the tail rule the send was missing", () => {
  it("the new bubble takes the tail of the accepted band, failures drop below", () => {
    const a = { seq: null, failed: true, name: "A" };
    const b = { seq: null, failed: false, name: "B" };
    const rows = [{ seq: 1, failed: false, name: "h1" }, a];
    expect(afterSend(rows, b).map((r) => r.name)).toEqual(["h1", "B", "A"]);
  });

  it("two failures keep the arrangement they already held", () => {
    const rows = [
      { seq: 1, failed: false, name: "h1" },
      { seq: null, failed: true, name: "A" },
      { seq: null, failed: true, name: "B" },
    ];
    const c = { seq: null, failed: false, name: "C" };
    expect(afterSend(rows, c).map((r) => r.name)).toEqual(["h1", "C", "A", "B"]);
  });
});

// --- the sequences, with the invariant checked after every step -------------
// A thread the four rules are applied to exactly as main.ts applies them:
// sinkFailed on a send, seatRow on an answer and on a failure, and applyEvent's
// tail slot for a frame from the server.

interface Named extends Standing {
  name: string;
}

class Thread {
  rows: Named[] = [];
  steps: string[] = [];

  private seat(r: Named): void {
    const i = this.rows.indexOf(r);
    const ref = seatBefore(this.rows, i);
    this.rows.splice(i, 1);
    this.rows.splice(ref ? this.rows.indexOf(ref) : this.rows.length, 0, r);
  }

  history(...seqs: number[]): this {
    for (const seq of seqs) this.rows.push({ name: `h${seq}`, seq, failed: false });
    return this.check("history");
  }

  /** send(): the bubble appears at the tail and every failure drops below it */
  send(name: string): this {
    this.rows = afterSend(this.rows, { name, seq: null, failed: false });
    return this.check(`send ${name}`);
  }

  /** transmit()'s answer: seat by the number the server just handed back */
  accept(name: string, seq: number): this {
    const r = this.find(name);
    r.seq = seq;
    r.failed = false;
    this.seat(r);
    return this.check(`accept ${name} as ${seq}`);
  }

  /** markFailed(): the mark goes up and the bubble sinks under what landed */
  fail(name: string): this {
    const r = this.find(name);
    r.failed = true;
    this.seat(r);
    return this.check(`fail ${name}`);
  }

  /** applyEvent()'s tail slot: above the unsent band, never past it */
  reply(seq: number): this {
    const r: Named = { name: `r${seq}`, seq, failed: false };
    const first = this.rows.findIndex((x) => x.failed);
    if (first < 0) this.rows.push(r);
    else this.rows.splice(first, 0, r);
    return this.check(`reply ${seq}`);
  }

  private find(name: string): Named {
    const r = this.rows.find((x) => x.name === name);
    if (!r) throw new Error(`no row ${name}`);
    return r;
  }

  private check(step: string): this {
    this.steps.push(step);
    // the invariant, at every moment: the live order IS the reload order
    expect(inReloadOrder(this.rows), `${step}: live order left the reload order`).toBe(true);
    return this;
  }

  order(): string[] {
    return this.rows.map((r) => r.name);
  }

  reload(): string[] {
    return reloadOrder(this.rows).map((r) => r.name);
  }
}

describe("the reported sequence: A fails, B is sent, A is retried", () => {
  it("A drops below B on the send and is seated last on the retry", () => {
    const t = new Thread().history(1, 2);
    t.send("A").fail("A");
    expect(t.order()).toEqual(["h1", "h2", "A"]);
    t.send("B");
    expect(t.order()).toEqual(["h1", "h2", "B", "A"]); // the tail rule, on the send
    t.accept("B", 3);
    t.accept("A", 4); // Try Again: a brand new message, numbered after B
    expect(t.order()).toEqual(["h1", "h2", "B", "A"]); // already home: nothing moves
    expect(t.reload()).toEqual(t.order());
  });

  it("the receipt's anchor is the newest accepted row, which is the last one", () => {
    const t = new Thread().history(1).send("A").fail("A").send("B").accept("B", 2).accept("A", 3);
    const accepted = t.reload().filter((n) => !n.startsWith("h"));
    expect(accepted[accepted.length - 1]).toBe("A");
    expect(t.order()[t.order().length - 1]).toBe("A");
  });
});

describe("A fails, B fails too, then each is retried", () => {
  it("the retried one climbs above the still-failed one, then that one lands last", () => {
    const t = new Thread().history(1).send("A").fail("A").send("B").fail("B");
    expect(t.order()).toEqual(["h1", "B", "A"]); // B was sent while A was failed
    t.accept("A", 2);
    expect(t.order()).toEqual(["h1", "A", "B"]); // an upward move, above the failure
    t.accept("B", 3);
    expect(t.order()).toEqual(["h1", "A", "B"]); // seated last, so it does not move
  });
});

describe("A fails, a reply arrives, then B is sent", () => {
  it("the reply slots above the failure and B lands between them", () => {
    const t = new Thread().history(1).send("A").fail("A").reply(2);
    expect(t.order()).toEqual(["h1", "r2", "A"]);
    t.send("B").accept("B", 3);
    expect(t.order()).toEqual(["h1", "r2", "B", "A"]);
    expect(t.reload()).toEqual(t.order());
  });
});

describe("A fails, B is sent, a reply arrives before the retry", () => {
  it("A holds the tail under the reply and the retry seats it last", () => {
    const t = new Thread().history(1).send("A").fail("A").send("B").accept("B", 2).reply(3);
    expect(t.order()).toEqual(["h1", "B", "r3", "A"]);
    t.accept("A", 4);
    expect(t.order()).toEqual(["h1", "B", "r3", "A"]); // already last: motionless
  });
});

describe("A fails and is retried with nothing sent in between", () => {
  it("nothing moves at all", () => {
    const t = new Thread().history(1, 2).send("A").fail("A");
    const before = t.order();
    t.accept("A", 3);
    expect(t.order()).toEqual(before);
  });
});

describe("a frame that lands while a send is still out", () => {
  it("the failure then sinks under it, so the live order still reads as a reload", () => {
    const t = new Thread().history(1).send("A");
    t.reply(2); // the server answered an earlier turn while A was in the air
    expect(t.order()).toEqual(["h1", "A", "r2"]);
    t.fail("A");
    expect(t.order()).toEqual(["h1", "r2", "A"]);
  });
});

// --- the wiring in main.ts --------------------------------------------------

describe("send() — the tail rule on a user send", () => {
  const body = fnBody("send");

  it("the failures sink between the shift's measure and the pin", () => {
    const measure = body.indexOf("beginSiblingShift()");
    const insert = body.indexOf('localWrapper("user")');
    const sink = body.indexOf("sinkFailed()");
    const pin = body.indexOf("scrollToBottom(true)");
    const play = body.indexOf("shift.play()");
    expect(sink).toBeGreaterThan(measure); // measured where they stood
    expect(sink).toBeGreaterThan(insert); // below the bubble they drop under
    expect(sink).toBeLessThan(pin);
    expect(sink).toBeLessThan(play); // so the drop is one of the glided moves
  });

  it("the drop happens before decorate folds the thread in DOM order", () => {
    expect(body.indexOf("sinkFailed()")).toBeLessThan(body.indexOf("decorate()"));
  });

  it("the failure path re-seats the bubble rather than appending it blindly", () => {
    expect(body).toContain("seatRow(w)");
    expect(body).not.toContain("threadEl().appendChild(w)");
  });
});

describe("sinkFailed / seatRow — the one rule, applied to the DOM", () => {
  const sink = fnBody("sinkFailed");
  const seat = fnBody("seatRow");
  const plan = fnBody("seatPlan");

  it("sinkFailed walks the failures in the order they stand in", () => {
    expect(sink).toContain('querySelectorAll<HTMLElement>(".evt.failed")');
    expect(sink).toContain("t.appendChild(w)"); // in DOM order: the arrangement carries over
  });

  it("both paths still the entrance first, so a move cannot replay the pop-in", () => {
    expect(sink).toContain("stillEntrance(w)");
    expect(seat).toContain("stillEntrance(w)");
    expect(fnBody("stillEntrance")).toContain('".msg.anim"');
  });

  it("seatRow moves the wrapper, never rebuilds it (identity is the photo bytes)", () => {
    expect(seat).toContain("t.insertBefore(w, ref)");
    expect(seat).toContain("t.appendChild(w)");
    expect(seat).not.toContain("createElement");
    expect(seat).not.toContain("remove()");
  });

  it("a wrapper that is already home reports no move, so no beat opens", () => {
    expect(seat).toContain("if (!moves) return false");
    expect(plan).toContain("seatBefore(rows, self)");
  });

  it("the dots follow an accepted row and stay above an unsent one", () => {
    expect(seat).toContain('if (!w.classList.contains("failed")) moveTypingAfter(t, w)');
  });

  it("the standings are read off the wrapper, number and mark", () => {
    const st = fnBody("threadStandings");
    expect(st).toContain("el.dataset.seq ? Number(el.dataset.seq) : null");
    expect(st).toContain('el.classList.contains("failed")');
  });
});

describe("applyEvent — a frame from the server never lands under a failure", () => {
  const body = fnBody("applyEvent");

  it("the tail slot is the unsent band, not just the restored half of it", () => {
    expect(body).toContain('querySelector<HTMLElement>(".evt.failed")');
    // the comment above it still names the marker it replaced; the query must not
    expect(body).not.toContain('querySelector<HTMLElement>(".evt.restored")');
    expect(body).toContain("threadEl().insertBefore(wrapper, unsent)");
  });
});

describe("markFailed — an unsent bubble drops under what landed beneath it", () => {
  const body = fnBody("markFailed");

  it("the mark goes up first, then the row is seated by it", () => {
    expect(body.indexOf('w.classList.add("failed")')).toBeLessThan(body.indexOf("seatRow(w)"));
  });

  it("the re-seat runs on a re-failure too, ahead of the already-marked return", () => {
    expect(body.indexOf("seatRow(w)")).toBeLessThan(body.indexOf('".sendfail-badge"'));
  });
});

describe("transmit — the answer settles the seat and the clock", () => {
  const body = fnBody("transmit");

  it("the accepted send is seated by the number the server just gave it", () => {
    expect(body).toContain("landSend(w, ");
    expect(body.indexOf("w.dataset.seq = String(seq)")).toBeLessThan(body.indexOf("landSend(w, "));
  });

  it("the clock handed to it is the server's, not the failed attempt's", () => {
    expect(body).toContain("Date.parse(ack.ts)");
    expect(body).toContain("Number.isFinite(stamped) ? stamped : 0");
  });

  it("a retry still takes the same path as a first attempt", () => {
    // one function, both callers: retrySend hands the held payload straight in
    expect(fnBody("retrySend")).toContain("transmit(w, held.text, held.files)");
  });
});

describe("landSend — motionless when there is nothing to move", () => {
  const body = fnBody("landSend");

  it("parks behind an airborne flight, on the gate the receipt already uses", () => {
    expect(body).toContain("if (flightsUp > 0)");
    expect(body).toContain("landPending.push([w, at])");
    expect(body.indexOf("if (flightsUp > 0)")).toBeLessThan(body.indexOf("beginSiblingShift()"));
  });

  it("opens no shift at all when the seat and the clock both already hold", () => {
    const guard = body.indexOf("if (!seatPlan(w).moves");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf("beginSiblingShift()"));
    expect(body).toContain("LAND_TIME_SLACK_MS");
  });

  it("the seat and the re-time ride one shift, measured before and played after", () => {
    expect(body.indexOf("beginSiblingShift()")).toBeLessThan(body.indexOf("applyLanding(w, at)"));
    expect(body.indexOf("applyLanding(w, at)")).toBeLessThan(body.indexOf("shift.play()"));
  });
});

describe("the re-timed row: the server's clock, where a reload reads it", () => {
  const body = fnBody("retimeRow");

  it("writes the wrapper's ts and every row's time label", () => {
    expect(body).toContain("w.dataset.ts = String(at)");
    expect(body).toContain("row.dataset.time = fmtTime(at)");
  });

  it("an answer within a second of the row's own clock re-times nothing", () => {
    expect(body).toContain("<= LAND_TIME_SLACK_MS) return false");
    expect(src).toMatch(/const LAND_TIME_SLACK_MS = 1000;/);
  });

  it("a landing that changed something re-folds the thread and re-pins", () => {
    const apply = fnBody("applyLanding");
    expect(apply).toContain("if (!retimed && !moved) return");
    expect(apply).toContain("decorate()");
    expect(apply).toContain("if (followTail) scrollToBottom()");
  });
});

describe("the receipt needs no new logic", () => {
  it("it still finds its bubble by number, so the retried one is where it lands", () => {
    expect(fnBody("updateReceipt")).toContain("wrapperFor(r.seq)");
  });

  it("nothing in the order rule touches the stamp", () => {
    for (const fn of ["seatRow", "sinkFailed", "seatPlan", "threadStandings"]) {
      expect(fnBody(fn)).not.toContain("receipt");
    }
  });
});
