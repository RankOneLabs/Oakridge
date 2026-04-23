import { Hono } from "hono";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    workdir: { type: "string" },
    port: { type: "string", default: "8788" },
  },
});

if (!values.workdir) {
  console.error("usage: bun run server.ts --workdir=<path> [--port=8788]");
  process.exit(1);
}

const workdir = values.workdir;
const port = Number(values.port);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`invalid --port=${values.port}`);
  process.exit(1);
}

const app = new Hono();

app.get("/", (c) => c.text("cc-deck v0 — not yet wired"));

app.get("/stream", (c) => c.text("not implemented", 501));
app.get("/events", (c) => c.text("not implemented", 501));
app.post("/input", (c) => c.text("not implemented", 501));
app.post("/approval", (c) => c.text("not implemented", 501));
app.post("/hook/approval", (c) => c.text("not implemented", 501));

let server: ReturnType<typeof Bun.serve>;
try {
  server = Bun.serve({
    port,
    hostname: "0.0.0.0",
    fetch: app.fetch,
  });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`cc-deck: failed to bind port ${port}: ${msg}`);
  console.error(`is another cc-deck running? try: lsof -i :${port}`);
  process.exit(1);
}

console.error(
  `cc-deck listening on http://${server.hostname}:${server.port}, workdir=${workdir}`,
);
