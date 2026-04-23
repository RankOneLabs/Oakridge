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
      "/stream": { target: backendTarget, changeOrigin: true },
      "/events": backendTarget,
      "/input": backendTarget,
      "/approval": backendTarget,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
