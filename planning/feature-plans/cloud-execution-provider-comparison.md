# Cloud Execution Provider Comparison

Mission: `coo:33`
Date: 2026-06-25

## Summary

The cleanest first hosted architecture is:

1. Run the Overlord backend/API as a hosted service.
2. Use hosted Postgres as the system of record.
3. Keep all execution targets as outbound-only runners, whether they run on a user's laptop, a home server, a Railway container, or a Daytona sandbox.
4. Keep the desktop app and web app as control surfaces that talk only to the backend REST/protocol/realtime API.

My recommendation is to start with **Neon for Postgres** and **Railway for the hosted backend plus the first managed cloud runner target**. Treat **Daytona as a second-phase sandbox provider** for short-lived or per-session agent environments once the generic cloud execution-target contract is stable.

This keeps the user-facing model simple: "install a runner somewhere, then select it as the target." The managed cloud runner should look like a runner we provisioned and maintained for the user, not like a separate product mode.

## Current Overlord Contract Fit

The existing contract already has the right core split:

- The Protocol Layer owns `attach -> update/heartbeat -> ask/deliver`.
- The Runner Layer owns execution request claiming and launch.
- The REST API Layer owns the queue endpoints and realtime stream.
- The Database Layer already names PostgreSQL as the authoritative database for shared deployments and SQLite as the local development/default workstation database.
- Realtime is already designed around `entity_changes` plus `/sync/changes` catch-up and `/realtime` streaming, with Postgres `NOTIFY` only an adapter optimization.

The important architectural implication is that a cloud runner should not need inbound network reachability. It should authenticate to the Overlord backend, poll or long-poll for claimable work, launch the agent locally inside its execution environment, and send protocol updates back through the same backend.

## Provider Roles

### Neon

Use Neon as the hosted Postgres database for the Overlord control plane.

Strengths:

- It is serverless Postgres with autoscaling, branching, instant restore, and direct Postgres compatibility.
- Database branching is a good fit for staging, preview, and migration rehearsal. A branch is an isolated copy-on-write clone that can be created from current or historical data.
- Connection pooling is built around PgBouncer and supports many client connections, which helps if the backend scales out or if desktop/web clients open many API-backed sessions.
- Logical replication exists, but using it for the main realtime UI would be a mistake for MVP because active replication prevents scale-to-zero and inactive replication slots have cleanup behavior.

Risks and constraints:

- Do not couple desktop/web realtime directly to Postgres `LISTEN/NOTIFY`. Neon pooled connections have PgBouncer transaction-pooling caveats; session features such as `LISTEN/NOTIFY` do not fit the pooled path. The backend can use a direct connection for notifications, but the contract's portable `entity_changes` feed should remain canonical.
- Treat Neon branching as an operations and development tool, not as the primary per-user execution filesystem. It solves database isolation, not repository persistence.
- For production, the backend should own DB credentials. Desktop, web, CLI, and runners should use user/service tokens against REST/protocol endpoints, not connect directly to Neon.

Recommended use:

- Primary Overlord hosted database.
- Optional database branches for staging, preview deployments, migration rehearsal, and customer support snapshots.
- Maybe read replicas later for analytics or heavy read-only dashboards, but not needed for the first cloud execution feature.

### Railway

Use Railway for the Overlord hosted backend and, optionally, the first managed persistent cloud runner service.

Strengths:

- Railway services are containers. They can be deployed from GitHub, a local directory, or Docker images.
- Persistent services are intended for always-running backend APIs, queues, and database-adjacent services.
- Private networking lets Railway services in the same project communicate over internal DNS without public exposure.
- Volumes give persistent storage for services, with manual and automated backups. This is useful for a per-user cloud runner that needs persistent repos, package caches, local Supabase state, and agent CLI state.
- Railway has public HTTP endpoints for the backend and TCP proxy support for database access, though Overlord should avoid exposing direct DB access to clients.

Risks and constraints:

- Volumes are per service and have limitations: one volume per service, no replicas with volumes, brief downtime during redeploys with attached volumes, and plan-dependent size limits. That means a cloud runner with a volume is a single-instance stateful target, not horizontally scalable infrastructure.
- Railway Postgres templates are convenient but documented as unmanaged templates. For Overlord's primary hosted control database, Neon is a better specialized fit.
- A Railway volume-backed runner is closer to a small managed workstation than to an elastic sandbox pool. That is good for the "home server in the cloud" experience, but less good for high fan-out ephemeral jobs.

Recommended use:

- Host the Overlord backend/API service.
- Run a "managed cloud target" container per user or per workspace with:
  - persistent volume mounted at `/home/overlord`;
  - `ovld runner start`;
  - registered cloud execution target;
  - outbound-only access to Overlord backend, Git providers, package registries, and user-selected agent providers;
  - optional preinstalled toolchains and local Supabase/Docker-compatible alternatives if Railway's environment permits them.

