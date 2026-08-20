// Pins for the send-flight receipt hold (the end-of-send bounce's last mover)
// and the TEMP send-window motion recorder. On a fast connection the send ACK
// lands mid-flight (real ACKs in 50-200ms against the 400ms beat) and
// updateReceipt then relocates the delivery stamp — removed from under the
// previous sent bubble, appended under the flying one — so the landing seat
// and everything above it jolt while the bubble is airborne. The hold parks
// any layout-mutating receipt work while a flight is up and applies it when
// the last flight settles, finish and cancel alike; label-only fades stay
// live, and sends with no flight keep the immediate path. main.ts boots a
// real shell at import and cannot load under node, so the wiring is
// source-pinned like flight.test.ts.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/main.ts"), "utf8");
const holdSrc = readFileSync(join(here, "../src/hold.ts"), "utf8");

function fnBody(name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("\n}", start);
  return src.slice(start, end);
}

describe("updateReceipt — layout mutations park while a flight is airborne", () => {
  const body = fnBody("updateReceipt");

  it("a relocation to a different wrapper parks on the flight gate", () => {
    // the fresh-stamp swap (remove + append) sits behind the flightsUp gate
    const gate = body.lastIndexOf("if (flightsUp > 0)");
    const swap = body.indexOf("wrapper.appendChild(buildReceipt(");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(swap);
    expect(body).toContain("receiptPending = true");
  });

  it("the bare removal (stamp target gone) parks behind the same hold", () => {
    // removing the stamp shifts every row above it exactly like a relocation
    const noTarget = body.indexOf("if (!r || !wrapper)");
    const sameWrapper = body.indexOf("existing.parentElement === wrapper");
    const gate = body.indexOf("flightsUp > 0", noTarget);
    expect(noTarget).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(noTarget);
    expect(gate).toBeLessThan(sameWrapper); // inside the no-target branch
  });

  it("same-wrapper label fades stay live: the fade branch precedes the gate", () => {
    // the Delivered -> Read flip is opacity-only (no layout), so it must
    // return before the relocation gate can park it
    const fade = body.indexOf('classList.add("rc-hide")');
    const gate = body.lastIndexOf("if (flightsUp > 0)");
    expect(fade).toBeGreaterThan(-1);
    expect(fade).toBeLessThan(gate);
  });

  it("the gate is the live animation count, never a timer", () => {
    // sends with no flight (flyFromField's early return) start no animation,
    // so flightsUp stays 0 and the immediate path is untouched; an ACK after
    // touchdown reads 0 the same way
    expect(body).not.toContain("lastLaunchAt");
    expect(body).not.toContain("performance.now");
    expect(fnBody("flyFromField")).toContain("flightsUp++");
  });

  it("both parks leave a receipt-hold record on the trail", () => {
    expect(body.match(/holdDiagRecord\("receipt-hold", \{ phase: "park" \}\)/g))
      .toHaveLength(2);
  });
});

describe("flightSettled — the parked stamp lands when the last flight ends", () => {
  const body = fnBody("flightSettled");
  const fly = fnBody("flyFromField");

  it("finish AND cancel both route through flightSettled", () => {
    // a cancelled flight (torn-down wrapper, replay beating the ACK) must
    // still deliver its stamp
    expect(fly.match(/flightSettled\(\);/g)).toHaveLength(2);
    expect(fly.indexOf("flightSettled()")).toBeGreaterThan(fly.indexOf('phase: "finish"'));
    expect(fly.lastIndexOf("flightSettled()")).toBeGreaterThan(fly.indexOf('phase: "cancel"'));
  });

  it("waits for the LAST flight: one counter, floored, drained per settle", () => {
    expect(body).toContain("if (flightsUp > 0) flightsUp--");
    expect(body).toContain("if (flightsUp > 0 || !receiptPending) return");
  });

  it("applies through the sibling-shift machinery, so the seat's hop glides", () => {
    // measure, swap, play: the relocation is height-neutral, so the seat's hop
    // is the only position that changes and it glides on the shared beat. A
    // moving stamp is the same element re-parented, so the walk reads it as a
    // row that went down, not a newborn; only a first-ever stamp fades up.
    const measure = body.indexOf("beginSiblingShift()");
    const apply = body.indexOf("updateReceipt()");
    const play = body.indexOf("shift.play()");
    expect(measure).toBeGreaterThan(-1);
    expect(measure).toBeLessThan(apply);
    expect(apply).toBeLessThan(play);
  });

  it("records the apply on the trail and clears the slot before recomputing", () => {
    expect(body).toContain('holdDiagRecord("receipt-hold", { phase: "apply" })');
    expect(body.indexOf("receiptPending = false")).toBeLessThan(body.indexOf("updateReceipt()"));
  });

  it("a fresh shell resets the counter and the slot", () => {
    const shell = fnBody("renderChat");
    expect(shell).toContain("flightsUp = 0");
    expect(shell).toContain("receiptPending = false");
  });
});

