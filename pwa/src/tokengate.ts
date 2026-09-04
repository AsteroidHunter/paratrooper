// Sign-in check — the card asks the server before it lets anyone through.
//
// The gate used to take the typed value at its word: store it, build the chat,
// open the socket. A wrong token then got the socket refused at the handshake
// and the blind two-second retry reconnected forever behind an empty thread,
// with nothing on screen ever saying no. So the answer is asked for once, in
// the one place a person is standing there waiting for it, and the box wears
// the answer: pastel green for yes, pastel red and a shake for no.
//
// Three answers, not two. A refusal is the server saying this token is not the
// token (401 from the same require_token gate every other route sits behind,
// or a 403). Anything else — no answer at all, a 500, a hotel wifi portal —
// says nothing about the token, so the border stays neutral and Connect comes
// back for another try. Claiming a red border there would be a lie about
// whose fault it is. The third answer is not silent, though: it gets a line of
// its own under the pill, in the card's muted grey, saying the one true thing
// there is to say — the server was not reached. And it is a bounded wait: the
// check carries a cut-off, so a request that hangs becomes that same line
// instead of a Connect button that never comes back.
//
// Pure beneath a one-line wiring in main.ts, the shape hold.ts and viewport.ts
// use: the controller drives element STAND-INS (the three things it touches:
// a value, a class list, an input listener), so the whole flow is exercised
// under node with a fake fetch and no browser anywhere.

/** The one token-gated request this file makes: no body, no state, no side
 *  effects — 204 if the bearer token is the token, 401 if it is not. */
export const CHECK_URL = "/api/auth/check";

// The three states the box can wear, named once here and styled once in
// styles.css (.gate input.ok / .bad / .shake). Nothing else in the app sets
// them, and the sheet paints borders and a transform with them and nothing
// else — the box's size, fill and place are the same in all three.
export const OK_CLASS = "ok";
export const BAD_CLASS = "bad";
export const SHAKE_CLASS = "shake";

// Connect's own state, worn while the question is out. The press itself is
// :active in the sheet, which the finger owns and the browser can drop at any
// moment; this is the same dim held for as long as the app is actually
// working, so lifting the finger before the answer does not flash the pill
// back to full. Set and cleared with `asking` and nothing else.
export const BUSY_CLASS = "busy";

/** The third answer, in the one line it is allowed. It says what happened —
 *  the server was not reached — and deliberately nothing about the token,
 *  which is the whole reason it is not a red border. */
export const NOTE_COPY = "Couldn't reach the server. Try again.";

/** The class that fades that line in (.gate-note.shown in styles.css). */
export const NOTE_CLASS = "shown";

/** The beat the green border holds before the chat replaces the card. Long
 *  enough to be seen as an answer, short enough that it reads as the app
 *  going rather than the app thinking. */
export const PASS_MS = 300;

/** How long the check is given before it is treated as no answer at all. A
 *  phone behind a captive portal is not refused and is not answered — the
 *  request simply hangs, and without this the card would sit forever with
 *  Connect dead under a finger that has nothing left to press. Eight seconds
 *  is long enough that a slow but working network still lands inside it, and
 *  short enough that a hung one is not mistaken for a slow one. */
export const CHECK_TIMEOUT_MS = 8000;

export type Verdict = "accepted" | "refused" | "unknown";

/** What one answer to the check means. A refusal is the gate itself talking;
 *  everything else — including a server that broke — is unknown, because it is
 *  not evidence about the token. */
export function verdictFor(status: number): Verdict {
  if (status >= 200 && status < 300) return "accepted";
  if (status === 401 || status === 403) return "refused";
  return "unknown";
}

/** The check request, reduced to what it carries. */
export interface CheckRequest {
  headers: Record<string, string>;
  cache: "no-store";
  /** the cut-off below, pulled at CHECK_TIMEOUT_MS */
  signal: AbortSignal;
}

export type Fetcher = (url: string, init: CheckRequest) => Promise<{ status: number }>;

/** One authenticated GET, reduced to a verdict. A throw is the network, not
 *  the token, so it lands on "unknown" like any other non-answer — and so does
 *  a request that never comes back, because the cut-off turns that into a
 *  throw rather than leaving the caller waiting on it. */
export async function askToken(value: string, fetcher: Fetcher): Promise<Verdict> {
  const cutoff = new AbortController();
  const timer = setTimeout(() => cutoff.abort(), CHECK_TIMEOUT_MS);
  try {
    const res = await fetcher(CHECK_URL, {
      headers: { Authorization: `Bearer ${value}` },
      // a cached 204 would let a rotated token in, and a cached 401 would keep
      // a good one out: this question has to reach the server every time
      cache: "no-store",
      signal: cutoff.signal,
    });
    return verdictFor(res.status);
  } catch {
    return "unknown";
  } finally {
    // an answered check leaves nothing armed: the abort would be a no-op, but
    // a timer per tap that nobody cancels is a timer per tap
    clearTimeout(timer);
  }
}

/** The token box, reduced to the three things the check touches. */
export interface GateBox {
  value: string;
  classList: { add(token: string): void; remove(token: string): void };
  addEventListener(type: "input", listener: () => void): void;
  addEventListener(type: "animationend", listener: () => void): void;
}

