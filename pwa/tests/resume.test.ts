// Pins for the app coming back on screen (src/resume.ts, wired in main.ts).
//
// The device report: tap a push banner for a new reply and the app comes back
// WITHOUT the reply on screen, then the reply appears somewhere below the fold
// with no entrance at all. Four separate things have to be true for that, and
// each of them is a decision here.
//
//   the socket iOS took away while the page was frozen, which only ever healed
//   through ws.onclose -> setTimeout(connect, 2000) — a retry that needs a close
//   event, and a half-open socket produces none
//   the keep-alive, which is the only thing that can make a half-open socket
//   admit it, because nothing else the client does ever writes to that socket
//   the landing: a reply arriving mid-resume asked for a SMOOTH pin, whose own
//   mid-flight scroll events read "away from the bottom" and flipped following
//   off, after which every re-pin in the app is gated shut and the resume's
//   geometry settles CLAMP where they should pin
//   the entrance: replay frames render flat by construction, so the reply that
//   arrived while the app was away materialised instead of landing
//
// The decisions are pure and run directly. main.ts boots a real shell at import
// time and cannot load under node, so the wiring is pinned by reading its
// source — the same split tailsettle.test.ts and flight.test.ts use.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  KEEPALIVE_MS,
  KEEPALIVE_STALL_BYTES,
  PIN_QUIET_MS,
  RESUME_WINDOW_MS,
  SOCKET_CLOSED,
  SOCKET_CLOSING,
  SOCKET_CONNECTING,
  SOCKET_OPEN,
  keepAliveAction,
  keepAliveSchedule,
  pinFlipGuard,
  reconnectOnVisible,
  replayAnimates,
  resumePinDecision,
} from "../src/resume";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/main.ts"),
  "utf8",
);

// read inside each test, never at describe level: a pin for a function that
// does not exist yet must fail as its own test, not take the file down with it
function fnBody(name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `missing function ${name}`).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf("\n}", start));
}

// --- the socket ----------------------------------------------------------------

describe("reconnectOnVisible", () => {
  it("a closed socket reconnects NOW rather than on the blind two-second retry", () => {
    // the whole point: that retry only runs if a close event was delivered, and
    // the catch-up it would eventually fetch carries the tapped-for reply
    expect(reconnectOnVisible(SOCKET_CLOSED)).toBe("reconnect");
  });

  it("a closing socket is already gone as far as the catch-up is concerned", () => {
    expect(reconnectOnVisible(SOCKET_CLOSING)).toBe("reconnect");
  });

  it("an open socket is left alone: the ?since= replay would be a duplicate", () => {
    expect(reconnectOnVisible(SOCKET_OPEN)).toBe("keep");
  });

  it("a handshake in flight is not a blind wait, and is not abandoned", () => {
    // abandoning it starts a second socket whose predecessor's close then arms
    // a third — one dead socket becoming three is not a fix
    expect(reconnectOnVisible(SOCKET_CONNECTING)).toBe("keep");
  });

  it("no socket at all is the boot, which the cached open owns", () => {
    expect(reconnectOnVisible(null)).toBe("keep");
  });
});

// --- the keep-alive ------------------------------------------------------------

describe("keepAliveAction", () => {
  it("an open socket on a visible page gets the ping", () => {
    expect(keepAliveAction(true, SOCKET_OPEN, 0)).toBe("send");
  });

  it("a hidden page pings nothing: nobody is watching and iOS has frozen it", () => {
    expect(keepAliveAction(false, SOCKET_OPEN, 0)).toBe("idle");
  });

  it("a socket that is not open is the resume path's problem, not the ping's", () => {
    for (const state of [SOCKET_CONNECTING, SOCKET_CLOSING, SOCKET_CLOSED, null]) {
      expect(keepAliveAction(true, state, 0)).toBe("idle");
    }
  });

  it("a ping still queued when the next comes due means half-open: drop it", () => {
    // this is the case readyState cannot see. One byte in twenty-five seconds
    // is not congestion, it is a connection the OS has already lost.
    expect(keepAliveAction(true, SOCKET_OPEN, KEEPALIVE_STALL_BYTES + 1)).toBe("drop");
    expect(keepAliveAction(true, SOCKET_OPEN, KEEPALIVE_STALL_BYTES)).toBe("send");
  });

  it("the interval is slow enough to cost nothing and fast enough to find it", () => {
    expect(KEEPALIVE_MS).toBeGreaterThanOrEqual(15000);
    expect(KEEPALIVE_MS).toBeLessThanOrEqual(45000);
  });
});

