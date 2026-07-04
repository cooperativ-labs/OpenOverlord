#!/bin/bash
# Overlord PreInvocation hook (plugin-managed) — Antigravity's closest analog to
# the canonical UserPromptSubmit follow-up-capture hook. It fires before each
# agent invocation and records the human's turn text as `user_follow_up`
# activity through `ovld protocol hook-event`. It must never block the agent:
# on any missing field, missing MISSION_ID, or missing `ovld`, it prints a
# harmless allow response and exits 0.
#
# Antigravity's public docs do not yet pin an exact PreInvocation payload
# shape the way they do for PreToolUse (`toolCall.args`), so this script
# defensively probes a few plausible field names (`prompt`, `message`, `text`,
# `input`) for the human turn text rather than assuming one.

BODY=$(cat -)
HOOK_NAME="antigravity-pre-invocation"
LOG_DIR="${HOME:-}/.ovld/logs"
LOG_FILE="${LOG_DIR}/pre-invocation-hook.log"

log_hook() {
  mkdir -p "$LOG_DIR" 2>/dev/null || return 0
  printf '%s [%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$HOOK_NAME" "$1" >>"$LOG_FILE" 2>/dev/null || true
}

respond_allow() {
  printf '{"decision":"allow"}'
  exit 0
}

if [ -z "${MISSION_ID:-}" ] || ! command -v ovld >/dev/null 2>&1; then
  log_hook "missing required env/tool mission=$([ -n "${MISSION_ID:-}" ] && echo yes || echo no) ovld=$([ "$(command -v ovld 2>/dev/null)" ] && echo yes || echo no)"
  respond_allow
fi

printf '%s' "$BODY" | python3 -c "
import json
import os
import subprocess
import sys

try:
    body = json.load(sys.stdin)
except Exception:
    sys.exit(0)

text = ''
for key in ('prompt', 'message', 'text', 'input'):
    value = body.get(key)
    if isinstance(value, str) and value.strip():
        text = value.strip()
        break

if not text:
    sys.exit(0)

mission_id = os.environ.get('MISSION_ID', '')
session_id = body.get('session_id') or body.get('sessionId')
session_key = os.environ.get('SESSION_KEY') or ''

env = dict(os.environ)
user_token = env.get('Overlord_USER_TOKEN') or env.get('OVLD_USER_TOKEN')
if user_token:
    env['Overlord_USER_TOKEN'] = user_token

args = [
    'ovld', 'protocol', 'hook-event',
    '--hook-type', 'UserPromptSubmit',
    '--mission-id', mission_id,
    '--prompt', text,
]
if session_id:
    args.extend(['--external-session-id', str(session_id)])
if session_key:
    args.extend(['--session-key', session_key])

with open(os.devnull, 'wb') as devnull:
    subprocess.Popen(args, stdout=devnull, stderr=devnull, env=env)
" 2>/dev/null

respond_allow
