// Paratrooper PWA — message the pinboard agent. Vanilla TS + DOM (lightest build).
// Same-origin /api + /ws (the FastAPI service serves this bundle in production).
import "./styles.css";
import { BLUR_EDGE, decodeBlurhash } from "./blurhash";
import { createBootGate } from "./bootgate";
import { caretCountsAsComposing } from "./caret";
import { moveTypingAfter, placeTyping } from "./dots";
import { createDownButton, createGlide } from "./downbtn";
import type { Glide } from "./downbtn";
import { ackFrame, enrichFrame } from "./enrich";
import {
  SHOT_BEND,
  bundleSeats,
  coverBox,
  elbowBox,
  elbowPath,
  gatherMsFor,
  shotLeg,
} from "./gather";
import { createReplyHold, holdDiagAuth, holdDiagRecord } from "./hold";
import { composeMirror, fitComposeBox } from "./mirror";
import {
  DRAW_NO_DEADLINE,
  SMALL_SHOT_PX,
  photoBox,
  resizeHonoured,
  smallShotUrl,
  thumbDrop,
  thumbMoved,
  thumbMoves,
  thumbPark,
  thumbShift,
  thumbSlide,
  trayClose,
  whenDrawn,
} from "./photobox";
import type { DrawWhy, SmallDrawHost, SmallShot, ThumbSeat } from "./photobox";
import { GUESS_H, GUESS_RATIO, GUESS_W, learnDims, scrollFix, servedShape } from "./photofit";
import type { Dims } from "./photofit";
import { WAIT_CLASS, createPhotoQueue, nearMargin } from "./photolazy";
import { receiptFor } from "./receipts";
import {
  ENTER_RISE_PX,
  FLIGHT_EASE,
  FLIGHT_MS,
  FLIGHT_SLACK_MS,
  accentAlpha,
  barTextAlpha,
  bubbleTextAlpha,
  flightEase,
  morphBox,
  morphCorners,
  newbornEnter,
  shiftParticipates,
  stampRidesFlight,
} from "./shift";
import type { MorphBox } from "./shift";
import { zoomClipCuts, zoomClipInset, zoomClipRest, zoomFit, zoomReturn } from "./zoom";
import {
  bindPicker,
  bindSendShield,
  closeCorrectionNeeded,
  currentFileInput,
  initShell,
  watchFollowTail,
  watchKeyboard,
} from "./shell";
import { bootBlankGap, installLoadingScreen, installStartupImage, watchQuiet } from "./splash";
import {
  SETTLE_BURST_GAP_MS,
  USER_SCROLL_INTENT_MS,
  compensationFor,
  createSettleBurst,
  flightOverflow,
  followFlipDecision,
  giveUpTarget,
  laidOutRows,
  nearBottomOf,
  rowName,
  settleBottom,
  settleMark,
  tailGapFrame,
} from "./viewport";
import type { BottomGeometry, SettleBurstMark, TailSettle } from "./viewport";
import { del as outboxDelete, getAll as outboxGetAll, put as outboxPut } from "./outbox";
import type { OutboxRecord } from "./outbox";
import {
  CACHE_FRAMES,
  createWriteScheduler,
  del as cacheDel,
  get as cacheGet,
  put as cachePut,
} from "./threadcache";
// TEMP DIAGNOSTIC (scroll-jank, scrolljank.ts owns the banner): the recorder
// wires itself on import (clock-only listeners plus the longtask observer),
// and jankSpan stamps the heavier jobs this file owns so a long frame can
// name them — the cache snapshot, the older-history drain, the decorate fold,
// the photo queue's release batch and its pixels' landing, the tail settle,
// and the sent shot's landing. TO REMOVE: both imports and the stamped pairs
// below (the banner's list names each one).
import { jankSpan } from "./jankledger";
import "./scrolljank";
// TEMP DIAGNOSTIC (pick-timing, picktiming.ts owns the banner): the pick clock's
// steps. shell.ts starts the clock at the file input's change event and every
// stamp below is one step of what this file then does with the file, out to the
// frame the picture is painted in. TO REMOVE: this import and the calls named in
// that banner's list.
import {
  pickTimingDims,
  pickTimingFile,
  pickTimingLaid,
  pickTimingPainted,
  pickTimingStep,
} from "./picktiming";
// TEMP DIAGNOSTIC (blank-thread, blankprobe.ts owns the banner): the readings
// either side of a drawer height change that begins mid-glide, whichever edge
// moved it. TO REMOVE: this import and the calls named in that banner's list.
import { blankProbeEdge, blankProbeFollow, blankProbeSettle } from "./blankprobe";

declare const __BUILT_AT__: string;
declare const __SERVER_VERSION__: string; // server commit this bundle was built against

const APP_VERSION = "0.3.59"; // the scroll-stutter hunt gets real instruments: the recorder now names which of the app's own jobs (history landing, bubble decorating, photo loading and settling) ran inside each stall, reports every gesture's total stalled time instead of a number that always read zero, and the diagnostic upload itself — caught blocking mid-scroll — now waits until your gesture is over and the app is idle before it sends

// compose placeholder: one of these, picked at random each time the chat
// renders — app-voice dispatch prompts, ellipses spaced per Akash's spec
const PROMPTS = [
  "Dispatch for HQ?",
  "Wire your orders …",
  "Carrier pigeon inbound …",
  "Balloon's up …",
  "Over the top …",
  "Sortie at dawn …",
  "From the trenches …",
  "Telegram for the board?",
  "Drop from the biplane …",
  "Signal the aerodrome …",
];

const TOKEN_KEY = "paratrooper_token";
const THREAD_ID = "default"; // single user, single thread in v1
let token = localStorage.getItem(TOKEN_KEY) ?? "";
let lastSeq = 0;
let oldestSeq = 0; // lowest seq applied; the ?before= cursor for older pages
let loadingOlder = false;
// Older-history pipeline (the iMessage feel without a virtual list): pages are
// FETCHED ahead into a bank and INSERTED only at glide boundaries — writing
// scrollTop mid-glide fights iOS momentum (the v0.1.53 jerk), and demanding
// long total silence starves (the v0.1.54 nothing-ever-loads). Boundaries come
// from the browser's own scrollend signal where available; the banked pages
// have their own cursor (fetchCursor) so several can queue before any insert
// advances oldestSeq.
const HISTORY_PAGE = 25;
const HISTORY_BANK = 3; // pages fetched ahead ≈ 6+ screens of ready runway
let pendingOlder: ServerMsg[][] = [];
let fetchCursor = 0; // min seq fetched so far; 0 = follow oldestSeq
let historyDone = false; // the server returned an empty page: true top reached
let threadTouching = false; // finger on the thread: never insert under it
let lastScrollAt = 0; // scroll events still arriving = momentum still running
let ws: WebSocket | null = null;
let closingOnPurpose = false; // logout: suppress the auto-reconnect
let restoredOutbox = false; // once-per-session guard for the durable-outbox restore
// Replay batching (one-commit catch-up): while the boot ledger says the
// backlog is still streaming, socket replay frames buffer here instead of
// touching the DOM, and the caughtUp edge applies the whole buffer in ONE
// task (commitReplayBuffer) — a cold open or an away-for-days catch-up lands
// as one discrete update, never a bubble-by-bubble movie. The fallback timer
// closes the ledger with whatever arrived if the tail probe never answers:
// buffered frames must not sit invisible behind a hung request.
let replayBuffer: ServerMsg[] = [];
let replayBufferMax = 0; // highest buffered seq; counts toward the caught-up cursor
let probeFallback: ReturnType<typeof setTimeout> | null = null;
const PROBE_FALLBACK_MS = 5000; // past any believable probe round trip; only a hang trips it

// The client-side event store: seq → ThreadEvent, THE display truth. Apply is
// idempotent (duplicate seqs no-op — reconnect replays and zombie-socket
// re-deliveries vanish here) and ordered (older pages and out-of-order frames
// insert in position). The DOM is a projection of this map, never the state.
// One carve-out from the no-op: a RICHER duplicate repairs the stored frame
// in place (enrichStored below), because the server heals photo rows on read
// and the re-delivery may be the only copy carrying the attachment fields.
const store = new Map<number, ServerMsg>();

// finished-reply hold (hold.ts owns the state machine): a "done" landing while
// Akash is mid-keystroke parks until 7s of composer quiet, an emptied box, or
// a send. Release renders through the one applyEvent path below, so seq
// ordering and idempotence hold unchanged — and nothing survives a reload
// (the reply is in server history; that's the point).
const replyHold = createReplyHold<ServerMsg>((m) => {
  applyEvent(m);
  // a released frame can be the last uncovered piece of a catch-up backlog:
  // the ledger must get its chance to latch on it (a no-op once settled)
  replaySettle();
});

// jump-chevron visibility (downbtn.ts owns the state machine): it appears only
// after 4s of scroll stillness while away from the bottom — never because new
// content landed. The scroll handler feeds it, this one callback drives the
// class; live lookup, so renderChat re-renders can't strand a stale element.
const downBtn = createDownButton((show) =>
  document.getElementById("jump")?.classList.toggle("show", show),
);

// the keyboard gate (shell.ts owns the edge, downbtn.ts the rule): up takes
// the chevron down, and the down edge is one nudge with the same followTail
// verdict the scroll handler feeds it, so the ordinary stillness window
// decides whether it comes back.
//
// The same edge is also the loudest bottom-geometry change the app has, so it
// settles the scroll (settleTail below). The edge is delivered from inside the
// visual-viewport resize that carries it, which is the event this has to run
// in; the next frame runs it again because iOS can still be reporting the old
// numbers at event time, and that is one frame of looking, not a delay. Every
// frame between the two belongs to the shell's own box glide, and those reach
// the same place through the thread's resize observer.
watchKeyboard((up) => {
  downBtn.keyboard(up, followTail);
  const via = up ? "kb-open" : "kb-close";
  settleTail(via);
  requestAnimationFrame(() => settleTail(via));
  // TEMP DIAGNOSTIC (tail-gap, block at the foot of this file): the band under
  // the last message, read at the edge he actually sees it at. Every reading in
  // the trail so far is taken on a SEND, and all of them come back healthy,
  // while his screenshots show 408px and 270px of white standing after a
  // keyboard close. So the failing state has never once been measured, and
  // guessing into that hole has been wrong twice. This reads it where he sees
  // it, and names what is sitting below the last message when it happens.
  if (!up) recordTailGapNow("kb-close");
});

// boot-replay ledger (bootgate.ts owns it): the honest replay marker. Every
// socket frame at or below the server's tail-at-connect is backlog and must
// never animate, however late it arrives; frames above it are genuinely new
// and do. connect() re-arms it per socket and feeds it the tail probe.
const bootGate = createBootGate();

// cold-open thread cache (threadcache.ts owns the record): the newest
// CACHE_FRAMES stored frames verbatim plus the lastSeq cursor, rewritten
// debounced after applies and flushed when the app goes hidden. Boot reads it
// back and paints the whole thread in one task before any network touches the
// visible path (bootFromCache below); logout deletes it.
function writeThreadCache(): void {
  if (!token || store.size === 0) return; // an empty snapshot must never clobber a good one
  const jankT0 = performance.now(); // TEMP DIAGNOSTIC (scroll-jank): the snapshot build is sync main-thread work
  const seqs = [...store.keys()].sort((a, b) => a - b).slice(-CACHE_FRAMES);
  void cachePut({ id: THREAD_ID, lastSeq, frames: seqs.map((s) => store.get(s)!) });
  jankSpan("cache-write", jankT0); // TEMP DIAGNOSTIC (scroll-jank)
}
const cacheWrites = createWriteScheduler(writeThreadCache);

// The canonical ThreadEvent frame — one shape for live pushes, socket replay,
// and history pages alike. Ephemeral kinds (working/typing) ride without a seq.
interface ServerMsg {
  seq?: number;
  thread_id?: string;
  role?: "user" | "agent" | "system";
  kind?: string | null; // ResultKind or system kind; absent/null on user messages
  payload?: unknown; // any JSON value; message text is a plain string
  attachments?: string[];
  attachment_dims?: ([number, number] | null)[]; // thumb sizes, index-aligned; null = undecodable preview
  attachment_blurhashes?: (string | null)[]; // ~28-char previews, same index, same null rule
  ts?: string; // ISO-8601, server clock (live, replay and the send ACK alike)
}

const app = document.getElementById("app")!;
initShell(app); // keyboard/focus/picker state converges through shell.ts

// editor hold-brighten: while a finger rests on the pill its face brightens
// evenly (one flat veil, styles.css .field::before — overlay opacity only,
// nothing positional) and fades back on release. Skipped during the settling
// window — a held tap must not brighten a switched-off box. Module-level with
// live lookups, like the menu-close below, so re-renders can't stack listeners.
document.addEventListener(
  "pointerdown",
  (e) => {
    const t = e.target;
    if (t instanceof HTMLElement && t.id === "text" && !app.classList.contains("settling")) {
      t.parentElement?.classList.add("glow");
    }
  },
  true,
);
const unglow = (): void => document.querySelector(".field.glow")?.classList.remove("glow");
document.addEventListener("pointerup", unglow, true);
document.addEventListener("pointercancel", unglow, true);

// settings dropdown: any tap outside it (or its button) closes it. Bound once
// at module level with live lookups, so renderChat re-renders can't stack
// stale listeners.
document.addEventListener(
  "pointerdown",
  (e) => {
    const menu = document.getElementById("menu");
    if (!menu?.classList.contains("open")) return;
    const gear = document.getElementById("settings");
    if (e.target instanceof Node && (menu.contains(e.target) || gear?.contains(e.target))) return;
    menu.classList.remove("open");
  },
  true,
);

// The one defensive snap-back left, and only OUTSIDE a keyboard session. The
// shell itself never scrolls (styles.css — html/body are overflow:hidden at
// 100vh with touch-action:none, #app is inset-pinned, only .thread scrolls),
// yet iOS can still programmatically scroll the WINDOW to "reveal" a focused
// composer — e.g. a focus tap's reveal landing before the keyboard is provably
// up, the gap the focus blink (styles.css) exists to close. The composer is
// always fully visible in our layout, so a window scroll while it holds focus
// with NO keyboard is iOS fighting the shell: snap it straight back, same
// frame (snapping to 0 refires "scroll" once with scrollY already 0, so it
// cannot loop). WITH the keyboard up (.kb) the shell owns the whole affair
// (shell.ts): it rides the visual viewport, refuses to track a scroll-sourced
// growth shove (clearing it in its own frame, with a yield guard so the
// retired counter's window war cannot restart), and corrects residue once at
// close.
window.addEventListener(
  "scroll",
  () => {
    if (document.activeElement?.id !== "text") return;
    if (app.classList.contains("kb")) return; // close-time correction owns keyboard residue
    if (window.scrollX !== 0 || window.scrollY !== 0) {
      holdDiagRecord("snapback", {
        door: "window", x: Math.round(window.scrollX), y: Math.round(window.scrollY),
      });
      window.scrollTo(0, 0);
    }
  },
  { passive: true },
);

// vv-geom: the trail's record of every visual-viewport move while the composer
// is focused — how the device reads keyboard geometry back from deploy logs.
// Purely a recorder: the shell tracks the viewport (shell.ts sizes it on this
// same event) instead of any door fighting it. Registered AFTER initShell, so
// reconcile has already applied .kb and the shell box for this event by the
// time the state is read.
if (window.visualViewport) {
  const vv = window.visualViewport;
  const vvRecord = (src: string): void => {
    if (document.activeElement?.id !== "text") return;
    holdDiagRecord("vv-geom", {
      src, h: Math.round(vv.height), top: Math.round(vv.offsetTop),
      ih: window.innerHeight, kb: app.classList.contains("kb"),
    });
  };
  vv.addEventListener("resize", () => vvRecord("resize"));
  vv.addEventListener("scroll", () => vvRecord("scroll"));
}

// caret moves and text selection count as composing for the reply hold: a
// reply must not land mid-thumb-drag any more than mid-keystroke.
// selectionchange fires document-wide (and once per keystroke too — the input
// listener already fed the clock then, a second reset is harmless), so it is
// gated to the focused composer and to a grace window after our own composer
// writes (the send-path clear echoes a selectionchange that must not undo
// flush — caret.ts explains); recorded under its own name so the trail tells
// selection activity from text changes.
let composerWroteAt = -Infinity; // performance.now() of the last programmatic value write
document.addEventListener("selectionchange", () => {
  if (!caretCountsAsComposing(document.activeElement?.id, performance.now() - composerWroteAt)) {
    return;
  }
  holdDiagRecord("caret");
  replyHold.typed();
});

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

// TEMP DIAGNOSTIC (hold.ts trail): its POST goes to a route that now demands
// the app token like every other one, so it is handed this builder rather than
// growing its own copy of the token read. A function, not the header itself:
// the token arrives at the gate screen and leaves at logout, and the trail must
// follow it both ways. TO REMOVE: this line, with that block.
holdDiagAuth(authHeaders);

// --- token gate --------------------------------------------------------------

function renderTokenGate(): void {
  app.innerHTML = `
    <div class="gate">
      <h1>Paratrooper</h1>
      <p>Enter your access token to connect.</p>
      <input id="token-input" type="password" placeholder="access token" autocomplete="off" />
      <button id="token-save">Connect</button>
      <p class="buildstamp">ui build ${__BUILT_AT__}</p>
    </div>`;
  const input = document.getElementById("token-input") as HTMLInputElement;
  document.getElementById("token-save")!.addEventListener("click", () => {
    const value = input.value.trim();
    if (!value) return;
    token = value;
    localStorage.setItem(TOKEN_KEY, value);
    renderChat();
    connect();
  });
}

// --- chat shell --------------------------------------------------------------

function renderChat(): void {
  app.innerHTML = `
    <header class="bar">
      <div class="contact">
        <img class="avatar" src="/topbar-logo.png" alt="" />
        <div class="ident">
          <span class="title">Paratrooper</span>
          <span class="ver">v${APP_VERSION}</span>
        </div>
      </div>
      <div class="settings">
        <button type="button" id="settings" class="gearbtn" title="Settings" aria-label="Settings"></button>
        <div id="menu" class="menu">
          <button type="button" id="logout" class="menu-item">Log Out</button>
        </div>
      </div>
    </header>
    <div id="confirm" class="confirm">
      <div class="confirm-card">
        <p class="confirm-msg">Are you sure you want to log out?</p>
        <div class="confirm-row">
          <button type="button" id="confirm-no" class="confirm-no">No</button>
          <button type="button" id="confirm-yes" class="confirm-yes">Yes</button>
        </div>
      </div>
    </div>
    <main id="thread" class="thread">
      <div id="histspin" class="histspin" aria-hidden="true"><span class="ring"></span></div>
    </main>
    <div id="pending" class="pending"></div>
    <form id="compose" class="compose">
      <button type="button" id="attach" class="attach" title="Attach">＋</button>
      <input id="files" type="file" accept="image/*" multiple
        class="filepick" tabindex="-1" aria-hidden="true" />
      <div class="field">
        <textarea id="text" rows="1"
          placeholder="${PROMPTS[Math.floor(Math.random() * PROMPTS.length)]}"></textarea>
        <button type="submit" id="sendbtn" class="send">↑</button>
      </div>
      <button type="button" id="jump" class="jump" title="Jump to latest"><span
        class="jump-glyph">↓</span></button>
    </form>`;
  document.getElementById("settings")!.addEventListener("click", () => {
    document.getElementById("menu")!.classList.toggle("open");
  });
  // Log Out is gated behind an iOS-style confirm so a stray tap can't log out:
  // No (safe, bold blue) dismisses; Yes (destructive red) actually logs out.
  const confirmEl = document.getElementById("confirm")!;
  document.getElementById("logout")!.addEventListener("click", () => {
    document.getElementById("menu")!.classList.remove("open");
    confirmEl.classList.add("open");
  });
  confirmEl.addEventListener("click", (e) => {
    if (e.target === confirmEl) confirmEl.classList.remove("open"); // backdrop tap = No
  });
  document.getElementById("confirm-no")!.addEventListener("click", () => {
    confirmEl.classList.remove("open");
  });
  document.getElementById("confirm-yes")!.addEventListener("click", () => {
    localStorage.removeItem(TOKEN_KEY);
    token = "";
    lastSeq = 0; // full replay on next login
    closingOnPurpose = true;
    ws?.close();
    ws = null;
    cacheWrites.cancel(); // a pending write must not resurrect the record deleted next
    void cacheDel(THREAD_ID); // the cached thread is credentialed content
    if (probeFallback) clearTimeout(probeFallback);
    probeFallback = null;
    renderTokenGate();
  });
  const filesEl = document.getElementById("files") as HTMLInputElement;
  // ＋/picker focus choreography (preventDefault rules, parked-focus cleanup,
  // swapping in a virgin input per present) lives in shell.ts; here only the
  // app concern: collect picks into the tray. Read the CURRENT input rather
  // than the one bound above — shell.ts replaces the element between presents.
  bindPicker(filesEl, document.getElementById("attach")!, () => {
    // TEMP DIAGNOSTIC (pick-timing, picktiming.ts owns the banner): the handler
    // step, so the hop from the change event into the app is its own number, and
    // one activity stamp around the whole synchronous pick so a long frame here
    // can name itself. Both are number writes and change nothing below.
    pickTimingStep("handler");
    const jankT0 = performance.now();
    const el = currentFileInput();
    pendingFiles.push(...Array.from(el?.files ?? []));
    if (el) el.value = ""; // allow re-picking the same file
    renderPending();
    // TEMP DIAGNOSTIC (pick-timing): the synchronous work is done here, and the
    // frame that carries its layout is stamped from a frame callback
    jankSpan("pick-sync", jankT0);
    pickTimingStep("sync");
    pickTimingLaid();
  });
  document.getElementById("compose")!.addEventListener("submit", (e) => {
    e.preventDefault();
    void send();
  });
  // the ↑ must not steal focus from the textarea (that collapsed the keyboard
  // on every send); the shield mirrors the ＋'s, and shell.ts owns the rule
  bindSendShield(document.getElementById("sendbtn")!);
  // compose auto-grow lives in autosize() (module level, by the scroll
  // helpers): it resizes the box AND compensates the thread's scroll in the
  // same frame, so send() can route its bar collapse through the same path
  const textEl = document.getElementById("text") as HTMLTextAreaElement;
  textEl.addEventListener("input", () => {
    autosize(true); // typed: the blink protects this keystroke whether or not it grew a line
    refreshSend();
    replyHold.typed(); // composing = keystroke freshness; content is irrelevant
  });
  // the editor's width moves when the ＋ yields/reclaims its slot (styles.css
  // .kb): existing text re-wraps at the new width, so its height must be
  // re-derived or the box keeps a stale line count (too tall widening, an
  // inner scrollbar shrinking back). Width-gated so our own height writes
  // above can't loop the observer.
  let lastTextWidth = 0;
  if ("ResizeObserver" in window) {
    new ResizeObserver(() => {
      if (textEl.clientWidth === lastTextWidth) return;
      lastTextWidth = textEl.clientWidth;
      autosize();
    }).observe(textEl);
  }
  const thread = document.getElementById("thread")!;
  // glide boundaries come from the browser's own scrollend where it exists
  // (Safari 26.2+ — a real "scrolling finished" signal, momentum included);
  // older engines fall back to a scroll-quiet debounce
  const hasScrollend = "onscrollend" in thread;
  let restTimer: ReturnType<typeof setTimeout> | null = null;
  // gesture evidence feeding userScrollIntent(): wheel and pointer cover the
  // desktop paths (scrollbar drags land pointerdown on the thread), touch is
  // marked in the peek handlers below. Every real gesture also takes the
  // scroll back from a running tap glide — the user always wins mid-flight.
  thread.addEventListener("wheel", () => {
    cancelGlide();
    lastGestureAt = performance.now();
  }, { passive: true });
  thread.addEventListener("pointerdown", () => {
    cancelGlide();
    lastGestureAt = performance.now();
  });
  thread.addEventListener("scroll", () => {
    // No watchdog here, deliberately, and it must not come back. A pass that
    // clamped the scroll whenever it read past the end shipped once and was a
    // regression: sitting past the end is also exactly what the engine does
    // while a rubber band stretch is on screen and while one of our own glides
    // is landing, so the clamp read normal motion as the fault and cut it, which
    // showed as the jump-down glide hanging part way and as the stretch at the
    // bottom snapping shut instead of easing back. The position is re-derived
    // where it is actually invalidated instead: both keyboard edges, the
    // drawer's open and close, and the thread's own resize, which sees every
    // frame of a box that eases. Those are what closed the white band, and none
    // of them fires while a finger is on the glass.
    // the ONE place following flips: away from the bottom = reading history,
    // back at the bottom = following again (programmatic pins land here too).
    // While the composer is focused, an away reading needs a real gesture to
    // unfollow — shove/pin scroll events hold the line (viewport.ts explains)
    const flip = followFlipDecision(
      nearBottom(), document.activeElement?.id === "text", userScrollIntent(),
    );
    if (flip === "follow") setFollowTail(true, "scroll-bottom");
    else if (flip === "unfollow") setFollowTail(false, "scroll-away");
    else holdDiagRecord("ft-suppress", { st: Math.round(thread.scrollTop) });
    downBtn.scrolled(followTail); // away restarts its 4s stillness window; bottom hides it
    // start BANKING older pages while the user is still ~1.5 screens away —
    // inserts happen separately, at glide boundaries
    if (thread.scrollTop < 1200) void loadOlder();
    lastScrollAt = performance.now();
    if (!hasScrollend) {
      if (restTimer) clearTimeout(restTimer);
      restTimer = setTimeout(() => {
        lastScrollAt = 0;
        tryApplyOlder();
      }, 100);
    }
  });
  if (hasScrollend) {
    thread.addEventListener("scrollend", () => {
      lastScrollAt = 0; // the browser says the glide is over — authoritative
      tryApplyOlder();
    });
  }
  document.getElementById("jump")!.addEventListener("click", () => {
    downBtn.bottomReached(); // hides now; the landing's own scroll event agrees
    setFollowTail(true, "jump");
    // one continuous ride (downbtn.ts): flat cruise speed however far up,
    // then a damped-spring settle into the landing, never a teleport step.
    // Mid-glide scroll events read !nearBottom and flip followTail off, so the
    // followTail-gated instant pins cannot cut the glide short; the landing's
    // own scroll event re-derives followTail=true as usual.
    startGlide();
  });
  // swipe-left to peek per-message times (iMessage): a decisively LEFTWARD
  // hold-and-drag pulls the thread with tanh resistance, revealing the time
  // rail the thread normally clips; anything else stays native scrolling
  let startX = 0;
  let startY = 0;
  let peeking: boolean | null = null; // null = gesture direction undecided
  thread.addEventListener(
    "touchstart",
    (e) => {
      cancelGlide(); // a finger down owns the scroll; the tap glide yields
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      peeking = null;
      threadTouching = true; // no history inserts under a resting finger
      lastGestureAt = performance.now();
    },
    { passive: true },
  );
  thread.addEventListener(
    "touchmove",
    (e) => {
      lastGestureAt = performance.now();
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (peeking === null) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        peeking = dx < 0 && Math.abs(dx) > Math.abs(dy) * 1.5;
        if (peeking) thread.classList.add("dragging");
      }
      if (!peeking) return;
      e.preventDefault(); // we own this gesture; vertical scroll stays native
      // resistance: tracks the finger at first, then fights back toward 64px
      const pull = 64 * Math.tanh(Math.max(-dx, 0) / 110);
      thread.style.setProperty("--peek", `-${pull.toFixed(1)}px`);
    },
    { passive: false },
  );
  const endPeek = () => {
    thread.classList.remove("dragging");
    thread.style.setProperty("--peek", "0px");
    threadTouching = false;
    // a release with no glide (a still hold) fires no scroll/scrollend —
    // check shortly after; the lastScrollAt gate skips real glides. NO special
    // at-top fast path: a release at the top starts the rubber-band snap-back,
    // which is itself a scroll animation — writing into it was the teleport.
    // scrollend fires after the bounce settles and lands the page then.
    setTimeout(tryApplyOlder, 200);
  };
  thread.addEventListener("touchend", endPeek);
  thread.addEventListener("touchcancel", endPeek);
  // fresh thread DOM: the store must match (login/logout re-renders the shell)
  store.clear();
  replyHold.reset(); // parked frames die with the old shell; replay re-delivers
  oldestSeq = 0;
  pendingOlder = []; // banked pages hold stale seqs from the old session
  fetchCursor = 0;
  historyDone = false;
  setFollowTail(true, "fresh-shell");
  downBtn.bottomReached(); // fresh shell opens pinned: no chevron, no pending timer
  bootGate.reset(); // fresh shell: replay ledger re-arms, the first settle owns the pin
  flightsUp = 0; // airborne flights died with the old shell (late settles floor at 0)
  airborneRows.clear(); // and their rows belong to a thread that no longer exists
  receiptPending = false;
  restoredOutbox = false; // a fresh shell re-reads the durable outbox
  threadObserver?.disconnect(); // the old shell's thread element is gone
  threadObserver?.observe(thread);
  watchPhotos(thread); // history photos load off THIS thread box's proximity
  // rebuild any failed sends persisted from a prior session; async and marked
  // .restored so the server replay (kicked off right after) stays above them
  void restoreOutbox();
}

