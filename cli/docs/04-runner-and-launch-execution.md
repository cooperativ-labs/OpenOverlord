# Runner And Launch Execution

## Goal

Port the execution-request queue, local runner, and agent launch path so Overlord can execute objectives from the CLI without requiring a desktop app or web browser.

## Execution Pipeline

The same pipeline should power manual run and auto-advance:

1. A user or system requests execution for an objective.
2. Overlord writes a durable execution request.
3. `ovld runner start` or `ovld runner once` claims the request.
4. The runner resolves a working directory.
5. The runner prepares the mission branch/worktree when worktree branch automation is enabled.
6. The runner launches the requested agent locally from the prepared directory.
7. The runner marks the terminal/launch command open as successful or failed.
8. The launched agent attaches to the mission, and attach links the session back
   to the execution request when the launch context carries the request id.

## Execution Requests

Requirements:

- Store objective ID, mission ID, project ID, requested agent, model, thinking/effort, launch flags, requested source, idempotency key, status, timestamps, last error, and resolved working directory/resource details.
- Statuses: `queued`, `claimed`, `launching`, `launched`, `failed`, `cleared`, `cancelled`, and `expired`.
- Active statuses: `queued`, `claimed`, `launching`.
- A request must be claimable only when its objective is launchable: `draft`, `submitted`, or `launching`.
- Duplicate auto-advance requests for the same objective should be prevented by an idempotency key.
- Manual run should allow repeat requests with distinct client request IDs.
- Stale claims should expire with a clear event. A launched request that never
  attaches should also expire so a terminal-open success does not masquerade as
  a durable agent session.
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
- `--branch <name>` to force a specific branch for this launch.
- `--no-worktree` to bypass mission worktree preparation and run in the resolved directory.
- `--organization-id <id>` deferred until multi-org support.

MVP behavior:

- Register/read a stable local device fingerprint from `~/.ovld/device.json`.
- Poll the configured backend.
- Claim the oldest compatible request.
- Resolve working directory.
- Prepare a per-mission git branch in a per-mission worktree under `~/.ovld/worktrees`
  (or `OVERLORD_WORKTREE_ROOT`) unless disabled in launch settings.
- Spawn the launch command.
- Record terminal-open success/failure through the backend API.
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
2. Objective `resource_key`, resolved to the active project resource row for the
   claiming execution target.
3. Primary resource directory for the project on the local target.
4. Current working directory if it contains matching `.overlord/project.json`.
5. Fail with an actionable error.

Requirements:

- `ovld add-cwd` registers the current directory as a project resource. It accepts
  optional `--key <resourceKey>`; when omitted, the key is derived from the
  resource label or path basename.
- The first directory for a project/device becomes primary by default.
- An objective with a non-null `resource_key` is launchable on a target only when
  that target has an active, usable resource row with the same key.
- Runner must refuse to launch when no usable working directory exists.
- Error should tell the user to run `ovld add-cwd` or pass `--working-directory`.
- If an objective-bound resource is missing for the selected target, the runner
  must refuse with `objective_resource_not_connected` and tell the user to run
  `ovld add-cwd --key <resourceKey>` from the intended checkout on that device.

## Mission Branch And Worktree Preparation

When launch settings have `worktreeBranchAutomationEnabled` enabled (disabled by
default; users opt in from the Worktrees settings page), the runner prepares a
mission-specific branch and git worktree after resolving the project resource and
before spawning the agent.

Branch names use:

```text
<mission-title-slug>-<mission-sequence>
```

The worktree lives under:

```text
~/.ovld/worktrees/<project-slug>/<resource-key>/<branch-name-with-slashes-flattened>
```

The branch name remains mission-scoped, but the worktree path is resource-scoped.
This lets two objectives in the same mission use the same branch name in
different repositories without colliding on disk.

