---
description: Record completed-from-chat work as a mission in review (no attach)
argument-hint: [optional additional context]
disable-model-invocation: true
---

Immediately record the work you just completed in this chat as a new Overlord mission via `ovld protocol record-work`. No agent session is opened — the work is already done. This creates a mission with one completed objective, records the file changes with rationales, lands it in the review column, and runs the standard Gemini delivery summary.

Synthesize from the current conversation:
- `objective`: what was asked / what was done (1–3 sentences).
- `summary`: reviewer-friendly narrative of what changed and why.
- `changeRationales`: one entry per meaningful git-tracked file change (`file_path`, `label`, `summary`, `why`, `impact`, optional `hunks`). Use `git status` and `git diff` to enumerate changed files. Every listed file shows as "covered" in review.
- `changedFiles` (optional): touched files you are not writing a full rationale for (`filePath`, optional `vcsStatus`).
- `title` (optional): mission title; defaults to a title derived from the objective.
- `artifacts` (optional): `next_steps`, `test_results`, `decision`, `note`, `url`.

If `$ARGUMENTS` is non-empty, treat it as additional context to weave into the summary.

Run:
`ovld protocol record-work --payload-file -`

and stream a single JSON object on stdin via a single-quoted heredoc (`<<'EOF'`):

```
{ "objective": "...", "summary": "...", "title": "...", "changeRationales": [...], "changedFiles": [...], "artifacts": [...] }
```

After the command succeeds, report the new `MISSION_ID`.

Rules:
- Do NOT use this for in-progress work. Use `/prompt` for that.
- If project resolution fails, re-run with `--project-id <id-or-name>`.
- The exact submission format is documented in `skills/overlord-mission/reference/record-work.md`.
