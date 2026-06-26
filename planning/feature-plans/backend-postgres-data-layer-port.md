# Backend Postgres Data-Layer Port — Staged Plan

Mission `ove:2`, objective 2. Prerequisite blocker for the Railway/Neon live
cutover. Port the **bundled backend** data layer from synchronous
`better-sqlite3` (`db.prepare(sql).get(args)`) to the async, adapter-agnostic
`DatabaseClient` (`await db.get(sql, [args])`) so the same hand-written SQL runs
on SQLite (Overlord Local) and Postgres (Railway phase 1 / Neon phase 2). The
async `DatabaseClient`, the Postgres migration runner, the async queue
primitives (`queue-runtime.ts`), and the adapter conformance tests already
landed (mission `coo:5` / objective 3); this objective ports the **running
server** onto that client.

## Scope is contained to the bundled backend

The CLI talks to the backend over HTTP (`ovld protocol …`), not the database, so
it is **not** a direct DB consumer and does not ripple. Better Auth is already
Postgres-capable. The conversion is confined to two trees that both run inside
`webapp/dist-server/index.cjs`:

| Tree | `.prepare()` sites (non-test) | Placeholder style |
| --- | ---: | --- |
| `webapp/server/*` | ~265 | **named** `@param` (171 in `repository.ts`) |
| `packages/core/service/*` | ~120 | positional `?` (already client-shaped) |
| **Total** | **~385 across ~25 files** | |

Per-file inventory (non-test):

```
130  webapp/server/repository.ts          43  packages/core/service/protocol.ts
 28  webapp/server/workspaces.ts          29  packages/core/service/missions.ts
 16  webapp/server/launch.ts              21  packages/core/service/execution-requests.ts
 10  webapp/server/storage.ts             20  packages/core/service/storage.ts
  7  webapp/server/runner.ts               8  packages/core/service/projects.ts
  5  webapp/server/everhour.ts             8  packages/core/service/execution-targets.ts
  5  webapp/server/db.ts                   7  packages/core/service/context.ts
  4  webapp/server/title-automation.ts     4  packages/core/service/devices.ts
  4  webapp/server/auth.ts                 2  packages/core/service/changes.ts
  3  webapp/server/workspace-settings.ts   1  packages/core/service/profiles.ts
  1  webapp/server/realtime.ts             1  packages/core/service/change-feed.ts
  1  webapp/server/rbac.ts
```

## Why this is not purely mechanical — three design hazards

The bulk is a mechanical `db.prepare(sql).get(args)` → `await db.get(sql,
[args])` rewrite (plus making each caller `async` up the stack). But three
issues are real design work and must be settled before bulk conversion:

### Hazard 1 — per-request module globals become a concurrency bug

`webapp/server/db.ts` keeps request state in **module-level `let` bindings**:
`ACTOR_WORKSPACE_USER_ID`, `ACTIVE_TOKEN_ID`, `ACTIVE_TOKEN_SCOPES`, and the
active `WORKSPACE`. Its own comment states this is "safe because the server
handles requests sequentially with **synchronous** better-sqlite3 handlers."
**That invariant dies the moment handlers `await`** — two in-flight requests
interleave on the event loop and clobber each other's actor/token/workspace.
There are **237 references** to these globals across `webapp/server`.

**Fix:** move per-request state into an `AsyncLocalStorage<RequestContext>`
established once in the `handle()` wrapper / auth middleware (`webapp/server/index.ts`
already funnels every route through `handle()` and `requireAuthenticatedSession`).
`recordChange`, `requirePermission`, and workspace resolution read from the
store instead of module `let`s. The active-`WORKSPACE` switch
(`setActiveWorkspace`) is a process-wide setting for Local single-tenant use and
can stay process-global, but actor/token attribution must be request-scoped.

### Hazard 2 — synchronous module-init in `db.ts`

`db.ts` opens the database, runs `migrateDatabase`, seeds `WORKSPACE`/actor, and
builds a module-level prepared statement (`insertChangeStmt`) **at import time**,
synchronously. Postgres init is async (`openDatabaseClient`, `migratePostgres`).
**Fix:** replace top-level side effects with an `async function initDatabase()`
awaited once during server bootstrap (before `app.listen`), exporting the
resolved `DatabaseClient` plus a resolved initial workspace. The boot-throw guard
(`db.ts:40-50`) that rejects a `postgres://` URL is removed as part of this.

### Hazard 3 — dialect-specific SQL (small, enumerated)

The portable-SQL surface is tiny and fully enumerated here:

| Location | SQLite | Postgres | Handling |
| --- | --- | --- | --- |
| `db.ts:61-63` | `pragma journal_mode/foreign_keys/busy_timeout` | n/a | SQLite-only connection setup; guard on `dialect === 'sqlite'` |
| `db.ts:281` | `pragma data_version` | n/a | SQLite change-poll heuristic; on Postgres use `currentMaxSeq()` (already exists) — `realtime.ts` must branch |
| `repository.ts:3030` | `INSERT OR IGNORE` | `INSERT … ON CONFLICT DO NOTHING` | dialect branch or portable `ON CONFLICT` (works on both modern SQLite + PG) |
| `repository.ts:3304-3314` | `pragma foreign_keys = OFF/ON` | `SET CONSTRAINTS ALL DEFERRED` | dialect branch around the bulk delete |
| `changes.ts:100` | `GROUP_CONCAT(label, char(10))` | `string_agg(label, chr(10))` | dialect branch (both invoked via `client.dialect`) |
| named params everywhere in `webapp/server` | `@name` | — | rewrite to positional `?` + ordered array (the client only rewrites `?`→`$n`) |
| `lastInsertRowid` (autoincrement reads) | populated | never populated | audit: schema uses text UUIDs (`newId()`); confirm no path depends on rowid |

