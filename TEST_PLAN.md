# Overlord Test Implementation Plan

Plan Version: `0.1-draft`
Targets Contract Version: `0.2-draft`

## Purpose

This is the master test implementation plan for Overlord. It defines **how every
module is tested** and — most importantly — **how tests prove that every module
adheres to [`CONTRACT.md`](CONTRACT.md)** and its machine-readable counterparts in
[`contract/`](contract/).

Overlord is built as independent modules connected only through the contract's
declared interaction surfaces. The contract is therefore the single most
important thing the test suite must protect. This plan treats contract
conformance as a first-class, cross-cutting test layer (Layer 3 below), not an
afterthought bolted onto unit tests.

The plan is organized per module, matching the repository convention that each
module owns its code, tests, and documentation under `<module>/docs/`:

| Module | Test plan | Contract component(s) covered |
| --- | --- | --- |
| Database | [`database/docs/testing.md`](database/docs/testing.md) | `database`, `extension` |
| CLI | [`cli/docs/testing.md`](cli/docs/testing.md) | `cli`, `protocol`, `runner` |
| Auth | [`auth/docs/testing.md`](auth/docs/testing.md) | `auth` |
| API (REST) | [`webapp/docs/testing.md`](webapp/docs/testing.md) (API section) | `rest` |
| Webapp | [`webapp/docs/testing.md`](webapp/docs/testing.md) (UI section) | `rest` (consumer) |
| Connectors | [`connectors/docs/testing.md`](connectors/docs/testing.md) | `connector` |
| Automations | [`automations/docs/testing.md`](automations/docs/testing.md) | `automations` |
| MCP | This document → [Future Modules](#future-modules) | _(future)_ |
| Mobile App | This document → [Future Modules](#future-modules) | _(future)_ |

The **cross-module contract conformance suite** ([Layer 3](#layer-3--contract-conformance-cross-module))
is owned by this document and lives under `contract/conformance/` so it can
exercise every module against the same normative source.

---

## Guiding Principles

1. **Contract-first.** A behavior described in `CONTRACT.md` or a `contract/*.yaml`
   file is not "done" until a test asserts it. When the contract and the code
   disagree, the test fails and the code is wrong (or the contract must be bumped
   first — see [Drift Guard](#34-contract-drift-guard)).
2. **Test the surface, not the internals.** Components may only be exercised
   through their declared interaction surfaces. A test that reaches into another
   module's internals is itself a contract violation and must be rewritten.
3. **Service-layer is the chokepoint.** Protocol, CLI, REST, and Runner all reach
   persistence through the same service layer. The bulk of behavioral coverage
   lives at the service-layer integration level (Layer 2), shared across the
   surfaces that call it.
4. **Adapter parity.** Every database-level test runs against **both** SQLite and
   Postgres adapters from the same test body. A behavior that passes on one
   adapter but not the other is a defect in the adapter, the schema source, or the
   test — never an accepted divergence.
5. **Deterministic and hermetic.** No wall-clock dependence, no network, no real
   agent processes, seeded IDs. Tests must pass identically in CI and locally and
   be safe to run in parallel.
6. **One assertion of intent per test.** Tests are named for the contract rule
   they protect so a failure points directly at the violated clause.

---

## Test Taxonomy (The Pyramid)

| Layer | Name | Scope | Speed | Where it lives |
| --- | --- | --- | --- | --- |
| **L0** | Static / schema | Lint, typecheck, YAML-schema validation of contract + manifest files | instant | `contract/conformance/static/` |
| **L1** | Unit | Pure functions: RBAC authorizer, token hashing, validators, id/sequence logic | very fast | `src/**/*.test.ts` colocated |
| **L2** | Module integration | One module against a real database via the service layer | fast | `<module>` + `database/test/` |
| **L3** | Contract conformance | Cross-module invariants asserted against `contract/*.yaml` | fast–medium | `contract/conformance/` |
| **L4** | Surface / E2E | Real `ovld` subprocess, real REST server over HTTP, connector launch dry-run | slow | `<module>/test/e2e/` |

The pyramid is intentionally bottom-heavy: most assertions live in L1/L2, the
**rigor about contract adherence concentrates in L3**, and L4 is a thin
confidence layer that the wiring at the real surface matches what L2/L3 proved.

---

## Tooling and Harness

The project already standardizes on Node's built-in runner (see `package.json`):

```jsonc
"test": "node --test --experimental-strip-types 'src/**/*.test.ts'"
```

The plan extends this rather than introducing a heavyweight framework:

- **Runner:** `node:test` (`describe`/`it`) with `node:assert/strict`. Already in
  use by `auth/src/rbac/authorizer.test.ts`; keep it as the single runner.
- **TypeScript:** `--experimental-strip-types` (no build step for tests). Type
  errors are caught separately by `yarn typecheck` (`tsc --noEmit`).
- **Coverage:** `node --test --experimental-test-coverage` with a per-layer
  threshold gate (see [Coverage Targets](#coverage-targets)). No external coverage
  dependency required.
- **SQLite:** `better-sqlite3` (already a dependency) opened as `:memory:` per
  test for isolation, WAL-mode variant for change-feed/realtime tests.
- **Postgres:** ephemeral instance per CI job. Locally, an opt-in
  `OVERLORD_TEST_PG_URL`; in CI a service container. Adapter-parity tests skip
  Postgres with a loud `SKIP` (never a silent pass) when no URL is configured.
- **YAML/JSON-Schema (L0):** validate `contract/*.yaml` and every
  `conformance-manifest.yaml` against `contract/conformance-manifest.schema.yaml`.
- **No new runtime deps for tests** unless a gap is proven; prefer Node stdlib
  (`node:test`, `node:assert`, `node:child_process`, `node:http`).

### Test commands (target `package.json` scripts)

```jsonc
{
  "test":            "node --test --experimental-strip-types 'src/**/*.test.ts' '*/test/**/*.test.ts' 'contract/conformance/**/*.test.ts'",
  "test:unit":       "node --test --experimental-strip-types 'src/**/*.test.ts'",
  "test:db":         "node --test --experimental-strip-types 'database/test/**/*.test.ts'",
  "test:contract":   "node --test --experimental-strip-types 'contract/conformance/**/*.test.ts'",
  "test:e2e":        "node --test --experimental-strip-types '*/test/e2e/**/*.test.ts'",
  "test:coverage":   "node --test --experimental-test-coverage --experimental-strip-types '...'",
  "typecheck":       "tsc --noEmit"
}
```

---

## Shared Test Infrastructure

To keep tests DRY and force every surface through the same setup, the plan
introduces a small shared toolkit (no third-party deps):

- **`database/test/harness.ts`** — `withAdapter(fn)` runs `fn(db)` once per
  adapter (SQLite always; Postgres when configured), applying all migrations to a
  fresh database and seeding the default local workspace/user/statuses/ticket
  sequence. This is the single entry point for every L2/L3 test that needs a DB.
- **`database/test/factories.ts`** — builder functions (`makeProject`,
  `makeTicket`, `makeObjective`, `makeSession`, …) that create valid rows through
  the **service layer**, never via raw inserts, so factories themselves exercise
  the sanctioned surface.
- **`contract/conformance/loaders.ts`** — parse `CONTRACT.md` tables and every
  `contract/*.yaml` into typed structures so conformance tests assert against the
  contract as data, not hard-coded copies. This is what makes the suite
  self-updating: change the contract YAML and the conformance tests re-derive
  their expectations.
- **`test/support/clock.ts`** — injectable fake clock for `TimestampUTC` ordering
  and heartbeat/expiry tests.
- **`test/support/cli.ts`** — `runOvld(args, { stdin, cwd, env })` spawning the
  real CLI as a subprocess and capturing stdout JSON / exit code, for L4.

---

## Layer 3 — Contract Conformance (Cross-Module)

> This is the rigorous core the objective demands: tests whose only job is to
> prove **every module adheres to the contract**. They live in
> `contract/conformance/` and are derived from `CONTRACT.md` +
> `contract/*.yaml` so they stay in lockstep with the normative spec.

### 3.1 Conformance manifest validation

For every `conformance-manifest.yaml` in the repo (currently
`connectors/adapters/claude/conformance-manifest.yaml` plus
`contract/examples/*`):

- Validates against `contract/conformance-manifest.schema.yaml` (required fields,
  `componentKey` pattern, `additionalProperties: false`).
- `contractVersion` is a known version present in the `CONTRACT.md` version table.
- `componentType`-specific required blocks are present (e.g. `connector` block for
  connectors, `restModule.endpointPrefix` for REST modules).
- Every declared connector `capabilities` value is in `approvedConnectorCapabilities`.
- Every declared `hookTypes` value is in `approvedHookTypes`.
- Every `vocabularyExtensions[].value` is namespaced and targets an **open**
  vocabulary (never a closed one).
- Extension `tablePrefix` matches `^ext_[a-z][a-z0-9_]*_$` and `migrationComponent`
  matches `^ext:[a-z][a-z0-9_-]*$`.

### 3.2 Controlled-vocabulary enforcement

Closed vocabularies in `contract/extension-points.yaml` are the source of truth.

- **DB ↔ contract parity:** parse the `CHECK (... IN (...))` constraints from the
  SQLite and Postgres migrations and assert each closed-vocab column's allowed set
  **equals** the contract list (e.g. `objectives.state`, `execution_requests.status`,
  `project_statuses.type`, `ticket_events.type`, `permission_requests.status`,
  `idempotency_keys.status`, `audit_log.result`, `agent_sessions.delivery_state`).
  A value added to one side but not the other fails this test.
- **Closed-set rejection:** the service layer rejects writes with a value outside
  the closed set (both adapters), and the rejection surfaces as a domain error,
  not a raw DB constraint error leaking to the caller.
- **Open-vocab namespacing:** extension-supplied open-vocab values
  (`artifacts.type`, `ticket_events.source`, `entity_changes.entity_type/source`,
  `outbox_messages.topic`, `worker_jobs.type`, RBAC permission names,
  connector identifiers) must be namespaced when not a documented core value.

### 3.3 Interaction-surface boundary enforcement

These tests prove components only talk through sanctioned surfaces:

- **No direct table writes outside the service layer.** A static test scans
  protocol/CLI/REST/runner/hook source for raw `INSERT`/`UPDATE`/`DELETE` (or
  Kysely `insertInto`/`updateTable`/`deleteFrom`) outside `database/` service
  modules and fails on any hit. Mirrors the contract rule "No direct table writes
  from protocol handlers."
- **Auth never writes core tables.** Auth-layer source must not mutate `tickets`,
  `projects`, `objectives`, etc. (contract: "Auth Layer must not write to core
  domain tables").
- **Auth-internal tables are private.** No module outside `auth/`/`auth/src/auth`
  reads `user`, `session`, `account`, `verification`, `apikey` directly.
- **Hook scripts use protocol only.** `connectors/**/scripts/*.sh` must invoke
  `ovld protocol …` and contain no DB connection strings or SQL.
- **Same service layer for every surface.** A test asserts CLI, Protocol, and REST
  create-ticket paths all converge on the identical service function (by reference,
  not duplication).

### 3.4 Contract drift guard

Protects the maintenance rule "the implementation code must not land before the
contract update":

- A test loads `contractVersion` from `CONTRACT.md`, `contract/components.yaml`,
  and each `contract/*.yaml`, and asserts they agree (within the documented
  per-file version, e.g. protocol-commands at `0.1-draft`).
- A snapshot/fingerprint test over the closed vocabularies and the protocol
  command set fails when they change, forcing the author to (a) bump the contract
  version and (b) update the snapshot in the same change — a deliberate
  "did you mean to change the contract?" gate.
- Every `schema_migrations.component` value used by extension tables matches
  `ext:<name>`; core migrations use the reserved core component name.

### 3.5 Protocol command-surface conformance

Asserts the live CLI matches `contract/protocol-commands.yaml`:

- Each declared command exists and rejects a call missing a `requiredFlags` entry.
- Commands marked `requiresSessionKey` fail clearly without a session key.
- `attach` output satisfies `attach-response-v1`: all `requiredTopLevelFields`
  present, `session` has `sessionKey`+`state`, `objectives[]` have
  `id/objective/state/position`, and `promptContext` contains every
  `promptContextRequiredContent` item (task title, ticket ID, objective ID,
  objective text, recent activity, required protocol workflow instructions).
- Declared `sideEffects` happen and undeclared ones do not — e.g. `heartbeat`
  updates session liveness but creates **no** `ticket_events` row.
- `validPhases`/`validEventTypes` are enforced; out-of-set values are rejected.

### 3.6 State-machine conformance

Drives the lifecycle transitions in `extension-points.yaml` against the service
layer (both adapters):

- `objectives.state`: legal path `future → draft → submitted → launching →
  executing → complete`; `executing → pending_delivery` only after a prior
  delivery begins follow-up; illegal jumps rejected; reopen requires an explicit
  follow-up/admin transition that records a `ticket_events` row.
- `execution_requests.status`: `queued → claimed → launching → launched`;
  terminal states (`failed/cleared/cancelled/expired`) are sinks.
- `project_statuses.type`: exactly one active `execute`, one active `review`, and
  one active default per project (partial-unique enforced).

### 3.7 Cross-cutting persistence invariants

- **Optimistic concurrency:** stale `revision` write → `409`-class conflict, zero
  rows mutated (both adapters).
- **Change-feed atomicity:** every domain mutation appends `entity_changes` in the
  **same transaction**; on rollback neither the mutation nor the change row
  survives; cursors are commit-safe (no gaps visible to readers).
- **Idempotency layering:** replaying a protocol/REST write with the same
  idempotency key returns the first result and does not double-apply.
- **Soft delete:** produces a tombstone (`deleted_at`) plus a change-feed row; FKs
  and active-uniqueness behave per contract.

### 3.8 Database adapter conformance suite

The schema contract's [Adapter Conformance Suite](database/docs/09-database-schema-contract.md)
checklist is implemented verbatim as parametrized tests every adapter must pass.
Detailed in [`database/docs/testing.md`](database/docs/testing.md); summarized in
the traceability matrix below.

---

## Traceability Matrix (Contract Rule → Test)

Every row must map to at least one executable test. The matrix is the acceptance
checklist for "rigorous about contract adherence."

| Contract source | Rule | Layer | Test home |
| --- | --- | --- | --- |
| components.yaml `protocolToDatabase` | No direct table writes from protocol | L3 | `conformance/boundaries` |
| components.yaml `authToDatabase` | Auth never writes core tables; auth tables private | L3 | `conformance/boundaries` |
| components.yaml `connectorToProtocol` | Hooks use protocol only, no DB | L3 | `conformance/boundaries` |
| protocol-commands.yaml | Required flags / session-key / phases / event types | L3+L4 | `conformance/protocol`, `cli/test/e2e` |
| protocol-commands.yaml `attach-response-v1` | Response shape + promptContext content | L3 | `conformance/protocol` |
| protocol-commands.yaml `heartbeat` | No `ticket_events` row created | L2 | `cli` |
| extension-points.yaml closed vocab | DB CHECK == contract list | L3 | `conformance/vocab` |
| extension-points.yaml transitions | Objective/exec/status state machines | L3 | `conformance/state` |
| extension-points.yaml capabilities/hooks | Manifest values within approved sets | L3 | `conformance/manifest` |
| conformance-manifest.schema.yaml | Every manifest validates | L0+L3 | `conformance/manifest` |
| schema contract — concurrency | revision compare-and-set | L2 | `database/test` |
| schema contract — change feed | entity_changes same-tx, commit-safe | L2 | `database/test` |
| schema contract — idempotency | Replays don't double-apply | L2 | `database/test` |
| schema contract — adapter suite | Full checklist, SQLite + Postgres | L2 | `database/test` |
| schema contract — security | Raw token/session secrets never persisted | L1+L2 | `auth`, `database/test` |
| extension-points.yaml `ext_` rules | Extension migrations don't collide with core | L2+L3 | `database/test`, `conformance/drift` |
| CONTRACT.md maintenance | Version agreement + drift snapshot | L3 | `conformance/drift` |

---

## Coverage Targets

Coverage is a floor, not a goal; the traceability matrix is the real bar.

| Area | Line/branch floor | Notes |
| --- | --- | --- |
| `auth/src/rbac`, `auth/src/auth` token/hash logic | 95% | Security-critical pure logic |
| Service layer (database) | 90% | Primary behavioral chokepoint |
| Protocol/CLI command handlers | 85% | Surface wiring + validation |
| REST handlers | 85% | Auth + service delegation |
| Contract conformance suite | 100% of matrix rows | Every row has a test, all green |
| Connectors (scripts/manifests) | n/a (asserted structurally) | Validated, not line-covered |

---

## CI Gating

A change cannot merge unless, in order:

1. `yarn typecheck` passes (`tsc --noEmit`).
2. `yarn test:unit` (L1) passes.
3. `yarn test:db` (L2) passes on **SQLite and Postgres** (matrix job).
4. `yarn test:contract` (L0+L3) passes — including the drift guard.
5. `yarn test:e2e` (L4) passes.
6. Coverage thresholds met.

The contract conformance job (step 4) is the required gate that no module change
can bypass: it runs on every PR regardless of which module changed, because a
change anywhere can violate a cross-module boundary.

---

## Phased Rollout

Test work is sequenced to land alongside the implementation phases in
[`planning/feature-plans/README.md`](planning/feature-plans/README.md). Each phase
ships its tests with its code — never after.

| Phase | Implementation focus | Tests that land with it |
| --- | --- | --- |
| 0 | Skeleton, config, SQLite connection, schema source | L0 contract/manifest validation; `withAdapter` harness; migration-applies test |
| 1 | CLI ticket management, seed | L2 service-layer CRUD; ticket-sequence; L4 `ovld` smoke |
| 2 | Agent protocol MVP | L3 protocol-surface + attach-response; rationale-on-deliver; state machine (objectives) |
| 3 | Local launch + runner | L3 runner queue atomicity; execution_requests state machine |
| 4 | Review features | L2 artifacts/rationales/shared-context; record-work without session |
| 5 | Auth, RBAC, tokens, extensions, adapters, MCP, web | Auth/RBAC suites; adapter conformance for new adapters; REST + UI; MCP (post-contract) |

---

## Future Modules

These modules are reserved but not yet implemented. Per
[Contract Maintenance Rules](CONTRACT.md), the **contract must be updated before**
their implementation (and therefore their tests) land. Each gets a per-module
`<module>/docs/testing.md` at that time, mirroring the structure used here.

### MCP (Phase 5, deferred)

`mcp/` is a reserved slot and **not yet a contract component**. Entry criteria
before any MCP test is written:

1. `mcp` added to the Component Registry, `contract/components.yaml`, and a new
   `mcpToDatabase` (service-layer) interaction surface declared.
2. Contract version bumped; changelog entry added.

Planned coverage once admitted: MCP tools map 1:1 to existing service-layer
operations (no new persistence paths); MCP server reaches the DB only through the
service layer (asserted by the same boundary test as REST/CLI); tool
input/output schemas validate; and a `drift-review`-style test confirms MCP tools
do not drift from the REST/CLI/protocol surface they mirror.

### Mobile App (deferred)

No module directory or contract component exists yet. It is expected to be a
**REST API consumer**, so its correctness is bounded by the REST contract tests.
Entry criteria: a `mobile/` module + contract treatment of any new surface it
introduces (e.g. push, device registration) before tests are authored. Until
then, the REST conformance suite is its guarantee.

### Agent Connectors (ongoing expansion)

The connector framework is live (`connectors/`), with per-connector test plans in
[`connectors/docs/testing.md`](connectors/docs/testing.md). New connectors are
admitted by passing the connector conformance tests (manifest validity, managed
files present, hook scripts protocol-only, capability/hook flags within the
approved sets) — no contract change unless a new capability or hook type is
needed, which requires a version bump first.

---

## Maintenance

- When a contract rule is added or changed, add or update the corresponding
  traceability-matrix row **in the same change** that bumps the contract version.
- When a new module becomes a contract component, add its `<module>/docs/testing.md`
  and link it from the table at the top of this document.
- The drift guard (§3.4) will fail any contract change that ships without updating
  the conformance snapshot — that failure is the reminder to update this plan.