// --- older history (recent-first: the socket sends a window, we page back) ----

// FETCH half: banks the next page and never touches the DOM. Chains itself
// until the bank is full or the server says there is nothing older. The
// spinner is NOT wired to this — it marks "more history exists", sitting in
// the content above the oldest message (see #histspin), like the reference.
async function loadOlder(): Promise<void> {
  if (loadingOlder || historyDone || pendingOlder.length >= HISTORY_BANK) return;
  if (oldestSeq === 0) return; // nothing applied yet: no cursor to page from
  const before = fetchCursor || oldestSeq;
  if (before <= 1) {
    historyDone = true;
    return;
  }
  loadingOlder = true;
  try {
    const r = await fetch(`/api/history/${THREAD_ID}?before=${before}&limit=${HISTORY_PAGE}`, {
      headers: authHeaders(),
    });
    if (!r.ok) return;
    const { messages } = (await r.json()) as { messages: ServerMsg[] };
    if (!messages.length) {
      historyDone = true; // true top; the spinner comes out on the next drain
    } else {
      pendingOlder.push(messages);
      fetchCursor = Math.min(...messages.map((m) => m.seq ?? before));
    }
  } finally {
    loadingOlder = false;
  }
  // a completed fetch may land ONLY for someone visibly waiting at the
  // spinner — landing on every fetch while parked streamed the whole thread
  // in 25s ("too many per turn"); everyone else gets pages at glide ends
  if (threadEl().scrollTop <= 50) tryApplyOlder();
  if (!historyDone && pendingOlder.length < HISTORY_BANK) void loadOlder(); // keep banking
}

// INSERT half: lands ONE page per glide boundary — the bank is for readiness,
// not for dumping ("users notice jumps way more than slow loading"); 75-message
// slabs were review-rejected. Older events feed the same apply path as live
// frames — they insert in position by seq; only the viewport needs pinning
// around the height change, and doing THAT between glides is the whole point.
// The spinner leaves only WITH the final page (or an empty-handed done probe),
// riding the same pin so the goodbye can't shift the view either.
function drainOlder(): void {
  const spin = document.getElementById("histspin");
  const page = pendingOlder.shift();
  const dropSpin = historyDone && pendingOlder.length === 0 && spin !== null;
  if (!page && !dropSpin) return;
  // TEMP DIAGNOSTIC (scroll-jank): a whole page's insert — twenty-five
  // applyEvent+decorate rounds plus the pin — is sync main-thread work and the
  // prime scroll-back suspect. Taken after the early return: a no-op drain
  // stamps nothing. TO REMOVE with the scrolljank.ts block.
  const jankT0 = performance.now();
  const t = threadEl();
  const prevScroll = t.scrollTop;
  const prevHeight = t.scrollHeight;
  const prevSuppress = suppressAnim;
  suppressAnim = true; // a page of history must not pop bubble-by-bubble
  if (page) for (const m of page) applyEvent(m);
  suppressAnim = prevSuppress;
  t.scrollTop = prevScroll + (t.scrollHeight - prevHeight); // visible row stays put
  if (dropSpin) {
    // the farewell happens at scrollTop~0 where the pin cannot compensate for
    // height removed above (it can't go negative) — an abrupt remove() shoved
    // the view every time. Collapse it smoothly outside the pin instead.
    spin.classList.add("bye");
    setTimeout(() => spin.remove(), 300);
  }
  jankSpan("drain-older", jankT0); // TEMP DIAGNOSTIC (scroll-jank)
}

// the boundary gate: no finger down and the glide over (scrollend sets
// lastScrollAt to 0 before calling; the debounce fallback relies on the
// timestamp). Doubling as the prober: after draining — or on short threads
// that can't scroll at all — it tops the bank back up.
function tryApplyOlder(): void {
  if (threadTouching) return;
  if (performance.now() - lastScrollAt < 140) return; // glide still running
  drainOlder();
  if (!historyDone && threadEl().scrollTop < 1200) void loadOlder();
}

// --- pending attachments (picked but not yet sent) -----------------------------

let pendingFiles: File[] = [];

// the ↑ lives inside the field and exists only while there is something to
// send (text or staged files), like iMessage; every path that changes either
// one funnels through the input handler or renderPending, which both call this
function refreshSend(): void {
  const btn = document.getElementById("sendbtn");
  const text = document.getElementById("text") as HTMLTextAreaElement | null;
  if (!btn || !text) return;
  btn.classList.toggle("show", text.value.trim().length > 0 || pendingFiles.length > 0);
}

// Everything a picked file carries between the picker and the send. The tray
// used to rebuild itself from scratch on every change, which made a fresh blank
// element for a photo it had already drawn; a pick is staged once and kept, so
// only a genuinely new photo is ever waited on and removing one of several never
// blinks the survivors.
interface Pick {
  url: string; // the one blob url the thumbnail and the sent photo both read
  wrap: HTMLElement; // the tray thumbnail, holding its square from the tap on
  img: HTMLImageElement; // the ONE drawn photo: the tray shows it, the send carries it
}

// TEMP DIAGNOSTIC (guessed-box, recorded in renderUser): the photos that have
// had to invent their own box this session, so the record is one per photo
// rather than one per render.
const guessedSeen = new Set<string>();

// TEMP DIAGNOSTIC (sized-box, recorded in renderUser): the photos that were
// drawn at a size the app already knew, counted for the same reason and in the
// same way as the guessing ones, so that neither channel's silence is ambiguous.
const sizedSeen = new Set<string>();

// TEMP DIAGNOSTIC (served-shape, recorded in checkServedShape): the photos of
// that same known-size kind whose real pixels have since been read, and how many
// of those turned out not to be the shape the app was promised. Distinct photos
// in both, like the two sets above, so that a re-render can inflate neither.
const servedSeen = new Set<string>();
let servedOff = 0;

const picks = new Map<File, Pick>();

// the tray's close-down while it runs (dismissPick, dismissSent). A pick
// landing mid-close has to call it off: an animation still holding the box at
// zero height would keep the new thumbnail clipped out of sight (showPending).
let trayClosing: Animation | null = null;

// The survivors' slide into a cancelled square's place (closeGap). Kept so that
// a second cancel arriving mid-slide can read them where they visually are and
// then take the old motions off, instead of stacking one translate on another.
let gapSlides: Animation[] = [];

// TEMP DIAGNOSTIC (blank-thread, blankprobe.ts owns the banner): how many
// squares the strip was last left holding, so showPending can tell a pass that
// really moves its height from one that re-renders a tray standing exactly as
// it was. A count, never a measurement. TO REMOVE: this and the two lines in
// showPending that read and write it.
let drawerSeats = 0;

function renderPending(): void {
  refreshSend(); // staged files count toward "something to send"
  const box = document.getElementById("pending");
  if (!box) return;
  // a file that left the tray takes its thumbnail and its blob url with it. A
  // file the SEND took has already handed its url over to the thread (takeShot
  // blanks it), and revoking that one would pull the photo out of the bubble.
  for (const [file, pick] of picks) {
    if (pendingFiles.includes(file)) continue;
    picks.delete(file);
    pick.wrap.remove();
    if (pick.url) URL.revokeObjectURL(pick.url);
  }
  for (const file of pendingFiles) {
    const pick: Pick = picks.get(file) ?? stagePick(file, box);
    picks.set(file, pick);
    // a rebuilt shell (a log out and back in) leaves a staged thumbnail parented
    // to a tray that is gone; it belongs to whichever tray is on screen now
    if (pick.wrap.parentElement !== box) box.appendChild(pick.wrap);
  }
  showPending();
}

// The tray is open exactly when something is staged in it — a file test, not a
// pixel test. Gating this on the pixels instead meant the tray's whole height
// change waited on a decode, and a 12MP camera photo misses that deadline every
// time on device, so the strip and the thumbnail both arrived a beat after the
// tap. The seat opens now and the picture fills it later (stagePick).
function showPending(): void {
  const box = document.getElementById("pending");
  if (!box) return;
  // TEMP DIAGNOSTIC (pick-timing/scroll-jank, picktiming.ts and scrolljank.ts
  // own the banners): the drawer's own switch-on and the tail settle behind it,
  // spanned for the ledger and stamped at the end as the "open" step. Taken
  // after the early return, so a run with no tray on screen stamps nothing.
  const jankT0 = performance.now();
  const open = pendingFiles.length > 0;
  // TEMP DIAGNOSTIC (blank-thread, blankprobe.ts owns the banner): whether the
  // strip is standing right now, read off the style attribute rather than off
  // layout, so it costs nothing and so it survives the removeAttribute below
  // that is about to wipe it. It names the edge for the probe further down.
  const wasOpen = box.style.display === "flex";
  // Not every pass through here moves the strip: a picker dismissed with
  // nothing chosen re-renders a tray that is already standing exactly as it
  // was. Arming on that would spend the one run a gesture gets on a frame where
  // nothing happened, and the run holds its slot for seconds. The display flip
  // and the seat count answer it between them, and both are free.
  const drawerMoved = wasOpen !== open || pendingFiles.length !== drawerSeats;
  drawerSeats = pendingFiles.length;
  // a pick landing mid-close calls the close off: the tray owes the new square
  // its full height this very frame, and the closing animation is still holding
  // the box at zero with the clip that goes with it
  if (open) {
    trayClosing?.cancel();
    trayClosing = null;
    box.classList.remove("closing");
    // a send's close parks the box on a fixed rect (dismissSent); a tray that
    // is opening again belongs back in the flex column, not floating on it
    box.removeAttribute("style");
  }
  // TEMP DIAGNOSTIC (blank-thread, blankprobe.ts owns the banner): the strip
  // appearing, growing a square, or going, whichever this pass is. It sits
  // ahead of the write so the reading it takes is the before-picture, and a
  // cancel or a send that is already inside a run refuses it there.
  if (drawerMoved) {
    blankProbeEdge(
      open ? (wasOpen ? "grow" : "open") : "shut",
      performance.now() - lastScrollAt,
    );
  }
  box.style.display = open ? "flex" : "none";
  // The tray's height is the thread's: the room it takes on the tap and the
  // room it gives back at the end of a close both move the scroller's bottom
  // edge, so the scroll is re-established on this same frame. Reading the box
  // inside the settle flushes the display write above, so the numbers it works
  // from are the ones this line just produced, not the previous frame's.
  settleTail(open ? "drawer-open" : "drawer-close");
  jankSpan("pick-open", jankT0); // TEMP DIAGNOSTIC (scroll-jank)
  pickTimingStep("open"); // TEMP DIAGNOSTIC (pick-timing)
}

// The gap a cancelled square leaves, closed while it goes rather than after it.
// photobox.ts (the gap section) holds the reasoning and all of the arithmetic;
// this is the reads, the writes and the one class.
function closeGap(box: HTMLElement, wrap: HTMLElement, beat: KeyframeAnimationOptions): void {
  const others = Array.from(box.querySelectorAll<HTMLElement>(".pthumb"))
    .filter((el) => el !== wrap);
  if (others.length === 0) return;
  // any slide still running comes off FIRST, so the before-reading below is of
  // squares where the eye last saw them and no translate is stacked on another
  for (const slide of gapSlides) slide.cancel();
  gapSlides = [];
  const seat = (el: HTMLElement): ThumbSeat => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top };
  };
  const before = others.map(seat);
  const square = wrap.getBoundingClientRect();
  wrap.classList.add("leaving"); // out of the flow in THIS frame: the room is given back now
  const strip = box.getBoundingClientRect(); // read after the reflow, never before
  const park = thumbPark(
    { left: square.left, top: square.top, width: square.width, height: square.height },
    { left: strip.left, top: strip.top },
  );
  wrap.style.left = `${park.left}px`;
  wrap.style.top = `${park.top}px`;
  wrap.style.width = `${park.width}px`;
  wrap.style.height = `${park.height}px`;
  const after = others.map(seat);
  thumbMoves(before, after).forEach((move, i) => {
    if (!thumbMoved(move)) return; // everything left of the gap has not moved
    gapSlides.push(others[i].animate(thumbShift(move), beat));
  });
}

// The ✕. Everything the tap DECIDES lands on the tap — the file leaves the
// staging list and the ↑ answers for it immediately — and only the DOM teardown
// waits for the motion, so a send fired mid-close can never pick the dismissed
// photo back up. Removing the square and switching the tray off in one frame was
// the snap he reported; photobox.ts (thumbDrop, trayClose) holds the two halves
// of what replaces it and why they are one beat.
function dismissPick(file: File, pick: Pick): void {
  const box = document.getElementById("pending");
  // Out of the ledger on the tap, not when the motion ends. From here this
  // square belongs to nobody: a renderPending landing mid-close cannot prune it
  // out from under its own animation, the drawing wait it was staged with reads
  // the same absence and lets its reveal go, and the teardown below owns the
  // wrap and the url outright rather than checking whether it still may.
  picks.delete(file);
  const beat: KeyframeAnimationOptions = {
    duration: FLIGHT_MS,
    easing: FLIGHT_EASE,
    fill: "forwards", // the square stays gone and the box stays shut until the teardown below
  };
  // the tray's own height moves only when this was the last square in it
  const last = pendingFiles.length === 0;
  if (box && last) {
    const padTop = parseFloat(getComputedStyle(box).paddingTop) || 0;
    box.classList.add("closing"); // clips the full-size square while the box goes past it
    trayClosing = box.animate(trayClose(box.offsetHeight, padTop), beat);
    // This close runs IN the flex column, so the thread takes the drawer's
    // height back frame by frame and the scroller's end walks up with it. Every
    // one of those frames settles through the threadObserver, which is delivered
    // after layout and before paint, so the conversation simply stays where it
    // is while the drawer closes underneath it and the band never opens.
    //
    // There is deliberately NO settle on this line. One used to stand here, and
    // it ran in the tap's own frame, when the drawer is still standing at its
    // full height and nothing about the geometry has changed yet. It could not
    // hand back a height that had not been given up, so what it actually did at
    // that instant was raise the scroll: following holds anywhere within
    // NEAR_BOTTOM_PX of the bottom, and the settle's follow arm pins to the
    // exact end, so it closed however much of that slack the reader had in one
    // hop. Its write is instant and unconditional too, which takes any glide or
    // rubber band the engine was in down with it. Both are upward, and the
    // per-frame settles then walked the view back down as the drawer really
    // went: the jump up, and the fall after it. Nothing here needs to correct
    // anything, because nothing here has changed yet; the close's own frames and
    // showPending's settle below own the whole of it.
  }
  // With others still staged the strip's height does not move at all, and the
  // work is the hole this square is about to leave in the middle of the row.
  if (box && !last) closeGap(box, pick.wrap, beat);
  const drop = pick.wrap.animate(thumbDrop(), beat);
  const gone = (): void => {
    box?.classList.remove("closing");
    gapSlides = []; // finished or cancelled with the square they were closing over
    pick.wrap.remove();
    if (pick.url) URL.revokeObjectURL(pick.url);
    // display:none only once the height has actually gone — and it re-reads the
    // staging list, so a pick that arrived mid-close finds the tray open
    showPending();
  };
  drop.addEventListener("finish", gone);
  drop.addEventListener("cancel", gone);
}

// The SEND's tray teardown. The ✕ above already says what a leaving square
// looks like: the square drops while the strip eases its own height down, one
// beat, and only the DOM teardown waits for the motion. A send used to skip
// all of that; renderPending's prune deleted the thumbnail and switched the
// strip off inside the tap's frame, so the photo vanished an instant before
// its strip did and an emptied strip sat over the compose bar for the close.
// The send closes like the ✕ now, with every square aboard for the ride.
//
// One part of the ✕'s close must not be copied: its height animation runs IN
// the flex column, so the thread absorbs it frame by frame through the
// threadObserver re-pin. During a send that re-pin is poison, because the
// flight's translate inflates scrollHeight and a pin landing mid-flight
// overshoots by the inflation and drags the landing seat (the mid-flight drag
// send()'s two-rAF wait exists to prevent). So the strip leaves the LAYOUT on
// the tap: fixed at its own rect, it hands the thread its room in one hop
// exactly where the old display:none did, and the close is pure paint over a
// thread that never resizes under the flight.
//
// The squares stay lit without their img: the send takes the one drawn
// element into the bubble (takeShot), so a square that has its pixels paints
// the same blob as its own background for the close (styles.css .pthumb.sent
// keeps the box the img used to size), and a square still waiting keeps the
// grey face and ring it was already wearing. At no point is an emptied strip
// on screen.
//
// Unless the squares have been taken ALOFT, which is the ordinary send now
// (armShotMorph): a copy of each picture is already standing over its square
// in viewport coordinates, about to gather and fly, so the square underneath
// has nothing left to say and goes on the spot. Nothing of it is on screen to
// shrink, and painting the blob a second time as a background under a copy
// that is covering it would be work for a frame nobody sees. The box's own
// height still eases down the same way; with every square handed over it is an
// empty box with no face of its own, so that close is pure bookkeeping.
function dismissSent(): void {
  const box = document.getElementById("pending");
  const sent = [...picks.values()];
  // out of the ledger on the tap, like the ✕: renderPending cannot prune what
  // it cannot see, the reveal wait reads the same absence and stands down,
  // and the teardown below owns the wraps outright
  picks.clear();
  if (!box || sent.length === 0 || box.style.display === "none") {
    renderPending(); // nothing staged, or no strip on screen: the plain teardown
    return;
  }
  // TEMP DIAGNOSTIC (blank-thread, blankprobe.ts owns the banner): the send's
  // own edge. The strip leaves the layout in one hop here rather than easing
  // inside the column, so this is the drawer edge that hands the thread its
  // room fastest, and it is taken before the three writes that do it.
  blankProbeEdge("sent", performance.now() - lastScrollAt);
  refreshSend(); // the ↑ answers the tap; the strip answers over the beat below
  const rect = box.getBoundingClientRect();
  const padTop = parseFloat(getComputedStyle(box).paddingTop) || 0;
  // anchored by its bottom edge so the top edge glides down, which is the way
  // the in-flow close moves (the thread grows and the strip's top descends)
  box.style.position = "fixed";
  box.style.left = `${rect.left}px`;
  box.style.width = `${rect.width}px`;
  box.style.bottom = `${window.innerHeight - rect.bottom}px`;
  box.classList.add("closing"); // clips the full-size squares while the box goes past them
  // The strip has just left the layout, so the thread has its room back in one
  // hop: the scroll answers for that hop here, in the hop's own frame.
  //
  // This is NOT the up-front correction the ✕ path had to lose. There the
  // drawer was still standing at full height when the settle ran, so it
  // answered a change that had not happened yet; here the three writes above
  // have already happened and reading the thread's numbers below flushes them,
  // so this settle answers room the thread genuinely has this frame. The ✕'s
  // close eases inside the column and belongs to the per-frame observer; this
  // one is a single hop and has no frames for that observer to ride.
  settleTail("drawer-close");
  const beat: KeyframeAnimationOptions = {
    duration: FLIGHT_MS,
    easing: FLIGHT_EASE,
    fill: "forwards", // the squares stay gone and the box stays shut until the teardown below
  };
  const closing = box.animate(trayClose(rect.height, padTop), beat);
  trayClosing = closing;
  const done = (): void => {
    box.classList.remove("closing");
    box.removeAttribute("style"); // the fixed rect goes; the display write below re-decides
    // display:none only once the height has actually gone, and it re-reads the
    // staging list, so a pick that arrived mid-close finds the tray open
    showPending();
  };
  closing.addEventListener("finish", done);
  closing.addEventListener("cancel", done);
  for (const pick of sent) {
    // no url is revoked here: takeShot blanked every one on the way in, and
    // the thread is reading the photos through them right now
    if (pick.wrap.classList.contains("aloft")) {
      pick.wrap.remove(); // its picture is airborne over the spot it just left
      continue;
    }
    if (!pick.wrap.classList.contains("undrawn")) {
      pick.wrap.style.backgroundImage = `url("${pick.img.src}")`;
    }
    pick.wrap.classList.add("sent");
    const drop = pick.wrap.animate(thumbDrop(), beat);
    const gone = (): void => pick.wrap.remove();
    drop.addEventListener("finish", gone);
    drop.addEventListener("cancel", gone);
  }
}

// The two platform calls behind the small version of a picked photo; photobox.ts
// holds the reason, the device numbers and the arithmetic. createImageBitmap is
// the one decode on this engine that takes the width to decode AT, so the phone
// reads the picture small instead of reading it whole and shrinking it
// afterwards. The canvas is here only because CSS cannot paint an ImageBitmap
// directly, and at 256px the re-encode is a rounding error beside the decode it
// stands in front of.
//
// smallDrawOff latches for the session. An engine that hands back a picture
// wider than the width asked for read the whole thing anyway, and a second full
// decode racing the send's own is precisely what the one-element rule exists to
// prevent, so the first honest answer decides for every pick after it. Painting
// a picture that size on this thread would be the same mistake twice over, so
// that answer is read before anything is drawn.
let smallDrawOff = false;

function smallDrawHost(): SmallDrawHost | null {
  if (smallDrawOff || typeof createImageBitmap !== "function") return null;
  return {
    bitmap: (blob, edge) =>
      createImageBitmap(blob, {
        resizeWidth: edge,
        // the cheapest resample there is: this picture is a stand-in for a
        // couple of seconds and the decode is the whole cost, not the scaling
        resizeQuality: "low",
        // a phone camera writes the picture in the sensor's orientation and the
        // rotation in the file's own metadata. An img honours that; this call is
        // asked to as well, or the square would wear a sideways preview and then
        // snap upright when the real pixels landed.
        imageOrientation: "from-image",
      }),
    paint: (shot: SmallShot): string | null => {
      if (!resizeHonoured(shot, SMALL_SHOT_PX)) {
        smallDrawOff = true;
        holdDiagRecord("flight", {
          phase: "small-off", w: Math.round(shot.width), h: Math.round(shot.height),
        });
        return null; // read whole: this thread is not touching twelve megapixels
      }
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(shot.width));
      c.height = Math.max(1, Math.round(shot.height));
      const ctx = c.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(shot as unknown as ImageBitmap, 0, 0);
      return c.toDataURL("image/jpeg", 0.72);
    },
  };
}

function stagePick(file: File, box: HTMLElement): Pick {
  // TEMP DIAGNOSTIC (pick-timing, picktiming.ts owns the banner): the file's own
  // facts (type, name, byte size) and then a step at each thing this function
  // does with them. Reading those three costs nothing and touches no layout.
  pickTimingFile(file);
  // The small version, asked for BEFORE the full-size element below exists so
  // that the small read is not queued behind the big one it is meant to get in
  // front of. It never rejects, so this promise is safe to hold and join later.
  const small = smallShotUrl(file, smallDrawHost());
  const url = URL.createObjectURL(file);
  pickTimingStep("url"); // TEMP DIAGNOSTIC (pick-timing)
  const wrap = document.createElement("div");
  // undrawn is about the PICTURE now, never the seat: the square is on screen
  // from this line, wearing the same placeholder the thread's unarrived photos
  // wear (styles.css), and only the img inside it is held back
  wrap.className = "pthumb undrawn";
  // ONE element and ONE full decode for this file. It is made here, shown here,
  // and handed to the send exactly as it stands (takeShot), so the phone draws
  // the photo at size once for both places instead of racing two copies of the
  // same work against each other (photobox.ts has the device numbers). The small
  // read above is not a second copy of that work: it is a fraction of it, it
  // never becomes an element, and it is dropped the moment it has been painted.
  const shot = prepareShot(url);
  pickTimingStep("elem"); // TEMP DIAGNOSTIC (pick-timing): src assigned, pixel wait armed
  const img = shot.img;
  const pick: Pick = { url, wrap, img };
  const x = document.createElement("button");
  x.type = "button";
  x.className = "pthumb-x";
  x.textContent = "✕";
  // removed by the file it shows, never by the index it was built at: staged
  // thumbnails outlive their neighbours now, so a captured index goes stale
  x.addEventListener("click", () => {
    const at = pendingFiles.indexOf(file);
    if (at < 0) return; // a second tap while the first one is still easing out
    // TEMP DIAGNOSTIC (blank-thread, blankprobe.ts owns the banner): the
    // before-picture, taken here because everything below this line changes
    // something. It arms nothing unless the conversation was still gliding.
    blankProbeEdge("cancel", performance.now() - lastScrollAt);
    pendingFiles.splice(at, 1);
    refreshSend(); // the ↑ answers the tap; the tray answers over the beat below
    dismissPick(file, pick);
  });
  wrap.append(img, x);
  box.appendChild(wrap); // seated now; renderPending opens the tray around it
  pickTimingStep("seat"); // TEMP DIAGNOSTIC (pick-timing)
  const staged = performance.now();
  // Whichever picture reaches the square first owns the entrance: the small
  // version when the engine made one, and the full decode when it did not. The
  // entrance has always been about the square getting a picture rather than
  // about which decode produced it, and it must play once.
  let filled = false;
  // The small version lands as the square's own BACKGROUND, under an img that is
  // still waiting. Nothing downstream can mistake it for the photo, which is the
  // whole point: .undrawn stays on the wrap until the real pixels arrive, and
  // that is the flag the send morph reads before it will fly (armShotMorph), so
  // a photo whose true shape is not known yet still stands the morph down. The
  // img keeps its full-size blob url and its own natural size for the send. All
  // this does is take the grey face and the ring off the seat and put a picture
  // there instead, a beat after the tap rather than a decode later.
  void small.then((picture) => {
    if (!picture || filled || picks.get(file) !== pick) return; // gone, or already filled
    filled = true;
    wrap.style.backgroundImage = `url("${picture}")`;
    wrap.classList.add("preview");
    wrap.animate(thumbSlide(), { duration: FLIGHT_MS, easing: FLIGHT_EASE });
    // the square's own clock, the same one pick-show carries, stopped at the
    // moment the seat stopped being empty rather than at the full decode
    holdDiagRecord("flight", {
      phase: "pick-preview", ms: Math.round(performance.now() - staged),
    });
  });
  // The picture's arrival, and nothing else's — the same one wait prepareShot
  // already started on this element, joined a second time rather than begun
  // again. The tray and this square went up on the tap, so nothing here is held
  // back and nothing carries a deadline (photobox.ts): waiting a deadline out
  // and uncovering the img anyway would swap a placeholder that says "coming"
  // for an empty frame that says nothing, which is the one thing this tray must
  // not show. A decode that FAILS uncovers the img like any other settle: WebKit
  // rejects the odd large photo that then paints perfectly well, and a square
  // stuck under a spinner forever is the worse of the two wrong answers.
  void shot.drawn.then((why) => {
    // TEMP DIAGNOSTIC (pick-timing, picktiming.ts owns the banner): the pixel
    // wait has settled. Stamped before the early return, because a square that
    // left the tray mid-decode still tells us how long the decode took; the
    // record itself never ships for that pick, since no picture is ever painted.
    pickTimingStep("decode");
    // the photo's own pixel size, handed to the recorder as two plain numbers so
    // that it never touches a node. This re-reads the pair prepareShot's landing
    // read a moment ago rather than plumbing them through: naturalWidth and
    // naturalHeight are the decoded image's own intrinsic values, not layout, so
    // reading them forces nothing and costs nothing measurable.
    const drawnAt = naturalSize(img);
    if (drawnAt) pickTimingDims(drawnAt[0], drawnAt[1]);
    if (picks.get(file) !== pick) return; // removed or sent while it was drawing
    wrap.classList.remove("undrawn");
    pickTimingStep("reveal"); // TEMP DIAGNOSTIC (pick-timing): placeholder off
    pickTimingPainted(); // TEMP DIAGNOSTIC (pick-timing): closes the pick, ships its record
    // the entrance starts on the PICTURE: it moves a square that has one, inside
    // a tray that has been open since the tap. Started on the old deadline
    // instead, it spent its whole beat on an empty box. When a small version
    // already filled the seat this beat has been and gone, and the full pixels
    // swap in behind it with nothing to announce.
    if (!filled) {
      filled = true;
      wrap.animate(thumbSlide(), { duration: FLIGHT_MS, easing: FLIGHT_EASE });
    }
    // ms says what a deadline used to say by settling "late", only better: how
    // long the phone actually took, not merely that it took longer than some
    // number (on device every camera photo did, the one screenshot did not).
    // This one is the SQUARE's clock and stops when the square fills; the
    // pixels' own clock rides shot-dims, which reports whether the photo was
    // still in the tray or already in the thread when they landed.
    holdDiagRecord("flight", {
      phase: "pick-show", why, ms: Math.round(performance.now() - staged),
    });
  });
  return pick;
}

