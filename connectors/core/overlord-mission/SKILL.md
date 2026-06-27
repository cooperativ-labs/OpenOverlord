---
name: overlord-mission
description: Shared Overlord mission workflow protocol for connector plugins, covering both Overlord-launched missions and chat-invoked Overlord work.
---

# Overlord Mission

Use this core whenever an agent connector needs to work with Overlord, whether the session was launched by Overlord Desktop/CLI or the user asks from chat to engage with Overlord.

Connector adapters may add harness-specific commands, hooks, MCP tools, or launch flags, but they must not replace the lifecycle rules in this core.

## Mode 1: Launched From Overlord Desktop Or CLI

Use this mode when the prompt already contains a mission ID or explicitly says the session was launched by Overlord.

1. Attach first with `ovld protocol attach --mission-id <mission_id>`.
2. The attach response prints JSON to stdout containing `session.sessionKey`. The CLI also persists this key automatically so subsequent `ovld protocol` commands in the same working directory resolve it without `--session-key`. If auto-resolution fails, pass `--session-key <sessionKey>` explicitly on every subsequent call.
3. Treat the Overlord mission prompt as authoritative for the objective, constraints, and delivery target.
4. Post updates while working: `ovld protocol update --session-key <sessionKey> --mission-id <mission_id> --summary "..." --phase execute`.
   During long mechanical stretches with nothing meaningful to post, send `ovld protocol heartbeat --session-key <sessionKey> --mission-id <mission_id> [--phase execute] [--percent <0-100>] [--note "..."]` instead of an empty update.
5. Follow-up messages after the initial mission are captured automatically by the installed `UserPromptSubmit` hook and stay in discussion intent while the mission is in review. Do not post `user_follow_up` manually unless the hook is unavailable.
6. If blocked, call `ovld protocol ask --session-key <sessionKey> --mission-id <mission_id> --question "..."` and stop.
7. Deliver last with `ovld protocol deliver --session-key <sessionKey> --mission-id <mission_id> --summary "..."`, including `changeRationales` only for meaningful behavioral file changes made as part of this mission.

For full command syntax, flags, phase values, and event types see **CLI Command Reference** below.

## Missions vs Objectives

**Missions** represent whole features or goals. **Objectives** are the individual steps to implement that goal — one objective equals one agent prompt.

Example:
```
Mission: add CLI command for editing user profile
 - Objective 1: draft plan for this command
 - Objective 2: implement phase 1 of plan
 - Objective 3: implement phase 2 of plan
 - Objective 4: update documentation
```

When to create a mission vs an objective:
- **Create a new mission** when the user describes a distinct feature, bug, or goal that stands on its own.
- **Add objectives to an existing mission** when the work is a sequential step toward the same feature or goal already tracked in a mission.

To add further objectives to an existing mission (Mode 2):
```
ovld protocol add-objectives --mission-id <mission_id> --objectives-json '[{"objective":"..."},{"objective":"..."}]'
```

## Objective Submission vs Execution

Discussing or otherwise opening a mission from within a chat should cause the draft objective to be marked **submitted** — this signals the mission is in active discussion with an agent, but not yet being executed. Only an explicit order to execute (e.g. "execute this", "do this", "start working on it") should cause you to **attach** to the mission and trigger execution.

- **Discussing / opening a mission** → `ovld protocol discuss-objective --mission-id $MISSION_ID` (draft → submitted, no session).
- **Creating a mission** via `ovld protocol create` keeps the objective in `draft` state.
- **Explicitly ordered to execute** → `ovld protocol attach --mission-id $MISSION_ID` (draft/submitted → executing, session begins).

Do not attach to a mission just because it was mentioned or opened in conversation. Only attach when the user clearly asks you to execute the work.

## Mode 2: Asked From Chat To Use Overlord

Use this mode when the conversation starts normally and the user asks the agent to create, inspect, connect to, or otherwise use Overlord.

