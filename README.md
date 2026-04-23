# cc-deck

Mobile command center for Claude Code. Drives a CC session running on a homelab host from a phone over Tailscale. See `comms/cc-deck-v0-spec.md` in the parent repo for the full v0 spec.

## Quick start

```bash
bun install
bun run server.ts --workdir=/path/to/your/repo
```

Then open `http://<host>:8788/` on your phone.

## Deployment (cgroup-limited, matches the spec's operational envelope)

```bash
systemd-run --user --scope --unit=cc-deck \
  -p MemoryMax=2G -p CPUQuota=200% \
  bun run server.ts --workdir=/path/to/your/repo
```

`systemctl --user stop cc-deck` to stop.

## Layout

- `server.ts` — Hono + Bun process supervisor (CC subprocess, SSE, JSONL, hook approval)
- `scripts/cc-start` — launcher that wraps `bun run server.ts`
- `scripts/gate.sh` — PreToolUse approval hook
- `pwa/` — React + Vite mobile client
- `data/sessions/` — JSONL transcripts (gitignored)