// The send takes the picked file's photo — the very element the tray has been
// drawing since the pick, so nothing is decoded a second time and nothing is
// waited on here — and its blob url with it: the tray must never revoke a url
// the thread has started reading from, so the pick stops owning the url here and
// the send's own tray clear takes the (now empty) thumbnail away as it always
// did. A file that somehow reaches send() unstaged gets its element made on the
// spot, which is the pre-staging behaviour: it enters the thread wearing the
// placeholder and fills in when its pixels land, exactly like a staged one whose
// send outran its tray.
function takeShot(file: File): HTMLImageElement {
  const pick = picks.get(file);
  if (!pick) return prepareShot(URL.createObjectURL(file)).img;
  pick.url = "";
  return pick.img;
}

const threadEl = () => document.getElementById("thread")!;

// --- scrolling: glide when following the tail, chevron when reading history ----

// stick-to-bottom (the WICG chat pattern): while following the tail, EVERY
// late height change — an image decoding, the keyboard shrinking the shell,
// the compose bar growing — re-pins the bottom. Following ends only when the
// user scrolls away (the scroll handler derives it) and resumes at the bottom;
// a moment-of-apply nearBottom() check can't do this, because a tall image
// above the fold pushes the bottom out of its threshold and pinning dies.
// While the composer is FOCUSED, "scrolls away" additionally requires a real
// gesture (viewport.ts followFlipDecision): a caret shove, its snap-back, or
// our own pin writes fire away-reading scroll events too, and letting those
// flip following off is what let each new composer line slip the view a
// little further on device. Every flip is recorded with its trigger.
let followTail = true;

function setFollowTail(next: boolean, trigger: string): void {
  if (next !== followTail) holdDiagRecord("followtail", { to: next, trigger });
  followTail = next;
}

// ===================== TEMP DIAGNOSTIC (remove after the keyboard-fall session) =====================
// The keyboard-close frame probe (shell.ts, block at the bottom) stamps each
// frame with whether the thread was following its tail, because the close
// jitter he sees at the bottom and the yank he sees away from it are the two
// halves of one bug and only this flag tells the runs apart. Read-only, and
// registered the same way the keyboard edge is. TO REMOVE: delete this call.
watchFollowTail(() => followTail);
// =================== END TEMP DIAGNOSTIC (remove after the keyboard-fall session) ===================

// TEMP DIAGNOSTIC (blank-thread, blankprobe.ts owns the banner): every reading
// that probe takes says which way the view was pointing when it took it, and
// the flag lives here. Read-only, registered the same way the line above is.
// TO REMOVE: delete this call.
blankProbeFollow(() => followTail);

// genuine-gesture evidence for the scroll handler: a finger currently on the
// thread, or wheel/pointer/touch activity inside the intent window. Starts
// at -Infinity so a boot-time scroll event can never read as a gesture.
let lastGestureAt = -Infinity;

function userScrollIntent(): boolean {
  return threadTouching || performance.now() - lastGestureAt < USER_SCROLL_INTENT_MS;
}

// Re-establish when the THREAD BOX resizes (keyboard up/down, compose growth,
// the photo drawer's height); content growth inside it re-pins via applyEvent
// and the image onload hooks. This used to re-pin the bottom while following
// and do nothing at all otherwise, which left the one case that shows as white:
// a box that GREW under a scroll position sitting at the old end. Routed
// through the settle, the follow arm is the same instant pin it always was and
// the other arm clamps, so an out-of-range position cannot survive a resize
// whichever way following happens to be pointing.
//
// This is also the only signal that sees every FRAME of a box that changes over
// a beat rather than in one hop: the shell's glide home after a keyboard close
// and the drawer's own height easing both move the edge frame by frame, and the
// observer is delivered on each of those frames, before it paints.
const threadObserver =
  "ResizeObserver" in window
    ? new ResizeObserver(() => settleTail("box", true))
    : null;

// Rows the send flight has in the air, each one translated down toward the
// compose field and each one inflating the thread's scrollHeight by whatever
// part of that translate hangs past the thread's bottom padding. The bar-morph
// leaves nothing here on purpose: its shell is a fixed element in the body and
// the real bubble holds its seat untransformed, so it inflates nothing. Kept as
// the elements themselves rather than a running total because the transforms
// deflate frame by frame and only the live style knows where they are.
const airborneRows = new Set<HTMLElement>();

function flightInflation(t: HTMLElement): number {
  if (airborneRows.size === 0) return 0; // the ordinary case: not one style read
  const pad = parseFloat(getComputedStyle(t).paddingBottom) || 0;
  let most = 0;
  for (const msg of airborneRows) {
    if (!msg.isConnected) continue; // a replay took the seat mid-flight
    const tr = getComputedStyle(msg).transform;
    if (tr === "none") continue;
    most = Math.max(most, flightOverflow(new DOMMatrixReadOnly(tr).f, pad));
  }
  return most;
}

// the one at-bottom reading in the app (viewport.ts explains the window and why
// the flight is subtracted rather than the window widened)
function nearBottom(): boolean {
  const t = threadEl();
  return nearBottomOf(t.scrollHeight, t.scrollTop, t.clientHeight, flightInflation(t));
}

function scrollToBottom(force = false): void {
  const t = threadEl();
  // replay bursts (suppressAnim) jump instantly; live messages glide
  t.scrollTo({ top: t.scrollHeight, behavior: suppressAnim || force ? "auto" : "smooth" });
}

// the jump tap's glide: one rAF-driven ride, full cruise speed while far out,
// settling on a damped spring (downbtn.ts owns the physics)
// — never behavior:"smooth", whose duration scales with distance and
// sails for seconds over a long thread, and never a teleport hop. The live
// bottom and container height are re-read every frame, so content landing
// mid-glide grows the remaining distance and the plan re-opens the throttle,
// still ending exactly at the true bottom; any real gesture on the thread
// (wheel, pointer, touch — the handlers in renderChat) cancels it mid-flight.
let glide: Glide | null = null;
let glideRaf = 0;

function cancelGlide(): void {
  glide?.cancel();
  glide = null;
  if (glideRaf) cancelAnimationFrame(glideRaf);
  glideRaf = 0;
}

// --- the one place the bottom geometry lands ----------------------------------
// "The room under the conversation just changed": the keyboard arriving or
// leaving, the photo drawer opening or collapsing, every in-between frame of
// the box animations those two ride, and the watchdog on the scroller's own
// scroll events. All of them come here, and two things happen in the caller's
// own frame, in this order.
//
// First, whatever scroll the app still has in the air stops counting. A smooth
// scroll aims at a target measured when it was ASKED for, and the engine keeps
// that target across a viewport change: the pin the send flight asks for as it
// lands, asked for while the keyboard was still up, is exactly the write that
// puts the thread past its own end once the keyboard has gone. An instant
// write cancels a smooth one, so the re-establish below IS that cancellation,
// and it is unconditional for that reason even when it lands on the value
// already there. That leans on one thing staying true: nothing in styles.css
// gives the thread a scroll-behavior, so the write below really is instant and
// not the stylesheet's smooth one under another name (scrollToBottom's forced
// pin has always leaned on the same). The app's own animated ride is cancelled
// outright, but only when this pass has real work to do, because that ride
// re-reads the geometry every frame and lands on the true bottom by itself.
//
// Second, the scroll is re-established from numbers read HERE, never from
// anything carried in: pinned to the fresh end while following the tail, and
// only clamped while the reader is up in the history (viewport.ts settleBottom
// owns that rule, and why a reader is never yanked down).
//
// Every caller is a state signal. Nothing here waits on a clock.
let tailGen = 0; // bumped by every settle: a write deferred before it is stale

/** cancel the app's own animated ride; true if one was actually running */
function cancelTailRide(): boolean {
  const riding = glide !== null || glideRaf !== 0;
  cancelGlide();
  return riding;
}

// ===================== TEMP DIAGNOSTIC (remove after the blank-thread session) =====================
// The quiet passes, kept instead of dropped. viewport.ts (createSettleBurst)
// holds the whole reasoning and the arithmetic; this is the clock and the one
// record. A run normally ends because the next settle is a loud one, and the
// photo drawer's close ends on exactly such a settle, so the timer below is a
// backstop for a run whose successor never comes rather than the ordinary
// path. Re-arming it per write costs the clearTimeout/setTimeout pair the
// trail's own upload already re-arms on every record it takes.
// TO REMOVE: this block and the three calls in settleTail.
const tailBurst = createSettleBurst();
let tailBurstTimer: ReturnType<typeof setTimeout> | null = null;

function tailBurstShip(mark: SettleBurstMark | null): void {
  if (mark) holdDiagRecord("tail-settle", mark);
}

function tailBurstClose(): void {
  if (tailBurstTimer) clearTimeout(tailBurstTimer);
  tailBurstTimer = null;
  tailBurstShip(tailBurst.take());
}

function tailBurstFold(via: string, g: BottomGeometry, plan: TailSettle): void {
  tailBurstShip(tailBurst.add(via, g, plan, performance.now()));
  if (tailBurstTimer) clearTimeout(tailBurstTimer);
  tailBurstTimer = setTimeout(tailBurstClose, SETTLE_BURST_GAP_MS + 20);
}
// =================== END TEMP DIAGNOSTIC (remove after the blank-thread session) ===================

/**
 * @param via   the signal that called, as the trail carries it
 * @param quiet a per-frame caller: a pass with nothing of its own to report
 *              folds into its run's summary rather than taking a mark
 *              (viewport.ts createSettleBurst)
 */
function settleTail(via: string, quiet = false): void {
  const t = document.getElementById("thread");
  if (!t) return; // no shell yet, or torn down under a deferred call
  // TEMP DIAGNOSTIC (scroll-jank): the geometry reads force layout and the
  // scroll write follows them, several callers deep in the settle machinery —
  // spanned through the write so a stall over one names the settle logic.
  // TO REMOVE with the scrolljank.ts block: this stamp pair.
  const jankT0 = performance.now();
  tailGen++;
  const g = { sh: t.scrollHeight, st: t.scrollTop, ch: t.clientHeight };
  const plan = settleBottom(g, followTail);
  const cut = plan.moved ? cancelTailRide() : false;
  t.scrollTo({ top: plan.top, behavior: "auto" });
  jankSpan("settle-tail", jankT0); // TEMP DIAGNOSTIC (scroll-jank)
  blankProbeSettle(plan.moved); // TEMP DIAGNOSTIC (blank-thread): a counter, nothing read
  if (!quiet || plan.over > 0 || cut) {
    tailBurstClose(); // TEMP DIAGNOSTIC (blank-thread): the run this pass ended goes first
    holdDiagRecord("tail-settle", settleMark(via, g, plan, cut, flightsUp));
    return;
  }
  tailBurstFold(via, g, plan); // TEMP DIAGNOSTIC (blank-thread): kept, not dropped
}

// The same settle, asked for the other reason: the CONVERSATION changed height,
// rather than the room under it.
//
// Every signal above is a change to the BOX: the keyboard's edges, the photo
// drawer opening and closing, and the thread's own ResizeObserver for each frame
// of a box that eases. A ResizeObserver on the thread watches that box and
// nothing else, so content growing or shrinking inside it fires none of them.
// Growth is harmless on its own: taller content raises the end of the range, so
// a position that was in range stays in range. SHRINKING is the hole. It lowers
// the end of the range under a position already sitting on the old end, and
// Safari hands that position back rather than clamping it, which is the band of
// empty white under the last message this whole area exists to prevent.
//
// The typing dots were the confirmed case: they are appended at the tail, the
// view is pinned to the bottom while they show, and their removal took their
// height out from under a scroll position that nothing then wrote again.
//
// This is a named set of call sites rather than an observer on the content, for
// a structural reason: there is no content element to observe. #thread is both
// the scroller and the flex container, .evt wrappers are display:contents, and
// so every row is a direct flex item of the scroller itself. Giving it an inner
// wrapper to watch would move every row a box down and change what the peek
// transforms, the sibling shift, laidOutRows and the row-width read are all
// looking at, which is a great deal more than this fix. The three sites are the
// three places a whole block leaves the conversation: hideTyping, applyRetract
// and deleteFailed. A gap stamp leaving inside decorate() is the one shrink left
// unnamed, and it is a few pixels that only ever moves while applyEvent or
// rerender is already writing the scroll around it.
//
// The rule is the settle's own, unchanged: pinned to the fresh end while
// following the tail, and only CLAMPED while the reader is up in the history, so
// a reader who has deliberately scrolled up keeps his place and is pulled back
// only when his place no longer exists. The via carries a content- prefix so a
// device session can tell these from the box signals at a glance.
function settleContent(what: string): void {
  settleTail(`content-${what}`);
}

// The other half of the scroll's ownership, and the opposite case to the one
// above. settleTail is for the room UNDER the conversation changing, where the
// answer is to re-establish the end of the range. This is for a row INSIDE the
// conversation changing height, where the answer is the reverse: leave the
// range alone and move the position, by exactly what the change cost, so the
// content the reader is looking at does not move by a single pixel.
//
// It only matters because this is an inner scroller on iOS, where the browser
// anchors nothing (photofit.ts has the full reason). A photo four screens back
// finishing its decode grows its row, every row below it slides down by that
// much, and the reader watching a message near the top of his screen sees the
// whole screen walk. That is the jank he reported while scrolling photo
// history, and the recorder that went looking for it found the main thread
// idle and the frame rate steady, which is exactly what a layout shift looks
// like from inside a frame timer.
//
// Both reads happen either side of the change with no paint in between, so
// they describe one frame: the box's bottom edge as it stood, and the height it
// gained. photofit.ts decides whether that change is one the reader could feel,
// and answers zero while the view is following the tail, where the settle above
// already owns the position.
function keepView(row: HTMLElement, change: () => void): void {
  const t = document.getElementById("thread");
  if (!t) {
    change();
    return;
  }
  const fold = t.getBoundingClientRect().top; // the reader's top edge
  const before = row.getBoundingClientRect();
  change();
  const fix = scrollFix(before.bottom, fold, row.getBoundingClientRect().height - before.height,
    followTail);
  if (fix === 0) return;
  t.scrollTop += fix; // same frame as the change, so the two paint as one
  holdDiagRecord("keep-view", {
    fix: Math.round(fix), bot: Math.round(before.bottom), fold: Math.round(fold),
  });
}

function startGlide(): void {
  cancelGlide();
  const run = createGlide(performance.now());
  glide = run;
  // float cursor: the DOM rounds scrollTop writes, and the brake's shrinking
  // steps would round away to a stall — the fractional position lives here
  let pos = threadEl().scrollTop;
  const step = (now: number): void => {
    const t = document.getElementById("thread");
    if (!t || run.cancelled()) return; // shell torn down, or a gesture took over
    pos += run.step(now, t.scrollHeight - t.clientHeight - pos, t.clientHeight);
    t.scrollTop = pos;
    if (run.done()) {
      glide = null;
      glideRaf = 0;
      return;
    }
    glideRaf = requestAnimationFrame(step);
  };
  glideRaf = requestAnimationFrame(step);
}

// The one-frame opacity blink that makes iOS skip its caret-reveal scroll (the
// verified ios-chat/kiding mechanism; styles.css focus-blink runs the same
// thing off :focus). Driven through WAAPI so re-triggering it never touches
// that :focus animation (flyFromField leans on the same WebKit property), and
// the previous blink is cancelled first so fast typing stacks nothing.
let composerBlink: Animation | null = null;

function blinkComposer(el: HTMLElement): void {
  composerBlink?.cancel();
  composerBlink = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 20 });
}

// compose grows with content like iMessage (1 -> ~5 lines, then inner scroll)
// and collapses on send. Every such resize moves the thread's bottom edge, so
// the compensation happens HERE, synchronously between the height write and
// this frame's paint — viewport.ts decides. Waiting for the threadObserver
// alone painted the slipped frame first (the visible bounce), and mid-history
// nothing compensated at all. At the tail this pins instantly, so the
// observer's later scrollToBottom(true) hits an already-correct scrollTop and
// moves nothing; a mid-history GROWTH hands back exactly the pixels the bar
// took, so the newest message is never left under it; atBottom is read BEFORE
// the resize, while the distance to the bottom still means what the user last
// saw. `typed` marks the keystroke path (the input handler) apart from the
// re-derives that share this function (a width change, the send collapse).
function autosize(typed = false): void {
  const textEl = document.getElementById("text") as HTMLTextAreaElement | null;
  if (!textEl) return;
  const t = threadEl();
  const nb = nearBottom();
  const atBottom = followTail || nb;
  // The height is measured on an off-screen twin (mirror.ts), never by
  // collapsing the live box. The bar and the thread split one fixed column, so
  // collapsing the box hands the thread those pixels for the length of one
  // forced layout, and the engine clamps the thread's offset into the smaller
  // range that leaves. A keystroke that changes no height takes no repair
  // branch below, so that clamp used to stand: the reported jump, one
  // keystroke after every new line. The twin means the live box's height never
  // dips, so there is nothing to clamp. The save and restore inside the fit
  // (shell.ts guards its own forced reflow the same way) is the second guard
  // behind that, and it also keeps the give-up branch below honest: it used to
  // compensate from an already-clamped position and so landed low by the clamp.
  // 120px is the five-line cap, the same one styles.css puts on the element.
  const fit = fitComposeBox(textEl, composeMirror(textEl), t, 120);
  const oldHeight = fit.oldHeight;
  const newHeight = fit.newHeight;
  // publish the pill's live height: the jump chevron seats itself off it
  // (styles.css .jump), so it clears the box at one line and at the five-line
  // cap alike instead of off a written-down single-line constant. The pill is
  // the textarea's parent and carries no padding or border of its own, so this
  // read costs nothing beyond the reflow the fit above already forced. The
  // twin hangs in that same pill but is out of its flex flow, so it adds
  // nothing to this number.
  const pill = textEl.parentElement;
  if (pill) app.style.setProperty("--field-h", `${pill.offsetHeight}px`);
  // EVERY keystroke hands iOS a caret to reveal, and it scrolls the whole page
  // one step to do it (the typing-test shove: vv.offsetTop 362 -> 412, 412px
  // piled up by close). Blinking only on GROWTH protected the first character
  // of each line and nothing after it, and stopped protecting anything at all
  // once the box hit its 120px cap around the fifth line, where the height
  // never changes again: exactly his report. So while the keyboard is up every
  // keystroke blinks, and a growth still blinks even before .kb has latched
  // (the focusing window's first line). Composer focus is required either way:
  // the reveal is a focus behavior.
  const grew = newHeight > oldHeight;
  const kbUp = app.classList.contains("kb");
  if (document.activeElement === textEl && (grew || (typed && kbUp))) {
    blinkComposer(textEl);
    holdDiagRecord("grow-blink", {
      why: grew ? "grow" : "key", oldH: oldHeight, newH: newHeight, kb: kbUp,
    });
  }
  const decision = compensationFor(oldHeight, newHeight, atBottom);
  if (decision === "pin-bottom") {
    scrollToBottom(true); // instant: the resize and the re-pin paint as one
  } else if (decision === "give-up") {
    // the thread yields exactly the height the bar gained, in the same frame:
    // its box just shrank from the bottom, so without this the line that sat
    // on that edge (the message he just sent) is clipped away under the bar
    t.scrollTop = giveUpTarget(t.scrollTop, oldHeight, newHeight, t.scrollHeight - t.clientHeight);
  }
  // TEMP DIAGNOSTIC field stM: the thread's position read the instant the
  // height landed, before the fit put it back. Measured on the twin it must
  // equal stB on every record, so a device session proves the jump is gone
  // instead of leaving us to argue about it; an stM below stB means the twin
  // was not there and the collapse path ran.
  holdDiagRecord("autosize", {
    oldH: oldHeight, newH: newHeight, ft: followTail, nb, atB: atBottom,
    dec: decision, stB: Math.round(fit.scrollBefore), stM: Math.round(fit.scrollMid),
    stA: Math.round(t.scrollTop),
  });
  // no shell work here: the bar and the thread split a shell box that only
  // the visual viewport sizes (shell.ts), so composer growth is pure
  // shell-internal layout: the scroll write above is the whole compensation
}

// --- rendering ---------------------------------------------------------------