describe("keepAliveSchedule", () => {
  it("starts when the page is on screen and nothing is running", () => {
    expect(keepAliveSchedule(true, false)).toBe("start");
  });

  it("stops when the page goes off screen", () => {
    expect(keepAliveSchedule(false, true)).toBe("stop");
  });

  it("never starts twice, and never stops what is already stopped", () => {
    expect(keepAliveSchedule(true, true)).toBe("keep");
    expect(keepAliveSchedule(false, false)).toBe("keep");
  });
});

// --- the landing ---------------------------------------------------------------

describe("resumePinDecision", () => {
  it("at the tail when he left: he comes back to the tail, new message or not", () => {
    expect(resumePinDecision(true, false, false)).toBe("following");
    expect(resumePinDecision(true, true, false)).toBe("following");
  });

  it("the banner tap: following was lost by the app, a reply lands, take the bottom", () => {
    // THE bug. followTail latched false with nobody touching anything — a
    // scroll event arriving mid-glide, an image growing the thread under a pin
    // — so wasFollowing reads false while the reader never went anywhere.
    // Nothing deliberate happened, so the new message wins.
    expect(resumePinDecision(false, true, false)).toBe("new-message");
  });

  it("a reader up in his history is never yanked, however new the message", () => {
    // he scrolled up by hand, went away, and something arrived: he gets the
    // message in place, not a view that jumps out from under him
    expect(resumePinDecision(false, true, true)).toBe("hold");
  });

  it("nothing new and not at the tail: the position is left exactly alone", () => {
    expect(resumePinDecision(false, false, false)).toBe("hold");
    expect(resumePinDecision(false, false, true)).toBe("hold");
  });

  it("the landing window outlasts a whole catch-up on a slow link", () => {
    // handshake, then the tail probe's history fetch, then the replay itself
    expect(RESUME_WINDOW_MS).toBeGreaterThanOrEqual(4000);
  });
});

describe("pinFlipGuard", () => {
  it("the resume's own pin cannot unfollow the app it is pinning", () => {
    // the write fires a scroll event that reads the geometry a frame before the
    // pin has settled; letting that disarm following disarms every re-pin after
    expect(pinFlipGuard(true, "unfollow")).toBe("hold");
  });

  it("reaching the bottom still means following, pin or no pin", () => {
    expect(pinFlipGuard(true, "follow")).toBe("follow");
    expect(pinFlipGuard(false, "follow")).toBe("follow");
  });

  it("outside the pin's own couple of frames nothing is held", () => {
    expect(pinFlipGuard(false, "unfollow")).toBe("unfollow");
    expect(pinFlipGuard(false, "hold")).toBe("hold");
    expect(pinFlipGuard(true, "hold")).toBe("hold");
  });

  it("the credit window is a couple of frames, far short of a gesture's", () => {
    expect(PIN_QUIET_MS).toBeLessThan(600); // USER_SCROLL_INTENT_MS
    expect(PIN_QUIET_MS).toBeGreaterThanOrEqual(50);
  });
});

// --- the entrance --------------------------------------------------------------

describe("replayAnimates", () => {
  it("the cold open's backlog stays flat: the cover is still up", () => {
    // one still picture, which is the whole reason the batch commit exists
    expect(replayAnimates(true, false, true)).toBe(false);
  });

  it("a reply replayed into a painted session on screen enters like a live one", () => {
    expect(replayAnimates(true, true, true)).toBe(true);
  });

  it("an entrance played to a hidden page is an entrance nobody sees", () => {
    expect(replayAnimates(true, true, false)).toBe(false);
  });

  it("a straggler that is not the tail never animates", () => {
    // it inserts above the fold and is compensated out of sight in the same
    // frame; there is nothing to animate, and popping a bubble into the middle
    // of history a reader is looking at would be worse than nothing
    expect(replayAnimates(false, true, true)).toBe(false);
  });
});

// --- the wiring in main.ts -----------------------------------------------------

