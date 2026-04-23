# cc-deck

Mobile command center for Claude Code. Drives a CC session running on a homelab host from a phone over Tailscale. See `comms/cc-deck-v0-spec.md` in the parent repo for the full v0 spec.

## How it works

A Bun + Hono server spawns `claude --print --input-format stream-json --output-format stream-json` as a child process. It pipes CC's NDJSON events through a per-session JSONL transcript and broadcasts them over SSE to connected PWA clients. A PreToolUse hook (`scripts/gate.sh`) routes every tool call through the server, which parks the decision until the operator taps Approve or Deny in the PWA — approval latency = time to tap.

## Quick start

```bash
bun install
bun run build:pwa
bun run scripts/cc-start /path/to/your/repo
```

Then open `http://<host>:8788/` on your phone. Add to Home Screen for a full-screen standalone app.

## Development

```bash
# Terminal 1: server with the CC subprocess
bun run scripts/cc-start /path/to/your/repo

# Terminal 2: Vite dev server with HMR (proxies API calls to :8788)
bun run dev:pwa
# open http://localhost:5173
```

## Deployment (cgroup-limited)

```bash
systemd-run --user --scope --unit=cc-deck \
  -p MemoryMax=2G -p CPUQuota=200% \
  bun run server.ts --workdir=/path/to/your/repo
```

Stop with `systemctl --user stop cc-deck`.

## Layout

- `server.ts` — Hono + Bun process supervisor (CC subprocess, SSE broadcast, JSONL persistence, hook approval parking)
- `scripts/cc-start` — launcher that validates the workdir and execs `bun run server.ts`
- `scripts/gate.sh` — PreToolUse hook; reads hook input on stdin, POSTs to `/hook/approval`, blocks on the operator's decision, echoes the `hookSpecificOutput` reply to CC
- `pwa/` — React + Vite mobile client, built to `pwa/dist/` and served statically by Hono
- `data/sessions/` — one JSONL transcript per session (gitignored)

## Security posture

- **Network auth:** Tailscale. No user accounts. If it's on the tailnet it's trusted.
- **Hook endpoint:** `/hook/approval` is filtered to `127.0.0.1` at the route handler — only the in-process gate script can park approval requests, not a tailnet peer.
- **Markdown:** assistant text is rendered with `react-markdown` + `rehype-sanitize`; no `dangerouslySetInnerHTML`, so prompt-injected HTML from web-fetched content can't execute.
- **CC user settings:** the server spawns CC with `--setting-sources ''` so user-level allowlists don't bypass the approval gate.

## PR walkthrough

The work is structured as 9 commits that build up in layers. Read them in order:

1. `Scaffold Bun + Hono server skeleton` — package.json, tsconfig, .gitignore, stub routes
2. `Add cc-start launcher and port-conflict error handling`
3. `Add CC subprocess supervisor and JSONL persistence`
4. `Wire SSE /stream, /events replay, and /input forwarding`
5. `Wire PreToolUse hook as the approval gate` ← load-bearing piece
6. `Scaffold React + Vite PWA and serve static build from Hono`
7. `Render chat events and add input box`
8. `Render tool cards and wire permission approval UX`
9. This commit — manifest, iOS polish, README