// iMessage clustering: consecutive same-sender bubbles inside RUN_GAP_MS form a
// run — continuations tighten spacing and the sender-side top corner. System
// lines break runs. Runs and gap stamps are DERIVED from the ordered store by
// decorate() — no mutable tracking, so pagination and out-of-order inserts
// need no save/restore dance.
const RUN_GAP_MS = 60_000;
const STAMP_GAP_MS = 60 * 60_000;

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function fmtStampDay(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString([], { weekday: "long" });
  return d.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

// entrance animation + smooth scroll are for LIVE messages only; a reconnect
// replaying fifty bubbles must not pop each one
let suppressAnim = true;

// Each event renders into one .evt wrapper (display: contents — invisible to
// the thread's flex layout, so rows/stamps stay direct flex items visually).
// The wrapper is the unit of ordering (data-seq), idempotent re-render, and
// removal; optimistic send bubbles are unkeyed wrappers at the tail until ACK.

function eventWrappers(): HTMLElement[] {
  return Array.from(threadEl().querySelectorAll<HTMLElement>(".evt"));
}

function wrapperFor(seq: number): HTMLElement | null {
  return threadEl().querySelector<HTMLElement>(`.evt[data-seq="${seq}"]`);
}

function rowEl(wrapper: HTMLElement, role: string, cls: string, at: number): HTMLDivElement {
  // each bubble sits in a full-width .row so the peek-time label can pin to
  // the screen's right edge (clipped by the thread until the pull reveals it)
  const row = document.createElement("div");
  row.className = `row ${role}`;
  if (role !== "system") row.dataset.time = fmtTime(at);
  const div = document.createElement("div");
  div.className = `msg ${role} ${cls}${suppressAnim ? "" : " anim"}`;
  row.appendChild(div);
  wrapper.appendChild(row);
  return div;
}

// decorate(): one pure fold over the rendered wrappers in DOM order — sets
// run-continuation classes and owns the gap stamps. Same result no matter what
// order events arrived in.
function decorate(): void {
  // TEMP DIAGNOSTIC (scroll-jank): the fold walks EVERY wrapper and applyEvent
  // runs it once per applied frame, so a history page pays it twenty-five
  // times over a growing thread — spanned per call, so a stall carrying many
  // of these names the pass itself as the weight. TO REMOVE with the
  // scrolljank.ts block: this stamp pair.
  const jankT0 = performance.now();
  let prevSide: string | null = null;
  let prevAt = 0;
  let lastStampAt = 0;
  for (const w of eventWrappers()) {
    const rows = Array.from(w.querySelectorAll<HTMLElement>(":scope > .row"));
    if (!rows.length) {
      w.querySelector(":scope > .stamp")?.remove(); // event renders nothing
      continue;
    }
    const at = Number(w.dataset.ts || 0);
    const role = w.dataset.role ?? "agent";
    // gap stamp: shown when >1h since the previous stamp, owned by the wrapper
    let stamp = w.querySelector<HTMLElement>(":scope > .stamp");
    if (at - lastStampAt > STAMP_GAP_MS) {
      const born = stamp === null;
      if (!stamp) {
        stamp = document.createElement("div");
        stamp.className = "stamp";
      }
      const day = document.createElement("b");
      day.textContent = fmtStampDay(at);
      stamp.replaceChildren(day, ` ${fmtTime(at)}`);
      w.prepend(stamp);
      // a stamp born on a LIVE arrival enters like the bubble it rides above
      // (the .anim row): the same fade-up the send path gives its newborn
      // stamp, so a reply that opens a new hour never pops. Replay, history
      // pages, and rerenders run under suppressAnim and render no .anim rows,
      // so they stay static — the bootgate rules hold untouched. The send
      // path's own wrapper renders suppressed (no .anim), so its stamp is
      // entered once, by shift play, never here.
      if (born && !suppressAnim && w.querySelector(".msg.anim")) {
        enterNewborn(stamp);
        holdDiagRecord("flight", { phase: "enter", n: 1, src: "live" });
      }
      lastStampAt = at;
    } else {
      stamp?.remove();
    }
    for (const row of rows) {
      const cont =
        (role === "user" || role === "agent") && role === prevSide && at - prevAt < RUN_GAP_MS;
      row.classList.toggle("cont", cont);
      prevSide = role === "system" ? null : role;
      prevAt = at;
    }
  }
  jankSpan("decorate", jankT0); // TEMP DIAGNOSTIC (scroll-jank)
}

// applyEvent(): THE one path every keyed frame takes — live push, reconnect
// replay, and older history pages alike. Idempotent by seq, ordered by seq.
function applyEvent(m: ServerMsg): void {
  const seq = m.seq;
  if (!seq) return;
  if (store.has(seq)) {
    // a duplicate delivery no-ops UNLESS it is richer: the server heals photo
    // rows on read, so a re-delivery can carry the attachment fields a frame
    // stored before they shipped is missing (enrich.ts holds the rule)
    enrichStored(m);
    return;
  }
  const prevMax = lastSeq;
  store.set(seq, m);
  if (seq > lastSeq) lastSeq = seq;
  if (oldestSeq === 0 || seq < oldestSeq) oldestSeq = seq;
  const isTail = prevMax === 0 || seq > prevMax;

  if (isTail && m.role !== "user" && m.kind !== "job") hideTyping(); // a bubble replaces the dots
  const wrapper = document.createElement("div");
  wrapper.className = "evt";
  wrapper.dataset.seq = String(seq);
  renderInto(wrapper, m);
  // insert in seq order among keyed wrappers; a tail seq lands at the absolute
  // end so in-flight optimistic (unkeyed) bubbles keep their place above it
  const next = eventWrappers().find((w) => w.dataset.seq && Number(w.dataset.seq) > seq);
  if (next) threadEl().insertBefore(wrapper, next);
  else {
    // restored failed bubbles (a prior session's unsent sends) sit at the very
    // tail; a keyed frame that would append past them slots in just above them,
    // so replayed history and live events never land beneath an old failure
    const restored = threadEl().querySelector<HTMLElement>(".evt.restored");
    if (restored) threadEl().insertBefore(wrapper, restored);
    else threadEl().appendChild(wrapper);
    // live dots stay below the newest content: a user frame landing during
    // them (agent replies removed them above) moves them back behind it,
    // same frame, a plain structural reorder (dots.ts)
    moveTypingAfter(threadEl(), wrapper);
  }
  decorate();
  // pinned-viewport handling for older pages lives in loadOlder; only tail
  // applies drive the scroll rule (the chevron is scroll-pause-only, downbtn.ts)
  if (isTail && wrapper.childElementCount > 0) {
    if (m.role === "user") setFollowTail(true, "apply-user"); // your own message snaps you back
    if (followTail) scrollToBottom();
  }
  if (m.kind === "published") flipCorrelatedPr(m);
  updateReceipt(); // any event can move the watermark (user row, job row, working)
  cacheWrites.bump(); // the cold-open snapshot trails every applied frame, debounced
}

// Store-only repair for a re-delivered seq: adopt whatever meaningful fields
// the stored frame lacks (enrich.ts decides; identical or poorer copies
// change nothing). Deliberately no DOM re-render: this session already drew
// the frame from what it had, and the point is the cold-open snapshot the
// next boot paints from. True when the store changed.
function enrichStored(m: ServerMsg): boolean {
  const seq = m.seq;
  if (!seq) return false;
  const cur = store.get(seq);
  if (!cur) return false;
  const merged = enrichFrame(cur, m);
  if (!merged) return false;
  store.set(seq, merged);
  cacheWrites.bump(); // the repaired frame must reach the snapshot
  return true;
}

// re-render one event's wrapper in place (e.g. its pr button state changed)
function rerender(seq: number): void {
  const w = wrapperFor(seq);
  const m = store.get(seq);
  if (!w || !m) return;
  const prevSuppress = suppressAnim;
  suppressAnim = true; // a state flip must not replay the entrance pop
  w.replaceChildren();
  renderInto(w, m);
  suppressAnim = prevSuppress;
  decorate();
}

function prUrl(payload: unknown): string | null {
  // live pr events carry {branch, url}; the migration parsed legacy JSON-in-body
  // rows into the same shape, so a bare-url string is the only other real case
  if (payload && typeof payload === "object" && "url" in payload) {
    return String((payload as { url: unknown }).url);
  }
  if (typeof payload === "string" && payload.startsWith("http")) return payload;
  return null;
}

function thumbUrl(key: string): string {
  return `/api/thumb/${encodeURIComponent(key)}?token=${encodeURIComponent(token)}`;
}

// --- history photos load when the reader nears them (photolazy.ts) ------------
// The ledger parks each history photo's url; this is the proximity signal that
// releases it. The root is the THREAD, not the window: the thread is the only
// thing that scrolls here, so a window-rooted observer (or the browser's own
// loading="lazy" heuristic, which reads the viewport) would answer about the
// wrong box. The reach is named and explicit: one screen of the thread's own
// height, applied above and below, so a photo starts loading about a screen
// before it reaches the eye whichever way the reader is going. Horizontal
// margin stays 0; nothing scrolls sideways.
//
// One observer per shell, rebuilt in renderChat because the root element is
// rebuilt there and the margin is measured from the fresh box. Each photo is
// released exactly once and then dropped from the observer: a photo that has
// its pixels can never need them again.
let photoObserver: IntersectionObserver | null = null;

const photoQueue = createPhotoQueue<HTMLImageElement>(
  "IntersectionObserver" in window ? (img) => photoObserver?.observe(img) : null,
);

function watchPhotos(thread: HTMLElement): void {
  photoObserver?.disconnect(); // the old shell's photos died with its DOM
  photoQueue.reset();
  if (!("IntersectionObserver" in window)) return; // every photo loads eagerly instead
  const margin = nearMargin(thread.clientHeight || window.innerHeight);
  photoObserver = new IntersectionObserver(
    (entries, obs) => {
      // TEMP DIAGNOSTIC (scroll-jank): a scroll-back sweeps whole batches of
      // parked photos into reach at once, and each release puts a source on
      // the wire — spanned per batch, stamped only when one actually
      // released. TO REMOVE with the scrolljank.ts block: this stamp pair.
      const jankT0 = performance.now();
      let released = 0;
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        obs.unobserve(e.target);
        if (photoQueue.release(e.target as HTMLImageElement)) released += 1;
      }
      if (released > 0) jankSpan("photo-release", jankT0); // TEMP DIAGNOSTIC (scroll-jank)
    },
    { root: thread, rootMargin: `${margin}px 0px` },
  );
}

// --- tap-to-zoom: the photo grows out of its spot and shrinks back into it ----
// The lightbox copy launches from the tapped photo's exact box and corner
// radius and flies to the fitted centered box zoom.ts computes, which it then
// KEEPS: the resting size has exactly one source, and a resize while the photo
// is open re-runs that same source rather than letting a second one in (the
// copy's own note at restBox below has the whole story), the backdrop fading in
// alongside. The geometry is real box
// interpolation on the send-flight's beat and ease, driven per rAF frame like
// the send morph (morphBox/flightEase — never transform scale, which would
// squash the corner circles). The thread photo hides beneath the copy for the
// whole zoom — two identical images a frame apart read as a doubling — and is
// handed back byte-clean as the copy lands home. The copy also inherits the
// photo's own cut: the thread paints nothing outside its scrolling box, so a
// photo half behind the top bar or the compose bar ends at that edge, and the
// copy is clipped to the same box, opening over the flight only as far as the
// resting frame genuinely needs. Dismissal re-reads the photo's rect at that
// moment: the thread may have scrolled or gained rows while zoomed, and the
// copy must land where the photo IS. A spot scrolled off-screen gets the edge
// return (shrink toward its direction while fading); a spot whose row is gone
// gets the center fade (zoom.ts decides). Records ride the flight channel like
// every other motion.
function openLightbox(src: string, from?: HTMLImageElement): void {
  if (document.querySelector(".lightbox")) return; // a double-tap must not stack overlays
  const overlay = document.createElement("div");
  overlay.className = "lightbox";
  const back = document.createElement("div");
  back.className = "lightbox-back";
  overlay.appendChild(back);
  const img = document.createElement("img");
  img.src = src;
  overlay.appendChild(img);
  document.body.appendChild(overlay);
  if (!from?.naturalWidth) {
    // nothing decoded to grow from (a not-yet-loaded optimistic blob): the
    // plain overlay, instant both ways
    overlay.addEventListener("click", () => overlay.remove());
    return;
  }
  const boxOf = (r: DOMRect): MorphBox => ({
    left: r.left, top: r.top, width: r.width, height: r.height,
  });
  const writeBox = (b: MorphBox): void => {
    img.style.left = `${b.left}px`;
    img.style.top = `${b.top}px`;
    img.style.width = `${b.width}px`;
    img.style.height = `${b.height}px`;
  };
  // The copy is cut where the real photo is cut (zoom.ts explains the rule):
  // the thread is its own scrolling box, so a photo half behind the top bar or
  // the compose bar ends at that box's edge, while the copy is a sheet over the
  // whole screen and would paint across the bar unless it is cut to match. The
  // cut travels with the flight — thread box at the thread end, and at the open
  // end the tightest rect the resting frame actually needs (zoomClipRest, which
  // carries the whole argument) rather than the whole screen. Only the copy is
  // ever cut: the backdrop and the resting photo still cover both bars.
  const clipper = from.closest(".thread"); // where the photo's own cut comes from
  const screenBox = (): MorphBox => ({
    left: 0, top: 0, width: window.innerWidth, height: window.innerHeight,
  });
  const threadBox = (): MorphBox =>
    clipper ? boxOf(clipper.getBoundingClientRect()) : screenBox();
  const writeClip = (b: MorphBox, clip: MorphBox): void => {
    const i = zoomClipInset(b, clip);
    if (!zoomClipCuts(i)) {
      img.style.removeProperty("clip-path"); // nothing to cut: no cut at all
      return;
    }
    img.style.clipPath = `inset(${i.top.toFixed(1)}px ${i.right.toFixed(1)}px ` +
      `${i.bottom.toFixed(1)}px ${i.left.toFixed(1)}px)`;
  };
  // the copy owns its geometry while airborne: absolute in the overlay's
  // fixed box (viewport coordinates), the resting max-* fit released so the
  // interpolated box is never clamped mid-flight (a tall screenshot's height
  // crosses 92vh on the way in)
  const freeze = (b: MorphBox, radius: number, clip: MorphBox): void => {
    img.style.position = "absolute";
    img.style.maxWidth = "none";
    img.style.maxHeight = "none";
    writeBox(b);
    img.style.borderRadius = `${radius.toFixed(1)}px`;
    writeClip(b, clip); // the launch frame is cut before it ever paints
  };
  let raf = 0;
  // the send morph's driver shape (armFieldMorph): eased box and corner
  // writes per frame, fades riding the clock, and the landed frame painting
  // once BEFORE the settle so the swap can never read as a snap
  const fly = (
    a: MorphBox, b: MorphBox, rA: number, rB: number, cA: MorphBox, cB: MorphBox,
    fade: (f: number) => void, settle: () => void,
  ): void => {
    if (raf) cancelAnimationFrame(raf);
    const t0 = performance.now();
    const step = (now: number): void => {
      raf = 0;
      const f = Math.min((now - t0) / FLIGHT_MS, 1);
      const p = flightEase(f);
      const box = morphBox(a, b, p);
      writeBox(box);
      img.style.borderRadius = `${morphCorners(rA, [rB], p)[0].toFixed(1)}px`;
      writeClip(box, morphBox(cA, cB, p)); // the cut rides the same beat and ease
      fade(f);
      if (f < 1) raf = requestAnimationFrame(step);
      else raf = requestAnimationFrame(settle);
    };
    raf = requestAnimationFrame(step);
  };
  const fromBox = boxOf(from.getBoundingClientRect());
  const fromRadius = parseFloat(getComputedStyle(from).borderTopLeftRadius) || 0;
  const restRadius = parseFloat(getComputedStyle(img).borderTopLeftRadius) || 0;
  // THE one source of the resting size. It used to be two: this fit, off
  // window.innerWidth/innerHeight, and the css max-width 96vw / max-height 92vh
  // the copy fell back to when the landing frame dropped its inline style. The
  // width halves agree; the height halves need not, because innerHeight shrinks
  // with the keyboard in two of iOS 26's three modes and can stay stuck short
  // after it (shell.ts) while vh keeps measuring the full screen. A portrait
  // photo is the one whose fit flips from the width term to the height term
  // when they part, which is why portrait alone resized on that frame and
  // landscape never did. The flight's landed box now simply STANDS: the inline
  // geometry is never dropped, so the css rule (still the sizing for an
  // undecoded copy, which never flies) can never re-fit a flown one, and the
  // close leg's rect read is that same landed box.
  const restBox = (): MorphBox =>
    zoomFit(from.naturalWidth, from.naturalHeight, window.innerWidth, window.innerHeight);
  const to = restBox();
  // A box that stands has to be re-aimed by hand when the viewport moves, so a
  // rotation or any other resize re-runs that same one source while the copy is
  // at rest. Never mid-flight: a flight owns its own frames.
  let atRest = false;
  const refit = (): void => {
    if (!atRest) return;
    const b = restBox();
    writeBox(b);
    writeClip(b, zoomClipRest(threadBox(), b)); // re-measured with it, and cuts nothing
  };
  window.addEventListener("resize", refit);
  // TEMP DIAGNOSTIC (hold.ts trail, flight channel): the two resting sizes side
  // by side on the landing frame. One is what the flight stands on, off
  // innerWidth/innerHeight; the other is what the css max-* rule would have
  // re-fitted to, off a live measurement of the 100vw/100vh those percentages
  // resolve against. A device session shows in the deploy log whether the pair
  // ever parts and by how much, instead of the question being argued.
  const restDiag = (b: MorphBox): void => {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;" +
      "visibility:hidden;pointer-events:none";
    document.body.appendChild(probe);
    const unit = probe.getBoundingClientRect();
    probe.remove();
    const css = zoomFit(from.naturalWidth, from.naturalHeight, unit.width, unit.height);
    holdDiagRecord("flight", {
      phase: "zoom-rest",
      iw: Math.round(window.innerWidth), ih: Math.round(window.innerHeight),
      vw: Math.round(unit.width), vh: Math.round(unit.height),
      w: Math.round(b.width), h: Math.round(b.height),
      cssW: Math.round(css.width), cssH: Math.round(css.height),
    });
  };
  const openFrom = threadBox(); // measured with the box reads above, before any write
  freeze(fromBox, fromRadius, openFrom);
  back.style.opacity = "0";
  from.style.opacity = "0"; // the copy IS the photo until it lands back home
  holdDiagRecord("flight", {
    phase: "zoom-open",
    dx: Math.round((to.left - fromBox.left) * 10) / 10,
    dy: Math.round((to.top - fromBox.top) * 10) / 10,
    dw: Math.round(to.width - fromBox.width),
    dh: Math.round(to.height - fromBox.height),
  });
  // the cut opens only as far as the landed frame needs, not to the whole
  // screen: for a photo whose fit lands inside the thread that is the thread's
  // own box the whole way, so the copy never paints on a bar it has not reached
  fly(fromBox, to, fromRadius, restRadius, openFrom, zoomClipRest(openFrom, to), (f) => {
    back.style.opacity = String(f);
  }, () => {
    // The landed geometry stands. Only the backdrop hands itself back to css;
    // the copy keeps the box the flight wrote, so nothing gets a second say on
    // this frame. The refit answers a viewport that moved DURING the flight,
    // out of that same one source, and is a no-op when it did not.
    back.removeAttribute("style");
    atRest = true;
    refit();
    restDiag(restBox()); // the box that now stands, re-read from the one source
  });
  let closing = false;
  overlay.addEventListener("click", () => {
    if (closing) return;
    closing = true;
    atRest = false; // the close flight owns the geometry from here, not the refit
    // the spot is re-read NOW, not remembered from the open
    const origin = from.isConnected ? boxOf(from.getBoundingClientRect()) : null;
    const cur = boxOf(img.getBoundingClientRect());
    const ret = zoomReturn(origin, cur, window.innerWidth, window.innerHeight);
    const curRadius = parseFloat(getComputedStyle(img).borderTopLeftRadius) || 0;
    const endRadius = ret.mode === "exact"
      ? parseFloat(getComputedStyle(from).borderTopLeftRadius) || 0
      : curRadius;
    const back0 = back.style.opacity ? parseFloat(back.style.opacity) : 1;
    // The cut closes back onto the thread's box, so the landed frame is cut
    // exactly like the photo it uncovers and the handover moves no pixel. It
    // STARTS at the tightest rect that hides nothing of the copy where it is
    // right now (zoom.ts carries the argument): starting at the whole screen
    // was what let a band of photo sit on both bars for most of the way back,
    // since a cut riding this ease only reaches the thread's box on the last
    // frame while the copy's own edge crosses the bar's edge far earlier. Like
    // the spot it flies to, the cut is decided here from what is on screen now
    // rather than remembered from the open. The other two modes have no photo to
    // land on and dissolve on their way out of the screen, so both ends of their
    // cut stay the whole screen and the exit is the one it always was.
    const clipFrom = ret.mode === "exact" ? zoomClipRest(threadBox(), cur) : screenBox();
    const clipTo = ret.mode === "exact" ? threadBox() : screenBox();
    freeze(cur, curRadius, clipFrom); // a mid-open tap turns home from wherever the copy is
    holdDiagRecord("flight", {
      phase: "zoom-close",
      mode: ret.mode,
      dx: Math.round((ret.box.left - cur.left) * 10) / 10,
      dy: Math.round((ret.box.top - cur.top) * 10) / 10,
      dw: Math.round(ret.box.width - cur.width),
      dh: Math.round(ret.box.height - cur.height),
    });
    fly(cur, ret.box, curRadius, endRadius, clipFrom, clipTo, (f) => {
      back.style.opacity = String(back0 * (1 - f));
      if (ret.mode !== "exact") img.style.opacity = String(1 - f); // no spot to land on: dissolve
    }, () => {
      // the landed copy painted exactly over the photo once; now, one task:
      // the photo back, the copy gone — no frame holds both, none holds neither
      window.removeEventListener("resize", refit); // nothing left to re-aim
      from.style.removeProperty("opacity");
      if (!from.getAttribute("style")) from.removeAttribute("style");
      overlay.remove();
    });
  });
}

// --- pr ↔ published correlation (Publish button state survives replay) --------

function prNumber(payload: unknown): number | null {
  const url = prUrl(payload);
  const m = url?.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
}

function publishedNumber(m: ServerMsg): number | null {
  if (m.kind !== "published" || typeof m.payload !== "string") return null;
  const hit = m.payload.match(/#(\d+)/);
  return hit ? Number(hit[1]) : null;
}

function isPublished(num: number | null): boolean {
  if (num === null) return false;
  for (const m of store.values()) if (publishedNumber(m) === num) return true;
  return false;
}

// a published event resolving an already-rendered pr bubble flips its button
function flipCorrelatedPr(published: ServerMsg): void {
  const num = publishedNumber(published);
  if (num === null) return;
  for (const [seq, m] of store) {
    if (m.kind === "pr" && prNumber(m.payload) === num) rerender(seq);
  }
}

// consecutive-duplicate agent text (log/done) is display noise — derived from
// the store predecessor, superseding the old lastAgentText mutable global.
// Also hides the deploy-overlap double-persist case (same text, two seqs).
function isDuplicateAgentText(seq: number, text: string): boolean {
  const seqs = Array.from(store.keys()).sort((a, b) => a - b);
  for (let i = seqs.indexOf(seq) - 1; i >= 0; i--) {
    const prev = store.get(seqs[i])!;
    if (prev.role === "user") return false; // a user turn resets the run
    const prevText = typeof prev.payload === "string" ? prev.payload.trim() : "";
    if (prev.role === "agent" && (prev.kind === "log" || prev.kind === "done") && prevText) {
      return prevText === text;
    }
  }
  return false;
}

// --- per-kind renderers: DOM = pure projection of one stored event -------------

type Renderer = (m: ServerMsg, wrapper: HTMLElement, at: number, value: string) => void;

// The blurred picture a photo wears while its real pixels are still coming:
// the server's ~28-character blurhash (blurhash.ts) painted into a data uri
// that the stylesheet stretches over the box already reserved for the photo.
//
// Small on purpose. The hash holds nothing but the lowest frequencies of the
// picture, so 32 square is everything there is in one, and decoding at the
// photo's real size would be a few hundred times the work for pixels nobody
// could tell apart. The square is not a compromise on shape either: a decoded
// pixel's colour depends only on how far across and down the picture it sits,
// never on the shape of the grid, so a square stretched over the reserved box
// shows exactly the picture a box-shaped decode would have.
//
// Null when there is nothing to paint, which the caller reads as "leave the
// grey face alone". Null hashes, a canvas this browser will not give a 2d
// context for, and anything malformed all land there.
//
// Nothing in here can put a raw hash into the stylesheet. base83 carries
// characters CSS would read as syntax, so what comes back is a base64 png and
// only ever a base64 png, quoted into the url() at the call below.
//
// Kept between renders because a re-render rebuilds every row it touches, and a
// thread of photos re-decoding wholesale is the one place this could be felt.
// The cap is there because the row's own inline style already holds a copy of
// each string, so an unbounded map would be a second copy of every photo ever
// scrolled past. Dropped wholesale rather than one at a time: this is a memo,
// not a store, and losing it costs a fraction of a millisecond per photo.
const BLUR_FACE_CAP = 200; // far more photos than one screen, or one cached thread, holds
const blurFaces = new Map<string, string | null>(); // one decode per distinct hash

function blurFace(hash: string | null | undefined): string | null {
  if (typeof hash !== "string" || !hash) return null;
  const cached = blurFaces.get(hash);
  if (cached !== undefined) return cached;
  if (blurFaces.size >= BLUR_FACE_CAP) blurFaces.clear();
  let uri: string | null = null;
  const pixels = decodeBlurhash(hash, BLUR_EDGE, BLUR_EDGE);
  if (pixels) {
    const canvas = document.createElement("canvas");
    canvas.width = BLUR_EDGE;
    canvas.height = BLUR_EDGE;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const face = ctx.createImageData(BLUR_EDGE, BLUR_EDGE);
      face.data.set(pixels);
      ctx.putImageData(face, 0, 0);
      uri = canvas.toDataURL();
    }
  }
  blurFaces.set(hash, uri);
  return uri;
}

function renderUser(m: ServerMsg, wrapper: HTMLElement, at: number, value: string): void {
  // photos render as their own frameless bubbles (same shape as the send
  // echo); pre-thumbnail history 404s and falls back to the old chip
  (m.attachments ?? []).forEach((key, i) => {
    const div = rowEl(wrapper, "user", "shot", at);
    const img = document.createElement("img");
    // reserve the box BEFORE any pixels arrive: an unsized image is 0-tall
    // until decode, and its late growth shoves the scroll position (the
    // residual history-landing jump). Server sends each thumb's real size.
    //
    // The 4:3 branch below is the squish: a portrait photo dropped into a
    // landscape frame because the client had to guess. It is not a legacy
    // branch any more. The server measures a preview it has never measured
    // before on first read and stores what it finds, so a photo arrives here
    // without a size only when its stored bytes will not decode at all, in
    // which case no pixels are ever coming and the guessed frame is a box for
    // a placeholder rather than a box for a photo. Same condition sends a null
    // blurhash, so that box keeps the flat grey face. The synthesized ACK frame
    // a send writes reaches here without dims too, until the healed re-delivery
    // catches up with it. Kept, not deleted: the guess is still the only thing
    // standing between an undecodable photo and a 0-tall row that shoves the
    // scroll under the reader.
    //
    // Either way the box is decided HERE and only here, and it holds for this
    // whole render. The known branch lays the photo out at its own size and the
    // arriving pixels agree with it. The guessed branch pins an explicit ratio,
    // which is not the natural one, so the arriving pixels have no say in it
    // either. The only thing that can reshape either box is adoptPhotoBox on the
    // load below, deliberately, once, and paying the scroll back as it goes.
    const dims = m.attachment_dims?.[i];
    const guessed = !dims; // this render has to invent the box, and say so later
    if (dims) {
      img.width = dims[0];
      img.height = dims[1];
      // TEMP DIAGNOSTIC (sized-box, marked at sizedSeen): the twin of the record
      // below, and the only thing that makes its silence mean anything. A whole
      // scroll back through the history produced not one guess, which reads
      // either as every photo knowing its own size or as no photo having been
      // drawn at all, and nothing then distinguished the two. This branch
      // counting as well settles it: both silent means the photos never came
      // past, this one alone means the guess is not what reshapes them and the
      // shift he sees comes from somewhere else entirely.
      const known = `${m.seq}:${i}`;
      if (!sizedSeen.has(known)) {
        sizedSeen.add(known);
        holdDiagRecord("sized-box", {
          seq: m.seq,
          i,
          n: sizedSeen.size, // distinct photos drawn at a size we were told
          w: dims[0],
          h: dims[1],
          tall: dims[1] > dims[0] ? 1 : 0, // the portrait ones are the complaint
          // and how many photos the served-shape check below has managed to
          // look at by now. It rides here, on the record that always fires,
          // because that check writes nothing at all when the pixels agree: on
          // its own, a channel with no records on it reads exactly like a
          // channel nobody ever wrote to, and that ambiguity has already sent
          // this session down the wrong branch twice.
          ck: servedSeen.size,
        });
      }
    } else {
      img.width = GUESS_W;
      img.height = GUESS_H;
      img.style.aspectRatio = GUESS_RATIO; // lock the box even after decode
      img.style.objectFit = "cover";
      // TEMP DIAGNOSTIC (guessed-box, block marked at guessedSeen): he reports
      // portrait photos coming up wide and then going tall as he scrolls back
      // through them, which is this branch and only this branch: a photo whose
      // size we were told cannot change shape at all. The compensation for the
      // correction only covers a photo entirely above the top of the screen,
      // and scrolling up they arrive across that edge, so nothing catches them.
      // What is not known is why the size is missing, since the server works it
      // out on the way in and repairs old rows on the way out. So: which photos
      // guess, and how many. One record per photo, not per render, or a scroll
      // through history would bury the trail in its own noise.
      const mark = `${m.seq}:${i}`;
      if (!guessedSeen.has(mark)) {
        guessedSeen.add(mark);
        holdDiagRecord("guessed-box", {
          seq: m.seq,
          i,
          n: guessedSeen.size, // distinct photos that have had to guess this session
          keys: (m.attachments ?? []).length,
          dims: m.attachment_dims ? m.attachment_dims.length : null,
          hash: m.attachment_blurhashes?.[i] ? 1 : 0, // told one thing but not the other?
        });
      }
    }
    // the photo's own colours in the box, in place of the grey rectangle, from
    // this frame and with no second request (styles.css reads --blur). A photo
    // with no usable hash simply never sets it and the grey stands.
    const face = blurFace(m.attachment_blurhashes?.[i]);
    if (face) div.style.setProperty("--blur", `url("${face}")`);
    img.alt = "photo";
    img.onload = () => {
      // TEMP DIAGNOSTIC (scroll-jank): a history photo's pixels landing runs
      // main-thread work here (the box adopt or the shape check, plus the
      // re-pin), and the paint after it carries the decode itself — the
      // engine's half is unstampable, so this span is the app's share of that
      // moment and its name in a stall marks decode territory. TO REMOVE with
      // the scrolljank.ts block: this stamp pair.
      const jankT0 = performance.now();
      photoQueue.arrived(img); // the grey box comes off with the first pixels
      // a photo that had to guess its box now has its own pixels to measure:
      // the box takes their shape in this same task, the scroll is handed back
      // whatever that costs, and the size is written down so no later render
      // of this photo ever guesses again
      if (guessed) adoptPhotoBox(img, div, m.seq, i);
      // and a photo that did NOT guess has its own pixels here too, which is the
      // first chance anything has had to check whether they are the shape the
      // frame promised (checkServedShape). Reads only, changes nothing.
      else if (dims) checkServedShape(img, m.seq, i, dims);
      // decoded height lands late; re-pin INSTANTLY — a layout completion must
      // never glide (the opening-scroll motion he flagged came from these)
      if (followTail) scrollToBottom(true);
      jankSpan("photo-load", jankT0); // TEMP DIAGNOSTIC (scroll-jank)
    };
    img.onerror = () => {
      photoQueue.arrived(img); // no pixels are coming; the chip replaces the box
      // the reserved box gives way to a one-line chip, which on old history is
      // hundreds of pixels leaving the thread at once; through keepView so a
      // reader further down the conversation never feels it
      keepView(div, () => {
        div.classList.replace("shot", "text");
        div.appendChild(chip("📎 photo"));
        img.remove();
      });
    };
    img.addEventListener("click", () => openLightbox(img.src, img));
    // the url is PARKED, not fetched (photolazy.ts): a photo far from the
    // screen never opens a connection, and the box reserved above sits grey
    // with a ring in it until the reader comes within a screen of it
    photoQueue.hold(img, thumbUrl(key));
    div.appendChild(img);
  });
  if (value) rowEl(wrapper, "user", "text", at).textContent = value;
}

