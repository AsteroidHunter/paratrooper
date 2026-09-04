// Pins for the sign-in check (src/tokengate.ts) and its main.ts wiring.
//
// The bug: the gate stored whatever was typed and built the chat around it. A
// wrong token then got the socket refused at the handshake, ws.onclose retried
// every two seconds forever, and the screen was an empty thread that never said
// anything. So Connect asks the server once, and the box wears the answer.
//
// Three answers, and the third is the one worth pinning hardest: only the gate
// itself refusing (401/403) may paint the box red. No answer at all, or a
// server that broke, says nothing about the token — the border stays neutral
// and Connect comes back. What it does now say is one muted line under the
// pill, which claims nothing about the token either; and a check that never
// comes back is cut off after CHECK_TIMEOUT_MS and lands on that same line,
// so a hung request can no longer leave Connect dead forever.
//
// The pill answers the finger too: one dim carried by :active, by the busy
// class for as long as the check is out, and by :disabled for the beat a card
// that has been let through takes to leave. And the two things that were not
// possible at all — Connect on an empty box, and Return instead of Connect —
// are here as well: the first shakes without sending anything, the second is a
// keydown on the box calling the very same handler, with no <form> in sight.
//
// The controller runs on element STAND-INS, the tapcaret.test.ts way: the three
// things it touches are a value, a class list and an input listener, so the
// whole flow is exercised under node against a fake fetch. What the classes
// then LOOK like is a source pin over the sheet, like the other presentation
// pins — jsdom resolves none of these rules and there is no browser here.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  BAD_CLASS,
  BUSY_CLASS,
  CHECK_TIMEOUT_MS,
  CHECK_URL,
  type Fetcher,
  type GateBox,
  type GateButton,
  type GateNote,
  NOTE_CLASS,
  NOTE_COPY,
  OK_CLASS,
  PASS_MS,
  SHAKE_CLASS,
  afterSocketClose,
  askToken,
  createTokenGate,
  verdictFor,
} from "../src/tokengate";

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

// --- the stand-ins ------------------------------------------------------------

/** A class list, the only part of an element three of these stand-ins share. */
function classes() {
  const set = new Set<string>();
  return {
    set,
    list: {
      add: (c: string) => void set.add(c),
      remove: (c: string) => void set.delete(c),
    },
  };
}

interface Box extends GateBox {
  classes: Set<string>;
  type(text: string): void; // a keystroke: the value changes and the app hears it
  shakeOver(): void; // the 0.45s finishing, which is what takes the class off
}

function makeBox(value = ""): Box {
  const own = classes();
  const heard = new Map<string, () => void>();
  return {
    value,
    classes: own.set,
    classList: own.list,
    addEventListener: (type: "input" | "animationend", listener: () => void) => {
      heard.set(type, listener);
    },
    type(text: string) {
      this.value = text;
      heard.get("input")?.();
    },
    shakeOver() {
      heard.get("animationend")?.();
    },
  };
}

interface Button extends GateButton {
  classes: Set<string>;
}

function makeButton(): Button {
  const own = classes();
  return { disabled: false, classes: own.set, classList: own.list };
}

interface Note extends GateNote {
  classes: Set<string>;
}

function makeNote(): Note {
  const own = classes();
  return { textContent: "", classes: own.set, classList: own.list };
}

/** A fetch that answers with one status, and remembers how it was called. */
function answering(status: number) {
  const calls: { url: string; auth: string; cache: string }[] = [];
  const signals: AbortSignal[] = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization, cache: init.cache });
    signals.push(init.signal);
    return { status };
  };
  return { fetcher, calls, signals };
}

/** A fetch that never answers, held open by the test — and, like the real
 *  thing, thrown out the moment its signal is pulled. Without that the cut-off
 *  would have nothing to cut and this stand-in would be lying about fetch. */
