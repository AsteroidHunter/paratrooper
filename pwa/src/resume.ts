// Coming back on screen — the decisions the resume path makes, and nothing else.
//
// Tapping a push banner is the one moment where every part of this app is out
// of position at once, and the four decisions below are what the wiring in
// main.ts asks on the way back in. Each of them exists because of a specific
// thing the device does.
//
//   THE SOCKET. iOS freezes a backgrounded page: timers stop, the WebSocket's
//   TCP connection is torn down by the OS or quietly rotted by a network change,
//   and nothing tells the page. The only recovery the app had was ws.onclose ->
//   setTimeout(connect, 2000), which needs a close event to fire at all, and a
//   half-open socket never produces one. So the return to the screen asks
//   directly: is this socket OPEN? If it is not, connect now with the usual
//   ?since= catch-up rather than waiting on a retry that may never be armed.
//
//   THE KEEP-ALIVE. Half-open is the case the readyState cannot see: the
//   browser still says OPEN because nothing has told it otherwise. Only SENDING
//   discovers the truth — the bytes go nowhere, the retransmit timer runs out,
//   and the socket errors into a close the reconnect above can act on. The
//   server's /ws loop awaits receive_text() for exactly this, so one tiny text
//   frame on a slow interval is cheap at the other end. It runs only while the
//   page is on screen: a frozen page cannot fire timers anyway, and a page that
//   CAN (a desktop tab in the background) has nobody watching it.
//
//   That last sentence is now the frame's SECOND job, and the server reads it.
//   A ping means "the app is on screen", it stops the moment the page hides,
//   and main.ts sends one last frame on the way out saying so outright. The
//   push for a finished reply used to leave the instant the result arrived,
//   with nobody asking where the reader was — so a banner announced a reply the
//   app was deliberately holding back under his thumbs, or one his next message
//   had already taken back, and a push Apple delivered late arrived after he had
//   gone, where the service worker's own visible-window check no longer
//   suppresses anything. The frame is no longer a no-op at the far end: the
//   interval below is what the server's freshness window is built from.
//
//   THE LANDING. This is the visible half of the bug, and the device has now
//   answered two attempts at it. The first was a SMOOTH pin, and a smooth
//   scroll on this path is fatal: every frame of the glide fires a thread
//   scroll event reading "away from the bottom", which flips followTail off
//   (the composer is not focused after a banner tap, so viewport.ts's protected
//   hold does not apply), and then the resume's own geometry settles cancel the
//   glide with an instant write that CLAMPS instead of pinning — because
//   clamping is what a settle does once following is off. The second was an
//   INSTANT pin on the visible edge, and the trail caught the engine undoing
//   it: the pin wrote the new bottom (1737 of a thread that had grown 120px
//   while the app was away), and seventy milliseconds later, with no gesture
//   and no write of ours anywhere near it, the scroller read the old bottom
//   (1617) back, and nothing re-pinned. That is not a race in the app. On iOS
//   the scroll offset belongs to the system scroll view; a frozen page is
//   handed back with its rendering updates still suspended, so a write made on
//   that edge is clamped against the content size the scroller was put away
//   with, and the scrolling tree is rebuilt a few frames later carrying the
//   STALE position (WebKit 218676, 231989). Safari takes several frames to
//   settle and there is no event that says when.
//
//   So the landing does not write on that edge at all. It HOLDS whatever
//   position the phone hands back, watches the scroller until it stops moving
//   on its own (settleVerdict), and only then rides down to the new bottom on
//   the same damped spring the jump chevron uses — full speed while far out, a
//   settle at the end, the live bottom re-read every frame so a reply landing
//   mid-ride is still ridden all the way to. Whether to ride at all is
//   resumePinDecision and resumeRideDecision below, and their whole point is
//   the case they REFUSE: a reader who deliberately scrolled up into history,
//   went away, and came back to nothing new keeps his place, untouched. A real
//   gesture anywhere in this — during the wait or during the ride — ends it,
//   because the reader has answered the question himself.
//
//   THE ENTRANCE. A frame the socket replays is history while the app is still
//   booting — a cold open's whole backlog, which must land as one still picture
//   rather than a bubble-by-bubble movie. Once the session is painted and on
//   screen, the SAME replay path is carrying something the eye has never seen:
//   the reply that arrived while the app was away. That one is new, and it
//   enters like a live message instead of appearing out of nowhere.
//
// Pure, like viewport.ts and shell.ts's decisions: no DOM, no clock, no socket.
// The wiring — the listeners, the interval, the scroll write — is main.ts's.

