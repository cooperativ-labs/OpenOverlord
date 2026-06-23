#!/bin/bash
# Overlord UserPromptSubmit hook — fires before Claude processes each user turn.
# Claude Code does not expose turn_number in the hook body; we persist the last
# posted turnIndex per session_id and send (last + 1). The first submit is
# turnIndex 0 (initial injected mission/objective prompt), which
# `ovld protocol hook-event` skips — same contract as the Cursor hook.

BODY=$(cat -)
HOOK_NAME="claude"
LOG_DIR="${HOME:-}/.ovld/logs"
LOG_FILE="${LOG_DIR}/user-prompt-submit-hook.log"

log_hook() {
  mkdir -p "$LOG_DIR" 2>/dev/null || return 0
  printf '%s [%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$HOOK_NAME" "$1" >>"$LOG_FILE" 2>/dev/null || true
}

PROMPT_LEN=$(printf '%s' "$BODY" | python3 -c "import json,sys; print(len((json.load(sys.stdin).get('prompt') or '').strip()))" 2>/dev/null || echo "0")
SESSION_ID=$(printf '%s' "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('session_id') or 'unknown')" 2>/dev/null || echo "unknown")
log_hook "received submit session_id=$SESSION_ID prompt_len=$PROMPT_LEN mission_present=$([ -n "${MISSION_ID:-}" ] && echo yes || echo no)"

if [ -z "${MISSION_ID:-}" ] || ! command -v ovld >/dev/null 2>&1; then
  log_hook "missing required env/tool mission=$([ -n "${MISSION_ID:-}" ] && echo yes || echo no) ovld=$([ "$(command -v ovld 2>/dev/null)" ] && echo yes || echo no)"
  exit 0
fi

printf '%s' "$BODY" | python3 -c "
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

try:
    body = json.load(sys.stdin)
except Exception:
    sys.exit(0)

text = (body.get('prompt') or '').strip()
if not text:
    sys.exit(0)

sid = body.get('session_id') or 'unknown'
tid = os.environ.get('MISSION_ID', '')
if sid != 'unknown' and tid:
    try:
        key = hashlib.sha256((os.getcwd() + '\0' + tid + '\0claude').encode()).hexdigest()
        native_dir = Path.home() / '.ovld' / 'native-sessions'
        native_dir.mkdir(parents=True, exist_ok=True)
        (native_dir / key).write_text(
            json.dumps({'agent': 'claude', 'missionId': tid, 'externalSessionId': sid}),
            encoding='utf-8',
        )
    except Exception:
        pass
state_dir = os.path.join(os.path.expanduser('~'), '.ovld', 'claude-user-prompt-hook')
os.makedirs(state_dir, exist_ok=True)
path = os.path.join(state_dir, hashlib.sha256(sid.encode()).hexdigest())
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

session_key = os.environ.get('SESSION_KEY') or ''
if not session_key:
    encoded = __import__('base64').urlsafe_b64encode(os.getcwd().encode()).decode().rstrip('=')
    session_file = os.path.join(__import__('tempfile').gettempdir(), f'.overlord-session-{encoded}')
    try:
        with open(session_file, encoding='utf-8') as handle:
            persisted = json.load(handle)
        if persisted.get('missionId') == tid:
            session_key = persisted.get('sessionKey') or ''
    except Exception:
        session_key = ''

payload = {
    'hookType': 'UserPromptSubmit',
    'missionId': tid,
    'prompt': text,
    'turnIndex': turn_index,
}
if sid != 'unknown':
    payload['externalSessionId'] = sid
if session_key:
    payload['sessionKey'] = session_key

env = dict(os.environ)
user_token = (
    env.get('CLAUDE_PLUGIN_OPTION_USER_TOKEN')
    or env.get('Overlord_USER_TOKEN')
    or env.get('OVLD_USER_TOKEN')
)
if user_token:
    env['Overlord_USER_TOKEN'] = user_token

args = [
    'ovld', 'protocol', 'hook-event',
    '--hook-type', 'UserPromptSubmit',
    '--mission-id', tid,
    '--prompt', text,
    '--turn-index', str(turn_index),
]
if sid != 'unknown':
    args.extend(['--external-session-id', sid])
if session_key:
    args.extend(['--session-key', session_key])

with open(os.devnull, 'wb') as devnull:
    subprocess.Popen(args, stdout=devnull, stderr=devnull, env=env)
" 2>/dev/null

exit 0