1. If the user wants to create missions (and does not ask to start execution), run `ovld protocol create --agent <agent-identifier> --objectives-json '[{"objective":"..."}]'`.
   - When `--session-key` and `--mission-id` are provided, it creates a follow-up draft.
   - When session flags are omitted, it resolves the project by matching current working directory (or `--working-directory`) to Overlord project resource directories, then creates a standalone draft.
   - Pass multiple items in `--objectives-json` when creating ordered steps for the same feature or goal.
   - If the user wants to **add more objectives to an existing mission** (not create a new mission), use `ovld protocol add-objectives --mission-id <mission_id> --objectives-json '[{"objective":"..."}]'` instead.
2. Default to `create` for new missions. Only use `ovld protocol prompt --agent <agent-identifier> --objectives-json '[{"objective":"..."}]'` when the user explicitly asks to create and execute immediately.
   `prompt` creates the mission in `execute` status and attaches immediately.
3. If the user already has a mission ID and only wants to inspect it, run `ovld protocol load-context --mission-id <mission_id>`.
   When you open or discuss an existing mission that has a draft objective, submit it with `ovld protocol discuss-objective --mission-id <mission_id>`.
4. If the user wants to route the current session onto an existing mission by ID, run `ovld protocol connect --mission-id <mission_id>`.
5. If the user wants to establish a persistent session with a mission by ID, run `ovld protocol attach --mission-id <mission_id>`.
6. If the user wants to find a mission but does not know the ID, run `ovld protocol search-missions --query "..." --status next-up,execute` and ask the user to confirm.
7. If you need to understand project routing before prompting, use `ovld protocol discover-project`.
8. If you need other lifecycle commands or flags, run `ovld protocol help` and use the real subcommand list instead of guessing.
9. Once you attach to a mission, switch back to Mode 1 and follow the full mission lifecycle.

For mission creation examples, project discovery, and `--objectives-json` format see **CLI Command Reference** below.

## CLI Command Reference

### Attach

```bash
ovld protocol attach --mission-id $MISSION_ID
```

In a git workspace, `attach` automatically creates a local git checkpoint for each executing objective before work begins, stored under `refs/overlord/checkpoints/<objectiveId>`. Pass `--skip-checkpoint` only when intentionally bypassing local provenance.

### Update

```bash
ovld protocol update --session-key <sessionKey> --mission-id $MISSION_ID --summary "What you did and why." --phase execute
```

### Heartbeat

```bash
ovld protocol heartbeat --session-key <sessionKey> --mission-id $MISSION_ID --phase execute --percent 40 --note "Running the integration suite"
```

Use `heartbeat` for liveness pings and transient UI telemetry when you have no meaningful narrative summary to post. It updates the attached session without creating a mission event.

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
- `discussion_summary` for important discussion outcomes that should remain visible on the mission
- `decision` for explicit non-file decisions made during follow-up discussion

- Post-delivery follow-up modes:

- User follow-up messages default to `discussion` intent while the mission is in review.
- Use `ovld protocol resume-follow-up --mission-id $MISSION_ID --summary "Beginning follow-up work."` when post-delivery implementation starts after the original session has ended or its key is unavailable.
- Use `ovld protocol update --begin-follow-up-work --follow-up-intent execution --summary "Beginning follow-up work."` before moving a delivered/review mission back to execution.
- Use `--follow-up-intent pending_delivery` when implementation is complete but final delivery is still being prepared.

### Ask

```bash
ovld protocol ask --session-key <sessionKey> --mission-id $MISSION_ID --question "Specific question for the PM."
```

### Deliver

```bash
ovld protocol deliver --session-key <sessionKey> \
  --mission-id $MISSION_ID \
  --summary "Narrative: what you did, next steps." \
  --artifacts-json '[{"type":"next_steps","label":"Next steps","content":"..."}]' \
  --change-rationales-json '[{"label":"Short reviewer title","file_path":"path/to/file.ts","summary":"What changed.","why":"Why it changed.","impact":"Behavioral impact.","hunks":[{"header":"@@ -10,6 +10,14 @@"}]}]'
```

Use `--payload-json` when the full delivery object fits comfortably inline (roughly under 8 KB). Larger inline `--*-json` values are **rejected** — use `--payload-file -`, `--change-rationales-file -`, or `--artifacts-file -` and stream JSON on stdin so no scratch file needs to be created or removed. If you use `--payload-file`, `--artifacts-file`, or `--change-rationales-file` with a real path, treat that file as ephemeral scratch data under `.overlord/tmp` and remove it after delivery.