function hanging() {
  let release: (status: number) => void = () => {};
  const calls: string[] = [];
  const signals: AbortSignal[] = [];
  const fetcher: Fetcher = (url, init) => {
    calls.push(url);
    signals.push(init.signal);
    return new Promise((resolve, reject) => {
      release = (status) => resolve({ status });
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  };
  return { fetcher, calls, signals, answer: (status: number) => release(status) };
}

/** The card, wired the way main.ts wires it, with the beat's clock in hand. */
function card(fetcher: Fetcher, value: string) {
  const box = makeBox(value);
  const button = makeButton();
  const note = makeNote();
  const beats: { ms: number; run: () => void }[] = [];
  const accepted: string[] = [];
  const gate = createTokenGate(box, button, note, {
    fetcher,
    wait: (ms, run) => void beats.push({ ms, run }),
    accepted: (v) => void accepted.push(v),
  });
  return { box, button, note, beats, accepted, gate };
}

// --- what one answer means ----------------------------------------------------

describe("the verdict — only the gate itself may say no", () => {
  it("a 2xx is the token, and 204 is the one the route actually sends", () => {
    expect(verdictFor(204)).toBe("accepted");
    expect(verdictFor(200)).toBe("accepted");
    expect(verdictFor(299)).toBe("accepted");
  });

  it("401 and 403 are the gate refusing, and nothing else is", () => {
    expect(verdictFor(401)).toBe("refused");
    expect(verdictFor(403)).toBe("refused");
  });

  it("a broken server is not evidence about the token", () => {
    for (const status of [400, 404, 429, 500, 502, 503]) {
      expect(verdictFor(status), `${status} must not read as a refusal`).toBe("unknown");
    }
  });

  it("and neither is a request that never came back", async () => {
    const thrown: Fetcher = () => Promise.reject(new Error("network"));
    expect(await askToken("t", thrown)).toBe("unknown");
  });

  it("asks the one route, as a bearer, and never off a cache", async () => {
    const { fetcher, calls } = answering(204);
    expect(await askToken("  ", fetcher)).toBe("accepted"); // the caller trims, not this
    expect(calls).toEqual([{ url: CHECK_URL, auth: "Bearer   ", cache: "no-store" }]);
    expect(CHECK_URL).toBe("/api/auth/check");
  });
});

// --- the cut-off --------------------------------------------------------------
//
// A refusal is an answer and a dead socket is an answer; a captive portal is
// neither. The request just hangs, and the whole point of asking before
// entering the chat was that somebody is standing there waiting for it.

describe("a check that never comes back", () => {
  it("is given eight seconds, and is a bounded wait either way", () => {
    expect(CHECK_TIMEOUT_MS).toBe(8000);
  });

  it("hands the fetch a signal, unpulled, on every ask", async () => {
    const { fetcher, signals } = answering(204);
    await askToken("t", fetcher);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0].aborted).toBe(false);
  });

  it("pulls it at the cut-off, and the hang becomes no answer at all", async () => {
    vi.useFakeTimers();
    try {
      const hung = hanging();
      const verdict = askToken("t", hung.fetcher);
      expect(hung.signals[0].aborted).toBe(false); // still waiting on the server
      vi.advanceTimersByTime(CHECK_TIMEOUT_MS);
      expect(hung.signals[0].aborted).toBe(true);
      expect(await verdict).toBe("unknown"); // not a refusal: nothing was said
    } finally {
      vi.useRealTimers();
    }
  });

  it("and disarms it the moment an answer arrives — no timer outlives its tap", async () => {
    vi.useFakeTimers();
    try {
      const { fetcher, signals } = answering(401);
      expect(await askToken("t", fetcher)).toBe("refused");
      vi.advanceTimersByTime(CHECK_TIMEOUT_MS * 2);
      expect(signals[0].aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- the card ----------------------------------------------------------------

describe("Connect on a token the server accepts", () => {
  it("turns the box green, waits a beat, and only then hands the token over", async () => {
    const { fetcher, calls } = answering(204);
    const c = card(fetcher, "  right  ");
    await c.gate.submit();

    expect(calls[0].auth).toBe("Bearer right"); // trimmed, as it always was
    expect([...c.box.classes]).toEqual([OK_CLASS]);
    expect(c.accepted).toEqual([]); // nothing stored yet: the green is on screen
    expect(c.beats).toHaveLength(1);
    expect(c.beats[0].ms).toBe(PASS_MS);
    c.beats[0].run();
    expect(c.accepted).toEqual(["right"]); // the trimmed value, not the typed one
  });

  it("keeps Connect disabled: this card has been answered and is leaving", async () => {
    const { fetcher } = answering(204);
    const c = card(fetcher, "right");
    await c.gate.submit();
    expect(c.button.disabled).toBe(true);
  });

  it("a beat of a few hundred ms — long enough to read, short enough to feel like going", () => {
    expect(PASS_MS).toBeGreaterThanOrEqual(200);
    expect(PASS_MS).toBeLessThanOrEqual(600);
  });
});

describe("Connect on a token the server refuses", () => {
  it("turns the box red and shakes it, and the app stays on the card", async () => {
    for (const status of [401, 403]) {
      const { fetcher } = answering(status);
      const c = card(fetcher, "wrong");
      await c.gate.submit();
      expect([...c.box.classes].sort(), `${status}`).toEqual([BAD_CLASS, SHAKE_CLASS].sort());
      expect(c.box.classes.has(OK_CLASS)).toBe(false);
      expect(c.accepted).toEqual([]); // nothing was handed over
      expect(c.beats).toEqual([]); // and nothing is on its way to being
    }
  });

  it("leaves what was typed in the box to be corrected", async () => {
    const { fetcher } = answering(401);
    const c = card(fetcher, "wrong");
    await c.gate.submit();
    expect(c.box.value).toBe("wrong");
  });

  it("gives Connect back, and the next tap asks again", async () => {
    const { fetcher, calls } = answering(401);
    const c = card(fetcher, "wrong");
    await c.gate.submit();
    expect(c.button.disabled).toBe(false);
    await c.gate.submit();
    expect(calls).toHaveLength(2); // re-checked, not remembered
  });

  it("the same wrong token twice shakes twice: the tap clears the box first", async () => {
    // the class has to leave and come back or the keyframes never re-run, and
    // the tap is where that happens — no layout read, no animation listener
    const { fetcher } = answering(401);
    const c = card(fetcher, "wrong");
    await c.gate.submit();
    const hung = hanging();
    const second = card(hung.fetcher, "wrong");
    second.box.classes.add(BAD_CLASS);
    second.box.classes.add(SHAKE_CLASS);
    const pending = second.gate.submit();
    expect([...second.box.classes]).toEqual([]); // neutral again while it asks
    hung.answer(401);
    await pending;
    expect([...second.box.classes].sort()).toEqual([BAD_CLASS, SHAKE_CLASS].sort());
  });

  it("typing returns the box to neutral", async () => {
    const { fetcher } = answering(401);
    const c = card(fetcher, "wrong");
    await c.gate.submit();
    c.box.type("wronge");
    expect([...c.box.classes]).toEqual([]);
  });
});

describe("Connect with nothing to answer it", () => {
  it("shows neither colour and gives Connect back, for a dead network", async () => {
    const dead: Fetcher = () => Promise.reject(new Error("offline"));
    const c = card(dead, "right");
    await c.gate.submit();
    expect([...c.box.classes]).toEqual([]); // no claim is made either way
    expect(c.button.disabled).toBe(false);
    expect(c.accepted).toEqual([]);
  });

  it("and the same for a server that broke, which is not the token's fault", async () => {
    const { fetcher } = answering(503);
    const c = card(fetcher, "right");
    await c.gate.submit();
    expect([...c.box.classes]).toEqual([]);
    expect(c.button.disabled).toBe(false);
    expect(c.accepted).toEqual([]);
  });

  it("says the one thing there is to say, under the pill", async () => {
    const dead: Fetcher = () => Promise.reject(new Error("offline"));
    const c = card(dead, "right");
    await c.gate.submit();
    expect(c.note.textContent).toBe(NOTE_COPY);
    expect([...c.note.classes]).toEqual([NOTE_CLASS]); // and it is faded in
  });

  it("the line is about the server, and says nothing about the token", () => {
    expect(NOTE_COPY).toBe("Couldn't reach the server. Try again.");
    expect(NOTE_COPY.toLowerCase()).not.toContain("token");
    expect(NOTE_COPY.toLowerCase()).not.toContain("wrong");
  });

  it("a 500 gets it too — a server that broke is still a server not reached", async () => {
    const { fetcher } = answering(500);
    const c = card(fetcher, "right");
    await c.gate.submit();
    expect(c.note.textContent).toBe(NOTE_COPY);
  });

  it("but a refusal never does: the border is the answer there", async () => {
    const { fetcher } = answering(401);
    const c = card(fetcher, "wrong");
    await c.gate.submit();
    expect(c.note.textContent).toBe("");
    expect([...c.note.classes]).toEqual([]);
  });

  it("and neither does a yes", async () => {
    const { fetcher } = answering(204);
    const c = card(fetcher, "right");
    await c.gate.submit();
    expect(c.note.textContent).toBe("");
  });

  it("the next keystroke takes it away, emptied and not just faded", async () => {
    const dead: Fetcher = () => Promise.reject(new Error("offline"));
    const c = card(dead, "righ");
    await c.gate.submit();
    c.box.type("right");
    expect(c.note.textContent).toBe("");
    expect([...c.note.classes]).toEqual([]);
  });

  it("and so does the next tap, before it has anything new to report", async () => {
    const dead: Fetcher = () => Promise.reject(new Error("offline"));
    const c = card(dead, "right");
    await c.gate.submit();
    const hung = hanging();
    const second = card(hung.fetcher, "right");
    second.note.textContent = NOTE_COPY;
    second.note.classes.add(NOTE_CLASS);
    const pending = second.gate.submit();
    expect(second.note.textContent).toBe(""); // silent while it asks again
    expect([...second.note.classes]).toEqual([]);
    hung.answer(204);
    await pending;
  });
});

describe("while the question is out", () => {
  it("Connect is disabled, so a second tap cannot start a second check", async () => {
    const hung = hanging();
    const c = card(hung.fetcher, "right");
    const pending = c.gate.submit();
    expect(c.button.disabled).toBe(true);
    await c.gate.submit(); // the double tap
    expect(hung.calls).toHaveLength(1);
    hung.answer(204);
    await pending;
    expect(hung.calls).toHaveLength(1);
  });

  it("the pill stays dimmed for exactly as long as the check is out", async () => {
    const hung = hanging();
    const c = card(hung.fetcher, "right");
    expect([...c.button.classes]).toEqual([]); // nothing before the tap
    const pending = c.gate.submit();
    expect([...c.button.classes]).toEqual([BUSY_CLASS]); // the finger may lift now
    hung.answer(401);
    await pending;
    expect([...c.button.classes]).toEqual([]);
  });

  it("and the dim comes off on a refusal, on no answer, and on the yes", async () => {
    const dead: Fetcher = () => Promise.reject(new Error("offline"));
    for (const [what, fetcher] of [
      ["refused", answering(401).fetcher],
      ["unknown", dead],
      ["accepted", answering(204).fetcher],
    ] as const) {
      const c = card(fetcher, "right");
      await c.gate.submit();
      expect(c.button.classes.has(BUSY_CLASS), `${what} left the pill busy`).toBe(false);
    }
  });

  it("nothing can leave Connect dead: the cut-off gives it back too", async () => {
    vi.useFakeTimers();
    try {
      const hung = hanging();
      const c = card(hung.fetcher, "right");
      const pending = c.gate.submit();
      expect(c.button.disabled).toBe(true);
      vi.advanceTimersByTime(CHECK_TIMEOUT_MS);
      await pending;
      expect(c.button.disabled).toBe(false);
      expect(c.button.classes.has(BUSY_CLASS)).toBe(false);
      expect([...c.box.classes]).toEqual([]); // no red: nothing refused anything
      expect(c.note.textContent).toBe(NOTE_COPY); // the third answer, as always
      // and the card is askable again, which is the whole point of the cut-off
      const again = c.gate.submit();
      expect(hung.calls).toHaveLength(2);
      hung.answer(204);
      await again;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Connect on an empty box", () => {
  it("shakes, sends nothing, and leaves the pill live", async () => {
    const { fetcher, calls } = answering(204);
    const c = card(fetcher, "   "); // whitespace is empty: the value is trimmed
    await c.gate.submit();
    expect(calls).toEqual([]); // no request at all — there is nothing to ask
    expect([...c.box.classes]).toEqual([SHAKE_CLASS]); // the shake, and no red
    expect(c.box.classes.has(BAD_CLASS)).toBe(false);
    expect(c.button.disabled).toBe(false);
    expect([...c.button.classes]).toEqual([]); // never went busy
    expect(c.note.textContent).toBe(""); // and nothing was reached to fail
  });

  it("shakes again on the next tap: the animation drops its own class", async () => {
    // adding a class an element already wears restarts nothing, and there is no
    // round trip here to carry the removal across a frame — so the end of the
    // shake is what takes it off, and the next tap re-arms by construction
    const { fetcher } = answering(204);
    const c = card(fetcher, "");
    await c.gate.submit();
    expect([...c.box.classes]).toEqual([SHAKE_CLASS]);
    c.box.shakeOver();
    expect([...c.box.classes]).toEqual([]);
    await c.gate.submit();
    expect([...c.box.classes]).toEqual([SHAKE_CLASS]);
  });

  it("clears whatever the last answer left before it shakes", async () => {
    const { fetcher } = answering(401);
    const c = card(fetcher, "wrong");
    await c.gate.submit();
    expect(c.box.classes.has(BAD_CLASS)).toBe(true);
    c.box.value = "  "; // typed away to nothing, then Connect again
    await c.gate.submit();
    expect([...c.box.classes]).toEqual([SHAKE_CLASS]); // the red went with it
  });

  it("and the shake the refusal wears comes off on the same event", async () => {
    const { fetcher } = answering(401);
    const c = card(fetcher, "wrong");
    await c.gate.submit();
    c.box.shakeOver();
    expect([...c.box.classes]).toEqual([BAD_CLASS]); // the red stays; the motion is over
  });
});

describe("a refusal that came from the socket, not the card", () => {
  it("puts the rejected value back in the box and paints it the same red", () => {
    const c = card(answering(204).fetcher, "");
    c.gate.refuse("stale");
    expect(c.box.value).toBe("stale"); // there to correct, as at the card
    expect([...c.box.classes].sort()).toEqual([BAD_CLASS, SHAKE_CLASS].sort());
  });
});

// --- the socket's own refusal -------------------------------------------------

describe("a socket close that never opened — refusal or drop", () => {
  function probe(status: number | null) {
    const fetcher: Fetcher =
      status === null ? () => Promise.reject(new Error("offline")) : async () => ({ status });
    const out: string[] = [];
    return {
      run: (refused = "tok", signedIn = true) =>
        afterSocketClose(refused, {
          fetcher,
          stillSignedIn: () => signedIn,
          signOut: (v) => void out.push(v),
        }),
      out,
    };
  }

  it("a 401 back means refused: out to the card, wearing the red", async () => {
    const p = probe(401);
    await p.run();
    expect(p.out).toEqual(["tok"]); // and the caller drops the armed retry with it
  });

  it("a 204 back means the network went away: nothing happens, the retry stands", async () => {
    const p = probe(204);
    await p.run();
    expect(p.out).toEqual([]);
  });

  it("no answer at all also leaves the retry alone — that is the drop case", async () => {
    const p = probe(null);
    await p.run();
    expect(p.out).toEqual([]);
  });

  it("a session that moved on while the question was out is left alone", async () => {
    const p = probe(401);
    await p.run("tok", false); // logged out, or signed in again with something else
    expect(p.out).toEqual([]);
  });
});

// --- the wiring ---------------------------------------------------------------

describe("main.ts — nothing is stored until the server has said yes", () => {
  const gate = /function renderTokenGate\(\)[\s\S]*?\n\}/.exec(main)?.[0] ?? "";

  it("the card is a controller now, and the accepted path is its callback", () => {
    expect(gate, "renderTokenGate not found").not.toBe("");
    expect(gate).toContain("createTokenGate(input, save, note, {");
    // the three lines that used to run on a tap now run on an answer
    const accepted = gate.slice(gate.indexOf("accepted: (value) =>"));
    expect(accepted).toContain("localStorage.setItem(TOKEN_KEY, value)");
    expect(accepted).toContain("renderChat();");
    expect(accepted).toContain("connect();");
    // and the tap itself does one thing: ask
    expect(gate).toMatch(/addEventListener\("click", \(\) => \{\s*void gate\.submit\(\);/);
  });

  it("the tap no longer writes the token anywhere on its way past", () => {
    const tap = gate.slice(gate.indexOf('addEventListener("click"'));
    expect(tap).not.toContain("localStorage.setItem");
    expect(tap).not.toContain("token =");
  });

  it("the card and the socket's probe ask the same question", () => {
    expect(main).toContain("const gateFetch: Fetcher = (url, init) => fetch(url, init);");
    expect(main.match(/fetcher: gateFetch,/g)).toHaveLength(2); // the card, the probe
    expect(main).not.toContain(CHECK_URL); // the route is named once, in tokengate.ts
  });

  it("the third answer's line is rendered empty, and announced when it is not", () => {
    expect(gate).toContain(
      '<div id="token-note" class="gate-note" role="status" aria-live="polite"></div>',
    );
    // it is the LAST thing in the card: nothing in the flow sits under it, and
    // the sheet lifts it out of the flow entirely
    expect(gate).toMatch(/<div id="token-note"[^>]*><\/div>\s*<\/div>`;/);
    // the copy is never written here — the module owns the one sentence
    expect(main).not.toContain(NOTE_COPY);
    expect(gate).toContain('document.getElementById("token-note") as HTMLDivElement');
  });

  it("Return in the box is a Connect tap, and there is still no form", () => {
    const at = gate.indexOf('input.addEventListener("keydown"');
    expect(at, "no keydown on the token box").toBeGreaterThan(-1);
    const key = gate.slice(at);
    expect(key).toContain('if (event.key !== "Enter") return;');
    expect(key).toContain("event.preventDefault();"); // or the box would keep it
    expect(key).toContain("void gate.submit();"); // the same handler, not a copy
    // one path in, two ways to take it: nothing here re-implements the check
    expect(key).not.toContain("askToken");
    expect(key).not.toContain("localStorage");
    // and no <form> was wrapped around the card to get Return for free: the
    // chat's composer is the app's only one, and a form here would reload
    const markup = /app\.innerHTML = `([\s\S]*?)`;/.exec(gate)?.[1] ?? "";
    expect(markup, "the card's markup not found").not.toBe("");
    expect(markup).not.toContain("<form");
  });
});

function fnBody(name: string): string {
  const start = main.indexOf(`function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  return main.slice(start, main.indexOf("\n}", start));
}

describe("main.ts — a refused socket goes to the card instead of retrying forever", () => {
  const connect = fnBody("connect");

  it("the close still arms the two-second retry, for every close", () => {
    expect(connect).toContain("retryTimer = setTimeout(");
    expect(connect).toContain("connect(); // dropped: reconnect; catch-up via ?since=");
  });

  it("only a socket that never opened is questioned: a drop is answered by the retry", () => {
    expect(connect).toContain("let opened = false");
    expect(connect).toContain("opened = true");
    const close = connect.slice(connect.indexOf("ws.onclose"));
    expect(close).toContain("if (opened) return;");
    // the retry is armed BEFORE the question, so the drop path is untouched
    expect(close.indexOf("retryTimer = setTimeout(")).toBeLessThan(
      close.indexOf("probeAfterClose(refused)"),
    );
  });

  it("the probe runs once per outage and lands on the shared teardown", () => {
    const body = fnBody("probeAfterClose");
    expect(body).toContain("if (closeProbeBusy) return;");
    expect(body).toContain("afterSocketClose(refused,");
    expect(body).toContain("stillSignedIn: (value) => token === value");
    expect(body).toContain("leaveChat();");
    expect(body).toContain("renderTokenGate();");
    expect(body).toContain("tokenGate?.refuse(value)");
  });

  it("leaving disarms whatever reconnect was already ticking", () => {
    const body = fnBody("leaveChat");
    expect(body).toContain("if (retryTimer) clearTimeout(retryTimer)");
    expect(body).toContain("retryTimer = null");
    expect(body).toContain("closingOnPurpose = true");
    expect(body).toContain('localStorage.removeItem(TOKEN_KEY)');
  });
});

// --- the look -----------------------------------------------------------------

describe("the two answers are tokens, declared for both appearances", () => {
  const root = /:root \{([\s\S]*?)\n\}/.exec(css.replace(/\/\*[\s\S]*?\*\//g, ""))?.[1] ?? "";
  const dark =
    /@media \(prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)\n  \}/.exec(
      css.replace(/\/\*[\s\S]*?\*\//g, ""),
    )?.[1] ?? "";

  it("light and dark both name a pastel green and a pastel red", () => {
    for (const [where, block] of [
      ["light", root],
      ["dark", dark],
    ] as const) {
      expect(block, `${where} :root not found`).not.toBe("");
      for (const name of ["--gate-ok", "--gate-bad"]) {
        const hex = new RegExp(`${name}: (#[0-9a-f]{6});`).exec(block);
        expect(hex, `${name} missing a value in ${where}`).not.toBeNull();
      }
    }
  });

  it("they are pastels: light, and not the shouting reds the app already has", () => {
    const read = (block: string, name: string): [number, number, number] => {
      const hex = new RegExp(`${name}: #([0-9a-f]{6});`).exec(block)![1];
      return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
    };
    for (const block of [root, dark]) {
      const [gr, gg, gb] = read(block, "--gate-ok");
      expect(gg).toBeGreaterThan(gr); // green, and green is the brightest channel
      expect(gg).toBeGreaterThan(gb);
      const [rr, rg, rb] = read(block, "--gate-bad");
      expect(rr).toBeGreaterThan(rg); // red, likewise
      expect(rr).toBeGreaterThan(rb);
      // pastel: nothing is allowed near black, and no channel is fully off
      for (const c of [gr, gg, gb, rr, rg, rb]) expect(c).toBeGreaterThan(0x50);
    }
    // and not --error-text, which is a failed message's red and much louder
    expect(root).not.toContain("--gate-bad: #d70015");
  });
});

/** One rule's body, by the exact selector it is written under. */
const rule = (selector: string): string => {
  const m = new RegExp(`(?:^|\\n)${selector.replace(/\./g, "\\.")} \\{([^}]*)\\}`).exec(
    css.replace(/\/\*[\s\S]*?\*\//g, ""),
  );
  expect(m, `no rule for ${selector}`).not.toBeNull();
  return m![1];
};

describe("the gate's rules paint a border and move nothing", () => {
  it("green and red are the tokens and nothing else — no colour is written here", () => {
    expect(rule(".gate input.ok").trim()).toBe("border-color: var(--gate-ok);");
    expect(rule(".gate input.bad").trim()).toBe("border-color: var(--gate-bad);");
  });

  it("the box's size, fill and place are the same in all three states", () => {
    for (const sel of [".gate input.ok", ".gate input.bad", ".gate input.shake"]) {
      const body = rule(sel);
      for (const prop of [
        "width",
        "padding",
        "margin",
        "border-width",
        "border-radius",
        "background",
        "font",
        "display",
      ]) {
        expect(body, `${sel} must not declare ${prop}`).not.toMatch(
          new RegExp(`(?:^|;)\\s*${prop}\\s*:`),
        );
      }
    }
  });

  it("the shake is translateX only, and over inside half a second", () => {
    const anim = rule(".gate input.shake");
    const seconds = /animation: gate-shake ([\d.]+)s/.exec(anim);
    expect(seconds, "the shake must name its own duration").not.toBeNull();
    expect(Number(seconds![1])).toBeGreaterThanOrEqual(0.4);
    expect(Number(seconds![1])).toBeLessThanOrEqual(0.5);

    const frames = /@keyframes gate-shake \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(frames, "gate-shake keyframes not found").not.toBe("");
    const moves = [...frames.matchAll(/transform: ([^;]+);/g)].map((m) => m[1].trim());
    expect(moves.length).toBeGreaterThan(4); // several oscillations, not one nudge
    for (const move of moves) {
      expect(move, `${move} is not a translateX`).toMatch(/^translateX\(-?\d+(?:px)?\)$/);
    }
    // nothing but transform: a shake that changed anything else would reflow
    expect(frames.replace(/transform: [^;]+;/g, "")).not.toMatch(/[a-z-]+\s*:/);
  });

  it("the swings decay, the way iOS refuses a passcode", () => {
    const frames = /@keyframes gate-shake \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    const swings = [...frames.matchAll(/translateX\((-?\d+)px\)/g)]
      .map((m) => Math.abs(Number(m[1])))
      .filter((px) => px > 0);
    expect(swings.length).toBeGreaterThan(3);
    for (let i = 1; i < swings.length; i++) {
      expect(swings[i], `swing ${i} must not grow`).toBeLessThan(swings[i - 1]);
    }
    // and it comes home: the first and last stops sit at zero
    expect(frames).toMatch(/0%,\s*100% \{ transform: translateX\(0\); \}/);
  });

  it("the classes the sheet styles are the classes the module names", () => {
    for (const cls of [OK_CLASS, BAD_CLASS, SHAKE_CLASS]) {
      expect(css).toContain(`.gate input.${cls} {`);
    }
    // and main.ts never names one of its own: the card's state is the module's
    expect(main).not.toMatch(/classList\.(?:add|remove)\("(?:ok|bad|shake)"\)/);
  });
});

describe("Connect answers the finger", () => {
  const dim = /\.gate button:active,\s*\.gate button\.busy,\s*\.gate button:disabled \{([^}]*)\}/.exec(
    css.replace(/\/\*[\s\S]*?\*\//g, ""),
  );

  it("the press, the wait and the leaving card are one dim, written once", () => {
    expect(dim, "the three states must share a rule, not drift apart").not.toBeNull();
    const opacity = /opacity: ([\d.]+);/.exec(dim![1]);
    expect(opacity, "the dim must be an opacity").not.toBeNull();
    expect(Number(opacity![1])).toBeGreaterThan(0.3); // still legibly the pill
    expect(Number(opacity![1])).toBeLessThan(1); // and visibly not the live one
  });

  it("dims the accent rather than naming a second fill for it", () => {
    expect(dim![1]).not.toMatch(/background|color|#[0-9a-fA-F]{3,8}/);
    // and no fade: a press that arrives late is not a press
    expect(dim![1]).not.toContain("transition");
  });

  it("the class the sheet dims is the class the module sets", () => {
    expect(css).toContain(`.gate button.${BUSY_CLASS},`);
  });

  it("the press cannot be left to the tap flash, which the app turns off", () => {
    // html, body opt the whole app out of the system's whitish blink, so a
    // button that declares nothing for a finger answers it with nothing
    expect(css).toContain("-webkit-tap-highlight-color: transparent;");
  });
});

describe("the third answer's line costs the card nothing", () => {
  it("is lifted out of the flow, so nothing above it ever moves for it", () => {
    const note = rule(".gate-note");
    expect(note).toContain("position: absolute;");
    expect(note).toContain("bottom: 0;"); // in the card's own bottom padding
    expect(rule(".gate")).toContain("position: relative;"); // its frame
    // no height, no margin: it cannot push the pill down even by accident
    for (const prop of ["height", "margin", "padding"]) {
      expect(note, `.gate-note must not declare ${prop}`).not.toMatch(
        new RegExp(`(?:^|;)\\s*${prop}\\s*:`),
      );
    }
  });

  it("is the card's own muted grey, and paints no border and no motion", () => {
    const note = rule(".gate-note");
    expect(note).toContain("color: var(--muted);"); // the version line's grey
    expect(note).not.toMatch(/#[0-9a-fA-F]{3,8}|rgb|hsl/);
    expect(note).not.toMatch(/border|animation/); // neither is its vocabulary
  });

  it("fades in on the sheet's usual short fade", () => {
    const note = rule(".gate-note");
    expect(note).toContain("opacity: 0;");
    const fade = /transition: opacity ([\d.]+)s/.exec(note);
    expect(fade, "the line must fade rather than blink").not.toBeNull();
    expect(Number(fade![1])).toBeGreaterThan(0);
    expect(Number(fade![1])).toBeLessThanOrEqual(0.3);
    expect(rule(`.gate-note.${NOTE_CLASS}`).trim()).toBe("opacity: 1;");
  });
});

describe("the card ships as 0.3.101", () => {
  it("the version on the badge is the version of this change", () => {
    expect(main).toMatch(/^const APP_VERSION = "0\.3\.101"; \/\/ \S/m);
  });
});
