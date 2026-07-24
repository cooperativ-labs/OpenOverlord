# Recording Completed Work (`record-work`)

Use `record-work` to log work that is **already finished** — for example, something you
just built for the user in a chat app — as a completed Overlord mission. It is the
after-the-fact equivalent of `create` + `attach` + `deliver`, collapsed into one call:

1. Creates a mission with a **single completed objective** matching the work done.
2. Records each file change with its rationale.
3. Lands the mission in the **review** column.
4. Runs the delivery through the **standard Gemini delivery summarizer**, so the result
   reads like any other delivered (in-review) mission.

There is **no agent session** — do not `attach`. Do not use this for in-progress work
(use `create`/`prompt` for that).

## Submission format (authoritative)

Submit **one JSON envelope** on stdin. This is the efficient, quoting-safe path and is
identical across the CLI (`--payload-file -`) and the hosted MCP tool
(`overlord_record_work`).

```jsonc
{
  "objective": "What was asked and what you did, phrased as a completed objective (1–3 sentences).",
  "summary": "Reviewer-facing narrative of what changed and why. This is what the PM reads first.",
  "title": "Optional mission title; defaults to a title derived from the objective.",
  "changeRationales": [
    {
      "file_path": "src/widget.ts",   // repository-relative path
      "label": "Add widget",          // short reviewer title
      "summary": "New widget module.", // what changed in this file
      "why": "User asked for a widget.", // why it changed
      "impact": "Widget now renders on the dashboard." // behavioral impact
    }
  ],
  "changedFiles": [
    { "filePath": "src/generated.ts", "vcsStatus": "M" } // optional; touched files without a rationale
  ],
  "artifacts": [
    { "type": "next_steps", "label": "Next steps", "content": "…" } // optional
  ]
}
```

### Field rules

- **`objective`** (required) — the completed objective text. May also be passed as
  `--objective`/positional on the CLI; a flag always wins over the envelope.
- **`summary`** (required) — narrative, not a command list.
- **`title`** (optional) — omit to derive from the objective.
- **`changeRationales`** (one per meaningful file change) — same shape as `deliver`. All
  five string fields (`file_path`, `label`, `summary`, `why`, `impact`) are required per
  entry. `filePath` (camelCase) is accepted as an alias for `file_path`. Do **not** wrap
  entries under a `rationale` key. Skip formatting-only noise.
  - Every rationale's `file_path` is automatically recorded as a **changed file** and
    shows as **covered** in the review file panel — you do not list it twice.
- **`changedFiles`** (optional) — additional touched files you are *not* writing a full
  rationale for. They appear as **missing_rationale** in review, exactly like a live
  delivery. Uses `filePath` (camelCase) + optional `vcsStatus`.
- **`artifacts`** (optional) — `next_steps`, `test_results`, `migration`, `note`, `url`,
  or `decision`.
- **`deliveryReport`** (optional) — you may include a `deliveryReport.agentReport`
  (`humanActions`, `tradeoffsMade`, `knownRisks`, `deferredWork`, `assumptions`) just as
  in `deliver`. It improves review visibility but never blocks the record.

Enumerate changed files from `git status` / `git diff` before writing rationales.

## CLI

Stream the envelope on stdin with a single-quoted heredoc (safe for backticks/`$vars`):

```bash
ovld protocol record-work --payload-file - <<'EOF'
{
  "objective": "Add a CSV export button to the reports page.",
  "summary": "Added a CSV export control and the serializer behind it.",
  "changeRationales": [
    { "file_path": "src/reports/export.ts", "label": "CSV serializer",
      "summary": "New CSV serializer.", "why": "Users need offline reports.",
      "impact": "Reports can be exported as CSV." }
  ]
}
EOF
```

- Project resolution: matches the current directory to a project resource. Pass
  `--project-id <id-or-name>` when running outside a linked checkout or to be explicit.
- The command prints the new mission (and `MISSION_ID`); report it back to the user.
- Inline `--*-json` flags are capped (~8 KB) — prefer `--payload-file -` on stdin.

## Hosted MCP

Call `overlord_record_work` with the same fields as first-class arguments
(`projectId` **required** — hosted MCP never chooses a project implicitly):

```jsonc
{
  "projectId": "acme-web",
  "objective": "Add a CSV export button to the reports page.",
  "summary": "Added a CSV export control and the serializer behind it.",
  "changeRationales": [
    { "filePath": "src/reports/export.ts", "label": "CSV serializer",
      "summary": "New CSV serializer.", "why": "Users need offline reports.",
      "impact": "Reports can be exported as CSV." }
  ]
}
```

The tool returns the created review-column mission and the `deliveryId` whose Gemini
summary is composing asynchronously.