### Daytona

Use Daytona for isolated agent sandboxes, not as the first control-plane database or backend host.

Strengths:

- Daytona is purpose-built for AI code execution sandboxes with dedicated kernel, filesystem, network stack, vCPU, RAM, and disk.
- The SDK/API/CLI expose sandbox lifecycle, filesystem operations, process execution, and runtime configuration.
- Snapshots can capture prepared environments so future sandboxes start from a known toolchain state.
- Volumes and external storage mounts can persist data beyond a sandbox and can be mounted into one or more sandboxes.
- The model maps well to agent sessions: create sandbox, clone or mount repo, run `ovld runner once` or an equivalent one-shot launcher, stream updates back, and clean up or snapshot afterward.

Risks and constraints:

- Daytona volumes are FUSE-based and their docs explicitly say they are not appropriate for applications requiring block storage access such as database tables. That makes them weaker for "persist local Supabase Postgres data inside the volume."
- Daytona is a sandbox fabric, not the obvious place to run the main Overlord backend or primary Postgres.
- The user experience will be different from a home server unless Overlord hides sandbox lifecycle and makes persistent volumes/snapshots feel like a stable named target.

Recommended use:

- Second-phase "ephemeral cloud sandbox" or "resettable cloud workspace" provider.
- Per-mission or per-objective sandboxes when isolation is more important than long-lived local state.
- Snapshot-backed templates: "Node + pnpm + Supabase CLI", "Python + uv", "Rails", etc.
- Shared persistent repository/cache volume only for compatible filesystem workloads, not for embedded database state that needs block-storage semantics.

## Recommended Architecture

### Control Plane

- Backend/API: Railway service, Vercel service, or another always-on Node host. Railway is the simplest of the evaluated providers for this if we also want cloud runner containers nearby.
- Database: Neon Postgres.
- Realtime: backend keeps the existing `/realtime` and `/sync/changes` contract. Postgres `NOTIFY` can wake backend workers, but `entity_changes` remains the durable source.
- Desktop app: Electron shell that points at either:
  - local loopback backend for local-only mode;
  - hosted backend URL for cloud mode.
- Web app: same hosted backend.

### Execution Plane

Every target should implement the same runner contract:

1. Target registers with the backend and receives a stable `execution_target_id`.
2. Target sends periodic heartbeat with target type, label, capabilities, health, and active resources.
3. User links one or more project resources to that target.
4. User queues an objective to a selected target.
5. Runner claims a compatible request atomically through the backend.
6. Runner resolves the target-local path, prepares branch/worktree, launches the agent, and sends protocol updates back.

Target types should become:

- `local`: existing laptop or workstation runner.
- `cloud_persistent`: long-lived cloud runner with durable filesystem.
- `cloud_sandbox`: Daytona-style provisioned sandbox, possibly created just in time.
- `ssh`: future bring-your-own remote host.

### Managed Cloud Runner On Railway

The fastest coherent managed offering is a Railway volume-backed service:

- One service per workspace or one service per user target.
- One attached volume for repos, package caches, `.overlord`, toolchain state, and user-level agent config.
- Container image maintained by Overlord with Node, Git, `ovld`, common package managers, and optional language toolchains.
- Service command runs a small Overlord runner daemon:
  - `ovld cloud-target start` or `ovld runner start --target <id>`;
  - heartbeat loop;
  - queue claim loop;
  - setup doctor;
  - optional command execution API mediated by backend auth.
- No public inbound port required for agent execution. The backend can expose logs/status through protocol events.

The UI should present this as "Create cloud computer" or "Create managed target", then show a target details page with:

- target status, storage usage, last heartbeat;
- linked repositories/resources;
- installed agents and auth status;
- shell/setup commands;
- reset/rebuild/snapshot controls;
- clear "data lives on this target" language.

### Daytona Sandbox Target

The Daytona integration should be provider-adapter based:

1. User chooses "Run in disposable sandbox" or "Run in resettable cloud workspace."
2. Backend asks Daytona to create a sandbox from a snapshot.
3. Backend injects a short-lived Overlord service token and launch context.
4. Sandbox runs the Overlord runner or a one-shot launcher.
5. Agent work is synced back through Git branches and protocol delivery.
6. Sandbox is stopped, deleted, or snapshotted depending on policy.

This is ideal for risky or parallel work, but it should not be the first default for users who expect a durable remote workstation with local databases.

## UX Ideas For A Seamless Experience

- Keep the same target picker for local, home server, Railway, and Daytona targets.
- Make setup copy/paste oriented:
  - "Install runner on this machine" gives `ovld auth login` and `ovld runner start`.
  - "Create cloud target" provisions the container and returns when it has heartbeated.
