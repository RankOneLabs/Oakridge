import { Hono, type Context } from "hono";
import { serveStatic } from "hono/bun";
import { streamSSE } from "hono/streaming";
import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SessionManager } from "./session-manager";
import {
  Session,
  SessionNotReadyError,
  type Decision,
  type EnvelopeEvent,
  type SpawnCmd,
} from "./session";

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

const moduleDir = dirname(fileURLToPath(import.meta.url));
const dataDir = values.dataDir ?? join(moduleDir, "data");
const pwaDistDir = join(moduleDir, "pwa", "dist");
const sessionsDir = join(dataDir, "sessions");
await mkdir(sessionsDir, { recursive: true });

// === settings.json for spawned CC (shared across all sessions) ===

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

// === spawn command builder ===

function buildSpawnCmd(session: Session): SpawnCmd {
  const cmd = [
    claudeBin,
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-hook-events",
    "--replay-user-messages",
    "--verbose",
    "--setting-sources",
    "user",
    "--settings",
    settingsPath,
  ];
  // Resume in a fresh session id so multiple live forks off the same parent
  // don't collide on CC's internal session id.
  if (session.parentCcSid) {
    cmd.push("--resume", session.parentCcSid, "--fork-session");
  }
  return {
    cmd,
    cwd: session.workdir,
    env: {
      ...process.env,
      CC_DECK_PORT: String(port),
    } as Record<string, string>,
  };
}

// === manager ===

const manager = new SessionManager({ sessionsDir, buildSpawnCmd });

// === HTTP handlers ===

