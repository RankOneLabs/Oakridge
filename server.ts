import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { parseArgs } from "node:util";
import { mkdir, readFile } from "node:fs/promises";
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

type Subscriber = (evt: EnvelopeEvent) => void;
const subscribers = new Set<Subscriber>();

function subscribe(cb: Subscriber): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
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
  for (const cb of subscribers) {
    try {
      cb(evt);
    } catch {
      // one subscriber's failure shouldn't affect others
    }
  }
  return evt;
}

// === http bind (fail fast before spawning CC) ===

const app = new Hono();

app.get("/", (c) => c.text(`cc-deck v0 — session ${sessionId}`));

app.get("/stream", (c) => {
  return streamSSE(c, async (stream) => {
    const pending: EnvelopeEvent[] = [];
    let notify: (() => void) | null = null;
    const unsub = subscribe((evt) => {
      pending.push(evt);
      if (notify) {
        const n = notify;
        notify = null;
        n();
      }
    });

    // 15s heartbeat so mobile carriers don't drop the connection
    const heartbeat = setInterval(() => {
      stream.write(": ping\n\n").catch(() => {});
    }, 15000);

    let sentUpTo = -1;
    try {
      // catchup: replay everything already in the JSONL
      const contents = await readFile(jsonlPath, "utf8");
      for (const line of contents.split("\n")) {
        if (!line.trim()) continue;
        const evt = JSON.parse(line) as EnvelopeEvent;
        sentUpTo = Math.max(sentUpTo, evt.id);
        await stream.writeSSE({
          event: "message",
          data: JSON.stringify(evt),
          id: String(evt.id),
        });
      }

      // live: drain new events as they arrive
      while (!stream.aborted) {
        if (pending.length === 0) {
          await new Promise<void>((r) => {
            notify = r;
          });
          continue;
        }
        const evt = pending.shift()!;
        if (evt.id <= sentUpTo) continue; // dedupe against catchup
        sentUpTo = evt.id;
        await stream.writeSSE({
          event: "message",
          data: JSON.stringify(evt),
          id: String(evt.id),
        });
      }
    } finally {
      clearInterval(heartbeat);
      unsub();
    }
  });
});

app.get("/events", async (c) => {
  const sinceRaw = c.req.query("since");
  const since = sinceRaw !== undefined ? Number(sinceRaw) : -1;
  if (!Number.isFinite(since)) {
    return c.json({ error: "invalid since" }, 400);
  }
  const contents = await readFile(jsonlPath, "utf8");
  const events: EnvelopeEvent[] = [];
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    const evt = JSON.parse(line) as EnvelopeEvent;
    if (evt.id > since) events.push(evt);
  }
  return c.json({ session_id: sessionId, events });
});

let inputQueue: Promise<unknown> = Promise.resolve();

app.post("/input", async (c) => {
  let body: { text?: unknown };
  try {
    body = (await c.req.json()) as { text?: unknown };
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  if (typeof body.text !== "string" || body.text.length === 0) {
    return c.json({ error: "text must be a non-empty string" }, 400);
  }
  const text = body.text;
  const task = async () => {
    const line =
      JSON.stringify({
        type: "user",
        message: { role: "user", content: text },
      }) + "\n";
    const w = proc.stdin as import("bun").FileSink;
    w.write(line);
    await w.flush();
  };
  inputQueue = inputQueue.then(task, task);
  await inputQueue;
  return c.json({ ok: true });
});

app.post("/approval", (c) => c.text("not implemented", 501));
app.post("/hook/approval", (c) => c.text("not implemented", 501));

let server: ReturnType<typeof Bun.serve>;
try {
  server = Bun.serve({
    port,
    hostname: "0.0.0.0",
    // SSE streams are long-lived; Bun defaults to 10s per request which
    // drops the connection before our 15s heartbeat fires.
    idleTimeout: 255,
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
  "--replay-user-messages",
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
