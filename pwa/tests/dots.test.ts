// Pins for the typing-dots placement (src/dots.ts). The device bug: a message
// sent while the dots showed appended past them and landed BELOW the dots.
// The reorder is structural (insertBefore relocates the node, no animation),
// so it is pinned against a minimal node fake — the same insertBefore /
// appendChild / sibling semantics the DOM gives the module, no jsdom needed.
import { describe, expect, it } from "vitest";
import { moveTypingAfter, placeTyping } from "../src/dots";

class FakeNode {
  id: string;
  classes: string[];
  parent: FakeNode | null = null;
  kids: FakeNode[] = [];
  constructor(id = "", ...classes: string[]) {
    this.id = id;
    this.classes = classes;
  }
  get nextElementSibling(): FakeNode | null {
    if (!this.parent) return null;
    return this.parent.kids[this.parent.kids.indexOf(this) + 1] ?? null;
  }
  get lastElementChild(): FakeNode | null {
    return this.kids[this.kids.length - 1] ?? null;
  }
  private detach(n: FakeNode): void {
    if (n.parent) n.parent.kids.splice(n.parent.kids.indexOf(n), 1);
    n.parent = null;
  }
  appendChild(n: FakeNode): void {
    this.detach(n);
    n.parent = this;
    this.kids.push(n);
  }
  insertBefore(n: FakeNode, ref: FakeNode | null): void {
    if (!ref) return this.appendChild(n);
    this.detach(n); // DOM semantics: a move, not a copy
    n.parent = this;
    this.kids.splice(this.kids.indexOf(ref), 0, n);
  }
  querySelector(sel: string): FakeNode | null {
    for (const k of this.kids) {
      if (sel === "#typing" && k.id === "typing") return k;
      if (sel === ".evt.failed" && k.classes.includes("evt") && k.classes.includes("failed")) {
        return k;
      }
    }
    return null;
  }
}

const el = (n: FakeNode): HTMLElement => n as unknown as HTMLElement;
const order = (t: FakeNode): string[] => t.kids.map((k) => k.id || k.classes.join("."));

function thread(...kids: FakeNode[]): FakeNode {
  const t = new FakeNode("thread");
  for (const k of kids) t.appendChild(k);
  return t;
}

const msg = (id: string): FakeNode => new FakeNode(id, "evt");
const dots = (): FakeNode => new FakeNode("typing");
// a prior session's unsent send, rebuilt from the outbox and marked failed
const restored = (): FakeNode => new FakeNode("old-fail", "evt", "failed");
// this session's failure: the same mark, and under strict compose order it
// holds no ground at all — the dots go below it like below any other row
const failed = (): FakeNode => new FakeNode("new-fail", "evt", "failed");

describe("moveTypingAfter", () => {
  it("a send during dots: the appended wrapper ends up above them", () => {
    const t = thread(msg("m1"), dots());
    const w = msg("w1");
    t.appendChild(w); // localWrapper appends to the absolute end, past the dots
    moveTypingAfter(el(t), el(w));
    expect(order(t)).toEqual(["m1", "w1", "typing"]);
  });

  it("two sends during dots stack as a run with the dots below both", () => {
    const t = thread(msg("m1"), dots());
    for (const id of ["w1", "w2"]) {
      const w = msg(id);
      t.appendChild(w);
      moveTypingAfter(el(t), el(w));
    }
    expect(order(t)).toEqual(["m1", "w1", "w2", "typing"]);
  });

  it("a frame seated above an older failure still takes the dots with it", () => {
    // applyEvent seats by compose time, so a frame CAN land above a failure
    // written before it; wherever it lands, the dots follow that wrapper
    const t = thread(msg("m1"), dots(), restored());
    const w = msg("w1");
    t.insertBefore(w, t.querySelector(".evt.failed"));
    moveTypingAfter(el(t), el(w));
    expect(order(t)).toEqual(["m1", "w1", "typing", "old-fail"]);
  });

  it("no dots on screen: a plain append stays where it landed", () => {
    const t = thread(msg("m1"));
    const w = msg("w1");
    t.appendChild(w);
    moveTypingAfter(el(t), el(w));
    expect(order(t)).toEqual(["m1", "w1"]);
  });

  it("dots already directly below the content: no reorder happens", () => {
    const t = thread(msg("m1"), msg("w1"), dots());
    const w = t.kids[1];
    const before = order(t);
    moveTypingAfter(el(t), el(w));
    expect(order(t)).toEqual(before);
  });
});

describe("placeTyping", () => {
  it("fresh dots land at the end of a plain thread", () => {
    const t = thread(msg("m1"), msg("m2"));
    placeTyping(el(t), el(dots()));
    expect(order(t)).toEqual(["m1", "m2", "typing"]);
  });

  // rewritten with the tail rule's removal: a failure is no longer a band the
  // dots have to stay above, it is a row dated where it was written. The dots
  // say the agent is typing NOW, so they belong under everything, failures too.
  it("fresh dots land under a restored failure, not above it", () => {
    const t = thread(msg("m1"), restored());
    placeTyping(el(t), el(dots()));
    expect(order(t)).toEqual(["m1", "old-fail", "typing"]);
  });

  it("fresh dots land under this session's failure the same way", () => {
    const t = thread(msg("m1"), failed());
    placeTyping(el(t), el(dots()));
    expect(order(t)).toEqual(["m1", "new-fail", "typing"]);
  });

  it("dots already at the end are left alone", () => {
    const t = thread(msg("m1"), failed(), dots());
    const d = t.kids[2];
    placeTyping(el(t), el(d));
    expect(order(t)).toEqual(["m1", "new-fail", "typing"]);
  });
});