// --- the stamp's move to a newer bubble: fade out, cross dark, fade in --------
// The device report: sending a few messages in a row made the Delivered tag
// look like it slid down the newly sent bubble. It was not a slide. The stamp
// was destroyed under the previous message and a fresh one built under the new
// one, and the eye read the two spots as travel. The move now takes the same
// two-phase fade the Delivered -> Read word flip already uses, with the
// crossing in the middle, while the label is at opacity 0.

describe("updateReceipt: a move to a newer bubble fades out, crosses, fades in", () => {
  const body = fnBody("updateReceipt");
  const travelStart = body.indexOf('existing.dataset.travel === "dark"');
  const travel = body.slice(travelStart, body.indexOf("existing?.remove()", travelStart));

  it("beat one fades the stamp out where it stands, before anything moves", () => {
    const fade = body.indexOf('existing.dataset.travel = "fade"');
    expect(fade).toBeGreaterThan(-1);
    expect(body.slice(fade)).toContain('classList.add("rc-hide")');
    expect(fade).toBeLessThan(travelStart); // the fade is armed before the crossing
  });

  it("beat one is opacity only, so it starts even mid-flight", () => {
    // no layout is touched by a fade, so the flight hold has nothing to protect:
    // arming it at ACK time is what leaves the label already dark at touchdown
    const fade = body.indexOf('existing.dataset.travel = "fade"');
    expect(fade).toBeLessThan(body.lastIndexOf("if (flightsUp > 0)"));
  });

  it("beat two crosses the SAME element: no remove, no rebuild", () => {
    // the height ledger below is the reason: one appendChild of an attached node
    // is a single DOM move, so the stamp's box is never absent from the thread
    expect(travel).toContain("wrapper.appendChild(existing)");
    expect(travel).not.toContain("existing.remove()");
    expect(travel).not.toContain("buildReceipt(");
  });

  it("beat three fades back in only after the crossing", () => {
    const cross = travel.indexOf("wrapper.appendChild(existing)");
    const fadeIn = travel.indexOf('classList.remove("rc-hide")');
    expect(cross).toBeGreaterThan(-1);
    expect(fadeIn).toBeGreaterThan(cross);
    // a re-parented element resolves its style fresh, and a first resolve never
    // transitions: the read-back at opacity 0 gives the fade a value to start from
    expect(travel.indexOf("void layer.offsetHeight")).toBeGreaterThan(cross);
    expect(travel.indexOf("void layer.offsetHeight")).toBeLessThan(fadeIn);
  });

  it("the crossing waits for opacity 0: only receiptTravel can reach beat two", () => {
    // dark is set by the layer's transitionend, never by a timer
    expect(fnBody("receiptTravel")).toContain('el.dataset.travel = "dark"');
    expect(src).not.toContain("setTimeout(() => receiptTravel");
    const handler = src.slice(src.indexOf("function buildReceipt("));
    const route = handler.indexOf("return receiptTravel(el)");
    expect(route).toBeGreaterThan(-1);
    // it must divert BEFORE the plain word-flip fade-in, or the label would
    // come back up at the old spot and then jump
    expect(route).toBeLessThan(handler.indexOf('layer.classList.remove("rc-hide")'));
  });

  it("replay bursts never fade: suppressAnim keeps the immediate rebuild", () => {
    // a transition that never runs never ends, so a fade armed under suppressAnim
    // would strand the stamp invisible at the old spot
    const fade = body.indexOf('existing.dataset.travel = "fade"');
    expect(body.slice(0, fade)).toContain("!suppressAnim");
  });

  it("a move that evaporates releases the label where it already is", () => {
    // the newer wrapper can be replayed away mid-fade; the stamp must not sit
    // dark forever waiting for a crossing that no longer applies
    const same = body.indexOf("existing.parentElement === wrapper");
    const release = body.indexOf("delete existing.dataset.travel", same);
    expect(release).toBeGreaterThan(same);
    expect(release).toBeLessThan(travelStart);
  });
});

