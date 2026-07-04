#!/bin/bash
# Overlord PreToolUse hook (plugin-managed) — Antigravity's closest analog to
# the canonical PermissionRequest hook. It fires before every tool call, so it
# is used only to *record* the request through `ovld protocol
# permission-request`; it always allows the call. This hook must never gate or
# slow down tool execution, and must never leak errors into the session, so
# the recording call runs detached and this script always answers allow.
BODY=$(cat -)

if [ -n "${MISSION_ID:-}" ] && command -v ovld >/dev/null 2>&1; then
  (
    USER_TOKEN="${Overlord_USER_TOKEN:-${OVLD_USER_TOKEN:-}}"
    if [ -n "$USER_TOKEN" ]; then
      export Overlord_USER_TOKEN="$USER_TOKEN"
    fi
    printf '%s' "$BODY" | ovld protocol permission-request \
      --mission-id "$MISSION_ID" \
      --payload-file - \
      >/dev/null 2>&1
  ) &
  disown
fi

printf '{"allow_tool":true}'
exit 0
