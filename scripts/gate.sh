#!/usr/bin/env bash
# cc-deck PreToolUse approval gate.
# Invoked by Claude Code as a PreToolUse hook. Reads the hook input JSON
# on stdin, forwards it to the cc-deck server, blocks on the operator's
# decision, echoes the server's ready-to-emit hookSpecificOutput reply.
set -euo pipefail

PORT="${CC_DECK_PORT:-8788}"
INPUT="$(cat)"

# --max-time is very long: approval latency = time until the operator
# taps the button, which can be minutes if the phone is asleep.
exec curl -sS -X POST \
  -H "content-type: application/json" \
  --data-raw "$INPUT" \
  --max-time 3600 \
  "http://127.0.0.1:${PORT}/hook/approval"
