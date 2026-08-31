// Pins for the scroll-write watch (src/scrollghost.ts, and its wiring in
// main.ts).
//
// The correction beside it takes back a position the thread cannot legitimately
// hold after a keyboard close, and the case for blaming the engine rests on an
// absence: on the frame the scroller jumped 386px past its own end, none of the
// app's scroll writers had recorded anything. An absence is only as good as the
// list it is drawn from, so this channel states the same thing as a measurement
// — the app says what it asked for, the position is looked at, and a move no
// intention of ours accounts for is written down.
//
// What matters about it is therefore exactly two things, and both are pinned
// below. It must not explain away the fault (the trail's restore landed sixteen
// milliseconds after a settle of ours, so a rule where a fresh write vouches for
// whatever happens next would have called the bug explained), and it must not
// cry ghost over the app's own animated rides or over a scroll gesture, because
// a channel that fires on ordinary use says nothing about an unusual event.
//
// The machine is a factory with an injected clock, the shape the picker
// lifecycle and the jank machine use, so the whole lifecycle runs on synthetic
// timestamps; the wiring (which sites announce their writes, and where the two
// looks sit) is pinned by source read, since main.ts boots a real shell at
// import time and cannot load under node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  GHOST_RIDE_MS,
  GHOST_RUN_GAP_MS,
  GHOST_TOL_PX,
  createScrollWatch,
  ghostMark,
  ghostVerdict,
} from "../src/scrollghost";
import type { GhostContext, GhostLook } from "../src/scrollghost";

const src = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

function fnBody(name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf("\n}", start));
}

// his trail: 6775 of content, a box that grew 238 -> 624, the close landing
// correctly on 6151 and the offset that came back one frame later
const REST_SH = 6775;
const REST_CH = 624;
const BACK_END = REST_SH - REST_CH; // 6151
const STALE_END = REST_SH - 238; // 6537
const AT_END = { sh: REST_SH, st: BACK_END, ch: REST_CH };
const PAST_END = { sh: REST_SH, st: STALE_END, ch: REST_CH };

function look(over: Partial<GhostLook> = {}): GhostLook {
  return {
    from: BACK_END,
    to: STALE_END,
    want: BACK_END,
    writeMs: 16, // the settle that landed a frame before the restore
    runMs: Infinity,
    touching: false,
    ...over,
  };
}

function ctx(over: Partial<GhostContext> = {}): GhostContext {
  return { pre: STALE_END, kms: 224, gest: false, touching: false, ...over };
}

describe("what a write accounts for, and what it does not", () => {
  it("his frame: a settle 16ms old asked for 6151 and does not explain 6537", () => {
    // the whole channel turns on this. A rule where a recent write vouches for
    // whatever the scroll does next would have explained the bug away.
    expect(ghostVerdict(look())).toBe("ghost");
  });

  it("the position a write asked for is explained by it, however it arrived", () => {
    expect(ghostVerdict(look({ from: STALE_END, to: BACK_END, want: BACK_END }))).toBe("explained");
  });

  it("a gliding pin is explained on every frame of its landing, not just at its end", () => {
    // the smooth pin a live message asks for arrives over a beat: each frame is
    // closer to the target than the last, and none of them has reached it
    const ride = [1000, 1400, 1700, 1850, 1900];
    for (let i = 1; i < ride.length; i += 1) {
      expect(
        ghostVerdict(look({ from: ride[i - 1], to: ride[i], want: 1900, writeMs: 200 })),
      ).toBe("explained");
    }
  });

  it("a write the engine clamped still explains where it landed", () => {
    // scrollToBottom asks for scrollHeight and the engine gives it the end of
    // the range, which is as close to the target as it can get
    expect(ghostVerdict(look({ from: 3000, to: BACK_END, want: REST_SH }))).toBe("explained");
  });

  it("a move AWAY from what was asked for is never explained by asking", () => {
    expect(ghostVerdict(look({ from: BACK_END, to: 5000, want: BACK_END, writeMs: 8 }))).toBe(
      "ghost",
    );
  });

  it("a write too old to still be landing explains nothing at all", () => {
    expect(ghostVerdict(look({ from: 3000, to: 4000, want: 6000, writeMs: 200 }))).toBe(
      "explained",
    );
    expect(
      ghostVerdict(look({ from: 3000, to: 4000, want: 6000, writeMs: GHOST_RIDE_MS })),
    ).toBe("ghost");
  });

  it("a scroller that has not moved is not an event", () => {
    expect(ghostVerdict(look({ from: BACK_END, to: BACK_END }))).toBe("still");
    expect(ghostVerdict(look({ from: BACK_END, to: BACK_END + GHOST_TOL_PX }))).toBe("still");
    expect(ghostVerdict(look({ from: BACK_END, to: BACK_END + GHOST_TOL_PX + 1 }))).not.toBe(
      "still",
    );
  });

  it("with nothing ever written, a move is unexplained rather than crediting a -1", () => {
    expect(ghostVerdict(look({ want: -1, writeMs: Infinity }))).toBe("ghost");
  });
});

