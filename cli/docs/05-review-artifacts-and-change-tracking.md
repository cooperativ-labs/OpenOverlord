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
- Delivery moves the mission to review.
- Delivery stores artifacts and change rationales as first-class records.
- Delivery is linked to the objective and, when work happened through an attached agent, the session. `record-work` deliveries may have no session.
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
- Local MVP can store files on disk under an Overlord-managed attachment directory.
- Future hosted mode can swap in signed upload/download URLs without changing command names.
- Soft-deleting attachment metadata should enqueue storage cleanup for the underlying bytes instead of deleting them inside the same database write.

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

## Mechanical Changed File Capture

Changed-file capture must not depend on the agent remembering to enumerate what it
changed. The client CLI captures changes from VCS automatically:

- When a work session begins (`attach`, `resume-follow-up`), the CLI records a **baseline** — the set of changed file paths from local `git status` for the working directory.
- At `deliver`, the CLI reads `git status` again and computes the **run-attributable delta** (current changed paths minus the baseline), then injects it as `--changed-files-json`. This subtracts files that were already dirty before the session started.
- **Exact attribution under concurrency**: when several missions run against one working tree, the baseline cannot tell sessions apart — a file another mission edits *after* this session attached has no baseline entry, so the delta alone would wrongly attribute it. To prevent this, a connector that ships a `PostToolUse` edit hook writes a per-session **touched-files log** (`<OVLD_HOME|~/.ovld>/vcs-touched/<sha256(abspath(cwd) + NUL + MISSION_ID)>.json`) recording the exact paths this agent edited. When that log exists, the run-attributable set is the **VCS delta intersected with the touched-files log**, so files this agent never touched are excluded even if they are dirty for unrelated reasons. The CLI clears the log at `attach`/`resume-follow-up` so each session starts from an empty edit set.
- Connectors without an edit hook write no touched-files log; the CLI then falls back to the baseline-delta alone (no intersection), so hookless agents behave exactly as before.
- **`.overlordignore`**: a repo may carry an optional `.overlordignore` file at its git root listing gitignore-style patterns for paths Overlord should never report as run-attributable changes (e.g. generated artifacts like `install-state.gz`). Blank lines and `#` comments are skipped; patterns support `!` negation (last match wins), leading-`/` anchoring to the repo root, trailing-`/` directory matches, and `*`/`**`/`?` globs. Matching paths are dropped at `deliver`/`update` after the baseline-delta and touched-files intersection, so ignored files never reach the changed-file payload.
- VCS is read **on the client only**; the CLI persists only metadata (normalized path and status), never full diffs, patch bodies, or file contents. The touched-files log likewise stores only normalized absolute paths.
- An agent that genuinely changed no files passes `--no-file-changes` at deliver to skip rationale-coverage enforcement. If the CLI still observes a non-empty delta, it warns.

## Update-Time Changed File Tracking

Agents may also make changed files visible before delivery without increasing protocol call volume:

- `ovld protocol update` may include changed-file tracking (`--changed-files-json` / `--changed-files-file`) in the same call already used for progress.
- The CLI persists only metadata such as normalized path, status, session, objective, and optional rationale fields.
- Full diffs, patch bodies, and file contents must not be persisted as update-time changed-file records.
- Each changed file should be stored once per session/objective/path and updated in place on later updates.
- Delivery coverage is objective-scoped: it should aggregate changed-file observations across all sessions for the objective and any no-session `record-work` records.
- Rationale fields can be added or revised over time, but delivery must still enforce complete rationales for meaningful tracked changes.
- A changed-file record can exist before a rationale exists; this lets live review show what is changing while the work is still in progress.
- If a file disappears from the current local diff, keep enough history to explain that it was observed earlier, but do not require final delivery coverage unless the final workspace state still contains a meaningful tracked change or a retained rationale should be reviewed.

## Local VCS Read And Current Changes Requirements

CLI-first requirements:

- Overlord may read VCS status and diffs for a linked project, but it must not create commits, refs, branches, stashes, checkpoints, tags, resets, checkouts, patches, or any other VCS mutation.
- Change views should be scoped around Overlord review units first: mission, objective, and delivery.
- `ovld changes status --mission-id <id> [--objective-id <id>]`: summarize changed files and rationale coverage for the mission or objective.
- `ovld changes diff --mission-id <id> [--objective-id <id>] [--path <path>]`: show read-only local VCS diffs grouped by objective context where possible.
- `ovld changes rationales --mission-id <id> [--objective-id <id>]`: show rationale coverage grouped by objective and file.
- `ovld protocol deliver` rejects delivery when run-attributable tracked changes lack rationales, unless `--no-file-changes` is passed; coverage is aggregated per objective across all sessions.
- Diffs should be annotated with recorded rationale labels and hunk headers when available.
- Changes that cannot be associated with a specific objective should be shown as unassigned/current workspace changes, not silently attached to the wrong objective.

Future web/desktop requirements are documented in [web-app.md](../../webapp/docs/web-app.md).

## Review Workflow Requirements

Humans should be able to review:

- Mission title/objective and acceptance criteria.
- Session progress updates.
- Blocking questions and answers.
- Delivery summary.
- Artifacts.
- Changed files and rationale coverage.
- Follow-up objectives.

CLI review commands can be added before UI:

- `ovld mission context <id>`
- `ovld mission events <id>`
- `ovld mission deliveries <id>`
- `ovld mission artifacts <id>`
- `ovld mission rationales <id>`

## Security And Data Boundaries

Requirements:

- Linking a repository must not automatically store repository contents.
- Reading local VCS state is allowed only for explicit status, diff, rationale coverage, delivery validation, or review views.
- Terminal output should only be persisted when a user or agent records it.
- Secrets should not be pasted into missions, artifacts, updates, or shared context.
- Attachments are explicit uploads/imports.
- Change rationales store descriptions and hunk headers, not necessarily full file contents.

## Acceptance Criteria

- A delivered mission can be reviewed without opening the original agent chat.
- Missing change rationales are detected before or during delivery.
- A later objective can read shared context written by an earlier objective.
- Artifacts and attachments are distinguishable.