/** Connect, reduced to the two things the check touches. */
export interface GateButton {
  disabled: boolean;
  classList: { add(token: string): void; remove(token: string): void };
}

/** The line under the pill, reduced to the two things the check touches. It is
 *  written into rather than unhidden so an empty line is empty to a screen
 *  reader too, and so the copy has one home — this file. */
export interface GateNote {
  textContent: string | null;
  classList: { add(token: string): void; remove(token: string): void };
}

export interface GateDeps {
  fetcher: Fetcher;
  /** the green beat's clock (setTimeout in the app) */
  wait: (ms: number, run: () => void) => void;
  /** the server said yes: store the token, build the chat, open the socket */
  accepted: (value: string) => void;
}

export interface TokenGate {
  /** a Connect tap: check, then paint the answer */
  submit(): Promise<void>;
  /** paint a refusal that came from somewhere else — the socket handshake —
   *  with the rejected value back in the box to be corrected */
  refuse(value: string): void;
}

export function createTokenGate(
  box: GateBox,
  button: GateButton,
  note: GateNote,
  deps: GateDeps,
): TokenGate {
  let asking = false; // a check is out; the tap that started it is unanswered

  // the third answer, put away again: emptied, not just faded, so nothing is
  // left on the card for a screen reader to read out of a blank line
  const hush = (): void => {
    note.classList.remove(NOTE_CLASS);
    note.textContent = "";
  };

  // neutral: no claim about the token. Also what the next keystroke restores —
  // the red is about the value that was sent, and it stops being about the
  // value in the box the moment that value changes.
  const clear = (): void => {
    box.classList.remove(OK_CLASS);
    box.classList.remove(BAD_CLASS);
    box.classList.remove(SHAKE_CLASS);
    hush();
  };

  const mark = (): void => {
    hush(); // an answer arrived: whatever the last silence said is stale
    box.classList.remove(OK_CLASS);
    box.classList.add(BAD_CLASS);
    box.classList.add(SHAKE_CLASS);
  };

  box.addEventListener("input", clear);
  // The shake takes its own class off at the end of its 0.45s, which is what
  // lets the SAME refusal shake twice: adding a class an element already wears
  // never restarts keyframes, and the empty-box shake below has no round trip
  // in the middle to carry the removal across a frame. No layout read, no
  // duration written twice — the animation itself says when it is done.
  box.addEventListener("animationend", () => box.classList.remove(SHAKE_CLASS));

  // the third answer, spoken. No border, no shake — neither would be about the
  // token, and both are the box's vocabulary for things that are.
  const say = (): void => {
    note.textContent = NOTE_COPY;
    note.classList.add(NOTE_CLASS);
  };

  const submit = async (): Promise<void> => {
    if (asking) return; // one check per tap: the second tap has nothing to add
    const value = box.value.trim();
    clear(); // a retry with the same wrong token re-arms the shake from here
    if (!value) {
      // nothing to ask about. The same refusal the server would give it, said
      // without spending a round trip on it — and no red, because an empty box
      // is not a wrong token. Connect stays live: there is nothing in flight.
      box.classList.add(SHAKE_CLASS);
      return;
    }
    asking = true;
    button.disabled = true; // and no double tap can start a second one
    button.classList.add(BUSY_CLASS); // and the pill stays pressed-looking
    const verdict = await askToken(value, deps.fetcher);
    asking = false;
    button.classList.remove(BUSY_CLASS); // exactly as long as `asking`, always
    if (verdict === "accepted") {
      box.classList.add(OK_CLASS);
      // Connect stays disabled: this card has been answered and is leaving.
      // The sheet dims a disabled pill too, so it does not sit there looking
      // live for the beat the green is up.
      deps.wait(PASS_MS, () => deps.accepted(value));
      return;
    }
    button.disabled = false; // every other path gives Connect back, including
    if (verdict === "refused") mark(); // a cut-off one: nothing can hang it
    else say(); // "unknown": the border claims nothing, the line says why
  };

  const refuse = (value: string): void => {
    box.value = value; // still there to correct, exactly as at the card
    mark();
  };

  return { submit, refuse };
}

// --- the socket's own refusal -------------------------------------------------
//
// A token can also be refused later: it is rotated on the server, or it was
// never right and the socket is the only thing that ever asked. The handshake
// rejection is invisible from here — a browser hides the status of a failed
// WebSocket handshake, so the server's refusal and a dead network both arrive
// as the same anonymous close — and the two-second retry behind it turns a
// refusal into an empty chat reconnecting forever.
//
// So the close is not the evidence; one authenticated GET is. It runs
// ALONGSIDE the retry the close armed rather than in front of it, so a real
// drop still comes back on the same two seconds it always did, and only a
// refusal ends the session.

export interface AfterCloseDeps {
  fetcher: Fetcher;
  /** false once the session moved on while the probe was out (logged out, or
   *  signed in again with something else): the answer is about a dead token */
  stillSignedIn: (refused: string) => boolean;
  /** back to the sign-in card wearing the red border, and nothing reconnects */
  signOut: (refused: string) => void;
}

export async function afterSocketClose(refused: string, deps: AfterCloseDeps): Promise<void> {
  const verdict = await askToken(refused, deps.fetcher);
  if (verdict !== "refused") return; // a drop, or no answer at all: retry as always
  if (!deps.stillSignedIn(refused)) return;
  deps.signOut(refused);
}
