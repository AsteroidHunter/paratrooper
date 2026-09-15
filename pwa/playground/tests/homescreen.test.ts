// This page as its own Home Screen app, beside the chat app and not inside it.
//
// Two things have to be true for that, and neither of them can be felt for from
// node, so both are pinned at their sources.
//
//   1. The page declares itself: its own manifest with its own name, start URL
//      and scope, the iOS meta tags, and the app's icons rather than a second
//      set of them.
//   2. The two service workers on this origin do not fight. The app's is
//      registered at "/" and answers EVERY navigation with the cached app shell,
//      which is what a phone with the chat app installed would have done to this
//      page too. It now returns early for /playground, so the first visit
//      reaches the network; after that the page's own worker controls the folder
//      because a client is taken by the most specific scope that covers it.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const here = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");

const page = here("../index.html");
const worker = here("../public/sw.js");
const install = here("../src/install.ts");
const viteConfig = here("../vite.config.ts");
const manifest = JSON.parse(here("../public/manifest.webmanifest")) as Record<string, unknown> & {
  icons: { src: string }[];
};
const appWorker = here("../../public/sw.js");
const appManifest = JSON.parse(here("../../public/manifest.webmanifest")) as Record<
  string,
  unknown
>;
const appPackage = JSON.parse(here("../../package.json")) as { scripts: Record<string, string> };

describe("the page declares itself installable, on its own", () => {
  it("is its own app with its own name and its own folder", () => {
    expect(manifest.name).toBe("Bubble playground");
    expect(manifest.short_name).toBe("Playground");
    expect(manifest.start_url).toBe("/playground/");
    expect(manifest.scope).toBe("/playground/");
    expect(manifest.display).toBe("standalone");
    // not the chat app under another name
    expect(manifest.name).not.toBe(appManifest.name);
  });

  it("wears the app's colours and the app's icons rather than a second set", () => {
    expect(manifest.theme_color).toBe(appManifest.theme_color);
    expect(manifest.background_color).toBe(appManifest.background_color);
    expect(manifest.icons.map((i) => i.src)).toEqual(["/icon-192.png", "/icon-512.png"]);
  });

  it("says the iOS words, in the document, where the phone reads them", () => {
    expect(page).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
    expect(page).toContain(
      '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />',
    );
    expect(page).toContain('<link rel="apple-touch-icon" href="/icon-192.png" />');
    expect(page).toContain('<link rel="manifest" href="/playground/manifest.webmanifest" />');
    // viewport-fit is what lets the canvas reach under the notch
    expect(page).toMatch(/name="viewport"[\s\S]*?viewport-fit=cover/);
  });
});

describe("the page's own service worker", () => {
  it("takes over at once, like the app's", () => {
    expect(worker).toContain("self.skipWaiting()");
    expect(worker).toContain("self.clients.claim()");
  });

  it("is named after the build, so a deploy does not serve the last one", () => {
    expect(worker).toContain('const BUILD = new URL(self.location.href).searchParams.get("v")');
    expect(worker).toContain("const CACHE = `playground-${BUILD}`;");
    expect(install).toContain("sw.js?v=${__PLAYGROUND_BUILD__}");
    expect(viteConfig).toContain("__PLAYGROUND_BUILD__");
  });

  it("registers at its own scope, taken from the folder it was served from", () => {
    expect(install).toContain('const scope = new URL("./", document.baseURI);');
    expect(install).toContain("navigator.serviceWorker.register(script.href, { scope: scope.href })");
  });

  it("never answers for anything outside that folder", () => {
    expect(worker).toContain(
      "if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE)) return;",
    );
    expect(worker).toContain('const SCOPE = new URL("./", self.location.href).pathname;');
  });

  it("only ever deletes its own caches, because the store is the whole origin", () => {
    expect(worker).toContain('keys.filter((k) => k.startsWith("playground-") && k !== CACHE)');
    expect(worker).not.toContain("keys.filter((k) => k !== CACHE)");
  });

  it("asks for nothing: no push, no badge, no subscription of any kind", () => {
    for (const forbidden of ["push", "notificationclick", "pushsubscriptionchange"]) {
      expect(worker).not.toContain(`addEventListener("${forbidden}"`);
    }
    expect(worker).not.toContain("indexedDB");
  });
});

describe("the app's worker leaves this folder alone", () => {
  it("returns early for /playground the way it does for /api and /ws", () => {
    expect(appWorker).toMatch(
      /if \(\s*url\.pathname\.startsWith\("\/api"\) \|\|\s*url\.pathname\.startsWith\("\/ws"\) \|\|\s*url\.pathname\.startsWith\("\/playground"\)\s*\)\s*\n?\s*return;/,
    );
  });

  it("and the exclusion comes before the navigation answer, not after it", () => {
    const excluded = appWorker.indexOf('url.pathname.startsWith("/playground")');
    const navigation = appWorker.indexOf('if (request.mode === "navigate")');
    expect(excluded).toBeGreaterThan(0);
    expect(navigation).toBeGreaterThan(excluded);
  });

  it("carries a new shell name, so the phone actually activates it", () => {
    // a worker that answers differently and keeps its old cache name is a worker
    // the device has no reason to replace
    const named = /const SHELL = "paratrooper-shell-v(\d+)";/.exec(appWorker);
    expect(named).not.toBeNull();
    expect(Number(named![1])).toBeGreaterThanOrEqual(3);
  });

  it("is otherwise the same worker: the push side is untouched", () => {
    expect(appWorker).toContain('self.addEventListener("push"');
    expect(appWorker).toContain('self.addEventListener("pushsubscriptionchange"');
    expect(appWorker).toContain('clients.some((client) => client.visibilityState === "visible")');
  });
});

describe("the build puts the page where the service looks for it", () => {
  it("builds the app first and this page after it, in one command", () => {
    expect(appPackage.scripts.build).toBe(
      "npm run typecheck && vite build && vite build playground",
    );
  });

  it("type-checks both trees", () => {
    expect(appPackage.scripts.typecheck).toBe("tsc --noEmit && tsc --noEmit -p playground/tsconfig.json");
  });

  it("writes into the app's own dist, under the folder it is served at", () => {
    expect(viteConfig).toContain('base: "/playground/"');
    expect(viteConfig).toContain('outDir: "../dist/playground"');
    // emptied, but only that subfolder: the app's build has already been and gone
    expect(viteConfig).toContain("emptyOutDir: true");
  });
});
