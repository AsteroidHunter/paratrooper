import { defineConfig } from "vite";

// The FastAPI service serves the built PWA, so /api and /ws are same-origin in
// production. In dev, proxy them to the local backend.
export default defineConfig({
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
