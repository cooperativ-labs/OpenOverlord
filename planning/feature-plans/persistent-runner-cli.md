# Persistent Runner CLI Recommendation

## Context

Overlord already has a foreground runner path:

1. A run request is queued in `execution_requests`.
2. `ovld runner once` or `ovld runner start` claims the request through the runner
   REST surface.
3. The runner resolves the working directory, prepares branch/worktree state, and
   launches the requested agent through the existing terminal launch path.

This works, but it requires the user to keep a terminal session alive. The desired
experience is:

- the user opts into a persistent runner once;
- when an objective hits the queue, Overlord opens a terminal and launches the job
  exactly as the foreground runner would;
- users retain `ovld runner start` for visible foreground operation;
- idle polling backs off to 10 seconds after two hours without a launched job, and
  uses 3 seconds otherwise.

## Recommendation

Add a CLI-owned persistent runner supervisor that is installed and managed by the
`ovld` binary, but keep all queue claiming and launch behavior in the existing
runner path.

Recommended command surface:

| Command | Purpose |
| --- | --- |
| `ovld runner start` | Existing foreground loop; unchanged. |
| `ovld runner once` | Existing one-shot claim and launch; unchanged. |
| `ovld runner service install` | Register the persistent runner with the host OS. |
| `ovld runner service start` | Start the registered persistent runner. |
| `ovld runner service stop` | Stop the registered persistent runner. |
| `ovld runner service restart` | Restart the registered persistent runner. |
| `ovld runner service status` | Show whether the OS service is installed/running, last launch time, and current poll interval. |
| `ovld runner service uninstall` | Remove the host OS registration. |
| `ovld runner service status --json` | Stable machine-readable status for desktop Settings and diagnostics. |

The service should run:

```text
ovld runner supervise
```

where `supervise` is an internal or hidden CLI subcommand that owns only the
long-lived loop and adaptive polling. Each poll should delegate to the same code
used by `ovld runner once`, not duplicate claim, worktree, terminal, or launch
logic.

## Why This Shape

This keeps the current runner contract intact. The new feature is an additional
CLI/runner management surface around the existing queue pipeline:

- no new execution-request status is needed;
- no database schema change is needed;
- no REST endpoint is required for the MVP;
- foreground `ovld runner start` remains useful for debugging and temporary use;
- the persistent path gets the same behavior as manual runner launches because it
  calls the same claim-and-launch implementation.

It also avoids making the desktop app responsible for local process supervision.
The CLI already owns user setup, terminal launch preferences, local config
resolution, and `ovld runner` commands, so installing the persistent runner through
the CLI is the least surprising user model.

The desktop app should still expose the feature, but as a UI over the CLI-owned
service surface rather than as an alternate runner implementation.

## Runtime Behavior

The supervisor should:

1. Load the same backend URL, auth, device fingerprint, project resource state, and
   terminal profile as normal `ovld runner` commands.
2. Poll the backend for claimable work.
3. If a request is claimed, call the shared runner launch implementation.
4. Record the latest successful claim/launch timestamp in local runner state.
5. Poll every 3 seconds while any job has launched in the last two hours.
6. Poll every 10 seconds after two hours with no launched jobs.
7. Return to 3-second polling immediately after a request is claimed or launched.

Use "last launched job" rather than "last poll with work" for the backoff clock.
That matches the product requirement and prevents a long series of empty polls
from keeping the runner hot.

The loop should include jitter of roughly 10 percent to avoid many local runners
waking at exactly the same cadence against a shared backend.

## Host Integration

Implement platform adapters behind one service-management abstraction:

| Platform | MVP integration |
| --- | --- |
| macOS | `launchd` user LaunchAgent under `~/Library/LaunchAgents/io.overlord.runner.plist`. |
| Linux | user-level `systemd --user` unit when available; fall back to a clearly documented foreground command if unavailable. |
| Windows | Defer, or add a follow-up using Task Scheduler after macOS/Linux are stable. |

The installed service should invoke the resolved `ovld` executable with an
explicit environment snapshot:

