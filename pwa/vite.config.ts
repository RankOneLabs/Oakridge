import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: Vite on :5173 with proxy for server endpoints on :8788.
// Build: emits to pwa/dist, Hono serves statically from the same process.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/stream": { target: "http://localhost:8788", changeOrigin: true },
      "/events": "http://localhost:8788",
      "/input": "http://localhost:8788",
      "/approval": "http://localhost:8788",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
