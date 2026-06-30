# Data Transfer Logic Review (mission coo:61)

Status: review + implementation. Objective 1 produced this review; objective 2
implemented the contract-safe items (1–5 below). Objective 3 implemented item 6
part A (§3.2 sync-handle retirement) and staged item 6 part B (§2.2 read
convergence) as a tracked, contract-touching follow-up.
Scope: how data moves between the database and the client (web SPA, Desktop renderer,
and CLI), the realtime change feed, and the two service/data layers that feed them.

## Implementation status (objective 2)

- **§2.1 single `entity_changes` writer — DONE.** `insertEntityChange(client, fields)`
  in `packages/core/service/change-feed.ts` owns the raw INSERT + column order; both the
  protocol `recordChange` (same file) and the REST `recordChange` (`webapp/server/db.ts`)
  route through it, passing their own `source`/`actorTokenId`.
- **§2.4 unify SSE on `connectEventStream` — DONE.** Deleted the native `EventSource`
  branch in `webapp/web/lib/realtime.tsx`; one code path handles bearer and cookie auth.
- **§2.5 `parseErrorResponse` — DONE.** Extracted in `webapp/web/lib/api.ts`; used by both
  `request<T>()` and `requestDownload()`.
- **§3.1 collapse sync/async wrapper pairs — DONE.** `recordChangeAsync` and
  `currentMaxSeqAsync` removed; call sites use `recordChange` / `currentMaxSeq`.
- **§2.3 `rowToCamel` for pure-rename mappers — NOT APPLIED (by design).** On close
  inspection every mapper coerces booleans (`=== 1`), casts enums, parses JSON, or derives
  joined fields; there is no literal `{ camel: row.snake }` mapper to collapse, and the core
  service shapes rows inline rather than through parallel named mappers. A generic converter
  would lose type-safety without removing real duplication, so per the section's own
  conservative guidance no change was made.
- **§3.2 (item 6, part A) — DONE.** The legacy synchronous `better-sqlite3` handle and the
  throwing `createPostgresLegacyDatabase()` shim are retired from production: `dataVersion()`
  moved into the adapter as `DatabaseClient.sqliteDataVersion()`, and `authDomainDatabase()`
  routes both editions through the async `DatabaseClient`. The raw `db` export is retained
  only for the SQLite integration-test harness. Contract `0.69-draft`. See plan
  `planning/feature-plans/data-layer-convergence-and-sync-handle-retirement.md`.
- **§2.2 (item 6, part B) — STAGED.** Converging the two data layers' overlapping reads is
  behavior-sensitive and needs end-to-end verification; it is planned and contract-pre-specced
  as phased follow-up objectives in the same plan document.

Verification: `typecheck:core` clean; `typecheck:webapp` error set identical to the
pre-change baseline (only pre-existing unrelated errors); `test:core` 100/100 (including the
durable-change-feed and storage suites); `test:webapp` realtime-invalidation routing,
objective/notification, and CSV suites green.

---

## 1. Intended functionality (as built today)

There are **two parallel data layers** over one schema, plus a **single realtime feed**
that keeps every client cache honest. The schema-contract boundary is described in
`CONTRACT.md` (Database Layer, REST API Layer, Protocol→Database surface).

### 1.1 The two write/read layers

| Layer | File(s) | Consumers | Transport |
|-------|---------|-----------|-----------|
| REST data layer | `webapp/server/repository.ts` (4,645 LOC) + sibling `webapp/server/*.ts` | Web SPA, Desktop renderer | HTTP/JSON via `/api/*` |
| Protocol/service core | `packages/core/service/*` (`missions.ts` 1,081 LOC, `protocol.ts`, `projects.ts`, …) | `ovld protocol`, CLI, REST handlers that delegate inward, tests | in-process service calls |

Both layers:
- Run SQL against the **same tables** (`missions`, `objectives`, `mission_events`,
  `artifacts`, `changed_files`, `change_rationales`, `projects`, …).
- Hand-map snake_case rows → camelCase DTOs.
- Append a row to `entity_changes` in the same transaction as the domain mutation.

They overlap substantially: `listMissions`, `searchMissions`, `listObjectives`,
`listMissionEvents`, `listArtifacts` exist in **both** `repository.ts` and
`packages/core/service/missions.ts`, with independent (and drift-prone) DTO shaping and
change-recording.

### 1.2 The DB → client read path (web/desktop)

