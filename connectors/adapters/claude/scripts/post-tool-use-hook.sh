#!/bin/bash
# Overlord PostToolUse hook — fires after Claude runs a file-editing tool
# (Edit/Write/MultiEdit/NotebookEdit) or a Bash command. It records the exact
# files THIS agent edits into a per-session touched-files log so `ovld protocol
# deliver` can flag the VCS working-tree delta against the agent's own edits.
# For Bash, which never names the files it changed (codegen, package managers,
# `git mv`, build scripts), the CLI instead diffs `git status --porcelain`
# against a cached last-seen snapshot and folds anything newly dirty into the
# same log. It also stores lightweight rationale notes beside that log so
# deliver can prefill reviewable per-file rationale drafts.
#
# The bookkeeping (mission resolution, key derivation, log format) lives in the
# CLI (`ovld protocol record-touched`, cli/src/record-touched.ts) so Codex and
# Cursor can wire up the same hook body to the same subcommand instead of each
# adapter reimplementing it. Mission resolution no longer requires MISSION_ID in
# the environment: the CLI resolves the active mission from the per-cwd
# active-session manifest written at `attach` (~/.ovld/vcs-sessions/), falling
# back to MISSION_ID as an explicit override when it is set.

BODY=$(cat -)
HOOK_NAME="claude-post-tool-use"
LOG_DIR="${HOME:-}/.ovld/logs"
LOG_FILE="${LOG_DIR}/post-tool-use-hook.log"

log_hook() {
  mkdir -p "$LOG_DIR" 2>/dev/null || return 0
  printf '%s [%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$HOOK_NAME" "$1" >>"$LOG_FILE" 2>/dev/null || true
}

mkdir -p "$LOG_DIR" 2>/dev/null || true

if ! command -v ovld >/dev/null 2>&1; then
  log_hook "ovld not on PATH; skipping"
  exit 0
fi

RESULT=$(printf '%s' "$BODY" | ovld protocol record-touched 2>>"$LOG_FILE")
log_hook "record-touched: ${RESULT:-<no output>}"

exit 0
