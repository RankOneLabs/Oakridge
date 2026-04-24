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
    // Default to loopback so a laptop connected to mixed networks (home wifi,
    // coffee shop, etc.) doesn't silently expose unauthenticated /input,
    // /approval, /stream, /events to any reachable peer. Operator opts into
    // phone/tablet access over Tailscale with --host=0.0.0.0.
    host: { type: "string", default: "127.0.0.1" },
    claudeBin: { type: "string", default: "claude" },
    dataDir: { type: "string" },
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
const host = values.host ?? "127.0.0.1";
const claudeBin = values.claudeBin ?? "claude";

// Resolve defaults from the server.ts location so data/ and pwa/dist/ don't
// depend on where the operator ran the command from. Operator override via
// --dataDir still works.
const moduleDir = dirname(fileURLToPath(import.meta.url));
const dataDir = values.dataDir ?? join(moduleDir, "data");
const pwaDistDir = join(moduleDir, "pwa", "dist");

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

async function readJsonlOrEmpty(path: string): Promise<string> {
  // The JSONL file is created lazily on the first emit. Clients hitting
  // /stream or /events before that first emit would see ENOENT; treat that
  // as an empty transcript rather than failing the request.
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "ENOENT"
    ) {
      return "";
    }
    throw err;
  }
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
  // EventSource replays Last-Event-ID on automatic reconnect. Resume from
  // there instead of re-sending the entire transcript each time.
  const lastEventIdHeader = c.req.header("last-event-id");
  const parsedResumeId = lastEventIdHeader ? Number(lastEventIdHeader) : NaN;
  const resumeAfter = Number.isFinite(parsedResumeId) ? parsedResumeId : -1;
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

    let sentUpTo = resumeAfter;
    try {
      // catchup: replay events from the JSONL that the client hasn't seen.
      const contents = await readJsonlOrEmpty(jsonlPath);
      for (const line of contents.split("\n")) {
        if (!line.trim()) continue;
        let evt: EnvelopeEvent;
        try {
          evt = JSON.parse(line) as EnvelopeEvent;
        } catch {
          // Partial line from a crash, or a corrupted byte — log and keep going
          // rather than tearing down the SSE setup.
          console.error(
            `cc-deck: skipping malformed JSONL line: ${line.slice(0, 120)}`,
          );
          continue;
        }
        if (evt.id <= sentUpTo) continue; // already on the client via Last-Event-ID
        sentUpTo = evt.id;
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
  const contents = await readJsonlOrEmpty(jsonlPath);
  const events: EnvelopeEvent[] = [];
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    let evt: EnvelopeEvent;
    try {
      evt = JSON.parse(line) as EnvelopeEvent;
    } catch {
      console.error(
        `cc-deck: skipping malformed JSONL line: ${line.slice(0, 120)}`,
      );
      continue;
    }
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
  if (typeof body.text !== "string") {
    return c.json({ error: "text must be a string" }, 400);
  }
  const text = body.text.trim();
  if (text.length === 0) {
    return c.json({ error: "text must be non-empty" }, 400);
  }
  if (!proc) {
    // Window at startup: HTTP server binds before Bun.spawn runs.
    return c.json({ error: "subprocess not ready" }, 503);
  }
  const stdin = proc.stdin as import("bun").FileSink;
  const task = async () => {
    const line =
      JSON.stringify({
        type: "user",
        message: { role: "user", content: text },
      }) + "\n";
    stdin.write(line);
    await stdin.flush();
  };
  try {
    inputQueue = inputQueue.then(task, task);
    await inputQueue;
  } catch (err) {
    // Subprocess exited between our ready-check and the write (EPIPE etc.).
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `subprocess write failed: ${msg}` }, 503);
  }
  return c.json({ ok: true });
});

// === approval plumbing ===

type Decision = "allow" | "deny";
interface PendingApproval {
  resolve: (d: Decision) => void;
  toolName: string;
}
const pendingApprovals = new Map<string, PendingApproval>();

