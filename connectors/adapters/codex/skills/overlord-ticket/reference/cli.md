# CLI Command Reference

## Attach

```bash
ovld protocol attach --ticket-id $TICKET_ID
```

In a git workspace, `attach` automatically creates a local git checkpoint for each executing objective before work begins, stored under `refs/overlord/checkpoints/<objectiveId>`. Pass `--skip-checkpoint` only when intentionally bypassing local provenance.

## Update

```bash
ovld protocol update --session-key <sessionKey> --ticket-id $TICKET_ID --summary "What you did and why." --phase execute
```

## Heartbeat

```bash
ovld protocol heartbeat --session-key <sessionKey> --ticket-id $TICKET_ID --phase execute --percent 40 --note "Running the integration suite"
```

Use `heartbeat` for liveness pings and transient UI telemetry when you have no meaningful narrative summary to post. It updates the attached session without creating a ticket event.

Supported `--phase` values:

- `draft`
- `execute`
- `review`
- `deliver`
- `complete`
- `blocked`
- `cancelled`

These are hardcoded CLI-supported values for the `--phase` flag. They are not user-defined phase types.

Event types:

- `update` for standard progress updates
- `user_follow_up` — only when the `UserPromptSubmit` hook is unavailable; the hook normally posts follow-ups to the activity feed
- `alert` for warnings or non-blocking issues
- `discussion_summary` for important discussion outcomes that should remain visible on the ticket
- `decision` for explicit non-file decisions made during follow-up discussion

- Post-delivery follow-up modes:

- User follow-up messages default to `discussion` intent while the ticket is in review.
- Use `ovld protocol resume-follow-up --ticket-id $TICKET_ID --summary "Beginning follow-up work."` when post-delivery implementation starts after the original session has ended or its key is unavailable.
- Use `ovld protocol update --begin-follow-up-work --follow-up-intent execution --summary "Beginning follow-up work."` before moving a delivered/review ticket back to execution.
- Use `--follow-up-intent pending_delivery` when implementation is complete but final delivery is still being prepared.

## Ask

```bash
ovld protocol ask --session-key <sessionKey> --ticket-id $TICKET_ID --question "Specific question for the PM."
```

## Deliver

```bash
ovld protocol deliver --session-key <sessionKey> \
  --ticket-id $TICKET_ID \
  --summary "Narrative: what you did, next steps." \
  --artifacts-json '[{"type":"next_steps","label":"Next steps","content":"..."}]' \
  --change-rationales-json '[{"label":"Short reviewer title","file_path":"path/to/file.ts","summary":"What changed.","why":"Why it changed.","impact":"Behavioral impact.","hunks":[{"header":"@@ -10,6 +10,14 @@"}]}]'
```

Use `--payload-json` when the full delivery object fits comfortably inline (roughly under 8 KB). Larger inline `--*-json` values are **rejected** — use `--payload-file -`, `--change-rationales-file -`, or `--artifacts-file -` and stream JSON on stdin so no scratch file needs to be created or removed. If you use `--payload-file`, `--artifacts-file`, or `--change-rationales-file` with a real path, treat that file as ephemeral scratch data under `.overlord/tmp` and remove it after delivery.

When delivery includes many change rationales, keep `--summary` inline and pipe rationales on stdin:

```bash
ovld protocol deliver --session-key <sessionKey> --ticket-id $TICKET_ID \
  --summary "Narrative: what you did and next steps." \
  --change-rationales-file - <<'EOF'
[
  {"label":"Add backoff","file_path":"lib/api.ts","summary":"Added retry.","why":"Transient failures.","impact":"Retries 3x."}
]
EOF
```

If `heartbeat` succeeds but `deliver` or `update` fails, the session is likely fine — retry with large JSON on stdin instead of inline `--*-json`.

Changed files are captured for you: the CLI records a VCS baseline at attach and, at deliver, reports the run-attributable delta (current `git status` minus baseline) automatically — you do not pass `--changed-files-json`. Include `changeRationales` only for meaningful file changes made as part of this ticket. Do not include other tracked worktree changes in the delivery report, payload, artifacts, or `changeRationales`, even to label them as pre-existing, concurrent, or unrelated. If `deliver` rejects with a `missing_rationale` error for a file you did not change for this ticket, do not add a rationale for that file; investigate attribution, send a progress update if needed, and resolve the delivery input so only this ticket's changes are reported. Coverage is aggregated per objective. If the run changed no files, declare it explicitly:

```bash
ovld protocol deliver --session-key <sessionKey> --ticket-id $TICKET_ID \
  --summary "Investigated X; no code changes were required." --no-file-changes
```

Ordinary deliver artifacts should use `next_steps`, `test_results`, `migration`, `note`, `url`, or `decision`.

## Revert

```bash
ovld protocol revert --objective-id <objective-id>
```

`revert` restores the local working tree to the recorded objective state.

## Record Change Rationales

These are structured protocol payloads that Overlord stores as first-class rows in the `file_changes` table. Inline `--change-rationales-json` is fine for a few entries; larger arrays are **rejected** — use `--change-rationales-file -` and stream JSON on stdin. The same ~8 KB inline limit applies to `--payload-json` and other `--*-json` flags.

**Required fields per entry:** `file_path`, `label`, `summary`, `why`, `impact` (all strings). Do not use `filePath` or `rationale` — those are the internal API shape and will fail CLI validation.

```bash
ovld protocol record-change-rationales --session-key <sessionKey> --ticket-id $TICKET_ID \
  --summary "Recorded rationale details for the latest code changes." --phase execute \
  --change-rationales-json '[{"label":"Add backoff","file_path":"lib/api.ts","summary":"Added retry.","why":"Transient failures.","impact":"Retries 3x.","hunks":[{"header":"@@ -22,4 +22,18 @@"}]}]'
```

