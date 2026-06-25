# Remote Overlord Architecture Recommendations

Mission: `coo:23`
Objective: Design Remote Overlord Architecture
Date: 2026-06-25

## Executive Summary

Use the CLI as the installed runtime on every execution target, and keep
database access behind an Overlord backend service.

For remote headless runners with a cloud-hosted database, do not build a
second "headless app" that the CLI talks to on every target. The current
contract already has the right split:

```text
Desktop / web / CLI clients
        |
        | REST + protocol + runner APIs
        v
Overlord backend service
        |
        | service-layer transactions
        v
PostgreSQL / authoritative database

Remote execution target
        |
        | ovld runner start / system service
        v
local agent binaries + local checkout
```

The execution target needs `ovld`, agent connectors, a project checkout, a
`USER_TOKEN`, and a supervised `ovld runner` process. The backend service needs
to own auth, queue claiming, writeback, realtime, migrations, and the database
adapter.

For the target-hosted database variant, the same rule applies. Host the
database and backend service on the chosen execution target, then point Desktop
and other clients at that backend URL. Do not have Desktop or the published CLI
open the remote database directly. Direct database access would bypass auth,
service-layer state machines, idempotency, `mission_events`, `entity_changes`,
and realtime guarantees.

## Current Architecture Fit

The repository already points in this direction:

- `CONTRACT.md` says the published CLI talks to a configured backend URL over
  HTTP/JSON, while the backend owns service-layer/database mutations.
- `cli/src/backend-client.ts` sends CLI requests to `backend_url` with bearer
  auth.
- `cli/src/config.ts` already separates local and cloud backend URLs.
- `ovld runner once|start` claims through `/api/runner/*`, then launches the
  agent locally on the execution target.
- `USER_TOKEN` and the `mission_lifecycle` scope already cover non-interactive
  runner and agent lifecycle work.
- `execution_targets`, `project_resources`, `devices.last_seen_at`,
  `execution_requests.claimed_by_*`, and `claim_expires_at` already model most
  of the remote-runner coordination data.
- `entity_changes` plus `/api/stream` are the intended realtime substrate for
  Desktop and web clients.

The main gap is not the process split. The gap is operational hardening:
runner supervision, headless launch mode, online/offline target state, stale
claim recovery, target-specific project resource setup, and wakeup latency.

There is one important implementation caveat: the contract and database docs
describe PostgreSQL as the shared-deployment target, and Postgres migrations
exist, but the live `webapp/server/db.ts` path inspected for this report still
opens `better-sqlite3` directly. A cloud/private-network backend needs the
backend runtime to finish adapter selection and service-layer execution against
PostgreSQL before it can be treated as production-ready for distributed runners.

## Architecture 1: Cloud Backend And Headless Remote Runners

Recommended topology:

```text
Desktop / browser / local CLI
        |
        | HTTPS REST, SSE, protocol commands
        v
Hosted Overlord backend
        |
        | service-layer transactions
        v
Managed PostgreSQL

Remote target A/B/C
        |
        | outbound HTTPS polling or long-poll/SSE
        v
ovld runner service -> local worktree -> local agent -> ovld protocol deliver
```

### Recommendation

Install the CLI everywhere an agent may run. Do not install a full app on each
target.

The CLI should be the target runtime because it already owns the concerns that
are local to a machine:

- device fingerprint and execution-target identity;
- project checkout discovery and `.overlord/project.json`;
- agent connector install/repair;
- branch/worktree preparation;
- local command spawning;
- `--no-terminal` / headless execution behavior;
- protocol attach/update/deliver from the launched agent.

The backend service should own the shared concerns:

- auth and RBAC;
- execution request queueing and claiming;
- target and project resource records;
- stale claim and stale launch recovery;
- protocol writeback;
- realtime feed;
- database migrations and adapter selection.

This keeps the remote target as a client of the system, not another partial
authority over the database.

### What To Build

1. **Runner service mode in the CLI.**
   Add an installable/supervisable runner path: `ovld runner install-service`,
   `ovld runner uninstall-service`, `ovld runner logs`, and a hardened
   `ovld runner start` loop suitable for `systemd`, `launchd`, or containers.
   This can build on the prior background-daemon planning, but remote targets
   should default to headless launch behavior.

2. **Headless launch profile.**
   A remote server will often have no GUI terminal. The runner should support a
   first-class headless profile that runs the agent without AppleScript or a
   terminal app, captures stdout/stderr to per-request logs, and reports launch
   failure reliably. If agents need an inspectable TTY, prefer `tmux` or another
   explicit multiplexer profile over assuming an interactive terminal.