// Session-scoped auto-approve state. Both reset when the server restarts.
// Persisted indirectly via the JSONL event log — yolo_mode_changed and
// tool_allowlisted events let reconnecting clients rebuild the same state.
let yoloMode = false;
const allowedTools = new Set<string>();

function drainParkedFor(predicate: (a: PendingApproval) => boolean): void {
  for (const [requestId, pending] of pendingApprovals) {
    if (!predicate(pending)) continue;
    pendingApprovals.delete(requestId);
    pending.resolve("allow");
  }
}

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

  // Auto-approve: yolo mode short-circuits everything; per-tool allowlist
  // short-circuits matching tools. Emit a notice so the operator can still
  // see what ran without prompting them.
  const autoReason = yoloMode
    ? "yolo"
    : allowedTools.has(hook.tool_name)
      ? "allowlist"
      : null;
  if (autoReason) {
    await emit("permission_auto_approved", {
      tool_name: hook.tool_name,
      tool_input: hook.tool_input,
      tool_use_id: hook.tool_use_id,
      reason: autoReason,
    });
    return c.json({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason:
          autoReason === "yolo"
            ? "auto-approved (yolo mode)"
            : `auto-approved (always allow ${hook.tool_name})`,
      },
    });
  }

  const requestId = randomUUID();
  const signal = c.req.raw.signal;

  // Install the waiter and abort listener before any await, so /approval can't
  // arrive before the map entry exists.
  let resolveDecision: (d: Decision) => void;
  let rejectDecision: (e: Error) => void;
  const decisionPromise = new Promise<Decision>((res, rej) => {
    resolveDecision = res;
    rejectDecision = rej;
  });
  pendingApprovals.set(requestId, {
    resolve: resolveDecision!,
    toolName: hook.tool_name,
  });
  // If the gate's curl is aborted (CC killed, --max-time expired, server
  // shutting down), reject so we don't leak the map entry forever.
  signal.addEventListener(
    "abort",
    () => rejectDecision!(new Error("gate_aborted")),
    { once: true },
  );

  try {
    // Await instead of fire-and-forget so a failing emit (disk full,
    // permission error) surfaces through the outer catch rather than
    // becoming an unhandled rejection.
    await emit("permission_request", {
      request_id: requestId,
      tool_name: hook.tool_name,
      tool_input: hook.tool_input,
      tool_use_id: hook.tool_use_id,
    });

    const decision = await decisionPromise;

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
  } catch (err) {
    const isGateAbort =
      err instanceof Error && err.message === "gate_aborted";
    pendingApprovals.delete(requestId);
    if (isGateAbort) {
      // Operator-visible: the gate request was cancelled before a decision.
      // Best-effort notify connected UI clients so the card clears.
      await emit("permission_resolved", {
        request_id: requestId,
        decision: "deny",
        reason: "gate_aborted",
      }).catch((e) => {
        console.error(
          `cc-deck: failed to emit gate-aborted resolution: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
      return c.json({ error: "gate aborted" }, 408);
    }
    // Unexpected failure (e.g. emit() threw on disk/perm error). Log and
    // report distinctly from an abort so the caller can tell them apart.
    console.error(
      `cc-deck: /hook/approval failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return c.json({ error: "internal error" }, 500);
  }
});

app.post("/approval", async (c) => {
  let body: { request_id?: unknown; decision?: unknown; scope?: unknown };
  try {
    body = (await c.req.json()) as {
      request_id?: unknown;
      decision?: unknown;
      scope?: unknown;
    };
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  if (typeof body.request_id !== "string") {
    return c.json({ error: "request_id must be a string" }, 400);
  }
  if (body.decision !== "approve" && body.decision !== "deny") {
    return c.json({ error: "decision must be 'approve' or 'deny'" }, 400);
  }
  if (body.scope !== undefined && body.scope !== "once" && body.scope !== "always") {
    return c.json({ error: "scope must be 'once' or 'always'" }, 400);
  }
  const pending = pendingApprovals.get(body.request_id);
  if (!pending) {
    return c.json({ error: "unknown or already-resolved request_id" }, 404);
  }
  pendingApprovals.delete(body.request_id);
  pending.resolve(body.decision === "approve" ? "allow" : "deny");

  // "Always" only applies to approves — denying never adds to the allowlist.
  if (body.scope === "always" && body.decision === "approve") {
    if (!allowedTools.has(pending.toolName)) {
      // Emit before mutating so server state never diverges from what a
      // reconnecting client can rebuild via JSONL replay. If emit throws
      // (disk full, perm error), the allowlist stays unchanged and the
      // error surfaces to the caller.
      await emit("tool_allowlisted", { tool_name: pending.toolName });
      allowedTools.add(pending.toolName);
    }
    // Drain any other parked requests for the same tool so the operator
    // doesn't have to tap through them individually.
    drainParkedFor((p) => p.toolName === pending.toolName);
  }
  return c.json({ ok: true });
});

app.post("/yolo", async (c) => {
  let body: { enabled?: unknown };
  try {
    body = (await c.req.json()) as { enabled?: unknown };
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  if (typeof body.enabled !== "boolean") {
    return c.json({ error: "enabled must be a boolean" }, 400);
  }
  if (yoloMode !== body.enabled) {
    // Emit before mutating so server state never diverges from what a
    // reconnecting client can rebuild via JSONL replay. If emit throws
    // we abort before flipping yoloMode, so a partial-success leak (yolo
    // on but no record + no drain) can't happen.
    await emit("yolo_mode_changed", { enabled: body.enabled });
    yoloMode = body.enabled;
  }
  // Enabling yolo also drains everything currently parked.
  if (yoloMode) drainParkedFor(() => true);
  return c.json({ ok: true, enabled: yoloMode });
});

// === static PWA (built into pwa/dist/ via `bun run build:pwa`) ===

app.use(
  "/*",
  serveStatic({
    root: pwaDistDir,
    rewriteRequestPath: (path) => (path === "/" ? "/index.html" : path),
  }),
);

let bunServer: ReturnType<typeof Bun.serve> | null = null;
try {
  bunServer = Bun.serve({
    port,
    hostname: host,
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
const gatePath = resolve(moduleDir, "scripts", "gate.sh");
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
  const trimCR = (s: string) => (s.endsWith("\r") ? s.slice(0, -1) : s);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        // Flush any pending multi-byte sequence out of the decoder before
        // the final yield, otherwise trailing non-ASCII chars can be lost.
        buf += decoder.decode();
        if (buf.length > 0) yield trimCR(buf);
        return;
      }
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        // Strip trailing \r so CRLF-terminated lines don't break JSON.parse.
        yield trimCR(buf.slice(0, idx));
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

let shutdownSignalReceived = false;

// If a detached pump fails (emit throws on disk/perm error, reader throws),
// we'd rather shut down cleanly than leak an unhandled rejection.
const fatalPumpError = (where: string) => (err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`cc-deck: ${where} failed: ${msg}`);
  shutdownSignalReceived = true;
  activeProc.kill();
};

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
})().catch(fatalPumpError("stdout pump"));

// === pipe subprocess stderr → subprocess_stderr envelope events ===

(async () => {
  for await (const line of readLines(procStderr)) {
    await emit("subprocess_stderr", { line });
  }
})().catch(fatalPumpError("stderr pump"));

// === subprocess exit → emit + shutdown ===

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
})().catch((err) => {
  // Shutdown sequence itself failed. Nothing graceful left to do.
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`cc-deck: shutdown handler failed: ${msg}`);
  process.exit(1);
});

// === signal handlers: clean shutdown on Ctrl-C / systemctl stop ===

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    shutdownSignalReceived = true;
    activeProc.kill();
  });
}
