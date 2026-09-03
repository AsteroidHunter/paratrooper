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
// says nothing about the token, so the box shows nothing and Connect comes
// back for another try. Claiming a red border there would be a lie about
// whose fault it is.
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

/** The beat the green border holds before the chat replaces the card. Long
 *  enough to be seen as an answer, short enough that it reads as the app
 *  going rather than the app thinking. */
export const PASS_MS = 300;

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
}

export type Fetcher = (url: string, init: CheckRequest) => Promise<{ status: number }>;

/** One authenticated GET, reduced to a verdict. A throw is the network, not
 *  the token, so it lands on "unknown" like any other non-answer. */
export async function askToken(value: string, fetcher: Fetcher): Promise<Verdict> {
  try {
    const res = await fetcher(CHECK_URL, {
      headers: { Authorization: `Bearer ${value}` },
      // a cached 204 would let a rotated token in, and a cached 401 would keep
      // a good one out: this question has to reach the server every time
      cache: "no-store",
    });
    return verdictFor(res.status);
  } catch {
    return "unknown";
  }
}

/** The token box, reduced to the three things the check touches. */
export interface GateBox {
  value: string;
  classList: { add(token: string): void; remove(token: string): void };
  addEventListener(type: "input", listener: () => void): void;
}

/** Connect, reduced to the one thing the check touches. */
export interface GateButton {
  disabled: boolean;
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

export function createTokenGate(box: GateBox, button: GateButton, deps: GateDeps): TokenGate {
  let asking = false; // a check is out; the tap that started it is unanswered

  // neutral: no claim about the token. Also what the next keystroke restores —
  // the red is about the value that was sent, and it stops being about the
  // value in the box the moment that value changes.
  const clear = (): void => {
    box.classList.remove(OK_CLASS);
    box.classList.remove(BAD_CLASS);
    box.classList.remove(SHAKE_CLASS);
  };

  const mark = (): void => {
    box.classList.remove(OK_CLASS);
    box.classList.add(BAD_CLASS);
    box.classList.add(SHAKE_CLASS);
  };

  box.addEventListener("input", clear);

  const submit = async (): Promise<void> => {
    if (asking) return; // one check per tap: the second tap has nothing to add
    const value = box.value.trim();
    if (!value) return;
    asking = true;
    button.disabled = true; // and no double tap can start a second one
    clear(); // a retry with the same wrong token re-arms the shake from here
    const verdict = await askToken(value, deps.fetcher);
    asking = false;
    if (verdict === "accepted") {
      box.classList.add(OK_CLASS);
      // Connect stays disabled: this card has been answered and is leaving
      deps.wait(PASS_MS, () => deps.accepted(value));
      return;
    }
    button.disabled = false;
    if (verdict === "refused") mark();
    // "unknown": nothing is claimed, nothing is painted, and Connect is live
    // again. No copy either — the spec covers a right token and a wrong one,
    // and inventing a sentence for the third case is not this file's call.
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
