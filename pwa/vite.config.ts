import { defineConfig } from "vite";

// The FastAPI service serves the built PWA, so /api and /ws are same-origin in
// production. In dev, proxy them to the local backend.
export default defineConfig({
  define: {
    __BUILT_AT__: JSON.stringify(new Date().toISOString().slice(0, 16) + "Z"),
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
