# Agent Protocol

## Goal

Port the `ovld protocol` lifecycle so every agent interacts with Overlord through one stable contract, regardless of connector or UI.

## Design Requirements

- Protocol commands are the authoritative agent interface.
- The same operation should be callable from the CLI, future web API, and future MCP surface.
- Drift between surfaces should be treated as a bug.
- Agents must attach first and deliver last.
- Protocol commands must be safe to call from shell hooks and agent runtimes.
- Protocol commands must handle special characters via `--summary-file -`, `--question-file -`, and `--payload-file -`.

## Required Protocol Commands

### Auth And Project Resolution

For MVP, auth commands can be local no-ops or diagnostics, but command names should be reserved for compatibility.

Requirements:

- `auth-status`: report local runtime readiness and whether an interactive local identity or `USER_TOKEN` is being used, without printing token secrets.
- `discover-project`: resolve project from current working directory, explicit directory, or project identifier.
- `list-organizations`: deferred until multi-user/multi-org support; can return the local instance workspace in MVP.

`USER_TOKEN` authentication is a modular expansion feature. When enabled, protocol requests may authenticate with a user-owned token that initially confers all permissions of the creating user. Future token scopes should restrict that user's permissions rather than grant additional access.

### Ticket Creation And Discovery

Requirements:

- `create`: create a draft ticket/objective without attaching.
- `prompt`: create a ticket and attach or queue execution immediately.
- `load-context`: read ticket context without creating a session.
- `connect`: create a lightweight session key without full context.
- `search-tickets`: search by query, status, project, creator, and update dates.
- `discuss-objective`: mark a draft objective submitted.
- `add-objectives`: append ordered objectives to a ticket.
- `record-work`: record already-completed chat work as a review ticket with completed objective and delivery record.

### Session Lifecycle

Requirements:

- `attach`: start the working session and return full context.
- `update`: post progress, discussion/decision events, optional change rationales, and follow-up execution transitions.
- `heartbeat`: update liveness and transient telemetry without creating a ticket event.
- `ask`: post a blocking question and stop work.
- `deliver`: finish work, store artifacts/rationales, mark objective complete, and move ticket to review.
- `hook-event`: record connector lifecycle events such as `UserPromptSubmit` and future `Stop`.
- `permission-request`: record that an agent asked for tool permission.

### Shared Context And Attachments

Requirements:

- `read-context`: read persistent shared context.
- `write-context`: write persistent shared context.
- `attachment-list`: list visible objective attachments.
- `attachment-prepare-upload`: prepare an attachment upload.
- `attachment-finalize-upload`: finalize an uploaded attachment.
- `attachment-download-url`: get a download URL or local file path reference.
- `attachment-upload-file`: one-command local attachment upload.

For the SQLite/local MVP, attachments can use local file storage instead of signed URLs, but keep the command contract compatible.

### Runner And Device Protocol

Requirements:

- `get-device`: identify/register the local device.
- `update-device`: rename the local device label.
- `request-execution`: queue an objective for runner execution.
- `claim-execution`: runner claims a queued execution request.
- `list-execution-requests`: inspect active runner queue.
- `clear-execution-requests`: clear queued/claimed/launching requests.
- `complete-execution-launch`: mark a runner launch successful.
- `fail-execution-launch`: mark a runner launch failed.
- `list-execution-targets`: can be local-only in MVP; remote target details deferred.

### Project Resource Protocol

Requirements:

- `create-project`
- `list-project-resources`
- `add-project-resource`
- `update-project-resource`

Delete operations can be added once project/resource lifecycle semantics are settled.

## Attach Response Requirements

`attach`, `connect`, and `prompt` should accept optional native session
attribution with `external-session-id`. When the flag is omitted, the CLI may
auto-detect known agent session IDs from harness environment variables or
connector hook caches and store the result in `agent_sessions.external_session_id`.

`attach` must return:

- Ticket metadata.
- Current objective metadata, including objective ID and instruction text.
- All objective IDs and states in order.
- Session object with `sessionKey`.
- History/events relevant to the ticket.
- Artifacts.
- Attachments visible to the active objective.
- Shared context.
- Assembled `promptContext`.
- Pending objective information when relevant.

The assembled prompt context should include:

- Task title.
- Ticket ID.
- Objective ID.
- Project identifier/name.
- Objective instruction.
- Constraints.
- Acceptance criteria.
- Available tools.
- Output format.
- Recent activity/history.
- Attachments.
- Artifacts.
- Shared context.
- Required protocol workflow instructions.

## Update Requirements

`update` fields:

- `session-key`
- `ticket-id`
- `summary` or `summary-file`
- `phase`
- `event-type`
- `payload-json`
- `external-url`
- `external-session-id`
- `begin-follow-up-work`
- `follow-up-intent`
- `track-changed-files`
- `changed-files-json` or `changed-files-file`
- `change-rationales-json` or `change-rationales-file`

Changed-file tracking requirements:

- `update` should support posting changed-file metadata during normal progress updates, without requiring extra agent calls.
- The CLI should be able to read local VCS status when `track-changed-files` is set and include only changed file paths/statuses, not full diffs or file contents.
- Agents may include rationale fields for changed files in the same update payload when useful, but incomplete rationales are allowed before delivery.
- Changed files should be upserted by session, objective, and normalized file path so repeated updates revise the same file record instead of creating duplicates.
- Changed-file records should distinguish mechanically observed file changes from agent-authored rationales.
- Files that can no longer be observed in the local diff should not be silently deleted from history; they should be marked resolved/no-current-diff or excluded from final coverage according to review rules.

Supported phases:

- `draft`
- `execute`
- `review`
- `deliver`
- `complete`
- `blocked`
- `cancelled`

Supported event types:

- `update`
- `user_follow_up`
- `alert`
- `discussion_summary`
- `decision`

## Delivery Requirements

`deliver` must support:

- `summary`
- `artifacts`
- `changeRationales`
- `payload-json`
- `payload-file`
- optional file-change coverage checks

Delivery rules:

- Every meaningful tracked file change should have a rationale.
- Do not store generic `file_changes` artifacts as a substitute for structured rationales.
- Delivery should validate final rationale coverage against current changed-file records and local VCS status when available.
- Delivery is the final review boundary, but it should not be the first time Overlord learns which files changed during the session.
- Delivery moves the active objective to `complete`.
- Delivery moves the ticket to review unless another explicit status is requested later.
- Delivery may trigger auto-advance for the next objective.
- After delivery, implementation work must not continue until follow-up execution is explicitly started.

## Record-Work Requirements

`record-work` exists for work already completed in the current chat without an attached session.

Requirements:

- Create a ticket directly in review.
- Create a completed objective.
- Store a delivery summary.
- Store artifacts and change rationales if provided.
- Store delivery and changed-file records without requiring an `agent_sessions` row; session attribution is null for `record-work`.
- Do not use it for in-progress work.

## Acceptance Criteria

- Agents can complete the full lifecycle using only `ovld protocol`.
- `attach` gives enough context for a new agent session to continue work without reading prior chat.
- Follow-up messages from hooks are preserved as events.
- Delivery with missing required rationale fields fails with a useful error.
- Protocol payloads can be sent via stdin to avoid shell quoting failures.
- Local MVP command names remain compatible with future HTTP/MCP surfaces.
