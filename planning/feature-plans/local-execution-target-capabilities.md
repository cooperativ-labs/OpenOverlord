# Local Execution Target Capabilities

**Status:** Proposal (planning only)
**Date:** 2026-06-28
**Contract baseline:** `0.58-draft`
**Layers:** REST API Layer (`rest`), Runner Layer (`runner`), CLI Layer (`cli`), Desktop Shell (`desktop`)
**Related plans:**
[`overlord-cloud-architecture.md`](overlord-cloud-architecture.md),
[`runner-background-daemon.md`](runner-background-daemon.md),
[`objective-launch-execution-flow-review.md`](objective-launch-execution-flow-review.md)
**Rollout / execution & legacy removal:**
[`local-execution-target-rollout.md`](local-execution-target-rollout.md)

---

## 1. Problem

The hosted backend exposed an architectural inconsistency: some backend code
still assumed it was co-located with a user's checkout and could call
`existsSync`, read repository trees, run `git`, manage worktrees, and write
`.overlord/project.json`.

That was convenient in the original local-only topology because the SQLite
backend, desktop shell, CLI, and checkout were often on the same laptop. It is
the wrong boundary for Overlord Cloud. A hosted backend on Railway cannot see
`/Users/...`, and it should not be able to read or mutate source files even if a
path string is stored in the database.

The target architecture should make local and hosted backends interchangeable:

- the backend is the DB/control plane;
- local execution targets own filesystem and Git work;
- a "local" target may be the user's laptop, a VM with only the CLI installed,
  or a future managed runner.

## 2. Design Principle

**All checkout-local work must run on an execution target, never on the backend.**

The backend may:

- authenticate users and tokens;
- persist project/resource/mission/objective state;
- queue execution requests;
- own runner claim/launch state transitions;
- serve realtime/sync feeds;
- receive protocol and runner writebacks;
- store backend-owned files such as uploads, static assets, logs, and local DB
  files.

The backend must not:

- derive linked-resource availability from the backend host filesystem;
- write `.overlord/project.json` into a linked checkout path;
- read repository trees from linked checkout paths;
- run `git status`, `git diff`, `git worktree`, `git commit`, `git push`, or
  equivalent checkout-local commands;
- manage worktree directories for a user's project from the backend host.

Local execution targets own:

- `.overlord/project.json`;
- directory existence and resource observations;
- repository tree reads;
- branch and worktree preparation;
- Git status/diff/commit/push/worktree actions;
- agent launch;
- changed-file capture;
- local diagnostics such as target doctor checks.

## 3. Target Model

```text
                         ┌──────────────────────────────┐
                         │ Backend / control plane       │
                         │ REST + protocol + realtime    │
                         │ queue + DB transactions       │
                         └──────────────┬───────────────┘
                                        │ HTTPS
                                        ▼
       ┌──────────────────────────────────────────────────────────┐
       │ Local execution target                                   │
       │ desktop helper, ovld runner, or CLI-only VM              │
       │                                                          │
       │ - filesystem                                             │
       │ - git/worktrees                                          │
       │ - agent process launch                                   │
       │ - local observations/writebacks                          │
       └──────────────────────────────────────────────────────────┘
```

Local SQLite and hosted Postgres deployments use the same product model. The
only difference is where the control-plane database lives, not where checkout
work runs.

### 3.1 Requirements this plan must satisfy

This plan exists to deliver four specific outcomes. Each phase below is tagged
with the requirement(s) it advances.

1. **Interchangeable backends (R1).** Local SQLite and hosted Postgres are
   selected by configuration only; no product feature may depend on the backend
   being co-located with a checkout.
2. **One generalized client-side mechanism (R2).** All checkout-local work
   (Git, worktrees, file/metadata writes, observations, agent launch) goes
   through a single local-target capability interface with pluggable transports
   — never through ad-hoc `existsSync`/`git` calls scattered across layers.
3. **Queue-here / run-there (R3).** A CLI-only device that is logged in and
   selected as a project's current execution target must be able to claim and
   run work that was *queued from a different surface* (e.g. the Run button in
   the desktop app on a laptop), with no inbound connection to the runner.
