import { Hono, type Context } from "hono";
import { serveStatic } from "hono/bun";
import { streamSSE } from "hono/streaming";
import { parseArgs } from "node:util";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RemoveFailedError,
  SessionManager,
  type CreateSessionOpts,
} from "./session-manager";
import {
  Session,
  SessionNotReadyError,
  readJsonlOrEmpty,
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

// Resolve to an absolute path before validation so /config and the initial
// session both see the same canonical workdir regardless of how the operator
// invoked cc-start (e.g. `--workdir=.` or a relative path from a script).
const workdir = resolve(values.workdir);
const startupWorkdirErr = await validateWorkdir(workdir);
if (startupWorkdirErr) {
  console.error(`cc-deck: invalid --workdir=${values.workdir}: ${startupWorkdirErr}`);
  process.exit(1);
}
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
  const clientSignal = c.req.raw.signal;
  const endedSignal = session.endedSignal;
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
    clientSignal.addEventListener("abort", onAbort, { once: true });
    // Close the stream when the session ends — otherwise a client that
    // stays connected to an ended session sits in the empty-pending loop
    // forever, leaking the SSE connection and (after many such ends) the
    // subscribe slot. Either signal aborting is enough to exit the loop.
    endedSignal.addEventListener("abort", onAbort, { once: true });
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
      while (!clientSignal.aborted && !endedSignal.aborted) {
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
      // Drain any events that arrived between the last pending.shift() and
      // the abort so clients don't miss the final subprocess_exited frame.
      // Only drain when the session ended but the client is still connected —
      // if the client aborted, writing to the dead socket would just throw,
      // and there's no one to miss the frame anyway.
      if (endedSignal.aborted && !clientSignal.aborted) {
        while (pending.length > 0) {
          const evt = pending.shift()!;
          if (evt.id <= sentUpTo) continue;
          sentUpTo = evt.id;
          await stream.writeSSE({
            event: "message",
            data: JSON.stringify(evt),
            id: String(evt.id),
          });
        }
      }
    } finally {
      clearInterval(heartbeat);
      clientSignal.removeEventListener("abort", onAbort);
      endedSignal.removeEventListener("abort", onAbort);
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
  return c.json({
    session_id: session.oakridgeSid,
    events: parseEventsSince(contents, since),
  });
}

// UUID v4 specifically — sids come from crypto.randomUUID(), which always
// produces v4. Accepting other versions would be dead space that never
// matches any real sid the server wrote.
const SID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidSid(sid: string): boolean {
  return SID_PATTERN.test(sid);
}

function parseEventsSince(contents: string, since: number): EnvelopeEvent[] {
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
  return events;
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
  const sid = c.req.param("sid");
  // Validate sid before falling through to the filesystem — the archived
  // path joins sid into sessionsDir, and a URL-encoded traversal like
  // `..%2F..%2Fetc%2Fpasswd` would otherwise let a tailnet peer read
  // arbitrary *.jsonl files the server has access to. sids are generated
  // by randomUUID() so a strict UUID-v4 regex is tight enough without
  // needing a path-prefix check.
  if (!isValidSid(sid)) return c.json({ error: "invalid sid" }, 400);
  const session = manager.get(sid);
  if (session) return eventsForSession(session, c);
  // Fall through to on-disk JSONL for sessions that aren't loaded in
  // memory (e.g. after a server restart). Matches the snapshot view an
  // archived session gets from /sessions?include=archived: fully-formed
  // transcript, no live updates.
  const sinceRaw = c.req.query("since");
  const since = sinceRaw !== undefined ? Number(sinceRaw) : -1;
  if (!Number.isFinite(since)) {
    return c.json({ error: "invalid since" }, 400);
  }
  const jsonlPath = join(sessionsDir, `${sid}.jsonl`);
  const contents = await readJsonlOrEmpty(jsonlPath);
  if (!contents) return c.json({ error: "unknown session" }, 404);
  return c.json({
    session_id: sid,
    events: parseEventsSince(contents, since),
  });
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

// ---- server config ----
//
// Exposes the operator-configured defaults the PWA needs to render forms
// (currently just the default workdir). Kept tiny on purpose: this is not a
// place to grow generic settings — anything per-session belongs in the
// session snapshot.

app.get("/config", (c) => {
  return c.json({ defaultWorkdir: workdir });
});

// ---- sessions CRUD ----

app.get("/sessions", async (c) => {
  const inMemory = manager.listSnapshots();
  const include = c.req.query("include");
  if (include !== "archived") return c.json({ sessions: inMemory });
  // Scan data/sessions/*.jsonl for sessions from prior runs. Ordered newest
  // first by lastActivityTs so the PWA can render without a second sort.
  const archived = await manager.listArchivedSnapshots();
  const merged = [...inMemory, ...archived].sort((a, b) => {
    if (a.lastActivityTs === b.lastActivityTs) return 0;
    return a.lastActivityTs < b.lastActivityTs ? 1 : -1;
  });
  return c.json({ sessions: merged });
});

// ---- /inbox (always-on delta stream) ----
//
// Snapshot-on-connect then named-event deltas. No replay log: if a client
// drops and reconnects, the fresh snapshot is authoritative — deltas in
// between are presumed lost, which is fine since the snapshot carries every
// field the deltas mutate.

app.get("/inbox", (c) => {
  return streamSSE(c, async (stream) => {
    const signal = c.req.raw.signal;
    // Per-connection buffer of deltas pending writeSSE. Unbounded by
    // design for v0: each delta is ~100 bytes, sessions move slowly, and
    // snapshot-on-reconnect makes drop-on-overflow safe if we ever need
    // to cap it. If a backgrounded client on a busy server ever shows up
    // as a memory regression, swap this for a ring buffer + forced close
    // on overflow — the reconnect will pull a fresh snapshot.
    const queue: import("./session-manager").InboxDelta[] = [];
    let notify: (() => void) | null = null;
    const unsub = manager.subscribeInbox((delta) => {
      queue.push(delta);
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
    try {
      await stream.writeSSE({
        event: "snapshot",
        data: JSON.stringify({ sessions: manager.listSnapshots() }),
      });
      while (!signal.aborted) {
        if (queue.length === 0) {
          await new Promise<void>((r) => {
            notify = r;
          });
          continue;
        }
        const delta = queue.shift()!;
        await stream.writeSSE({
          event: "delta",
          data: JSON.stringify(delta),
        });
      }
    } finally {
      clearInterval(heartbeat);
      signal.removeEventListener("abort", onAbort);
      unsub();
    }
  });
});

app.post("/sessions", async (c) => {
  // Optional body: { resume_from?: string, workdir?: string, name?: string
  // (≤80 chars) }. No body / missing fields = a fresh session under the
  // server's --workdir with a server-generated name. resume_from is an
  // oakridgeSid whose parent CC session should be inherited as context via
  // --resume <parentCcSid> --fork-session, and ignores any workdir override
  // (the parent's workdir is authoritative).
  let resumeFrom: string | null = null;
  let bodyWorkdir: string | null = null;
  let bodyName: string | null = null;
  // Read raw text first so we can distinguish "no body" (treat as no
  // options, preserves the old POST /sessions behavior) from "bad body"
  // (400). Using c.req.json() with an inner .catch() would silently
  // turn malformed JSON into "no options" — a bad body would create
  // a fresh session instead of erroring.
  try {
    const bodyText = await c.req.text();
    if (bodyText !== "") {
      const raw = JSON.parse(bodyText) as unknown;
      // Reject arrays / strings / numbers explicitly: property access on
      // them silently yields undefined, so without this check a body like
      // `[]` or `"foo"` would slip through as "no options" and spawn a
      // fresh session under --workdir, masking client bugs.
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return c.json({ error: "json body must be an object" }, 400);
      }
      const parsed = raw as {
        resume_from?: unknown;
        workdir?: unknown;
        name?: unknown;
      };
      if (parsed.resume_from !== undefined) {
        if (typeof parsed.resume_from !== "string") {
          return c.json({ error: "resume_from must be a string" }, 400);
        }
        resumeFrom = parsed.resume_from;
      }
      if (parsed.workdir !== undefined) {
        if (typeof parsed.workdir !== "string") {
          return c.json({ error: "workdir must be a string" }, 400);
        }
        bodyWorkdir = parsed.workdir;
      }
      if (parsed.name !== undefined) {
        if (typeof parsed.name !== "string") {
          return c.json({ error: "name must be a string" }, 400);
        }
        // Validate after trimming so leading/trailing whitespace can't
        // push an otherwise-valid name past the cap. All-whitespace
        // trims to empty, which manager.create()'s slug fallback
        // handles the same as an omitted name, so we just store the
        // trimmed value (possibly empty) and let create() decide.
        const trimmedName = parsed.name.trim();
        if (trimmedName.length > 80) {
          return c.json({ error: "name must be ≤ 80 chars after trimming" }, 400);
        }
        bodyName = trimmedName;
      }
    }
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }

  let spawnOpts: CreateSessionOpts;
  if (resumeFrom === null) {
    // Normalize via resolve() so /repo, /repo/, and /repo/..//repo all
    // collapse to one canonical workdir before validation + persistence —
    // matches the startup --workdir handling so the same path doesn't
    // show up as two distinct workdirs across the UI.
    const target = resolve(bodyWorkdir ?? workdir);
    const err = await validateWorkdir(target);
    if (err) return c.json({ error: err }, 400);
    spawnOpts = { workdir: target, name: bodyName ?? undefined };
  } else {
    if (!isValidSid(resumeFrom)) {
      return c.json({ error: "invalid resume_from" }, 400);
    }
    const parentInfo = await resolveResumeParent(resumeFrom);
    if (parentInfo.kind === "unknown") {
      return c.json({ error: "unknown resume_from session" }, 404);
    }
    if (parentInfo.kind === "no_cc_sid") {
      // Parent session never reached CC's system/init — there's nothing
      // to resume against. Distinct 400 so the PWA can show a specific
      // error rather than "spawn failed".
      return c.json(
        {
          error:
            "resume_from parent never observed a cc session id — can't resume",
        },
        400,
      );
    }
    // Validate the inherited workdir before spawn — archived metadata
    // can outlive the directory it points at (e.g. operator deleted the
    // worktree). Without this check, Bun.spawn fails downstream and the
    // caller sees an opaque 500. Re-resolve so a parent stored as
    // /repo/.//worktree still validates against /repo/worktree.
    const parentWorkdir = resolve(parentInfo.workdir);
    const parentErr = await validateWorkdir(parentWorkdir);
    if (parentErr) {
      return c.json(
        { error: `resume_from parent workdir invalid: ${parentErr}` },
        400,
      );
    }
    spawnOpts = {
      // Spawn under the parent's workdir, not the server default. If the
      // operator restarted the server with a different --workdir, the
      // resumed subprocess still needs parent's cwd to match what the
      // transcript assumes.
      workdir: parentWorkdir,
      name: bodyName ?? undefined,
      parentCcSid: parentInfo.parentCcSid,
      parentOakridgeSid: resumeFrom,
    };
  }

  try {
    const session = await manager.create(spawnOpts);
    return c.json(session.snapshot());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `spawn failed: ${msg}` }, 500);
  }
});

/**
 * Validates a workdir string for POST /sessions. Returns null if OK or a
 * human-readable error string for the 400 response. We require absolute
 * paths so the spawn cwd is unambiguous regardless of how the operator
 * launched the server, and verify existence + directory-ness so the
 * failure surfaces as a clear 400 instead of a downstream Bun.spawn
 * error. Operator input is trusted (this is a localhost/tailnet tool),
 * so no sandbox/allowlist beyond that.
 */
async function validateWorkdir(path: string): Promise<string | null> {
  if (!isAbsolute(path)) return "workdir must be an absolute path";
  try {
    const s = await stat(path);
    if (!s.isDirectory()) return "workdir is not a directory";
  } catch {
    return "workdir does not exist";
  }
  return null;
}

/**
 * Look up a resume parent's ccSid + workdir. Checks the live map first
 * (fast path) then falls back to parsing the on-disk JSONL. Returns a
 * tagged result so the POST handler can map each failure case to a
 * distinct status code.
 */
type ResumeParentResult =
  | { kind: "unknown" }
  | { kind: "no_cc_sid" }
  | { kind: "ok"; parentCcSid: string; workdir: string };

async function resolveResumeParent(sid: string): Promise<ResumeParentResult> {
  const live = manager.get(sid);
  if (live) {
    const ccSid = live.currentCcSid;
    if (!ccSid) return { kind: "no_cc_sid" };
    return { kind: "ok", parentCcSid: ccSid, workdir: live.workdir };
  }
  const jsonlPath = join(sessionsDir, `${sid}.jsonl`);
  let contents: string;
  try {
    contents = await readJsonlOrEmpty(jsonlPath);
  } catch (err) {
    // Same EACCES / I/O error surface as loadArchivedSnapshot — treat
    // as unknown rather than 500 the resume call, but log the cause so
    // an operator seeing an unexpected 404 on resume has a breadcrumb
    // (the alternative is indistinguishable from a genuinely unknown
    // sid).
    console.error(
      `cc-deck: failed to read parent jsonl ${jsonlPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { kind: "unknown" };
  }
  if (!contents) return { kind: "unknown" };
  let parentCcSid: string | null = null;
  let parentWorkdir: string | null = null;
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    let evt: EnvelopeEvent;
    try {
      evt = JSON.parse(line) as EnvelopeEvent;
    } catch {
      continue;
    }
    const payload = (evt.payload ?? {}) as Record<string, unknown>;
    if (
      evt.type === "cc_session_id_observed" &&
      typeof payload.cc_session_id === "string"
    ) {
      parentCcSid = payload.cc_session_id;
    }
    if (evt.type === "session_started" && typeof payload.workdir === "string") {
      parentWorkdir = payload.workdir;
    }
    if (parentCcSid && parentWorkdir) break;
  }
  if (!parentCcSid) return { kind: "no_cc_sid" };
  // Fall back to server --workdir if the parent's session_started frame
  // is missing a workdir (very early truncated transcript). Same cwd
  // the operator is running under now; best-effort.
  return {
    kind: "ok",
    parentCcSid,
    workdir: parentWorkdir ?? workdir,
  };
}

app.delete("/sessions/:sid", async (c) => {
  const sid = c.req.param("sid");
  if (!isValidSid(sid)) return c.json({ error: "invalid sid" }, 400);
  // ?purge=true is a hard delete (drop map entry + delete JSONL). Without
  // it, the existing abort-only semantic is preserved so the PWA's Stop
  // button keeps the ended transcript visible. Treat any non-falsy value
  // as truthy ("1", "true", "yes") to match common URL convention.
  // Lowercase once so falsy variants like ?purge=False / FALSE / NO are
  // recognized — without this, mixed-case spellings would unexpectedly
  // trigger a hard delete.
  const purgeParam = c.req.query("purge")?.toLowerCase();
  const purge =
    purgeParam !== undefined &&
    purgeParam !== "" &&
    purgeParam !== "0" &&
    purgeParam !== "false" &&
    purgeParam !== "no" &&
    purgeParam !== "off";
  if (purge) {
    let removed: boolean;
    try {
      removed = await manager.remove(sid);
    } catch (err) {
      if (err instanceof RemoveFailedError) {
        // JSONL exists but unlink failed (EACCES/EBUSY/EIO/etc). Surface
        // as 500 so the client doesn't see a misleading "removed:true" —
        // the transcript is still on disk and would reappear after
        // restart.
        console.error(`cc-deck: ${err.message}`);
        return c.json({ error: "purge failed", detail: err.message }, 500);
      }
      throw err;
    }
    if (!removed) return c.json({ error: "unknown session" }, 404);
    return c.json({ ok: true, removed: true });
  }
  const session = manager.get(sid);
  if (!session) return c.json({ error: "unknown session" }, 404);
  const code = await session.abort();
  return c.json({ ok: true, code });
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
