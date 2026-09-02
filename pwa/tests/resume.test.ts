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
//   the landing, which took two goes. A reply arriving mid-resume first asked
//   for a SMOOTH pin, whose own mid-flight scroll events read "away from the
//   bottom" and flipped following off, after which every re-pin in the app is
//   gated shut and the resume's geometry settles CLAMP where they should pin.
//   The instant pin that replaced it was undone by the phone: the device trail
//   has the write landing on the new bottom and the scroller reading the old
//   one back seventy milliseconds later with no gesture and no write of ours in
//   between, which is iOS restoring a scrolling tree it rebuilt from the
//   content size the page was frozen with. So the landing now writes nothing on
//   that edge at all — it holds, waits for the engine to go still, and rides
//   the chevron's spring down to the reply
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
  RIDE_MIN_PX,
  SETTLE_STILL_FRAMES,
  SETTLE_WINDOW_MS,
  SOCKET_CLOSED,
  SOCKET_CLOSING,
  SOCKET_CONNECTING,
  SOCKET_OPEN,
  appOwnsScroll,
  keepAliveAction,
  keepAliveSchedule,
  pinFlipGuard,
  reconnectOnVisible,
  replayAnimates,
  resumePinDecision,
  resumeRideDecision,
  settleVerdict,
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

describe("settleVerdict", () => {
  it("the visible edge itself is never written on: no frame, no verdict", () => {
    // THE lesson of the ghost. A write made before the engine has rendered once
    // is clamped against the content size the page was frozen with, and handed
    // straight back a few frames later — so the bound below cannot fire either
    // until something has actually painted.
    expect(settleVerdict(0, 0, 0)).toBe("wait");
    expect(settleVerdict(0, 0, SETTLE_WINDOW_MS + 1000)).toBe("wait");
  });

  it("one frame says nothing: it has agreed with nothing yet", () => {
    expect(settleVerdict(1, 1, 8)).toBe("wait");
  });

  it("two frames reading the same position mean the engine has let go", () => {
    expect(settleVerdict(2, SETTLE_STILL_FRAMES, 32)).toBe("settled");
  });

  it("a position still moving frame to frame is still the phone's, not ours", () => {
    // the restore walking the offset back: every frame disagrees with the last,
    // so the run of agreement never gets going
    for (let f = 2; f < 12; f += 1) expect(settleVerdict(f, 1, f * 16)).toBe("wait");
  });

  it("a restore that never settles is not waited on for ever", () => {
    expect(settleVerdict(20, 1, SETTLE_WINDOW_MS)).toBe("settled");
    expect(settleVerdict(20, 1, SETTLE_WINDOW_MS - 1)).toBe("wait");
  });

  it("the bound is a beat before the motion, not a stall", () => {
    expect(SETTLE_WINDOW_MS).toBeGreaterThanOrEqual(300);
    expect(SETTLE_WINDOW_MS).toBeLessThanOrEqual(400);
  });
});

describe("resumeRideDecision", () => {
  it("following, with a reply waiting below: ride down to it", () => {
    expect(resumeRideDecision("following", 120, false)).toBe("ride");
    expect(resumeRideDecision("new-message", 120, false)).toBe("ride");
  });

  it("a reader up in his history is left exactly where the phone put him", () => {
    expect(resumeRideDecision("hold", 4000, false)).toBe("still");
  });

  it("nothing new below: the position is not touched at all", () => {
    // a return to a thread that did not move — the ordinary case, and the one
    // where any motion at all would be the app fidgeting
    expect(resumeRideDecision("following", 0, false)).toBe("still");
    expect(resumeRideDecision("following", RIDE_MIN_PX, false)).toBe("still");
    expect(resumeRideDecision("following", RIDE_MIN_PX + 1, false)).toBe("ride");
  });

  it("a real gesture since the return ends it before it starts", () => {
    // he has answered the question himself; the app does not get a second
    // opinion. Mid-ride the thread's own wheel/pointer/touch handlers do the
    // same thing by cancelling the glide.
    expect(resumeRideDecision("following", 4000, true)).toBe("still");
    expect(resumeRideDecision("new-message", 4000, true)).toBe("still");
  });
});

