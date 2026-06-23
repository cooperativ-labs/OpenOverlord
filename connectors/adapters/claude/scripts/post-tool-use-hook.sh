#!/bin/bash
# Overlord PostToolUse hook — fires after Claude runs a file-editing tool.
# It records the exact files THIS agent edits into a per-session touched-files
# log so `ovld protocol deliver` can intersect the VCS working-tree delta with
# the agent's own edits. That keeps concurrent missions sharing one working tree
# from being attributed to this session. The log path + key must stay in sync
# with cli/src/vcs.ts (touchedFilesPath / sessionKeyHash):
#   <OVLD_HOME|~/.ovld>/vcs-touched/<sha256(abspath(cwd) + "\0" + MISSION_ID)>.json
# with shape {"updatedAt": "...", "paths": ["<abs>", ...]}.

BODY=$(cat -)
HOOK_NAME="claude-post-tool-use"
LOG_DIR="${HOME:-}/.ovld/logs"
LOG_FILE="${LOG_DIR}/post-tool-use-hook.log"

log_hook() {
  mkdir -p "$LOG_DIR" 2>/dev/null || return 0
  printf '%s [%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$HOOK_NAME" "$1" >>"$LOG_FILE" 2>/dev/null || true
}

if [ -z "${MISSION_ID:-}" ]; then
  log_hook "no MISSION_ID in env; skipping"
  exit 0
fi

printf '%s' "$BODY" | MISSION_ID="${MISSION_ID}" python3 -c '
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    body = json.load(sys.stdin)
except Exception:
    sys.exit(0)

tool_input = body.get("tool_input") or {}

candidates = []
for key in ("file_path", "notebook_path"):
    value = tool_input.get(key)
    if isinstance(value, str) and value.strip():
        candidates.append(value.strip())
edits = tool_input.get("edits")
if isinstance(edits, list):
    for edit in edits:
        if isinstance(edit, dict):
            value = edit.get("file_path")
            if isinstance(value, str) and value.strip():
                candidates.append(value.strip())

if not candidates:
    sys.exit(0)

# Match cli/src/vcs.ts: key = sha256(abspath(cwd) + chr(0) + MISSION_ID).
cwd = body.get("cwd") or os.getcwd()
tid = os.environ.get("MISSION_ID", "")
key = hashlib.sha256((os.path.abspath(cwd) + chr(0) + tid).encode()).hexdigest()

data_dir = os.environ.get("OVLD_HOME") or os.path.join(os.path.expanduser("~"), ".ovld")
target_dir = Path(data_dir) / "vcs-touched"
target_dir.mkdir(parents=True, exist_ok=True)
target = target_dir / (key + ".json")

existing = []
try:
    with open(target, encoding="utf-8") as handle:
        prior = json.load(handle)
    if isinstance(prior.get("paths"), list):
        existing = [p for p in prior["paths"] if isinstance(p, str)]
except Exception:
    existing = []

merged = list(existing)
seen = set(existing)
for raw in candidates:
    absolute = os.path.abspath(os.path.join(cwd, raw)).replace(chr(92), "/")
    if absolute not in seen:
        seen.add(absolute)
        merged.append(absolute)

try:
    with open(target, "w", encoding="utf-8") as handle:
        json.dump({"updatedAt": datetime.now(timezone.utc).isoformat(), "paths": merged}, handle)
except Exception:
    pass
' 2>/dev/null

exit 0
