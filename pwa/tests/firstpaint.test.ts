// What the BUILT page does before a line of the bundle has run.
//
// The launch cover is markup, styles and art in index.html (the comment at the
// top of that file carries the why), so it is paintable the moment the document
// is parsed. That is only worth something if the document has nothing else to
// wait for, and what a document waits for is settled at BUILD time rather than
// in the template: vite adds tags of its own, and the one it used to add was a
// <link rel="stylesheet">, which stops the browser painting anything at all
// until the file behind it is back. So this suite reads what vite actually
// produced, not what the source says, by running the real build in memory.
// Nothing is written: dist/ is left exactly as the last real build left it.
//
// The second half is the safety argument for the cover. A cover sitting opaque
// over an app whose styles have not landed is fine, since that is what it is
// for. A cover that LIFTS off one is a flash of unstyled content, which is a
// worse artifact than the white it was traded for. The claim is that this cannot
// happen, and it is a claim about the built page and about the module in equal
// parts, so both halves are pinned here together.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { build } from "vite";
import { COVER_MIN_HOLD_MS } from "../src/splash";

// one emitted file, in the shape the two checks below need it
interface Emitted {
  fileName: string;
  source?: string | Uint8Array;
}

let PAGE = ""; // the built document, as it would be served
let FILES: string[] = []; // every file the build emitted alongside it

beforeAll(async () => {
  const result = await build({
    root: fileURLToPath(new URL("..", import.meta.url)),
    logLevel: "silent",
    // in memory, and with the real vite.config.ts underneath: the point is to
    // read vite's own output, so nothing here may override how it is produced
    build: { write: false },
  });
  const first = Array.isArray(result) ? result[0] : result;
  const output = (first as unknown as { output: Emitted[] }).output;
  FILES = output.map((f) => f.fileName);
  const page = output.find((f) => f.fileName === "index.html");
  const source = page?.source ?? "";
  PAGE = typeof source === "string" ? source : new TextDecoder().decode(source);
  expect(PAGE).not.toBe(""); // a suite that read nothing must not pass quietly
}, 120_000);

// every custom property the app's stylesheet declares. A minifier rewrites
// whitespace and colours but never renames one of these, so finding all of them
// in the page is the whole sheet being there rather than a sample of it.
const STYLES_CSS = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const CUSTOM_PROPS = [
  ...new Set([...STYLES_CSS.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1])),
];

describe("the built page blocks its first paint on nothing", () => {
  it("links no stylesheet, which is the tag that blocks every paint there is", () => {
    // A <link rel="stylesheet"> anywhere in the head means no frame reaches the
    // screen until that file has arrived and been read. vite emitted one until
    // the config folded the sheet into the document instead.
    expect(PAGE).not.toContain('rel="stylesheet"');
    // and what is left links nothing that renders: a manifest is read when the
    // app is installed, a touch icon by the home screen
    const rels = [...PAGE.matchAll(/<link[^>]*\brel="([^"]*)"/g)].map((m) => m[1]);
    expect(rels.sort()).toEqual(["apple-touch-icon", "manifest"]);
  });

  it("does not defer one either, so nothing lands at a moment nobody can name", () => {
    // the two usual ways to keep the file and make it non-blocking. Both were
    // available and both were turned down: they leave the app's styles applying
    // at an unknown instant, which is the one thing the cover's lift rule below
    // must not have to race.
    expect(PAGE).not.toContain('media="print"');
    expect(PAGE).not.toContain('rel="preload"');
    expect(PAGE).not.toContain("onload=");
  });

  it("ships no stylesheet file at all, so there is nothing left to go and get", () => {
    expect(FILES.filter((f) => f.endsWith(".css"))).toEqual([]);
    // the one thing the page still fetches is the bundle, and a module script
    // is deferred, so it cannot hold the paint either
    const scripts = [...PAGE.matchAll(/<script([^>]*)>/g)].map((m) => m[1]);
    expect(scripts.length).toBe(1);
    expect(scripts[0]).toContain('type="module"');
  });

  it("carries the app's styles itself, all of them", () => {
    expect(CUSTOM_PROPS.length).toBeGreaterThan(20); // the sweep is not vacuous
    for (const prop of CUSTOM_PROPS) expect([prop, PAGE.includes(prop)]).toEqual([prop, true]);
    // the at-rules survive too, which a naive concatenation would be the first
    // thing to lose. The page holds the cover's own display-mode rule as well,
    // hence at least rather than exactly.
    expect(PAGE.split("@media").length - 1).toBeGreaterThanOrEqual(
      STYLES_CSS.split("@media").length - 1,
    );
    expect(PAGE.split("@keyframes").length - 1).toBe(STYLES_CSS.split("@keyframes").length - 1);
  });

  it("keeps the app's styles below the cover's own, the order the link had", () => {
    // the cover states its white, its logo rect and its credit line in the head
    // <style> index.html carries; the app's sheet is folded in after it, exactly
    // where the link used to sit. An app rule that named one of the cover's ids
    // would win, and did before this change too: nothing about the cascade moved.
    const coverAt = PAGE.indexOf("#splashcover");
    const appAt = PAGE.indexOf(":root{");
    expect(coverAt).toBeGreaterThan(-1);
    expect(appAt).toBeGreaterThan(coverAt);
  });
});

