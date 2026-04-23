import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { streamSSE } from "hono/streaming";
import { parseArgs } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

app.get("/stream", (c) => {
  const signal = c.req.raw.signal;
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

    // Wake the wait loop if the client disconnects while idle, so the finally
    // block runs promptly instead of leaking the heartbeat + subscriber.
    const onAbort = () => {
      if (notify) {
        const n = notify;
        notify = null;
        n();
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });

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
      while (!signal.aborted) {
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
      signal.removeEventListener("abort", onAbort);
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
  if (!proc) {
    // Window at startup: HTTP server binds before Bun.spawn runs.
    return c.json({ error: "subprocess not ready" }, 503);
  }
  const stdin = proc.stdin as import("bun").FileSink;
  const text = body.text;
  const task = async () => {
    const line =
      JSON.stringify({
        type: "user",
        message: { role: "user", content: text },
      }) + "\n";
    stdin.write(line);
    await stdin.flush();
  };
  inputQueue = inputQueue.then(task, task);
  await inputQueue;
  return c.json({ ok: true });
});

// === approval plumbing ===

type Decision = "allow" | "deny";
interface PendingApproval {
  resolve: (d: Decision) => void;
}
const pendingApprovals = new Map<string, PendingApproval>();

interface HookInput {
  session_id: string;
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
  hook_event_name: string;
}

app.post("/hook/approval", async (c) => {
  // only accept from 127.0.0.1 — the gate runs in our process tree
  if (!bunServer) return c.text("server not ready", 503);
  const info = bunServer.requestIP(c.req.raw);
  if (!info || (info.address !== "127.0.0.1" && info.address !== "::1")) {
    return c.text("forbidden", 403);
  }

  let hook: HookInput;
  try {
    hook = (await c.req.json()) as HookInput;
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  if (hook.hook_event_name !== "PreToolUse") {
    return c.json({ error: `unexpected hook_event_name: ${hook.hook_event_name}` }, 400);
  }

  const requestId = randomUUID();
  const signal = c.req.raw.signal;
  try {
    const decision = await new Promise<Decision>((resolveDecision, rejectDecision) => {
      pendingApprovals.set(requestId, { resolve: resolveDecision });
      // If the gate's curl is aborted (CC killed, --max-time expired, server
      // shutting down), reject so we don't leak the map entry forever.
      signal.addEventListener(
        "abort",
        () => rejectDecision(new Error("gate_aborted")),
        { once: true },
      );
      void emit("permission_request", {
        request_id: requestId,
        tool_name: hook.tool_name,
        tool_input: hook.tool_input,
        tool_use_id: hook.tool_use_id,
      });
    });

    await emit("permission_resolved", { request_id: requestId, decision });

    return c.json({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason:
          decision === "allow"
            ? "operator approved via cc-deck"
            : "operator denied via cc-deck",
      },
    });
  } catch {
    // Gate aborted before a decision arrived. Clean up the map entry and
    // notify connected UI clients so the card clears.
    if (pendingApprovals.delete(requestId)) {
      await emit("permission_resolved", {
        request_id: requestId,
        decision: "deny",
        reason: "gate_aborted",
      });
    }
    return c.json({ error: "gate aborted" }, 408);
  }
});

app.post("/approval", async (c) => {
  let body: { request_id?: unknown; decision?: unknown };
  try {
    body = (await c.req.json()) as { request_id?: unknown; decision?: unknown };
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  if (typeof body.request_id !== "string") {
    return c.json({ error: "request_id must be a string" }, 400);
  }
  if (body.decision !== "approve" && body.decision !== "deny") {
    return c.json({ error: "decision must be 'approve' or 'deny'" }, 400);
  }
  const pending = pendingApprovals.get(body.request_id);
  if (!pending) {
    return c.json({ error: "unknown or already-resolved request_id" }, 404);
  }
  pendingApprovals.delete(body.request_id);
  pending.resolve(body.decision === "approve" ? "allow" : "deny");
  return c.json({ ok: true });
});

// === static PWA (built into pwa/dist/ via `bun run build:pwa`) ===

app.use(
  "/*",
  serveStatic({
    root: "./pwa/dist",
    rewriteRequestPath: (path) => (path === "/" ? "/index.html" : path),
  }),
);

let bunServer: ReturnType<typeof Bun.serve> | null = null;
try {
  bunServer = Bun.serve({
    port,
    hostname: "0.0.0.0",
    // SSE streams are long-lived; Bun defaults to 10s per request which
    // drops the connection before our 15s heartbeat fires. Hook approval
    // requests also park for as long as the operator takes to tap.
    idleTimeout: 255,
    fetch: app.fetch,
  });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`cc-deck: failed to bind port ${port}: ${msg}`);
  console.error(`is another cc-deck running? try: lsof -i :${port}`);
  process.exit(1);
}
const server = bunServer;

console.error(
  `cc-deck listening on http://${server.hostname}:${server.port}, workdir=${workdir}, session=${sessionId}`,
);

// === spawn CC subprocess ===

// generate a settings.json that registers gate.sh as the PreToolUse hook
const scriptDir = dirname(fileURLToPath(import.meta.url));
const gatePath = resolve(scriptDir, "scripts", "gate.sh");
const settingsPath = join(dataDir, "settings.json");
await writeFile(
  settingsPath,
  JSON.stringify(
    {
      hooks: {
        PreToolUse: [
          {
            matcher: ".*",
            hooks: [{ type: "command", command: gatePath }],
          },
        ],
      },
    },
    null,
    2,
  ),
);

const cmd = [
  claudeBin,
  "--print",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--include-hook-events",
  "--replay-user-messages",
  "--verbose",
  "--setting-sources", "",
  "--settings", settingsPath,
];

await emit("session_started", { command: cmd, workdir, sessionId });

let proc: ReturnType<typeof Bun.spawn> | null = null;
try {
  proc = Bun.spawn({
    cmd,
    cwd: workdir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CC_DECK_PORT: String(port),
    },
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

// Narrow past the null state; if spawn failed we'd have exited above.
if (!proc) process.exit(1);
const activeProc = proc;
const procStdout = activeProc.stdout as ReadableStream<Uint8Array>;
const procStderr = activeProc.stderr as ReadableStream<Uint8Array>;

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
  const code = await activeProc.exited;
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
    activeProc.kill();
  });
}