- `OVERLORD_BACKEND_URL` or `OVERLORD_BACKEND_URL_DEV`, matching the CLI profile;
- `OVERLORD_HOME` if configured;
- auth/token variables needed by the local CLI runtime;
- a minimal `PATH` sufficient to find the agent binaries or the user's configured
  launch wrappers.

Do not rely on interactive shell startup files. Persistent services usually start
with a sparse environment, and agent binaries installed through user shell
tooling are a common failure mode.

## Terminal Launching

The persistent runner should still open the agent through the existing terminal
launch path when a terminal profile is configured. That means a background
LaunchAgent or systemd unit claims the request, then `launchAgent` opens Terminal,
iTerm2, or the configured launcher with the same prompt/context environment as
`ovld runner start`.

For macOS, document that the terminal launcher may require Automation permissions
for `osascript` to control Terminal or iTerm2. The CLI should detect common
AppleScript failures and report an actionable message in the execution request's
`last_error`.

## Local State

Store persistent runner state under the existing Overlord home, for example:

```text
~/.ovld/runner-service.json
```

Recommended fields:

- installed service kind and service identifier;
- resolved `ovld` executable path;
- backend URL/profile used at install time;
- last supervisor heartbeat timestamp;
- last claimed request timestamp;
- last launched request timestamp;
- last error summary;
- current poll interval.

This is local diagnostic state only. It should not become a backend source of
truth for runner liveness in the MVP.

## Desktop Settings Interface

Add a persistent runner panel under desktop Settings. The panel should manage the
local machine's service by invoking the same CLI-owned service operations that a
user could run manually.

Recommended controls:

| UI control | Underlying operation |
| --- | --- |
| Enable persistent runner | `ovld runner service install --start` |
| Start | `ovld runner service start` |
| Stop | `ovld runner service stop` |
| Restart | `ovld runner service restart` |
| Disable persistent runner | `ovld runner service uninstall` |
| Refresh status | `ovld runner service status --json` |

The Settings panel should show:

- installed/not installed;
- running/stopped/errored/unknown;
- current poll interval;
- last supervisor heartbeat;
- last claimed request;
- last launched request;
- last error summary;
- configured backend URL/profile;
- local execution target label and resource availability;
- active queue rows relevant to this target.

The desktop app must not claim runner queue work directly and must not duplicate
terminal launch logic. It only starts, stops, installs, uninstalls, and monitors
the CLI-managed service. This keeps foreground CLI, persistent service, and
desktop controls pointed at one runner implementation.

## Remote Monitoring

Add remote monitoring in the same feature family, but keep remote control as a
separate later stage.

The local state file is enough when desktop and runner are on the same machine.
If the CLI runner is installed on a server and the desktop app is running on a
different machine, the supervisor must publish runner presence to the backend.

Recommended MVP:

1. `ovld runner supervise` posts heartbeat/status updates for its
   `execution_target_id`.
2. The backend stores the latest runner status per execution target.
3. Desktop Settings reads runner status from the backend for all visible targets.
4. Desktop displays stale/offline warnings when the latest heartbeat is too old.
5. Queue claim and launch still happen only on the machine where the runner
   service is installed.

Remote status should include:

- execution target id, label, hostname, and platform;
- service mode: `foreground`, `persistent`, or `unknown`;
- running state: `polling`, `stopped`, `errored`, `offline`, or `unknown`;
- last heartbeat timestamp;
- last poll timestamp;
- current poll interval;
- last claimed request timestamp;
- last launched request timestamp;
- last error summary;
- CLI version;
- backend URL/profile identity;
- visible active queue for that target, or enough IDs for the desktop app to join
  against the normal queue view.

Remote monitoring is a backend-observed liveness feature, so it does require a
contracted REST/status surface and likely a small persistence addition. It should
not rely on the desktop app having filesystem, SSH, or shell access to the remote
server.

## Remote Control Later Stage

Do not include remote start/stop/restart in the first persistent runner release.
Remote control requires a secure command channel from the backend to the runner
host, plus target capability flags, authorization checks, audit logs, command
expiry, command result reporting, and explicit user/admin opt-in.