describe("pinFlipGuard", () => {
  it("the resume's own ride cannot unfollow the app it is riding down", () => {
    // every frame of the ride reads away-from-the-bottom on the way there;
    // letting that disarm following disarms every re-pin after it
    expect(pinFlipGuard(true, "unfollow")).toBe("hold");
  });

  it("reaching the bottom still means following, ride or no ride", () => {
    expect(pinFlipGuard(true, "follow")).toBe("follow");
    expect(pinFlipGuard(false, "follow")).toBe("follow");
  });

  it("outside the app's own motion nothing is held", () => {
    expect(pinFlipGuard(false, "unfollow")).toBe("unfollow");
    expect(pinFlipGuard(false, "hold")).toBe("hold");
    expect(pinFlipGuard(true, "hold")).toBe("hold");
  });
});

describe("appOwnsScroll", () => {
  it("a ride in the air owns every scroll event under it, however long it runs", () => {
    // asked about directly rather than timed: a spring cruising two screens
    // would run out of any stamp window
    expect(appOwnsScroll(1e6, true)).toBe(true);
  });

  it("the stamp carries the credit past the ride's own last frame", () => {
    // that write's scroll event arrives after the ride has already ended, and
    // it is the one that used to undo the whole landing
    expect(appOwnsScroll(PIN_QUIET_MS - 1, false)).toBe(true);
  });

  it("past the stamp window with nothing riding, a scroll is the reader's", () => {
    expect(appOwnsScroll(PIN_QUIET_MS, false)).toBe(false);
    expect(appOwnsScroll(5000, false)).toBe(false);
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
    expect(body).toContain("armResumeRide(verdict)");
  });

  it("going hidden takes the reading the decision needs while it is still true", () => {
    const body = fnBody("resumeHidden");
    expect(body).toContain("resumeWasFollowing = followTail");
    expect(body).toContain("resumeAwayByHand = scrolledUpByHand");
    expect(body).toContain("closeResumeWindow()");
    expect(body).toContain("stopResumeRide()"); // a half-finished landing dies here
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

// --- presence: the server is told where the app is, not left to guess ----------
//
// The push for a finished reply used to leave the instant the result arrived,
// with nothing in the server knowing whether the app was in front of the
// reader. Two things came out of that. The app deliberately HOLDS a finished
// reply while he is typing and can take it back entirely when the next message
// outruns it, so a banner and a badge announced a reply that was never put on
// screen or one that had already been deleted. And a push Apple delivered late
// landed after he had left, where the service worker's "is a window visible
// right now" rule no longer suppresses anything — that rule stays exactly where
// it is, as the second line rather than the first.
//
// So the decision moved to the server and the app feeds it, over the socket it
// already holds open. No beacon, no extra request: the keep-alive doubles as
// "on screen now" and one more frame says "gone".

describe("wiring — the app says where it is over the socket it already has", () => {
  it("the away frame sits with the ping and is one byte like it", () => {
    expect(src).toMatch(/const AWAY_FRAME = "\w";/);
    // declared together, because they are one statement about the same thing
    expect(src).toMatch(/const KEEPALIVE_FRAME = "\w";[^\n]*\nconst AWAY_FRAME = "\w";/);
  });

  it("both bytes mean the same thing at the far end", () => {
    // the one wire contract this rides: two single-character frames, agreed
    // across the two files by nothing but their spelling
    const app = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../src/paratrooper/web/app.py"),
      "utf8",
    );
    const ping = src.match(/const KEEPALIVE_FRAME = "(\w)";/);
    const away = src.match(/const AWAY_FRAME = "(\w)";/);
    expect(app).toContain(`PRESENCE_PING = "${ping?.[1]}"`);
    expect(app).toContain(`PRESENCE_AWAY = "${away?.[1]}"`);
  });

  it("a frame goes out only on an OPEN socket, and never takes the page down", () => {
    // send() on a CONNECTING socket throws, and the resume path replaces a
    // socket in every other state — neither is this function's problem
    const body = fnBody("sendPresence");
    expect(body).toContain("if (!token) return");
    expect(body).toContain("ws.readyState !== SOCKET_OPEN");
    expect(body).toContain("ws.send(frame)");
    expect(body).toMatch(/try \{[\s\S]*\} catch \{/);
  });

  it("going hidden says so once, BEFORE the keep-alive stops", () => {
    // from that edge the page may be frozen mid-breath; a ping already sent
    // would otherwise leave the server believing he is here for a whole window
    const body = fnBody("resumeHidden");
    expect(body).toContain("sendPresence(AWAY_FRAME)");
    expect(body.indexOf("sendPresence(AWAY_FRAME)")).toBeLessThan(
      body.indexOf("keepAliveSync()"),
    );
  });

  it("coming back says so at once, not at the interval's first tick", () => {
    // keepAliveSync only STARTS the clock: its first ping is KEEPALIVE_MS away,
    // and a reply finishing inside that would have pushed a banner at a reader
    // holding the phone
    const body = fnBody("resumeVisible");
    expect(body).toContain("sendPresence(KEEPALIVE_FRAME)");
  });

  it("a fresh socket announces itself, so presence is known from the handshake", () => {
    const at = src.indexOf("ws.onopen = () => {");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("\n  };", at));
    expect(body).toContain("if (pageVisible()) sendPresence(KEEPALIVE_FRAME)");
  });

  it("the server's freshness window is built from this interval", () => {
    // it cannot read the number, so the derivation is pinned here as well as in
    // the python suite: two intervals (one ping may drop) plus a margin
    const app = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../src/paratrooper/web/app.py"),
      "utf8",
    );
    const window = app.match(/^PRESENCE_FRESH_S = ([\d.]+)$/m);
    expect(window, "the server names its window").toBeTruthy();
    const seconds = Number(window?.[1]);
    expect(seconds).toBeGreaterThanOrEqual((2 * KEEPALIVE_MS) / 1000);
    expect(seconds).toBeLessThanOrEqual((3 * KEEPALIVE_MS) / 1000);
  });

  it("the phone-side rule is untouched: it is the second line, not the first", () => {
    // a late push still has to be caught on the device, and the worker's own
    // visibility check is the only thing that can do it
    const sw = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../public/sw.js"),
      "utf8",
    );
    expect(sw).toContain('clients.some((client) => client.visibilityState === "visible")');
  });
});

describe("wiring — the landing holds, then rides, and its own motion cannot disarm it", () => {
  it("NOTHING is written on the visible edge: the landing only watches", () => {
    // the ghost's whole lesson. The instant pin that used to live here wrote
    // the new bottom and the engine handed the old one back 70ms later.
    const body = fnBody("armResumeRide");
    expect(body).not.toContain("scrollTop =");
    expect(body).not.toContain("scrollTo(");
    // the first thing it does with a frame is READ
    expect(body).toContain("const top = el.scrollTop");
  });

  it("the wait is the settle detector, driven a rendering update at a time", () => {
    const body = fnBody("armResumeRide");
    expect(body).toContain("settleVerdict(frames, still, ms)");
    expect(body).toContain("still = top === lastTop ? still + 1 : 1");
    // every check happens INSIDE a frame, which is what makes "the first
    // rendering update has happened" true by construction rather than by clock
    expect(body).toMatch(/=== "wait"\) \{\n\s*requestAnimationFrame\(step\);/);
  });

  it("only then does it ride, on the chevron's own spring", () => {
    const body = fnBody("armResumeRide");
    expect(body).toContain('startGlide("resume")');
    // and the distance is read after the wait, not carried in from the edge:
    // the reply it is riding to usually landed inside that wait
    expect(body).toContain("maxScrollTop(el.scrollHeight, el.clientHeight) - top");
    expect(body).toContain("resumeRideDecision(verdict, remaining, gestured)");
  });

  it("following is asserted before the first frame of the ride", () => {
    const body = fnBody("armResumeRide");
    expect(body.indexOf('setFollowTail(true, "resume-ride")')).toBeLessThan(
      body.indexOf('startGlide("resume")'),
    );
  });

  it("a gesture since the return stands the landing down", () => {
    const body = fnBody("armResumeRide");
    // only a gesture AFTER the app came back: lastGestureAt survives the freeze
    expect(body).toContain("const armedAt = lastGestureAt");
    expect(body).toContain("threadTouching || lastGestureAt > armedAt");
    // and mid-ride the thread's own handlers cancel it, as they do the chevron's
    const at = src.indexOf('thread.addEventListener("wheel"');
    expect(src.slice(at, src.indexOf('thread.addEventListener("scroll"', at)))
      .toContain("cancelGlide()");
    expect(fnBody("cancelGlide")).toContain("landingHold = false");
  });

  it("the ride's every frame is stamped, and the scroll handler credits it", () => {
    // the chevron's ride is pointedly NOT stamped: it relies on unfollowing
    // itself so the settles clamp and leave it alone
    expect(fnBody("startGlide")).toContain(
      'if (owner === "resume") appWroteAt = performance.now()',
    );
    const at = src.indexOf('thread.addEventListener("scroll"');
    const body = src.slice(at, src.indexOf("if (hasScrollend)", at));
    expect(body).toContain("pinFlipGuard(");
    expect(body).toContain("appOwnsScroll(performance.now() - appWroteAt, resumeRiding())");
  });

  it("no pin and no settle writes the bottom while the landing owns it", () => {
    // a pin here is the write iOS undoes while holding, and the teleport the
    // ride replaces while riding
    expect(fnBody("scrollToBottom")).toContain("if (resumeHolding()) return");
    const settle = fnBody("settleTail");
    expect(settle).toContain("settleBottom(g, followTail && !resumeHolding())");
    expect(settle).toContain("const write = plan.moved || !resumeHolding()");
  });

  it("the ride ends the landing, whichever way it ends", () => {
    expect(fnBody("cancelGlide")).toContain("if (resumeRiding()) landingHold = false");
    expect(fnBody("startGlide")).toContain("landingHold = false");
    expect(fnBody("stopResumeRide")).toContain("landingHold = false");
  });

  it("every bottom pin inside the window is instant, glide included", () => {
    // THE fix for the view stopping short: a live reply landing mid-resume used
    // to ask for a smooth pin, and every frame of that glide fired a scroll
    // event reading away-from-the-bottom
    const pin = fnBody("scrollToBottom");
    expect(pin).toContain(
      "const instant = suppressAnim || force || pinInstant || resumeWindowOpen()",
    );
    // an instant pin is the one native scroll left on the thread; a live
    // message outside the window rides the app's own spring instead of the
    // browser's smooth scroll (retired on 2026-09-02: one such scroll put the
    // engine into dropping the page's offset writes around every box change
    // for the rest of the session)
    expect(pin).toContain('if (instant) {\n    t.scrollTo({ top, behavior: "auto" });');
    expect(pin).not.toContain('"smooth"');
    expect(pin).toContain("startGlide()");
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
    expect(arrival).toContain("armResumeRide(verdict)");
    const apply = fnBody("applyEvent");
    expect(apply.indexOf("resumeArrival()")).toBeLessThan(
      apply.indexOf("if (followTail) scrollToBottom()"),
    );
  });

  it("a landing already in the air is not restarted by the reply it is riding to", () => {
    // the ride re-reads the live bottom every frame, so the message that just
    // grew the thread is already in front of it
    expect(fnBody("armResumeRide")).toContain("if (resumeHolding()) return true");
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

  it("the ride says how long the phone held on, how far it then went, and where it landed", () => {
    // the edge mark cannot carry any of this: it is all known some hundreds of
    // milliseconds later, which is the whole reason for a second record
    const arm = fnBody("armResumeRide");
    expect(arm).toMatch(/holdDiagRecord\("resume-ride", \{ phase: "ride", \.\.\.mark \}\)/);
    expect(arm).toMatch(/holdDiagRecord\("resume-ride", \{ phase: "still", \.\.\.mark \}\)/);
    expect(arm).toContain("ms: Math.round(ms), frames, still");
    expect(arm).toContain("px: Math.round(remaining), gest: gestured");
    expect(fnBody("startGlide")).toMatch(/holdDiagRecord\("resume-ride", \{\n\s*phase: "land"/);
  });

  it("both marks arm an upload: a quiet thread's banner tap fires nothing else", () => {
    const hold = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../src/hold.ts"),
      "utf8",
    );
    expect(hold).toMatch(/ev === "resume"/);
    expect(hold).toMatch(/ev === "resume-ride"/);
  });

  it("the server prints both, or the records die on arrival", () => {
    // a mark no block in the digest claims never reaches the deploy logs at
    // all, which is exactly how this channel went missing the first time
    const app = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../src/paratrooper/web/app.py"),
      "utf8",
    );
    const marks = app.slice(app.indexOf("marks = ["), app.indexOf("vp = ["));
    expect(marks).toContain('"resume", "resume-ride"');
    const vp = app.slice(app.indexOf("vp = ["), app.indexOf("holddiag viewport"));
    expect(vp).toContain('"resume", "resume-ride"');
  });
});