describe("the cover cannot lift before the app's styles have applied", () => {
  // The whole reason a non-blocking stylesheet would have been safe here is
  // that the cover is opaque, fixed and over everything, so an unstyled app
  // underneath is not on screen. That argument is only worth anything if the
  // cover is still there when the styles land. These four are why it is.

  beforeEach(() => {
    vi.useFakeTimers(); // the lift timers arm on adoption
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("puts the styles and the cover in the same bytes, so neither arrives alone", () => {
    // not an ordering claim and not a timing one: one document carries both, so
    // there is no instant at which the page holds the cover and not the styles
    expect(PAGE).toContain('<div id="splashcover">');
    expect(PAGE).toContain(":root{");
    expect(PAGE).not.toContain('rel="stylesheet"');
  });

  it("finishes the styles in the head, before the parser reaches the cover", () => {
    // the sheet is folded in where the link was, which is in the head, so it is
    // applied before the parser has even made the element it protects. Nothing
    // downstream depends on this, since the case below is the actual guarantee,
    // but it is the plainest statement of the order and costs one line to hold.
    const appStyleEndsAt = PAGE.indexOf("</style>", PAGE.indexOf(":root{"));
    expect(appStyleEndsAt).toBeLessThan(PAGE.indexOf("</head>"));
    expect(appStyleEndsAt).toBeLessThan(PAGE.indexOf('<div id="splashcover">'));
  });

  it("runs that script as a module, which cannot execute until the parse is done", () => {
    // a module script is deferred by definition, so by the time the bundle's
    // first statement runs the document has been parsed end to end: every
    // <style> in it has been applied and the cover element exists
    const scripts = [...PAGE.matchAll(/<script([^>]*)>/g)].map((m) => m[1]);
    expect(scripts.length).toBe(1);
    expect(scripts[0]).toContain('type="module"');
  });

  it("arms the lift inside that script, so nothing can lift before the parse", async () => {
    // The last link. The lift is two timers and they are started by
    // installSplashCover, not by loading the module, so the earliest instant a
    // cover can go anywhere is a whole minimum hold after the script adopted
    // it, which is after the parse, which is after the styles.
    const el = { id: "splashcover", style: {} as Record<string, string>, remove() {} };
    const byId: Record<string, typeof el> = {
      splashcover: el,
      splashlogo: { id: "splashlogo", style: {}, remove() {} },
      splashhandle: { id: "splashhandle", style: {}, remove() {} },
    };
    vi.stubGlobal("document", { getElementById: (id: string) => byId[id] ?? null });
    vi.stubGlobal("navigator", { standalone: true, userAgent: "iPhone" });
    vi.stubGlobal("screen", { width: 390, height: 844 });
    vi.stubGlobal("window", { devicePixelRatio: 3 });
    vi.resetModules(); // a fresh evaluation stands in for the bundle's first run
    const mod = await import("../src/splash");

    // the module has been evaluated and no cover adopted: no timer exists, so
    // no amount of time takes the cover anywhere
    vi.advanceTimersByTime(COVER_MIN_HOLD_MS * 100);
    expect(el.style.opacity).toBeUndefined();

    const cover = mod.installSplashCover("/splash-logo.png");
    expect(cover.lifted()).toBe(false); // the clock starts here and nowhere earlier
    cover.settled(); // even a thread that settled instantly waits out the hold
    vi.advanceTimersByTime(COVER_MIN_HOLD_MS - 1);
    expect(cover.lifted()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(cover.lifted()).toBe(true);
  });
});