describe("wiring — the resume edge reaches all four decisions", () => {
  it("the visible edge reconnects, re-arms the keep-alive, and lands", () => {
    const body = fnBody("resumeVisible");
    expect(body).toContain("openResumeWindow()");
    expect(body).toContain("resumeReconnect()");
    expect(body).toContain("keepAliveSync()");
    expect(body).toContain("resumePinDecision(resumeWasFollowing, false, resumeAwayByHand)");
    expect(body).toContain("pinBottomNow(\"resume\")");
  });

  it("going hidden takes the reading the decision needs while it is still true", () => {
    const body = fnBody("resumeHidden");
    expect(body).toContain("resumeWasFollowing = followTail");
    expect(body).toContain("resumeAwayByHand = scrolledUpByHand");
    expect(body).toContain("closeResumeWindow()");
    expect(body).toContain("keepAliveSync()");
  });

  it("both edges are delivered from the one visibility listener", () => {
    const at = src.indexOf('document.addEventListener("visibilitychange"');
    const body = src.slice(at, src.indexOf("\n});", at));
    expect(body).toContain("resumeVisible()");
    expect(body).toContain("resumeHidden()");
  });

  it("a back-forward-cache restore is a resume; a load-time pageshow is not", () => {
    const at = src.indexOf('window.addEventListener("pageshow"');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("\n});", at));
    expect(body).toMatch(/if \(e\.persisted\) resumeVisible\(\)/);
  });
});

describe("wiring — the reconnect replaces the socket instead of racing it", () => {
  it("the verdict is the readyState one, and the catch-up is the usual connect", () => {
    const body = fnBody("resumeReconnect");
    expect(body).toContain("reconnectOnVisible(ws ? ws.readyState : null)");
    expect(body).toContain("connect()");
    expect(body).toContain("if (!token) return false"); // logged out: the gate is showing
  });

  it("one socket at a time: connect drops the one it is replacing", () => {
    // the resume's immediate reconnect and a blind retry armed before the
    // freeze can both land in the same beat; the loser used to stay open with
    // its handlers attached and arm yet another retry when it finally closed
    const body = fnBody("connect");
    expect(body.indexOf("dropSocket()")).toBeGreaterThan(-1);
    expect(body.indexOf("dropSocket()")).toBeLessThan(body.indexOf("ws = new WebSocket(url)"));
  });

  it("the dropped socket's own retry is disarmed before it can arm a third", () => {
    const body = fnBody("dropSocket");
    expect(body).toContain("stale.onclose = null");
    expect(body).toContain("stale.onmessage = null");
    expect(body).toContain("stale.close()");
  });

  it("connect still asks for the catch-up from the applied cursor", () => {
    expect(src).toContain("&since=${lastSeq}");
  });
});

