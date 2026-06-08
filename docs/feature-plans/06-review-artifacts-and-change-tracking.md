# Review, Artifacts, And Change Tracking

## Goal

Port the review record that makes Overlord useful after an agent finishes: delivery summaries, artifacts, shared context, and file-level change rationales.

## Delivery Review Requirements

A delivery should preserve:

- What was asked.
- What happened.
- What was delivered.
- What changed and why.
- What verification was run.
- What still needs follow-up.

Requirements:

- Delivery summary is a narrative, not a command log.
- Delivery moves the ticket to review.
- Delivery stores artifacts and change rationales as first-class records.
- Delivery is linked to the session and objective.
- Follow-up deliveries should not destroy previous delivery history.

## Artifact Requirements

Supported structured artifact types:

- `test_results`
- `next_steps`
- `note`
- `url`
- `decision`
- `migration`

Requirements:

- Artifacts are part of delivery payloads.
- Artifacts should have `type`, `label`, and `content`.
- Artifacts can be rendered by CLI now and web app later.
- Large files should use objective attachments instead of inline artifact content.

## Objective Attachment Requirements

Requirements:

- Attachments belong to a specific objective.
- Agents see active objective attachments in attach/load-context responses.
- CLI supports list, upload, and download/open commands.
- Local MVP can store files on disk under an OpenOverlord-managed attachment directory.
- Future hosted mode can swap in signed upload/download URLs without changing command names.

## Shared Context Requirements

Requirements:

- Store stable facts that future sessions need.
- Avoid using shared context as full transcript storage.
- Support small keys such as `repo.testing`, `deploy.target`, `arch`, or `env.secrets.path`.
- Support JSON values and strings.
- Support tags and filtered reads.

## Change Rationale Requirements

Each meaningful tracked file change should have a rationale:

```json
{
  "label": "Short reviewer title",
  "file_path": "path/to/file.ts",
  "summary": "What changed.",
  "why": "Why it changed.",
  "impact": "Behavioral impact.",
  "hunks": [{ "header": "@@ -10,6 +10,14 @@" }]
}
```

Rules:

- `file_path`, `label`, `summary`, `why`, and `impact` are required.
- `hunks` should be captured when available.
- Formatting-only noise can be skipped.
- Do not send `file_changes` as a generic artifact.
- Record rationales during `update`, via `record-change-rationales`, or during `deliver`.
- Delivery should validate rationale coverage unless explicitly skipped.

## Update-Time Changed File Tracking

Agents should be able to make changed files visible before delivery without increasing protocol call volume:

- `ovld protocol update` may include changed-file tracking in the same call already used for progress.
- The CLI may populate changed files from local VCS status, but it must persist only metadata such as normalized path, status, session, objective, and optional rationale fields.
- Full diffs, patch bodies, and file contents must not be persisted as update-time changed-file records.
- Each changed file should be stored once per session/objective/path and updated in place on later updates.
- Rationale fields can be added or revised over time, but delivery must still enforce complete rationales for meaningful tracked changes.
- A changed-file record can exist before a rationale exists; this lets live review show what is changing while the work is still in progress.
- If a file disappears from the current local diff, keep enough history to explain that it was observed earlier, but do not require final delivery coverage unless the final workspace state still contains a meaningful tracked change or a retained rationale should be reviewed.

## Local VCS Read And Current Changes Requirements

CLI-first requirements:

- Overlord may read VCS status and diffs for a linked project, but it must not create commits, refs, branches, stashes, checkpoints, tags, resets, checkouts, patches, or any other VCS mutation.
- Change views should be scoped around Overlord review units first: ticket, objective, and delivery.
- `ovld changes status --ticket-id <id> [--objective-id <id>]`: summarize changed files and rationale coverage for the ticket or objective.
- `ovld changes diff --ticket-id <id> [--objective-id <id>] [--path <path>]`: show read-only local VCS diffs grouped by objective context where possible.
- `ovld changes rationales --ticket-id <id> [--objective-id <id>]`: show rationale coverage grouped by objective and file.
- `ovld protocol deliver` should warn when tracked changes lack rationales.
- Diffs should be annotated with recorded rationale labels and hunk headers when available.
- Changes that cannot be associated with a specific objective should be shown as unassigned/current workspace changes, not silently attached to the wrong objective.

Future web/desktop requirements are documented in [web-app.md](web-app.md).

## Review Workflow Requirements

Humans should be able to review:

- Ticket title/objective and acceptance criteria.
- Session progress updates.
- Blocking questions and answers.
- Delivery summary.
- Artifacts.
- Changed files and rationale coverage.
- Follow-up objectives.

CLI review commands can be added before UI:

- `ovld ticket context <id>`
- `ovld ticket events <id>`
- `ovld ticket deliveries <id>`
- `ovld ticket artifacts <id>`
- `ovld ticket rationales <id>`

## Security And Data Boundaries

Requirements:

- Linking a repository must not automatically store repository contents.
- Reading local VCS state is allowed only for explicit status, diff, rationale coverage, delivery validation, or review views.
- Terminal output should only be persisted when a user or agent records it.
- Secrets should not be pasted into tickets, artifacts, updates, or shared context.
- Attachments are explicit uploads/imports.
- Change rationales store descriptions and hunk headers, not necessarily full file contents.

## Acceptance Criteria

- A delivered ticket can be reviewed without opening the original agent chat.
- Missing change rationales are detected before or during delivery.
- A later objective can read shared context written by an earlier objective.
- Artifacts and attachments are distinguishable.