4. **Slim, single-purpose cloud backend (R4).** The hosted backend image ships
   only what a Postgres control plane needs. Local-only artifacts (SQLite
   migrations, `better-sqlite3`, the SPA static bundle if served elsewhere)
   must not be baked into the cloud image, and generated build artifacts must
   not be committed as if they were source.

### 3.2 Known correctness gap: target identity is derived from the *backend* host

`ensureLocalExecutionTarget` (`packages/core/service/execution-targets.ts`)
resolves "the local execution target" from `getDevice(ctx)` — the device
fingerprint of **whatever process is running the service layer**. It is used in
two very different places:

- request creation (`webapp/server/launch.ts`), and
- request claiming (`claimNextExecutionRequest` in
  `packages/core/service/execution-requests.ts`).

In the Local edition the backend *is* the laptop, so this conflation is
harmless. In Cloud it is wrong twice over: the hosted backend invents a bogus
`local` target for the Railway host, stamps queued requests with it at creation
time, and would "claim" on behalf of a machine that has no checkout. This single
abstraction is the root of both the R1 and R3 problems and must be split:

- **Claiming** must use the identity of the *runner/CLI process* that is
  polling — never the backend's. This is already half-true (the runner CLI runs
  the claim against its own device) but only because today the runner and
  backend are the same process in Local mode.
- **Creating** a request must stamp the *selected* target (see §6.1), not the
  creator's device.

## 4. Capability Interface

Introduce one internal local-target capability interface. The first
implementation can be in-process for Desktop/CLI/local runner, but all product
features should depend on the interface rather than directly on backend
filesystem calls.

Initial capabilities:

| Capability | Purpose |
| --- | --- |
| `writeProjectMetadata` | Create/update `.overlord/project.json` after the backend creates a resource. |
| `observeResource` | Report whether a linked directory exists and whether it is accessible on this target. |
| `readRepositoryTree` | Read a repository/file tree for UI browsing. |
| `listBranches` | Return local and remote branch names for a project resource. |
| `prepareBranch` | Create/check out the branch/worktree for an execution request. |
| `listWorktrees` | Enumerate Overlord-managed local worktrees. |
| `removeWorktree` | Remove one local worktree, with dirty-worktree protection. |
| `purgeMergedWorktrees` | Remove clean merged worktrees. |
| `readCurrentDiff` | Read current Git diff/status for a mission file. |
| `generateCommitMessageFromLocalDiff` | Gather local diff and call the summarizer. |
| `launchAgent` | Spawn the selected agent with the resolved context. |
| `doctor` | Check local tools, credentials, Git state, package managers, and agent CLIs. |

### Response Shape

Capabilities should return typed results with:

- `ok: true` plus a payload on success;
- `ok: false`, a stable error code, a short message, and optional details on
  failure;
- enough target metadata to explain where the operation ran.

Avoid throwing raw filesystem/Git errors across REST boundaries.

### Transport & Providers (R2)

The capability interface is the *generalization point* — callers depend on it,
not on how the work reaches a target. Define one interface and several
interchangeable **provider transports** behind it:

| Provider | When used | Latency |
| --- | --- | --- |
| **In-process** | Local SQLite backend co-located with the checkout; the local runner acting on its own machine. | direct call |
| **Desktop bridge** | Desktop-hosted SPA driving the laptop it runs on (e.g. directory picking, metadata writes). Uses the existing `window.overlord` preload bridge. | IPC |
| **Runner queue** | Any surface (web, or Desktop in remote-client mode) driving a target it is not co-located with — including the R3 "queue-here / run-there" case. Outbound-poll only; **no inbound port to the target, ever**. | poll round-trip |

Callers select a *target*, not a transport; the resolver picks the transport
from the target's type and reachability. This keeps R1 honest: the same product
code works whether the chosen target is in-process, across an IPC bridge, or a
CLI-only VM on the other side of the runner queue. Capability results already
carry target metadata (above) so the UI can show *where* an operation ran.

## 5. Resource State Split

Split resource state into two concepts.

### Resource Lifecycle

Stored by the backend:

- `active`
- `archived`
- future backend-owned lifecycle values

This is durable project metadata. It does not answer whether the path exists on
any specific machine.

### Target Observation

Reported by a local execution target:

