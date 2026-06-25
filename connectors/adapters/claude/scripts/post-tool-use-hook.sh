#!/bin/bash
# Overlord PostToolUse hook — fires after Claude runs a file-editing tool.
# It records the exact files THIS agent edits into a per-session touched-files
# log so `ovld protocol deliver` can intersect the VCS working-tree delta with
# the agent's own edits. It also stores lightweight rationale notes beside that
# log so deliver can prefill reviewable per-file rationale drafts. The log path
# + key must stay in sync with cli/src/vcs.ts:
#   <OVLD_HOME|~/.ovld>/vcs-touched/<sha256(abspath(cwd) + "\0" + MISSION_ID)>.json
# with shape {"updatedAt": "...", "paths": ["<abs>", ...]}.
#   <OVLD_HOME|~/.ovld>/vcs-rationale-notes/<same-key>.json

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
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    body = json.load(sys.stdin)
except Exception:
    sys.exit(0)

tool_input = body.get("tool_input") or {}
tool_name = body.get("tool_name")
if not isinstance(tool_name, str) or not tool_name.strip():
    tool_name = "file edit"

candidates = []
edit_counts = {}
for key in ("file_path", "notebook_path"):
    value = tool_input.get(key)
    if isinstance(value, str) and value.strip():
        candidates.append(value.strip())
        edit_counts[value.strip()] = 1
edits = tool_input.get("edits")
if isinstance(edits, list):
    top_level_path = tool_input.get("file_path")
    if isinstance(top_level_path, str) and top_level_path.strip():
        edit_counts[top_level_path.strip()] = 0
    for edit in edits:
        if isinstance(edit, dict):
            value = edit.get("file_path") or top_level_path
            if isinstance(value, str) and value.strip():
                candidates.append(value.strip())
                edit_counts[value.strip()] = edit_counts.get(value.strip(), 0) + 1

if not candidates:
    sys.exit(0)

def compact(value, limit=500):
    if not isinstance(value, str):
        return None
    text = " ".join(value.split())
    if not text:
        return None
    return text[: limit - 1] + "..." if len(text) > limit else text

def edit_intent(raw_path):
    count = edit_counts.get(raw_path, 1)
    if tool_name == "Write":
        return "wrote or replaced the file"
    if tool_name == "MultiEdit" or count > 1:
        return f"applied {count} targeted text edit(s)"
    if tool_name == "Edit":
        return "replaced selected text"
    if "notebook" in raw_path.lower() or "Notebook" in tool_name:
        return "edited notebook content"
    return f"edited via {tool_name}"

def recent_assistant_context():
    transcript = body.get("transcript_path")
    if not isinstance(transcript, str) or not transcript:
        return None
    try:
        with open(transcript, encoding="utf-8") as handle:
            lines = handle.readlines()[-200:]
    except Exception:
        return None
    for line in reversed(lines):
        try:
            event = json.loads(line)
        except Exception:
            continue
        if not isinstance(event, dict):
            continue
        message = event.get("message") if isinstance(event, dict) else None
        role = message.get("role") if isinstance(message, dict) else event.get("type")
        if role != "assistant":
            continue
        content = message.get("content") if isinstance(message, dict) else event.get("content")
        texts = []
        if isinstance(content, str):
            texts.append(content)
        elif isinstance(content, list):
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    text = item.get("text")
                    if isinstance(text, str):
                        texts.append(text)
        text = compact(" ".join(texts))
        if text:
            return text
    return None

def git_content_hash(cwd, absolute):
    try:
        return subprocess.check_output(
            ["git", "hash-object", absolute],
            cwd=cwd,
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip() or None
    except Exception:
        return None

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

notes_dir = Path(data_dir) / "vcs-rationale-notes"
notes_dir.mkdir(parents=True, exist_ok=True)
notes_target = notes_dir / (key + ".json")
existing_notes = []
try:
    with open(notes_target, encoding="utf-8") as handle:
        prior_notes = json.load(handle)
    if isinstance(prior_notes.get("notes"), list):
        existing_notes = [n for n in prior_notes["notes"] if isinstance(n, dict)]
except Exception:
    existing_notes = []

assistant_context = recent_assistant_context()
new_notes = []
seen_note_paths = set()
for raw in candidates:
    absolute = os.path.abspath(os.path.join(cwd, raw)).replace(chr(92), "/")
    if absolute in seen_note_paths:
        continue
    seen_note_paths.add(absolute)
    new_notes.append(
        {
            "filePath": absolute,
            "toolName": compact(tool_name, 80),
            "intent": compact(edit_intent(raw)),
            "transcriptContext": assistant_context,
            "contentHash": git_content_hash(cwd, absolute),
            "recordedAt": datetime.now(timezone.utc).isoformat(),
        }
    )

try:
    with open(notes_target, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "updatedAt": datetime.now(timezone.utc).isoformat(),
                "notes": (existing_notes + new_notes)[-200:],
            },
            handle,
        )
except Exception:
    pass
' 2>/dev/null

exit 0
