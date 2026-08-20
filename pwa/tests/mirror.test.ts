// Pins for the compose box's ruler (src/mirror.ts). The device bug: the box
// was measured by collapsing the LIVE one to its rows="1" intrinsic and
// reading scrollHeight while it sat there. The bar and the thread split one
// fixed column, so that collapse handed the thread the lost pixels for the
// length of one forced layout and the engine pulled the thread's scroll offset
// down into the smaller range left over. A keystroke that grew a line took a
// repair branch and looked fine; the very next keystroke changed no height,
// took no branch (viewport.ts answers "none"), and kept the clamp. The thread
// jumped up by exactly the height the box had lost, one keystroke after every
// new line.
//
// The stand-in below is the load-bearing part of these tests: a shell whose
// thread and compose box share one fixed column, where any geometry read
// flushes the pending height write and a shrunken thread pulls its offset back
// into range. That clamp is the browser behaviour the whole bug turns on, so
// the shipped collapse-and-read is run against the same stand-in first and
// asserted to MOVE the thread. Without that arm these tests would pass either
// way and prove nothing.
import { describe, expect, it } from "vitest";
import {
  type LiveBox,
  type ScrollBox,
  type StyleSource,
  type Twin,
  dressMirror,
  fitComposeBox,
} from "../src/mirror";

// the shipped type and box: 17px/1.35 lands on a 23px line and styles.css puts
// 8px of padding above and below it, so a rows="1" box is 39px, which is the
// number main.ts's rows attribute and styles.css's --field-h agree on
const LINE_H = 23;
const PAD_TOP = 8;
const PAD_BOTTOM = 8;
const PAD_LEFT = 14;
const PAD_RIGHT = 40; // the ↑'s reserved column
const ONE_LINE = LINE_H + PAD_TOP + PAD_BOTTOM;
const CAP = 120; // the five-line ceiling, styles.css max-height and main.ts's Math.min
const CHAR_W = 8; // one character, in this stand-in

// While the keyboard is up the ＋ yields its slot and the right inset swallows
// it (styles.css #app.kb .compose textarea), so the wrap width really does
// move under a live box mid-session.
const PAD_RIGHT_KB = 82;

const SHORT = "x".repeat(11); // one line
const WRAPPED = "x".repeat(70); // three lines at the resting width
const TALL = "x".repeat(300); // ten lines: well past the ceiling
const REWRAPS = "x".repeat(60); // two lines resting, three once the padding widens

// The stand-in's wrap: whole characters at a fixed width, a line each, plus the
// box's own padding. A trailing newline gets its own empty line, the way a
// textarea gives one. A width that was never set reads back NaN and poisons
// every number derived from it, so a twin nobody told where the line ends can
// never quietly answer with a plausible wrong height.
function needFor(value: string, contentWidth: number): number {
  const perLine = Math.floor(contentWidth / CHAR_W);
  if (!(perLine >= 1)) return Number.NaN;
  let lines = 0;
  for (const para of value.split("\n")) lines += Math.max(1, Math.ceil(para.length / perLine));
  return lines * LINE_H + PAD_TOP + PAD_BOTTOM;
}

// The fixed flex column the thread and the compose bar share (styles.css #app
// is the column, .thread is flex:1): every pixel the box takes is a pixel of
// thread height gone, and every pixel of thread height gone is a pixel off the
// thread's maximum scroll offset.
class FakeShell {
  readonly height = 700; // the column
  contentHeight = 2400; // what the thread holds
  boxHeight = ONE_LINE; // the live compose box, as rows="1" leaves it
  boxWidth = 320; // the pill's inner width
  pendingHeight: number | null = null;
  private offset = 0;

  // Any geometry read flushes the pending style write, exactly as a real
  // engine does, and the flush is where a thread that just grew pulls its
  // offset back into the range that is left. THIS is the clamp.
  flush(): void {
    const next = this.pendingHeight;
    this.pendingHeight = null;
    if (next === null || next === this.boxHeight) return;
    this.boxHeight = next;
    this.offset = Math.min(this.offset, this.maxScroll());
  }