// The one moment a photo's box changes shape, and the last time this photo
// ever needs one.
//
// Only a photo that had no size to lay out from gets here. It has been
// standing in the guessed 4:3 box, which carries an explicit ratio, so nothing
// that has decoded in the meantime has touched its layout: the height read
// below is still the guessed height, and the height read after the write is
// the shape the photo actually is. Both reads and the write sit in this one
// task, so the change and the scroll that pays for it paint together.
//
// The change is deliberate on purpose. Left in the guessed box a portrait photo
// stays cropped into a landscape frame for as long as the app is open, which is
// the squish, and the alternative to changing it is keeping a picture the
// reader can see is wrong. So it changes, once, in the same frame its first
// pixels appear in, and keepView makes sure that costs the reader nothing when
// it happens above what he is reading.
//
// A photo whose pixels never reported a size keeps the guess and takes no
// branch at all, which is the behaviour that has always been there: the guess
// is the only thing standing between an undecodable photo and a zero tall row.
function adoptPhotoBox(
  img: HTMLImageElement,
  row: HTMLElement,
  seq: number | undefined,
  index: number,
): void {
  const nat = naturalSize(img);
  if (!nat) return; // nothing to measure: the guessed box stands, as it always has
  keepView(row, () => {
    img.style.aspectRatio = ""; // back to the photo's own ratio
    img.style.objectFit = "";
    img.width = nat[0];
    img.height = nat[1];
  });
  learnPhotoDims(seq, index, nat);
}

// Write a measured size into the stored frame, so the next render starts at the
// right box instead of guessing it again.
//
// The store is the display truth and the cold-open snapshot is copied straight
// out of it, so one write here reaches every later drawing of this photo: an
// in-place re-render, a fresh shell, and the next cold open. That is what makes
// the change above a once-per-photo event rather than something that happens on
// every scroll past it.
//
// It lands in the same attachment_dims the server fills, at the same index, in
// the same shape, so the record that comes out is indistinguishable from one the
// server sized. Nothing about the cached frame's shape changes and no era is
// crossed, which is why this needs no schema bump: a frame the client sized and
// a frame the server sized are the same frame. A slot that already holds a size
// is left alone (photofit.ts holds that rule), so this can only ever fill a gap.
// True when the store changed.
function learnPhotoDims(seq: number | undefined, index: number, dims: Dims): boolean {
  if (!seq) return false;
  const cur = store.get(seq);
  if (!cur) return false;
  const next = learnDims(cur.attachment_dims, (cur.attachments ?? []).length, index, dims);
  if (!next) return false;
  store.set(seq, { ...cur, attachment_dims: next });
  cacheWrites.bump(); // the learned box must reach the cold-open snapshot
  holdDiagRecord("photo-learned", { seq, i: index, w: dims[0], h: dims[1] });
  return true;
}

// TEMP DIAGNOSTIC (served-shape, dedupe set at servedSeen, rule in photofit.ts).
//
// He watched photos in his history come up landscape and then stand up into
// portrait, shoving everything under them down the page, and reports it as
// something he saw rather than something he inferred. Everything measured so
// far contradicts him from a distance: the marks say almost every photo back
// there took the known-size branch, which is the branch that is not supposed to
// be able to change shape, and reading the server's code says the size it stores
// and the thumbnail bytes it serves cannot disagree. Two indirect readings
// against one direct one, and no measurement anywhere of the only thing that
// would settle it — the shape of the pixels that actually arrive.
//
// It would settle it because of how the known-size box is written. The width and
// height attributes under `height: auto` are `aspect-ratio: auto W/H`, and that
// keyword hands the box to the image's own natural ratio the moment the image
// loads. So pixels of a different shape than the frame promised DO reshape the
// box, at load, in silence, and adoptPhotoBox above never sees it: that
// correction is wired to the guessing branch and pays the scroll back only
// there. This is exactly the shape of what he describes.
//
// Records nothing when the two agree, so quiet is the answer that clears the
// mechanism — which is only readable because the sized-box record carries how
// many photos got this far (ck). One record per photo, never per render, or one
// scroll back through the history would bury its own evidence.
//
// Costs two properties the image already holds. No geometry is read here and
// nothing is written to the page.
function checkServedShape(
  img: HTMLImageElement,
  seq: number | undefined,
  index: number,
  told: Dims,
): void {
  const mark = `${seq}:${index}`;
  if (servedSeen.has(mark)) return;
  const nat = naturalSize(img);
  if (!nat) return; // no pixels to have a shape: nothing was checked, so say nothing
  servedSeen.add(mark);
  const off = servedShape(told, nat);
  if (!off) return; // the box it was drawn at is the box the picture is
  servedOff += 1;
  holdDiagRecord("served-shape", {
    seq,
    i: index,
    n: servedOff, // distinct photos served a shape other than the promised one
    w: told[0],
    h: told[1],
    nw: nat[0],
    nh: nat[1],
    swap: off.swap, // told W×H and served H×W: the landscape-into-portrait case
    r: off.r, // told aspect over served aspect, for the mismatches that are not that
  });
}

function renderSystemLine(_m: ServerMsg, wrapper: HTMLElement, at: number, value: string): void {
  rowEl(wrapper, "system", "line", at).textContent = value || "✓";
}

// PNG dimensions read straight from a data-URI's first 24 bytes (signature +
// IHDR width/height) — no image decode needed, so the box can be reserved for
// every stored screenshot, legacy included. Null when it isn't a PNG.
function pngDims(dataUri: string): [number, number] | null {
  const start = dataUri.indexOf(",") + 1;
  if (start <= 0) return null;
  try {
    const head = atob(dataUri.slice(start, start + 32)); // 32 b64 chars = 24 bytes
    if (head.length < 24 || head.slice(12, 16) !== "IHDR") return null;
    const u32 = (o: number) =>
      ((head.charCodeAt(o) << 24) | (head.charCodeAt(o + 1) << 16) |
        (head.charCodeAt(o + 2) << 8) | head.charCodeAt(o + 3)) >>> 0;
    const w = u32(16);
    const h = u32(20);
    return w > 0 && h > 0 ? [w, h] : null;
  } catch {
    return null;
  }
}

function renderScreenshot(_m: ServerMsg, wrapper: HTMLElement, at: number, value: string): void {
  if (!value) return;
  const div = rowEl(wrapper, "agent", "shot", at);
  const img = document.createElement("img");
  // reserve the box before decode — the last unsized images shoving the scroll
  //
  // Nothing here needs the guess-and-adopt the photo rows carry, because this
  // box cannot change shape: the numbers below are read out of the picture's own
  // header, so they ARE the size the pixels decode to, and every stored preview
  // is a png this can read. A preview that somehow is not leaves the row unsized
  // and takes its height on decode, which is the one case left in the app, and
  // giving it a guessed box would trade a shape nobody has ever seen for a crop
  // everybody would.
  const dims = pngDims(value);
  if (dims) {
    img.width = dims[0];
    img.height = dims[1];
  }
  img.src = value;
  img.alt = "board preview";
  img.onload = () => {
    if (followTail) scrollToBottom(true); // height lands after decode; never glide
  };
  img.addEventListener("click", () => openLightbox(value, img));
  div.appendChild(img);
}

function renderPr(m: ServerMsg, wrapper: HTMLElement, at: number): void {
  const url = prUrl(m.payload);
  const div = rowEl(wrapper, "agent", "pr", at);
  if (url) {
    div.append("Opened a PR: ");
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = url;
    div.appendChild(a);
  } else {
    div.textContent = "Opened a PR.";
  }
  const btn = document.createElement("button");
  btn.className = "publish";
  if (isPublished(prNumber(m.payload))) {
    btn.textContent = "Published ✓"; // resolved by a correlated published event
    btn.disabled = true;
  } else {
    btn.textContent = "Publish";
    btn.addEventListener("click", () => void publish(url ?? "", btn));
  }
  div.appendChild(btn);
}

function renderError(_m: ServerMsg, wrapper: HTMLElement, at: number, value: string): void {
  rowEl(wrapper, "agent", "error", at).textContent = `⚠ ${value}`;
}

function renderAgentText(m: ServerMsg, wrapper: HTMLElement, at: number, value: string): void {
  const kind = m.kind ?? "log";
  if (kind === "done" && !value.trim()) return; // job-complete signal, text already shown
  if ((kind === "log" || kind === "done") && m.seq && value.trim()
      && isDuplicateAgentText(m.seq, value.trim())) {
    return; // consecutive duplicate of the same reply
  }
  rowEl(wrapper, "agent", "text", at).textContent = value;
}

const agentRenderers: Record<string, Renderer> = {
  screenshot: renderScreenshot,
  pr: renderPr,
  error: renderError,
};

function renderInto(wrapper: HTMLElement, m: ServerMsg): void {
  const role = m.role ?? "agent";
  const at = m.ts ? Date.parse(m.ts) : Date.now();
  const value = typeof m.payload === "string" ? m.payload : "";
  wrapper.dataset.ts = String(at);
  wrapper.dataset.role = role;
  if (role === "user") return renderUser(m, wrapper, at, value);
  // internal markers, not messages: job = enqueue bookkeeping, working = the
  // pickup watermark the receipt derives from
  if (m.kind === "job" || m.kind === "working") return;
  if (role === "system") return renderSystemLine(m, wrapper, at, value);
  return (agentRenderers[m.kind ?? "log"] ?? renderAgentText)(m, wrapper, at, value);
}

function chip(label: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = "filechip";
  s.textContent = label;
  return s;
}

// --- delivery receipt (single stamp under the most recent sent message) --------
// Derived from the STORED thread, never from transient signals, so a reopen
// replays the same label (message persisted -> Delivered; its job picked up,
// per the stored working row -> Read). Anchored inside the newest sent
// message's wrapper, so it stays under that bubble when replies land below.

// The label flip (Delivered -> Read) is a two-phase opacity fade. The current
// word fades fully out, its text is swapped only once the layer is invisible,
// then the new word fades back in. The swap runs on the layer's transitionend,
// when opacity has already reached 0, never on a timer, so the text can never
// change while any of it still shows. It is smooth by construction, with no
// per-device timing. The fade lives on an inner .rc layer (opacity only,
// caret-safe) so the receipt's own transform transition for swipe-peek (the
// :where rule in styles.css) is left untouched.

// A MOVE to a newer sent message is that same fade with the travel in the
// middle: the stamp fades out where it stands, crosses while it is invisible,
// and fades back in under the newer bubble. It never snaps to the new seat,
// which is the one thing the real messages app never does. data-travel says
// which beat a move is on: "fade" while the label is still on its way to
// opacity 0, "dark" once it is there and the crossing is owed. The crossing
// itself must cost the thread no height (receiptTravel below).

// build a fresh receipt: an .rc text layer inside the #receipt box, plus the
// one persistent handler that drives every later flip. Reaching opacity 0 (the
// rc-hide fade-out just finished) swaps the now-invisible text to the newest
// target and releases the fade back in. If a move is owed, the crossing runs
// first instead and releases the fade itself. Reaching opacity 1 is the end,
// no work.
function buildReceipt(state: string): HTMLElement {
  const el = document.createElement("div");
  el.id = "receipt";
  el.className = "receipt";
  el.dataset.state = state;
  const layer = document.createElement("span");
  layer.className = "rc";
  layer.textContent = state;
  layer.addEventListener("transitionend", (e) => {
    if (e.propertyName !== "opacity" || !layer.classList.contains("rc-hide")) return;
    layer.textContent = el.dataset.state ?? ""; // swapped while fully invisible
    if (el.dataset.travel) return receiptTravel(el); // a move is owed: cross still dark
    layer.classList.remove("rc-hide"); // fade the new word in
  });
  el.appendChild(layer);
  return el;
}

// The invisible beat of a move. The label has just reached opacity 0, so the
// stamp can cross to the newer bubble with none of it showing, provided the
// crossing moves nothing else. It does not: updateReceipt re-parents the SAME
// element, and re-appending an already-attached node is one DOM move, never a
// detach followed by an insert, so the stamp's box is never absent from the
// thread and the thread's height is identical before and after. The only
// element whose position genuinely differs between the two layouts is the
// newer bubble's seat, one stamp-height higher once the stamp sits below it
// rather than above it; the sibling shift glides that hop on the shared beat
// instead of letting it jump under an invisible label. While a flight is still
// airborne the move parks instead, because opening a shift here would cancel
// the flight's own glide, and flightSettled applies the move inside the shift
// it already opens.
function receiptTravel(el: HTMLElement): void {
  el.dataset.travel = "dark";
  holdDiagRecord("receipt-hold", { phase: "dark", flights: flightsUp });
  if (flightsUp > 0) return updateReceipt(); // parks on the gate; flightSettled lands it
  const shift = beginSiblingShift();
  updateReceipt();
  shift.play();
}

function updateReceipt(): void {
  const r = receiptFor(store.values());
  const wrapper = r ? wrapperFor(r.seq) : null;
  const existing = document.getElementById("receipt");
  if (!r || !wrapper) {
    if (!existing) return;
    // the bare removal shifts every row above the stamp exactly like a
    // relocation does — a flight in progress parks it on the same slot
    if (flightsUp > 0) {
      receiptPending = true;
      holdDiagRecord("receipt-hold", { phase: "park" });
      return;
    }
    existing.remove(); // nothing to stamp, or the newest sent message sits above the loaded window
    return;
  }
  const layer = existing?.querySelector<HTMLElement>(".rc") ?? null;
  if (existing && existing.parentElement === wrapper) {
    // Same bubble, so only the LABEL can have changed: fade it, don't snap it.
    // dataset.state holds the newest TARGET label. A repeat call with the same
    // target no-ops (no stacked fades), and the transitionend swap reads it so
    // the latest state always wins even if it changes mid-fade.
    if (existing.dataset.travel) {
      // a move was owed and the anchor came back under this bubble (a replay
      // took the newer wrapper away): drop it, show the label where it is
      delete existing.dataset.travel;
      existing.dataset.state = r.state;
      layer?.classList.remove("rc-hide");
    } else if (existing.dataset.state !== r.state) {
      existing.dataset.state = r.state;
      // fade fully out; the persistent handler swaps the text and fades it back
      // in once the layer is invisible. Re-adding rc-hide mid-fade is a harmless
      // no-op, so repeat flips never stack.
      layer?.classList.add("rc-hide");
    }
    if (followTail) scrollToBottom();
    return;
  }
  // The anchor is moving to a newer bubble. Beat one: fade out where it stands.
  // Opacity only, nothing in the layout touched, so this starts the moment the
  // move is known, mid-flight included, which is what leaves the label already
  // dark by the time the bubble lands. Beats two and three (cross, fade in) run
  // off the layer's transitionend at opacity 0, through receiptTravel. A repeat
  // call re-arms the same beat: rc-hide is already on, the running fade owns it.
  // Replay bursts (suppressAnim) never fade, since no transition would run to
  // end one, so they fall through to the immediate rebuild below.
  if (existing && layer && existing.dataset.travel !== "dark" && !suppressAnim) {
    existing.dataset.state = r.state; // the newest target word, swapped while dark
    existing.dataset.travel = "fade";
    layer.classList.add("rc-hide");
    holdDiagRecord("receipt-hold", { phase: "fade" });
    return;
  }
  // On a fast connection the send ACK lands mid-flight (real ACKs in 50-200ms
  // against the 400ms beat), and crossing the ~18px stamp then, out from under
  // the previous bubble and in under the flying one, jolts the landing seat and
  // everything above it while the bubble is airborne: the end-of-send bounce.
  // Park the move until the flight settles; flightSettled applies it. The gate
  // is the live animation count, so sends with no flight (and ACKs landing
  // after touchdown) keep the immediate path.
  if (flightsUp > 0) {
    receiptPending = true;
    holdDiagRecord("receipt-hold", { phase: "park" });
    return;
  }
  if (existing && layer && existing.dataset.travel === "dark") {
    // Beat two: cross while invisible. appendChild on an ALREADY-ATTACHED node
    // is a single DOM move, so the stamp's box never leaves the thread and no
    // height is lost in between. No row can drop into a gap the label is not
    // there to explain. Beat three releases the fade in the same task, so the
    // label comes back up under the newer bubble.
    delete existing.dataset.travel;
    existing.dataset.state = r.state;
    layer.textContent = r.state;
    wrapper.appendChild(existing);
    // re-parenting rebuilds the layer's resolved style, and a style resolved
    // for the first time never transitions. Read it back at opacity 0 first so
    // the browser has a value to start FROM, then release the class.
    void layer.offsetHeight;
    layer.classList.remove("rc-hide");
    holdDiagRecord("receipt-hold", { phase: "travel" });
    if (followTail) scrollToBottom();
    return;
  }
  existing?.remove(); // nothing to carry across: the first stamp, or a replay snap
  wrapper.appendChild(buildReceipt(r.state));
  if (followTail) scrollToBottom();
}

// --- typing indicator (dots = the agent is COMPOSING text, like iMessage) ------
// Dots self-expire: the agent's internal notes also count as "composing" but
// never become messages, so dots that lead nowhere fade out on their own.

let typingExpiry: ReturnType<typeof setTimeout> | null = null;

function showTyping(): void {
  if (typingExpiry) clearTimeout(typingExpiry);
  typingExpiry = setTimeout(hideTyping, 15000);
  if (document.getElementById("typing")) return;
  const el = document.createElement("div");
  el.id = "typing";
  el.className = "msg agent typing";
  el.innerHTML = "<span></span><span></span><span></span>";
  const t = document.getElementById("thread");
  if (t) {
    placeTyping(t, el); // after the newest content, above restored failures (dots.ts)
    if (followTail) scrollToBottom();
  }
}

function hideTyping(): void {
  if (typingExpiry) clearTimeout(typingExpiry);
  typingExpiry = null;
  const dots = document.getElementById("typing");
  if (!dots) return; // nothing was on screen: the conversation did not change height
  dots.remove();
  // showTyping pins the bottom when the dots go up; this is the other half of
  // that, and without it the view stayed where the taller content had put it and
  // the dots' height was left on screen as white under the last message
  settleContent("typing");
}

// --- networking --------------------------------------------------------------

// Version-skew guard: a service-worker-cached bundle can outlive the server it
// was built against (wire/schema changes ride deploys). On mismatch, drop the
// SW caches and reload ONCE per server version — navigations are network-first,
// so the reload fetches the freshly deployed bundle.
const REFRESHED_KEY = "paratrooper_refreshed_for";

// full-screen "Updating …" cover for the version swap: with cache-first opens
// the stale UI paints instantly, so a silent mid-use reload would read as a
// strange flip — this branded beat explains it instead
function showUpdating(): void {
  if (document.getElementById("updating")) return;
  const el = document.createElement("div");
  el.id = "updating";
  el.className = "updating";
  el.innerHTML = `
    <img src="/topbar-logo.png" alt="" />
    <div class="up-title">Updating …</div>
    <div class="updots"><span></span><span></span><span></span></div>`;
  document.body.appendChild(el);
}

function maybeSelfRefresh(server: string): void {
  if (__SERVER_VERSION__ === "dev" || server === "dev") return; // local dev
  if (server === __SERVER_VERSION__) return; // bundle matches the server
  if (sessionStorage.getItem(REFRESHED_KEY) === server) return; // already tried
  sessionStorage.setItem(REFRESHED_KEY, server);
  showUpdating();
  const cleared =
    "caches" in window
      ? caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      : Promise.resolve([]);
  void cleared
    .catch(() => {})
    // warm refetch: repopulate the shell cache with the NEW page before
    // reloading, so the reload paints instantly from cache under the overlay
    // instead of showing white while the network round-trips
    .then(() => fetch("/").catch(() => {}))
    .then(() => location.reload());
}

async function checkServerVersion(): Promise<void> {
  try {
    const r = await fetch("/api/health");
    const v = String((await r.json()).version ?? "");
    console.log(`paratrooper ui ${__BUILT_AT__} built@${__SERVER_VERSION__} / server ${v}`);
    if (v) maybeSelfRefresh(v);
  } catch {
    /* offline: the cached shell is all there is anyway */
  }
}

// The socket never announces "replay finished", and replay re-sends the
// exact live frame shape — but the backlog is by definition everything at or
// below the server's newest seq at connect. One tiny history query (newest
// row only, the same endpoint the client already pages with) learns that seq
// the moment the socket opens; bootgate.ts holds it as the per-frame replay
// marker. Until the probe answers, every frame counts as replay — stillness
// is the safe default. On failure the ledger closes at whatever has arrived:
// a socket that can't reach the server is dying anyway, and its reconnect
// re-probes.
async function probeReplayTail(): Promise<void> {
  let tail: number;
  try {
    const r = await fetch(
      `/api/history/${THREAD_ID}?before=${Number.MAX_SAFE_INTEGER}&limit=1`,
      { headers: authHeaders() },
    );
    if (!r.ok) throw new Error(String(r.status));
    const { messages } = (await r.json()) as { messages: ServerMsg[] };
    // pages are oldest-first, so the newest row — the backlog's ceiling — is last
    tail = messages.length ? (messages[messages.length - 1].seq ?? 0) : 0;
  } catch {
    tail = Math.max(lastSeq, replayBufferMax); // whatever has arrived, buffered included
  }
  bootGate.tailKnown(tail);
  replaySettle();
}

// the backlog is fully covered — applied or buffered — (the ledger's
// caught-up edge, once per socket): the buffered catch-up commits as ONE
// task, animations come on, and the boot settle runs — this used to hang off
// a 400ms quiet timer that late replay frames could outlive
function replaySettle(): void {
  if (!document.getElementById("thread")) return; // the gate replaced the shell mid-flight
  if (!bootGate.caughtUp(Math.max(lastSeq, replayBufferMax))) return;
  commitReplayBuffer(); // the whole catch-up lands here, in this same task
  suppressAnim = false;
  // settled: probe the history bank once — a short thread never scrolls, so
  // without this the spinner would sit unresolved forever
  tryApplyOlder();
  void bootSettlePin();
  // one cheap look back at the newest page: a reply retracted while the app
  // was closed (or the socket was down — retract frames are ephemeral) must
  // not survive on screen just because the cache or the store replayed it
  void reconcileRetracts();
}

// the batching half of the cold-open fix: the buffered backlog applies in one
// synchronous task, oldest first, through the same silent applyReplay path a
// straggler takes — one decorate'd DOM state, one bottom pin, one paint,
// whether it is three frames after an hour away or fifty after a reinstall
function commitReplayBuffer(): void {
  const frames = replayBuffer;
  replayBuffer = [];
  replayBufferMax = 0;
  frames.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  for (const m of frames) applyReplay(m);
  holdDiagRecord("batch-commit", { n: frames.length });
}

// After the settle, ask the server for its newest page ONCE and drop any
// stored seq inside that page's span the server no longer has: a take-back
// that happened while this client was closed or disconnected never sent us
// its retract frame (retracts are ephemeral broadcasts), so the cached reply
// would otherwise stand forever. Bounded to the page's own span — seqs above
// it may be frames landing this instant, seqs below it are beyond one cheap
// fetch — and removal rides the same applyRetract path a live take-back uses.
async function reconcileRetracts(): Promise<void> {
  let messages: ServerMsg[];
  try {
    const r = await fetch(
      `/api/history/${THREAD_ID}?before=${Number.MAX_SAFE_INTEGER}&limit=${HISTORY_PAGE}`,
      { headers: authHeaders() },
    );
    if (!r.ok) return;
    ({ messages } = (await r.json()) as { messages: ServerMsg[] });
  } catch {
    return; // reconcile is best-effort; the next settle gets another look
  }
  if (!document.getElementById("thread")) return;
  // the page in hand is also the server's authoritative copy of every row it
  // spans: give stored frames from a poorer era their attachment fields back
  // (the enrich rule no-ops on plain duplicates), so a send whose read-back
  // fetch failed still heals on the next connect
  for (const m of messages) enrichStored(m);
  const present = new Set(messages.map((m) => m.seq ?? 0).filter((s) => s > 0));
  if (!present.size) return; // an empty page bounds nothing: drop nothing
  const lo = Math.min(...present);
  const hi = Math.max(...present);
  const dropped = [...store.keys()].filter((s) => s >= lo && s <= hi && !present.has(s));
  if (!dropped.length) return;
  holdDiagRecord("reconcile-drop", { seqs: dropped });
  for (const s of dropped) applyRetract(s);
}

// replay frames NEVER animate and NEVER animated-scroll, however late they
// arrive. A straggler that a live frame overtook is no longer the tail: it
// inserts above the fold with the bottom pin compensating in the same frame
// (drainOlder's own pattern), so the settled view just gains content out of
// sight with zero visible motion. Tail frames pin instantly via the usual
// followTail path (suppressAnim makes that pin behavior:"auto").
function applyReplay(m: ServerMsg): void {
  const prevSuppress = suppressAnim;
  suppressAnim = true;
  const t = threadEl();
  const prevScroll = t.scrollTop;
  const prevHeight = t.scrollHeight;
  const isTail = (m.seq ?? 0) > lastSeq;
  applyEvent(m);
  if (!isTail) t.scrollTop = prevScroll + (t.scrollHeight - prevHeight); // visible row stays put
  suppressAnim = prevSuppress;
}

