// A batch of frames folds the thread once (main.ts foldOnce): a history page
// and the saved copy at boot apply every frame with the per-frame fold, the
// receipt and the bottom pin held, then fold and derive the receipt once, and
// their callers pin once. The motion rig measured the per-frame version as the
// stall at the end of a scroll back through history.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { transformWithEsbuild } from "vite";

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

function fnBody(name: string): string {
  const start = main.search(new RegExp(`(async )?function ${name}\\(`));
  expect(start, `main.ts has no ${name}`).toBeGreaterThan(-1);
  return main.slice(start, main.indexOf("\n}", start) + 2);
}

/** foldOnce, run for real in its own context, with counting collaborators */
async function harness() {
  const code = (
    await transformWithEsbuild(`let foldHeld = false;\n${fnBody("foldOnce")}\n` +
      "globalThis.__held = () => foldHeld; globalThis.__foldOnce = foldOnce;", "fold.ts", {
      loader: "ts",
    })
  ).code;
  const calls: string[] = [];
  const context: Record<string, unknown> = {
    decorate: () => calls.push("decorate"),
    updateReceipt: () => calls.push("receipt"),
  };
  runInNewContext(code, context);
  return {
    calls,
    held: context.__held as () => boolean,
    foldOnce: context.__foldOnce as (apply: () => void) => void,
  };
}

describe("foldOnce", () => {
  it("holds the fold for the whole batch, then folds and derives the receipt once", async () => {
    const h = await harness();
    const seen: boolean[] = [];
    h.foldOnce(() => {
      for (let i = 0; i < 25; i++) seen.push(h.held());
    });
    expect(seen).toEqual(Array(25).fill(true));
    expect(h.held()).toBe(false);
    expect(h.calls).toEqual(["decorate", "receipt"]);
  });

  it("lets go of the hold even when a frame throws, so later frames fold again", async () => {
    const h = await harness();
    expect(() =>
      h.foldOnce(() => {
        throw new Error("bad frame");
      }),
    ).toThrow("bad frame");
    expect(h.held()).toBe(false);
  });
});

describe("the wiring", () => {
  it("applyEvent skips its own fold and receipt inside a batch, and nowhere else", () => {
    const apply = fnBody("applyEvent");
    expect(apply).toContain("if (!foldHeld) decorate();");
    expect(apply).toContain("if (!foldHeld) updateReceipt();");
    expect(apply.match(/decorate\(\);/g)).toHaveLength(1);
  });

  it("the bottom pin stands down inside a batch, before it reads any geometry", () => {
    const pin = fnBody("scrollToBottom");
    expect(pin).toContain("if (foldHeld) return;");
    expect(pin.indexOf("if (foldHeld) return;")).toBeLessThan(pin.indexOf("t.scrollHeight"));
  });

  it("a history page lands as one batch, and its own pin comes after the fold", () => {
    const drain = fnBody("drainOlder");
    expect(drain).toContain("if (page) foldOnce(() => { for (const m of page) applyEvent(m); });");
    expect(drain.indexOf("foldOnce(")).toBeLessThan(
      drain.indexOf("t.scrollTop = prevScroll + (t.scrollHeight - prevHeight)"),
    );
  });

  it("the saved copy lands as one batch, and the boot's one pin comes after the fold", () => {
    const boot = fnBody("bootFromCache");
    expect(boot).toContain("foldOnce(() => { for (const m of cached.frames) applyEvent(m); });");
    expect(boot.indexOf("foldOnce(")).toBeLessThan(boot.indexOf("scrollToBottom(true)"));
  });

  it("the hold is set in exactly one place", () => {
    expect(main.match(/foldHeld = true/g)).toHaveLength(1);
    expect(fnBody("foldOnce")).toContain("foldHeld = true");
  });
});
