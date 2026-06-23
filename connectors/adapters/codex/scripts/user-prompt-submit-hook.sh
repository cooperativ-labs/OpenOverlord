#!/bin/bash
# Overlord UserPromptSubmit hook — fires before Codex processes each user turn.
# Codex exposes turn_number in the hook body; turn 0 is the initial injected
# mission/objective prompt, which `ovld protocol hook-event` skips.

BODY=$(cat -)
HOOK_NAME="codex"
LOG_DIR="${HOME:-}/.ovld/logs"
LOG_FILE="${LOG_DIR}/user-prompt-submit-hook.log"

log_hook() {
  mkdir -p "$LOG_DIR" 2>/dev/null || return 0
  printf '%s [%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$HOOK_NAME" "$1" >>"$LOG_FILE" 2>/dev/null || true
}

TURN=$(printf '%s' "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('turn_number', 0))" 2>/dev/null || echo "0")
PROMPT_LEN=$(printf '%s' "$BODY" | python3 -c "import json,sys; print(len((json.load(sys.stdin).get('prompt') or '').strip()))" 2>/dev/null || echo "0")
log_hook "received submit turn=$TURN prompt_len=$PROMPT_LEN mission_present=$([ -n "${MISSION_ID:-}" ] && echo yes || echo no)"

printf '%s' "$BODY" | python3 -c "
import hashlib
import json
import os
import re
import sys
from pathlib import Path

UUID_RE = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', re.I)


def detect_codex_session_id_from_disk():
    try:
        sessions_dir = Path.home() / '.codex' / 'sessions'
        if not sessions_dir.is_dir():
            return None
        cwd = os.getcwd()
        candidates = []
        for entry in sessions_dir.rglob('rollout-*.jsonl'):
            try:
                candidates.append((entry.stat().st_mtime, entry))
            except OSError:
                continue
            if len(candidates) > 1000:
                break
        candidates.sort(key=lambda item: item[0], reverse=True)
        fallback_id = None
        for _, entry in candidates[:25]:
            meta_id = None
            meta_cwd = None
            try:
                with entry.open('r', encoding='utf-8', errors='replace') as handle:
                    first_line = handle.readline()
                obj = json.loads(first_line)
                meta = obj.get('payload') if isinstance(obj.get('payload'), dict) else obj
                if isinstance(meta, dict):
                    raw_id = meta.get('id')
                    if isinstance(raw_id, str):
                        match = UUID_RE.search(raw_id)
                        meta_id = match.group(0) if match else None
                    if isinstance(meta.get('cwd'), str):
                        meta_cwd = meta.get('cwd')
            except Exception:
                meta_id = None
            if not meta_id:
                match = UUID_RE.search(entry.name)
                meta_id = match.group(0) if match else None
            if not meta_id:
                continue
            if fallback_id is None:
                fallback_id = meta_id
            if meta_cwd and meta_cwd == cwd:
                return meta_id
        return fallback_id
    except Exception:
        return None


try:
    json.load(sys.stdin)
except Exception:
    sys.exit(0)

tid = os.environ.get('MISSION_ID', '')
external_session_id = (
    os.environ.get('CODEX_THREAD_ID')
    or os.environ.get('CODEX_SESSION_ID')
    or detect_codex_session_id_from_disk()
    or None
)
if tid and external_session_id:
    try:
        key = hashlib.sha256((os.getcwd() + '\0' + tid + '\0codex').encode()).hexdigest()
        native_dir = Path.home() / '.ovld' / 'native-sessions'
        native_dir.mkdir(parents=True, exist_ok=True)
        (native_dir / key).write_text(
            json.dumps({'agent': 'codex', 'missionId': tid, 'externalSessionId': external_session_id}),
            encoding='utf-8',
        )
    except Exception:
        pass
" 2>/dev/null

if [ "$TURN" = "0" ]; then
  log_hook "skipping initial submit turn=0"
  exit 0
fi

if [ -z "${MISSION_ID:-}" ] || ! command -v ovld >/dev/null 2>&1; then
  log_hook "missing required env/tool mission=$([ -n "${MISSION_ID:-}" ] && echo yes || echo no) ovld=$([ "$(command -v ovld 2>/dev/null)" ] && echo yes || echo no)"
  exit 0
fi

printf '%s' "$BODY" | python3 -c "
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

UUID_RE = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', re.I)


def detect_codex_session_id_from_disk():
    try:
        sessions_dir = Path.home() / '.codex' / 'sessions'
        if not sessions_dir.is_dir():
            return None
        cwd = os.getcwd()
        candidates = []
        for entry in sessions_dir.rglob('rollout-*.jsonl'):
            try:
                candidates.append((entry.stat().st_mtime, entry))
            except OSError:
                continue
            if len(candidates) > 1000:
                break
        if not candidates:
            return None
        candidates.sort(key=lambda item: item[0], reverse=True)
        fallback_id = None
        for _, entry in candidates[:25]:
            meta_id = None
            meta_cwd = None
            try:
                with entry.open('r', encoding='utf-8', errors='replace') as handle:
                    first_line = handle.readline()
                obj = json.loads(first_line)
                meta = obj.get('payload') if isinstance(obj.get('payload'), dict) else obj
                if isinstance(meta, dict):
                    raw_id = meta.get('id')
                    if isinstance(raw_id, str):
                        match = UUID_RE.search(raw_id)
                        meta_id = match.group(0) if match else None
                    if isinstance(meta.get('cwd'), str):
                        meta_cwd = meta.get('cwd')
            except Exception:
                meta_id = None
            if not meta_id:
                match = UUID_RE.search(entry.name)
                meta_id = match.group(0) if match else None
            if not meta_id:
                continue
            if fallback_id is None:
                fallback_id = meta_id
            if meta_cwd and meta_cwd == cwd:
                return meta_id
        return fallback_id
    except Exception:
        return None


try:
    body = json.load(sys.stdin)
except Exception:
    sys.exit(0)

text = (body.get('prompt') or '').strip()
if not text:
    sys.exit(0)

turn_index = body.get('turn_number', 0)
external_session_id = (
    os.environ.get('CODEX_THREAD_ID')
    or os.environ.get('CODEX_SESSION_ID')
    or detect_codex_session_id_from_disk()
    or None
)

tid = os.environ.get('MISSION_ID', '')
session_key = os.environ.get('SESSION_KEY') or ''
if not session_key:
    encoded = base64.urlsafe_b64encode(os.getcwd().encode()).decode().rstrip('=')
    session_file = Path(tempfile.gettempdir()) / f'.overlord-session-{encoded}'
    try:
        persisted = json.loads(session_file.read_text(encoding='utf-8'))
        if persisted.get('missionId') == tid:
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
    '--mission-id', tid,
    '--prompt', text,
    '--turn-index', str(turn_index),
]
if external_session_id:
    args.extend(['--external-session-id', external_session_id])
if session_key:
    args.extend(['--session-key', session_key])

with open(os.devnull, 'wb') as devnull:
    subprocess.Popen(args, stdout=devnull, stderr=devnull, env=env)
" 2>/dev/null

exit 0
