# Data-layer convergence & legacy sync-handle retirement (mission coo:61, item 6)

Status: **Part A (§3.2 sync-handle retirement) implemented.** Part B (§2.2 read
convergence) is planned and contract-pre-specified here as the staged follow-up.

This is the contract-touching tail of the `coo:61` data-transfer review
(`planning/feature-plans/data-transfer-logic-review.md`, §2.2 / §3.2 / §4 item 6).
Items 1–5 of that review shipped under objective 2; this document plans and executes
the remaining item 6, which the review explicitly deferred because it crosses the
Database / REST / Protocol / Auth contract surfaces and needs a `CONTRACT.md` change.

The two halves are independent and are sequenced sync-handle-first because it is the
smaller, fully self-contained, fully verifiable change:

- **Part A — §3.2:** retire the legacy synchronous `better-sqlite3` handle and the
  throwing Postgres shim from the backend's production paths. **Done.**
- **Part B — §2.2:** converge the two data layers' overlapping **read** functions so
  the REST view and the protocol/CLI view cannot disagree. **Staged** (needs the
  end-to-end verification budget Part A did not).

---

## Part A — Retire the legacy synchronous handle (§3.2) — IMPLEMENTED

### Problem

`webapp/server/db.ts` exported a module-level synchronous `better-sqlite3` handle
(`db`) and, so that export could stay a non-null `Database.Database` on the hosted
Postgres edition, a `createPostgresLegacyDatabase()` **shim whose every method threw**
`postgresLegacyError()`. That shim was a landmine: a guard for code paths not yet
ported off the sync handle. By the time of this mission the only production consumers
of the raw handle were exactly two:

1. `dataVersion()` — `db.pragma('data_version')`, the SQLite external-write probe the
   realtime poller (`webapp/server/realtime.ts`) uses to emit a coarse `refresh`.
2. `authDomainDatabase()` — returned the raw `db` to `@overlord/auth`'s
   `verifyUserToken` on the SQLite edition (the Postgres edition already went through a
   `PostgresQueryExecutor` wrapper).

Both are relocatable behind the async `DatabaseClient` adapter, after which the raw
production handle — and therefore the throwing shim — is unnecessary.

### Changes (landed)

1. **`database/src/client.ts` — adapter owns the probe.** Added an optional
   `sqliteDataVersion(): Promise<number | null>` to the `DatabaseClient` interface.
   `SqliteClient` reads `PRAGMA data_version` off its own (encapsulated) handle through
   the same mutex guard as every other op — so the "same connection's own writes don't
   bump it" semantics are preserved exactly. `PostgresClient` returns `null` (the hosted
   edition's only change detector is the `entity_changes` feed). The method is optional
   so the lightweight inline `DatabaseClient` test doubles need not implement it.

2. **`auth/src/auth/database.ts` — auth speaks `DatabaseClient`.** `AuthDomainDatabase`
   now also accepts the async `DatabaseClient`. `queryOne`/`queryAll`/`execute` detect it
   (`isDatabaseClient`) and route to `get`/`all`/`run`, passing the original `?`-placeholder
   SQL unchanged (the client rewrites placeholders per dialect internally — so **no**
   `toPostgresSql` rewrite is applied on this branch). The raw `better-sqlite3` and bare
   `PostgresQueryExecutor` branches remain for the auth package's own tests/legacy callers.

3. **`webapp/server/db.ts` — delete the shim and the production coupling.**
   - Removed `createPostgresLegacyDatabase()`, `postgresLegacyError()`, and the
     `LegacyStatement` type.
   - `authDomainDatabase()` now `return requireDatabaseClient()` for **both** editions
     (one code path); removed the dialect branch and the `postgresAuthExecutor` wrapper.
   - Removed `dataVersion()` (moved into the adapter).
   - The raw `db` export is **retained for the SQLite integration-test harness only**,
     documented as such, and is `null` on Postgres (no shim — production never reads it).

4. **`webapp/server/realtime.ts` — poll through the adapter.** `initializeCursor()` and
   `poll()` read `await client.sqliteDataVersion?.()` instead of the removed `dataVersion()`.
   On Postgres the method returns `null`, so the external-write `refresh` branch never
   fires there — identical to the prior `DATABASE_DIALECT === 'sqlite'` guard.

### Why the raw handle is kept for tests (deliberate scope boundary)

The §3.2 goal is to remove **legacy production cruft** — the throwing shim and the
production code's dependence on a synchronous handle. Both are gone. The webapp
integration tests, however, legitimately use a synchronous SQLite handle for terse
fixture seeding and direct row assertions across ~40 call sites in 9 files
(`objectives.test.ts`, `workspaces.test.ts`, `token-scope.test.ts`, …). Those tests
always run on SQLite. Forcing them onto the async client (every `db.prepare(...).get()`
becomes an `await`) is a large, behavior-risky test rewrite with **no production
benefit**, and `seedAuthenticatedOperatorClient` already exists for tests that want the
async path. So the raw handle stays exported, clearly documented as test-only and
nullable-on-Postgres. Migrating the test harness to the async client is a clean,
low-priority follow-up if desired — tracked here, not blocking.