// A truly fresh open must LAND at the very bottom with zero visible motion.
// The replay's per-frame pins can die early — an unsized image (a non-PNG
// screenshot, a restored-outbox blob) growing the thread between one pin and
// that pin's own scroll event makes the event read "away from the bottom"
// and flip followTail off, and every later re-pin hook is followTail-gated —
// so the first settle of each shell (and only the first: reconnect settles
// must never yank a reader; bootgate.ts keeps that ledger) forces every
// still-pending thread image to decode (decode() resolves after load+decode,
// so all late height is in), then pins one final time without any gate. The
// pin's own scroll event re-derives followTail=true through the one usual
// place.
async function bootSettlePin(): Promise<void> {
  if (!document.getElementById("thread")) return;
  if (!bootGate.claimSettlePin()) return;
  const pending = Array.from(threadEl().querySelectorAll<HTMLImageElement>("img"))
    .filter((img) => !img.complete);
  // bounded wait: a slow thumb fetch must not stall the settle — anything
  // landing later re-pins through the usual followTail onload hooks (and
  // sized images shift nothing anyway)
  await Promise.race([
    Promise.allSettled(pending.map((img) => img.decode())),
    new Promise((r) => setTimeout(r, 1200)),
  ]);
  scrollToBottom(true); // a settled layout must not glide
  void settleLoadingScreen(); // a cacheless boot's first paint is this one
}

