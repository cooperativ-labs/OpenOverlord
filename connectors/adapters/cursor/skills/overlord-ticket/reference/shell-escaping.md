# Shell Escaping

When a summary or question contains backticks, `$vars`, or other shell-special characters, always use `--summary-file -` (or `--question-file -`) with a single-quoted heredoc (`<<'EOF'`) to prevent shell expansion. Never retry by stripping or escaping content — pipe stdin instead.

```bash
ovld protocol update --session-key <sessionKey> --ticket-id $TICKET_ID --summary-file - --phase execute <<'EOF'
What you did and why — including `backticks`, "quotes", and $variables are all safe here.
EOF
```

Use `--payload-json` when the full delivery object fits comfortably inline. For larger delivery payloads, prefer `--payload-file -` and stream the full JSON on stdin so no scratch file needs to be created or removed.

If the summary contains special characters, use `--summary-file -` and pipe via a single-quoted heredoc (`<<'EOF'`) to prevent shell expansion.

If you use `--payload-file`, `--artifacts-file`, or `--change-rationales-file` with a real path, treat that file as ephemeral scratch data under `.overlord/tmp` and remove it after delivery.

