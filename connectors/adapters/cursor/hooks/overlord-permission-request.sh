#!/bin/bash
# Overlord Cursor permission observation hook.
#
# Cursor invokes this script from beforeShellExecution and beforeMCPExecution,
# its native permission-decision points. The hook records the request through
# the Connector -> Protocol surface but intentionally returns no decision, so
# Cursor's own permissions and any other user hooks remain authoritative.

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

exit 0