Recommended later-stage commands:

- request remote restart;
- request remote stop;
- request remote self-update if supported;
- acknowledge or reject commands from the runner host;
- record command result and audit trail.

Until that stage exists, server operators install and start the service locally on
the server:

```bash
ovld runner service install --start
```

The desktop app can then monitor that server-side runner through backend
heartbeats, but cannot control its process lifecycle remotely.

## Contract Impact

This feature extends the stable CLI and Runner surfaces and should update the
contract before implementation:

- `CONTRACT.md` CLI Layer: add `ovld runner service ...` as CLI-owned management
  commands.
- `CONTRACT.md` Runner Layer: move "background service installation" from future
  behavior to owned runner behavior, and add runner status heartbeat ownership.
- `CONTRACT.md` REST API Layer: add the runner target status read/write surface
  for remote monitoring.
- `CONTRACT.md` Desktop Layer: state that desktop may manage only the local
  persistent runner through the CLI service-management interface, and may monitor
  remote runners through backend status.
- `cli/docs/01-command-reference.md`: add the service commands.
- `cli/docs/02-cli-first-product-surface.md`: add persistent runner setup to first
  run and runner command requirements.
- `cli/docs/04-runner-and-launch-execution.md`: define supervisor behavior,
  adaptive polling, platform support, desktop service status output, and remote
  heartbeat behavior.
- `desktop/docs/desktop-app.md`: add the Settings panel for local service control
  and local/remote runner monitoring.
- `webapp/docs/ui/04-execution-and-runner.md`: replace "copy `ovld runner start`"
  as the only fallback with "enable persistent runner" plus the existing foreground
  commands.

The local service-management feature should not need a contract version bump if it
is additive and does not alter existing command semantics. Remote monitoring may
need a contract update and possibly a version bump if it adds stable REST DTOs or
database fields that other components consume.

## Implementation Plan

1. Extract the current `runOnce` closure from `cli/src/commands.ts` into a shared
   runner module, preserving existing behavior for `runner once` and `runner start`.
2. Add `runner supervise` as the adaptive long-running loop over the shared
   one-shot function.
3. Add a service manager abstraction with macOS `launchd` support first.
4. Add `runner service install/start/stop/status/uninstall` commands.
5. Add local service state read/write and status output.
6. Add the desktop Settings panel for local service install/start/stop/status.
7. Add runner heartbeat publishing and backend runner-target status reads for
   remote monitoring.
8. Update the docs and contract files listed above.
9. Add unit tests for command parsing, adaptive interval selection, service file
   generation, and preservation of the existing foreground runner behavior.
10. Add an integration dry-run test proving the supervisor delegates to the same
   claim-and-launch path as `runner once`.

## Open Decisions

- Whether `runner service install` should also start the service by default. The
  recommended default is yes, with `--no-start` for packaging and tests.
- Whether `ovld setup` should offer persistent runner installation. The
  recommended default is to prompt after terminal launcher configuration, because
  the persistent runner depends on the same terminal settings.
- Whether Cloud edition should recommend a user token with `mission-lifecycle`
  scope for the service. The recommendation is yes, because the persistent runner
  should not depend on an expiring browser session.
- How aggressively remote runner heartbeats should expire. The recommended first
  threshold is offline after three missed polls plus 30 seconds of slack.
- Whether remote status belongs in the existing `/api/runner/status` response or a
  new execution-target status endpoint. The recommendation is a dedicated target
  status endpoint to keep local queue status and remote liveness distinct.

## Summary

Ship a CLI-managed persistent runner service, not a separate daemon package. Keep
`ovld runner start` and `ovld runner once` exactly as they are, and make the
persistent path a host supervisor over the same one-shot claim-and-launch
implementation. This gives users the hands-off queue-to-terminal experience while
preserving the transparent foreground runner for debugging, demos, and temporary
execution. Expose local service controls in desktop Settings immediately, add
remote monitoring through backend-published runner heartbeats, and defer remote
process control to a separate security-reviewed stage.
