// Pins for Messages' bubble tail (src/runs.ts, styles.css, the wiring in
// main.ts and arrival.ts).
//
// The rule and the shape were both read off the owner's own Messages thread
// (the screen recording of 2026-09-06, every frame at full 3x resolution; the
// numbers are in runs.ts). The pure fold is exercised directly, row by row;
// the shape is sampled off the path and checked against the measurements; the
// stylesheet and main.ts are source-pinned the way flight.test.ts and
// arrival.test.ts hold theirs, because main.ts boots a real shell at import
// and cannot load under node.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUBBLE_RADIUS,
  RUN_GAP_MS,
  TAIL_DROP,
  TAIL_EDGE_Y,
  TAIL_H,
  TAIL_PATH,
  TAIL_W,
  continues,
  installTailMasks,
  isBubble,
  markRuns,
  tailMask,
} from "../src/runs";
import type { RunRow } from "../src/runs";

const here = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(join(here, "../src/main.ts"), "utf8");
const sheet = readFileSync(join(here, "../src/styles.css"), "utf8");
const arrival = readFileSync(join(here, "../src/arrival.ts"), "utf8");

function fnBody(name: string): string {
  const start = main.indexOf(`function ${name}(`);
  expect(start, `main.ts has no ${name}`).toBeGreaterThan(-1);
  const end = main.indexOf("\n}", start);
  return main.slice(start, end);
}

/** one css rule's body, by its exact selector line */
function rule(selector: string): string {
  const at = sheet.indexOf(`${selector} {`);
  expect(at, `styles.css has no rule ${selector}`).toBeGreaterThan(-1);
  return sheet.slice(at, sheet.indexOf("}", at));
}

const row = (role: string, at: number, stamped = false): RunRow => ({ role, at, stamped });
const S = 1000;
const tails = (rows: RunRow[]): string => markRuns(rows).map((m) => (m.tail ? "T" : "-")).join("");
const conts = (rows: RunRow[]): string => markRuns(rows).map((m) => (m.cont ? "c" : "-")).join("");

