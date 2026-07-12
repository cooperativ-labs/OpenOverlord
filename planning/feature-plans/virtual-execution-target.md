# Virtual Execution Targets (Racecar first): feature plan

Status: **draft / not started**  
Date: 2026-07-11  
Source proposal: [Racecar virtual-execution-target.md](https://github.com/jchaselubitz/Racecar/blob/main/planning/virtual-execution-target.md)  
Contract impact: **yes — update `CONTRACT.md`, `contract/components.yaml`, `contract/extension-points.yaml`, and the database schema contract before code. Bump contract version `2` → `3`.**

## 1. Outcome

Add a provider-neutral **virtual execution target**: one selectable Overlord target
for a gateway that realizes (or reuses) a mission environment only after it claims
an existing Overlord execution request. Racecar is the first gateway/adapter; it
must consume documented Overlord APIs and never access Overlord's database.

The normal lifecycle remains authoritative:

```text
queue immutable launch snapshot → gateway claim → preparing observations
→ launched observation → normal agent protocol attach/deliver
```

`execution_requests.status` remains the current closed vocabulary. Preparation
is diagnostic observation data, not a parallel request state machine. A gateway
does not complete an objective; an agent protocol delivery does.

## 2. Current-state gap analysis

| Current Overlord surface | What works already | What is missing for a virtual target |
| --- | --- | --- |
| `execution_targets` | Stable target identity, ownership, selection, and open target type vocabulary | Gateway identity/version, heartbeat/health, advertised capabilities, and provider-neutral target configuration |
| `execution_requests` | One durable request; selected target; claim lease; `queued → claimed → launching → launched/failed`; attempt count | Immutable queue snapshot/digest, version negotiation, remote source and environment inputs, request-scoped grants, and structured launch/failure observations |
| `claimNextExecutionRequest` | Atomically claims a target-compatible queued request | Resolves a host filesystem path before claim and assumes `ClientDeviceIdentity`; cannot let a remote gateway perform source/environment realization |
| Runner REST endpoints | `/api/runner/claim` and launching/launched/failed transitions already model the needed durable lifecycle | Authentication is local-runner shaped; responses lack virtual payload; outputs only accept a free-text failure; no progress endpoint/idempotency sequence |
| Local-target capabilities | A clean, typed boundary for local checkout work and a target-aware registry | The interface is specifically local/path-based and includes worktree/agent spawning operations; it is not a virtual gateway contract |
| Project resources | Logical `resource_key`, project-scoped resource identities, source descriptors, observations, and multi-resource attach manifest | Immutable source revisions/digests, source requirements, and target-relative opaque workspace references |
| Protocol | Attach/deliver remains provider-independent and can link a launched request to an agent session | No gateway launch grant exchange or mission lifecycle-resource representation |
| Web/Desktop UI | Target selection, resource availability, runner queue, and mission detail already exist | Capability-aware selection, source compatibility warnings/overrides, preparation progress, external environment/run cards, lifecycle actions, and terminal delegation |

The decisive change is to separate **desired launch state** (Overlord's immutable
snapshot) from **observed realization state** (gateway reports). Paths and raw
credentials must never cross that boundary.

## 3. Contract v3 decisions

1. Promote `virtual` to a core `execution_targets.type`. Racecar is identified by
   an adapter key in the target registration (`racecar`), not by a Racecar-specific
   target type or database table.
2. Preserve the current execution-request status vocabulary. Add ordered,
   idempotent observations under the request instead of statuses such as
   `provisioning` or `running`.
3. Define `VirtualExecutionQueueItemV1` as the exact versioned, immutable payload
   returned only to the authenticated claiming gateway. Store its canonical JSON
   and SHA-256 digest when the request is queued; never rebuild it from mutable
   project/objective rows at retry time.
4. A virtual claim is target-authenticated, not device-authenticated. Keep local
   `claimed_by_device_id` nullable and use `claimed_by_execution_target_id` as
   the universal claimant identity.
5. `project_resources` has no path or target columns. A local checkout path lives
   only in its `project_resource_sources` descriptor; a virtual queue item carries
   a typed source descriptor; `targetRelativeRef` and
   `workspaceRef` are opaque handles, never server-readable filesystem paths.
6. Use only short-lived, request-scoped grants and credential-reference IDs in
   payloads. Provider tokens, Git tokens, user tokens, and agent secrets never
   appear in queue JSON, observations, events, logs, or UI DTOs.
7. Racecar ships as `componentType: rest-consumer`, validates against contract v3,
   vendors the published virtual-target types, and declares its endpoints and
   namespaced adapter key in a conformance manifest.

## 4. Contract and type work (must land first)

Update `CONTRACT.md`:

- Runner owns durable queue delivery, leases/retries, and status transitions;
  gateways own target registration/heartbeat, claim handling, source/environment
  realization, and observed-state reporting.
- REST owns the virtual-target registration, claim, grant exchange, progress,
  observation, failure, and delegated-action DTOs. It must enforce auth/RBAC and
  bounded/redacted output.
- Database owns the new core tables and controlled-vocabulary definitions.
- Add a **Virtual Target Gateway** conformance requirement: no database access;
  only documented REST; idempotent by `executionRequestId`; preserves the normal
  protocol lifecycle.
- Extend the component interaction diagram/extension table with the gateway
  boundary. `rest-consumer` is the sanctioned integration mechanism; do not add a
  Racecar-specific core extension point.

Update machine-readable contract files:

- `contract/components.yaml`: contract version 3 plus stable interfaces for the
  queue payload and virtual runner routes.
- `contract/extension-points.yaml`: version 3 and the documented namespaced
  adapter key/value rules. Do not add virtual execution-request states to its
  closed vocabulary.
- `packages/contract/src/index.ts`: exported V1 payload, capability, observation,
  failure, delegated action, and grant-exchange DTOs. Backend and webapp import
  these types; Racecar vendors the corresponding public subset.
- `database/docs/09-database-schema-contract.md`: schema, indexes, constraints,
  source/compatibility vocabulary, and redaction/retention rules below.

## 5. Data model and migrations

Add identical SQLite and PostgreSQL migrations. The schema is core because the
data drives core queue status, audit, authorization, and UI; it is not an
`ext_racecar_*` extension.

| Table / change | Key columns | Purpose and constraints |
| --- | --- | --- |
| `execution_target_registrations` | `execution_target_id` unique, `gateway_key`, `gateway_instance_id`, `capabilities_json`, `supported_queue_versions_json`, `health`, `last_heartbeat_at`, `last_error_code` | Gateway-owned target registration/health. `connection_json` stays non-secret configuration; secrets remain in credential storage. Registration replaces rather than creates a target when stable gateway identity matches. |
| `project_environment_definitions` | project, immutable `version`, canonical `definition_json`, `digest`, `fingerprint`, archived timestamp | Provider-neutral desired environment. Unique active `(project_id, fingerprint)`; an execution request references the exact definition. |
| `project_resource_sources` | resource, source kind, canonical descriptor JSON, observed revision/content digest | Defines Git, opaque local-checkout, or uploaded-bundle source inputs without persisting remote paths/secrets. A resource may have target-specific descriptors. |
| `execution_request_snapshots` | request unique, `schema_version`, canonical `payload_json`, `payload_digest`, `created_at` | Immutable `VirtualExecutionQueueItemV1`; create in the same transaction as the queued request and disallow update. Retrying increments `attempt_count` only. |
| `execution_request_grants` | request, kind, scope JSON, expiry, consumed/revoked timestamps | Stores opaque launch/attachment/download/credential-reference grant records. Store hashes or opaque IDs, never bearer values. |
| `execution_request_observations` | request, `sequence` unique per request, observation kind, bounded/redacted JSON, observed timestamp | Append-only gateway progress, launch observation, failure, and lifecycle-resource observations. Monotonic sequence rejects duplicates/out-of-order writes. |
| `mission_target_resources` | mission, target, adapter resource kind/external ID, state, latest observation | Durable summarized external car/environment/run/resource state for mission views and delegated actions; references opaque external IDs only. |
| `execution_requests` additions | `launch_snapshot_id`, `failure_code`, `failure_phase`, `claimed_by_gateway_instance_id` | Links immutable payload and typed failure while preserving `last_error` as human-safe summary. No change to status vocabulary. |

Add service-level checks: a selected virtual target must be active, healthy within
its heartbeat TTL, authorized for the project, support the requested agent and
all source types, contain exactly one active resource, and support the queue
schema version. Validate all resource IDs against the project before snapshot
creation. Enforce target registration/auth ownership transactionally.

## 6. Queue and gateway REST contract

Keep the existing local runner routes working. Add a versioned virtual gateway
route family (recommended: `/api/virtual-targets/v1`) rather than overloading a
local-device request body until the types are stable.

| Endpoint | Caller | Behavior |
| --- | --- | --- |
| `PUT /api/virtual-targets/v1/registration` | gateway | Registers/refreshes one selected virtual target, capabilities, supported agents, queue versions, adapter key/version, and heartbeat. Requires target-management authorization or a provisioned gateway credential. |
| `POST /api/virtual-targets/v1/claim` | gateway | Atomically claims a request assigned to its target and returns `VirtualExecutionQueueItemV1`, `claimId`, expiry, and only request-scoped launch grant references. Same gateway/request replay returns the same claim/payload. |
| `POST /api/virtual-targets/v1/requests/:id/progress` | gateway | Records a bounded, monotonic V1 preparation observation. Does not transition status. |
| `POST /api/virtual-targets/v1/requests/:id/launched` | gateway | Validates request/claim/target/digest, records `VirtualTargetLaunchObservationV1`, then makes the normal `launching → launched` transition atomically. Idempotent response by request and observation sequence. |
| `POST /api/virtual-targets/v1/requests/:id/failed` | gateway | Records typed `VirtualTargetFailureV1`, redacts details, and makes the allowed normal transition to `failed`. `retryable` informs existing retry UI/policy but does not requeue itself. |
| `POST /api/virtual-targets/v1/grants/:id/exchange` | gateway | Exchanges an authenticated, unexpired opaque grant for narrowly scoped credentials/attachment download access. Audit every exchange; never return the user’s Overlord token. |
| `GET /api/virtual-targets/v1/missions/:id/resources` | UI/gateway as authorized | Returns summarized opaque lifecycle resources and source-compatibility observations. |
| `POST /api/virtual-targets/v1/missions/:id/actions` | UI | Authorizes an explicit `start`, `stop`, `archive`, `delete`, `enqueue`, `retry`, or `dequeue` action and delegates it to the target. Target output becomes an observation; it cannot change mission completion. |

The exact payload follows the source proposal's `VirtualExecutionQueueItemV1`:
request/target, project environment+fingerprint, mission/objective, all project
resources plus one active resource, agent settings, lifecycle defaults, and
grant references. Define it in `packages/contract`, including its nested source,
attachment, informational-reference, and source-requirement DTOs.

## 7. Service and runner implementation changes

1. Split current `claimNextExecutionRequest` into a common lease/state core and
   two presenters: local runner claim (keeps `workingDirectory`) and virtual
   gateway claim (returns the immutable snapshot). `resolveWorkingDirectory`
   must not run on virtual claims.
2. At queue creation, resolve target selection and build the snapshot in the same
   transaction. For a local target, retain today’s deferred local-path resolution.
   For a virtual target, reject absent/incompatible environment/source inputs
   before the request enters `queued`.
3. Generalize claimant authentication from `ClientDeviceIdentity` to a typed
   `ClaimantIdentity` union: local runner/device or virtual gateway/target. Keep
   local compatibility fields and behavior unchanged.
4. Preserve stale-lease and stale-agent-attach expiry. A post-launch gateway
   crash never destroys the car/run; retrying the same `executionRequestId`
   reuses/resumes it through adapter idempotency.
5. Add service methods for registration, heartbeat expiry, snapshot creation,
   grant issuance/exchange/revocation, progress append, launch observation,
   typed failure, lifecycle-resource projection, and delegated action requests.
6. Keep `packages/core/service/local-target/*` local. Do not expand its
   path-oriented `LocalTargetCapabilities` into the remote contract; share only
   neutral types from `packages/contract` and the execution-request service.
7. Add queue cleanup rules: cancellation/retry revokes unconsumed grants;
   observation retention is bounded; source bundles are expiration-deleted by a
   worker/outbox effect.

## 8. Resource, environment, and compatibility behavior

Before queueing, assemble every project resource into the snapshot. `activeResourceId`
selects only the initial directory; it never drops sibling resources from the
environment fingerprint. Initial supported source paths:

- `git`: URL plus credential-reference ID; gateway materializes the declared
  branch/commit.
- `local_checkout`: only for a target advertising `localCheckoutSource`; opaque
  target-relative reference, observed commit/content digest, and dirty bit.
- `source_bundle`: uploaded, filtered, digest-verified bundle; retention and
  secret-scan policy are mandatory before a gateway can fetch it.

Implement source requirements and informational references separately. Required
inputs block launch with typed `source_incompatible`; informational drift returns
`compatible`/`degraded`/`incompatible` observations and preserved excerpts for
agent context. An override is explicit, attributed, request-snapshotted, and
shown in UI/audit history.

The first increment should support Git-only, a project-owned immutable
environment definition, two-or-more resources, and no browser terminal proxy.
Local checkout bundles, attachment retrieval, and full source-reference analysis
follow once the grant and storage paths are verified.

## 9. UI, desktop, and CLI changes

- **Target management:** add a virtual-target card to `ExecutionTargetsPage`:
  adapter/version, health/last heartbeat, capability badges, supported agents,
  source modes, and repair guidance. Target credentials are configured through a
  secure gateway setup flow and are never rendered.
- **Target selection:** `NewMissionModal`, `QuickTaskBar`, and launch controls
  filter/select only target-compatible agents/resources. Explain incompatibility
  before queueing and require a clearly labeled override for source drift.
- **Queue/Mission detail:** show `queued`, normal status, plus latest preparation
  stage/message and typed failures. Show reusable car/environment/run summaries,
  per-resource source compatibility, and explicit lifecycle actions only when
  target capabilities permit them.
- **Repository views:** gateway-backed browse/terminal links use opaque
  workspace refs and delegated actions. Existing local repository capability
  calls must remain selected only for local targets.
- **CLI:** add virtual target registration/status/diagnostic commands and a
  gateway-oriented runner command only if it is an ergonomic wrapper over the
  REST contract. Do not embed provider setup, secrets, snapshot construction, or
  car operations in `ovld runner`.
- **Desktop:** may launch/setup a locally installed gateway and render target
  state, but must not implement a second queue claimant or provider adapter.

## 10. Security and authorization

- Introduce gateway principal credentials scoped to one execution target and
  workspace permissions: claim, heartbeat, request-observation write, and
  grant exchange. A gateway cannot enumerate or claim another target’s work.
- Enforce project-target authorization both when snapshotting and claiming.
- Make launch/download/credential grants short-lived, single-purpose, auditable,
  revocable, and bound to request, target, and gateway instance.
- Redact/bound all free-text error details before persistence; return safe error
  codes to UI. Audit registrations, claims, grant exchanges, overrides, and
  lifecycle actions.
- Add SSRF/repository URL policy, bundle path filtering and secret scan,
  digest verification, rate limits, heartbeat expiry, and replay protection.
- Browser terminal access is a later separate expiring authorization; it must
  never proxy provider credentials into the browser.

## 11. Delivery phases

1. **Contract/design:** land contract v3, schema docs, machine-readable
   declarations, exported DTOs, OpenAPI/REST documentation, and the Racecar
   consumer manifest template. No gateway functionality before this phase.
2. **Core queue foundation:** migrations; target registration/health;
   immutable Git-only snapshot builder; virtual target pre-queue validation;
   typed claimant and V1 claim endpoint.
3. **Observed launch:** grants; progress; launch observation; typed failure;
   lease/retry/expiry handling; queue and mission projections. Connect a fake
   virtual gateway for deterministic integration tests.
4. **Racecar adapter:** implement registration, idempotent claim handling,
   environment/car/run ensure, multi-resource materialization, and agent launch.
   Validate its conformance manifest against contract v3.
5. **Product surfaces:** UI target selection/status/progress/failure cards;
   target lifecycle actions; CLI diagnostics; documentation and onboarding.
6. **Follow-ons:** local-checkout/source-bundle transport, attachments,
   informational-reference drift, browser terminal authorization, Git integration
   projection, and additional virtual adapters.

## 12. Tests and acceptance criteria

Add SQLite/Postgres service conformance tests, backend route tests, runner
regression tests, contract DTO/schema tests, web component tests, and a fake
gateway end-to-end suite. At minimum verify:

1. An online Racecar target can queue a two-resource, Git-only request with a
   stable environment fingerprint and immutable V1 snapshot.
2. Gateway claim, retry, duplicate delivery, and restart use the same request ID
   and result in exactly one Racecar car/run.
3. Progress is monotonic/idempotent and does not alter request status.
4. A launch observation transitions exactly once to `launched`; subsequent agent
   attach/deliver follows the unchanged protocol.
5. Expired claim is recoverable; gateway crash after launch does not terminate
   the environment; stale agent attach expiry remains authoritative.
6. Remote targets reject opaque local checkouts unless they advertise that
   capability. Incompatible required source yields typed failure, not an agent
   failure; audited override is respected.
7. Every gateway grant is target/request bound, expires, is auditable, and no
   raw secret appears in DB rows, events, API responses, test fixtures, or logs.
8. Local runner regression tests prove unchanged local path resolution,
   worktree preparation, and current `/api/runner/*` behavior.
9. Contract conformance verifies Racecar makes only documented REST calls and
   declares contract v3; no direct database access is possible or required.

## 13. Explicit non-goals for v1

- No Racecar-specific database schema or direct Overlord DB integration.
- No new mission/objective/execution-request status vocabulary.
- No browser terminal proxy, Git merge automation, or provider-specific UI.
- No automatic source-drift override, silent credential fallback, or inferred
  provisioning success.
- No replacement of the existing local runner or local-target capability system.

## 14. Files and modules expected to change

| Area | Primary paths |
| --- | --- |
| Contract | `CONTRACT.md`, `contract/components.yaml`, `contract/extension-points.yaml`, `contract/conformance-manifest.schema.yaml`, `packages/contract/src/index.ts` |
| Database | `database/docs/09-database-schema-contract.md`, both `database/sqlite/migrations/` and `database/postgres/migrations/`, generated DB types |
| Core services | `packages/core/service/execution-requests.ts`, `execution-targets.ts`, project/resource services, new virtual-target/grant/observation services and tests |
| Backend REST | `backend/index.ts`, `backend/execution/runner.ts`, auth/RBAC permissions, route tests |
| Runner/CLI | `cli/src/runner*.ts`, command/help/docs only for gateway diagnostics; preserve local runner semantics |
| UI/Desktop | execution-target settings, target-aware launch components, queue/mission resource views, API/query DTOs, desktop bridge only for setup/control |
| External consumer | Racecar's vendored contract, REST client, gateway, and `conformance-manifest.yaml` |

## 15. Open decisions to settle in the contract-design objective

1. Should gateway enrollment use an admin-provisioned one-time token, OAuth
   device flow, or a signed installation credential? It must result in a
   target-scoped renewable principal.
2. Where do project environment definitions live in the authoring UI, and what
   produces a canonical fingerprint across lockfiles/resources?
3. Is source-bundle upload a core storage route in the first remote-target
   release, or deferred behind Git-only sources as recommended above?
4. What operator-controlled heartbeat TTL, observation retention, and car
   lifecycle default values balance responsiveness with remote/offline gateways?
5. Which adapter action results are synchronous observations versus asynchronous
   queued work, and how are destructive actions confirmed?
