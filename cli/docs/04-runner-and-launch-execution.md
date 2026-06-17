# Runner And Launch Execution

## Goal

Port the execution-request queue, local runner, and agent launch path so Overlord can execute objectives from the CLI without requiring a desktop app or web browser.

## Execution Pipeline

The same pipeline should power manual run and auto-advance:

1. A user or system requests execution for an objective.
2. Overlord writes a durable execution request.
3. `ovld runner start` or `ovld runner once` claims the request.
4. The runner resolves a working directory.
5. The runner launches the requested agent locally.
6. The launched agent attaches to the ticket.
7. The runner marks the launch successful or failed.

## Execution Requests

Requirements:

- Store objective ID, ticket ID, project ID, requested agent, model, thinking/effort, launch flags, requested source, idempotency key, status, timestamps, last error, and resolved working directory/resource details.
- Statuses: `queued`, `claimed`, `launching`, `launched`, `failed`, `cleared`, `cancelled`, and `expired`.
- Active statuses: `queued`, `claimed`, `launching`.
- A request must be claimable only when its objective is launchable: `draft`, `submitted`, or `launching`.
- Duplicate auto-advance requests for the same objective should be prevented by an idempotency key.
- Manual run should allow repeat requests with distinct client request IDs.
- Stale claims should expire and become retryable or failed with a clear event.
- Queue claiming must be atomic. Competing runners should not be able to claim the same active execution request.

## Runner Requirements

Commands:

- `ovld runner once`
- `ovld runner start`
- `ovld runner status`
- `ovld runner clear <objective_id>`
- `ovld runner clear-all`

Options:

- `--device-fingerprint <fp>` for advanced override.
- `--poll-interval-ms <ms>` defaulting to 3000.
- `--project-id <id>` to restrict claims.
- `--organization-id <id>` deferred until multi-org support.

MVP behavior:

- Register/read a stable local device fingerprint from `~/.ovld/device.json`.
- Poll the configured backend.
- Claim the oldest compatible request.
- Resolve working directory.
- Spawn the launch command.
- Record launch success/failure through the backend API.
- Print status with device identity and active queue.

Future behavior:

- Multi-org polling.
- Remote/SSH target claiming.
- Realtime notification instead of polling.
- Background service installation.

## Device And Execution Target Requirements

MVP:

- One local execution target per device fingerprint.
- Label generated from hostname/platform.
- Rename via `ovld protocol update-device`.
- Local project resource directories attached to the device.

Future:

- Target types: `local` and `ssh`.
- Per-user and organization-owned target ownership.
- Access control for managing resources.
- Remote host key and SSH credential handling.
- Target selection when queuing a run.

## Resource Directory Resolution

Working directory resolution order:

1. Explicit `workingDirectory` from the execution request or launch flag.
2. Selected target resource directory.
3. Primary resource directory for the project on the local target.
4. Current working directory if it contains matching `.overlord/project.json`.
5. Fail with an actionable error.

Requirements:

- `ovld add-cwd` registers the current directory as a project resource.
- The first directory for a project/device becomes primary by default.
- Runner must refuse to launch when no usable working directory exists.
- Error should tell the user to run `ovld add-cwd` or pass `--working-directory`.

## Launch Command Requirements

`ovld launch <agent>` must:

- Fetch or assemble ticket context before launching.
- Write large context payloads to `.overlord/tmp/` when a project directory is known.
- Export `TMPDIR`, `TMP`, `TEMP`, and `OVERLORD_TMPDIR` to the project `.overlord/tmp/`.
- Pass concise prompt text or context-file references to the agent.
- Preserve model/thinking/flags.
- Support `--pre-command <wrapper>` through an interactive shell where needed.
- Open the agent in a new terminal window when a launcher is configured via
  the stored terminal profile (or `--terminal <launcher>`); `--no-terminal` forces an
  inline launch. Built-in macOS launchers `iTerm2` and `Terminal` drive
  AppleScript (`osascript`) to open a fresh window, `cd` into the working
  directory, and re-export the `TMPDIR` family before invoking the agent. Any
  other value is a prefix command with the agent invocation appended. When no
  launcher is set, the agent runs inline (`stdio: 'inherit'`).
- Record native external session/resume identifiers when available.

Initial command mappings:

- Codex: `codex [--model <model>] [-c model_reasoning_effort="<level>"] "<prompt or context-file prompt>"`
- Claude Code: `claude --append-system-prompt-file <context-file> [--model <model>] [--effort <level>] <start-prompt>`

Next command mappings:

- Cursor: `agent [--model <model>] "<prompt>"`
- Antigravity: plugin-driven launch; model selection inside Antigravity.
- OpenCode: command adapter once connector shape is defined.
- Custom agents: user-configured command templates.

## Auto-Advance Requirements

Auto-advance should not directly spawn agents.

Requirements:

- After delivery, inspect the next draft objective with non-empty text.
- If no next objective exists, stop.
- If `auto_advance=false`, record `awaiting_approval` and do not queue execution.
- If `auto_advance=true`, move the objective to `submitted` or `launching` and create an execution request.
- Use an idempotency key like `auto_advance:<objective_id>`.
- Runner handles actual launch.

Manual Run:

- Uses the same request queue.
- Source should be recorded as `manual_run`, `api`, `cli`, or similar.
- Repeated manual launches are allowed when intentionally requested.

## Acceptance Criteria

- `ovld runner once` can pick up a queued objective and launch the requested agent locally.
- `ovld runner status` explains why a queued request is or is not claimable.
- A missing primary directory produces a clear repair command.
- Auto-advance queues the next objective without requiring a desktop app.
- Manual run and auto-advance share the same execution request model.
- Agent launch writes context files under `.overlord/tmp/` for large prompts and wrappers.