describe("a gesture is one run, and no ghosts", () => {
  it("a move that begins under a finger is the finger's, not a ghost", () => {
    expect(ghostVerdict(look({ touching: true }))).toBe("gesture");
  });

  it("and it stays the finger's after the finger lifts: momentum joins its run", () => {
    // the rubber band at the end of a fling reads past the end exactly like the
    // fault does, which is why the run and not the touch decides
    expect(ghostVerdict(look({ touching: false, runMs: 16 }))).toBe("run");
    expect(ghostVerdict(look({ touching: false, runMs: GHOST_RUN_GAP_MS }))).toBe("run");
  });

  it("a quiet gap ends the run, so the next unexplained move is its own event", () => {
    expect(ghostVerdict(look({ runMs: GHOST_RUN_GAP_MS + 1 }))).toBe("ghost");
  });
});

describe("what the record carries", () => {
  const mark = ghostMark("frame", PAST_END, look(), "kb-close", ctx());

  it("the moment, the old value, the new one and how far past the end it is", () => {
    expect(mark.at).toBe("frame");
    expect(mark.from).toBe(BACK_END);
    expect(mark.to).toBe(STALE_END);
    expect(mark.over).toBe(386);
    expect(mark.kms).toBe(224);
  });

  it("says whether the app was mid-gesture, without that deciding anything", () => {
    expect(mark.gest).toBe(false);
    expect(ghostMark("scroll", PAST_END, look(), "kb-close", ctx({ gest: true })).gest).toBe(true);
  });

  it("names the app's last intention and its age, which is the whole accusation", () => {
    expect(mark.via).toBe("kb-close");
    expect(mark.want).toBe(BACK_END);
    expect(mark.wms).toBe(16);
  });

  it("stale is the pre-dismissal bottom handed back, stated rather than derived", () => {
    expect(mark.stale).toBe(true);
    expect(mark.pre).toBe(STALE_END);
    // a jump that landed anywhere else is a different animal and says so
    const elsewhere = ghostMark("scroll", PAST_END, look({ to: 4000 }), "glide", ctx());
    expect(elsewhere.stale).toBe(false);
  });

  it("no keyboard close anywhere near it reads -1, never a coordinate or a zero", () => {
    const idle = ghostMark("scroll", AT_END, look({ to: 3000 }), "", ctx({ pre: -1, kms: -1 }));
    expect(idle.pre).toBe(-1);
    expect(idle.kms).toBe(-1);
    expect(idle.stale).toBe(false);
    expect(idle.over).toBe(0); // unexplained, but inside the range: not this bug
    expect(idle.via).toBe("");
  });

  it("a write that never happened leaves wms as -1 rather than an infinity", () => {
    expect(ghostMark("scroll", PAST_END, look({ writeMs: Infinity }), "", ctx()).wms).toBe(-1);
  });
});

describe("the watch itself, on a clock it is handed", () => {
  // the close as it really ran: the settle lands the scroll on the fresh end,
  // the box holds still, and a frame later the offset comes back
  function close(): { mark: ReturnType<typeof ghostMark> | null; second: unknown } {
    let t = 0;
    const watch = createScrollWatch(() => t);
    t = 100;
    watch.look("frame", { ...AT_END, st: STALE_END }, ctx()); // the first look: a baseline
    t = 192;
    watch.wrote("box", BACK_END); // the observer's settle, on the glide's last frame
    watch.look("frame", AT_END, ctx());
    t = 208;
    const mark = watch.look("frame", AT_END, ctx()); // nothing moved
    t = 224;
    const second = watch.look("frame", PAST_END, ctx({ kms: 224 }));
    return { mark, second: second as unknown };
  }

  it("the app's own settle passes in silence, and the restore does not", () => {
    const { mark, second } = close();
    expect(mark).toBeNull();
    expect(second).not.toBeNull();
    expect((second as { to: number }).to).toBe(STALE_END);
    expect((second as { over: number }).over).toBe(386);
    expect((second as { stale: boolean }).stale).toBe(true);
  });

  it("the very first look has nothing to compare against and reports nothing", () => {
    let t = 0;
    const watch = createScrollWatch(() => t);
    expect(watch.look("scroll", PAST_END, ctx())).toBeNull();
    t = 5000;
    expect(watch.look("scroll", PAST_END, ctx())).toBeNull(); // still not moved
  });

  it("one record per run: a gesture's whole sweep is not thirty of them", () => {
    let t = 0;
    const watch = createScrollWatch(() => t);
    watch.look("scroll", { sh: 6000, st: 3000, ch: 600 }, ctx({ touching: true }));
    let marks = 0;
    for (let i = 1; i <= 30; i += 1) {
      t += 16;
      const finger = i < 10; // lifted a third of the way in; momentum carries on
      const m = watch.look(
        "scroll",
        { sh: 6000, st: 3000 + i * 40, ch: 600 },
        ctx({ touching: finger, gest: true }),
      );
      if (m) marks += 1;
    }
    expect(marks).toBe(0);
  });

  it("a correction of ours is explained by the settle it goes through", () => {
    let t = 0;
    const watch = createScrollWatch(() => t);
    watch.look("frame", AT_END, ctx());
    t = 16;
    expect(watch.look("frame", PAST_END, ctx())).not.toBeNull(); // the fault, once
    t = 20;
    watch.wrote("kb-restore", BACK_END); // the correction's own settle
    t = 32;
    expect(watch.look("frame", AT_END, ctx())).toBeNull();
  });
});