```
DatabaseClient (SQLite local / Postgres hosted)
  → repository.ts SQL  → toXxxDto() hand-mapper  → DTO (camelCase, shared/contract.ts)
  → express route (webapp/server/index.ts)        → JSON
  → fetchApi() (api-transport.ts: auth header + device headers + 401 retry)
  → api.ts typed method                            → react-query hook (queries.ts)
  → React component
```

- `webapp/web/lib/api.ts` — one typed method per REST endpoint; a single `request<T>()`
  helper centralizes JSON encoding, error parsing (`ApiRequestError` with `code`/`detail`),
  and the `204 → undefined` rule. Binary uploads send raw bytes with the filename in a
  header (no multipart). This file is clean and consistent.
- `webapp/web/lib/api-transport.ts` — `fetchApi()` injects the Authorization header (bearer,
  remote mode) and device-identity headers, resolves the API base, and transparently retries
  a 401 once after clearing in-memory tokens.
- `webapp/web/lib/queries.ts` — the `keys` registry (one place defining every react-query
  key) plus 57 `useXxx` hooks. The `keys` object is the contract that
  `realtime-invalidation.ts` routes against.

### 1.3 The realtime (DB → client push) path

```
domain mutation + recordChange() → entity_changes (seq, entity_type, changed_fields_json, …)
  → RealtimeHub.poll() every 500ms (webapp/server/realtime.ts)
  → SSE 'change' {changes, cursor}  (or coarse 'refresh')
  → client SSE reader (fetch-sse.ts OR native EventSource — see §3.4)
  → applyChangePayload() advances cursor (realtime.tsx)
  → invalidateRealtimeChanges() routes entityType→query keys (realtime-invalidation.ts)
  → react-query refetches only the affected keys
```

Two safety nets keep the UI correct regardless of who wrote to the DB:
1. The `entity_changes` `seq` cursor forwards every mutation either data layer records.
2. (SQLite only) `PRAGMA data_version` detects an *external* writer that bypassed the feed
   and emits a coarse `refresh` so clients refetch everything.

Catch-up after a reconnect is by `?after=<cursor>` against `/realtime` (and `/sync/changes`
for the polled fallback), so no delta is missed across a dropped connection.

This realtime design is sound and is the strongest part of the data-transfer story. The
problems below are about **duplication and transitional cruft**, not about the architecture.

---

## 2. DRY / modularity / simplification opportunities

### 2.1 (High) Two `entity_changes` writers that can silently diverge

- `webapp/server/db.ts:450` `recordChangeAsync()` — `source` hardcoded `'webapp'`,
  fills `actor_token_id` from `getActiveTokenId()`, workspace/actor from module globals.
- `packages/core/service/change-feed.ts:6` `recordChange()` — `source` from `ctx.source`,
  `actor_token_id` **hardcoded `NULL`**, workspace/actor from `ctx`.

These are the same INSERT with different column-fill rules. The columns
(`actor_token_id`, `source`) already differ between the two paths, which is exactly the kind
of drift a single writer prevents. **Proposal:** extract one parameterized
`insertEntityChange(client, fields)` (the raw SQL + column list) into the database/core
package, and have both `db.ts` and `change-feed.ts` call it, passing their context-specific
`source`/`actor`/`workspace`. The SQL and column order live in exactly one place.

### 2.2 (High) Overlapping read functions across the two data layers

`repository.ts` and `packages/core/service/missions.ts` independently implement
`listMissions`, `searchMissions`, `listObjectives`, `listMissionEvents`, `listArtifacts`,
each with its own SQL and its own row→DTO mapping. This is the single largest source of
"same intent, two implementations" in the codebase and the most likely place for the REST
view and the protocol view to disagree.

Full unification is a large effort and crosses the Database/REST/Protocol contract surfaces,
so treat it as a tracked follow-up rather than a drive-by. Recommended incremental path:
1. Make `repository.ts` REST handlers **delegate reads** to the core service functions where
   the shapes already match (start with `listArtifacts`, `listMissionEvents` — the simplest),
   keeping `repository.ts` as the camelCase/DTO adapter only.
2. Converge the DTO mappers (§2.3) so delegation does not require reshaping.
3. Leave write paths alone until reads are unified and tested.

### 2.3 (Medium) ~14 hand-written row→DTO mappers, no shared key-casing helper

`toProjectDto`, `toStatusDto`, `toProjectResourceDto`, `toMissionDto`, `toObjectiveDto`,
`toProjectTagDto`, `toMyMissionDto`, `toProfileDto`, `toUserTokenDto`, `missionBranchDto`, …
(`webapp/server/repository.ts`) plus parallel mappers in the core service. There is **no**
generic snake→camel converter anywhere (confirmed by grep). Most mappers are pure field
renames; a few add derived/joined data (tags, branch metadata).