function connect(): void {
  closingOnPurpose = false;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/ws?token=${encodeURIComponent(token)}&thread=${THREAD_ID}&since=${lastSeq}`;
  suppressAnim = true; // the catch-up replay must not animate or glide
  bootGate.reconnect(); // a new backlog is inbound: everything is replay again
  replayBuffer = []; // an old socket's unfinished catch-up re-delivers via since=
  replayBufferMax = 0;
  if (probeFallback) clearTimeout(probeFallback);
  // the probe can hang, not just fail: past this bound the ledger closes at
  // whatever arrived — tailPending() keeps the timeout from ever lowering a
  // ceiling the probe DID establish (a slow big replay must finish buffering)
  probeFallback = setTimeout(() => {
    probeFallback = null;
    if (!bootGate.tailPending()) return;
    bootGate.tailKnown(Math.max(lastSeq, replayBufferMax));
    replaySettle();
  }, PROBE_FALLBACK_MS);
  ws = new WebSocket(url);
  ws.onopen = () => {
    void probeReplayTail(); // the honest marker: the server's tail at connect
    // every (re)connect re-checks version: a deploy drops the socket, so the
    // reconnect is exactly when a live page may have gone stale
    void checkServerVersion();
  };
  ws.onmessage = (e) => {
    if (!document.getElementById("thread")) return; // gate is showing; don't consume
    const m = JSON.parse(e.data) as ServerMsg & { retract_seq?: number };
    // a take-back frame: the server deleted this reply on the owner's send.
    // Checked before the seq gate — the frame carries no top-level seq on
    // purpose (a stale bundle drops it as ephemeral instead of rendering it).
    if (m.kind === "retract" && typeof m.retract_seq === "number") {
      applyRetract(m.retract_seq);
      return;
    }
    if (!m.seq) {
      // ephemeral kinds bypass the store: they are presence, not history.
      // (working is keyed now — the stored row drives the Read receipt)
      if (m.kind === "typing") showTyping(); // dots self-expire if it wasn't for you
      return;
    }
    // the finished reply must not land under his thumbs: mid-composition it
    // parks in the hold and renders after 7s of quiet (or on empty/send)
    if (m.role === "agent" && m.kind === "done" && replyHold.maybeHold(m.seq, m)) return;
    // every socket frame that passes (or bypasses) the hold is visible in the
    // trail with its kind — a rendered seq with no ws-apply record came from
    // some other route (history page, hold release, optimistic ACK)
    holdDiagRecord("ws-apply", { seq: m.seq, kind: m.kind ?? null, role: m.role ?? null });
    if (bootGate.isReplay(m.seq)) {
      if (bootGate.settled()) {
        applyReplay(m); // a post-settle straggler: silent, pinned, per-frame
      } else {
        // the streaming catch-up: buffered, committed as ONE task on the
        // caughtUp edge (commitReplayBuffer) — the browser may paint between
        // socket tasks, so per-frame applies are a visible movie by definition
        replayBuffer.push(m);
        if (m.seq > replayBufferMax) replayBufferMax = m.seq;
      }
    } else {
      suppressAnim = false; // a genuinely new message: the boot era is over
      applyEvent(m);
    }
    replaySettle();
  };
  ws.onclose = () => {
    if (closingOnPurpose || !token) return; // logout: stay closed
    setTimeout(connect, 2000); // dropped: reconnect; catch-up via ?since=
  };
}

// A retract frame landed: the server deleted this reply at the owner's send
// (another client's take-back — or our own echoing back, already clean).
// Remove every trace wherever it lives: a still-parked hold entry, the store
// row, the rendered bubble. All three misses is the clean-echo case and a
// no-op; the trail records what was actually found so the round-trip reads
// back from the deploy logs.
function applyRetract(seq: number): void {
  const wasHeld = replyHold.drop(seq);
  const hadStore = store.delete(seq);
  if (hadStore) cacheWrites.bump(); // the deleted reply must leave the cold-open snapshot too
  const w = wrapperFor(seq);
  if (w) {
    w.remove();
    decorate();
    updateReceipt();
    settleContent("retract"); // a whole bubble left: the end of the range moved up with it
  }
  holdDiagRecord("retract-applied", {
    seq, bubble: w !== null, stored: hadStore, held: wasHeld,
  });
}

// --- send-flight receipt hold (the end-of-send bounce's last mover) -----------
// While any send-flight animation is airborne, layout-mutating receipt work
// (a relocation to a new bubble, a bare removal) parks in receiptPending — a
// recompute flag, not a snapshot: the apply derives from the store fresh, so
// whatever landed meanwhile wins — and lands when the LAST flight settles,
// finish and cancel alike, so a torn-down flight still gets its stamp. The
// apply rides the sibling-shift machinery: the relocation is height-neutral
// (the stamp's 18px move from above the seat to below it), so no scroll write
// fires, and the seat's hop glides on the shared beat. A moving stamp is the
// SAME element re-parented, so the walk reads it as an existing row that went
// down, not a newborn: its own fade owns its entrance. Only a first-ever stamp
// is a newborn here, and that one fades up into place.
let flightsUp = 0; // send-flight animations still airborne
let receiptPending = false; // updateReceipt work parked until the flights settle

function flightSettled(): void {
  if (flightsUp > 0) flightsUp--;
  if (flightsUp > 0 || !receiptPending) return;
  receiptPending = false;
  if (!document.getElementById("thread")) return; // shell torn down mid-flight
  holdDiagRecord("receipt-hold", { phase: "apply" });
  const shift = beginSiblingShift();
  updateReceipt();
  shift.play();
}

// --- the send morph: the bar leaves the box (his order) -----------------------
// The true iMessage send is not the finished bubble translated down to the
// field — it is the BAR: a shell the typing box's exact rect, pill, face, and
// as-typed text, which lifts out of the composer and compresses into the
// bubble's box while it rises, landing on the seat. The shell is a
// fixed-position element in <body>: the thread is a scroll container, so
// anything inside it is clipped at the thread's box and could never stand
// over the field — and a fixed shell's per-frame layout is its own, touching
// nothing in the thread (no transformed overflow inflating scrollHeight, the
// old flight's known tax). Its box is real geometry (left/top/width/height
// plus per-corner radius), never transform scale: scale would squash the
// corner circles and the glyphs. The real bubble holds its seat in layout the
// whole time, hidden, and takes over in the shell's landing frame — the
// thread's layout after touchdown is exactly what it would have been with no
// flight at all. armFieldMorph is called BEFORE the composer collapse (the
// shell must snapshot the bar while the text is still in it; the collapse
// then happens beneath the opaque shell, so no bare-field frame ever paints),
// and launch() runs in send()'s insert task like the old flight did.

interface FieldMorph {
  launch(msg: HTMLElement): void;
  launched(): boolean;
  cancel(): void;
}

const MORPH_CORNER_PROPS = [
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomRightRadius",
  "borderBottomLeftRadius",
] as const;

function armFieldMorph(textEl: HTMLTextAreaElement): FieldMorph | null {
  const field = document.querySelector(".field");
  if (!field) return null;
  const barRect = field.getBoundingClientRect();
  const bar = {
    left: barRect.left, top: barRect.top, width: barRect.width, height: barRect.height,
  };
  const textRect = textEl.getBoundingClientRect();
  const barRadius = parseFloat(getComputedStyle(field).borderTopLeftRadius) || 18;
  const shell = document.createElement("div");
  shell.className = "morph";
  const writeBox = (b: { left: number; top: number; width: number; height: number }): void => {
    shell.style.left = `${b.left}px`;
    shell.style.top = `${b.top}px`;
    shell.style.width = `${b.width}px`;
    shell.style.height = `${b.height}px`;
  };
  writeBox(bar);
  shell.style.borderRadius = `${barRadius}px`;
  const layer = (cls: string): HTMLDivElement => {
    const el = document.createElement("div");
    el.className = cls;
    shell.appendChild(el);
    return el;
  };
  layer("morph-face-under");
  layer("morph-face-bar");
  const accent = layer("morph-face-accent");
  // the bar's text: cloned at the textarea's exact offset, width, padding, and
  // inner scroll, so the shell's first painted frame is indistinguishable from
  // the box it lifts out of
  const barText = layer("morph-text-bar");
  barText.style.left = `${textRect.left - bar.left}px`;
  barText.style.top = `${textRect.top - bar.top}px`;
  barText.style.width = `${textRect.width}px`;
  barText.style.padding = getComputedStyle(textEl).padding;
  barText.style.transform = `translateY(${-textEl.scrollTop}px)`;
  barText.textContent = textEl.value;
  const bubbleText = layer("morph-text-bubble"); // geometry lands at launch
  document.body.appendChild(shell);
  holdDiagRecord("flight", {
    phase: "morph-arm", barW: Math.round(bar.width), barH: Math.round(bar.height),
  });
  let raf = 0;
  let up = false;
  const settle = (msg: HTMLElement, phase: string): void => {
    // hand the seat back to the real bubble, byte-clean: the flight was pure
    // presentation, so the landed thread must carry no trace of it
    msg.style.removeProperty("opacity");
    if (!msg.getAttribute("style")) msg.removeAttribute("style");
    shell.remove();
    holdDiagRecord("flight", { phase });
    flightSettled();
  };
  return {
    launched: () => up,
    cancel(): void {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      shell.remove(); // never launched: nothing hidden, nothing airborne
    },
    launch(msg: HTMLElement): void {
      up = true;
      const seat0 = msg.getBoundingClientRect();
      const style = getComputedStyle(msg);
      const corners = MORPH_CORNER_PROPS.map((prop) => parseFloat(style[prop]) || 0);
      // the bubble's laid-out text, locked to the seat's width so it wraps
      // exactly as the real bubble did — the landing swap is pixel-identical
      bubbleText.style.width = `${seat0.width}px`;
      bubbleText.textContent = msg.textContent;
      msg.style.opacity = "0"; // the shell IS the bubble until it lands
      flightsUp++;
      holdDiagRecord("flight", {
        phase: "morph-launch",
        dx: Math.round((bar.left + bar.width - seat0.right) * 10) / 10,
        dy: Math.round((bar.top - seat0.top) * 10) / 10,
        toW: Math.round(seat0.width), toH: Math.round(seat0.height),
      });
      const t0 = performance.now();
      const step = (now: number): void => {
        raf = 0;
        if (!msg.isConnected) return settle(msg, "morph-cancel"); // replay/teardown took the seat
        const f = Math.min((now - t0) / FLIGHT_MS, 1);
        const p = flightEase(f);
        // the seat is re-read every frame: a second send's pin-and-shift (or a
        // reply landing mid-flight) moves it, and the shell must land on the
        // seat as it IS, not as it was at launch — the tracking the old FLIP
        // translate got for free by riding the element itself
        const seat = msg.getBoundingClientRect();
        writeBox(morphBox(
          bar,
          { left: seat.left, top: seat.top, width: seat.width, height: seat.height },
          p,
        ));
        shell.style.borderRadius =
          morphCorners(barRadius, corners, p).map((c) => `${c.toFixed(1)}px`).join(" ");
        accent.style.opacity = String(accentAlpha(f));
        barText.style.opacity = String(barTextAlpha(f));
        bubbleText.style.opacity = String(bubbleTextAlpha(f));
        if (f < 1) {
          raf = requestAnimationFrame(step);
        } else {
          // the landed box paints once (shell and bubble now pixel-identical),
          // THEN the swap — settling in the write's own frame could drop the
          // landing frame under load and read as a snap
          raf = requestAnimationFrame(() => settle(msg, "morph-finish"));
        }
      };
      raf = requestAnimationFrame(step);
    },
  };
}

// --- the photo send morph: the picked squares leave the strip -----------------
// The bar morph above is the text send's answer to the question of what
// actually moves. A photo send's answer has to be a different one, because the
// bar never held the photos: they were staged in the strip over the compose
// bar, and that is where they must be seen to leave from. So the flying thing
// here is the PICTURE and only the picture. Nothing is behind it at any point,
// in flight or after: a sent photo has no bubble (styles.css .msg.shot), so
// neither does the object that becomes one.
//
// What flies is a copy per picked photo, in one fixed sheet over the whole
// screen. Fixed and outside the thread for the bar morph's reason: the thread
// clips its children at its own box, so nothing inside it could rise out of
// the strip and across the thread's bottom edge. The real rows keep the one
// drawn element the tray handed them and hold their reserved seats in layout
// the whole time, hidden, taking over on the landing frame, exactly as the bar
// morph parks the real bubble. The strip's own squares are hidden from the
// frame the flight is armed (styles.css .pthumb.aloft) and its close then
// plays out on a box with no face of its own. Two elements over one blob url
// is the second read the tray's own close already did, and it is asked for
// only once the picture is decoded and standing on screen: a pick with no
// pixels yet stands the whole flight down (the record says which) and the send
// keeps the plain translate it always had.
//
// gather.ts holds the two legs, the deck the squares cluster into, and the
// cover-crop arithmetic that opens as the bundle grows. This half writes
// boxes. Armed BEFORE the composer collapse for the bar morph's reason too:
// the squares have to be measured while they are still in the strip.

/** what the newborn gap stamp copies so it travels with the photos, not past them */
interface ShotRide {
  dx: number;
  dy: number;
  delay: number;
}

interface ShotMorph {
  launch(msgs: HTMLElement[]): ShotRide | null;
  launched(): boolean;
  cancel(): void;
}

interface ShotFlier {
  copy: HTMLImageElement;
  square: MorphBox; // the strip thumbnail's rect, measured before the collapse
  natW: number;
  natH: number;
}

function armShotMorph(files: readonly File[]): ShotMorph | null {
  // a flight that cannot be armed says so on the trail, so a device session
  // that shows the old translate can name the reason instead of being argued
  const stand = (reason: string): null => {
    holdDiagRecord("flight", { phase: "shot-skip", reason, n: files.length });
    return null;
  };
  if (files.length === 0) return null;
  const fliers: ShotFlier[] = [];
  const wraps: HTMLElement[] = [];
  let thumbRadius = 12; // styles.css .pthumb img, re-read below from the real square
  for (const file of files) {
    const pick = picks.get(file);
    if (!pick) return stand("unstaged"); // never reached the strip: nothing to lift
    if (pick.wrap.classList.contains("undrawn")) return stand("undrawn");
    const nat = naturalSize(pick.img);
    if (!nat) return stand("nodims"); // no shape to open the crop onto
    const r = pick.img.getBoundingClientRect();
    if (!(r.width > 0) || !(r.height > 0)) return stand("unlaid");
    const copy = document.createElement("img");
    // never a synchronous decode at paint: the pixels are already on screen in
    // the square this copy is standing over, so the cache serves it, and if it
    // somehow does not then a missing frame beats freezing the main thread
    // through the whole launch (photobox.ts has the device numbers)
    copy.decoding = "async";
    copy.src = pick.img.src;
    // one style read for the whole strip: every square wears the same rule
    if (fliers.length === 0) {
      thumbRadius = parseFloat(getComputedStyle(pick.img).borderTopLeftRadius) || thumbRadius;
    }
    fliers.push({
      copy,
      square: { left: r.left, top: r.top, width: r.width, height: r.height },
      natW: nat[0],
      natH: nat[1],
    });
    wraps.push(pick.wrap);
  }
  const shell = document.createElement("div");
  shell.className = "shotflight";
  // The picture's own box and the cut that shows part of it, written together.
  // The box is where the WHOLE photo sits; the cut is the window onto it. They
  // start far apart (a 64px window on a photo blown up to cover it) and end as
  // the same rect, which is the crop opening. The corner lives on the cut,
  // never on the box: the box's own corners are outside the window for most of
  // the flight and would simply not be there to see.
  const paint = (f: ShotFlier, box: MorphBox, cut: MorphBox, radius: number): void => {
    f.copy.style.left = `${box.left.toFixed(1)}px`;
    f.copy.style.top = `${box.top.toFixed(1)}px`;
    f.copy.style.width = `${box.width.toFixed(1)}px`;
    f.copy.style.height = `${box.height.toFixed(1)}px`;
    const i = zoomClipInset(box, cut);
    f.copy.style.clipPath =
      `inset(${i.top.toFixed(1)}px ${i.right.toFixed(1)}px ` +
      `${i.bottom.toFixed(1)}px ${i.left.toFixed(1)}px round ${radius.toFixed(1)}px)`;
  };
  const n = fliers.length;
  fliers.forEach((f, i) => {
    // the first picked photo is the top of the deck and the top row of the
    // landed stack: one order, held from the gather through to the landing
    f.copy.style.zIndex = String(n - i);
    paint(f, coverBox(f.square, f.natW, f.natH), f.square, thumbRadius);
    shell.appendChild(f.copy);
  });
  document.body.appendChild(shell);
  for (const wrap of wraps) wrap.classList.add("aloft"); // the copies cover them now
  holdDiagRecord("flight", {
    phase: "shot-arm", n, thumb: Math.round(fliers[0].square.width),
  });
  let raf = 0;
  let up = false;
  return {
    launched: () => up,
    cancel(): void {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      shell.remove(); // never launched: nothing hidden in the thread, nothing airborne
    },
    launch(msgs: HTMLElement[]): ShotRide | null {
      if (msgs.length !== n) {
        shell.remove(); // the rows and the squares disagree: no honest pairing
        holdDiagRecord("flight", { phase: "shot-skip", reason: "rows", n: msgs.length });
        return null;
      }
      up = true;
      // the seat is the PHOTO's rect, not the row's: .msg.shot has no padding
      // so today they are the same box, and the img is the one that stays true
      // if that ever changes
      const seatOf = (msg: HTMLElement): MorphBox => {
        const r = (msg.querySelector("img") ?? msg).getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      };
      const seatRadius =
        parseFloat(
          getComputedStyle(msgs[0].querySelector("img") ?? msgs[0]).borderTopLeftRadius,
        ) || thumbRadius;
      const bundle = bundleSeats(fliers.map((f) => f.square));
      const gatherMs = gatherMsFor(n); // a lone photo has no arrangement to change
      for (const msg of msgs) msg.style.opacity = "0"; // the copies ARE the rows until they land
      flightsUp++;
      const seat0 = seatOf(msgs[0]);
      // The stamp gets the carry's two ends and its beat, not its corner: it
      // is a declarative animation on the row above and it takes the straight
      // reading between the same two points. Same start, same landing, same
      // clock, so the two arrive together; only the middle of the travel
      // differs, by the corner's own depth, on an element that is still
      // fading up while the turn is being made.
      const ride: ShotRide = {
        dx: bundle[0].left - seat0.left,
        dy: bundle[0].top - seat0.top,
        delay: gatherMs, // the stamp waits the gather out and rides the carry
      };
      holdDiagRecord("flight", {
        phase: "shot-launch", n, gather: gatherMs, bend: SHOT_BEND,
        dx: Math.round(ride.dx * 10) / 10,
        dy: Math.round(ride.dy * 10) / 10,
        toW: Math.round(seat0.width), toH: Math.round(seat0.height),
      });
      const settle = (phase: string): void => {
        // hand the seats back byte-clean: the flight was pure presentation, so
        // the landed thread must carry no trace of it
        for (const msg of msgs) {
          msg.style.removeProperty("opacity");
          if (!msg.getAttribute("style")) msg.removeAttribute("style");
        }
        shell.remove();
        holdDiagRecord("flight", { phase });
        flightSettled();
      };
      const t0 = performance.now();
      let carrying = false; // the gather's end, stamped once
      let turning = false; // the corner's start, likewise
      let risen = false; // and the rise's end, past which the travel is all sideways
      const step = (now: number): void => {
        raf = 0;
        if (!msgs[0].isConnected) return settle("shot-cancel"); // replay took the seats
        const at = shotLeg(now - t0, gatherMs, FLIGHT_MS);
        const p = flightEase(at.f);
        const onward = at.leg === "carry";
        // The L. One clock and one ease still, and this only reads which of
        // the two legs has spent how much of the one progress above: the rise
        // leads, the run follows, and they overlap so the corner is a curve.
        // The gather has no corner of its own, so it keeps the plain box.
        const bend = onward ? elbowPath(p) : null;
        if (onward && !carrying) {
          carrying = true;
          holdDiagRecord("flight", { phase: "shot-carry", at: Math.round(now - t0) });
        }
        // the two legs, timed on the device: when the run picks up and how
        // much rise was left under it, then when the rise is spent and how
        // much run had already been made. A session that says the L is not
        // reading has these two instants to argue from.
        if (bend && !turning && bend.across > 0) {
          turning = true;
          holdDiagRecord("flight", {
            phase: "shot-elbow", at: Math.round(now - t0), up: Math.round(bend.up * 100),
          });
        }
        if (bend && !risen && bend.up >= 1) {
          risen = true;
          holdDiagRecord("flight", {
            phase: "shot-across",
            at: Math.round(now - t0),
            across: Math.round(bend.across * 100),
          });
        }
        // Every read first, then every write. The carry's far end is re-read
        // each frame for the reason the bar morph re-reads its own: a second
        // send's pin and shift, or a reply landing mid-flight, moves the seat,
        // and this must land where the seat IS rather than where it was at
        // launch. Reading a seat between two box writes would make the browser
        // re-lay-out once per photo per frame, so the whole frame's rects are
        // taken in one pass before anything is written.
        const ends = onward ? msgs.map(seatOf) : bundle;
        fliers.forEach((f, i) => {
          const from = onward ? bundle[i] : f.square;
          const to = ends[i];
          // The cut and the picture behind it take the same path and the same
          // size fraction, so they stay concentric and the window never pans
          // over the picture: one object travelling, not a frame sliding on a
          // photograph.
          const cut = bend ? elbowBox(from, to, p, bend) : morphBox(from, to, p);
          // the whole picture's box: the oversized cover frame while the cut is
          // still a square, the seat itself once the cut has opened onto it
          const cover = coverBox(from, f.natW, f.natH);
          const box = bend
            ? elbowBox(cover, to, p, bend)
            : morphBox(cover, coverBox(to, f.natW, f.natH), p);
          const radius = onward
            ? morphCorners(thumbRadius, [seatRadius], p)[0]
            : thumbRadius;
          paint(f, box, cut, radius);
        });
        if (!at.done) {
          raf = requestAnimationFrame(step);
        } else {
          // the landed frame paints once, copies and rows now pixel-identical,
          // and only THEN the swap: settling in the write's own frame could
          // drop the landing frame under load and read as a snap
          raf = requestAnimationFrame(() => settle("shot-finish"));
        }
      };
      raf = requestAnimationFrame(step);
      return ride;
    },
  };
}

// iMessage send flight: the fresh bubble lifts out of the compose field and
// rises into its thread seat. The TEXT row rides the bar morph, the compose
// pill itself compressing into the bubble, and the PHOTO rows ride the strip
// morph above, gathering into one bundle and growing into their seats out of
// the squares they were staged in. Each leaves from where it actually was.
// The FLIP translate below (the bubble laid out in its final spot, instantly
// translated back to the field's rect, then released) is what remains for
// anything neither morph could take: a row with no morph armed, or a photo
// whose pixels had not landed by the time ↑ was pressed. Replayed and received
// bubbles keep their ordinary entrance. The flight must always play (standing
// order), with no reduced-motion gate. Every invocation leaves a trail record with
// the measured per-bubble dx/dy and the animation's start and finish/cancel,
// so a device session where nothing visibly moved shows WHY (near-zero deltas
// are themselves the finding).
function flyFromField(
  wrapper: HTMLElement,
  morph: FieldMorph | null = null,
  shotMorph: ShotMorph | null = null,
): void {
  const field = document.querySelector(".field");
  const msgs = wrapper.querySelectorAll<HTMLElement>(".msg");
  holdDiagRecord("flight", { phase: "invoke", msgs: msgs.length, field: field !== null });
  if (!field || !msgs.length) {
    morph?.cancel();
    shotMorph?.cancel();
    return;
  }
  const start = field.getBoundingClientRect();
  let flights = 0; // motions launched, of any kind, that the stamp can ride
  let rideDx = 0; // the first row's travel, for the stamp below
  let rideDy = 0;
  let rideDelay = FLIGHT_SLACK_MS;
  // the photos go first and go together: one object, one launch, so the ride
  // the stamp copies is the bundle's own travel rather than any single row's
  const shotRows = Array.from(msgs).filter((m) => m.classList.contains("shot"));
  if (shotMorph && shotRows.length) {
    const ride = shotMorph.launch(shotRows);
    if (ride) {
      flights++;
      rideDx = ride.dx;
      rideDy = ride.dy;
      // the morph drives its own frames from the launch instant, so it spends
      // no runway: a stamp riding it must not wait out the FLIP's slack either
      rideDelay = ride.delay;
    }
  }
  msgs.forEach((msg, i) => {
    if (morph && msg.classList.contains("text")) {
      morph.launch(msg);
      return;
    }
    if (shotMorph?.launched() && msg.classList.contains("shot")) return; // the strip morph has it
    const end = msg.getBoundingClientRect();
    const dx = start.right - end.right;
    const dy = start.top - end.top;
    if (!flights) {
      rideDx = dx;
      rideDy = dy;
      rideDelay = FLIGHT_SLACK_MS; // this one IS a FLIP, so it spends the runway
    }
    flights++;
    // Web Animations API, not a transition: the start state lives inside the
    // animation itself, so WebKit cannot coalesce the two style writes into
    // one and silently skip the motion (which is what killed the old
    // transition + double-rAF version on iOS). The beat and ease are shared
    // with the sibling shift (shift.ts) — one motion, no overshoot.
    // The clock gets FLIGHT_SLACK_MS of runway (shift.ts holds the
    // measurement): armed here mid-task, a zero-delay animation is already
    // two frames old at its first paint, and the backwards fill keeps the
    // true start on screen through the slack instead of skipping it.
    const anim = msg.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
      { duration: FLIGHT_MS, easing: FLIGHT_EASE, delay: FLIGHT_SLACK_MS, fill: "backwards" },
    );
    flightsUp++;
    // this translate holds the bubble below the content edge for the whole
    // beat, and scrollHeight counts it: registered so the at-bottom reading can
    // subtract it instead of reporting the reader hundreds of pixels from a
    // bottom he is sitting on (nearBottom)
    airborneRows.add(msg);
    holdDiagRecord("flight", {
      phase: "start", i, dx: Math.round(dx * 10) / 10, dy: Math.round(dy * 10) / 10,
    });
    anim.finished.then(
      () => {
        airborneRows.delete(msg);
        holdDiagRecord("flight", { phase: "finish", i });
        flightSettled();
      },
      () => {
        airborneRows.delete(msg);
        holdDiagRecord("flight", { phase: "cancel", i });
        flightSettled();
      },
    );
  });
  // The newborn gap stamp above a flying photo row rides that row's own
  // travel, fading from zero on the same clock and slack, in place of the
  // 10px newborn fade parked at its final seat: a stamp holding still over an
  // empty seat while its row crosses hundreds of pixels read as the stamp
  // arriving early, a fifth visible on its first frame. play() stands down
  // for it (stampRidesFlight, shift.ts), so this is its one entrance; the
  // wrapper is built by this send, so any stamp in it was born with it. Pure
  // presentation, like the ride itself: no flightsUp, no airborneRows (the
  // row beneath it already registers the deeper translate).
  // The ride is whichever motion took the photos: the strip morph's bundle
  // travel, which starts only after the gather and so waits the gather out in
  // place of the FLIP's runway, or the FLIP's own first row.
  const stamp = flights ? wrapper.querySelector<HTMLElement>(":scope > .stamp") : null;
  if (stamp) {
    stamp.animate(
      [
        { opacity: 0, transform: `translate(${rideDx}px, ${rideDy}px)` },
        { opacity: 1, transform: "none" },
      ],
      { duration: FLIGHT_MS, easing: FLIGHT_EASE, delay: rideDelay, fill: "backwards" },
    );
    holdDiagRecord("flight", {
      phase: "stamp-ride",
      dx: Math.round(rideDx * 10) / 10,
      dy: Math.round(rideDy * 10) / 10,
      delay: Math.round(rideDelay),
    });
  }
  if (morph && !morph.launched()) morph.cancel(); // no text row rendered: no seat to morph into
  if (shotMorph && !shotMorph.launched()) shotMorph.cancel(); // no photo row: nothing to land on
  recordSendMotion(msgs[msgs.length - 1]);
  recordTailGap(msgs[msgs.length - 1]);
}

// ===================== TEMP DIAGNOSTIC (remove after the hold session) =====================
// Send-window motion recorder, riding the same holddiag trail as the reply-hold
// probe (hold.ts explains the ring and the POST). From flight start until
// SEND_MOTION_WINDOW_MS after it, every animation frame compares the thread's
// scrollTop and scrollHeight and the flying bubble's landing-seat top — its
// rect with the running transform stripped, so the SEAT is measured, not the
// bubble flying toward it — against the previous frame; any move past 1px
// lands one send-motion record naming the mover, capped so a busy window
// cannot flood the ring. If the owner still sees end-of-send movement after
// the receipt hold, this trail names the frame and the moved quantity.

const SEND_MOTION_WINDOW_MS = 600; // the 400ms beat plus a landing tail
const SEND_MOTION_MAX = 40; // records per window, not frames
let sendMotionRaf = 0;

// the seat: the bubble's viewport top with every running translate stripped,
// its own flight transform and any FLIP riding an ancestor row alike — layout
// truth, not the bubble flying toward it. The strip walks to the thread so
// the sibling-shift's row transforms cannot masquerade as seat motion.
function seatTop(msg: HTMLElement): number {
  let top = msg.getBoundingClientRect().top;
  for (let el: HTMLElement | null = msg; el && el.id !== "thread"; el = el.parentElement) {
    const t = getComputedStyle(el).transform;
    if (t !== "none") top -= new DOMMatrixReadOnly(t).f;
  }
  return top;
}

function recordSendMotion(msg: HTMLElement): void {
  if (sendMotionRaf) cancelAnimationFrame(sendMotionRaf); // a rapid second send re-arms the window
  const t0 = performance.now();
  let recorded = 0;
  let prev: [number, number, number] | null = null;
  const step = (): void => {
    sendMotionRaf = 0;
    const t = document.getElementById("thread");
    if (!t || !msg.isConnected) return; // shell torn down, or a replay replaced the wrapper
    // the flight's own translate holds the bubble below the content edge, and
    // scrollHeight counts that transformed overflow (the send() collapse
    // comment has the history) — subtract the part poking past the thread's
    // own bottom padding, so the height channel reports only real layout
    // growth, not the flight deflating frame by frame
    const tr = getComputedStyle(msg).transform;
    const pad = parseFloat(getComputedStyle(t).paddingBottom) || 0;
    const overflow = tr === "none" ? 0 : Math.max(0, new DOMMatrixReadOnly(tr).f - pad);
    const cur: [number, number, number] = [t.scrollTop, t.scrollHeight - overflow, seatTop(msg)];
    if (prev) {
      (["scroll", "height", "seat"] as const).forEach((name, i) => {
        const delta = cur[i] - prev![i];
        if (Math.abs(delta) > 1 && recorded < SEND_MOTION_MAX) {
          recorded++;
          holdDiagRecord("send-motion", {
            at: Math.round(performance.now() - t0), moved: name,
            delta: Math.round(delta * 10) / 10,
          });
        }
      });
    }
    prev = cur;
    if (performance.now() - t0 < SEND_MOTION_WINDOW_MS) {
      sendMotionRaf = requestAnimationFrame(step);
    }
  };
  sendMotionRaf = requestAnimationFrame(step);
}
// =================== END TEMP DIAGNOSTIC (remove after the hold session) ===================

// ===================== TEMP DIAGNOSTIC (remove after the tail-gap session) =====================
// The white space after a send, measured where he sees it. viewport.ts
// (tailGapFrame) holds the arithmetic and why; this half only reads the DOM.
//
// Two readings per send, both after the 400ms flight has landed: one when the
// send window closes, one a second and a half later, because a photo that
// decodes late changes the thread's height after everything else has settled
// and the first reading alone could not tell the two apart.
//
// Nothing here writes. Every read is a getter, the walk stops at the thread,
// and no layout is flushed that the send was not going to flush anyway.
//
// Every element measured comes out of laidOutRows (viewport.ts), never off a
// direct child of the thread: those are .evt wrappers, display: contents gives
// them no box, and reading geometry off one manufactures a screen-tall gap on
// any thread at all. That number would have looked exactly like his bug.

const TAIL_GAP_AT_MS = [SEND_MOTION_WINDOW_MS, 2100] as const;
const tailGapTimers: number[] = [];

// the bottom of a laid-out row in the thread's content coordinates, every
// running translate stripped: seatTop already walks the ancestors for the
// flight and the sibling shift, so the seat plus the row's own height is where
// that row truly ends, whatever is mid-animation on top of it
function seatBottom(t: HTMLElement, row: HTMLElement): number {
  return seatTop(row) - t.getBoundingClientRect().top + t.scrollTop + row.offsetHeight;
}

// what is sitting under the message this send just landed, named the way a
// reader can act on it. The dots are the case worth catching, so nothing is
// filtered out: an agent composing under his newest bubble is real occupied
// room and a genuine answer, not noise. null means nothing sits below and any
// gap belongs to the thread's own box rather than to a row.
function firstBelow(t: HTMLElement, rows: HTMLElement[], sent: number): string | null {
  for (const row of rows) {
    if (seatBottom(t, row) > sent + 1) return rowName(row);
  }
  return null;
}

// The same reading, taken at a moment nothing was sent: the band is measured
// from the LAST row rather than from a bubble this send just landed, which is
// the only difference. Timed the same way, so a close is described over the
// same stretch a send is and the two can be read side by side.
function recordTailGapNow(when: string): void {
  while (tailGapTimers.length) clearTimeout(tailGapTimers.pop());
  TAIL_GAP_AT_MS.forEach((delay, i) => {
    tailGapTimers.push(
      window.setTimeout(() => {
        const t = document.getElementById("thread");
        if (!t) return; // shell torn down
        const rows = laidOutRows(t).filter((el): el is HTMLElement => el instanceof HTMLElement);
        const last = rows[rows.length - 1];
        if (!last) return; // nothing to measure a band from
        const floor = seatBottom(t, last);
        holdDiagRecord(
          "tail-gap",
          tailGapFrame(i === 0 ? when : `${when}-late`, {
            sh: () => t.scrollHeight,
            st: () => t.scrollTop,
            ch: () => t.clientHeight,
            pad: () => parseFloat(getComputedStyle(t).paddingBottom),
            air: () => flightInflation(t),
            lastBottom: () => floor,
            rows: () => rows.length,
            // measured from the last row's own floor, so "below" names anything
            // standing under it rather than under a bubble that was just sent
            below: () => firstBelow(t, rows, floor),
          }),
        );
        // The band OUTSIDE the conversation. Every reading above describes the
        // room under the last message INSIDE the scroller, and across his whole
        // reproduction every one of them came back at three tenths of a pixel
        // while he was looking at hundreds of pixels of white. So the white is
        // not in there, and the only place left for it is between where the
        // scroller's own box ends on screen and where the compose bar begins.
        // Nothing has ever measured that, which is why the app keeps insisting
        // it is fine: it is telling the truth about the wrong thing.
        const bar = document.querySelector<HTMLElement>(".bar");
        const box = t.getBoundingClientRect();
        const barBox = bar?.getBoundingClientRect() ?? null;
        const one = (n: number): number | null =>
          Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
        holdDiagRecord("tail-gap", {
          when: `${when}-edges`,
          // the white he can see, if this is where it is
          white: barBox ? one(barBox.top - box.bottom) : null,
          threadTop: one(box.top),
          threadBot: one(box.bottom),
          barTop: barBox ? one(barBox.top) : null,
          barBot: barBox ? one(barBox.bottom) : null,
          // and what the screen itself says, so a shell sitting in the wrong
          // place is told apart from a shell that is right and short
          vvH: one(window.visualViewport?.height ?? NaN),
          vvTop: one(window.visualViewport?.offsetTop ?? NaN),
          ih: window.innerHeight,
        });
      }, delay),
    );
  });
}

function recordTailGap(msg: HTMLElement): void {
  while (tailGapTimers.length) clearTimeout(tailGapTimers.pop()); // a second send re-arms
  TAIL_GAP_AT_MS.forEach((delay, i) => {
    tailGapTimers.push(
      window.setTimeout(() => {
        const t = document.getElementById("thread");
        if (!t || !msg.isConnected) return; // shell torn down, or a replay took the row
        // one walk for all three row questions, so every field in the record
        // describes the same instant
        const rows = laidOutRows(t).filter((el): el is HTMLElement => el instanceof HTMLElement);
        const last = rows[rows.length - 1];
        const floor = last ? seatBottom(t, last) : NaN; // no rows at all: null, not a zero
        // the seat of the bubble this send landed, which is what "under the
        // last message" is measured from; the row holds it, so the row is the
        // laid-out box to ask
        const seat = msg.closest<HTMLElement>(".row") ?? msg;
        const sent = seatBottom(t, seat);
        holdDiagRecord(
          "tail-gap",
          tailGapFrame(i === 0 ? "settle" : "late", {
            sh: () => t.scrollHeight,
            st: () => t.scrollTop,
            ch: () => t.clientHeight,
            pad: () => parseFloat(getComputedStyle(t).paddingBottom),
            air: () => flightInflation(t),
            lastBottom: () => floor,
            rows: () => rows.length,
            below: () => firstBelow(t, rows, sent),
          }),
        );
      }, delay),
    );
  });
}
// =================== END TEMP DIAGNOSTIC (remove after the tail-gap session) ===================

// ===================== TEMP DIAGNOSTIC (remove after the cold-open session) =====================
// Boot-window motion recorder, riding the holddiag trail like the send-window
// one above. The 4-of-5 cold-open drop is the app frame settling after the
// cached paint, and only the device knows WHICH quantity settles late: from
// module init until BOOT_MOTION_TAIL_MS past the first content paint, every
// animation frame reads the shell box, the safe-area paddings as consumed
// (computed style on the header and compose bar, where env() actually lands),
// the document and thread scroll positions, the thread's scrollHeight, the
// first message's viewport top, and the visual viewport's offset and height.
// Any channel that moved past 1px lands one boot-motion record naming the
// mover and the distance, capped so a busy boot cannot flood the ring — the
// next device session's deploy logs then name the culprit precisely.

const BOOT_MOTION_TAIL_MS = 2000; // sampling continues this long past first content
const BOOT_MOTION_LEAD_MAX_MS = 15000; // content never painted (token gate): stop
const BOOT_MOTION_MAX = 60; // records for the whole window, not frames

function bootMotionChannels(): Record<string, number | null> {
  const shell = document.getElementById("app");
  const box = shell ? shell.getBoundingClientRect() : null;
  const bar = document.querySelector(".bar");
  const compose = document.getElementById("compose");
  const thread = document.getElementById("thread");
  // .evt wrappers are display:contents (no box of their own): the first
  // LAID-OUT descendant — the stamp or row the first message paints — is the
  // honest "where does content start" reading
  const first = thread?.querySelector(".evt > *");
  const vv = window.visualViewport;
  return {
    "shell-top": box ? box.top : null,
    "shell-h": box ? box.height : null,
    "inset-top": bar ? parseFloat(getComputedStyle(bar).paddingTop) : null,
    "inset-bottom": compose ? parseFloat(getComputedStyle(compose).paddingBottom) : null,
    "doc-scroll": window.scrollY,
    "thread-scroll": thread ? thread.scrollTop : null,
    "thread-sh": thread ? thread.scrollHeight : null,
    "first-msg-top": first ? first.getBoundingClientRect().top : null,
    "vv-top": vv ? vv.offsetTop : null,
    "vv-h": vv ? vv.height : null,
  };
}

function startBootMotion(): void {
  if (typeof document === "undefined" || document.getElementById("app") === null) return;
  const t0 = performance.now();
  let contentAt = 0;
  let recorded = 0;
  let prev: Record<string, number | null> | null = null;
  const step = (): void => {
    const nowMs = performance.now();
    if (!contentAt && document.querySelector("#thread .evt")) contentAt = nowMs;
    const cur = bootMotionChannels();
    if (prev) {
      for (const [name, v] of Object.entries(cur)) {
        const was = prev[name];
        if (v === null || was === null || was === undefined) continue; // channel absent: not motion
        const delta = v - was;
        if (Math.abs(delta) > 1 && recorded < BOOT_MOTION_MAX) {
          recorded++;
          holdDiagRecord("boot-motion", {
            at: Math.round(nowMs - t0), moved: name,
            delta: Math.round(delta * 10) / 10, v: Math.round(v * 10) / 10,
          });
        }
      }
    }
    prev = cur;
    const done = contentAt
      ? nowMs - contentAt > BOOT_MOTION_TAIL_MS
      : nowMs - t0 > BOOT_MOTION_LEAD_MAX_MS;
    if (!done) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
startBootMotion();
// =================== END TEMP DIAGNOSTIC (remove after the cold-open session) ===================

// --- send-time sibling shift (the white-strip fix; shift.ts holds the why) ----
// The instant bottom pin on a send teleports the older content up by the new
// bubble's height while the bubble is still down at the field — a bare strip
// under the older message for the whole flight. FLIP over the preceding rows:
// each candidate's position is measured BEFORE the insert (with any mid-shift
// transform still applied, so a second rapid send starts every row from where
// it visually is), the running shift set is cancelled, the insert and the pin
// land, positions are measured again, and each row that moved animates from
// its old spot to its new one on the flight's own beat and ease.

const SHIFT_MAX_TARGETS = 40; // a couple of screens; the shift is a tail affair

let shiftAnims: Animation[] = [];

// the elements the thread actually lays out (the .evt wrappers are
// display:contents shells): rows, stamps, receipts, failure labels, spinner,
// dots. Walked newest-first from the tail, bounded — the shift only ever
// concerns the last screen or two.
function laidOutTail(): HTMLElement[] {
  const out: HTMLElement[] = [];
  let n = threadEl().lastElementChild;
  for (; n && out.length < SHIFT_MAX_TARGETS; n = n.previousElementSibling) {
    if (!(n instanceof HTMLElement)) continue;
    if (n.classList.contains("evt")) {
      for (let i = n.children.length - 1; i >= 0 && out.length < SHIFT_MAX_TARGETS; i--) {
        const c = n.children[i];
        if (c instanceof HTMLElement) out.push(c);
      }
    } else {
      out.push(n);
    }
  }
  return out;
}

// entrance for elements BORN with the motion (no before-rect to FLIP from):
// the newborn fades up into the space the glide opened, on the flight's own
// beat and ease, so nothing materializes at full size mid-animation. Created
// in the same task as the insert, so the element never paints pre-animation
// (the same WebKit-proof property flyFromField leans on). Its LAYOUT space
// still opens in one frame — the glide above covers it while the occupant
// fades in, so the space itself is never bare.
function enterNewborn(el: HTMLElement): void {
  el.animate(
    [
      { opacity: 0, transform: `translateY(${ENTER_RISE_PX}px)` },
      { opacity: 1, transform: "none" },
    ],
    { duration: FLIGHT_MS, easing: FLIGHT_EASE },
  );
}

// whether a newborn stamp stands over a photo row born with the same send:
// that row is about to fly and the flight carries the stamp with it
// (flyFromField), so the newborn enter must leave it alone. Newborn means
// absent from the measure pass, which only ever happens to elements this
// send's own insert created.
function stampOverNewbornShot(el: HTMLElement, before: Map<HTMLElement, number>): boolean {
  if (!el.classList.contains("stamp")) return false;
  const wrapper = el.parentElement;
  if (!wrapper) return false;
  return Array.from(wrapper.querySelectorAll<HTMLElement>(":scope > .row")).some(
    (row) => !before.has(row) && row.querySelector(".msg.shot") !== null,
  );
}

function beginSiblingShift(): { play(): void } {
  // eligibility is the pre-send view: pinned (or near) the bottom. A send from
  // deep in history pins with an intentional jump cut — animating THAT would
  // turn the instant pin into a slow scroll of the whole distance.
  const eligible = followTail || nearBottom();
  const before = new Map<HTMLElement, number>();
  if (eligible) {
    for (const el of laidOutTail()) before.set(el, el.getBoundingClientRect().top);
  }
  // measured first, cancelled second: the before-tops keep the mid-flight
  // visual truth, and everything from here through play() is one synchronous
  // task — nothing paints in the cancelled state
  for (const a of shiftAnims) a.cancel();
  shiftAnims = [];
  return {
    play(): void {
      if (!eligible) {
        holdDiagRecord("flight", { phase: "shift-skip", reason: "away" });
        return;
      }
      const view = threadEl().getBoundingClientRect();
      let maxDelta = 0;
      let rows = 0;
      let entered = 0;
      // the walk starts at the true tail, not above the send's wrapper: the
      // newborn stamp decorate() just created lives INSIDE it, above the
      // flying rows, and send() is synchronous from measure through play, so
      // everything unseen at measure time was born with this send
      for (const el of laidOutTail()) {
        const beforeTop = before.get(el);
        // flight cargo: the flying rows themselves, and the newborn stamp a
        // photo flight carries with it (stampRidesFlight, shift.ts)
        const carriesFlight =
          el.classList.contains("msg") ||
          el.querySelector(".msg") !== null ||
          stampRidesFlight(
            beforeTop !== undefined,
            el.classList.contains("stamp"),
            stampOverNewbornShot(el, before),
          );
        if (newbornEnter(beforeTop !== undefined, carriesFlight)) {
          enterNewborn(el); // born with this send: it fades up on the same beat
          entered++;
          continue;
        }
        if (beforeTop === undefined) continue; // the flying rows: the flight owns them
        const r = el.getBoundingClientRect();
        const delta = beforeTop - r.top;
        if (!shiftParticipates(r.top, r.bottom, delta, view.top, view.bottom)) continue;
        shiftAnims.push(el.animate(
          [{ transform: `translateY(${delta}px)` }, { transform: "none" }],
          { duration: FLIGHT_MS, easing: FLIGHT_EASE },
        ));
        if (delta > maxDelta) maxDelta = delta;
        rows++;
      }
      holdDiagRecord("flight", {
        phase: "shift-start", delta: Math.round(maxDelta * 10) / 10, rows,
      });
      holdDiagRecord("flight", { phase: "enter", n: entered });
    },
  };
}

// client-local bubbles (optimistic sends, network-failure notices) live in
// unkeyed .evt wrappers at the tail — outside the store unless ACKed into it
function localWrapper(role: string): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "evt";
  wrapper.dataset.ts = String(Date.now());
  wrapper.dataset.role = role;
  threadEl().appendChild(wrapper);
  // a send during visible dots must stack under the previous message with the
  // dots below it, not land beneath them — same-frame reorder (dots.ts)
  moveTypingAfter(threadEl(), wrapper);
  return wrapper;
}

function localBubble(role: string, cls: string, text: string): void {
  const w = localWrapper(role);
  rowEl(w, role, cls, Date.now()).textContent = text;
  decorate();
  if (role === "user") setFollowTail(true, "local-user");
  if (followTail) scrollToBottom();
}

// --- the sent photo's seat, reserved before the row lands ---------------------
// A photo row inserted with no size is zero tall until its pixels decode, and
// send() pins the thread to the bottom immediately after the insert, so that pin
// used to land on a bubble that had not grown yet; the decode then grew the row
// downward and the photo came to rest as a thin top sliver under the compose
// bar. The file's own size is therefore in hand FIRST, read off the element the
// tray has already been loading, so the row can be laid out at full height
// before anything measures, pins, or flies.
//
// The SIZE and the PIXELS are two different arrivals, and only the size has to
// be here. A file reports its size the moment it is READ, which on a local blob
// url is quick; turning twelve megapixels into something paintable is the slow
// half, and it is the half the row can go without. So send() reserves the seat
// from whatever the element has read and inserts the row on the spot, and the
// photo joins it in place — no wait of any kind between the tap and the bubble.
//
// The blank that used to sit in that bubble is now a PLACEHOLDER instead. The
// element wears the thread's own not-arrived mark from the frame it is made
// (WAIT_CLASS below), which is the same grey face and ring the tray's waiting
// square wears and the same one every history photo wears before it loads, so a
// bubble whose photo has not drawn yet reads as waiting rather than as nothing.
// That is what let the wait go: send() used to hold the whole task for up to
// 350ms hoping for pixels, miss on every camera photo, and then show the empty
// frame anyway — the lag he reported between the tray vanishing and the photo
// appearing was that deadline, spent to no purpose.
//
// A file that never reports a size at all falls back to the old unsized
// behaviour, re-pinning when the pixels land like every other photo kind. Every
// outcome lands on the flight trail, so a device session says whether the seat
// was reserved and at what size.

// the file's own pixels, or null when the image has not reported them; read at
// the moment the row is built rather than when the wait ended, so a photo whose
// send outran its read still gets its exact seat if the read has since landed
function naturalSize(img: HTMLImageElement): [number, number] | null {
  return img.naturalWidth > 0 && img.naturalHeight > 0
    ? [img.naturalWidth, img.naturalHeight]
    : null;
}

/** the one element a picked photo's pixels land in, and the one wait for them */
interface Shot {
  img: HTMLImageElement;
  drawn: Promise<DrawWhy>;
}

// The element a picked photo lives in for its whole life on this device: the
// tray's thumbnail, and then — the same node, moved, never copied — the photo in
// the sent bubble. Two elements over one blob url meant two decodes of the same
// twelve megapixels running against each other (photobox.ts has the device
// numbers); one element means one, started as early as the pick and finished
// wherever the photo happens to be standing by then.
function prepareShot(url: string): Shot {
  const img = document.createElement("img");
  // the thread's own not-arrived mark, worn from the frame the element exists:
  // whichever box it is standing in while the pixels are missing — the tray's
  // square or a bubble the send has already built around it — paints the grey
  // face and the shared ring over it instead of showing a blank (styles.css)
  img.classList.add(WAIT_CLASS);
  // Decode off the main thread, always. A send seats this element in the
  // thread while its pixels may still be cooking, and WebKit's default there
  // is to decode AT the paint, synchronously: on device the attach froze the
  // main thread 220-240ms mid-flight (the attach's own pixel work, not the
  // network). The placeholder above stands until whenDrawn settles either
  // way, so async decoding changes which thread does the work and nothing
  // about what shows: the seat is reserved, the mark says coming, and the
  // pixels land exactly when they always did.
  img.decoding = "async";
  img.src = url;
  const started = performance.now();
  const drawn = whenDrawn(img, DRAW_NO_DEADLINE).then((why) => {
    const jankT0 = performance.now(); // TEMP DIAGNOSTIC (scroll-jank): the pixels' landing runs main-thread work here
    // the mark comes off wherever the element now stands, tray or thread: this
    // is the one moment a picked photo stops being a placeholder in both places
    img.classList.remove(WAIT_CLASS);
    const nat = naturalSize(img);
    // ms and seat are what a deadline used to say by settling "late": how long
    // the pixels really took, and whether the send had already carried them into
    // the thread by the time they arrived
    holdDiagRecord("flight", {
      phase: "shot-dims", why, w: nat ? nat[0] : 0, h: nat ? nat[1] : 0,
      ms: Math.round(performance.now() - started),
      seat: img.closest(".msg") ? "thread" : "tray",
    });
    jankSpan("shot-drawn", jankT0); // TEMP DIAGNOSTIC (scroll-jank)
    return why;
  });
  return { img, drawn };
}

// the width one .row spans: the thread's content box, since rows are its direct
// flex children (the .evt wrappers are display:contents and have no box)
function threadContentWidth(): number {
  const t = threadEl();
  const cs = getComputedStyle(t);
  return t.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
}

// when the last send's flight left the field: a send composing onto a still-
// airborne flight must stay one synchronous composition (see send()), while a
// fresh send may wait out the composer collapse first
let lastLaunchAt = -Infinity;

async function send(): Promise<void> {
  const textEl = document.getElementById("text") as HTMLTextAreaElement;
  const sendBtn = document.getElementById("sendbtn") as HTMLButtonElement;
  const text = textEl.value.trim();
  const files = [...pendingFiles];
  if (!text && files.length === 0) return;

  // the photos: the very elements the tray has been drawing since each pick, one
  // decode apiece and not one started here. Taken before the tray is cleared out
  // from under them, and carried straight into the rows below — nothing in this
  // function waits on a pixel (prepareShot has the whole story)
  const shots = files.map(takeShot);

  // the take-back: a reply still held unseen when he sends must vanish for
  // good — the send outran it, and the rerun's next reply answers everything.
  // take() hands the parked frames over UNRENDERED and zeroes the composing
  // clock exactly as flush() did (the textarea clear below fires no input
  // event; a reply arriving moments later must render immediately). The taken
  // seqs ride the send body so the server deletes the rows; they re-render
  // only if the send fails (below), because then the server never took them.
  const taken = replyHold.take();
  const retractSeqs = taken.map(([seq]) => seq);
  if (retractSeqs.length) holdDiagRecord("retract-sent", { seqs: retractSeqs });

  // clear the field and collapse the auto-grown bar (and the pending tray)
  // through the one compensated path; called at a branch-dependent moment
  const collapseBar = (): void => {
    composerWroteAt = performance.now(); // the clear's selectionchange is ours, not composing
    textEl.value = "";
    autosize();
    pendingFiles = [];
    dismissSent(); // the strip closes on the flight's beat, squares aboard, out of the layout
  };

  // WHEN the bar collapses is the mid-flight drag fix. On a FRESH launch it
  // collapses BEFORE anything measures: collapsing after the launch shrank a
  // multi-line composer mid-flight (82 -> 39 on device) and the pin riding
  // that resize slid the fresh bubble's seat 51px underneath it — the landing
  // read as a drag. And when the bar actually resized, take off on the frame
  // after next: the threadObserver re-pin for the resize is delivered after
  // the launch frame's rAF callbacks, and by then the flight transform holds
  // the bubble below the content edge — scrollHeight counts transformed
  // overflow, so that pin overshoots by the bubble's translate and the
  // shrinking overflow then drags the pinned scroller (the seat) for the rest
  // of the flight (Chrome traces in /tmp/m217-evidence/). Two rAFs put the
  // collapse's paint and its honest re-pin fully before the launch, so no
  // bottom pin fires while the bubble is in the air. One-line sends are
  // untouched (39 -> 39, no height write, no pin, no wait).
  //
  // Composing onto a still-AIRBORNE flight (a rapid second send) instead
  // keeps the whole task in the shipped order, collapse after the launch:
  // a collapse landing between the measure and the launch would lower the
  // field AND shrink the sibling deltas, opening a band between the riding
  // first bubble and the departing second one (measured at ~2x the bar
  // delta); the deferred collapse's own re-pin residue is bounded by the
  // remaining translate and decays with it.
  const airborne = performance.now() - lastLaunchAt < FLIGHT_MS;
  // the morph shell snapshots the bar BEFORE the collapse empties it — rect,
  // pill, and the typed text, standing over the field — so the collapse (and
  // its re-pin wait) happens beneath the shell and no bare-field frame ever
  // paints; the launch itself still runs after the collapse, in the insert
  // task below. The bar carried the text and never the photos, so it morphs
  // for the text alone.
  const morph = text ? armFieldMorph(textEl) : null;
  // the photos' own shell, snapshotted for the same reason and in the same
  // breath: the strip's squares have to be measured while they are still in
  // the strip, since collapseBar takes it out of the layout. A send carrying
  // both arms both, and each object then leaves from where it actually was.
  const shotMorph = files.length ? armShotMorph(files) : null;
  if (!airborne) {
    const fieldHBefore = textEl.offsetHeight;
    collapseBar();
    if (textEl.offsetHeight !== fieldHBefore || files.length > 0) {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
  }

  // from here down send() is one synchronous task (measure, insert, pin,
  // launch). It used to open with a wait on the photos' own pixels, and that
  // wait is what he felt as the lag between the tray vanishing and the bubble
  // arriving: a 12MP camera photo missed its deadline every time, so the tap
  // bought a blank frame and a beat of nothing to look at. The rows go up now
  // with whatever their elements have — the seat below if the file has been
  // read, the placeholder either way — and the pixels join them in place.
  const rowW = files.length ? threadContentWidth() : 0;

  // the white-strip fix measures the older content BEFORE anything is
  // inserted; the pin below fires first, then play() starts the transforms
  const shift = beginSiblingShift();

  // INSTANT feedback on tap: one optimistic wrapper appears immediately; the
  // uploads/POST happen behind it. On ACK the wrapper adopts the server seq,
  // so a later replay of the same event no-ops instead of duplicating.
  // suppressAnim while rendering: the send flight below owns the entrance —
  // the pop-in animation would fight its transform.
  const prevSuppress = suppressAnim;
  suppressAnim = true;
  const w = localWrapper("user");
  for (const img of shots) {
    const div = rowEl(w, "user", "shot", Date.now());
    const nat = naturalSize(img);
    if (nat) {
      // the seat: the aspect ratio through the width/height attributes (the
      // stylesheet's height:auto reads it) and the used width from the bubble's
      // share of the row. That is the box the photo still occupies once it
      // paints, so the pin below has nothing left to grow past.
      const box = photoBox(nat[0], nat[1], rowW);
      img.width = nat[0];
      img.height = nat[1];
      img.style.width = `${box.width}px`;
      holdDiagRecord("flight", {
        phase: "shot-reserve",
        w: Math.round(box.width * 10) / 10, h: Math.round(box.height * 10) / 10,
      });
    } else {
      // The file has not even been READ yet, which now means a send within a
      // frame or two of the pick rather than a decode that ran long. Nothing to
      // reserve: the old unsized row, whose late growth re-pins the bottom the
      // way every other photo kind does. The placeholder has no box to paint in
      // either until that read lands, so this row is briefly the empty one the
      // reserved rows above never are — the one case where there is genuinely
      // nothing yet to describe.
      img.onload = () => {
        if (followTail) scrollToBottom(true);
      };
    }
    img.addEventListener("click", () => openLightbox(img.src, img));
    div.appendChild(img);
  }
  if (text) rowEl(w, "user", "text", Date.now()).textContent = text;
  suppressAnim = prevSuppress;
  decorate();
  setFollowTail(true, "send"); // sending snaps you to the tail
  scrollToBottom(true); // instant pin first; the transforms below play over it
  shift.play(); // preceding rows glide, newborn stamps fade up: no white strip, no pop
  flyFromField(w, morph, shotMorph);
  lastLaunchAt = performance.now();
  if (airborne) collapseBar(); // the shipped order when a flight is already up

  sendBtn.disabled = true; // no double-fire while the network work runs
  try {
    await transmit(w, text, files, retractSeqs);
  } finally {
    sendBtn.disabled = false;
  }
  // the send FAILED (every transmit failure path lands in markFailed, which
  // registers the wrapper): the server never took the held replies back, so
  // they render after all — ABOVE the failed bubble, the same reply-then-
  // failure order a reload rebuilds (history replays the reply; the failed
  // send restores below it). applyEvent appends the keyed reply at the tail,
  // so the unkeyed failed wrapper is re-appended after it to restore order.
  if (taken.length && failedSends.has(w)) {
    for (const [seq, frame] of taken) {
      holdDiagRecord("render", { seq, route: "send-fail" });
      applyEvent(frame);
    }
    threadEl().appendChild(w);
    decorate();
    if (followTail) scrollToBottom();
  }
}

// The network half of a send — uploads, then POST /api/send — shared by the
// first attempt and every Try Again, so a retry takes the exact same path,
// frame adoption included. Any failure marks the wrapper failed (iMessage
// treatment below) instead of raising a separate error bubble; the typed text
// and File objects stay held for the next retry. retractSeqs ride the FIRST
// attempt only: a retry follows a failure, and the failure path already
// rendered the held replies (the server still has their rows).
async function transmit(
  w: HTMLElement, text: string, files: File[], retractSeqs: number[] = [],
): Promise<void> {
  const keys: string[] = [];
  for (const file of files) {
    const fd = new FormData();
    fd.append("file", file);
    let r: Response;
    try {
      r = await fetch("/api/upload", { method: "POST", headers: authHeaders(), body: fd });
    } catch {
      return markFailed(w, text, files);
    }
    if (!r.ok) return markFailed(w, text, files);
    keys.push((await r.json()).inbox_key);
  }
  let resp: Response;
  try {
    resp = await fetch("/api/send", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        thread_id: THREAD_ID, text, attachments: keys, retract_seqs: retractSeqs,
      }),
    });
  } catch {
    return markFailed(w, text, files);
  }
  if (!resp.ok) return markFailed(w, text, files);
  // the server accepted this send: drop any durable failed-copy for this wrapper
  // and release its tail-pinning marker (it is a real keyed bubble now)
  if (w.dataset.outboxId) void outboxDelete(w.dataset.outboxId);
  w.classList.remove("restored");
  // the ACK is the finished frame, the same one history returns for this seq
  // (enrich.ts holds the guard that says so), with status riding beside it
  const ack = (await resp.json()) as ServerMsg & { status?: string };
  const seq = ack.seq;
  if (seq) {
    if (store.has(seq)) {
      w.remove(); // a reconnect replay beat the ACK; the keyed wrapper won
      decorate();
    } else {
      // upgrade in place: the optimistic wrapper becomes the event's wrapper
      w.dataset.seq = String(seq);
      // store the server's own row: its attachment_dims and
      // attachment_blurhashes are already on it, so a photo send needs no
      // read-back, and its ts is the server clock every other frame is
      // stamped by, so this row sorts and clusters with them on the next boot
      const served: ServerMsg | null = ackFrame(ack);
      if (served) store.set(seq, served);
      else {
        // deploy skew: a client kept in the service worker's cache can outlive
        // the server that grew the frame. A frameless answer is never stored,
        // so fall back to what this path did before: synthesize the frame and
        // read the real one back. This is the last CLIENT clock ts in the app,
        // and only a photo send heals it, because the read-back is a richer
        // frame and a text-only one has nothing for the merge to gain on.
        store.set(seq, {
          seq, role: "user", payload: text, attachments: keys,
          ts: new Date().toISOString(),
        });
      }
      if (seq > lastSeq) lastSeq = seq; // our own message: don't re-replay it
      if (oldestSeq === 0 || seq < oldestSeq) oldestSeq = seq;
      cacheWrites.bump(); // the ACKed send enters the cold-open snapshot like any applied frame
      if (!served && keys.length) void adoptServerFrame(seq); // skew fallback only
    }
  }
  updateReceipt(); // the server has it: the stored row now derives Delivered
}

// The read-back half of a photo send against an OLD server, the only caller
// left now that the ACK carries the frame. Such a server answers with the seq
// alone, and the socket never echoes your own message (lastSeq already covers
// it, so no replay ever re-delivers it either): its complete frame, attachment
// sizes and blurhashes included, exists only behind the history endpoint the
// client already pages with. One exact-row fetch, routed through the same
// enrich rule as any richer re-delivery. Best-effort: on failure the next
// connect's reconcile page gets the same chance.
async function adoptServerFrame(seq: number): Promise<void> {
  let messages: ServerMsg[];
  try {
    const r = await fetch(`/api/history/${THREAD_ID}?before=${seq + 1}&limit=1`, {
      headers: authHeaders(),
    });
    if (!r.ok) return;
    ({ messages } = (await r.json()) as { messages: ServerMsg[] });
  } catch {
    return;
  }
  const m = messages.find((f) => f.seq === seq);
  if (m) enrichStored(m);
}

// --- failed sends (iMessage): the bubble STAYS, marked by a red !-in-circle
// to its right and a small red "Not Delivered" underneath. The payload (text +
// File objects) is held in memory, keyed by the wrapper, so each failed send
// retries independently, and is mirrored to an on-disk outbox (outbox.ts) keyed
// by a stable id, so it now also survives closing the app: on the next open the
// records are read back and rebuilt as failed bubbles (see restoreOutbox).

const failedSends = new Map<HTMLElement, { id: string; text: string; files: File[] }>();

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `ob-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// persist a failed send's bytes for durability across an app close. Fire and
// forget: reading the File bytes or the IndexedDB write can fail on iOS, and a
// failed persist must never break the in-memory failed-send UI above it.
function persistFailed(id: string, ts: number, text: string, files: File[]): void {
  void (async () => {
    try {
      const stored: OutboxRecord["files"] = [];
      for (const f of files) {
        stored.push({ name: f.name, type: f.type, buf: await f.arrayBuffer() });
      }
      await outboxPut({ id, text, files: stored, ts });
    } catch {
      /* storage is best-effort; the in-memory failed send still stands */
    }
  })();
}

function markFailed(w: HTMLElement, text: string, files: File[]): void {
  // stable id per logical failed send, reused across retries (kept on the
  // wrapper so a re-failure overwrites its record rather than duplicating it)
  const id = w.dataset.outboxId ?? newId();
  w.dataset.outboxId = id;
  failedSends.set(w, { id, text, files });
  // persist with the wrapper's own send time so a restored record keeps its
  // original timestamp instead of drifting forward on each re-persist
  persistFailed(id, Number(w.dataset.ts) || Date.now(), text, files);
  w.classList.add("failed");
  if (w.querySelector(".sendfail-badge")) return; // already marked (re-failure)
  // badge on the last bubble's row, absolutely positioned in the column the
  // .failed row padding frees — no flex children, so bubble geometry holds.
  // No entrance animation: the badge just appears, like the reference.
  const rows = w.querySelectorAll<HTMLElement>(":scope > .row");
  const lastRow = rows[rows.length - 1];
  if (!lastRow) return;
  const badge = document.createElement("button");
  badge.type = "button";
  badge.className = "sendfail-badge";
  badge.textContent = "!";
  badge.setAttribute("aria-label", "Not Delivered — options");
  badge.addEventListener("click", () => openFailSheet(w));
  lastRow.appendChild(badge);
  const label = document.createElement("div");
  label.className = "sendfail";
  label.textContent = "Not Delivered";
  label.addEventListener("click", () => openFailSheet(w));
  w.appendChild(label);
  if (followTail) scrollToBottom(); // the label adds height under the bubble
}

// drops the failure UI and the held payload — used by a successful/in-flight
// retry (transmit re-marks if it fails again) and by Delete
function clearFailed(w: HTMLElement): void {
  const id = w.dataset.outboxId; // kept on the wrapper so a re-failure reuses it
  if (id) void outboxDelete(id); // drop the durable copy alongside the in-memory one
  failedSends.delete(w);
  w.classList.remove("failed");
  w.querySelector(".sendfail-badge")?.remove();
  w.querySelector(":scope > .sendfail")?.remove();
}

function retrySend(w: HTMLElement): void {
  const held = failedSends.get(w);
  if (!held) return;
  clearFailed(w); // badge/label hide while the retry is in flight
  void transmit(w, held.text, held.files); // success adopts the seq; failure re-marks
}

function deleteFailed(w: HTMLElement): void {
  clearFailed(w);
  // release the object URLs backing the optimistic image previews
  w.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
    if (img.src.startsWith("blob:")) URL.revokeObjectURL(img.src);
  });
  w.remove();
  decorate();
  settleContent("delete"); // the failed bubble and its badge left from the tail
}

