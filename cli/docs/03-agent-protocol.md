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
`attach` and `load-context` also accept optional `executionTargetId`; the CLI
uses it when it knows the local execution target so context assembly can resolve
project resource paths for that target. This is additive and may be omitted.

`attach` must return:

- Mission metadata.
- Current objective metadata, including objective ID, instruction text, and
  optional `resourceKey`.
- All objective IDs, states, and optional `resourceKey` values in order.
- Session object with `sessionKey`.
- History/events relevant to the mission.
- Artifacts.
- Attachments visible to the active objective.
- Shared context.
- `projectResources` when available: the project's logical resources resolved
  for the relevant execution target.
- Concise `agentInstructions` with workflow guidance and pointers to structured fields.
- Pending objective information when relevant.

`projectResources` entries have this shape:

```ts
{
  resourceKey: string;
  label: string | null;
  isPrimary: boolean;
  isCurrent: boolean;
  path: string | null;
  state: string;
}
```

`path` is absolute on the session's execution target when known, and null when
the target is unknown or has no row for that logical resource. `state` mirrors
the latest target resource observation for that row, or `unknown`.

The agent instructions should include:

- Mission ID.
- Objective ID.
- Objective title or fallback label.
- Project identifier/name.
- Where to find the objective body and related context in the structured JSON.
- Required protocol workflow instructions.
- A `Project Resources` section when the project spans multiple logical
  resources. It identifies the current resource and sibling resources available
  on the same execution target, and instructs agents to treat siblings as
  read-only context unless a future objective launches in that resource.

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

> Concurrency note: the baseline-at-attach / delta-at-deliver approach subtracts
> files that were already dirty when the session began. Worktree isolation and
> objective resource binding improve attribution for launched sessions, but agents
> must still avoid editing sibling resources exposed only for context because those
> paths are outside the session's resolved working directory.

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
- `changed-files-json` / `changed-files-file` (normally auto-injected by the CLI from the run-attributable VCS delta; each entry may carry an optional `attribution` of `mine`/`claimed`/`unclaimed` and `claimedByMissionIds`, computed client-side and never persisted — used only to enrich a `missing_rationale` error)
- `observed-dirty-paths-json` (optional; the full current dirty worktree, auto-injected by the CLI — see **Server-Side Reconciliation** below)
- `no-file-changes` (assert this run changed no files; skips rationale-coverage enforcement)
- `skip-rationale-for-json` / `skip-rationale-for-file` (per-file rationale overrides for changes the agent did not make)
- `payload-json`
- `payload-file`
- `payload-json.deliveryReport` / `payload-file.deliveryReport` (optional versioned agent evidence)
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
- `payload-json` / `payload-file` may include `deliveryReport: { schemaVersion: 1, agentReport }`.
  `agentReport` accepts `humanActions`, `tradeoffsMade`, `knownRisks`, `deferredWork`,
  and `assumptions`; each missing array becomes `[]`. Human actions are for concrete
  work outside the agent's completed changes and must never include Git actions or
  routine review/testing. The protocol stores a deterministic presentation immediately;
  delivery does not wait for an AI provider.

### Server-Side Reconciliation And Self-Servicing Errors

- `deliver` accepts an optional `observedDirtyPaths` (every path the client currently observes as dirty — the full worktree, not just the run-attributable delta). When present, `changed_files` rows for the objective that are `present` but whose path is absent from `observedDirtyPaths` are reconciled to `current_diff_state = 'resolved'` before rationale coverage is computed. This un-poisons coverage from a past over-attribution (e.g. a file recorded while an edit hook was inert and never dirty again) instead of permanently demanding a rationale for it. Omitting the field skips reconciliation (older clients behave exactly as before).
- A `resolved` row is excluded from rationale-coverage enforcement and is reported in review as coverage state `resolved`, distinct from `covered`, `missing_rationale`, `skipped`, and `unassigned`.
- A `missing_rationale` failure carries a structured `details.missingRationales` array, one entry per outstanding path: `{ filePath, classification: 'mine' | 'claimed' | 'unclaimed', suggestedSkip: { filePath, reason } | null }`. `suggestedSkip` is `null` for `'mine'` (a real rationale is owed, not a skip) and a ready-to-use `--skip-rationale-for-json` entry otherwise, so a rejected `deliver` needs exactly one mechanical retry instead of an investigation. Classification comes from the `attribution` the client attached to each `changed-files-json` entry.
- `ovld protocol changes --mission-id <id>` is a local-only, read-only preflight (no backend call) that prints this same mine/claimed/unclaimed classification plus draft rationales ahead of time, so an agent never has to hand-triage `git status` before delivering.

## Record-Work Requirements

`record-work` exists for work already completed in the current chat without an attached session.

Requirements:

- Create a mission directly in review.
- Create a completed objective.
- Store a delivery summary.
- Store artifacts and change rationales if provided.
- Record a `changed_files` row for every rationale's file path (shown "covered" in review) plus any explicit `--changed-files-json` entries (shown "missing_rationale"), so the review file panel matches a normal delivery.
- Store delivery and changed-file records without requiring an `agent_sessions` row; session attribution is null for `record-work`.
- Enqueue the standard delivery compose job so the Gemini delivery summary runs exactly as it does for a normal `deliver`.
- Accept the whole submission as a single `--payload-json` / `--payload-file` envelope (`{ objective, summary, title, changeRationales, changedFiles, artifacts }`), with explicit flags overriding envelope fields.
- Do not use it for in-progress work.

The exact submission format is documented in the shared connector reference at
`connectors/core/overlord-mission/reference/record-work.md`.

## Acceptance Criteria

- Agents can complete the full lifecycle using only `ovld protocol`.
- `attach` gives enough context for a new agent session to continue work without reading prior chat.
- Follow-up messages from hooks are preserved as events.
- Delivery with missing required rationale fields fails with a useful error.
- Protocol payloads can be sent via stdin to avoid shell quoting failures.
- Local MVP command names remain compatible with future HTTP/MCP surfaces.
