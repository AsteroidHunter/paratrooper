// Pins for the thread's order rule (src/sendorder.ts) and its wiring in main.ts.
//
// The device report that started this: a message failed, a new one was sent,
// and the new one "flew above the not delivered ones". That was the 0.3.119
// tail rule working as built — a failed bubble was pushed to the end of the
// thread on every later send. The research pass that followed found no app
// doing it: Messages, Signal, Telegram, Google Messages and Discord all order a
// conversation by the moment the send was pressed, so a failure keeps its slot
// and later messages land BELOW it. A device photo of a Messages thread shows
// failed and delivered bubbles interleaved in send order.
//
// The rule is now one comparison: (compose time, server number, creation).
// Nothing about failing or retrying moves a row. The pure half is exercised
// directly below, step by step, with the invariant checked after every one; the
// main.ts half is source-pinned the way flight.test.ts and receipthold.test.ts
// hold theirs, because main.ts boots a real shell at import and cannot load
// under node.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compare, inReloadOrder, reloadOrder, seatBefore } from "../src/sendorder";
import type { Standing } from "../src/sendorder";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/main.ts"), "utf8");

function fnBody(name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `main.ts has no ${name}`).toBeGreaterThan(-1);
  const end = src.indexOf("\n}", start);
  return src.slice(start, end);
}

// --- the pure rule ----------------------------------------------------------

let ords = 0;
const row = (at: number, seq: number | null = null, failed = false): Standing => ({
  at, seq, ord: ++ords, failed,
});

describe("compare — compose time first, then the number, then creation", () => {
  it("the earlier compose time is above, whatever the numbers say", () => {
    // the retry in one line: written first, numbered last, still above
    expect(compare(row(10, 9), row(20, 2))).toBeLessThan(0);
  });

  it("a failure is not a standing: the mark does not enter the comparison", () => {
    const failed = row(10, null, true);
    const sent = row(20, 3);
    expect(compare(failed, sent)).toBeLessThan(0); // composed first, so above
    expect(compare(sent, failed)).toBeGreaterThan(0);
  });

  it("same millisecond: the numbered row sits above the un-numbered one", () => {
    expect(compare(row(10, 4), row(10, null))).toBeLessThan(0);
  });

  it("same millisecond and both un-numbered: creation order settles it", () => {
    const first = row(10, null, true);
    const second = row(10, null, true);
    expect(compare(first, second)).toBeLessThan(0);
  });
});

describe("seatBefore — where one row belongs", () => {
  it("a row goes above the first row composed after it", () => {
    const rows = [row(10, 1), row(20, 2), row(40, 9), row(30, 5)];
    expect(seatBefore(rows, 3)).toBe(rows[2]); // the 30 goes above the 40
  });

  it("the newest compose time belongs at the very end", () => {
    const rows = [row(10, 1), row(20, 2), row(30, 3)];
    expect(seatBefore(rows, 2)).toBeNull();
  });

  it("a later send seats BELOW a failure written before it", () => {
    const rows = [row(10, 1), row(20, null, true), row(30, null)];
    expect(seatBefore(rows, 2)).toBeNull(); // past the failure, to the end
  });

  it("a failure never moves: it is already above what came after it", () => {
    const rows = [row(20, null, true), row(30, 7)];
    expect(seatBefore(rows, 0)).toBe(rows[1]);
  });

  it("the retry moves nothing: the row is already in its compose-time slot", () => {
    // A composed at 20 and retried as seq 4, B composed at 30 and sent as seq 3
    const rows = [row(10, 1), row(20, 4), row(30, 3)];
    expect(seatBefore(rows, 1)).toBe(rows[2]);
  });

  it("a reply stamped after a failure seats under it", () => {
    const rows = [row(20, null, true), row(30, 7)];
    expect(seatBefore(rows, 1)).toBeNull();
  });
});