  maxScroll(): number {
    return Math.max(0, this.contentHeight - (this.height - this.boxHeight));
  }

  boxHeightNow(): number {
    this.flush();
    return this.boxHeight;
  }

  readScroll(): number {
    this.flush();
    return this.offset;
  }

  writeScroll(next: number): void {
    this.flush();
    this.offset = Math.max(0, Math.min(next, this.maxScroll()));
  }
}

class FakeThread implements ScrollBox {
  private readonly shell: FakeShell;

  constructor(shell: FakeShell) {
    this.shell = shell;
  }

  get scrollTop(): number {
    return this.shell.readScroll();
  }

  set scrollTop(next: number) {
    this.shell.writeScroll(next);
  }
}

// The live compose box. It is also the style source the twin is dressed from,
// which is the real arrangement: the twin's values come off this element.
class FakeBox implements LiveBox, StyleSource {
  value = "";
  padRight = PAD_RIGHT;
  readonly style: { height: string };
  private readonly shell: FakeShell;

  constructor(shell: FakeShell) {
    this.shell = shell;
    let written = "";
    this.style = {
      get height(): string {
        return written;
      },
      set height(next: string) {
        written = next;
        // "auto" on a rows="1" textarea is the 39px intrinsic: the collapse
        // the shipped measurement leaned on
        shell.pendingHeight = next === "auto" ? ONE_LINE : parseFloat(next);
      },
    };
  }

  get offsetHeight(): number {
    return this.shell.boxHeightNow();
  }

  get scrollHeight(): number {
    // a textarea reports the taller of its own box and what the text needs,
    // which is why the shipped code had to collapse the box before reading it
    return Math.max(this.offsetHeight, needFor(this.value, this.contentWidth()));
  }

  contentWidth(): number {
    return this.shell.boxWidth - PAD_LEFT - this.padRight;
  }

  getPropertyValue(prop: string): string {
    switch (prop) {
      case "box-sizing":
        return "border-box";
      case "padding-top":
        return `${PAD_TOP}px`;
      case "padding-bottom":
        return `${PAD_BOTTOM}px`;
      case "padding-left":
        return `${PAD_LEFT}px`;
      case "padding-right":
        return `${this.padRight}px`;
      case "line-height":
        return `${LINE_H}px`;
      default:
        return ""; // everything else this box leaves at its inherited value
    }
  }
}

// The off-screen twin. Its own box is the rows="1" intrinsic it copies off the
// live box, and its wrap width comes only from what dressMirror wrote on it.
class FakeTwin implements Twin {
  value = "";
  readonly props = new Map<string, string>();
  readonly style = {
    setProperty: (prop: string, value: string): void => {
      if (value) this.props.set(prop, value);
      else this.props.delete(prop); // an empty value removes, as the DOM does
    },
  };

  get scrollHeight(): number {
    return Math.max(ONE_LINE, needFor(this.value, this.contentWidth()));
  }

  contentWidth(): number {
    const px = (prop: string): number => parseFloat(this.props.get(prop) ?? "");
    return px("width") - px("padding-left") - px("padding-right");
  }
}

function world() {
  const shell = new FakeShell();
  const box = new FakeBox(shell);
  const thread = new FakeThread(shell);
  const twin = new FakeTwin();
  // the app dresses the twin from the live box's computed style and measured
  // border box before every fit (composeMirror); this is that step
  const dress = (): FakeTwin => {
    dressMirror(twin, box, shell.boxWidth);
    return twin;
  };
  return { shell, box, thread, twin, dress };
}

// main.ts's shipped measurement, kept here as the thing the fix replaces: the
// live box is collapsed to its intrinsic, scrollHeight is read while it sits
// collapsed, and the height goes back. Nothing saves the thread's position.
function shippedAutosize(box: FakeBox): void {
  box.style.height = "auto";
  box.style.height = `${Math.min(box.scrollHeight, CAP)}px`;
}

