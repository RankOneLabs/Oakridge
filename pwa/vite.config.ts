import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Follow CC_DECK_PORT so running the server on a non-default port doesn't break
// dev-mode API routing. Matches the env var the gate script reads.
const backendTarget = `http://localhost:${process.env.CC_DECK_PORT ?? "8788"}`;

// Dev: Vite on :5173 with proxy for server endpoints.
// Build: emits to pwa/dist, Hono serves statically from the same process.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Top-level API routes used by the session list + inbox + CRUD.
      "/sessions": { target: backendTarget, changeOrigin: true },
      "/inbox": { target: backendTarget, changeOrigin: true },
      // Per-sid routes. Keyed by regex so any sid prefix gets proxied.
      // Must start with ^ for vite to treat the key as a RegExp.
      "^/[^/]+/(stream|events|input|approval|yolo)(\\?.*)?$": {
        target: backendTarget,
        changeOrigin: true,
      },
      // Legacy single-session aliases kept for the PR 2.5 cutover window.
      "/stream": { target: backendTarget, changeOrigin: true },
      "/events": backendTarget,
      "/input": backendTarget,
      "/approval": backendTarget,
      "/yolo": backendTarget,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