When delivery includes many change rationales, keep `--summary` inline and pipe rationales on stdin:

```bash
ovld protocol deliver --session-key <sessionKey> --mission-id $MISSION_ID \
  --summary "Narrative: what you did and next steps." \
  --change-rationales-file - <<'EOF'
[
  {"label":"Add backoff","file_path":"lib/api.ts","summary":"Added retry.","why":"Transient failures.","impact":"Retries 3x."}
]
EOF
```

If `heartbeat` succeeds but `deliver` or `update` fails, the session is likely fine — retry with large JSON on stdin instead of inline `--*-json`.

### Shared worktree safety (critical)

The working tree may contain file changes from **other agents, missions, or objectives** running concurrently in the same checkout or worktree. Those changes are **not yours to undo**.

**Never revert, delete, or restore another agent's work to make delivery succeed.** This includes:

- `git checkout`, `git restore`, `git reset`, or any command that rolls back uncommitted edits you did not make for this mission
- Deleting or overwriting files you do not recognize as your own
- `ovld protocol revert` on another objective's checkpoint to "clean up" before deliver

If `deliver` fails with `missing_rationale` for a file you did not change, or `git status` shows dirty paths outside your mission:

1. **Do not** touch those files — leave concurrent work intact.
2. **Do not** fabricate rationales for work you did not do.
3. Post a progress update explaining the attribution mismatch, then call `ovld protocol ask` with the conflicting paths and stop until a human resolves it.

Report only **your** mission's changes in the delivery payload and `changeRationales`. Excluding unrelated files from the delivery report is correct; **removing them from disk is not**.

Changed files are captured for you: the CLI records a VCS baseline at attach and, at deliver, reports the run-attributable delta (current `git status` minus baseline) automatically — you do not pass `--changed-files-json`. Include `changeRationales` only for meaningful file changes made as part of this mission. Do not include other tracked worktree changes in the delivery report, payload, artifacts, or `changeRationales`, even to label them as pre-existing, concurrent, or unrelated. If `deliver` rejects with a `missing_rationale` error for a file you did not change for this mission, do not add a rationale for that file and **do not revert the file**; follow **Shared worktree safety** above. Coverage is aggregated per objective. If the run changed no files, declare it explicitly:

```bash
ovld protocol deliver --session-key <sessionKey> --mission-id $MISSION_ID \
  --summary "Investigated X; no code changes were required." --no-file-changes
```

Ordinary deliver artifacts should use `next_steps`, `test_results`, `migration`, `note`, `url`, or `decision`.

### Revert

```bash
ovld protocol revert --objective-id <objective-id>
```

`revert` restores the local working tree to the recorded objective state. Use only when explicitly asked to undo **this** objective's work. Never use `revert` — or any git rollback — to strip unrelated concurrent changes before delivery.

### Record Change Rationales

These are structured protocol payloads that Overlord stores as first-class rows in the `file_changes` table. Inline `--change-rationales-json` is fine for a few entries; larger arrays are **rejected** — use `--change-rationales-file -` and stream JSON on stdin. The same ~8 KB inline limit applies to `--payload-json` and other `--*-json` flags.

**Required fields per entry:** `file_path`, `label`, `summary`, `why`, `impact` (all strings). `filePath` (camelCase) is accepted as an alias for `file_path` and normalized to the canonical form, so matching the changed-files casing no longer fails validation. Do not wrap the entry under a `rationale` key — that is a different internal shape and will fail CLI validation.

```bash
ovld protocol record-change-rationales --session-key <sessionKey> --mission-id $MISSION_ID \
  --summary "Recorded rationale details for the latest code changes." --phase execute \
  --change-rationales-json '[{"label":"Add backoff","file_path":"lib/api.ts","summary":"Added retry.","why":"Transient failures.","impact":"Retries 3x.","hunks":[{"header":"@@ -22,4 +22,18 @@"}]}]'
```

```bash
ovld protocol update --session-key <sessionKey> --mission-id $MISSION_ID \
  --summary "Added retry logic." --phase execute \
  --change-rationales-json '[{"label":"Add backoff","file_path":"lib/api.ts","summary":"Added retry.","why":"Transient failures.","impact":"Retries 3x.","hunks":[{"header":"@@ -22,4 +22,18 @@"}]}]'
```