Subsequent launches for the same mission reuse the latest recorded branch read
from the `missions.active_branch` column (surfaced on the mission detail DTO's
`branch` field). If that branch has been merged or deleted after merge, the next
launch starts a new cycle with a numeric suffix (`-2`, `-3`, ...). Preparation is
never destructive: the main checkout is not stashed, reset, or force-checked out;
an existing worktree at the planned path is reused only when it is a git worktree
checked out on the expected mission branch. A dirty reused worktree is allowed so
later objectives in the same mission can continue uncommitted work on the same
branch.

After preparation, the runner records `POST /api/missions/:id/branch-prepared`,
which writes the resolved branch to the `missions.active_branch` column (the
source of truth), records a human-readable audit entry under an allowed
`mission_events` type (no dedicated `branch_prepared` event type exists — the
event vocabulary is a closed enum), and stamps
`execution_requests.launch_flags_json.branchAutomation` for queued runner
requests.

## Launch Command Requirements

`ovld launch <agent>` must:

- Fetch or assemble mission context before launching.
- Write large context payloads to `.overlord/tmp/` when a project directory is known.
- Opportunistically prune stale `.overlord/tmp/` entries before writing new launch scratch files.
- Export `TMPDIR`, `TMP`, `TEMP`, and `OVERLORD_TMPDIR` to the project `.overlord/tmp/`.
- Export `MISSION_ID`, `OVERLORD_MISSION_ID`, and the resolved `OVERLORD_BACKEND_URL`
  into launched agent terminals so connector hooks can publish prompt and permission
  activity to the same mission/backend.
- Export `OVERLORD_WORKING_DIRECTORY` (substitution map) and
  `OVERLORD_CONTEXT_FILE` for the written briefing path under `.overlord/tmp/`.
- Export `OVERLORD_PROJECT_RESOURCES` as JSON for the launching execution target.
  The value mirrors attach context's project resource manifest: one entry per
  logical resource key with label, primary/current flags, local path when known,
  and availability state. Hooks and pre-commands may use it for context, but the
  launched session remains rooted in the resolved working directory.
- Derive convenience path variables for `{VAR}` substitution:
  `OVERLORD_PROJECT_RESOURCES_PATHS` (comma-separated paths with explicit `:rw`/`:ro`
  permission suffixes per resource `accessMode`),
  `OVERLORD_PROJECT_RESOURCES_PATHS_CSV` (alias of the above, kept for backward compatibility), and
  `OVERLORD_PRIMARY_RESOURCE_PATH`. The documented catalog lives in
  `@overlord/contract` (`LAUNCH_VARIABLES`) and is listed in Project Settings →
  Launch.
- Pass concise prompt text or context-file references to the agent.
- Preserve model/thinking/flags.
- Support `--branch <name>` and `--no-worktree` with the same semantics as the
  runner path.
- Support `--pre-command <wrapper>` through an interactive shell where needed.
- Run the project's **pre-launch commands** inside the launch environment after
  the terminal enters the working directory and exports the launch env, but
  before the agent process starts. These are ordered shell command lines
  configured per project (`ProjectDto.preLaunchCommands`, stored under the
  `overlord.preLaunchCommands` key in `projects.settings_json`) and are the
  generic hook for project-specific launch preparation — e.g. granting an agent
  pod extra file access before the agent runs. The runner claim response carries
  them for the runner path; a manual `ovld launch` fetches them from the
  mission's project. Each line may reference launch variables with `{VAR_NAME}`
  placeholders (e.g. `{OVERLORD_PROJECT_RESOURCES_PATHS}`, plus every exported
  Overlord launch env var) that are substituted at plan-build time; unknown
  placeholders are left verbatim so a not-yet-wired variable stays visible. The
  set of exposed variables is intentionally open-ended and grows as more launch
  context is wired in — see `LAUNCH_VARIABLES` and the mission-launch-lifecycle
  docs for what is available at plan-build vs attach.