describe("wiring — the keep-alive is one small frame, and only while on screen", () => {
  it("the tick asks the decision with the socket's own state and queue", () => {
    const body = fnBody("keepAliveTick");
    expect(body).toContain(
      "keepAliveAction(pageVisible(), ws ? ws.readyState : null, ws?.bufferedAmount ?? 0)",
    );
    expect(body).toContain("ws?.send(KEEPALIVE_FRAME)");
  });

  it("a stalled or refused send reconnects, and the stall is on the trail", () => {
    const body = fnBody("keepAliveTick");
    expect(body).toMatch(/holdDiagRecord\("resume", \{[^}]*reason: "stall"/);
    expect(body.match(/connect\(\);/g)).toHaveLength(2); // the stall AND a throwing send
  });

  it("the frame is text, since the server's loop awaits receive_text", () => {
    expect(src).toMatch(/const KEEPALIVE_FRAME = "\w"/);
  });

  it("the schedule is the decision's, both ways, from one place", () => {
    const body = fnBody("keepAliveSync");
    expect(body).toContain("keepAliveSchedule(pageVisible(), keepAliveTimer !== null)");
    expect(body).toContain("setInterval(keepAliveTick, KEEPALIVE_MS)");
    expect(body).toContain("clearInterval(keepAliveTimer)");
  });

  it("it starts with the page, which opens visible", () => {
    expect(src).toMatch(/clearBadge\(\);\nkeepAliveSync\(\);/);
  });
});

describe("wiring — the landing is instant, and its own writes do not disarm it", () => {
  it("the pin asserts following BEFORE it writes, so the settles pin not clamp", () => {
    const body = fnBody("pinBottomNow");
    expect(body.indexOf("setFollowTail(true, via)")).toBeLessThan(
      body.indexOf("t.scrollTop = t.scrollHeight"),
    );
  });

  it("the pin is a plain write, never a ride or a smooth scroll", () => {
    const body = fnBody("pinBottomNow");
    expect(body).toContain("t.scrollTop = t.scrollHeight");
    expect(body).not.toContain("behavior");
    expect(body).not.toContain("startGlide");
  });

  it("the write is stamped, and the scroll handler credits the stamp", () => {
    expect(fnBody("pinBottomNow")).toContain("pinWroteAt = performance.now()");
    const at = src.indexOf('thread.addEventListener("scroll"');
    const body = src.slice(at, src.indexOf("if (hasScrollend)", at));
    expect(body).toContain("pinFlipGuard(");
    expect(body).toContain("performance.now() - pinWroteAt < PIN_QUIET_MS");
  });

  it("the re-assert a frame later stands down if a settle already answered", () => {
    const body = fnBody("pinBottomNow");
    expect(body).toContain("const armed = tailGen");
    expect(body).toContain("armed !== tailGen");
  });

  it("every bottom pin inside the window is instant, glide included", () => {
    // THE fix for the view stopping short: a live reply landing mid-resume used
    // to ask for a smooth pin, and every frame of that glide fired a scroll
    // event reading away-from-the-bottom
    const pin = fnBody("scrollToBottom");
    expect(pin).toContain(
      "const instant = suppressAnim || force || pinInstant || resumeWindowOpen()",
    );
    expect(pin).toContain('behavior: instant ? "auto" : "smooth"');
    // the replay path's own era is scoped and restored; the window asks for
    // itself, so neither can leave the other's era behind
    const replay = fnBody("applyReplay");
    expect(replay).toContain("pinInstant = true");
    expect(replay).toContain("pinInstant = prevInstant");
    expect(fnBody("openResumeWindow")).not.toContain("pinInstant");
    expect(fnBody("closeResumeWindow")).not.toContain("pinInstant");
  });

  it("the timer IS the window: nothing else can say it is open", () => {
    expect(fnBody("resumeWindowOpen")).toContain("return resumeTimer !== null");
  });

  it("the window closes on its own clock, and early on a real reading gesture", () => {
    expect(fnBody("openResumeWindow")).toContain(
      "setTimeout(closeResumeWindow, RESUME_WINDOW_MS)",
    );
    const at = src.indexOf('thread.addEventListener("scroll"');
    const body = src.slice(at, src.indexOf("if (hasScrollend)", at));
    expect(body).toMatch(/if \(userScrollIntent\(\)\) \{\n\s*scrolledUpByHand = true;/);
    expect(body).toContain("closeResumeWindow()");
  });

  it("a message landing in the window decides once, before the usual pin", () => {
    const arrival = fnBody("resumeArrival");
    expect(arrival).toContain("if (!resumeWindowOpen() || resumeNewArrived) return");
    expect(arrival).toContain("resumePinDecision(resumeWasFollowing, true, resumeAwayByHand)");
    expect(arrival).toContain('pinBottomNow("resume-new")');
    const apply = fnBody("applyEvent");
    expect(apply.indexOf("resumeArrival()")).toBeLessThan(
      apply.indexOf("if (followTail) scrollToBottom()"),
    );
  });

  it("only a real gesture marks the reader as having gone up by hand", () => {
    // the distinction the whole landing turns on: the app's own writes flip
    // following off too, and those must not read as a reader's intent
    expect(src).toMatch(/if \(next\) scrolledUpByHand = false;/); // the tail clears it
    expect(src).not.toMatch(/scrolledUpByHand = true[\s\S]{0,40}[^t]Intent/);
  });
});

describe("wiring — the trail says what the resume decided", () => {
  it("each edge records the reconnect, the pin and the reason", () => {
    for (const body of [fnBody("resumeVisible"), fnBody("resumeArrival")]) {
      expect(body).toMatch(
        /holdDiagRecord\("resume", \{ reconnect(?:: [^,]+)?, pinned, reason: verdict \}\)/,
      );
    }
  });

  it("the mark arms an upload: a quiet thread's banner tap fires nothing else", () => {
    const hold = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../src/hold.ts"),
      "utf8",
    );
    expect(hold).toMatch(/ev === "resume"/);
  });
});