describe("the wiring: every writer announces itself, and the looks read nothing", () => {
  it("every site in main.ts that writes the thread's scroll says what it asked for", () => {
    for (const call of [
      'scrollGhostWrite(via, plan.top)', // the settle
      'scrollGhostWrite("bottom", top)', // the bottom pin, target not read-back
      'scrollGhostWrite("glide", pos)', // the jump chevron's ride
      'scrollGhostWrite("keep-view", t.scrollTop)',
      'scrollGhostWrite("give-up", t.scrollTop)',
      'scrollGhostWrite("drain", t.scrollTop)',
      'scrollGhostWrite("replay", t.scrollTop)',
      'scrollGhostWrite("boot-repin", t.scrollTop)',
      'scrollGhostWrite("cache-pin", el.scrollTop)',
    ]) {
      expect(src, `${call} is missing`).toContain(call);
    }
  });

  it("the list is complete: no scroll write in main.ts goes unannounced", () => {
    // a writer that never announces itself is a ghost of our own making, which
    // is the failure mode this channel exists to rule out. The two writes
    // outside this file (mirror.ts's fit, shell.ts's heal) are silent on
    // purpose: each saves a value and puts the same one back inside one
    // synchronous task, so no look can land in between (the banner explains).
    const writes = (src.match(/^.*(?:\.scrollTop\s*(?:\+?=)|\.scrollTo\()[^=].*$/gm) ?? []).filter(
      // the window's own scroll is the shell's displacement clear, not the
      // thread's position: shell.ts owns it and it can never land on this
      // scroller (styles.css leaves the document nothing to scroll)
      (line) => !line.includes("window.scrollTo"),
    );
    for (const line of writes) {
      const at = src.indexOf(line);
      const after = src.slice(at, at + line.length + 400);
      expect(after, `unannounced scroll write: ${line.trim()}`).toContain("scrollGhostWrite(");
    }
  });

  it("the animated pin announces its TARGET, since it arrives over a beat", () => {
    const pin = fnBody("scrollToBottom");
    expect(pin).toContain("const top = t.scrollHeight");
    expect(pin).toContain("scrollGhostWrite(\"bottom\", top)");
  });

  it("the scroller's own scroll events look, and still carry no clamp", () => {
    const handler = src.indexOf('thread.addEventListener("scroll"');
    const body = src.slice(handler, src.indexOf("if (hasScrollend)", handler));
    expect(body).toContain("scrollGhostLook(\"scroll\", {");
    expect(body).toContain("sh: thread.scrollHeight, st: thread.scrollTop, ch: thread.clientHeight");
    expect(body).not.toContain("settleTail(");
    expect(body).not.toMatch(/scrollTop\s*=/);
  });

  it("the post-close look is handed the numbers the correction already read", () => {
    const fix = fnBody("fixCloseTail");
    expect(fix).toContain("scrollGhostLook(via, g, ghostCtx())");
    // one read of the three numbers serves both, so the look costs nothing
    expect(fix.match(/scrollHeight/g)).toHaveLength(1);
  });

  it("the context is gathered in one place, from state the app already keeps", () => {
    const c = fnBody("ghostCtx");
    expect(c).toContain("pre: closeBottom");
    expect(c).toContain("gest: userScrollIntent()");
    expect(c).toContain("touching: threadTouching");
    expect(c).not.toMatch(/scrollTop|scrollHeight|clientHeight|getBoundingClientRect/);
  });

  it("nothing in the watch reads geometry or holds a clock of its own", () => {
    const ghost = readFileSync(new URL("../src/scrollghost.ts", import.meta.url), "utf8");
    expect(ghost).not.toMatch(/getElementById|querySelector|getBoundingClientRect/);
    expect(ghost).not.toMatch(/setTimeout|setInterval|requestAnimationFrame/);
    expect(ghost).not.toMatch(/\.scrollTop|\.scrollHeight|\.clientHeight/);
  });

  it("the record reaches the phone's trail instead of waiting on an unrelated mark", () => {
    const hold = readFileSync(new URL("../src/hold.ts", import.meta.url), "utf8");
    expect(hold).toContain('ev === "scroll-ghost"');
    const app = readFileSync(new URL("../../src/paratrooper/web/app.py", import.meta.url), "utf8");
    expect(app).toContain('"scroll-ghost"');
  });
});
