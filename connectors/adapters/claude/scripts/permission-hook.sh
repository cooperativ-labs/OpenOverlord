#!/bin/bash
# Overlord PermissionRequest notification hook (plugin-managed).
#
# Uses the protocol CLI so the hook stays behind the Connector → Protocol
# boundary. Silently no-ops if the ticket or CLI is unavailable — the hook must
# never block the user or leak errors into the Claude session.
BODY=$(cat -)
if [ -n "${TICKET_ID:-}" ] && command -v ovld >/dev/null 2>&1; then
  (
    USER_TOKEN="${CLAUDE_PLUGIN_OPTION_USER_TOKEN:-${OPENOVERLORD_USER_TOKEN:-${OVLD_USER_TOKEN:-}}}"
    if [ -n "$USER_TOKEN" ]; then
      export OPENOVERLORD_USER_TOKEN="$USER_TOKEN"
    fi
    printf '%s' "$BODY" | ovld protocol permission-request \
      --ticket-id "$TICKET_ID" \
      --payload-file - \
      >/dev/null 2>&1
  ) &
  disown
fi
exit 0
