# cc-deck

Command center for Claude Code. Drives one or more CC sessions from a browser — at your desk, on your phone over Tailscale, or any viewport in between. See `comms/cc-deck-v0-spec.md` for the full v0 spec.

## How it works

A single Bun + Hono server hosts many sessions. Each session is a `claude --print --input-format stream-json --output-format stream-json` child process; the server pipes its NDJSON events through a per-session JSONL transcript and broadcasts them over SSE to connected PWA clients. A PreToolUse hook (`scripts/gate.sh`) routes every tool call through the server, which parks the decision until the operator taps Approve or Deny in the PWA — approval latency = time to tap.

The PWA opens to a session list backed by a `/inbox` delta stream (snapshot + create/end/status/pending/activity events). New sessions are created from the list view, not by launching another server. Ended sessions linger on disk and can be resumed (`--resume <ccSid> --fork-session`) from their row in the list — the resumed session is a new fork that inherits the parent's context.

## Quick start

```bash
bun install
bun run build:pwa
./scripts/cc-start /path/to/your/repo
```

Defaults to `127.0.0.1:8788` — open `http://localhost:8788/` in a browser on the same machine. From the session list, click **+ New session** to spawn a session in the workdir of your choice.

For phone/tablet access over Tailscale, bind all interfaces:

```bash
./scripts/cc-start /path/to/your/repo --host=0.0.0.0
```

Then open `http://<machine>:8788/` on your phone. Add to Home Screen for a full-screen standalone app. Only do this on networks where every reachable peer is trusted (Tailscale-only, or a LAN you control) — control endpoints are unauthenticated in v0.

The workdir passed to `cc-start` is the *default* for new sessions; each session can pick its own workdir from the **+ New session** form.

## Development

```bash
# Terminal 1: server with the CC subprocesses
./scripts/cc-start /path/to/your/repo

# Terminal 2: Vite dev server with HMR (proxies API calls to :8788)
bun run dev:pwa
# open http://localhost:5173
```

## Running

The primary flow is `./scripts/cc-start <workdir>` in a terminal — that's the *server*. Adding more sessions happens in the PWA (or via `POST /sessions`); a second `cc-start` would just collide on the port.

Ctrl-C stops the server; all live CC subprocesses die with it. Ended sessions remain readable via their on-disk JSONL the next time the server starts.

### Optional: cgroup limits via systemd-run

If you want to bound resource use (shared box, or a box hosting other workloads), wrap the invocation:

```bash
systemd-run --user --scope --unit=cc-deck \
  -p MemoryMax=2G -p CPUQuota=200% \
  ./scripts/cc-start /path/to/your/repo
```

Stop with `systemctl --user stop cc-deck`. Not needed on a dedicated workstation.

## Endpoints

- `GET /sessions` — list live sessions (add `?include=archived` to fold in on-disk JSONL)
- `POST /sessions` — create a session; body: `{ workdir, resume_from? }`. With `resume_from`, forks an ended session via `--resume … --fork-session`.
- `DELETE /sessions/:sid` — kill a live session
- `GET /inbox` — SSE delta stream for the session list (snapshot + create/end/status/pending/activity)
- `GET /:sid/stream` — SSE event stream for one session
- `GET /:sid/events` — replay JSONL history (falls through to disk for archived sessions)
- `POST /:sid/input` — send operator text to the session
- `POST /:sid/approval` — Approve / Deny / Always-{tool} reply for a parked PreToolUse
- `POST /:sid/yolo` — toggle the session's auto-approve mode
- `POST /hook/approval` — `127.0.0.1`-only; the gate script's parking endpoint
- `GET /config` — server config snapshot for the PWA

## Layout

- `server.ts` — Hono + Bun process supervisor (route handlers, SSE broadcast, `/inbox` deltas, hook approval parking)
- `session-manager.ts` — owns the `Map<sid, Session>`, `/inbox` subscriptions, `ccSidToOakridgeSid` reverse index, archived-snapshot reads
- `session.ts` — one CC subprocess: spawn, JSONL persistence, per-session event broadcast, YOLO / always-allow state
- `scripts/cc-start` — launcher that validates the workdir and execs `bun run server.ts`
- `scripts/gate.sh` — PreToolUse hook; reads hook input on stdin, POSTs to `/hook/approval`, blocks on the operator's decision, echoes the `hookSpecificOutput` reply to CC
- `pwa/` — React + Vite client (responsive across phone / tablet / desktop), built to `pwa/dist/` and served statically by Hono. Hash routing (`#sid=…`), no router library.
- `data/sessions/` — one JSONL transcript per session (gitignored)

## Security posture

- **Network:** binds to `127.0.0.1` by default. Operator opts into wider exposure with `--host=0.0.0.0` for tailnet/phone access, and is responsible for ensuring only trusted peers can reach the port (Tailscale-only, LAN firewall, etc.). Control endpoints are unauthenticated in v0 — token-based auth is planned follow-up work.
- **Hook endpoint:** `/hook/approval` is filtered to `127.0.0.1` at the route handler — only the in-process gate script can park approval requests, not a tailnet peer.
- **Path-traversal guard:** `:sid` route params are validated against a strict v4 UUID regex before any filesystem access.
- **Markdown:** assistant text is rendered with `react-markdown` + `rehype-sanitize`; no `dangerouslySetInnerHTML`, so prompt-injected HTML from web-fetched content can't execute.
- **CC user settings:** the server spawns CC with `--setting-sources user` so your user-level skills and slash commands are available inside the spawned subprocess. Tradeoff: user-level allowlists and permission settings in `~/.claude/settings.json` can bypass cc-deck's approval gate — if you've globally approved a tool there, the PreToolUse hook won't fire for it. The operator-controlled escape hatches below (YOLO, "Always {tool}") are the intended path for short-circuiting the gate; don't rely on the gate to stop things you've already auto-approved at the user level.
- **YOLO mode and per-tool always-allow** are operator-controlled escape hatches, scoped to a single session. YOLO mode (top-bar toggle) auto-approves every PreToolUse for the rest of the session — useful for setting CC loose on a long task without tapping each prompt. The "Always {tool}" button on a permission card adds that tool name to a session-scoped allowlist; matching future calls auto-approve. Both reset on server restart, are emitted as visible events, and turn the gate into "see what happened" rather than "decide each call." Use them deliberately.
