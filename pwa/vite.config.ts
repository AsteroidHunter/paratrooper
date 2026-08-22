import { type Plugin, defineConfig } from "vite";

// The app's stylesheet, folded into the built document instead of linked from
// it.
//
// A <link rel="stylesheet"> is render-blocking by definition: the browser paints
// NOTHING, not even markup it has already parsed, until that file is back and
// read. index.html carries the launch cover precisely so the cover is on screen
// from the document's first frame, and this link was the one thing left in
// between: a second request, a second service-worker cache lookup and a second
// parse, all of them in front of a cover that needs none of them.
//
// The whole sheet goes in, not a critical slice of it. A critical/rest split
// would cost a second mechanism and still leave a file to go and fetch, and at
// this size there is nothing to split: the sheet is about 16 kB raw and 4 kB
// compressed, against a document that is 8 kB compressed and has to arrive
// anyway. The other way round, keeping the file but making it non-blocking with
// the media="print" swap or a preload, was turned down for a different reason:
// it leaves the styles landing at a moment nobody can name, and the cover is
// only safe over an unstyled app because the app is styled again before the
// cover lifts. Inlining makes that structural rather than a race. The styles
// arrive in the same bytes as the cover, so there is no instant at which the
// page holds one and not the other.
//
// The cost is a bigger document, paid once per open, in place of a fetch that
// was also paid once per open AND held the screen blank while it happened.
function inlineAppStylesheet(): Plugin {
  return {
    name: "inline-app-stylesheet",
    apply: "build", // dev serves CSS through the module graph: no link to fold
    enforce: "post", // after vite has emitted the document and the sheet it links
    generateBundle(_options, bundle) {
      const page = bundle["index.html"];
      if (!page || page.type !== "asset") return;
      const read = (s: string | Uint8Array): string =>
        typeof s === "string" ? s : new TextDecoder().decode(s);
      page.source = read(page.source).replace(/<link[^>]*\brel="stylesheet"[^>]*>/g, (tag) => {
        // the href vite writes is site-absolute ("/assets/x.css"); the bundle
        // keys the same file without the leading slash
        const name = (/\bhref="([^"]*)"/.exec(tag)?.[1] ?? "").replace(/^\//, "");
        const sheet = bundle[name];
        if (!sheet || sheet.type !== "asset") return tag; // not one of ours: leave it be
        delete bundle[name]; // nothing links it now, so it has no business shipping
        // A stylesheet must not be able to carry the string that ends the
        // element it is being put inside. The escape is a no-op to the CSS
        // parser and stops the HTML parser closing the block early.
        return `<style>${read(sheet.source).replace(/<\/style/gi, "<\\/style")}</style>`;
      });
    },
  };
}

// The FastAPI service serves the built PWA, so /api and /ws are same-origin in
// production. In dev, proxy them to the local backend.
export default defineConfig({
  plugins: [inlineAppStylesheet()],
  define: {
    __BUILT_AT__: JSON.stringify(new Date().toISOString().slice(0, 16) + "Z"),
    // the server commit this bundle was built against (Dockerfile.web passes
    // Render's RENDER_GIT_COMMIT build arg through; "dev" locally) — compared
    // to /api/health's version so a stale cached bundle can self-refresh
    __SERVER_VERSION__: JSON.stringify((process.env.RENDER_GIT_COMMIT || "dev").slice(0, 7)),
  },
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:8000", changeOrigin: true },
      "/ws": { target: "ws://127.0.0.1:8000", ws: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