- Export the project's **launch environment variables** into the launch
  environment before both the pre-launch commands and the agent run. These are
  user-defined `NAME=value` pairs configured per project
  (`ProjectDto.launchEnvVars`, stored under the `overlord.launchEnvVars` key in
  `projects.settings_json`) — the generic hook for handing the agent (or a
  pre-launch command) extra environment, e.g.
  `AGENT_POD_EXTRA_ALLOWED_PATHS={OVERLORD_PROJECT_RESOURCES_PATHS_CSV}`. The
  runner claim response carries them for the runner path; a manual `ovld launch`
  fetches them from the mission's project. Each *value* may reference the same
  `{VAR_NAME}` launch variables as pre-launch commands and is substituted at
  launch time (unknown placeholders left verbatim); because they are `export`ed
  before the pre-launch commands, those commands can also read them via shell
  `$NAME`.
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

## Persistent Runner Service

`ovld runner once` and `ovld runner start` require a terminal to stay open. The
persistent runner service removes that requirement by installing an OS-level user
service that runs the supervisor loop in the background.

- `ovld runner supervise` is the long-lived loop. Each poll delegates to the same
  one-shot claim-and-launch implementation used by `ovld runner once` — claim,
  resource resolution, branch/worktree preparation, and terminal launch behavior
  are never duplicated.
- **Adaptive polling**: poll every 3 seconds while any job launched within the
  last two hours, and every 10 seconds after two hours with no launched job.
  Backoff is keyed on the "last launched job" clock (not "last poll with work"),
  so a long run of empty polls does not keep the runner hot. Each interval adds
  ~10% jitter so many local runners do not wake in lockstep against a shared
  backend.
- **Host integration**: macOS uses a user `launchd` LaunchAgent
  (`~/Library/LaunchAgents/io.overlord.runner.plist`); Linux uses a
  `systemd --user` unit (`~/.config/systemd/user/overlord-runner.service`).
  Windows is deferred; use `ovld runner start` there. The installed service
  invokes the resolved `ovld` executable with an explicit environment snapshot
  (`OVERLORD_BACKEND_URL`, `OVLD_HOME` when set, the user token when present, and
  a minimal `PATH`) because persistent services do not source interactive shell
  startup files.
- **Local state**: `~/.ovld/runner-service.json` records the installed service
  kind/identifier, resolved exec path, backend URL, last heartbeat/claim/launch
  timestamps, last error, and current poll interval. This is local diagnostic
  state only, not a backend source of truth.
- **Security**: the rendered service definition embeds the user token in its
  environment, so the plist/unit file is written owner read/write only.
- **Desktop control**: Overlord Desktop exposes install/start/stop/restart/status/
  uninstall through the `window.overlord.runnerService` bridge, which spawns these
  same CLI commands. The desktop app never claims queue work or supervises the
  loop itself.
- **Publisher identity (macOS)**: macOS attributes a LaunchAgent's background item,
  login item, and automation prompt to the code-signing identity of its program.
  When the Overlord desktop app is present, both desktop-driven installs and plain
  `ovld runner service install` runs execute the supervisor through the signed
  Overlord app binary (as Node, via `ELECTRON_RUN_AS_NODE`), so the service
  registers under **Overlord** rather than the plain `node` binary's **Node.js
  Foundation** signature. A CLI-only install with no desktop app present falls back
  to the `node` binary and registers under "Node.js Foundation"; `ovld runner
  service status` reports the resolved `publisher` and, when applicable, a
  `reinstallHint` to re-register it under Overlord by reinstalling with the desktop
  app present.

## Acceptance Criteria

- `ovld runner once` can pick up a queued objective and launch the requested agent locally.
- `ovld runner supervise` polls adaptively and delegates to the same claim-and-launch path as `ovld runner once`.
- `ovld runner service install` registers a background service that survives terminal exit on macOS and Linux.
- `ovld runner status` explains why a queued request is or is not claimable.
- A missing primary directory produces a clear repair command.
- Auto-advance queues the next objective without requiring a desktop app.
- Manual run and auto-advance share the same execution request model.
- Agent launch writes context files under `.overlord/tmp/` for large prompts and wrappers.
