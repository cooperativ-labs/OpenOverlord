#!/bin/bash
# Overlord Cursor stop hook.
# Checks whether the attached mission still needs delivery and, at most once,
# asks Cursor to continue so the agent can deliver. It never delivers itself.

BODY=$(cat -)
LOG_DIR="${HOME:-}/.ovld/logs"
LOG_FILE="${LOG_DIR}/cursor-stop-hook.log"

log_hook() {
  mkdir -p "$LOG_DIR" 2>/dev/null || return 0
  printf '%s [cursor-stop] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" >>"$LOG_FILE" 2>/dev/null || true
}

if [ -z "${MISSION_ID:-}" ] || ! command -v ovld >/dev/null 2>&1; then
  log_hook "missing required mission or ovld, skipping"
  printf '{}'
  exit 0
fi

LOOP_COUNT=$(printf '%s' "$BODY" | python3 -c '
import json, sys
try:
    value = json.load(sys.stdin).get("loop_count", 0)
    print(value if isinstance(value, int) else 0)
except Exception:
    print(0)
' 2>/dev/null)

if [ "${LOOP_COUNT:-0}" -gt 0 ]; then
  log_hook "automatic follow-up already used, skipping"
  printf '{}'
  exit 0
fi

RESPONSE_FILE=$(mktemp "${TMPDIR:-/tmp}/overlord-cursor-stop.XXXXXX")
USER_TOKEN="${Overlord_USER_TOKEN:-${OVLD_USER_TOKEN:-}}"
if [ -n "$USER_TOKEN" ]; then
  export Overlord_USER_TOKEN="$USER_TOKEN"
fi

ovld protocol hook-event \
  --hook-type Stop \
  --mission-id "$MISSION_ID" \
  >"$RESPONSE_FILE" 2>/dev/null
OVLD_EXIT=$?

if [ "$OVLD_EXIT" -eq 0 ]; then
  python3 - "$RESPONSE_FILE" <<'PY'
import json, sys

response = {}
try:
    with open(sys.argv[1]) as handle:
        data = json.load(handle)
    status = data.get("deliveryStatus") or {}
    if status.get("needed"):
        reason = status.get("reason") or "Pending Overlord delivery work detected."
        response["followup_message"] = (
            f"[Overlord] {reason} Complete the required verification and deliver the attached mission now."
        )
except Exception:
    pass

print(json.dumps(response, separators=(",", ":")))
PY
else
  log_hook "hook-event failed exit=$OVLD_EXIT"
  printf '{}'
fi

rm -f "$RESPONSE_FILE"
exit 0
