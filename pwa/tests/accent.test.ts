// A one-way ratchet on the accent colour. The app's blue-purple was #432bff and
// is now #4538ff; this test reads every source the accent could hide in and
// refuses the old value in any spelling, so a future edit — a hand-typed hex, an
// rgb() literal, a copied gradient stop — cannot quietly bring the old purple
// back. It is deliberately NOT scoped to the CSS token: the point is that the
// old number is gone from the whole surface, not just from where it was declared.
//
// Scanned, per the change's brief: the app source (../src), the playground
// source (../playground/src), the loading page (../index.html) and the
// server-side pages and push payloads (../../src/paratrooper). This file lives
// in ../tests, which is NOT one of those roots, so the old-colour spellings it
// names below to test against are not themselves flagged.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOTS = [
  new URL("../src/", import.meta.url),
  new URL("../playground/src/", import.meta.url),
  new URL("../index.html", import.meta.url),
  new URL("../../src/paratrooper/", import.meta.url),
].map(fileURLToPath);

// only the files a colour can be written into, so a stray binary under one of
// these roots is skipped rather than read as text
const TEXT = /\.(ts|tsx|js|mjs|cjs|css|html?|json|webmanifest|svg|py|txt|md)$/i;

function walk(path: string, out: string[] = []): string[] {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) walk(`${path}/${name}`, out);
  } else if (TEXT.test(path)) {
    out.push(path);
  }
  return out;
}

// The old accent, #432bff = rgb(67, 43, 255) = ~hsl(247, 100%, 58%), in every
// spelling it could be written: the hex (3/6/8-digit all carry the 432bff core),
// rgb()/rgba() with any separators, and the hsl()/hsla() equivalent. Each is
// named so a failure says which spelling crept in.
const OLD: Record<string, RegExp> = {
  hex: /432bff/i,
  rgb: /rgba?\(\s*67\s*[,\s]\s*43\s*[,\s]\s*255\b/i,
  hsl: /hsla?\(\s*24[67](?:\.\d+)?\s*[,\s]\s*100%\s*[,\s]\s*5[89](?:\.\d+)?%/i,
};

const FILES = ROOTS.flatMap((r) => walk(r));

describe("the old accent purple is gone for good", () => {
  it("scans a non-empty set of real source files", () => {
    // a walk that quietly found nothing would pass every check below for the
    // wrong reason, so the sweep proves it actually read the tree
    expect(FILES.length).toBeGreaterThan(20);
  });

  for (const [spelling, re] of Object.entries(OLD)) {
    it(`no file carries the old colour as ${spelling}`, () => {
      const hits = FILES.filter((f) => re.test(readFileSync(f, "utf8")));
      expect(hits, `old accent (${spelling}) found in:\n${hits.join("\n")}`).toEqual([]);
    });
  }

  it("the new accent #4538ff is the token both sheets now declare", () => {
    const app = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");
    const pg = readFileSync(
      fileURLToPath(new URL("../playground/src/bubbles.css", import.meta.url)),
      "utf8",
    );
    expect(app).toMatch(/--accent:\s*#4538ff\b/i);
    expect(pg).toMatch(/--accent:\s*#4538ff\b/i);
  });
});
