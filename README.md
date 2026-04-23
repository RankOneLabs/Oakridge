# cc-deck

Command center for Claude Code. Drives a CC session from a browser — at your desk, on your phone over Tailscale, or any viewport in between. See `comms/cc-deck-v0-spec.md` in the parent repo for the full v0 spec.

## How it works

A Bun + Hono server spawns `claude --print --input-format stream-json --output-format stream-json` as a child process. It pipes CC's NDJSON events through a per-session JSONL transcript and broadcasts them over SSE to connected PWA clients. A PreToolUse hook (`scripts/gate.sh`) routes every tool call through the server, which parks the decision until the operator taps Approve or Deny in the PWA — approval latency = time to tap.

## Quick start

```bash
bun install
bun run build:pwa
bun run scripts/cc-start /path/to/your/repo
```

Defaults to `127.0.0.1:8788` — open `http://localhost:8788/` in a browser on the same machine.

For phone/tablet access over Tailscale, bind all interfaces:

```bash
bun run scripts/cc-start /path/to/your/repo --host=0.0.0.0
```

Then open `http://<machine>:8788/` on your phone. Add to Home Screen for a full-screen standalone app. Only do this on networks where every reachable peer is trusted (Tailscale-only, or a LAN you control) — the control endpoints (`/input`, `/approval`, `/stream`, `/events`) are unauthenticated in v0.

## Development

```bash
# Terminal 1: server with the CC subprocess
bun run scripts/cc-start /path/to/your/repo

# Terminal 2: Vite dev server with HMR (proxies API calls to :8788)
bun run dev:pwa
# open http://localhost:5173
```

## Running

The primary flow is just `bun run scripts/cc-start <workdir>` in a terminal. Ctrl-C to stop; CC dies with the server.

### Optional: cgroup limits via systemd-run

If you want to bound resource use (shared box, or a box hosting other workloads), wrap the invocation:

```bash
systemd-run --user --scope --unit=cc-deck \
  -p MemoryMax=2G -p CPUQuota=200% \
  bun run server.ts --workdir=/path/to/your/repo
```

Stop with `systemctl --user stop cc-deck`. Not needed on a dedicated workstation.

## Layout

- `server.ts` — Hono + Bun process supervisor (CC subprocess, SSE broadcast, JSONL persistence, hook approval parking)
- `scripts/cc-start` — launcher that validates the workdir and execs `bun run server.ts`
- `scripts/gate.sh` — PreToolUse hook; reads hook input on stdin, POSTs to `/hook/approval`, blocks on the operator's decision, echoes the `hookSpecificOutput` reply to CC
- `pwa/` — React + Vite client (responsive across phone / tablet / desktop), built to `pwa/dist/` and served statically by Hono
- `data/sessions/` — one JSONL transcript per session (gitignored)

## Security posture

- **Network:** binds to `127.0.0.1` by default. Operator opts into wider exposure with `--host=0.0.0.0` for tailnet/phone access, and is responsible for ensuring only trusted peers can reach the port (Tailscale-only, LAN firewall, etc.). Control endpoints (`/input`, `/approval`, `/stream`, `/events`) are unauthenticated in v0 — token-based auth is planned follow-up work.
- **Hook endpoint:** `/hook/approval` is filtered to `127.0.0.1` at the route handler — only the in-process gate script can park approval requests, not a tailnet peer.
- **Markdown:** assistant text is rendered with `react-markdown` + `rehype-sanitize`; no `dangerouslySetInnerHTML`, so prompt-injected HTML from web-fetched content can't execute.
- **CC user settings:** the server spawns CC with `--setting-sources ''` so user-level allowlists don't bypass the approval gate.

