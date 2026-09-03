// Pins for the sign-in check (src/tokengate.ts) and its main.ts wiring.
//
// The bug: the gate stored whatever was typed and built the chat around it. A
// wrong token then got the socket refused at the handshake, ws.onclose retried
// every two seconds forever, and the screen was an empty thread that never said
// anything. So Connect asks the server once, and the box wears the answer.
//
// Three answers, and the third is the one worth pinning hardest: only the gate
// itself refusing (401/403) may paint the box red. No answer at all, or a
// server that broke, says nothing about the token — the border stays neutral,
// Connect comes back, and the app invents no copy for a case the spec does not
// cover.
//
// The controller runs on element STAND-INS, the tapcaret.test.ts way: the three
// things it touches are a value, a class list and an input listener, so the
// whole flow is exercised under node against a fake fetch. What the classes
// then LOOK like is a source pin over the sheet, like the other presentation
// pins — jsdom resolves none of these rules and there is no browser here.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BAD_CLASS,
  CHECK_URL,
  type Fetcher,
  type GateBox,
  type GateButton,
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

interface Box extends GateBox {
  classes: Set<string>;
  type(text: string): void; // a keystroke: the value changes and the app hears it
}

function makeBox(value = ""): Box {
  const classes = new Set<string>();
  let onInput: (() => void) | null = null;
  return {
    value,
    classes,
    classList: {
      add: (c: string) => void classes.add(c),
      remove: (c: string) => void classes.delete(c),
    },
    addEventListener: (_type: "input", listener: () => void) => {
      onInput = listener;
    },
    type(text: string) {
      this.value = text;
      onInput?.();
    },
  };
}

const makeButton = (): GateButton => ({ disabled: false });

/** A fetch that answers with one status, and remembers how it was called. */
function answering(status: number) {
  const calls: { url: string; auth: string; cache: string }[] = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization, cache: init.cache });
    return { status };
  };
  return { fetcher, calls };
}

/** A fetch that never answers, held open by the test. */
function hanging() {
  let release: (status: number) => void = () => {};
  const calls: string[] = [];
  const fetcher: Fetcher = (url) => {
    calls.push(url);
    return new Promise((resolve) => {
      release = (status) => resolve({ status });
    });
  };
  return { fetcher, calls, answer: (status: number) => release(status) };
}

/** The card, wired the way main.ts wires it, with the beat's clock in hand. */
function card(fetcher: Fetcher, value: string) {
  const box = makeBox(value);
  const button = makeButton();
  const beats: { ms: number; run: () => void }[] = [];
  const accepted: string[] = [];
  const gate = createTokenGate(box, button, {
    fetcher,
    wait: (ms, run) => void beats.push({ ms, run }),
    accepted: (v) => void accepted.push(v),
  });
  return { box, button, beats, accepted, gate };
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

  it("an empty box asks nothing at all", async () => {
    const { fetcher, calls } = answering(204);
    const c = card(fetcher, "   ");
    await c.gate.submit();
    expect(calls).toEqual([]);
    expect(c.button.disabled).toBe(false);
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
    expect(gate).toContain("createTokenGate(input, save, {");
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

describe("the gate's rules paint a border and move nothing", () => {
  const rule = (selector: string): string => {
    const m = new RegExp(`(?:^|\\n)${selector.replace(/\./g, "\\.")} \\{([^}]*)\\}`).exec(
      css.replace(/\/\*[\s\S]*?\*\//g, ""),
    );
    expect(m, `no rule for ${selector}`).not.toBeNull();
    return m![1];
  };

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

describe("the card ships as 0.3.99", () => {
  it("the version on the badge is the version of this change", () => {
    expect(main).toMatch(/^const APP_VERSION = "0\.3\.99"; \/\/ \S/m);
  });
});