**Proposal:** introduce one tiny `rowToCamel()` helper for the pure-rename mappers and reserve
hand-written mappers only for the ones that genuinely enrich (tags, branch DTO). This removes
the bulk of the boilerplate while keeping explicit shaping where it earns its keep. Keep it
conservative — explicit mappers are valuable at the contract boundary, so only collapse the
ones that are literally `{ camel: row.snake }` today.

### 2.4 (Medium) Duplicated SSE client wiring in `realtime.tsx`

`webapp/web/lib/realtime.tsx` has two SSE implementations:
- `connectEventStream()` (`fetch-sse.ts`) — used for remote backend or when an auth header is
  present; supports custom headers and reconnect-with-`?after`.
- A native `EventSource` branch (`realtime.tsx:105-139`) — used only for the local,
  same-origin, cookie-auth case, re-wiring `onOpen`/`onHello`/`onChange`/`onRefresh`/`onError`
  by hand against `applyChangePayload`/`invalidateAll`.

`connectEventStream` already handles the cookie case (`credentials: 'include'` when no
Authorization header). The native branch is redundant. **Proposal:** always use
`connectEventStream` and delete the `EventSource` branch (~35 lines), so there is one SSE code
path and one set of handlers. (Verify the local cookie stream over `fetch` keep-alive in the
Desktop renderer before removing — that is the one environment to smoke-test.)

### 2.5 (Low) `request<T>()` and `requestDownload()` duplicate error parsing

`webapp/web/lib/api.ts:138-152` and `:170-184` contain the same 20-line non-2xx
error-extraction block. Extract a `parseErrorResponse(res)` helper used by both.

---

## 3. Legacy / transitional / unused code

### 3.1 Redundant sync/async wrapper pairs (Postgres-migration residue) — resolved

The async DatabaseClient migration (mission coo:5) left dead-weight pass-through wrappers.
Objective 2 removed them:

- `recordChangeAsync()` was deleted; all REST call sites now use `recordChange()`.
- `currentMaxSeqAsync()` was deleted; `webapp/server/realtime.ts` now calls
  `currentMaxSeq()`.

The `Async` suffix no longer distinguished anything once the client was uniformly async, so
this migration artifact is gone.

### 3.2 Legacy sync SQLite handle and Postgres shim in `db.ts` — production path resolved

Objective 3 completed the production-path half of this cleanup under contract `0.69-draft`:

- `createPostgresLegacyDatabase()` and its throwing `postgresLegacyError()` shim were
  deleted.
- The realtime poller's SQLite `PRAGMA data_version` probe moved behind
  `DatabaseClient.sqliteDataVersion()`.
- `authDomainDatabase()` now returns the async `DatabaseClient` for both SQLite and
  Postgres, so auth token verification no longer receives a raw synchronous handle.

`webapp/server/db.ts` still exports the raw synchronous `better-sqlite3` handle only for the
SQLite integration-test harness, where direct fixture seeding and row assertions remain
deliberately synchronous. That test harness migration is optional follow-up work; it is not a
production blocker and does not affect the Postgres runtime.

### 3.3 `sqliteDataVersion()` is SQLite-only by design

Not a bug — but note that the external-writer `refresh` safety net (§1.3 path 2) exists only
on local SQLite. On hosted Postgres `DatabaseClient.sqliteDataVersion()` returns `null`, and
the only change-detection is the `entity_changes` feed. That is acceptable because on
Postgres every writer goes through the service layer; the contract now documents this so
nobody assumes the `data_version` net protects the hosted deployment.

---

## 4. Recommended sequencing

Smallest-blast-radius first; each step is independently shippable and testable. Current
status:

1. **§3.1** delete the redundant sync/async wrappers — done.
2. **§2.5** extract `parseErrorResponse` in `api.ts` — done.
3. **§2.4** unify on `connectEventStream`, delete the native `EventSource` branch — done.
4. **§2.1** single `insertEntityChange()` writer shared by both layers — done.
5. **§2.3** `rowToCamel()` for pure-rename DTO mappers — assessed and intentionally skipped
   because no pure-rename mappers exist.
6. **§3.2** retire production use of the legacy sync `db` handle — done under contract
   `0.69-draft`.
7. **§2.2** converge the two data layers' overlapping reads — staged as phased follow-up in
   `planning/feature-plans/data-layer-convergence-and-sync-handle-retirement.md`.

The remaining §2.2 read-convergence work will require a future `CONTRACT.md` note because it
changes which layer owns the read implementations.
