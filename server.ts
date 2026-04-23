import { Hono } from "hono";
import { parseArgs } from "node:util";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

// === args ===

const { values } = parseArgs({
  options: {
    workdir: { type: "string" },
    port: { type: "string", default: "8788" },
    claudeBin: { type: "string", default: "claude" },
    dataDir: { type: "string", default: "./data" },
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
const claudeBin = values.claudeBin ?? "claude";
const dataDir = values.dataDir ?? "./data";

// === session init ===

const sessionId = randomUUID();
const sessionsDir = join(dataDir, "sessions");
await mkdir(sessionsDir, { recursive: true });
const jsonlPath = join(sessionsDir, `${sessionId}.jsonl`);

const jsonlWriter = Bun.file(jsonlPath).writer();

let nextId = 0;

interface EnvelopeEvent {
  id: number;
  type: string;
  ts: string;
  payload: unknown;
}

async function emit(type: string, payload: unknown): Promise<EnvelopeEvent> {
  const evt: EnvelopeEvent = {
    id: nextId++,
    type,
    ts: new Date().toISOString(),
    payload,
  };
  jsonlWriter.write(JSON.stringify(evt) + "\n");
  await jsonlWriter.flush();
  return evt;
}

// === http bind (fail fast before spawning CC) ===

const app = new Hono();

app.get("/", (c) => c.text(`cc-deck v0 — session ${sessionId}`));
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
  `cc-deck listening on http://${server.hostname}:${server.port}, workdir=${workdir}, session=${sessionId}`,
);

// === spawn CC subprocess ===

const cmd = [
  claudeBin,
  "--print",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--include-hook-events",
  "--verbose",
];

await emit("session_started", { command: cmd, workdir, sessionId });

let proc: ReturnType<typeof Bun.spawn>;
try {
  proc = Bun.spawn({
    cmd,
    cwd: workdir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  await emit("subprocess_exited", { code: -1, reason: `spawn failed: ${msg}` });
  server.stop();
  console.error(`cc-deck: failed to spawn CC subprocess: ${msg}`);
  process.exit(1);
}

// === stream line splitter ===

async function* readLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (buf.length > 0) yield buf;
        return;
      }
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        yield buf.slice(0, idx);
        buf = buf.slice(idx + 1);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// === pipe subprocess stdout → envelope events ===

const procStdout = proc.stdout as ReadableStream<Uint8Array>;
const procStderr = proc.stderr as ReadableStream<Uint8Array>;

(async () => {
  for await (const line of readLines(procStdout)) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line);
      const type = typeof raw?.type === "string" ? raw.type : "unknown";
      await emit(type, raw);
    } catch (err) {
      await emit("subprocess_stdout_parse_error", {
        line,
        error: (err as Error).message,
      });
    }
  }
})();

// === pipe subprocess stderr → subprocess_stderr envelope events ===

(async () => {
  for await (const line of readLines(procStderr)) {
    await emit("subprocess_stderr", { line });
  }
})();

// === subprocess exit → emit + shutdown ===

let shutdownSignalReceived = false;

(async () => {
  const code = await proc.exited;
  await emit("subprocess_exited", {
    code,
    reason: shutdownSignalReceived
      ? "operator signal"
      : code === 0
        ? "clean"
        : "error",
  });
  await jsonlWriter.end();
  server.stop();
  process.exit(shutdownSignalReceived ? 0 : code === 0 ? 0 : 1);
})();

// === signal handlers: clean shutdown on Ctrl-C / systemctl stop ===

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    shutdownSignalReceived = true;
    proc.kill();
  });
}