`kysely` types (`packages/core/types/db.ts`) are generated `--dialect sqlite`;
the row *shapes* are dialect-agnostic (timestamps/json already normalized to
strings by the `pg` type parsers in `client.ts`). Regenerate/verify after schema
parity is confirmed; no per-column retype is expected.

## Conversion rules (apply uniformly)

1. `x.prepare(SQL).get(a, b)` → `await x.get(SQL, [a, b])`
2. `x.prepare(SQL).all(a)` → `await x.all(SQL, [a])`
3. `x.prepare(SQL).run(a)` → `await x.run(SQL, [a])` (use `.changes`, never `.lastInsertRowid` on PG)
4. Named `@param` objects → positional `?` with an ordered param array (rewrite the SQL too).
5. `x.transaction(fn)(args)` (better-sqlite3) → `await x.transaction(async tx => …)` (client).
6. Every function containing a converted call becomes `async`; propagate `await` to all callers.
7. `ServiceContext.db: OverlordDatabase` → `DatabaseClient`; `createServiceContext` becomes `async`.
8. Route handlers stay registered through `handle()` — already promise-tolerant; just return the awaited value.

## Staged sequence (each stage is an agent-sized objective, build green at every boundary)

Because a sync→async conversion cannot stay type-green while half-done across a
call graph, stages are **vertical and leaf-first**: convert the lowest-level
shared modules and everything that calls them within the same stage.

- **Stage 1 — Foundation & request context.**
  `db.ts` async bootstrap (`initDatabase()` → resolved `DatabaseClient`), remove
  the postgres:// boot-throw, introduce `AsyncLocalStorage<RequestContext>` in
  `index.ts`/auth middleware, port `recordChange`/`currentMaxSeq`/workspace
  resolution, and branch `realtime.ts` off `data_version`. Wire
  `service/context.ts` (`createServiceContext` async, `db: DatabaseClient`).
  *Exit:* server boots on SQLite unchanged; auth context request-scoped; no
  module-global actor/token reads remain.

- **Stage 2 — Service layer (`packages/core/service/*`).**
  Convert `missions.ts`, `protocol.ts`, `execution-requests.ts`, `storage.ts`,
  `projects.ts`, `execution-targets.ts`, `devices.ts`, `changes.ts`,
  `profiles.ts`, `change-feed.ts` to async on the client. Reuse the existing
  async `queue-runtime.ts` for claim/recovery (delete or delegate the sync
  `execution-requests.ts` claim path). *Exit:* `packages/core/service` is
  async end-to-end; existing service tests pass on SQLite.

- **Stage 3 — REST repository (`webapp/server/repository.ts`, 130 sites).**
  The largest single file; named-param rewrite + async. Split into review-sized
  commits by domain (workspaces/statuses, projects/resources/tags,
  missions/objectives, tokens, branches). *Exit:* all `/api` reads/writes async.

- **Stage 4 — Remaining webapp modules.**
  `workspaces.ts`, `launch.ts`, `runner.ts`, `storage.ts`, `everhour.ts`,
  `title-automation.ts`, `auth.ts`, `workspace-settings.ts`, `rbac.ts`,
  `realtime.ts`. *Exit:* zero non-test `.prepare()` in `webapp/server`.

- **Stage 5 — Verification on both adapters.**
  Run the conformance/adapter battery against SQLite (default) and Postgres
  (`TEST_DATABASE_URL` → a throwaway Neon branch or local PG). Boot the bundled
  server against a `postgres://` `DATABASE_URL` and walk the deployment
  verification checklist (health, REST auth+lists, protocol attach/update/deliver,
  runner claim, `/api/stream` delta). Regenerate kysely types and confirm schema
  parity. *Exit:* objective 2 acceptance — green on both adapters, server boots
  on Postgres with no better-sqlite3 throw.

## Test strategy

- `packages/core/service/postgres-conformance.test.ts` already runs the battery
  against SQLite always and Postgres when `TEST_DATABASE_URL` is set (each test
  in a throwaway `ovld_test_*` schema). Extend it as service modules convert.
- Provision a Postgres for `TEST_DATABASE_URL` before Stage 5: a Neon branch off
  `production` (project `little-term-34261138`) or the Railway Postgres once
  provisioned (objective 3). Branch-and-drop keeps the shared DB clean.
- Keep SQLite (Local/Electron) as the always-on default; every stage must leave
  `yarn test` green on SQLite independent of Postgres availability.

## Risks / watch-items

- Transaction boundaries: better-sqlite3 transactions are synchronous and
  implicit; the client's `transaction(async tx => …)` must wrap the *same* unit
  of work, and every `recordChange` inside a mutation must run on the `tx`
  client, not the pooled one, or the realtime feed can diverge.
- `realtime.ts` `data_version` poll is SQLite-only; the Postgres path must poll
  `MAX(seq)` from `entity_changes` (already exposed via `currentMaxSeq()`).
- Per-request `AsyncLocalStorage` must wrap the *entire* async handler including
  `realtime.pollNow()` so attribution holds across awaits.
- `lastInsertRowid` audit: confirm no insert path reads it (schema is UUID-keyed).
```