For many entries (roughly 5+), pipe via stdin to avoid shell quoting failures:

```bash
ovld protocol record-change-rationales --session-key <sessionKey> --mission-id $MISSION_ID \
  --summary "Recorded rationale details for the latest code changes." --phase execute \
  --change-rationales-file - <<'EOF'
[
  {"label":"Add backoff","file_path":"lib/api.ts","summary":"Added retry.","why":"Transient failures.","impact":"Retries 3x."},
  {"label":"Update config","file_path":"lib/config.ts","summary":"Added timeout.","why":"Match new defaults.","impact":"Requests time out after 30s."}
]
EOF
```

### Project Discovery And Mission Creation

When creating missions from within a repository:

- Prefer `create` by default for draft mission creation.
- Use `prompt` only when the user explicitly asks to start execution immediately.
- Both commands can resolve the project from the current working directory; use `--working-directory` to override or `--project-id` to be explicit.
- Follow-up `create` calls under an active session inherit the current mission's project by default, but `--project-id` can override that when the follow-up belongs in a different project.
- Create multiple missions when each prompt represents a different feature or goal.
- Add objectives to the same mission when each prompt is a sequential step toward the same feature or goal; use `ovld protocol add-objectives --mission-id <mission_id> --objectives-json '[{"objective":"..."}]'`.
- `create`, `prompt`, and `record-work` require `--objectives-json` or `--objectives-file` with an ordered array of `{ "objective": "...", "title": "...", "autoAdvance": true }` objects. A single objective is just an array with one item.
- `create`, `prompt`, `create-mission`, and `record-work` accept `--assigned-to <member>` to set the mission's human owner. Accepts a username, an email, a user-id UUID, or the `orgid:username` member ID. When omitted, the assignee defaults to the mission creator.

```bash
ovld protocol create --agent <agent-identifier> --objectives-json '[{"objective":"Capture follow-up work from this repository"}]'
```

```bash
ovld protocol prompt --agent <agent-identifier> --objectives-json '[{"objective":"Implement feature X"}]' --priority medium
```

```bash
ovld protocol add-objectives --mission-id 1:899 --objectives-json '[{"objective":"Implement the API"},{"objective":"Add CLI docs"}]'
```

#### Local Durability For New Missions

`create`, `prompt`, `add-objectives`, and `record-work` save the objective/mission text to a local draft (`~/.overlord/pending-missions/`) **before** sending it, and delete that draft only once the server confirms the write. If the network drops mid-call, your text is never lost — the failure message points at the saved file. Manage outstanding drafts with `pending-missions`:

```bash
ovld protocol pending-missions               # list drafts the server never confirmed
ovld protocol pending-missions --retry <id>  # re-send a saved draft; clears it on success
ovld protocol pending-missions --clear <id>  # delete one draft after confirming it landed
ovld protocol pending-missions --clear-all   # delete every draft
```

To inspect project resolution explicitly:

```bash
ovld protocol discover-project
ovld protocol discover-project --project-id <id-or-name>
ovld protocol discover-project --project-id "My Project"
ovld protocol discover-project --working-directory /path/to/repo
```

Use `--project-id` when the project ID or name is already known (names are unique per organization, matched case-insensitively). Use `--working-directory` to override cwd path matching. If the runtime has an `OVERLORD_DEVICE_FINGERPRINT`, pass `--device-fingerprint "$OVERLORD_DEVICE_FINGERPRINT"` so resource-directory matching prefers the current device.

### Creating Projects

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

#### Resolving the project ID when you don't have one

When you need a project ID for a protocol command and the mission prompt did not supply one, resolve it in this order.