import type { FollowFlip } from "./viewport";

// --- the resume window ---------------------------------------------------------
//
// How long after the app comes back a message still counts as "arrived during
// the resume". It has to outlast the whole catch-up on a bad link: the socket
// handshake, the tail probe's history fetch, and the replay itself. Six seconds
// is past all three on cellular and still short enough that it is plainly a
// landing rather than a mode. While it is open every bottom pin the rest of the
// app asks for is instant, which is the point — the app is still publishing its
// own geometry and a browser glide would be cut mid-flight by the first settle.
// The landing's OWN motion is the ride below, which is not one of those pins:
// it re-reads the geometry every frame instead of aiming at a stale target.
export const RESUME_WINDOW_MS = 6000;

// How long a scroll event may still be credited to a write the app made itself.
// A scroll event lands in the same frame as its write or the next one; this is
// a couple of frames of slack for an engine that coalesces them, and it is
// deliberately far short of a gesture's own intent window (viewport.ts). It is
// what covers the RIDE'S last frame: the ride stamps every write it makes, and
// the final one's event arrives after the ride itself has ended.
export const PIN_QUIET_MS = 150;

// --- the socket ----------------------------------------------------------------

// WebSocket.readyState, by name. The numbers are the platform's; naming them
// here keeps this module free of the DOM without pretending the values are ours.
export const SOCKET_CONNECTING = 0;
export const SOCKET_OPEN = 1;
export const SOCKET_CLOSING = 2;
export const SOCKET_CLOSED = 3;

export type ResumeSocket = "reconnect" | "keep";

/**
 * The app is back on screen: does the socket need replacing right now?
 *
 * CLOSING and CLOSED are the dead ones and the whole reason this exists — the
 * blind two-second retry only runs if a close event was ever delivered, and the
 * catch-up it would eventually fetch is the catch-up carrying the reply the
 * user just tapped a banner for.
 *
 * CONNECTING is deliberately left alone: a handshake already in flight is not a
 * blind wait, and abandoning it would start a second socket whose predecessor's
 * close then arms a third. No socket at all (null) is the boot, which
 * bootFromCache owns.
 */
export function reconnectOnVisible(readyState: number | null): ResumeSocket {
  if (readyState === SOCKET_CLOSING || readyState === SOCKET_CLOSED) return "reconnect";
  return "keep";
}

// --- the keep-alive ------------------------------------------------------------

// Slow on purpose. One tiny frame every 25 seconds costs nothing and still
// finds a wedged socket inside a minute.
//
// Something does now depend on it: the server treats the last ping as "the app
// is on screen" and holds the reply's push back while it is fresh, so its
// window (PRESENCE_FRESH_S in src/paratrooper/web/app.py) is two of these plus
// a margin — one ping may be dropped on a bad link without a reader being
// declared absent. Changing this number moves that window, and a test pins the
// two together across the files.
export const KEEPALIVE_MS = 25000;

// A ping still sitting in the send queue when the NEXT one comes due means the
// socket is not moving bytes at all: one byte in 25 seconds is not congestion,
// it is a connection the OS has already lost. Anything above this is a drop.
export const KEEPALIVE_STALL_BYTES = 0;

export type KeepAliveTick = "send" | "drop" | "idle";

/**
 * One turn of the keep-alive clock.
 *
 * @param buffered the socket's bufferedAmount — bytes send() has queued and the
 *                 engine has not yet put on the wire
 */