describe("the rule: the tail sits on the last bubble of each run", () => {
  it("a lone bubble at the end of the thread carries it", () => {
    expect(tails([row("agent", 0)])).toBe("T");
    expect(tails([row("user", 0)])).toBe("T");
  });

  it("a run of three from one sender: the last carries it, the others continue without one", () => {
    const rows = [row("agent", 0), row("agent", 10 * S), row("agent", 20 * S)];
    expect(tails(rows)).toBe("--T");
    expect(conts(rows)).toBe("-cc");
  });

  it("the other side speaking ends the run: the bubble before the switch keeps its tail", () => {
    const rows = [row("agent", 0), row("agent", 5 * S), row("user", 6 * S), row("user", 7 * S)];
    expect(tails(rows)).toBe("-T-T");
    expect(conts(rows)).toBe("-c-c");
  });

  it("a pause of RUN_GAP_MS or more ends the run even from the same sender", () => {
    expect(RUN_GAP_MS).toBe(60_000);
    const rows = [row("user", 0), row("user", RUN_GAP_MS), row("user", RUN_GAP_MS + 30 * S)];
    expect(tails(rows)).toBe("T-T");
    expect(conts(rows)).toBe("--c");
    // one ms inside the gap still continues
    expect(tails([row("user", 0), row("user", RUN_GAP_MS - 1)])).toBe("-T");
  });

  it("a gap stamp ends the run even inside RUN_GAP_MS (the attachment above 'Wed, Aug 19' has a tail)", () => {
    // the stamp rule reads the time since the last STAMP, so a stamp can be
    // born between two bubbles that are seconds apart; the bubble above it
    // is the end of its run all the same
    const rows = [row("agent", 0), row("agent", 30 * S, true), row("agent", 40 * S)];
    expect(tails(rows)).toBe("T-T");
    expect(conts(rows)).toBe("--c");
  });

  it("a system line ends the run on both sides and never carries a tail itself", () => {
    const rows = [row("agent", 0), row("system", 1 * S), row("agent", 2 * S), row("agent", 3 * S)];
    expect(tails(rows)).toBe("T--T");
    expect(conts(rows)).toBe("---c");
    // a system line at the very end: the bubble above it is still a run's end
    expect(tails([row("user", 0), row("system", S)])).toBe("T-");
  });

  it("the end of the thread always carries one, whoever spoke last", () => {
    for (const last of ["agent", "user"]) {
      const rows = [row("agent", 0), row("user", S), row(last, 2 * S)];
      expect(markRuns(rows)[2].tail).toBe(true);
    }
  });

  it("exactly one tail per run, never two and never none, over any thread", () => {
    // a deterministic pseudo-random thread, walked run by run
    let seed = 7;
    const rnd = (): number => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const rows: RunRow[] = [];
    let at = 0;
    for (let i = 0; i < 400; i++) {
      at += rnd() < 0.8 ? Math.floor(rnd() * 50 * S) : RUN_GAP_MS + Math.floor(rnd() * 3600 * S);
      const r = rnd();
      rows.push(row(r < 0.45 ? "agent" : r < 0.9 ? "user" : "system", at, rnd() < 0.05));
    }
    const marks = markRuns(rows);
    let prev: RunRow | null = null;
    let runTails = 0;
    let runLen = 0;
    const close = (): void => {
      if (runLen > 0) expect(runTails).toBe(1);
      runTails = 0;
      runLen = 0;
    };
    rows.forEach((r, i) => {
      if (!isBubble(r.role)) {
        close();
        prev = null;
        expect(marks[i].tail).toBe(false);
        expect(marks[i].cont).toBe(false);
        return;
      }
      if (!continues(prev, r)) close();
      runLen += 1;
      if (marks[i].tail) runTails += 1;
      expect(marks[i].cont).toBe(continues(prev, r));
      prev = r;
    });
    close();
  });

  it("a new message joining the run takes the tail off the bubble above, in the same fold", () => {
    const before = [row("user", 0), row("user", 5 * S)];
    expect(tails(before)).toBe("-T");
    const after = [...before, row("user", 9 * S)];
    expect(tails(after)).toBe("--T");
    // and a message that does NOT join leaves the tail above in place, adding its own
    expect(tails([...before, row("agent", 9 * S)])).toBe("-TT");
    expect(tails([...before, row("user", 5 * S + RUN_GAP_MS)])).toBe("-TT");
  });

  it("pagination: an older page landing above changes nothing below except the seam it joins", () => {
    const page2 = [row("agent", 100 * S), row("agent", 105 * S), row("user", 110 * S)];
    const page1 = [row("user", 0), row("user", 3 * S), row("agent", 99 * S)];
    const alone = markRuns(page2);
    const joined = markRuns([...page1, ...page2]);
    // page 2's own rows read the same, except its first, which now continues
    // page 1's last agent bubble (seconds apart, same sender)
    expect(joined.slice(page1.length).map((m) => m.tail)).toEqual(alone.map((m) => m.tail));
    expect(joined[page1.length].cont).toBe(true);
    expect(joined[page1.length - 1].tail).toBe(false); // page 1's last lost its end-of-thread tail
  });

  it("depends on order and times only, never on the order things arrived (idempotent)", () => {
    const rows = [row("agent", 0), row("user", S), row("user", 2 * S), row("agent", 3 * S)];
    expect(markRuns(rows)).toEqual(markRuns(rows));
    expect(markRuns([...rows])).toEqual(markRuns(rows));
  });

  it("a photo is a bubble like any other: of two sent photos only the second carries it", () => {
    // (the recording: 'Wed, Aug 26 at 11:34 PM', two sent photos, the first
    // plainly rounded, the second with the tail)
    expect(tails([row("user", 0, true), row("user", 4 * S)])).toBe("-T");
  });

  it("a photo's caption, sent with it, continues the photo's run", () => {
    // one wrapper renders the photo row and the text row at the same time;
    // only the first row of a wrapper can be under a stamp
    expect(tails([row("user", 0, true), row("user", 0)])).toBe("-T");
    expect(conts([row("user", 0, true), row("user", 0)])).toBe("-c");
  });

  it("continues() is the one judge: sender, gap and stamp, nothing else", () => {
    const a = row("agent", 0);
    expect(continues(null, row("agent", S))).toBe(false);
    expect(continues(a, row("agent", S))).toBe(true);
    expect(continues(a, row("user", S))).toBe(false);
    expect(continues(a, row("agent", RUN_GAP_MS))).toBe(false);
    expect(continues(a, row("agent", S, true))).toBe(false);
    expect(continues(a, row("system", S))).toBe(false);
    expect(isBubble("system")).toBe(false);
    expect(isBubble("agent")).toBe(true);
    expect(isBubble("user")).toBe(true);
  });
});