// --- durable outbox restore: a prior session's failed sends -------------------
// On boot (and re-login) the persisted failed sends are read back and rebuilt as
// failed bubbles at the tail, reusing the optimistic-bubble body and the same
// markFailed treatment. Marked .restored so applyEvent keeps replayed history
// and live frames above them; Try Again and Delete then behave exactly as for a
// live failed send, and Try Again reuses the same transmit path (seq/ACK
// adoption included) so a restored retry cannot double-send.
async function restoreOutbox(): Promise<void> {
  if (restoredOutbox) return; // once per session; a reconnect must not re-add them
  restoredOutbox = true;
  let records: OutboxRecord[];
  try {
    records = await outboxGetAll();
  } catch {
    return; // a broken or unavailable store must never block boot
  }
  if (!records.length || !document.getElementById("thread")) return;
  records.sort((a, b) => a.ts - b.ts); // oldest first: appended in order at the tail
  const prevSuppress = suppressAnim;
  suppressAnim = true; // a batch of restored bubbles must not pop one by one
  for (const rec of records) {
    const files = rec.files.map((f) => new File([f.buf], f.name, { type: f.type }));
    const w = localWrapper("user");
    w.classList.add("restored");
    w.dataset.outboxId = rec.id; // reuse the stored id, not a fresh one
    w.dataset.ts = String(rec.ts); // markFailed re-persists with this same ts (no drift)
    for (const file of files) {
      const div = rowEl(w, "user", "shot", rec.ts);
      const img = document.createElement("img");
      img.src = URL.createObjectURL(file);
      img.onload = () => {
        // blob decode lands after this batch's final pin; re-pin like every
        // other image kind, instantly — a layout completion must never glide
        if (followTail) scrollToBottom(true);
      };
      img.addEventListener("click", () => openLightbox(img.src, img));
      div.appendChild(img);
    }
    if (rec.text) rowEl(w, "user", "text", rec.ts).textContent = rec.text;
    markFailed(w, rec.text, files); // red badge + Not Delivered + in-memory entry
  }
  suppressAnim = prevSuppress;
  decorate();
  if (followTail) scrollToBottom(true);
}

// tapping the badge or label opens a bottom action sheet — the log-out
// confirm's visual language (safe default bold/blue, destructive red) in
// Apple's bottom-anchored shape: Try Again / Delete, Cancel on its own card
function openFailSheet(w: HTMLElement): void {
  if (document.querySelector(".sheet")) return; // one sheet at a time
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  const dismiss = (): void => {
    sheet.classList.remove("open");
    setTimeout(() => sheet.remove(), 150); // matches the .sheet fade
  };
  const mk = (label: string, cls: string, fn: () => void): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = label;
    b.addEventListener("click", () => {
      dismiss();
      fn();
    });
    return b;
  };
  const card = document.createElement("div");
  card.className = "sheet-card";
  card.append(
    mk("Try Again", "sheet-item", () => retrySend(w)),
    mk("Delete", "sheet-item sheet-danger", () => deleteFailed(w)),
  );
  sheet.append(card, mk("Cancel", "sheet-cancel", () => {}));
  sheet.addEventListener("click", (e) => {
    if (e.target === sheet) dismiss(); // backdrop tap = Cancel
  });
  document.body.appendChild(sheet);
  requestAnimationFrame(() => sheet.classList.add("open")); // let the fade run
}

let publishing = false;

async function publish(pr: string, btn: HTMLButtonElement): Promise<void> {
  if (publishing) return; // one merge at a time; repeat taps do nothing
  publishing = true;
  btn.disabled = true;
  btn.textContent = "Publishing…";
  try {
    let resp: Response;
    try {
      resp = await fetch("/api/publish", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: THREAD_ID, pr }),
      });
    } catch (e) {
      localBubble("agent", "error", `⚠ publish failed, server unreachable: ${e}`);
      btn.disabled = false;
      btn.textContent = "Publish";
      return;
    }
    if (!resp.ok) {
      let detail = `${resp.status} ${resp.statusText}`;
      try {
        detail = (await resp.json()).detail ?? detail;
      } catch {
        /* keep the status text */
      }
      localBubble("agent", "error", `⚠ publish failed: ${detail}`);
      btn.disabled = false;
      btn.textContent = "Publish";
      return;
    }
    btn.textContent = "Published ✓"; // stays disabled; server also pushes a stamp
  } finally {
    publishing = false;
  }
}

// --- web push (Phase 6): subscribe, re-register on every reopen -------------

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(new ArrayBuffer(raw.length)); // explicit ArrayBuffer -> BufferSource
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function setupPush(reg: ServiceWorkerRegistration): Promise<void> {
  if (!("PushManager" in window) || !token) return;
  let key: string | null;
  try {
    const r = await fetch("/api/push/key", { headers: authHeaders() });
    if (!r.ok) return;
    key = (await r.json()).key;
  } catch {
    return;
  }
  if (!key) return; // push not configured server-side
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    if (Notification.permission === "denied") return;
    if ((await Notification.requestPermission()) !== "granted") return;
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
  }
  await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(sub),
  });
}

// --- boot --------------------------------------------------------------------

// opening (or returning to) the app clears the home-screen unread badge
function clearBadge(): void {
  if ("clearAppBadge" in navigator) void navigator.clearAppBadge().catch(() => {});
  navigator.serviceWorker?.controller?.postMessage("badge-clear");
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") clearBadge();
  else cacheWrites.flush(); // hidden: the pending snapshot lands before iOS can freeze the page
});
clearBadge();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("/sw.js");
      await setupPush(reg);
    } catch {
      /* push/SW are best-effort */
    }
  });
}

// paint this device's iOS launch image once per load (see splash.ts): the same
// top-bar logo centered on white, sized to the current screen. No-ops off iOS.
installStartupImage("/splash-logo.png"); // full-res cut-out; the 140px topbar file pixelates at splash size

// The app's OWN loading page, over its own first frames. The phone's image dies
// the moment the web view takes the page, which is before the thread has laid
// out, so the document carries a page of its own (a globe with a dot going
// round it; index.html draws it) and that holds the handover until the
// thread has stopped moving. splash.ts owns the lift rule and the cap; this
// side reports the settle below and lands the lift on the diagnostic trail.

// How many frames the quiet watch below read before it answered, carried on the
// lift record. A cap lift with none of these read is a deploy log saying the app
// never went still on its own and the page came down over the top of it.
let quietFrames = 0;

const loadingScreen = installLoadingScreen((why) =>
  holdDiagRecord("splash-cover", { lift: why, frames: quietFrames }),
);

// ===================== TEMP DIAGNOSTIC (remove after the cold-open session) =====================
// The white gap, on the boot channel. The cover has just mounted, so both ends
// of the stretch the page spent with nothing drawn on it are readable now:
// codeStartMs when this bundle began running, coverUpMs when the cover entered
// the document, htmlDoneMs when the HTML itself finished arriving, all counted
// from the moment the page began loading (splash.ts holds what each mark is
// and why it is read where it is). One record, recorded here rather than in
// splash.ts so the cover module keeps its single job and the trail keeps its
// single writer, so a cold open puts a real number in the deploy logs instead
// of leaving the gap to be inferred from the code.
holdDiagRecord("boot-blank", bootBlankGap());
// =================== END TEMP DIAGNOSTIC (remove after the cold-open session) ===================

// The loading page's settle signal, in three steps, because the page has to
// come down onto an app that is not going to move afterwards.
//
//   ARRIVED: the boot's messages have been laid out for a frame and every image
//   the thread painted has finished loading. This is what "settled" used to
//   mean on its own, and it is the point at which everything the app was going
//   to fetch is in.
//   STILL: and then a few frames in a row in which the thread's height, its
//   scroll position and the viewport's height all read what they read the frame
//   before, with the scroll sitting at the bottom. splash.ts owns that rule and
//   the reasons for it; the short version is that arriving and holding still
//   are different instants, and the boot-motion recorder above is the record of
//   how far apart they were.
//   AND ONLY THEN the page is told, which starts its fade if its minimum hold
//   has passed.
//
// Called from the cached paint and, on a cacheless boot, from the socket's
// first settle; the page ignores every call after the first, and its own cap
// lifts it whatever happens here. That cap is also the way out of the watch:
// nothing in this path has a clock of its own.
//
// Nothing here writes a scroll position. The pins this waits on are made
// elsewhere, by the paths that own them; watching for stillness by nudging the
// thread would be the reveal causing the very motion it is there to rule out.
async function settleLoadingScreen(): Promise<void> {
  if (loadingScreen.lifted()) return;
  const t = document.getElementById("thread");
  if (!t) {
    loadingScreen.settled(); // no thread to wait on (the token gate)
    return;
  }
  await new Promise<void>((r) => requestAnimationFrame(() => r())); // laid out and painted
  const pending = Array.from(t.querySelectorAll<HTMLImageElement>("img"))
    .filter((img) => !img.complete);
  await Promise.allSettled(pending.map((img) => img.decode()));
  await new Promise<void>((resolve) =>
    watchQuiet(
      t,
      () => window.visualViewport?.height ?? window.innerHeight,
      () => loadingScreen.lifted(),
      (frames) => {
        quietFrames = frames;
        resolve();
      },
    ),
  );
  loadingScreen.settled();
}

// Launch frame settle (the 4-of-5 cold-open drop): iOS standalone can publish
// its final frame AFTER the cached paint — the layout viewport growing into
// its real height, or the splash handoff leaving the visual viewport panned —
// and the only boot-time coverage was thread-box resizes (threadObserver) and
// a window snap-back gated on composer focus (the module-level scroll
// listener), so a launch settle moved the whole pinned thread in plain sight.
// For this window after boot, every window/visual-viewport geometry event
// clears launch displacement (the keyboard close pass's own conditional
// write, shell.ts closeCorrectionNeeded) and re-pins the thread bottom, in
// the event's own task so the settle and the correction paint together.
// Keyboard sessions are excluded: once the composer holds focus the shell
// owns vv events (shell.ts) and the close-time pass owns displacement — this
// guard must never become a second mid-typing fighter.
const FRAME_SETTLE_MS = 2000;

function armBootFrameGuard(): void {
  const onGeometry = (src: string): void => {
    if (document.activeElement?.id === "text") return; // shell.ts owns focus geometry
    if (app.classList.contains("kb")) return;
    const x = Math.round(window.scrollX);
    const y = Math.round(window.scrollY);
    const top = Math.round(window.visualViewport?.offsetTop ?? 0);
    const snap = closeCorrectionNeeded(x, y, top);
    // clears scroll AND pan on the unscrollable document (cannot loop: the
    // write refires scroll once with everything already 0)
    if (snap) window.scrollTo(0, 0);
    const t = document.getElementById("thread");
    let repin = false;
    if (t && followTail) {
      repin = t.scrollHeight - t.scrollTop - t.clientHeight >= 1;
      if (repin) t.scrollTop = t.scrollHeight; // instant: a settle must not glide
    }
    if (snap || repin) holdDiagRecord("boot-repin", { src, x, y, top, snap, repin });
  };
  const vv = window.visualViewport;
  const subs: Array<[EventTarget, string, EventListener]> = [
    [window, "resize", () => onGeometry("resize")],
    [window, "scroll", () => onGeometry("scroll")],
  ];
  if (vv) {
    subs.push([vv, "resize", () => onGeometry("vv-resize")]);
    subs.push([vv, "scroll", () => onGeometry("vv-scroll")]);
  }
  for (const [target, ev, fn] of subs) target.addEventListener(ev, fn);
  setTimeout(() => {
    for (const [target, ev, fn] of subs) target.removeEventListener(ev, fn);
  }, FRAME_SETTLE_MS);
}

// Cold open, the one-paint boot: the shell has rendered; now the cached
// thread (threadcache.ts) lands BEFORE any network. Every cached frame goes
// through the one applyEvent path in a single task with animations
// suppressed, the bottom pins instantly, and the bottom is re-pinned from
// FRESH geometry on the next frame — Safari sometimes swallows the first
// scrollTop write after a fresh DOM build, and a frame settling between the
// pin and that paint must not be re-asserted stale — then the socket
// connects with since=lastSeq. On the common open (nothing new) the replay
// is empty and nothing on screen ever moves; anything newer buffers and
// lands as commitReplayBuffer's one update. The ledger needs no special
// case: the probe's tail sits at or above the cached cursor, so every
// cached seq classifies as replay by construction. A missing, mismatched,
// or unreadable record simply means the old cacheless boot.
async function bootFromCache(): Promise<void> {
  armBootFrameGuard(); // the settle window opens with the boot, cache or not
  const t0 = performance.now();
  const cached = await cacheGet<ServerMsg>(THREAD_ID).catch(() => null);
  const readMs = Math.round(performance.now() - t0);
  const t = document.getElementById("thread");
  if (cached && cached.frames.length && t) {
    holdDiagRecord("cache-read", { frames: cached.frames.length, ms: readMs });
    const prevSuppress = suppressAnim;
    suppressAnim = true; // cached frames are history: no pops, no glides
    for (const m of cached.frames) applyEvent(m);
    suppressAnim = prevSuppress;
    if (cached.lastSeq > lastSeq) lastSeq = cached.lastSeq; // a retracted tail still advances the cursor
    scrollToBottom(true);
    const armed = tailGen; // a settle between here and the next frame wins
    requestAnimationFrame(() => {
      const el = document.getElementById("thread");
      // the swallowed-first-write re-assert, from live geometry: writing the
      // captured value back re-pinned a frame iOS had already re-sized under
      // it. A bottom-geometry settle landing in between has already answered
      // for the fresh box, so this stands down rather than pinning over it.
      if (el && armed === tailGen) el.scrollTop = el.scrollHeight;
    });
    holdDiagRecord("cache-applied", { lastSeq, ms: Math.round(performance.now() - t0) });
    void settleLoadingScreen(); // the cached thread is the first paint: the wait for quiet starts here
  } else {
    holdDiagRecord("cache-read", { frames: 0, ms: readMs });
  }
  connect(); // ws.onopen runs the version check; see checkServerVersion
}

if (token) {
  renderChat();
  void bootFromCache(); // the cached thread paints first, then the socket connects
} else {
  renderTokenGate();
  void settleLoadingScreen(); // no thread on this path: the page holds its minimum and goes
}