export function keepAliveAction(
  visible: boolean,
  readyState: number | null,
  buffered: number,
): KeepAliveTick {
  if (!visible) return "idle"; // nobody is watching; a frozen page cannot tick anyway
  if (readyState !== SOCKET_OPEN) return "idle"; // the resume and close paths own a dead socket
  if (buffered > KEEPALIVE_STALL_BYTES) return "drop"; // the last ping never left: half-open
  return "send";
}

export type KeepAliveSchedule = "start" | "stop" | "keep";

/** whether the interval itself should be running, given the page's state */
export function keepAliveSchedule(visible: boolean, running: boolean): KeepAliveSchedule {
  if (visible && !running) return "start";
  if (!visible && running) return "stop";
  return "keep";
}

// --- the landing ---------------------------------------------------------------

export type ResumePin = "following" | "new-message" | "hold";

/**
 * The app is back on screen (or a message has just landed while it was coming
 * back): take the bottom, or leave the view exactly where the reader left it?
 *
 * @param wasFollowing         the view was at the tail the moment the app went
 *                             hidden — coming back to anywhere else would be
 *                             the app losing his place, new message or not
 * @param newArrived           a message has arrived inside the resume window,
 *                             live or replayed. On its own this is not enough:
 *                             a reader up in history gets a badge, not a yank.
 * @param scrolledUpBeforeHide he had DELIBERATELY scrolled up before leaving —
 *                             a real gesture took the view off the tail, not one
 *                             of the app's own writes. This is the distinction
 *                             the whole bug turns on: followTail also latches
 *                             false from a mid-glide scroll event or an image
 *                             landing under a pin, and treating those as a
 *                             reader's intent is what left the view short.
 */
export function resumePinDecision(
  wasFollowing: boolean,
  newArrived: boolean,
  scrolledUpBeforeHide: boolean,
): ResumePin {
  if (wasFollowing) return "following";
  if (newArrived && !scrolledUpBeforeHide) return "new-message";
  return "hold";
}

// --- the settle: waiting the phone's own restore out -----------------------------
//
// The bounded window. A restore that never stops moving is not waited on for
// ever: past this the landing rides anyway, because a view left short of the
// reply is the failure and a ride that starts a few frames early merely writes
// over an engine correction that has by then already happened once. Long enough
// to cover the several frames Safari takes to rebuild the scrolling tree, short
// enough that it reads as a beat before the motion rather than a stall.
export const SETTLE_WINDOW_MS = 350;

// How many frames in a row must read the SAME scrollTop for the engine to count
// as done moving it. Two: the frame that took a reading and the frame that
// agreed with it. One cannot say anything — there is nothing to compare it
// with — and waiting for three costs a whole frame of hold on every ordinary
// return to catch a restore that stutters, which the window above catches anyway.
export const SETTLE_STILL_FRAMES = 2;

// Under a pixel from the bottom there is nowhere to ride to. Same threshold the
// spring itself lands on (downbtn.ts: remaining <= 1 and nearly still = landed),
// so "the ride would do nothing" and "the ride is over" are one number.
export const RIDE_MIN_PX = 1;

export type SettleVerdict = "wait" | "settled";

/**
 * Has the phone finished restoring the scroll position, so the app may start
 * writing it again?
 *
 * There is no event for this. iOS hands a frozen page back with its rendering
 * updates suspended and rebuilds the scrolling tree some frames later, carrying
 * whatever position it was put away with; the only honest signal is the
 * scroller going still by itself, and the only honest floor is a rendering
 * update having happened at all.
 *
 * @param frames    rendering updates delivered since the app came back. Zero is
 *                  the visible edge itself, which is the one moment nothing may
 *                  be written — that is the whole lesson of the ghost.
 * @param still     how many frames in a row, counting this one, have read the
 *                  same scrollTop as the frame before them. The first reading
 *                  of a run is 1: it has agreed with nothing yet.
 * @param elapsedMs since the visible edge
 */
