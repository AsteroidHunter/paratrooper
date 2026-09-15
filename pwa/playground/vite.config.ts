import { defineConfig } from "vite";

// The playground's own build, run AFTER the app's (pwa/package.json's build
// script) so that the app's emptyOutDir has already been and gone.
//
// Three things make it a page of this site rather than a second site:
//
//   - base "/playground/", so every hashed asset and the public files the
//     document names are written with that prefix and resolve under the folder
//     the service mounts them at;
//   - outDir "../dist/playground", which is the app's own dist with this page
//     inside it: src/paratrooper/web/app.py mounts pwa/dist at "/" with
//     StaticFiles(html=True), so dist/playground/index.html is served at
//     /playground/ with no server change and no Dockerfile change;
//   - emptyOutDir true, which is scoped to THAT subfolder and nothing else.
//     It is spelled out because the folder sits outside this root, and vite
//     refuses to empty such a folder silently.
//
// The root is not set here. The build is invoked as `vite build playground`
// from pwa/, which hands vite this directory as the root and finds this file
// inside it; setting root to "." would resolve against the working directory
// instead, which is the folder above.
//
// The dev server is kept for working on the page locally. It binds 127.0.0.1
// like everything else in this repo, and it deliberately does NOT use 5174:
// that port belongs to the standalone tool this page came from.
export default defineConfig({
  base: "/playground/",
  define: {
    // The cache name the page's own service worker uses, and the query it is
    // registered under, so a new deploy gets a new cache instead of serving the
    // last build's bundle out of the old one.
    __PLAYGROUND_BUILD__: JSON.stringify(
      new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14),
    ),
  },
  server: {
    host: "127.0.0.1",
    port: 5180,
    strictPort: true,
    open: false,
  },
  preview: {
    host: "127.0.0.1",
    port: 5181,
    strictPort: true,
    open: false,
  },
  build: {
    outDir: "../dist/playground",
    emptyOutDir: true,
    target: "es2022",
  },
});