describe("the keystroke that changes no height", () => {
  it("the shipped collapse-and-read moves the thread anyway (the reported jump)", () => {
    const { shell, box, thread } = world();
    box.value = WRAPPED;
    shippedAutosize(box);
    expect(box.offsetHeight).toBe(85); // three lines
    thread.scrollTop = shell.maxScroll(); // typing at the tail, where he was
    const before = thread.scrollTop;

    box.value = `${WRAPPED}x`; // the next keystroke: still three lines
    shippedAutosize(box);

    expect(box.offsetHeight).toBe(85); // the box never changed size
    // and yet the view moved, by exactly what the box gave up while collapsed:
    // stA = min(stB, maxScroll - (oldHeight - 39)), the shape of the records
    expect(thread.scrollTop).toBe(before - (85 - ONE_LINE));
  });

  it("measured on the twin instead, the thread does not move at all", () => {
    const { shell, box, thread, dress } = world();
    box.value = WRAPPED;
    fitComposeBox(box, dress(), thread, CAP);
    expect(box.offsetHeight).toBe(85);
    thread.scrollTop = shell.maxScroll();
    const before = thread.scrollTop;

    box.value = `${WRAPPED}x`;
    const fit = fitComposeBox(box, dress(), thread, CAP);

    expect(fit.oldHeight).toBe(fit.newHeight); // the height really did not change
    expect(fit.scrollMid).toBe(before); // stM === stB: nothing was ever clamped
    expect(thread.scrollTop).toBe(before); // the view is exactly where he left it
  });

  it("with no twin to measure on it falls back, and the restore repairs it", () => {
    const { shell, box, thread, dress } = world();
    box.value = WRAPPED;
    fitComposeBox(box, dress(), thread, CAP);
    thread.scrollTop = shell.maxScroll();
    const before = thread.scrollTop;

    box.value = `${WRAPPED}x`;
    const fit = fitComposeBox(box, null, thread, CAP);

    expect(fit.newHeight).toBe(85); // still sized correctly, which comes first
    expect(fit.scrollMid).toBe(before - (85 - ONE_LINE)); // the collapse clamped
    expect(thread.scrollTop).toBe(before); // and the guard put it back
  });
});

describe("the twin measures what the live box would have measured", () => {
  const cases: readonly (readonly [string, string, number])[] = [
    ["a single line", SHORT, ONE_LINE],
    ["a wrapped line", WRAPPED, 85],
    ["text past the 120px ceiling", TALL, CAP],
  ];

  for (const [name, text, height] of cases) {
    it(`${name}: the twin and the live box land on the same height`, () => {
      const viaTwin = world();
      const viaCollapse = world();
      viaTwin.box.value = text;
      viaCollapse.box.value = text;

      const a = fitComposeBox(viaTwin.box, viaTwin.dress(), viaTwin.thread, CAP);
      const b = fitComposeBox(viaCollapse.box, null, viaCollapse.thread, CAP);

      expect(a.newHeight).toBe(b.newHeight);
      expect(a.newHeight).toBe(height);
    });
  }

  it("the raw reading agrees too, not just the one the ceiling flattens", () => {
    const { box, dress } = world();
    box.value = TALL;
    const twin = dress();
    twin.value = box.value;
    box.style.height = "auto"; // the live box, collapsed, as the old path had it
    expect(twin.scrollHeight).toBe(box.scrollHeight);
    expect(twin.scrollHeight).toBe(246); // ten lines, well past the ceiling
  });

  it("the keyboard's padding widen re-wraps the live box, and the twin follows", () => {
    const resting = world();
    resting.box.value = REWRAPS;
    const before = fitComposeBox(resting.box, resting.dress(), resting.thread, CAP).newHeight;

    // the ＋ yields its slot and the right inset swallows it: same box width,
    // narrower text, one more line
    resting.box.padRight = PAD_RIGHT_KB;
    const after = fitComposeBox(resting.box, resting.dress(), resting.thread, CAP).newHeight;

    expect(before).toBe(62);
    expect(after).toBe(85); // it really re-wrapped

    // and it re-wrapped to exactly what the live box itself would have said
    const check = world();
    check.box.padRight = PAD_RIGHT_KB;
    check.box.value = REWRAPS;
    expect(after).toBe(fitComposeBox(check.box, null, check.thread, CAP).newHeight);
  });
});

