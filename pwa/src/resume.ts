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
//   server's /ws loop already awaits receive_text() for exactly this ("client
//   keepalive / pings; sends go via POST"), so one tiny text frame on a slow
//   interval is a supported no-op at the other end. It runs only while the page
//   is on screen: a frozen page cannot fire timers anyway, and a page that CAN
//   (a desktop tab in the background) has nobody watching it.
//
//   THE LANDING. This is the visible half of the bug. A reply that lands while
//   the app is resuming used to arrive with a SMOOTH scroll behind it, and a
//   smooth scroll on this path is fatal: every frame of the glide fires a thread
//   scroll event reading "away from the bottom", which flips followTail off
//   (the composer is not focused after a banner tap, so viewport.ts's protected
//   hold does not apply), and then the resume's own geometry settles cancel the
//   glide with an instant write that CLAMPS instead of pinning — because
//   clamping is what a settle does once following is off. Every later re-pin
//   hook is followTail-gated too, so nothing recovers and the view sits short of
//   the new reply. The fix is a pin that is instant from the start, asserts
//   following before it writes, and is not undone by its own scroll event.
//   Whether to pin at all is resumePinDecision below, and its whole point is
//   the case it REFUSES: a reader who deliberately scrolled up into history,
//   went away, and came back to nothing new keeps his place.
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
// landing rather than a mode. While it is open every bottom pin is instant,
// which is the point — the app is still publishing its own geometry and a glide
// would be cut mid-flight by the first settle.
export const RESUME_WINDOW_MS = 6000;

// How long a scroll event may still be credited to the resume's own pin. The
// write is instant, so its event lands in the same frame or the next one; this
// is a couple of frames of slack for an engine that coalesces them, and it is
// deliberately far short of a gesture's own intent window (viewport.ts).
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

// Slow on purpose: this is a liveness probe, not a heartbeat anything depends
// on. One tiny frame every 25 seconds costs nothing and still finds a wedged
// socket inside a minute.
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

/**
 * The resume's pin writes the scroll, and writing the scroll fires a scroll
 * event, and that event reads the geometry a frame BEFORE the pin has settled —
 * "away from the bottom", which unfollows, which disarms every followTail-gated
 * re-pin after it. The app's own write does not get to disarm the app.
 *
 * Only the unfollow arm is held. Reaching the bottom still means following,
 * exactly as it does everywhere else, so a pin that lands correctly re-derives
 * the truth through the one usual place rather than being asserted twice.
 */
export function pinFlipGuard(pinning: boolean, flip: FollowFlip): FollowFlip {
  return pinning && flip === "unfollow" ? "hold" : flip;
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