async function streamForSession(session: Session, c: Context) {
  const signal = c.req.raw.signal;
  const lastEventIdHeader = c.req.header("last-event-id");
  const parsedResumeId = lastEventIdHeader ? Number(lastEventIdHeader) : NaN;
  const resumeAfter = Number.isFinite(parsedResumeId) ? parsedResumeId : -1;
  return streamSSE(c, async (stream) => {
    const pending: EnvelopeEvent[] = [];
    let notify: (() => void) | null = null;
    const unsub = session.subscribe((evt) => {
      pending.push(evt);
      if (notify) {
        const n = notify;
        notify = null;
        n();
      }
    });
    const onAbort = () => {
      if (notify) {
        const n = notify;
        notify = null;
        n();
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const heartbeat = setInterval(() => {
      stream.write(": ping\n\n").catch(() => {});
    }, 15000);
    let sentUpTo = resumeAfter;
    try {
      const contents = await session.readJsonl();
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
        if (evt.id <= sentUpTo) continue;
        sentUpTo = evt.id;
        await stream.writeSSE({
          event: "message",
          data: JSON.stringify(evt),
          id: String(evt.id),
        });
      }
      while (!signal.aborted) {
        if (pending.length === 0) {
          await new Promise<void>((r) => {
            notify = r;
          });
          continue;
        }
        const evt = pending.shift()!;
        if (evt.id <= sentUpTo) continue;
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
}

async function eventsForSession(session: Session, c: Context) {
  const sinceRaw = c.req.query("since");
  const since = sinceRaw !== undefined ? Number(sinceRaw) : -1;
  if (!Number.isFinite(since)) {
    return c.json({ error: "invalid since" }, 400);
  }
  const contents = await session.readJsonl();
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
  return c.json({ session_id: session.oakridgeSid, events });
}

async function inputForSession(session: Session, c: Context) {
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
  try {
    await session.writeInput(text);
  } catch (err) {
    if (err instanceof SessionNotReadyError) {
      return c.json({ error: "subprocess not ready" }, 503);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `subprocess write failed: ${msg}` }, 503);
  }
  return c.json({ ok: true });
}

async function yoloForSession(session: Session, c: Context) {
  if (session.status !== "live") {
    return c.json({ error: "session not live" }, 409);
  }
  let body: { enabled?: unknown };
  try {
    body = (await c.req.json()) as { enabled?: unknown };
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  if (typeof body.enabled !== "boolean") {
    return c.json({ error: "enabled must be a boolean" }, 400);
  }
  const enabled = await session.setYolo(body.enabled);
  return c.json({ ok: true, enabled });
}

interface ApprovalBody {
  request_id: string;
  decision: "approve" | "deny";
  scope: "once" | "always";
}

function parseApprovalBody(raw: unknown): ApprovalBody | string {
  if (typeof raw !== "object" || raw === null) return "invalid json";
  const body = raw as {
    request_id?: unknown;
    decision?: unknown;
    scope?: unknown;
  };
  if (typeof body.request_id !== "string") return "request_id must be a string";
  if (body.decision !== "approve" && body.decision !== "deny") {
    return "decision must be 'approve' or 'deny'";
  }
  if (
    body.scope !== undefined &&
    body.scope !== "once" &&
    body.scope !== "always"
  ) {
    return "scope must be 'once' or 'always'";
  }
  return {
    request_id: body.request_id,
    decision: body.decision,
    scope: (body.scope ?? "once") as "once" | "always",
  };
}

async function applyApproval(
  session: Session,
  body: ApprovalBody,
  c: Context,
) {
  if (session.status !== "live") {
    return c.json({ error: "session not live" }, 409);
  }
  const pending = session.deleteApproval(body.request_id);
  if (!pending) {
    return c.json({ error: "unknown or already-resolved request_id" }, 404);
  }
  pending.resolve(body.decision === "approve" ? "allow" : "deny");
  if (body.scope === "always" && body.decision === "approve") {
    try {
      await session.allowlistTool(pending.toolName);
    } catch (err) {
      console.error(
        `cc-deck: allowlist side-effect for ${pending.toolName} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return c.json({ ok: true });
}

async function approvalForSession(session: Session, c: Context) {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  const parsed = parseApprovalBody(raw);
  if (typeof parsed === "string") return c.json({ error: parsed }, 400);
  return applyApproval(session, parsed, c);
}

// === hook payload type ===

interface HookInput {
  session_id: string;
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
  hook_event_name: string;
}

// === Hono app ===

const app = new Hono();

// ---- hook (loopback-only) ----
//
// Registered BEFORE /:sid/* so Hono's registration-order match doesn't
// catch POST /hook/approval as /:sid/approval with sid="hook".

app.post("/hook/approval", async (c) => {
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
    return c.json(
      { error: `unexpected hook_event_name: ${hook.hook_event_name}` },
      400,
    );
  }

  const session = await resolveSessionForHook(hook.session_id);
  if (!session) {
    // The gate reached us before system/init mapped this ccSid to a session.
    // Deny rather than hang so CC isn't wedged waiting on us.
    return c.json(
      {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "cc-deck: no oakridge session for this CC session_id",
        },
      },
      200,
    );
  }

  const autoReason = session.yolo
    ? "yolo"
    : session.toolAllowlist.has(hook.tool_name)
      ? "allowlist"
      : null;
  if (autoReason) {
    // Log the auto-approve best-effort. If emit throws (disk full, perm
    // error), still return the allow decision — the auto-approve policy
    // doesn't depend on the log being durable, and wedging CC on a log
    // failure would be worse than a missing event line.
    try {
      await session.emit("permission_auto_approved", {
        tool_name: hook.tool_name,
        tool_input: hook.tool_input,
        tool_use_id: hook.tool_use_id,
        reason: autoReason,
      });
    } catch (err) {
      console.error(
        `cc-deck: failed to log auto-approve for ${hook.tool_name}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
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
  let resolveDecision: (d: Decision) => void;
  let rejectDecision: (e: Error) => void;
  const decisionPromise = new Promise<Decision>((res, rej) => {
    resolveDecision = res;
    rejectDecision = rej;
  });
  session.registerApproval(requestId, {
    resolve: resolveDecision!,
    toolName: hook.tool_name,
  });
  signal.addEventListener(
    "abort",
    () => rejectDecision!(new Error("gate_aborted")),
    { once: true },
  );

  try {
    await session.emit("permission_request", {
      request_id: requestId,
      tool_name: hook.tool_name,
      tool_input: hook.tool_input,
      tool_use_id: hook.tool_use_id,
    });
    const decision = await decisionPromise;
    await session.emit("permission_resolved", {
      request_id: requestId,
      decision,
    });
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
    session.deleteApproval(requestId);
    if (isGateAbort) {
      await session
        .emit("permission_resolved", {
          request_id: requestId,
          decision: "deny",
          reason: "gate_aborted",
        })
        .catch((e) => {
          console.error(
            `cc-deck: failed to emit gate-aborted resolution: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        });
      return c.json({ error: "gate aborted" }, 408);
    }
    console.error(
      `cc-deck: /hook/approval failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return c.json({ error: "internal error" }, 500);
  }
});

/**
 * Map a hook's CC session_id to our Session. Waits briefly if the
 * manager hasn't seen the ccSid yet: CC emits system/init before any
 * PreToolUse under normal conditions, but hooks and stdout are separate
 * pipes and in theory could race. 2s should cover any realistic scheduling
 * jitter while still failing fast on a genuinely-unknown ccSid.
 */
async function resolveSessionForHook(
  ccSid: string,
): Promise<Session | undefined> {
  const deadline = Date.now() + 2000;
  while (true) {
    const session = manager.getByCcSid(ccSid);
    if (session) return session;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ---- per-sid routes ----

app.get("/:sid/stream", (c) => {
  const session = manager.get(c.req.param("sid"));
  if (!session) return c.json({ error: "unknown session" }, 404);
  return streamForSession(session, c);
});

app.get("/:sid/events", async (c) => {
  const session = manager.get(c.req.param("sid"));
  if (!session) return c.json({ error: "unknown session" }, 404);
  return eventsForSession(session, c);
});

app.post("/:sid/input", async (c) => {
  const session = manager.get(c.req.param("sid"));
  if (!session) return c.json({ error: "unknown session" }, 404);
  return inputForSession(session, c);
});

app.post("/:sid/yolo", async (c) => {
  const session = manager.get(c.req.param("sid"));
  if (!session) return c.json({ error: "unknown session" }, 404);
  return yoloForSession(session, c);
});

app.post("/:sid/approval", async (c) => {
  const session = manager.get(c.req.param("sid"));
  if (!session) return c.json({ error: "unknown session" }, 404);
  return approvalForSession(session, c);
});

// ---- sessions CRUD ----

app.get("/sessions", (c) => c.json({ sessions: manager.listSnapshots() }));

app.post("/sessions", async (c) => {
  // PR 1 doesn't expose a per-session workdir knob — every new session
  // uses the server's --workdir. A future PR can add a validated workdir
  // field (resolve + stat + probably loopback-only) once we actually need
  // multi-workdir support.
  try {
    const session = await manager.create({ workdir });
    return c.json(session.snapshot());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `spawn failed: ${msg}` }, 500);
  }
});

app.delete("/sessions/:sid", async (c) => {
  const sid = c.req.param("sid");
  const session = manager.get(sid);
  if (!session) return c.json({ error: "unknown session" }, 404);
  const code = await session.abort();
  return c.json({ ok: true, code });
});

// ---- legacy aliases (temporary bridge so today's PWA keeps working) ----

function requireSingleLive(
  c: Context,
): Session | Response {
  const session = manager.getSingleLive();
  if (!session) {
    return c.json(
      {
        error:
          "no single live session — use /:sid/<route> for multi-session clients",
      },
      409,
    );
  }
  return session;
}

app.get("/stream", (c) => {
  const s = requireSingleLive(c);
  if (!(s instanceof Session)) return s;
  return streamForSession(s, c);
});

app.get("/events", async (c) => {
  const s = requireSingleLive(c);
  if (!(s instanceof Session)) return s;
  return eventsForSession(s, c);
});

app.post("/input", async (c) => {
  const s = requireSingleLive(c);
  if (!(s instanceof Session)) return s;
  return inputForSession(s, c);
});

app.post("/yolo", async (c) => {
  const s = requireSingleLive(c);
  if (!(s instanceof Session)) return s;
  return yoloForSession(s, c);
});

app.post("/approval", async (c) => {
  // Legacy /approval body doesn't carry a sid. Scan live sessions by
  // request_id (UUIDs, globally unique). Keeps today's PWA working until
  // it migrates to /:sid/approval in PR 2.
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  const parsed = parseApprovalBody(raw);
  if (typeof parsed === "string") return c.json({ error: parsed }, 400);
  const owningSession = manager
    .listLive()
    .find((s) => s.hasApproval(parsed.request_id));
  if (!owningSession) {
    return c.json({ error: "unknown or already-resolved request_id" }, 404);
  }
  return applyApproval(owningSession, parsed, c);
});

// ---- static PWA ----

app.use(
  "/*",
  serveStatic({
    root: pwaDistDir,
    rewriteRequestPath: (path) => (path === "/" ? "/index.html" : path),
  }),
);

// === bind port (fail fast before spawning CC) ===

let bunServer: ReturnType<typeof Bun.serve> | null = null;
try {
  bunServer = Bun.serve({
    port,
    hostname: host,
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
  `cc-deck listening on http://${server.hostname}:${server.port}, workdir=${workdir}`,
);

// === auto-create initial session ===

let initialSession: Session;
try {
  initialSession = await manager.create({ workdir });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`cc-deck: failed to spawn initial CC subprocess: ${msg}`);
  server.stop();
  process.exit(1);
}
console.error(`cc-deck initial session ${initialSession.oakridgeSid}`);

// === signals ===

let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      const worstCode = await manager.endAll();
      server.stop();
      process.exit(worstCode);
    })();
  });
}