### Contract

`CONTRACT.md` `0.69-draft`: Database Layer gains `sqliteDataVersion()`; the
Auth → Database surface documents `DatabaseClient` as the preferred auth handle. No
schema, migration, vocabulary, protocol, REST shape, or connector impact; runtime
`CONTRACT_VERSION` (schema baseline) unchanged.

### Verification

- `typecheck:auth` clean; `typecheck:core` clean; `typecheck:webapp` byte-identical to
  the pre-change baseline (18 pre-existing unrelated errors; none in `db`/`realtime`/`auth`).
- `test:auth` 22/22; `test:core` 100/100 (incl. durable-change-feed + postgres
  conformance); webapp `token-scope` + `objectives` + `workspaces` + realtime DTO/catch-up
  21/21 (exercises `verifyUserToken` through the new `DatabaseClient` branch and the
  realtime poller).

---

## Part B — Converge the two data layers' reads (§2.2) — STAGED

### Problem (restated from the review)

`webapp/server/repository.ts` (REST data layer, web/desktop) and
`packages/core/service/missions.ts` (protocol/CLI service core) **independently**
implement `listMissions`, `searchMissions`, `listObjectives`, `listMissionEvents`, and
`listArtifacts`, each with its own SQL and its own row→DTO mapping. This is the single
largest "same intent, two implementations" surface in the codebase and the most likely
place for the REST view and the protocol view to silently disagree.

### Why this is staged rather than shipped in this objective

Read convergence is **behavior-sensitive** and crosses contract surfaces (which layer
owns the read implementation). Validating that a REST handler delegating to the core
service returns a byte-identical DTO requires **end-to-end** exercise of the web/desktop
client against a running backend — verification this mission's environment (sandboxed
Agent-Pod, no browser, native-module constraints) cannot perform reliably. Shipping a
blind read-delegation would introduce exactly the drift risk this mission is meant to
eliminate. The review itself flagged §2.2 as "a tracked follow-up rather than a drive-by."

### Recommended sequencing (smallest blast radius first)

Each phase is independently shippable, testable, and reversible. **One phase per
objective**, each verified end-to-end before the next.

1. **DTO parity audit (no code change).** For each shared read, diff the REST DTO shape
   against the core-service DTO shape field-by-field (booleans coerced `=== 1`, enum
   casts, JSON parses, derived/joined fields like tags and branch metadata). Produce a
   parity table marking each function `identical` / `REST-enriches` / `service-enriches`.
   This decides the safe delegation order.

2. **Delegate the simplest reads first.** Start with `listArtifacts` and
   `listMissionEvents` (the review's recommended entry point — least enrichment). Make the
   REST handler call the core-service function and keep `repository.ts` as a thin
   camelCase/DTO adapter **only** where the service shape and the REST shape already match.
   Add a focused integration test asserting the REST JSON is unchanged before and after.

3. **Converge the row→DTO mappers** for any function where REST enrichment (tags, branch
   DTO) blocks direct delegation, so delegation no longer requires reshaping. Keep
   explicit, hand-written mappers at the contract boundary where they earn their keep
   (per review §2.3 — do not introduce a generic `rowToCamel`).

4. **Delegate `listObjectives`, then `listMissions` / `searchMissions`** (the most
   enriched, with read-side aggregates like `completedObjectiveCount`,
   `hasExecutingObjective`). These need the aggregates to live in (or be re-exposed by)
   the core service, or to stay computed in the REST adapter over service-provided rows.

5. **Leave write paths alone** until reads are unified and tested. Writes already share
   one `entity_changes` writer (`insertEntityChange`, shipped under review item §2.1);
   converging domain writes is out of scope for this mission.

### Contract pre-spec for Part B (to be finalized when phase 2 lands)

When the first REST read begins delegating to the core service, bump `CONTRACT.md` with a
note under the **REST API → Database** and **Protocol → Database** surfaces stating that
the named read implementations are **owned by the core service layer** and the REST API
Layer is a DTO adapter over them. No DTO **shape** changes (that is the whole safety
property being verified); the change is purely *which layer owns the implementation*. No
schema, migration, vocabulary, or auth impact is expected.

### Definition of done for Part B

For every converged read: one SQL + one row-shaping implementation in the core service;
the REST handler is a thin adapter (or a direct pass-through); an integration test pins
the REST JSON output; and `ovld contract check` passes for the affected manifests.

### Optional cleanup follow-up (from Part A)

Migrate the webapp integration-test harness (`seedAuthenticatedOperator` + the ~40
synchronous `db.prepare(...)` call sites) onto the async `DatabaseClient`
(`seedAuthenticatedOperatorClient` already exists), then drop the test-only raw `db`
export entirely. Pure test-suite refactor; no production or contract impact.
