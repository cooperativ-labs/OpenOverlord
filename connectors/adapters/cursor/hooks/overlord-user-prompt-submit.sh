#!/bin/bash
# Overlord Cursor beforeSubmitPrompt hook — posts user composer prompts to the ticket activity feed.
# Cursor does not expose Claude's turn_number; we persist the last posted turnIndex per conversation_id
# and send (last + 1). The first submit is turnIndex 0 (initial injected ticket/objective prompt), which
# `ovld protocol hook-event` skips — same contract as Claude's UserPromptSubmit hook.

BODY=$(cat -)
HOOK_NAME="cursor"
LOG_DIR="${HOME:-}/.ovld/logs"
LOG_FILE="${LOG_DIR}/user-prompt-submit-hook.log"

log_hook() {
  mkdir -p "$LOG_DIR" 2>/dev/null || return 0
  printf '%s [%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$HOOK_NAME" "$1" >>"$LOG_FILE" 2>/dev/null || true
}

PROMPT_LEN=$(
  printf '%s' "$BODY" | python3 -c "
import json, sys
try:
    body = json.load(sys.stdin)
    text = (body.get('prompt') or body.get('message') or '').strip()
    print(len(text))
except Exception:
    print(0)
" 2>/dev/null || echo "0"
)
CONVERSATION_ID=$(
  printf '%s' "$BODY" | python3 -c "
import json, sys
try:
    print(json.load(sys.stdin).get('conversation_id') or 'unknown')
except Exception:
    print('unknown')
" 2>/dev/null || echo "unknown"
)
log_hook "received submit conversation_id=$CONVERSATION_ID prompt_len=$PROMPT_LEN ticket_present=$([ -n "${TICKET_ID:-}" ] && echo yes || echo no)"

if [ -z "${TICKET_ID:-}" ] || ! command -v ovld >/dev/null 2>&1; then
  log_hook "missing required env/tool ticket=$([ -n "${TICKET_ID:-}" ] && echo yes || echo no) ovld=$([ "$(command -v ovld 2>/dev/null)" ] && echo yes || echo no)"
  printf '%s\n' '{"continue":true}'
  exit 0
fi

printf '%s' "$BODY" | python3 -c "
import hashlib
import json
import os
import subprocess
import sys

try:
    body = json.load(sys.stdin)
except Exception:
    sys.exit(0)

text = (body.get('prompt') or body.get('message') or '').strip()
if not text:
    sys.exit(0)

cid = body.get('conversation_id') or 'unknown'
state_dir = os.path.join(os.path.expanduser('~'), '.ovld', 'cursor-user-prompt-hook')
os.makedirs(state_dir, exist_ok=True)
path = os.path.join(state_dir, hashlib.sha256(cid.encode()).hexdigest())
last_posted = -1
try:
    with open(path, encoding='utf-8') as handle:
        raw = (handle.read() or '').strip()
        if raw != '':
            last_posted = int(raw)
except Exception:
    last_posted = -1

turn_index = last_posted + 1
with open(path, 'w', encoding='utf-8') as handle:
    handle.write(str(turn_index))

tid = os.environ.get('TICKET_ID', '')
session_key = os.environ.get('SESSION_KEY') or ''
if not session_key:
    encoded = __import__('base64').urlsafe_b64encode(os.getcwd().encode()).decode().rstrip('=')
    session_file = os.path.join(__import__('tempfile').gettempdir(), f'.overlord-session-{encoded}')
    try:
        with open(session_file, encoding='utf-8') as handle:
            persisted = json.load(handle)
        if persisted.get('ticketId') == tid:
            session_key = persisted.get('sessionKey') or ''
    except Exception:
        session_key = ''

env = dict(os.environ)
user_token = env.get('Overlord_USER_TOKEN') or env.get('OVLD_USER_TOKEN')
if user_token:
    env['Overlord_USER_TOKEN'] = user_token

args = [
    'ovld', 'protocol', 'hook-event',
    '--hook-type', 'UserPromptSubmit',
    '--ticket-id', tid,
    '--prompt', text,
    '--turn-index', str(turn_index),
]
if cid != 'unknown':
    args.extend(['--external-session-id', cid])
if session_key:
    args.extend(['--session-key', session_key])

with open(os.devnull, 'wb') as devnull:
    subprocess.Popen(args, stdout=devnull, stderr=devnull, env=env)
" 2>/dev/null

printf '%s\n' '{"continue":true}'
exit 0