```bash
ovld protocol update --session-key <sessionKey> --ticket-id $TICKET_ID \
  --summary "Added retry logic." --phase execute \
  --change-rationales-json '[{"label":"Add backoff","file_path":"lib/api.ts","summary":"Added retry.","why":"Transient failures.","impact":"Retries 3x.","hunks":[{"header":"@@ -22,4 +22,18 @@"}]}]'
```

For many entries (roughly 5+), pipe via stdin to avoid shell quoting failures:

```bash
ovld protocol record-change-rationales --session-key <sessionKey> --ticket-id $TICKET_ID \
  --summary "Recorded rationale details for the latest code changes." --phase execute \
  --change-rationales-file - <<'EOF'
[
  {"label":"Add backoff","file_path":"lib/api.ts","summary":"Added retry.","why":"Transient failures.","impact":"Retries 3x."},
  {"label":"Update config","file_path":"lib/config.ts","summary":"Added timeout.","why":"Match new defaults.","impact":"Requests time out after 30s."}
]
EOF
```

## Project Discovery And Ticket Creation

When creating tickets from within a repository:

- Prefer `create` by default for draft ticket creation.
- Use `prompt` only when the user explicitly asks to start execution immediately.
- Both commands can resolve the project from the current working directory; use `--working-directory` to override or `--project-id` to be explicit.
- Follow-up `create` calls under an active session inherit the current ticket's project by default, but `--project-id` can override that when the follow-up belongs in a different project.
- Create multiple tickets when each prompt represents a different feature or goal.
- Add objectives to the same ticket when each prompt is a sequential step toward the same feature or goal; use `ovld protocol add-objectives --ticket-id <ticket_id> --objectives-json '[{"objective":"..."}]'`.
- `create`, `prompt`, and `record-work` require `--objectives-json` or `--objectives-file` with an ordered array of `{ "objective": "...", "title": "...", "autoAdvance": true }` objects. A single objective is just an array with one item.
- `create`, `prompt`, `create-ticket`, and `record-work` accept `--assigned-to <member>` to set the ticket's human owner. Accepts a username, an email, a user-id UUID, or the `orgid:username` member ID. When omitted, the assignee defaults to the ticket creator.

```bash
ovld protocol create --agent <agent-identifier> --objectives-json '[{"objective":"Capture follow-up work from this repository"}]'
```

```bash
ovld protocol prompt --agent <agent-identifier> --objectives-json '[{"objective":"Implement feature X"}]' --priority medium
```

```bash
ovld protocol add-objectives --ticket-id 1:899 --objectives-json '[{"objective":"Implement the API"},{"objective":"Add CLI docs"}]'
```

### Local Durability For New Tickets

`create`, `prompt`, `add-objectives`, and `record-work` save the objective/ticket text to a local draft (`~/.overlord/pending-tickets/`) **before** sending it, and delete that draft only once the server confirms the write. If the network drops mid-call, your text is never lost — the failure message points at the saved file. Manage outstanding drafts with `pending-tickets`:

```bash
ovld protocol pending-tickets               # list drafts the server never confirmed
ovld protocol pending-tickets --retry <id>  # re-send a saved draft; clears it on success
ovld protocol pending-tickets --clear <id>  # delete one draft after confirming it landed
ovld protocol pending-tickets --clear-all   # delete every draft
```

To inspect project resolution explicitly:

```bash
ovld protocol discover-project
ovld protocol discover-project --project-id <id-or-name>
ovld protocol discover-project --project-id "My Project"
ovld protocol discover-project --working-directory /path/to/repo
```

Use `--project-id` when the project ID or name is already known (names are unique per organization, matched case-insensitively). Use `--working-directory` to override cwd path matching. If the runtime has an `OVERLORD_DEVICE_FINGERPRINT`, pass `--device-fingerprint "$OVERLORD_DEVICE_FINGERPRINT"` so resource-directory matching prefers the current device.

## Creating Projects

Users and agents can create a project directly from the CLI. By default the current
working directory is registered as the new project's primary resource in the same
call (one-step setup); pass `--no-directory` to create a bare project.

```bash
# Create a project and link the current directory in one step
ovld protocol create-project --name "Acme Web"

# Link a specific directory
ovld protocol create-project --name "Acme Web" --directory /path/to/repo

# Create a bare project with no directory
ovld protocol create-project --name "Acme Web" --no-directory
```

`ovld create-project` is a friendly top-level alias for `ovld protocol create-project`.
When a directory is registered the command also writes `.overlord/project.json` so
future cwd-based resolution finds the project. Pass `--organization-id <id>` to create
in a specific organization (defaults to your membership); `--color <#rrggbb>` sets the
project color.

### Resolving the project ID when you don't have one

When you need a project ID for a protocol command and the ticket prompt did not supply one, resolve it in this order.

**Locally (CLI inside a shell on the user's machine):**

1. `--project-id` if explicitly provided.
2. Otherwise, let the CLI match the current working directory (the default behavior of `create`, `prompt`, `discover-project`).
3. If working-directory resolution returns nothing, read `.overlord/project.json` from the cwd (or any ancestor you have access to) and pass its project id via `--project-id`.

**Over MCP (web agents and hosted tools, where the server cannot see the agent's cwd):**

1. `projectId` (hosted MCP) or `project_id` (local shim) if explicitly provided or found in the ticket/context.
2. Read `.overlord/project.json` from the directory the user is accessing and pass its project id as `projectId` / `project_id`.
3. As a last resort, try `workingDirectory` / `working_directory` resolution. If a device fingerprint is available, include `deviceFingerprint` / `device_fingerprint`.

If `.overlord/project.json` contains more than one project, show the user the project **names** from that file and ask which one to use before calling any protocol command — never silently pick one.
