// What the BUILT page does before a line of the bundle has run.
//
// The loading page is markup and styles in index.html (the comment at the top
// of that file carries the why), so it is paintable the moment the document is
// parsed. That is only worth something if the document has nothing else to wait
// for, and what a document waits for is settled at BUILD time rather than in
// the template: vite adds tags of its own, and the one it used to add was a
// <link rel="stylesheet">, which stops the browser painting anything at all
// until the file behind it is back. So this suite reads what vite actually
// produced, not what the source says, by running the real build in memory.
// Nothing is written: dist/ is left exactly as the last real build left it.
//
// The second half is the safety argument for the page. A panel sitting opaque
// over an app whose styles have not landed is fine, since that is what it is
// for. A panel that LIFTS off one is a flash of unstyled content, which is a
// worse artifact than the white it was traded for. The claim is that this cannot
// happen, and it is a claim about the built page and about the module in equal
// parts, so both halves are pinned here together.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { build } from "vite";
import { LOAD_MIN_HOLD_MS } from "../src/splash";

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
    // at an unknown instant, which is the one thing the lift rule below must
    // not have to race.
    expect(PAGE).not.toContain('media="print"');
    expect(PAGE).not.toContain('rel="preload"');
    expect(PAGE).not.toContain("onload=");
  });

  it("ships no stylesheet file at all, so there is nothing left to go and get", () => {
    expect(FILES.filter((f) => f.endsWith(".css"))).toEqual([]);
    // The one thing the page still fetches is the bundle, and a module script
    // is deferred, so it cannot hold the paint either. It is also the ONLY
    // script the built page carries: the head used to run an inline one to
    // recompute the old cover's geometry off the screen, and the scene that
    // replaced that cover states its own, so there is no code of any kind in
    // front of the first frame.
    const scripts = [...PAGE.matchAll(/<script([^>]*)>/g)].map((m) => m[1]);
    expect(scripts.length).toBe(1);
    expect(scripts[0]).toContain("src=");
    expect(scripts[0]).toContain('type="module"');
  });

  it("carries the whole loading scene, markup and styles, in the bytes it serves", () => {
    // tests/loading.test.ts holds the scene to its own geometry, off the
    // template. This is the other half: what vite actually emitted still has
    // every part of it, and still has it INLINE. A build step that pulled the
    // head's <style> out into a file would leave the page painting a bare white
    // panel until that file came back, which is the flash the whole arrangement
    // exists to remove.
    for (const part of ["globe", "earth"]) {
      expect([part, PAGE.includes(`class="${part}"`)]).toEqual([part, true]);
    }
    for (const sel of ["#loading", ".scene", ".globe", ".earth", ".coast"]) {
      expect([sel, PAGE.includes(sel)]).toEqual([sel, true]);
    }
    // The coastline is the one part of this scene that is a drawing rather than
    // a box, so it is the one part a build step could plausibly decide to pull
    // out into a file of its own. It has to still be written out in the bytes
    // the page serves, and it has to still be stated once and used twice: the
    // second copy is what makes the loop seamless, and naming the first is what
    // keeps it from costing a second 19,457 bytes.
    expect(PAGE).toContain("<defs>");
    const uses = [...PAGE.matchAll(/<use\b[^>]*>/g)];
    expect(uses.length).toBe(2);
    const id = /<path[^>]*\bid="([^"]*)"/.exec(PAGE)?.[1];
    expect(id).toBeTruthy();
    for (const u of uses) expect(u[0]).toContain(`href="#${id}"`);
    expect(/\bd="[Mm][^"]{5000,}"/.test(PAGE)).toBe(true); // the shape itself, not a stub
    // the scene arriving and the globe turning, plus the answer for anyone
    // who asked for reduced motion, which slows that turn rather than stopping
    // it: a still loading indicator reads as an app that has died, and this is
    // now the only moving thing on the page
    for (const name of ["ld-spin", "ld-appear"]) {
      expect([name, PAGE.includes(`@keyframes ${name}`)]).toEqual([name, true]);
    }
    expect(PAGE).toContain("prefers-reduced-motion: reduce");
    // and the slow-down survived the build as a slow-down. The page's own
    // <style> is the first one in the document (the app's sheet is folded in
    // after it), and it is the only one this claim is about: the app's bubbles
    // do stop under the same setting, and should, since a person starts those.
    const own = PAGE.slice(PAGE.indexOf("<style>"), PAGE.indexOf("</style>"));
    const full = Number(/animation:\s*ld-spin\s+(\d+)ms/.exec(own)?.[1]);
    const slow = Number(
      /prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?animation-duration:\s*(\d+)ms/.exec(own)?.[1],
    );
    expect(full).toBeGreaterThan(0);
    expect(slow).toBe(full * 2);
    expect(own).not.toMatch(/animation:\s*none/);
    // and the scene fetches nothing: no picture, no font, no second file
    const scene = PAGE.slice(PAGE.indexOf("#loading"), PAGE.indexOf('<div id="app">'));
    expect(scene).not.toContain("url(");
    expect(scene).not.toContain("data:");
    expect(scene).not.toContain("<img");
  });

  it("carries the app's styles itself, all of them", () => {
    expect(CUSTOM_PROPS.length).toBeGreaterThan(20); // the sweep is not vacuous
    for (const prop of CUSTOM_PROPS) expect([prop, PAGE.includes(prop)]).toEqual([prop, true]);
    // the at-rules survive too, which a naive concatenation would be the first
    // thing to lose. The document carries at-rules of its own (the loading
    // page's display-mode and reduced-motion rules, and its orbit), so the
    // counts are floors and the names are what makes the sweep exact.
    expect(PAGE.split("@media").length - 1).toBeGreaterThanOrEqual(
      STYLES_CSS.split("@media").length - 1,
    );
    const frames = [...STYLES_CSS.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]);
    expect(frames.length).toBeGreaterThan(2); // the sweep is not vacuous
    for (const name of frames) expect([name, PAGE.includes(name)]).toEqual([name, true]);
    expect(PAGE.split("@keyframes").length - 1).toBeGreaterThanOrEqual(frames.length);
  });

  it("keeps the app's styles below the loading page's own, the order the link had", () => {
    // the loading page states its white and its whole scene in the head <style>
    // index.html carries; the app's sheet is folded in after it, exactly where
    // the link used to sit. An app rule that named one of the page's own
    // selectors would win, and did before this change too: nothing about the
    // cascade moved.
    const coverAt = PAGE.indexOf("#loading");
    const appAt = PAGE.indexOf(":root{");
    expect(coverAt).toBeGreaterThan(-1);
    expect(appAt).toBeGreaterThan(coverAt);
  });
});