// --- the shape, sampled off the path and held against the measurements -------

interface Pt {
  x: number;
  y: number;
}

/** sample TAIL_PATH into a closed polyline (M/L/H/V/C/Q/Z only, which is all it uses) */
function samplePath(d: string, steps = 64): Pt[] {
  const tokens = d.match(/[MLHVCQZ]|-?\d*\.?\d+/g) ?? [];
  const pts: Pt[] = [];
  let cur: Pt = { x: 0, y: 0 };
  let i = 0;
  const num = (): number => Number(tokens[i++]);
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === "M") {
      cur = { x: num(), y: num() };
      pts.push(cur);
    } else if (cmd === "L") {
      cur = { x: num(), y: num() };
      pts.push(cur);
    } else if (cmd === "H") {
      cur = { x: num(), y: cur.y };
      pts.push(cur);
    } else if (cmd === "V") {
      cur = { x: cur.x, y: num() };
      pts.push(cur);
    } else if (cmd === "C") {
      const p1 = { x: num(), y: num() };
      const p2 = { x: num(), y: num() };
      const p3 = { x: num(), y: num() };
      const p0 = cur;
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        const u = 1 - t;
        pts.push({
          x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
          y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
        });
      }
      cur = p3;
    } else if (cmd === "Q") {
      const p1 = { x: num(), y: num() };
      const p2 = { x: num(), y: num() };
      const p0 = cur;
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        const u = 1 - t;
        pts.push({
          x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
          y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
        });
      }
      cur = p2;
    } else if (cmd === "Z") {
      // closed
    } else {
      throw new Error(`unexpected path token ${cmd}`);
    }
  }
  return pts;
}

function inside(poly: Pt[], p: Pt): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

/** the bubble's own corner circle: centre 18 in from the side and 18 up from the bottom */
const CX = TAIL_W - BUBBLE_RADIUS;
const CY = TAIL_EDGE_Y - BUBBLE_RADIUS;
const radial = (p: Pt): number => Math.hypot(p.x - CX, p.y - CY);
/** inside the bubble: left of the corner circle under the flat bottom edge, or inside the circle */
const inBubble = (p: Pt, slack = 0): boolean =>
  (p.x <= CX + slack && p.y <= TAIL_EDGE_Y + slack) || radial(p) <= BUBBLE_RADIUS + slack;

