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

### Mission Creation And Discovery

Requirements:

- `create`: create a draft mission/objective without attaching.
- `prompt`: create a mission and attach or queue execution immediately.
- `load-context`: read mission context without creating a session.
- `connect`: create a lightweight session key without full context.
- `search-missions`: search by query, status, project, creator, and update dates.
- `discuss-objective`: mark a draft objective submitted.
- `add-objectives`: append ordered objectives to a mission.
- `record-work`: record already-completed chat work as a review mission with completed objective and delivery record.

### Session Lifecycle

Requirements:

- `attach`: start the working session and return full context.
- `update`: post progress, discussion/decision events, optional change rationales, and follow-up execution transitions.
- `heartbeat`: update liveness and transient telemetry without creating a mission event.
- `ask`: post a blocking question and stop work.
- `deliver`: finish work, store artifacts/rationales, mark objective complete, and move mission to review.
- `hook-event`: record connector lifecycle events such as `UserPromptSubmit` and future `Stop`. `UserPromptSubmit` records follow-up user activity without requiring a live session and without reopening execution.
- `resume-follow-up`: explicitly reopen a completed objective for post-delivery implementation follow-up, returning a new session key.
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

### Runner, Device, And Project Resource Management

Runner queue/device/project-resource operations are not part of the agent
protocol. They are management surfaces:

- `ovld runner once|start|status|clear|clear-all` uses `/api/runner/*` REST
  endpoints to claim and update execution requests.
- `ovld create-project` and `ovld add-cwd` use project REST endpoints to create
  projects and register checkout paths.

Agents should treat objective execution as: attach to a mission, report progress,
ask when blocked, and deliver. They should not claim queue work through
`ovld protocol`.

## Attach Response Requirements

`attach`, `connect`, and `prompt` should accept optional native session
attribution with `external-session-id`. When the flag is omitted, the CLI may
auto-detect known agent session IDs from harness environment variables or
connector hook caches and store the result in `agent_sessions.external_session_id`.
Runner-launched agents may also carry `OVERLORD_EXECUTION_REQUEST_ID`; the CLI
forwards it as `--execution-request-id` during `attach` so the backend can link
`execution_requests.launched_session_id` to the created session.

`attach` must return:

- Mission metadata.
- Current objective metadata, including objective ID and instruction text.
- All objective IDs and states in order.
- Session object with `sessionKey`.
- History/events relevant to the mission.
- Artifacts.
- Attachments visible to the active objective.
- Shared context.
- Assembled `promptContext`.
- Pending objective information when relevant.

The assembled prompt context should include:

- Task title.
- Mission ID.
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
- `mission-id`
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

Post-delivery discussion vs execution:

- Connector `UserPromptSubmit` hooks should call `hook-event` for ordinary user
  follow-up messages. This appends `user_follow_up` activity and does not change
  objective state.
- When the user explicitly asks for more implementation after delivery, agents
  should call `resume-follow-up` to create a new live session and transition the
  completed objective to `pending_delivery`.
- A bare `attach` must not silently reopen a completed objective.
- `resume-follow-up` reuses the existing completed objective rather than adding
  a new objective when the user is asking for a correction or update to the
  delivered work.

Changed-file tracking requirements:

- Changed-file capture is mechanical, not agent-enumerated. The client CLI records a VCS baseline (changed file paths from local `git status`) for the working directory when a work session begins (`attach`, and `resume-follow-up`), and at `deliver` computes the run-attributable delta — the paths changed now minus the baseline — and sends them as changed files. Agents do not have to manually list what they changed.
- VCS is read on the client only. The CLI sends normalized file paths/statuses (never full diffs or file contents); the backend persists what the client sends.
- Capture is best-effort: outside a git repository, or when git is unavailable, no changed files are inferred and delivery proceeds on whatever the agent recorded explicitly.
- `update` may still carry explicit changed-file metadata (`--changed-files-json` / `--changed-files-file`) during normal progress updates, without requiring extra agent calls.
- Agents may include rationale fields for changed files in the same update payload when useful, but incomplete rationales are allowed before delivery.
- Changed files are upserted by session, objective, and normalized file path so repeated updates revise the same file record instead of creating duplicates.
- Changed-file records should distinguish mechanically observed file changes from agent-authored rationales.
- Files that can no longer be observed in the local diff should not be silently deleted from history; they should be marked resolved/no-current-diff or excluded from final coverage according to review rules.

> Concurrency note: the runner resolves all executions for a project to the same
> working directory, so a raw whole-tree `git status` cannot attribute a change to
> one run. The baseline-at-attach / delta-at-deliver approach subtracts files that
> were already dirty when the session began. Exact per-run attribution under
> concurrency requires per-run worktree isolation (a separate runner change).

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
- `changed-files-json` / `changed-files-file` (normally auto-injected by the CLI from the run-attributable VCS delta)
- `no-file-changes` (assert this run changed no files; skips rationale-coverage enforcement)
- `skip-rationale-for-json` / `skip-rationale-for-file` (per-file rationale overrides for changes the agent did not make)
- `payload-json`
- `payload-file`
- optional file-change coverage checks

Delivery rules:

- Every meaningful tracked file change should have a rationale.
- Do not store generic `file_changes` artifacts as a substitute for structured rationales.
- Delivery validates rationale coverage against the changed-file records for the objective (aggregated across all sessions and no-session `record-work` records). The client supplies the current run's changed files from local VCS; the agent can pass `--no-file-changes` to declare the run made no file changes, or `--skip-rationale-for-json` / `--skip-rationale-for-file` to override rationale requirements for specific paths the agent did not change (each entry requires `file_path` and `reason`).
- Delivery is the final review boundary, but it should not be the first time Overlord learns which files changed during the session.
- Delivery moves the active objective to `complete`.
- Delivery moves the mission to review unless another explicit status is requested later.
- Delivery may trigger auto-advance for the next objective.
- After delivery, implementation work must not continue until follow-up execution is explicitly started.

## Record-Work Requirements

`record-work` exists for work already completed in the current chat without an attached session.

Requirements:

- Create a mission directly in review.
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