export function settleVerdict(frames: number, still: number, elapsedMs: number): SettleVerdict {
  if (frames < 1) return "wait"; // nothing has rendered: this IS the visible edge
  if (elapsedMs >= SETTLE_WINDOW_MS) return "settled"; // the bound, whatever the engine is doing
  return still >= SETTLE_STILL_FRAMES ? "settled" : "wait";
}

export type ResumeRide = "ride" | "still";

/**
 * The engine has settled: ride down to the new bottom, or leave the scroll
 * exactly where the phone put it?
 *
 * @param verdict   resumePinDecision's answer, taken at the visible edge while
 *                  the reading it needs was still true
 * @param remaining px between the position the engine settled on and the end of
 *                  the thread's range as it now stands. Read HERE, after the
 *                  wait, never carried in from the edge: the reply the ride
 *                  exists for usually lands inside that wait.
 * @param gestured  a real gesture has happened since the app came back — a
 *                  finger on the glass, a wheel, a pointer. He has answered the
 *                  question himself and the app does not get a second opinion.
 */
export function resumeRideDecision(
  verdict: ResumePin,
  remaining: number,
  gestured: boolean,
): ResumeRide {
  if (verdict === "hold") return "still"; // a reader up in his history
  if (gestured) return "still"; // the scroll is his again
  return remaining > RIDE_MIN_PX ? "ride" : "still";
}

/**
 * The app's own scroll writes fire scroll events, and those events read the
 * geometry mid-motion — "away from the bottom", which unfollows, which disarms
 * every followTail-gated re-pin after it. The app's own write does not get to
 * disarm the app.
 *
 * Only the unfollow arm is held. Reaching the bottom still means following,
 * exactly as it does everywhere else, so a write that lands correctly re-derives
 * the truth through the one usual place rather than being asserted twice.
 */
export function pinFlipGuard(pinning: boolean, flip: FollowFlip): FollowFlip {
  return pinning && flip === "unfollow" ? "hold" : flip;
}

/**
 * Is this scroll event the app's own motion?
 *
 * Two shapes of the same fact. A RIDE is in the air for as long as it takes, so
 * it is asked about directly rather than timed — a spring that cruises two
 * screens would run out of any stamp window. Its last frame is the other
 * shape: that write's event arrives after the ride has already ended, so the
 * stamp is what carries the credit across the boundary.
 *
 * The jump chevron's glide is deliberately NOT covered by either. It relies on
 * its own mid-flight events unfollowing, because a settle that pins would cut
 * it short and a settle that clamps leaves it alone (viewport.ts settleBottom).
 * The resume's ride is the opposite case: it is followed all the way down, and
 * the settles stand aside for it in main.ts instead.
 *
 * @param sinceWriteMs ms since the ride last wrote the scroll
 * @param riding       the resume's ride is in the air right now
 */
export function appOwnsScroll(sinceWriteMs: number, riding: boolean): boolean {
  return riding || sinceWriteMs < PIN_QUIET_MS;
}

/**
 * Whether a frame arriving on the REPLAY path enters like a live message.
 *
 * The boundary is the session's first paint. Before it — the cold open, the
 * loading cover still up — the replay is the thread's own history arriving and
 * must land as one still picture; that is the whole reason the batch commit
 * exists. After it, with the app on screen, the replay path is carrying a reply
 * that landed while the app was away, and it is new to the eye.
 *
 * @param isTail  the frame is the newest thing in the thread. A straggler
 *                inserting above the fold is compensated out of sight in the
 *                same frame; animating something nobody can see, or popping a
 *                bubble into the middle of history a reader is looking at, are
 *                both wrong for the same reason.
 * @param booted  the loading cover has lifted: there is a painted session here
 * @param visible the page is on screen right now — an entrance played to a
 *                hidden page is an entrance nobody sees
 */
export function replayAnimates(isTail: boolean, booted: boolean, visible: boolean): boolean {
  return isTail && booted && visible;
}