**Locally (CLI inside a shell on the user's machine):**

1. `--project-id` if explicitly provided.
2. Otherwise, let the CLI match the current working directory (the default behavior of `create`, `prompt`, `discover-project`).
3. If working-directory resolution returns nothing, read `.overlord/project.json` from the cwd (or any ancestor you have access to) and pass its project id via `--project-id`.

**Over MCP (web agents and hosted tools, where the server cannot see the agent's cwd):**

1. `projectId` (hosted MCP) or `project_id` (local shim) if explicitly provided or found in the mission/context.
2. Read `.overlord/project.json` from the directory the user is accessing and pass its project id as `projectId` / `project_id`.
3. As a last resort, try `workingDirectory` / `working_directory` resolution. If a device fingerprint is available, include `deviceFingerprint` / `device_fingerprint`.

If `.overlord/project.json` contains more than one project, show the user the project **names** from that file and ask which one to use before calling any protocol command — never silently pick one.

## Change Rationales

Always include `changeRationales` when delivering; optionally on updates during long-running work. Your job is rationale for *what* changed and why — the CLI captures *which* files changed (see **Deliver** above).

- Rationales only for meaningful behavioral changes you made for this mission; skip formatting-only noise. Do not send `file_changes` as an artifact.
- Do not include unrelated worktree changes in the delivery report, payload, artifacts, or rationales — even to label them pre-existing.
- **Never revert, restore, or delete file changes from other agents or missions** to satisfy delivery. Ask instead (see **Shared worktree safety** under **Deliver**).
- If `deliver` rejects with `missing_rationale` for a file you did not change, do not invent a rationale and do not revert the file; ask and stop.
- Read-only runs: `--no-file-changes` (see **Deliver** above).

Field shape, inline vs stdin piping, and `record-change-rationales` syntax are in **Deliver** and **Record Change Rationales** in **CLI Command Reference** above.

## Rules

- Always attach first and always deliver last once you are on a mission.
- Use `ovld protocol` commands and the connector's native commands/tools instead of ad hoc scripts.
- Do not invent protocol subcommands. Use `ovld protocol help` when unsure.
- Include at least one progress update before delivering.
- After delivery, answer ordinary questions and clarifications in discussion mode; hook capture records those user turns as `user_follow_up` activity.
- When explicit follow-up implementation starts on a delivered/review mission and no live session exists, call `ovld protocol resume-follow-up --mission-id <mission_id> --summary "Beginning follow-up work."` and use the returned session key before code changes.
- When explicit follow-up implementation starts while a live delivered session still accepts updates, call `ovld protocol update --begin-follow-up-work --follow-up-intent execution --summary "Beginning follow-up work."` before code changes or `--phase execute`.
- During follow-up execution, post progress updates and record change rationales for each file modified, the same as during initial execution.
- Record important non-file decisions with `--event-type decision` or `--event-type discussion_summary`.
- The `summary` in deliver is what the PM reads first, so write it as a narrative, not a command list.
- When a summary or question contains backticks, `$vars`, or other shell-special characters, always use `--summary-file -` (or `--question-file -`) with a single-quoted heredoc (`<<'EOF'`). Never retry by stripping or escaping content — pipe stdin instead. See [reference/shell-escaping.md](reference/shell-escaping.md).
- Use `write-context` for facts a future agent session should know.
- If a protocol or MCP call fails with auth/session errors, run `ovld auth repair` yourself before asking the user to log in again or proceed without Overlord updates.
- If you must run `ovld auth login`, `--organization-id <id>` is optional — it validates/scopes that login or command but does not create a stored default organization.
- Do not add or commit changes unless the user explicitly asks you to commit.
- **Never revert, restore, or delete concurrent work from other agents or missions** to deliver your own changes. Leave unrelated dirty files intact and use `ovld protocol ask` when attribution blocks delivery.
- Delivery is the concluding step. After delivering, stop implementation work unless the user explicitly asks for follow-up execution; once follow-up execution is complete, deliver again.

## Reference

- [reference/cli.md](reference/cli.md) — Full protocol command syntax, flags, phases, mission creation, and project discovery
- [reference/mcp.md](reference/mcp.md) — MCP tool naming, key casing, hosted vs local shim defaults
- [reference/devices.md](reference/devices.md) — Device fingerprints, project resources, and `--for-human`
- [reference/context.md](reference/context.md) — Shared state, attachments, and large artifact policy
- [reference/shell-escaping.md](reference/shell-escaping.md) — Heredoc stdin piping for special characters in summaries and payloads

<!-- version: 0.5.15 -->