3. **Target registration and heartbeat.**
   The runner should register or refresh its `devices` / `execution_targets`
   rows on start, update `last_seen_at`, expose connector readiness, and keep a
   heartbeat while polling. This lets the UI show "online, idle, busy, stale,
   disabled" without guessing from queue state alone.

4. **Target-scoped project resources.**
   Each remote target needs a project checkout path registered as a
   `project_resources` row scoped to that target. Queueing should fail early or
   warn clearly when a selected target has no active resource path for the
   project.

5. **Reliable wakeup.**
   Polling is acceptable for the first version, but the durable shape should be
   outbound from the runner to the backend, not inbound from the backend to a
   private device. Add long-poll or runner SSE later so a queued request wakes
   the target quickly while still using the same atomic claim endpoint.

6. **Central execution-request state machine.**
   Before expanding remote runners, consolidate request queue/claim/launch/fail
   logic as recommended in the prior report. Remote runners magnify the current
   duplicated state handling and stale-launch gaps.

### Why Not A Headless App On Every Runner

A "headless app" on every target would either duplicate the backend service or
become a thin wrapper around `ovld runner`. Duplicating the backend on every
target creates unclear ownership over migrations, auth, queue semantics,
realtime, and database access. A wrapper around `ovld runner` is just service
supervision; that belongs in the CLI/runner layer.

There is still room for a backend package, but it should be the state-hosting
service, not the runner runtime. In other words:

- **yes:** `ovld serve` / packaged backend service for the machine or cloud
  deployment that owns the database;
- **yes:** `ovld runner` installed on every execution target;
- **no:** a separate app process on every target just so the CLI can trigger a
  runner.

### Operational Tradeoffs

Benefits:

- Remote targets only need outbound HTTPS to the backend.
- The backend remains the single policy and state authority.
- Runners can be added, removed, or rotated without moving the database.
- Managed PostgreSQL gives safe multi-writer queue claiming and backups.
- Desktop can observe remote runner changes through the existing realtime feed.

Costs:

- Requires hosted backend uptime.
- Requires token provisioning and rotation for headless devices.
- Requires a real runner service story, logs, and diagnostics.
- Requires target-specific setup for checkouts and agent binaries.

## Architecture 2: Backend And Database Hosted On An Execution Target

Recommended topology:

```text
Desktop / browser / other CLI clients
        |
        | HTTPS or VPN/private-network REST + SSE
        v
Execution target hosting Overlord backend
        |
        | local service-layer transactions
        v
SQLite or PostgreSQL on that target

Same target runner
        |
        | loopback REST to local backend
        v
local checkout -> local agent -> ovld protocol deliver
```

### Recommendation

This is viable, but treat the target as an Overlord server, not as a shared
database file.

Run the backend service on that target and point Desktop at its backend URL. The
runner on that same target can use the loopback URL or the private-network URL,
but it should still use REST/protocol APIs. Desktop should show changes through
the backend's SSE/sync surface.

Use this topology for a private lab, home server, on-prem workstation, or
air-gapped-ish environment where one machine is expected to stay online. Use
the cloud-hosted backend topology when availability, backups, multi-site access,
and low-friction remote runners matter more.

### Database Choice

Prefer PostgreSQL if more than one machine or process family will write
meaningful shared state over time.

SQLite can be acceptable only when one backend process owns the SQLite file and
every other client, including local CLI and local runner, goes through that
backend. Do not mount or share the SQLite file across machines. Do not point
Desktop at a remote SQLite file.

PostgreSQL is the safer default for this topology because the target-hosted
machine is now a shared server. It gives better concurrent writer behavior,
backup tooling, row-level queue coordination, and a clearer migration path if
the deployment later grows beyond one target.

### Desktop Implications

Current Desktop is specified as a loopback shell that supervises a local server.
For this topology, Desktop needs a client-only remote mode:

- configure `backend_url` to the target-hosted backend;
- require real auth for non-loopback access;
- allow the configured remote origin in CSP/connect-src;
- do not fork a local server in that mode;
- use the same REST and SSE surfaces as the browser UI;
- pass a `USER_TOKEN` to any spawned CLI process.

This is a Desktop contract change if implemented. The current contract says the
shell loads the SPA over loopback and supervises local processes. A remote
client mode should be documented explicitly before code changes.