describe("the measured shape", () => {
  const poly = samplePath(TAIL_PATH);

  it("the box hangs on the corner: 24 wide, 25 tall, its top where the corner circle begins, 7 under the bubble", () => {
    expect(TAIL_W).toBe(24);
    expect(TAIL_H).toBe(25);
    expect(TAIL_DROP).toBe(7);
    expect(TAIL_EDGE_Y).toBe(18);
    expect(TAIL_EDGE_Y).toBe(BUBBLE_RADIUS);
    expect(BUBBLE_RADIUS).toBe(18);
  });

  it("the tip is 6 to 6.7px under the bubble's bottom edge (measured 6.0 to 6.3 at the half-coverage contour)", () => {
    const lowest = poly.reduce((a, b) => (b.y > a.y ? b : a));
    const below = lowest.y - TAIL_EDGE_Y;
    expect(below).toBeGreaterThanOrEqual(6.0);
    expect(below).toBeLessThanOrEqual(6.7);
    // and it sits 7.5 to 9px INSIDE the bubble's side edge (measured 7.7 to 8.3)
    const inset = TAIL_W - lowest.x;
    expect(inset).toBeGreaterThanOrEqual(7.5);
    expect(inset).toBeLessThanOrEqual(9);
  });

  it("the tail never protrudes past the bubble's side edge, unlike the older outward curl", () => {
    const maxX = Math.max(...poly.map((p) => p.x));
    expect(TAIL_W - maxX).toBeGreaterThanOrEqual(6); // the closest it comes is the corner itself
    expect(maxX).toBeLessThan(TAIL_W);
  });

  it("the neck is near-vertical at inset 9 to 9.7 from the bottom edge to 1.5px under it (measured 9.3 to 9.4)", () => {
    const neck = poly.filter((p) => p.y >= TAIL_EDGE_Y - 0.5 && p.y <= TAIL_EDGE_Y + 1.5 && p.x > TAIL_W / 2);
    expect(neck.length).toBeGreaterThan(3);
    for (const p of neck) {
      expect(TAIL_W - p.x).toBeGreaterThanOrEqual(9);
      expect(TAIL_W - p.x).toBeLessThanOrEqual(9.7);
    }
  });

  it("the underside leaves the bottom edge at inset 22 with a horizontal tangent (measured 21 to 22)", () => {
    expect(TAIL_PATH.startsWith("M0 16V18H2C5 18")).toBe(true); // (2,18) with control (5,18): tangent along the edge
    expect(TAIL_W - 2).toBe(22);
  });

  it("the outer edge leaves the corner circle about 3.5px above the bottom and is never more than 2px outside it", () => {
    // between the departure and the neck the edge lies just outside the
    // bubble's own arc (the sliver the mask paints); above the departure it
    // is the circle itself, which the bubble already paints
    const outer = poly.filter((p) => p.x > 13 && p.y >= 13.5 && p.y <= TAIL_EDGE_Y - 0.5);
    expect(outer.length).toBeGreaterThan(5);
    for (const p of outer) {
      expect(radial(p)).toBeGreaterThanOrEqual(BUBBLE_RADIUS - 0.25);
      expect(radial(p)).toBeLessThanOrEqual(BUBBLE_RADIUS + 2);
    }
  });

  it("above the departure point the fill stays inside the bubble: nothing is painted outside its own corner", () => {
    for (const p of poly.filter((p) => p.y < 13.5)) expect(inBubble(p, 0.05)).toBe(true);
  });

  it("the fill overlaps the bubble's interior and closes, so the two paints share no seam", () => {
    expect(TAIL_PATH.endsWith("Z")).toBe(true);
    expect(inside(poly, { x: 6, y: 12 })).toBe(true); // well inside the bubble
    expect(inside(poly, { x: 3, y: 17 })).toBe(true);
    expect(inside(poly, { x: 13, y: 21 })).toBe(true); // in the hook, under the bubble's bottom edge
    expect(inside(poly, { x: 20, y: 15 })).toBe(false); // outside the corner, above the departure
    expect(inside(poly, { x: 23, y: 24 })).toBe(false); // beside the tip
    expect(inside(poly, { x: 8, y: 21 })).toBe(false); // under the flat bottom edge, left of the hook
  });

  it("one mask per side: the received tail is the sent path mirrored in the same 24x25 box", () => {
    const user = tailMask("user");
    const agent = tailMask("agent");
    for (const m of [user, agent]) {
      expect(m.startsWith('url("data:image/svg+xml,%3Csvg ')).toBe(true);
      expect(m).toContain("viewBox='0 0 24 25'");
      expect(m).toContain(`d='${TAIL_PATH}'`);
      expect(m.endsWith('%3C/svg%3E")')).toBe(true);
      expect(m.slice(5, -2)).not.toMatch(/[<>"]/); // nothing that would end the url() early
    }
    expect(user).not.toContain("transform");
    expect(agent).toContain("transform='matrix(-1 0 0 1 24 0)'");
  });

  it("installTailMasks writes both onto the root, where the stylesheet reads them", () => {
    const wrote: Record<string, string> = {};
    installTailMasks({ style: { setProperty: (n, v) => void (wrote[n] = v) } });
    expect(wrote["--tail-user"]).toBe(tailMask("user"));
    expect(wrote["--tail-agent"]).toBe(tailMask("agent"));
  });
});

// --- the stylesheet ----------------------------------------------------------

describe("the stylesheet: every bubble fully rounded, the tail a mask on the last of a run", () => {
  it("every bubble is an 18px round box on all four corners and is positioned for its tail", () => {
    const msg = rule(".msg");
    expect(msg).toContain("position: relative;");
    expect(msg).toContain("border-radius: 18px;");
    // the squared stand-in corners are gone: from the bubbles, from the
    // continuation rule, from the typing indicator
    expect(sheet).not.toMatch(/border-radius: 18px 18px 4px 18px/);
    expect(sheet).not.toMatch(/border-radius: 18px 18px 18px 4px/);
    expect(sheet).not.toMatch(/\.row\.cont \.msg/);
    expect(rule(".msg.user")).not.toContain("border-radius");
    expect(rule(".msg.agent")).not.toContain("border-radius");
    expect(rule(".typing")).toContain("border-radius: 18px;");
  });

  it("the run's spacing is untouched: 2px inside a run, 10px otherwise, on the row", () => {
    expect(sheet).toContain(".row.cont { margin-top: 2px; }");
    expect(rule(".row")).toContain("margin-top: 10px;");
  });

  it("the tail is the bubble's own pseudo-element, masked over its fill, hung 7px under it", () => {
    const tail = rule(".msg.tail:not(:has(img.waiting))::after");
    expect(tail).toContain('content: "";');
    expect(tail).toContain("position: absolute;");
    expect(tail).toContain("left: 0;");
    expect(tail).toContain("right: 0;");
    expect(tail).toContain(`bottom: -${TAIL_DROP}px;`);
    expect(tail).toContain(`height: ${TAIL_H}px;`);
    expect(tail).toContain("background: var(--fill);");
    expect(tail).toContain("pointer-events: none;");
    expect(tail).toContain(`-webkit-mask: var(--tail-mask) var(--tail-x) 0 / ${TAIL_W}px ${TAIL_H}px no-repeat;`);
    expect(tail).toContain(`mask: var(--tail-mask) var(--tail-x) 0 / ${TAIL_W}px ${TAIL_H}px no-repeat;`);
  });

  it("each side names its fill, its mask and its end; the fill is the same token the bubble is painted with", () => {
    const user = rule(".msg.user");
    expect(user).toContain("--fill: var(--accent);");
    expect(user).toContain("--tail-mask: var(--tail-user);");
    expect(user).toContain("--tail-x: right;");
    expect(user).toContain("background: var(--accent);");
    const agent = rule(".msg.agent");
    expect(agent).toContain("--fill: var(--received);");
    expect(agent).toContain("--tail-mask: var(--tail-agent);");
    expect(agent).toContain("--tail-x: left;");
    expect(agent).toContain("background: var(--received);");
    expect(rule(".msg.error")).toContain("--fill: var(--error-bg);");
  });

  it("the masks are not spelled in the sheet: no url() is served before the first paint", () => {
    expect(sheet).not.toContain("url(");
    expect(sheet).toContain("var(--tail-user)");
    expect(sheet).toContain("var(--tail-agent)");
  });

  it("photos: the same 18px corner as text, and a tail cut from the photo itself", () => {
    expect(rule(".msg.shot img")).toContain("border-radius: 18px;");
    expect(rule(".msg.shot:has(img.waiting)::before")).toContain("border-radius: 18px;");
    const photo = rule(".msg.shot.tail:not(:has(img.waiting))::after");
    expect(photo).toContain("background: var(--shot, var(--received)) 50% 100% / 100% 20000% no-repeat;");
    // the waiting ring keeps this pseudo-element while the pixels are missing
    expect(sheet).toContain(".msg.shot:has(img.waiting)::after {");
  });

  it("the typing indicator is a thought bubble: a pill with two circles under its corner, no message tail", () => {
    const trail = rule(".typing::before, .msg.arriving::before");
    expect(trail).toContain('content: "";');
    expect(trail).toContain("position: absolute;");
    expect(trail).toContain("left: -3px;");
    expect(trail).toContain("bottom: -12px;");
    expect(trail).toContain("width: 24px;");
    expect(trail).toContain("height: 24px;");
    expect((trail.match(/radial-gradient\(circle at/g) ?? []).length).toBe(2);
    expect(trail).toContain("var(--received) 4.5px");
    expect(trail).toContain("var(--received) 2.5px");
  });

  it("through the morph the trail fades with the dots and the tail comes in with the text", () => {
    expect(sheet).toContain(".msg.arriving::before { opacity: var(--dots-alpha, 1); }");
    expect(sheet).toContain(".msg.arriving.tail::after { opacity: var(--ink-alpha, 1); }");
    expect(sheet).not.toMatch(/\.msg\.arriving \{[^}]*overflow/); // nothing clips the tail off
  });

  it("the send flight's shell carries the same hook as a second fixed box, in the shell's own faces", () => {
    const tail = rule(".morphtail");
    expect(tail).toContain("position: fixed;");
    expect(tail).toContain("z-index: 7;");
    expect(tail).toContain(`width: ${TAIL_W}px;`);
    expect(tail).toContain(`height: ${TAIL_H}px;`);
    expect(tail).toContain(`-webkit-mask: var(--tail-user) 0 0 / ${TAIL_W}px ${TAIL_H}px no-repeat;`);
    expect(tail).toContain(`mask: var(--tail-user) 0 0 / ${TAIL_W}px ${TAIL_H}px no-repeat;`);
    expect(sheet).toContain(".morphtail > div { position: absolute; inset: 0; }");
    expect(sheet).toContain(".morphtail > .morph-face-bar { box-shadow: none; }");
    // the hook fades as one piece: an opaque accent face inside, the box's own opacity outside
    expect(sheet).toContain(".morphtail > .morph-face-accent { opacity: 1; }");
    expect(fnBody("armFieldMorph")).not.toContain("tail.lastElementChild");
  });
});

// --- the wiring ----------------------------------------------------------------

describe("the wiring in main.ts", () => {
  const dec = fnBody("decorate");

  it("decorate() reads the rows in order, folds them through runs.ts, and writes cont and tail back", () => {
    expect(main).toContain('import { TAIL_EDGE_Y, TAIL_W, installTailMasks, markRuns } from "./runs";');
    expect(main).not.toMatch(/^const RUN_GAP_MS/m); // one home for the gap: runs.ts
    expect(dec).toContain("const stamped = at - lastStampAt > STAMP_GAP_MS;");
    expect(dec).toContain("stamped: stamped && i === 0"); // only a wrapper's first row is under its stamp
    expect(dec).toContain("const marks = markRuns(seats.map((s) => s.read));");
    expect(dec).toContain('row.classList.toggle("cont", marks[i].cont);');
    expect(dec).toContain('bubble.classList.toggle("tail", marks[i].tail);');
    // the tail goes on the bubble element itself, the row's first child
    expect(dec).toContain("const bubble = row.firstElementChild;");
    expect(dec).toContain('bubble.classList.contains("msg")');
    // no mutable tracking survived the change
    expect(dec).not.toContain("prevSide");
    expect(dec).not.toContain("prevAt");
  });

  it("the masks go onto the document at boot", () => {
    expect(main).toContain("installTailMasks(document.documentElement);");
    expect(main.indexOf("installTailMasks(document.documentElement);")).toBeLessThan(main.indexOf("function renderChat("));
  });

  it("a photo's tail takes the photo's url, from the fold and from the thread's one load listener", () => {
    const fill = fnBody("shotFill");
    expect(fill).toContain("img.currentSrc || img.src");
    expect(fill).toContain('bubble.style.setProperty("--shot", want)');
    expect(fill).toContain('bubble.style.removeProperty("--shot")');
    expect(dec).toContain('if (marks[i].tail && bubble.classList.contains("shot")) shotFill(bubble);');
    const watch = fnBody("watchPhotos");
    expect(watch).toMatch(/thread\.addEventListener\(\s*"load",[\s\S]*?true,\s*\)/);
    expect(watch).toContain('closest<HTMLElement>(".msg.shot.tail")');
  });

  it("the send flight's shell gets the hook when its bubble has one, placed each frame from the box just written", () => {
    const morph = fnBody("armFieldMorph");
    expect(morph).toContain("let tail: HTMLDivElement | null = null;");
    expect(morph).toContain('tail = msg.classList.contains("tail") ? tailShell() : null;');
    expect(morph).toContain("if (tail) shell.before(tail);"); // under the shell in paint order
    expect(morph).toContain("tail.style.left = `${box.left + box.width - TAIL_W}px`;");
    expect(morph).toContain("tail.style.top = `${box.top + box.height - TAIL_EDGE_Y}px`;");
    expect(morph).toContain("tail.style.opacity = String(alpha);");
    // placed at the bar's box, invisible, BEFORE it enters the document, and
    // then from every frame's box: no frame can catch it unplaced
    expect(morph.indexOf("placeTail(bar, 0);")).toBeLessThan(morph.indexOf("if (tail) shell.before(tail);"));
    expect(morph).toContain("placeTail(box, accentAlpha(f));");
    expect(rule(".morphtail")).toContain("opacity: 0;");
    // gone with the shell on every exit, cancel included
    const settle = morph.slice(morph.indexOf("const settle = "), morph.indexOf("return {"));
    expect(settle).toContain("tail?.remove();");
    expect(settle).toContain("tail = null;");
    const shell = fnBody("tailShell");
    expect(shell).toContain('el.className = "morphtail";');
    expect(shell).toContain('["morph-face-under", "morph-face-bar", "morph-face-accent"]');
  });

  it("the FLIP flight and the pop-in need nothing: they animate the bubble element the tail is part of", () => {
    expect(fnBody("flyFromField")).toContain("msg.animate(");
    expect(sheet).toContain(".msg.anim { animation: pop-in 0.2s ease-out; }");
    expect(sheet).toContain(".msg.user.anim { transform-origin: bottom right; }");
    expect(sheet).toContain(".msg.agent.anim { transform-origin: bottom left; }");
  });

  it("every path that seats, re-seats or removes a row ends in decorate(), so the tail moves with it", () => {
    for (const name of ["localBubble", "applyEvent", "applyRetract", "deleteFailed"]) {
      expect(fnBody(name), name).toContain("decorate();");
    }
    const send = fnBody("send");
    expect(send.indexOf("sinkFailed();")).toBeLessThan(send.indexOf("decorate();")); // the failed rows drop, then the fold
    expect(send).toContain("seatRow(w); // the failed bubble drops below the replies that just rendered");
    expect(send.indexOf("seatRow(w);")).toBeLessThan(send.lastIndexOf("decorate();"));
  });
});

describe("the wiring in arrival.ts", () => {
  it("the morph writes both tail alphas each frame and clears them at the landing", () => {
    expect(arrival).toContain('bubble.style.setProperty("--dots-alpha", String(dotsAlpha(f)));');
    expect(arrival).toContain('bubble.style.setProperty("--ink-alpha", String(inkAlpha(f)));');
    expect(arrival).toContain('bubble.style.removeProperty("--dots-alpha");');
    expect(arrival).toContain('bubble.style.removeProperty("--ink-alpha");');
  });
});
