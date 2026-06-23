Immediately record the work you just completed in this chat as a new Overlord mission via `ovld protocol record-work`. No agent session is opened — the work is already done.

Synthesize from the current conversation:
- `objective`: what was asked / what was done.
- `summary`: reviewer-friendly narrative for the feed.
- `changeRationales`: one entry per meaningful git-tracked file change (`label`, `file_path`, `summary`, `why`, `impact`, optional `hunks`). Use `git status` and `git diff` to enumerate changed files.
- `artifacts` (optional): `next_steps`, `test_results`, `decision`, `note`, `url`.

If text was provided after `/record-work`, treat it as additional context for the summary.

Run `ovld protocol record-work --payload-file -` and stream the JSON payload `{ "objective": "...", "summary": "...", "artifacts": [...], "changeRationales": [...] }` on stdin via a single-quoted heredoc.

After the command succeeds, report the new MISSION_ID.

Do NOT use for in-progress work — use `/prompt` for that.
