#!/bin/bash
# Overlord Stop hook — fires when the agent's turn ends.
# Checks whether the session has pending delivery work and outputs
# guidance if delivery is needed. Does not force delivery.

BODY=$(cat -)
LOG_DIR="${HOME:-}/.ovld/logs"
LOG_FILE="${LOG_DIR}/stop-hook.log"

log_hook() {
  mkdir -p "$LOG_DIR" 2>/dev/null || return 0
  printf '%s [stop] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" >>"$LOG_FILE" 2>/dev/null || true
}

if [ -z "${TICKET_ID:-}" ] || ! command -v ovld >/dev/null 2>&1; then
  log_hook "missing required ticket or ovld, skipping"
  exit 0
fi

SESSION_KEY=$(python3 -c "
import base64, json, os, tempfile
cwd = os.getcwd().encode()
encoded = base64.urlsafe_b64encode(cwd).decode().rstrip('=')
session_file = os.path.join(tempfile.gettempdir(), f'.overlord-session-{encoded}')
try:
    with open(session_file) as f:
        data = json.load(f)
        print(data.get('sessionKey', ''))
except Exception:
    print('')
" 2>/dev/null)

if [ -z "$SESSION_KEY" ]; then
  log_hook "no persisted session key, skipping delivery check"
  exit 0
fi

log_hook "checking delivery status session_key=${SESSION_KEY:0:8}..."

RESPONSE_FILE=$(mktemp "${TMPDIR:-/tmp}/overlord-stop-hook.XXXXXX")
USER_TOKEN="${CLAUDE_PLUGIN_OPTION_USER_TOKEN:-${OPENOVERLORD_USER_TOKEN:-${OVLD_USER_TOKEN:-}}}"
if [ -n "$USER_TOKEN" ]; then
  export OPENOVERLORD_USER_TOKEN="$USER_TOKEN"
fi
ovld protocol hook-event \
  --hook-type Stop \
  --ticket-id "$TICKET_ID" \
  --session-key "$SESSION_KEY" \
  >"$RESPONSE_FILE" 2>/dev/null
OVLD_EXIT=$?

if [ "$OVLD_EXIT" -eq 0 ] && [ -f "$RESPONSE_FILE" ]; then
  GUIDANCE=$(python3 -c "
import json, sys
try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
    status = data.get('deliveryStatus')
    if status and status.get('needed'):
        print(status.get('reason', 'Pending delivery work detected.'))
except Exception:
    pass
" "$RESPONSE_FILE" 2>/dev/null)

  if [ -n "$GUIDANCE" ]; then
    log_hook "delivery needed, outputting guidance"
    echo "[Overlord] $GUIDANCE"
  else
    log_hook "no delivery needed"
  fi
else
  log_hook "hook-event failed exit=$OVLD_EXIT"
fi

rm -f "$RESPONSE_FILE"
exit 0