- Add a target readiness checklist:
  - backend connected;
  - Git provider connected or repo cloned;
  - agent CLI installed;
  - agent provider auth present;
  - project resource linked;
  - package manager caches warmed.
- Add target capabilities:
  - can persist repos;
  - supports Docker or local Supabase;
  - supports browser preview;
  - supports multiple concurrent jobs;
  - supports snapshots;
  - supports idle shutdown.
- Let users pin a project default target and override per objective.
- For cloud targets, make "Open shell" and "Open repo" first-class actions, but route them through audited backend sessions rather than requiring direct SSH at first.
- Keep secrets target-scoped. Agent provider tokens should live on the execution target or in a server-side secret store and should never be returned to desktop/web clients.
- Show data gravity clearly: "This repo path exists on cloud-target-1, not on this laptop."
- Preserve the home-server mental model: a managed cloud target is just another runner with a filesystem and a heartbeat.

## Contract Changes Needed Before Implementation

Do not implement the provider integrations without updating the contract first. Proposed deltas:

1. Database Layer:
   - Widen `execution_targets.type` open/core values from `local` toward `local`, `cloud_persistent`, `cloud_sandbox`, and future `ssh`.
   - Add nullable provider metadata to `execution_targets` or namespaced `settings_json` keys for provider, region, provisioned service id, lifecycle state, storage stats, and capability flags.
   - Add target heartbeat fields or a dedicated target status table if current `devices.last_seen_at` is too local-device-specific.
   - Add a resource location model that distinguishes local paths from provider paths and sandbox workspace paths.

2. REST API Layer:
   - Add target provisioning endpoints for managed cloud targets.
   - Add target heartbeat/status endpoints for non-local runners.
   - Add provider-neutral target capability DTOs.
   - Keep runner queue endpoints as the claim/launch boundary.

3. CLI Layer:
   - Add `ovld config set` cloud onboarding polish if missing.
   - Add runner registration for non-local targets.
   - Add a no-persist-config mode for containers, using injected backend URL and service token.
   - Add target doctor commands that report missing agent CLIs, Git credentials, package managers, and local services.

4. Runner Layer:
   - Make the runner target-aware beyond device fingerprint.
   - Add capability matching when claiming requests.
   - Add cloud-safe path resolution and branch/worktree root defaults.
   - Preserve outbound-only polling as the baseline; optionally add server push later.

5. Auth Layer:
   - Add scoped service tokens for cloud targets.
   - Add revocation and rotation flows for provisioned runners.
   - Ensure tokens can claim only requests assigned to their target/workspace.

6. Web/Desktop:
   - Add target creation and target detail surfaces.
   - Update the launch picker to show local, home server, managed persistent, and sandbox targets with readiness/health.
   - Make offline/realtime states cloud-aware.

Contract impact is significant but mostly additive if target type remains an open vocabulary and provider metadata is namespaced. The highest-risk stable surface is queue claiming: it must remain centralized in service-layer transactions and must not let provider adapters claim work directly from database internals.

## Phased Plan

### Phase 1: Hosted Control Plane

- Deploy backend against Neon Postgres.
- Verify Postgres adapter conformance around `entity_changes`, queue claim atomicity, and idempotency.
- Keep local and home-server runners as the execution targets.
- Desktop app connects to hosted backend and receives realtime updates through existing API.

### Phase 2: Home Server And BYO Remote Runner

- Harden target registration, heartbeat, and project resource linking.
- Let users install `ovld` on another machine and link it with a short code or token.
- Target picker supports choosing that remote runner.
- No provider-specific cloud provisioning yet.

### Phase 3: Railway Managed Persistent Target

- Provision Railway service plus volume from Overlord.
- Register it as `cloud_persistent`.
- Run `ovld runner start` in the container.
- Add target shell/setup UX and readiness checks.
- Use this for users who want persistent repos and local services.

### Phase 4: Daytona Sandbox Target

- Add provider adapter for just-in-time sandbox creation.
- Use snapshots for warm environments.
- Run one-shot agent jobs in isolated sandboxes.
- Sync results back through Git branches and protocol delivery.
- Position this as "disposable/resettable sandbox", not as the default persistent workstation.

## Source Notes

- Neon docs: https://neon.com/docs/introduction, https://neon.com/docs/introduction/branching, https://neon.com/docs/connect/connection-pooling, https://neon.com/docs/guides/logical-replication-neon
- Railway docs: https://docs.railway.com/services, https://docs.railway.com/databases/postgresql, https://docs.railway.com/volumes/reference, https://docs.railway.com/networking/private-networking
- Daytona docs: https://www.daytona.io/docs/llms.txt, https://www.daytona.io/docs/llms-full.txt