describe("receiptTravel: the invisible beat never fights the flight's glide", () => {
  const body = fnBody("receiptTravel");

  it("marks the stamp dark before handing back to updateReceipt", () => {
    expect(body.indexOf('el.dataset.travel = "dark"')).toBeLessThan(body.indexOf("updateReceipt()"));
  });

  it("a flight still up parks instead of opening its own shift", () => {
    // beginSiblingShift cancels every running shift animation, so opening one
    // here would kill the flight's own glide mid-air
    const gate = body.indexOf("if (flightsUp > 0)");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(body.indexOf("beginSiblingShift()"));
    expect(body.slice(gate)).toContain("return updateReceipt()");
  });

  it("with no flight it opens its own measure, swap, play", () => {
    // the crossing lands outside any send, so the seat's hop needs a shift of
    // its own or it would jump under a label that is not there to explain it
    const measure = body.indexOf("beginSiblingShift()");
    const apply = body.lastIndexOf("updateReceipt();"); // the parked path returns one earlier
    const play = body.indexOf("shift.play()");
    expect(measure).toBeGreaterThan(-1);
    expect(measure).toBeLessThan(apply);
    expect(apply).toBeLessThan(play);
  });
});

// --- the height ledger --------------------------------------------------------
// The property beat two rests on: re-appending an ALREADY-ATTACHED node is one
// DOM move, never a detach followed by an insert, so the thread is never short
// the stamp's box for even a frame. Pinned against a minimal node fake with the
// DOM's own appendChild semantics (the same approach dots.test.ts takes), the
// thread's height sampled around every mutation. The shape this replaced
// (remove the old stamp, build a fresh one) runs through the same ledger to
// show the ledger has teeth. Tops are content offsets; the thread is pinned to
// its bottom and the total height is unchanged, so they are screen offsets too.

class Box {
  parent: Box | null = null;
  kids: Box[] = [];
  constructor(readonly name: string, readonly h = 0) {}
  appendChild(n: Box): void {
    if (n.parent) n.parent.kids.splice(n.parent.kids.indexOf(n), 1); // one move
    n.parent = this;
    this.kids.push(n);
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.kids.splice(this.parent.kids.indexOf(this), 1);
    this.parent = null;
  }
  height(): number {
    return this.h + this.kids.reduce((sum, k) => sum + k.height(), 0);
  }
  holds(n: Box): boolean {
    return this === n || this.kids.some((k) => k.holds(n));
  }
}

const STAMP_H = 18;

// the owner's case: two sends in a row. The stamp sits under the previous
// bubble, the new bubble has landed below it, and the stamp must end up under
// the new one. The .evt wrappers are display:contents, so only rows and the
// stamp carry height.
function threadWithStamp(): { thread: Box; newWrapper: Box; stamp: Box } {
  const thread = new Box("thread");
  const older = new Box("evt-older");
  const prev = new Box("evt-prev");
  const fresh = new Box("evt-new");
  thread.appendChild(older);
  older.appendChild(new Box("row-older", 40));
  thread.appendChild(prev);
  prev.appendChild(new Box("row-prev", 40));
  const stamp = new Box("receipt", STAMP_H);
  prev.appendChild(stamp);
  thread.appendChild(fresh);
  fresh.appendChild(new Box("row-new", 40));
  return { thread, newWrapper: fresh, stamp };
}