describe("reloadOrder / inReloadOrder — what a reload rebuilds", () => {
  it("every surviving row by compose time, failures interleaved", () => {
    const a = row(20, null, true);
    const b = row(40, null, true);
    const rows = [row(30, 7), a, row(10, 2), b];
    expect(reloadOrder(rows)).toEqual([rows[2], a, rows[0], b]);
  });

  it("a row still in the air is left out: a reload cannot show it", () => {
    const flying = row(50, null);
    const sent = row(10, 1);
    expect(reloadOrder([sent, flying])).toEqual([sent]);
    expect(inReloadOrder([sent, flying])).toBe(true);
  });

  it("a failed row is NOT left out: the durable outbox brings it back", () => {
    const failed = row(50, null, true);
    expect(reloadOrder([row(10, 1), failed])).toHaveLength(2);
  });

  it("the old tail rule's arrangement is exactly what it now flags", () => {
    // a failure pushed below a message composed after it: what 0.3.119 did
    const failed = row(10, null, true);
    const later = row(20, 9);
    expect(inReloadOrder([later, failed])).toBe(false);
    expect(inReloadOrder([failed, later])).toBe(true);
  });
});

// --- the sequences, with the invariant checked after every step -------------
// A thread the rules are applied to exactly as main.ts applies them: seatNew on
// a fresh bubble (a send, a restored outbox row) and on a frame from the
// server, seatRow on an answer, and nothing at all on a failure.

interface Named extends Standing {
  name: string;
}

class Thread {
  rows: Named[] = [];
  clock = 0;

  private seat(r: Named): void {
    const i = this.rows.indexOf(r);
    const ref = seatBefore(this.rows, i);
    this.rows.splice(i, 1);
    this.rows.splice(ref ? this.rows.indexOf(ref) : this.rows.length, 0, r);
  }

  private add(r: Named): void {
    this.rows.push(r);
    this.seat(r);
  }

  history(...seqs: number[]): this {
    for (const seq of seqs) {
      this.add({ name: `h${seq}`, at: (this.clock += 10), seq, ord: ++ords, failed: false });
    }
    return this.check("history");
  }

  /** send(): a bubble stamped now, which is the end; nothing else moves */
  send(name: string): this {
    this.add({ name, at: (this.clock += 10), seq: null, ord: ++ords, failed: false });
    return this.check(`send ${name}`);
  }

  /** transmit()'s answer: the number arrives, the compose time does not change */
  accept(name: string, seq: number): this {
    const r = this.find(name);
    r.seq = seq;
    r.failed = false;
    this.seat(r);
    return this.check(`accept ${name} as ${seq}`);
  }

  /** markFailed(): the mark goes up and the row stays exactly where it is */
  fail(name: string): this {
    const before = this.order();
    this.find(name).failed = true;
    expect(this.order(), `fail ${name}: a failure moved a row`).toEqual(before);
    return this.check(`fail ${name}`);
  }

  /** applyEvent(): a frame from the server, seated by its own clock */
  reply(seq: number): this {
    this.add({ name: `r${seq}`, at: (this.clock += 10), seq, ord: ++ords, failed: false });
    return this.check(`reply ${seq}`);
  }

  /** restoreOutbox(): a prior session's failure, rebuilt at the time it was written */
  restore(name: string, at: number): this {
    this.add({ name, at, seq: null, ord: ++ords, failed: true });
    return this.check(`restore ${name}`);
  }

  private find(name: string): Named {
    const r = this.rows.find((x) => x.name === name);
    if (!r) throw new Error(`no row ${name}`);
    return r;
  }

  private check(step: string): this {
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
  it("B lands BELOW A, and the retry leaves A exactly where it stands", () => {
    const t = new Thread().history(1, 2);
    t.send("A").fail("A");
    expect(t.order()).toEqual(["h1", "h2", "A"]);
    t.send("B");
    expect(t.order()).toEqual(["h1", "h2", "A", "B"]); // the fix: below, not above
    t.accept("B", 3);
    expect(t.order()).toEqual(["h1", "h2", "A", "B"]);
    t.accept("A", 4); // Try Again: a brand new row, numbered after B
    expect(t.order()).toEqual(["h1", "h2", "A", "B"]); // in place, motionless
    expect(t.reload()).toEqual(t.order());
  });

  it("the receipt's anchor is the LAST row in compose order, not the newest number", () => {
    const t = new Thread().history(1).send("A").fail("A").send("B").accept("B", 2).accept("A", 3);
    // A carries the highest number (3) and B is the bubble at the bottom
    expect(t.order()[t.order().length - 1]).toBe("B");
  });
});

