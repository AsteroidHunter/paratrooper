// The swipe-left peek (peek.ts, main.ts touch handlers, styles.css): only the
// pieces on screen move, only they carry a transform, and only while the pull
// is in play. The motion rig measured the whole-thread version at 55 ms frames
// for a peek a few hundred rows deep, and the standing transform on every row
// at 25 ms of re-layering on every repainting frame.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PEEK_HOME_MS, PEEK_PIECES, piecesInView, releasePeek } from "../src/peek";

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const sheet = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

/** a piece standing from `top` to `top + h`, counting how often it is measured */
function piece(name: string, top: number, h = 40) {
  return {
    name,
    reads: 0,
    getBoundingClientRect() {
      this.reads++;
      return { top, bottom: top + h };
    },
  };
}

describe("piecesInView: what the pull moves", () => {
  // a thread 60 rows tall scrolled to its bottom: the screen is 100 to 700
  const rows = Array.from({ length: 60 }, (_, i) => piece(`r${i}`, 700 - (60 - i) * 45 + 45));

  it("the pieces on screen and within the margin, in document order", () => {
    const got = piecesInView(rows, 100, 700, 50).map((p) => p.name);
    const want = rows
      .filter((p) => {
        const r = { top: 700 - (60 - rows.indexOf(p)) * 45 + 45 };
        return r.top + 40 >= 50 && r.top <= 750;
      })
      .map((p) => p.name);
    expect(got).toEqual(want);
    expect(got.length).toBeGreaterThan(10);
    expect(got.length).toBeLessThan(rows.length);
  });

  it("walks up from the newest and stops at the first piece above the band", () => {
    for (const p of rows) p.reads = 0;
    const got = piecesInView(rows, 100, 700, 50);
    const read = rows.filter((p) => p.reads > 0).length;
    expect(read).toBe(got.length + 1); // everything it kept, and the one that ended the walk
  });

  it("an empty thread moves nothing", () => {
    expect(piecesInView([], 0, 800, 400)).toEqual([]);
  });

  it("the list is the one the rail has always been drawn against", () => {
    expect(PEEK_PIECES).toBe(".row, .stamp, .receipt, .typing, .empty, .sendfail");
  });
});

/** a picked-up piece: its class list, inline style and style attribute */
function held(pull: string, otherStyle = "") {
  const classes = new Set(["row", "peeked"]);
  const style = new Map<string, string>([["--peek", pull]]);
  let attr: string | null = otherStyle || "--peek: " + pull;
  return {
    classes,
    style: {
      getPropertyValue: (n: string) => style.get(n) ?? "",
      removeProperty: (n: string) => {
        style.delete(n);
        attr = otherStyle || (style.size ? attr : "");
        return "";
      },
    },
    classList: { remove: (n: string) => void classes.delete(n) },
    getAttribute: () => attr,
    removeAttribute: () => void (attr = null),
    attr: () => attr,
  };
}

describe("releasePeek: the transform goes once the pieces are home", () => {
  it("waits out the spring back, then takes the class, the pull and an empty style off", () => {
    const home = held("0px");
    const timers: [() => void, number][] = [];
    releasePeek([home], (fn, ms) => timers.push([fn, ms]));
    expect(timers).toHaveLength(1);
    expect(timers[0][1]).toBeGreaterThanOrEqual(PEEK_HOME_MS);
    expect(home.classes.has("peeked")).toBe(true); // nothing before the spring back ends
    timers[0][0]();
    expect(home.classes.has("peeked")).toBe(false);
    expect(home.style.getPropertyValue("--peek")).toBe("");
    expect(home.attr()).toBeNull();
  });

  it("leaves a piece a newer drag has picked up again", () => {
    const regrabbed = held("-18.4px");
    let run: () => void = () => {};
    releasePeek([regrabbed], (fn) => (run = fn));
    run();
    expect(regrabbed.classes.has("peeked")).toBe(true);
    expect(regrabbed.style.getPropertyValue("--peek")).toBe("-18.4px");
  });

  it("keeps a style attribute that still says something else", () => {
    const styled = held("0px", "max-width: 212px");
    let run: () => void = () => {};
    releasePeek([styled], (fn) => (run = fn));
    run();
    expect(styled.attr()).toBe("max-width: 212px");
  });

  it("a release with nothing picked up arms nothing", () => {
    let armed = 0;
    releasePeek([], () => armed++);
    expect(armed).toBe(0);
  });
});

describe("the stylesheet: no standing transform on the thread's rows", () => {
  it("--peek is registered and does not inherit", () => {
    expect(sheet).toMatch(/@property --peek \{\s*syntax: "<length>";\s*inherits: false;\s*initial-value: 0px;\s*\}/);
  });

  it("only picked-up pieces carry the pull, and they spring back on the peek's clock", () => {
    const at = sheet.indexOf(".thread .peeked {");
    expect(at).toBeGreaterThan(-1);
    const rule = sheet.slice(at, sheet.indexOf("}", at));
    expect(rule).toContain("transform: translateX(var(--peek, 0px));");
    expect(rule).toContain(`transition: transform ${PEEK_HOME_MS / 1000}s ease;`);
    expect(sheet).toContain(".thread.dragging .peeked { transition: none; }");
  });

  it("the old rule that gave every row a transform is gone", () => {
    expect(sheet).not.toContain(".thread :where(.row, .stamp, .receipt, .typing, .empty, .sendfail) {");
    expect(sheet.match(/translateX\(var\(--peek/g)).toHaveLength(1);
  });
});

describe("the wiring in main.ts", () => {
  const touch = main.slice(main.indexOf('"touchmove",'), main.indexOf("const endPeek = () => {"));
  const end = main.slice(main.indexOf("const endPeek = () => {"), main.indexOf('thread.addEventListener("touchend", endPeek);'));

  it("the pieces are picked up once, when the drag is decided a peek", () => {
    const decided = touch.indexOf("if (peeking) {");
    expect(decided).toBeGreaterThan(-1);
    const pick = touch.slice(decided, touch.indexOf("if (!peeking) {"));
    expect(pick).toContain("piecesInView(");
    expect(pick).toContain("thread.querySelectorAll<HTMLElement>(PEEK_PIECES)");
    expect(pick).toContain('piece.classList.add("peeked")');
  });

  it("every move writes the pull on the pieces, never on every row", () => {
    expect(touch).toContain('for (const piece of peekPieces) piece.style.setProperty("--peek", shift);');
  });

  it("the release sends them home and puts the transform down after", () => {
    expect(end).toContain('for (const piece of peekPieces) piece.style.setProperty("--peek", "0px");');
    expect(end.indexOf('piece.style.setProperty("--peek", "0px")')).toBeLessThan(end.indexOf("releasePeek(peekPieces);"));
    expect(end).toContain("peekPieces = [];");
  });
});