- `available`
- `missing`
- `unreachable`
- `permission_denied`
- `not_git_repository`
- `unknown`

This is target-scoped and time-sensitive. It may be cached with `observedAt`, but
the backend should not infer it from its own filesystem unless the backend is
explicitly acting as a local target through the same capability interface.

## 6. API Routing

REST endpoints should become control-plane endpoints, not direct checkout
operators.

| Current behavior | Target behavior |
| --- | --- |
| `POST /api/projects/:id/resources` records resource and writes local metadata in some modes. | Backend records the resource. Local target writes `.overlord/project.json`. |
| `GET /api/projects/:id/resources` derives `missing` from backend `existsSync`. | Backend returns lifecycle status plus optional latest target observations. |
| `GET /api/projects/:id/repository` reads backend-host filesystem. | Request is routed to a selected local target, or returns `LOCAL_TARGET_REQUIRED`. |
| Branch/worktree actions run in `webapp/server/repository.ts`. | Actions are local target jobs or direct local target calls. |
| Commit-message drafting reads diff on backend host. | Local target gathers diff; backend may still call AI summarizer if needed. |
| Launch creates queue item and local backend may inspect path before queueing. | Queue creation records desired target/resource; runner validates local path on claim/launch. |

## 6.1 Execution Target Selection — "queue here, run there" (R3)

The product must let a user queue work on one surface and have it execute on a
different device. Concrete acceptance case: clicking **Run** in the desktop app
on a laptop launches the agent on a VM, *because* that VM has the CLI logged in
and is set as the project's current execution target.

Today this cannot work, because request creation stamps
`execution_requests.execution_target_id` with the creator's own derived `local`
target (see §3.2). To support R3:

### Current target as first-class state

- Introduce a **current/selected execution target** preference, scoped per
  `(workspace_user, project)` (fall back to a workspace- or user-level default
  when a project has none). It is durable control-plane state, not a property of
  the device that happens to be clicking.
- Surface it: `GET/PUT /api/projects/:id/execution-target` (or an equivalent
  preference endpoint) returning the selected target plus the list of targets
  that can reach the project's primary resource (joined from
  `workspace_user_execution_targets` and reported observations from §5).
- Web, Desktop, and CLI all read/write the same preference, so the selector is
  consistent regardless of where the user is sitting.

### Request creation stamps the *selected* target

- `launch.ts` request creation resolves `execution_target_id` from the selected
  target, **not** from `ensureLocalExecutionTarget`. If no target is selected,
  fall back to: the single available target, or leave `NULL` to mean "any
  eligible target may claim."
- The claim filter `execution_target_id IS NULL OR = ?` already supports this;
  the only change needed is that the *VM's* runner claims with its own target
  identity (§3.2) and the request carries the VM's target id, so the laptop's
  desktop process never claims it.

### Eligibility, not just identity

- A request should only be claimable by a target that can actually reach the
  resource. Combine target identity with the §5 observation (`available` on that
  target) and the §3.55-draft capability flags so a selected-but-`missing`
  target surfaces a clear "target can't see this checkout" error instead of a
  silent no-op.
- Wakeup stays outbound-only (runner poll → long-poll/SSE per
  `runner-background-daemon.md`); the laptop never needs to reach the VM.

### Exit criteria

- Selecting a CLI-only VM as a project's current target and clicking Run in
  Desktop (or the web app) on another machine launches the agent on the VM.
- The originating surface can go offline after queueing without blocking the
  run.
- A request targeted at a specific device is never claimed by a different one.

## 7. Local Backend Compatibility Adapter

Do not preserve a separate "local backend can touch files" path long-term.

Instead, provide a compatibility adapter:

- Local Desktop mode starts or embeds a local target provider.
- Existing local REST/UI flows call the same local-target interface.
- During migration, the provider may run in the same process as the local
  backend, but the code boundary is the target capability interface.
- Once callers are moved, direct `existsSync`/`git` calls in backend repositories
  are removed.

This preserves local-only ergonomics without keeping a divergent architecture.

## 8. Phased Implementation

### Phase 0 — Stabilize Current Cloud Correctness (R1)

Already started under contract `0.57-draft` / `0.58-draft`:

- hosted backend stops writing `.overlord/project.json`;
- CLI/Desktop write local metadata after backend resource creation;
- hosted backend stops marking resources `missing` from Railway filesystem;
- hosted backend degrades/rejects checkout-local Git/worktree operations.

Exit criteria:

- linked resources in remote Desktop mode do not show as missing merely because
  the hosted backend cannot see the path;
- `ovld add-cwd` against Cloud writes local `.overlord/project.json`;
- branch/worktree actions against Cloud fail with a clear local-target-required
  message rather than operating on backend paths.

### Phase 1 — Extract Local Capability Module (R2)

Create a local target module with the capability interface and move existing
filesystem/Git helpers behind it.

Initial source candidates:

- `webapp/server/repository.ts` branch/worktree helpers;
- `packages/core/service/projects.ts` project metadata and resource status
  helpers;
- `packages/core/service/changes.ts` Git status/diff reads;
- `packages/core/service/execution-requests.ts` working-directory validation;
- `cli/src/branch-preparation.ts`;
- `cli/src/vcs.ts`;
- `desktop/src/ipc.ts` local metadata bridge.

Exit criteria:

- no product code calls checkout-local filesystem/Git helpers without going
  through the local target capability interface;
- local and cloud test harnesses can swap in a fake target provider.

### Phase 2 — Target Observation API (R1, R3)

Add target-scoped resource observations.

Suggested backend surfaces:

- `POST /api/runner/resources/:resourceId/observation`
- `GET /api/projects/:id/resources?includeObservations=true`

Suggested observation payload:

```json
{
  "executionTargetId": "target_123",
  "resourceId": "resource_123",
  "state": "available",
  "gitRoot": "/path/to/repo",
  "branch": "main",
  "commit": "abc123",
  "observedAt": "2026-06-28T12:00:00.000Z"
}
```

Exit criteria:

- resource list UI can distinguish stored lifecycle from this-device
  availability;
- missing paths are reported per target, not globally.

### Phase 3 — Route Read Operations To Local Targets (R1, R2)

Move repository browsing, branch listing, and diff reads from backend-local
operations to target operations.

Options:

1. Direct Desktop bridge for desktop-hosted UI.
2. Runner request/response jobs over HTTPS polling.
3. Short-lived signed command requests claimed by a target.

Recommendation: use the runner queue model for operations that must work from
web and Desktop, and use a direct Desktop bridge only for narrow shell-only
operations such as directory picking.

Exit criteria:

- repository tree browsing works in remote Desktop mode through the laptop
  target;
- the hosted backend never reads source files;
- a CLI-only VM target can serve the same operation.

### Phase 4 — Route Mutating Git/Worktree Actions To Local Targets (R1, R2)

Move branch/worktree mutations to local target jobs:

- integrate with parent;
- commit branch changes;
- push parent;
- publish branch;
- remove/purge worktrees.

These actions should be explicit, auditable target operations with durable
events and typed failures.

Exit criteria:

- branch/worktree UI works identically whether backend is local or hosted;
- local target logs show command stdout/stderr;
- backend records state transitions only after target-reported success.

### Phase 5 — Launch And Runner Unification (R1, R3)

Make agent launch consistently flow through execution targets:

- backend creates execution request;
- selected target claims request;
- target validates local resource and prepares branch/worktree;
- target launches agent;
- agent writes protocol updates to backend;
- target reports launch success/failure.

Local Desktop may auto-start a target provider, but it should still use the same
claim/launch model.

Exit criteria:

- local SQLite and hosted Postgres use the same launch path;
- no backend path validation blocks queue creation for paths that are only
  meaningful on the target;
- target identity determines where the agent runs.

### Phase 6 — Slim The Cloud Backend Image (R4)

Goal R1/R3 fix *what* the backend does; this phase fixes *what ships with it*.
The hosted Railway image currently bundles Local-only baggage, which is both the
literal "why is the whole webapp folder / why are the SQLite migrations on the
backend?" complaint and a real attack-surface/size problem.

Findings to address:

