#!/bin/bash
# Overlord Cursor postToolUse hook.
# Records Cursor Write/Edit and Shell effects in the per-session touched-files
# log used by `ovld protocol deliver` for concurrent-work attribution.

BODY=$(cat -)
LOG_DIR="${HOME:-}/.ovld/logs"
LOG_FILE="${LOG_DIR}/cursor-post-tool-use-hook.log"

log_hook() {
  mkdir -p "$LOG_DIR" 2>/dev/null || return 0
  printf '%s [cursor-post-tool-use] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" >>"$LOG_FILE" 2>/dev/null || true
}

if ! command -v ovld >/dev/null 2>&1; then
  log_hook "ovld not on PATH; skipping"
  exit 0
fi

RESULT=$(printf '%s' "$BODY" | ovld protocol record-touched 2>>"$LOG_FILE")
log_hook "record-touched: ${RESULT:-<no output>}"

exit 0
