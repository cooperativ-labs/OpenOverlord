# Review, Artifacts, And Change Tracking

## Goal

Port the review record that makes Overlord useful after an agent finishes: delivery summaries, artifacts, shared context, checkpoints, and file-level change rationales.

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

## Checkpoint Requirements

Checkpoints anchor file-change review to local Git state.

Requirements:

- On attach, create an objective-start checkpoint when the working directory is a Git repository with a valid `HEAD`.
- Store checkpoint metadata with objective/session, not as a schema design here.
- Support checkpoint kinds: `objective`, `delivery`, and `manual`.
- Capture head SHA, hidden ref name when created, summary, and optional diff stat.
- Allow attach to proceed with a clear warning when checkpoint creation is impossible, such as a repository with no initial commit.
- Support `--skip-checkpoint`.
- Support `revert` later by restoring from an objective checkpoint with a safety snapshot first.

MVP note:

- Repositories without an initial commit cannot create Git checkpoints. The CLI should explain that and continue when `--skip-checkpoint` is passed.

## Local Diff And Current Changes Requirements

CLI-first requirements:

- `ovld changes status`: summarize changed files for the linked project.
- `ovld changes diff [path]`: show local diffs.
- `ovld changes rationales --ticket-id <id>`: show rationale coverage by file.
- `ovld protocol deliver` should warn when tracked changes lack rationales.

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
- Terminal output should only be persisted when a user or agent records it.
- Secrets should not be pasted into tickets, artifacts, updates, or shared context.
- Attachments are explicit uploads/imports.
- Change rationales store descriptions and hunk headers, not necessarily full file contents.

## Acceptance Criteria

- A delivered ticket can be reviewed without opening the original agent chat.
- Missing change rationales are detected before or during delivery.
- A later objective can read shared context written by an earlier objective.
- Artifacts and attachments are distinguishable.
- Checkpoint failure in a no-commit repository does not block work when skipped intentionally.