describe("the loading page cannot lift before the app's styles have applied", () => {
  // The whole reason a non-blocking stylesheet would have been safe here is
  // that the loading page is opaque, fixed and over everything, so an unstyled
  // app underneath is not on screen. That argument is only worth anything if
  // the page is still there when the styles land. These four are why it is.

  beforeEach(() => {
    vi.useFakeTimers(); // the lift timers arm on adoption
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("puts the styles and the page in the same bytes, so neither arrives alone", () => {
    // not an ordering claim and not a timing one: one document carries both, so
    // there is no instant at which it holds the scene and not the styles
    expect(PAGE).toContain('<div id="loading">');
    expect(PAGE).toContain(":root{");
    expect(PAGE).not.toContain('rel="stylesheet"');
  });

  it("finishes the styles in the head, before the parser reaches the scene", () => {
    // the sheet is folded in where the link was, which is in the head, so it is
    // applied before the parser has even made the element it protects. Nothing
    // downstream depends on this, since the case below is the actual guarantee,
    // but it is the plainest statement of the order and costs one line to hold.
    const appStyleEndsAt = PAGE.indexOf("</style>", PAGE.indexOf(":root{"));
    expect(appStyleEndsAt).toBeLessThan(PAGE.indexOf("</head>"));
    expect(appStyleEndsAt).toBeLessThan(PAGE.indexOf('<div id="loading">'));
  });

  it("runs that script as a module, which cannot execute until the parse is done", () => {
    // a module script is deferred by definition, so by the time the bundle's
    // first statement runs the document has been parsed end to end: every
    // <style> in it has been applied and the loading page's element exists
    const scripts = [...PAGE.matchAll(/<script([^>]*)>/g)].map((m) => m[1]);
    const fetched = scripts.filter((s) => s.includes("src="));
    expect(fetched.length).toBe(1);
    expect(fetched[0]).toContain('type="module"');
  });

  it("leaves no code at all in front of the paint, not even an inline script", () => {
    // The head used to carry one, which recomputed the old cover's geometry off
    // the screen because that cover had to land on the pixels the phone's
    // stored picture used. The scene that replaced it states its own geometry
    // in lengths, so the first frame needs nothing executed to be right. The
    // built page is where this is checked rather than the template, because a
    // build step is free to add a tag of its own.
    expect(PAGE).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(PAGE).not.toContain("splashfit");
  });

  it("arms the lift in the bundle, so nothing can lift before the parse", async () => {
    // The last link. The lift is two timers and they are started by
    // installLoadingScreen, not by loading the module, so the earliest instant
    // the page can go anywhere is a whole minimum hold after the bundle adopted
    // it, which is after the parse, which is after the styles.
    const el = { id: "loading", style: {} as Record<string, string>, remove() {} };
    vi.stubGlobal("document", { getElementById: (id: string) => (id === "loading" ? el : null) });
    vi.stubGlobal("navigator", { standalone: true, userAgent: "iPhone" });
    vi.stubGlobal("screen", { width: 390, height: 844 });
    vi.stubGlobal("window", { devicePixelRatio: 3 });
    vi.resetModules(); // a fresh evaluation stands in for the bundle's first run
    const mod = await import("../src/splash");

    // the module has been evaluated and nothing adopted: no timer exists, so no
    // amount of time takes the page anywhere
    vi.advanceTimersByTime(LOAD_MIN_HOLD_MS * 100);
    expect(el.style.opacity).toBeUndefined();

    const loading = mod.installLoadingScreen();
    expect(loading.lifted()).toBe(false); // the clock starts here and nowhere earlier
    loading.settled(); // even an app that settled instantly waits out the hold
    vi.advanceTimersByTime(LOAD_MIN_HOLD_MS - 1);
    expect(loading.lifted()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(loading.lifted()).toBe(true);
  });
});
