---
description: Record completed-from-chat work as a mission in review, with a feed post (no attach)
---

Immediately record the work you just completed in this chat as a new Overlord mission via `ovld protocol record-work`. No agent session is opened — the work is already done.

Synthesize from the current conversation:
- `objective`: what was asked / what was done (1-3 sentences).
- `summary`: reviewer-friendly narrative of what changed and why.
- `changeRationales`: one entry per meaningful git-tracked file change (`label`, `file_path`, `summary`, `why`, `impact`, optional `hunks`). Use `git status` and `git diff` to enumerate changed files.
- `artifacts` (optional): `next_steps`, `test_results`, `decision`, `note`, `url`.

If a command argument is present, treat it as additional context to weave into the summary.

Run:
`ovld protocol record-work --agent antigravity --payload-file -`

and stream a JSON object `{ "objective": "...", "summary": "...", "artifacts": [...], "changeRationales": [...] }` on stdin via a single-quoted heredoc (`<<'EOF'`).

After the command succeeds, report the new `MISSION_ID`.

Rules:
- Do NOT use this for in-progress work. Use `/prompt` for that.
- The CLI validates that every changed git-tracked file is represented in `changeRationales` unless `--skip-file-change-check` is passed.
- If project resolution fails, re-run with `--project-id <id-or-name>` or `--personal`.