### Why Direct DB Access Is The Wrong Shape

Letting Desktop open the target database directly sounds simpler, but it breaks
the architecture:

- Desktop would bypass REST auth and RBAC.
- Client writes could miss `mission_events` and `entity_changes`.
- Queue claiming could drift from the runner/service implementation.
- Realtime would become database-driver-specific instead of service portable.
- The published CLI would violate its client-only contract if it opened the DB.
- Schema migrations and adapter selection would become client concerns.
- Secret handling would move from backend deployment to every client device.

If the project intentionally wants direct database access from Desktop, the
contract would need a major change: Desktop would become a database client,
auth/realtime would need new ownership rules, and the CLI client-only guarantee
would no longer hold. I do not recommend that direction.

### Operational Tradeoffs

Benefits:

- Can run entirely inside a private network.
- Avoids a hosted cloud dependency.
- The runner and backend can be physically close to the checkout and agent
  environment.
- Desktop can still get realtime updates through SSE if it connects to the
  backend service.

Costs:

- The execution target becomes critical infrastructure.
- You need DNS/VPN/TLS/firewall setup for Desktop access.
- Backups and restore are now your responsibility.
- If the target sleeps or reboots, both UI and runner coordination go down.
- Remote Desktop mode needs explicit auth and CSP work.

## CLI Versus Headless App Decision

Use this split:

| Need | Owner |
| --- | --- |
| Run an agent on a device | CLI Runner Layer (`ovld runner`) |
| Install/repair agent connectors | CLI / Connector Layer |
| Supervise a long-lived runner | CLI Runner service mode |
| Queue, claim, expire, and audit execution requests | Backend service / REST |
| Store and migrate the authoritative database | Backend service / Database Layer |
| Show UI and realtime state | Web/Desktop as REST/SSE clients |
| Host state without a UI | Backend service package (`ovld serve` or successor) |

So the answer is not "CLI only" or "headless app only." It is:

1. Put runner functionality in the CLI and install the CLI on every execution
   target.
2. Keep the backend service as the only process that owns the database.
3. Package the backend service separately enough that it can run headlessly on
   a cloud host or on a chosen execution target.
4. Keep Desktop optional and client-oriented outside the single-machine local
   mode.

## Implementation Sequence

1. Finish execution-request state-machine cleanup from the prior report:
   central status transitions, claim expiry, stale launched-without-attach
   recovery, and request-to-session correlation.
2. Add runner identity and heartbeat: register device/target on start, update
   `devices.last_seen_at`, record `claimed_by_device_id` and
   `claimed_by_execution_target_id`, and expose target readiness in
   `runner status`.
3. Add target-scoped project resource setup and validation UX:
   `ovld add-cwd --target current`, remote target readiness checks, and UI
   warnings before queueing a run to a target with no checkout.
4. Add a headless runner launch profile with logs and no GUI terminal
   assumptions.
5. Add runner service supervision for macOS/Linux/container deployments.
6. Add long-poll or SSE runner wakeups after polling is correct.
7. Package a backend-service deployment path for cloud/private-network hosts.
8. Add Desktop remote-client mode only after auth, CSP, and backend URL
   selection are contractually specified.

## Contract Impact

This report changes no runtime behavior and does not require a contract bump.

Future implementation should update the contract before code changes in these
cases:

- Additive runner commands such as `install-service`, `logs`, or service
  supervision flags belong to the Runner/CLI Layers and should be documented in
  `CONTRACT.md` and CLI docs.
- New REST endpoints such as runner heartbeat, runner long-poll/SSE, target
  readiness, or target registration should be added to the REST/Runner
  interaction surfaces before implementation.
- A Desktop remote-client mode changes the Desktop Shell contract, because the
  current spec is loopback-local and supervises a local backend.
- New closed vocabulary values would require a version bump. Avoid this by
  reusing existing execution request statuses and existing `local` execution
  targets for devices where the runner executes locally, even when the backend
  observes them as remote devices.
- Direct database access from Desktop or the published CLI would be a major
  contract violation unless the contract is deliberately rewritten. Avoid it.

## Bottom Line

For cloud-hosted state, install and supervise `ovld runner` on remote devices and
keep all database writes behind a hosted Overlord backend.

For target-hosted state, run the backend service and database on that target,
then point Desktop and runners at the backend URL. Do not expose the database as
the client API.

The unifying principle is: runners are local executors; the backend is the
state authority; Desktop is a client.
