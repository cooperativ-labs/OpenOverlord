# Shell Escaping

When a summary or question contains backticks, `$vars`, or other shell-special characters, always use `--summary-file -` (or `--question-file -`) with a single-quoted heredoc (`<<'EOF'`) to prevent shell expansion. Never retry by stripping or escaping content — pipe stdin instead.

```bash
ovld protocol update --session-key <sessionKey> --mission-id $MISSION_ID --summary-file - --phase execute <<'EOF'
What you did and why — including `backticks`, "quotes", and $variables are all safe here.
EOF
```

## Inline JSON size limits

Oversized inline `--*-json` arguments are **rejected** by the CLI (limit ~8 KB per flag). This includes `--change-rationales-json`, `--payload-json`, `--artifacts-json`, and `--objectives-json`. Pass large JSON via the paired `--*-file -` flag and a single-quoted heredoc instead:

```bash
ovld protocol deliver --session-key <sessionKey> --mission-id $MISSION_ID \
  --summary "Short narrative summary stays inline." \
  --change-rationales-file - <<'EOF'
[{"label":"Example","file_path":"lib/api.ts","summary":"...","why":"...","impact":"..."}]
EOF
```

If `heartbeat` succeeds but `deliver` or `update` fails, the session is likely fine — retry with JSON on stdin rather than inline `--*-json`.

Use `--payload-file -` when the full delivery object (summary, artifacts, and change rationales together) exceeds the inline limit.

If the summary contains special characters, use `--summary-file -` and pipe via a single-quoted heredoc (`<<'EOF'`) to prevent shell expansion.

If you use `--payload-file`, `--artifacts-file`, or `--change-rationales-file` with a real path, treat that file as ephemeral scratch data under `.overlord/tmp` and remove it after delivery.