describe("the twin is a ruler, not a second control", () => {
  it("stays out of the pill's flex flow, out of sight, and uncapped", () => {
    const twin = world().dress();
    expect(twin.props.get("position")).toBe("absolute");
    expect(twin.props.get("visibility")).toBe("hidden"); // laying out, never painted
    expect(twin.props.get("height")).toBe("auto"); // the rows="1" intrinsic
    expect(twin.props.get("max-height")).toBe("none"); // the ceiling is the caller's
    expect(twin.props.get("overflow")).toBe("hidden"); // no bar may narrow the wrap
    expect(twin.props.get("transition")).toBe("none"); // this frame's numbers only
  });

  it("takes the live box's own values for everything that moves a line break", () => {
    const twin = world().dress();
    expect(twin.props.get("box-sizing")).toBe("border-box");
    expect(twin.props.get("padding-left")).toBe(`${PAD_LEFT}px`);
    expect(twin.props.get("padding-right")).toBe(`${PAD_RIGHT}px`);
    expect(twin.props.get("line-height")).toBe(`${LINE_H}px`);
    expect(twin.props.get("width")).toBe("320px"); // the live box's border box
  });

  it("a twin never told its wrap width cannot answer at all", () => {
    // the guard that keeps the tests above honest: an undressed twin returns
    // NaN rather than some plausible wrong number, so a dressMirror that
    // stopped writing the width or the padding would fail loudly, not quietly
    const bare = new FakeTwin();
    bare.value = WRAPPED;
    expect(Number.isNaN(bare.scrollHeight)).toBe(true);
  });
});

describe("the compensation branches get an honest position again", () => {
  it("a growth reports the position from BEFORE the resize, not a clamped one", () => {
    const { shell, box, thread, dress } = world();
    box.value = SHORT;
    fitComposeBox(box, dress(), thread, CAP);
    thread.scrollTop = shell.maxScroll();
    const before = thread.scrollTop;

    box.value = WRAPPED; // the keystroke that grows the box two lines
    const fit = fitComposeBox(box, dress(), thread, CAP);

    expect(fit.newHeight).toBe(85);
    expect(fit.scrollBefore).toBe(before);
    expect(fit.scrollMid).toBe(before); // a growing box shrinks nothing: no clamp
    // giveUpTarget is handed this, and it is the honest number now: the shipped
    // path fed it a scrollTop the collapse had already pulled down, so that
    // branch landed low by exactly the clamp
    expect(thread.scrollTop).toBe(before);
  });

  it("a genuine shrink is put back as far as the taller thread allows", () => {
    // the send collapse, where the box really does get shorter: the thread
    // really does grow and the engine really does clamp, so stM below stB here
    // is the truth and not a defect. The restore takes the position as high as
    // the new range allows and the caller still hears the pre-resize number.
    const { shell, box, thread, dress } = world();
    box.value = WRAPPED;
    fitComposeBox(box, dress(), thread, CAP);
    thread.scrollTop = shell.maxScroll();
    const before = thread.scrollTop;

    box.value = ""; // send: the field is cleared and the bar collapses
    const fit = fitComposeBox(box, dress(), thread, CAP);

    expect(fit.newHeight).toBe(ONE_LINE);
    expect(fit.scrollBefore).toBe(before);
    expect(fit.scrollMid).toBe(shell.maxScroll()); // the new, lower floor
    expect(thread.scrollTop).toBe(shell.maxScroll());
    expect(fit.scrollMid).toBe(before - (85 - ONE_LINE));
  });
});