describe("A fails, B fails too, then each is retried", () => {
  it("both keep their slots through every step", () => {
    const t = new Thread().history(1).send("A").fail("A").send("B").fail("B");
    expect(t.order()).toEqual(["h1", "A", "B"]); // B was composed after A
    t.accept("A", 2);
    expect(t.order()).toEqual(["h1", "A", "B"]); // the older one retried: no move
    t.accept("B", 3);
    expect(t.order()).toEqual(["h1", "A", "B"]);
    expect(t.reload()).toEqual(t.order());
  });
});

describe("A fails, a reply arrives, then B is sent", () => {
  it("the reply lands under the failure and B under the reply", () => {
    const t = new Thread().history(1).send("A").fail("A").reply(2);
    expect(t.order()).toEqual(["h1", "A", "r2"]);
    t.send("B").accept("B", 3);
    expect(t.order()).toEqual(["h1", "A", "r2", "B"]);
    expect(t.reload()).toEqual(t.order());
  });
});

describe("A fails, B is sent, a reply arrives before the retry", () => {
  it("A holds its slot above both and the retry does not move it", () => {
    const t = new Thread().history(1).send("A").fail("A").send("B").accept("B", 2).reply(3);
    expect(t.order()).toEqual(["h1", "A", "B", "r3"]);
    t.accept("A", 4);
    expect(t.order()).toEqual(["h1", "A", "B", "r3"]);
    expect(t.reload()).toEqual(t.order());
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
  it("the frame seats under the send, and the failure changes nothing", () => {
    const t = new Thread().history(1).send("A");
    t.reply(2); // the server answered an earlier turn while A was in the air
    expect(t.order()).toEqual(["h1", "A", "r2"]);
    t.fail("A");
    expect(t.order()).toEqual(["h1", "A", "r2"]); // it stays put now
  });
});

describe("a reload with a prior session's failure in it", () => {
  it("the restored row comes back among the history, not after it", () => {
    // written at 15, between h1 (10) and h2 (20), and back there on the reload
    const t = new Thread();
    t.rows.push({ name: "h1", at: 10, seq: 1, ord: ++ords, failed: false });
    t.rows.push({ name: "h2", at: 20, seq: 2, ord: ++ords, failed: false });
    t.clock = 20;
    t.restore("old", 15);
    expect(t.order()).toEqual(["h1", "old", "h2"]);
    expect(t.reload()).toEqual(t.order());
  });
});

// --- the wiring in main.ts --------------------------------------------------

describe("send() — nothing is re-seated on a user send", () => {
  const body = fnBody("send");

  it("the tail rule's sink is gone from the send path and from the file", () => {
    expect(body).not.toContain("sinkFailed");
    expect(src).not.toContain("function sinkFailed");
  });

  it("the bubble is built by localWrapper, which seats it by its own clock", () => {
    expect(body).toContain('localWrapper("user")');
  });

  it("the failure path re-seats the bubble rather than appending it blindly", () => {
    expect(body).toContain("seatRow(w)");
    expect(body).not.toContain("threadEl().appendChild(w)");
  });
});

describe("localWrapper / seatNew — a new row lands where its clock puts it", () => {
  const local = fnBody("localWrapper");
  const seat = fnBody("seatNew");

  it("the compose time is a parameter, defaulting to now", () => {
    expect(local).toContain("at: number = Date.now()");
    expect(local).toContain("wrapper.dataset.ts = String(at)");
  });

  it("every wrapper takes a creation ordinal, so the sort is total", () => {
    expect(local).toContain("wrapper.dataset.ord = String(++rowOrd)");
    expect(fnBody("applyEvent")).toContain("wrapper.dataset.ord = String(++rowOrd)");
  });

  it("the row is appended and then seated, never appended blindly", () => {
    expect(local).toContain("threadEl().appendChild(wrapper)");
    expect(local).toContain("seatNew(wrapper)");
    expect(local.indexOf("appendChild(wrapper)")).toBeLessThan(local.indexOf("seatNew(wrapper)"));
  });

  it("seatNew reads the rule and takes the dots with it at the end", () => {
    expect(seat).toContain("seatBefore(rows, rows.length - 1)");
    expect(seat).toContain("moveTypingAfter(t, w)");
  });
});

describe("seatRow — the one rule, applied to the DOM", () => {
  const seat = fnBody("seatRow");
  const plan = fnBody("seatPlan");

  it("the entrance is stilled first, so a move cannot replay the pop-in", () => {
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

  it("the dots follow whatever lands at the end, failure or not", () => {
    expect(seat).toContain("moveTypingAfter(t, w)");
    expect(seat).not.toContain('classList.contains("failed")');
  });

  it("the standings are the compose time, the number and the ordinal", () => {
    const st = fnBody("threadStandings");
    expect(st).toContain("at: Number(el.dataset.ts) || 0");
    expect(st).toContain("el.dataset.seq ? Number(el.dataset.seq) : null");
    expect(st).toContain("ord: Number(el.dataset.ord) || 0");
  });
});

describe("applyEvent — a frame from the server is seated by its own clock", () => {
  const body = fnBody("applyEvent");

  it("the unsent-band lookup is gone: there is no band to slot above", () => {
    expect(body).not.toContain('querySelector<HTMLElement>(".evt.failed")');
    expect(body).not.toContain('querySelector<HTMLElement>(".evt.restored")');
  });

  it("it appends and seats, the same two lines every new row takes", () => {
    expect(body).toContain("threadEl().appendChild(wrapper)");
    expect(body).toContain("seatNew(wrapper)");
  });

  it("renderInto writes the clock before the row is seated by it", () => {
    expect(body.indexOf("renderInto(wrapper, m)")).toBeLessThan(body.indexOf("seatNew(wrapper)"));
    expect(fnBody("renderInto")).toContain("wrapper.dataset.ts = String(at)");
  });
});

describe("markFailed — the mark goes up and nothing moves", () => {
  const body = fnBody("markFailed");

  it("no re-seat runs on a failure at all", () => {
    expect(body).toContain('w.classList.add("failed")');
    expect(body).not.toContain("seatRow(w)");
  });

  it("the record keeps the wrapper's own compose time, so a restore matches", () => {
    expect(body).toContain("persistFailed(id, Number(w.dataset.ts) || Date.now()");
  });
});

describe("transmit — the compose time rides every attempt", () => {
  const body = fnBody("transmit");

  it("the send carries sent_at, read straight off the bubble", () => {
    expect(body).toContain("sent_at: new Date(Number(w.dataset.ts) || Date.now()).toISOString()");
  });

  it("a retry takes the same path, so it carries the SAME sent_at", () => {
    expect(fnBody("retrySend")).toContain("transmit(w, held.text, held.files)");
    expect(fnBody("retrySend")).not.toContain("dataset.ts");
  });

  it("the accepted send is still settled by the answer", () => {
    expect(body).toContain("landSend(w, ");
    expect(body.indexOf("w.dataset.seq = String(seq)")).toBeLessThan(body.indexOf("landSend(w, "));
  });
});

describe("restoreOutbox — a prior session's failures come back in their slots", () => {
  const body = fnBody("restoreOutbox");

  it("the record's own time places the bubble, not the end of the thread", () => {
    expect(body).toContain('localWrapper("user", rec.ts)');
  });

  it("the id settles a tie, so two records of one millisecond restore in one order", () => {
    expect(body).toContain("records.sort((a, b) => a.ts - b.ts ||");
  });

  it("the tail-pinning marker is gone rather than left dead", () => {
    expect(body).not.toContain('classList.add("restored")');
    expect(src).not.toContain('classList.remove("restored")');
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

describe("the re-timed row: the guard for a server that ignores sent_at", () => {
  const body = fnBody("retimeRow");

  it("writes the wrapper's ts and every row's time label", () => {
    expect(body).toContain("w.dataset.ts = String(at)");
    expect(body).toContain("row.dataset.time = fmtTime(at)");
  });

  it("an answer within a second of the row's own clock re-times nothing", () => {
    // which is EVERY send now: the server stores the clock the row was drawn on
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

describe("the receipt is anchored, not numbered", () => {
  it("it still finds its bubble by the anchor the derivation names", () => {
    expect(fnBody("updateReceipt")).toContain("wrapperFor(r.seq)");
  });

  it("nothing in the order rule touches the stamp", () => {
    for (const fn of ["seatRow", "seatNew", "seatPlan", "threadStandings"]) {
      expect(fnBody(fn)).not.toContain("receipt");
    }
  });
});