1. **SQLite migrations ship to a Postgres-only service.** The server bundle
   resolves migrations relative to itself and `webapp/scripts/build-server.mjs`
   stages **both** `webapp/sqlite/migrations` and `webapp/postgres/migrations`;
   the `Dockerfile` then `COPY`s both into the runtime image. A hosted Postgres
   backend should stage/copy only the Postgres set (gate on the configured DB
   adapter), so SQLite migrations never appear in the cloud image.
2. **`better-sqlite3` ships to the cloud image.** It is kept `external` and
   installed into runtime `node_modules` because the data layer/auth still
   import it unconditionally (`Dockerfile` lines 10-14). Finishing the
   adapter-selection work promised in contract `0.55-draft` ("the production
   path no longer opens `better-sqlite3` directly") lets the cloud image drop
   the native addon and its `python3/make/g++` build toolchain entirely.
3. **Committed build artifacts.** `webapp/sqlite/**` and `webapp/postgres/**`
   are *generated copies* of `database/{sqlite,postgres}/migrations` (staged by
   `build-server.mjs`) yet are tracked in git. They should be `.gitignore`d and
   produced only at build time; `database/` stays the single source of truth.
   (Note the same duplication smell at the root: a stale untracked `src/`
   alongside the canonical `packages/core` from contract `0.53-draft`.)
4. **The backend serves the SPA.** `webapp/server/index.ts` mounts
   `express.static(distDir)` and an `index.html` fallback. Contract
   `0.55-draft` already says the Vercel web build serves the SPA and connects
   realtime **directly** to the Railway backend. Decide explicitly: if Cloud
   serves the SPA from Vercel, the Railway image should **not** build or bundle
   `webapp/web`/`dist`, shrinking "the whole webapp folder" down to just the
   server. Keep static-serving only for the Local/desktop edition. This is
   consistent with `0.55-draft` and needs no contract bump — but the build
   split should be documented.

Exit criteria:

- The cloud image contains no SQLite migrations, no `better-sqlite3`, and no
  native build toolchain.
- `git status` is clean after a server build (no regenerated migration trees
  showing as changes).
- Either the SPA is intentionally served by the cloud backend (documented) or
  the cloud image no longer bundles the web client.
- Image size and cold-start measurably drop; nothing Local-only remains in the
  hosted artifact.

## 9. Testing Strategy

Add test matrices that run the same product scenario against:

1. local SQLite backend with in-process fake local target;
2. hosted/Postgres-style backend with no filesystem access;
3. fake runner target that reports observations and action results;
4. real CLI integration path for `ovld add-cwd`, branch preparation, and
   changed-file delivery.

Required invariants:

- backend location does not determine whether local file work can happen;
- target availability determines whether local file work can happen;
- hosted backend never marks a resource missing from its own filesystem;
- hosted backend never reads source files;
- DB state remains correct when target operations fail halfway.

## 10. Open Questions

1. Should repository browsing be a durable target job or a low-latency direct
   target request?
2. How long should resource observations be cached before showing as stale?
3. Should Desktop always run a target provider while in remote-client mode?
4. **Decided (see §6.1):** target selection is a durable per-`(user, project)`
   preference, not a per-click property. Remaining sub-question: when multiple
   targets can reach the same resource and none is selected, do we prompt or
   auto-pick the most-recently-available one?
5. Should local target capabilities be exposed through `ovld runner serve` or a
   separate `ovld target start` command? (R3 leans toward making the runner the
   target provider so a logged-in CLI on a VM is automatically selectable.)
6. Which operations need streamed output/logs versus request/response payloads?
7. **(R4)** Should the cloud Railway backend serve the SPA at all, or is that
   exclusively Vercel's job? The build split in Phase 6 depends on this answer.
8. **(R4)** Adapter selection: is the cleanest cut a build-time DB target flag
   (two images) or a single image that lazily loads the SQLite adapter only when
   configured for Local? The latter still pulls `better-sqlite3` into the
   image unless tree-shaken behind a dynamic import.

## 11. Non-Goals

- Do not make browsers read arbitrary local files directly.
- Do not expose source file contents to the hosted backend unless explicitly
  uploaded as an artifact/attachment by a local target.
- Do not require inbound network access to laptops or VMs.
- Do not make database clients connect directly from runners to Postgres.
- Do not remove local-only operation; preserve the no-account local workflow via
  a local target provider and local backend/database.