function tops(thread: Box): Map<string, number> {
  const out = new Map<string, number>();
  let y = 0;
  const walk = (b: Box): void => {
    if (b.kids.length === 0) {
      out.set(b.name, y);
      y += b.h;
      return;
    }
    for (const k of b.kids) walk(k);
  };
  walk(thread);
  return out;
}

describe("the crossing's height ledger: no space is lost while the label is dark", () => {
  it("the crossing is ONE mutation, so there is no in-between state to lose", () => {
    const { thread, newWrapper, stamp } = threadWithStamp();
    const before = thread.height();
    newWrapper.appendChild(stamp); // exactly what beat two runs
    expect(thread.height()).toBe(before);
    expect(thread.holds(stamp)).toBe(true);
    expect(stamp.parent).toBe(newWrapper);
  });

  it("only the newer bubble's seat changes position, by exactly the stamp's height", () => {
    const { thread, newWrapper, stamp } = threadWithStamp();
    const before = tops(thread);
    newWrapper.appendChild(stamp);
    const after = tops(thread);
    const moved = [...after].filter(([name, top]) => before.get(name) !== top).map(([n]) => n);
    expect(moved).toEqual(["row-new", "receipt"]); // nothing above the stamp stirs
    expect(before.get("row-new")! - after.get("row-new")!).toBe(STAMP_H); // the seat's hop
  });

  it("the ledger has teeth: remove-then-rebuild leaves the thread short", () => {
    const { thread, newWrapper, stamp } = threadWithStamp();
    const before = thread.height();
    const samples: number[] = [];
    stamp.remove();
    samples.push(thread.height()); // the gap: rows drop with no label to explain it
    newWrapper.appendChild(new Box("receipt", STAMP_H));
    samples.push(thread.height());
    expect(samples).toEqual([before - STAMP_H, before]);
  });
});

describe("send-window motion recorder (TEMP, rides the holddiag trail)", () => {
  const rec = fnBody("recordSendMotion");

  it("armed at flight start with the landing row", () => {
    const fly = fnBody("flyFromField");
    expect(fly).toContain("recordSendMotion(msgs[msgs.length - 1])");
  });

  it("samples scrollTop, scrollHeight, and the transform-stripped seat", () => {
    // the seat is the bubble's LAYOUT position: stripping the running
    // transform is what keeps the flying bubble itself out of the metric
    expect(rec).toContain("t.scrollTop");
    expect(rec).toContain("t.scrollHeight");
    expect(rec).toContain("seatTop(msg)");
    expect(fnBody("seatTop")).toContain("DOMMatrixReadOnly");
  });

  it("names the mover past a 1px threshold", () => {
    expect(rec).toContain("Math.abs(delta) > 1");
    expect(rec).toContain('holdDiagRecord("send-motion"');
    expect(rec).toMatch(/moved: name/);
  });

  it("caps the window's records and bounds the window itself", () => {
    expect(src).toContain("const SEND_MOTION_MAX = 40");
    expect(src).toContain("const SEND_MOTION_WINDOW_MS = 600");
    expect(rec).toContain("recorded < SEND_MOTION_MAX");
    expect(rec).toContain("< SEND_MOTION_WINDOW_MS");
  });

  it("a rapid second send re-arms one window instead of stacking loops", () => {
    expect(rec).toContain("cancelAnimationFrame(sendMotionRaf)");
  });

  it("the new record names trigger the diag post", () => {
    expect(holdSrc).toContain('ev === "send-motion"');
    expect(holdSrc).toContain('ev === "receipt-hold"');
  });
});
