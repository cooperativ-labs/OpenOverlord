# 13 — Database Seeding Framework

**Status:** Recommendation (decision record)
**Question:** "We need the ability to seed the DB with data. What framework should we use for this?"

## TL;DR

**Do not adopt a third-party "seeding framework."** Build a thin, first-party
seed runner that mirrors the existing migration launcher
([`database/src/launch-local.ts`](../src/launch-local.ts)) and
composes the tools already in the stack:

- **Kysely** for inserts — it is already the query builder and is dialect-aware,
  so one seed module works across both the SQLite and Postgres adapters.
- The **service layer** ([`webapp/server/repository.ts`](../../webapp/server/repository.ts))
  for core-domain entities, so `entity_changes`, `revision`, and idempotency stay
  consistent with [`CONTRACT.md`](../../CONTRACT.md).
- **`@faker-js/faker`** (one small dev dependency) only as a *data generator* for
  realistic volume — it never touches the database, so it stays adapter-neutral.
  Seed its RNG with a fixed value for reproducible fixtures.

This keeps the dependency footprint lean, honors the dual-adapter contract, and
reuses the launcher pattern the repo already established for migrations.

## Why a dedicated framework is the wrong fit here

The constraints that decide this come straight from the existing architecture:

1. **Dual-adapter portability.** SQLite is the local default; PostgreSQL is
   authoritative for shared deployments (see
   [11 — SQLite Vs PostgreSQL](11-sqlite-vs-postgresql-multi-agent.md)). Any seed
   path must run unchanged on both. Kysely already abstracts the dialect; raw SQL
   seed files would have to be maintained twice.

2. **No ORM — deliberately.** The project uses Kysely (a query builder) plus
   `kysely-codegen` for types, not Prisma/Drizzle/TypeORM. The schema lives in
   hand-written SQL migrations, not an ORM schema DSL.

3. **Service-layer write discipline.** `CONTRACT.md` → *Protocol → Database* and
   *REST API → Database* require that core-domain writes go through the service
   layer, which appends `entity_changes` and bumps `revision` in the same
   transaction. A seeder that bulk-inserts raw rows would bypass the change feed
   and desync the realtime poller.

4. **Lean dependencies + an existing launcher pattern.** `package.json` is
   intentionally small, and `launch-local.ts` already establishes how we run
   Node/TS database tooling (resolve path → apply units in order → record state).
   A seed runner should look like its sibling.

## Options considered

| Option | Verdict | Reasoning |
| --- | --- | --- |
| **First-party Kysely + faker runner (recommended)** | ✅ Adopt | Adapter-portable, reuses service layer + launcher pattern, one tiny dependency. |
| `prisma db seed` | ❌ Reject | Requires adopting Prisma ORM and a second source of schema truth; reverses a deliberate architecture choice. |
| `drizzle-seed` | ❌ Reject | Coupled to Drizzle ORM; same problem as Prisma. |
| `@snaplet/seed` | ❌ Reject | Snaplet wound down its product; the seed tool is no longer actively maintained — risky to depend on. |
| Per-adapter raw SQL seed files | ❌ Reject | Doubles maintenance (SQLite + Postgres), bypasses the service layer / change feed, drifts from schema. |
| knex / TypeORM seeders | ❌ Reject | Adds a second migration/query framework alongside Kysely; redundant. |

## What "seeding" means here (three tiers)

Be explicit about which tier each row belongs to — they have different owners:

1. **Reference / bootstrap seed (already handled).** The default workspace,
   implicit user, workspace membership, mission sequence, and `ADMIN` role are
   seeded *inside the migrations* (`001_initial_core.sql`, `002_rbac.sql`). This
   is deterministic install state and stays in migrations. **Do not** move it into
   the dev seeder.

2. **Development sample data (the gap this mission addresses).** Realistic
   projects, missions, objectives, statuses, and events so the webapp and CLI have
   something to render. This is what the new seed runner generates, routed through
   the service layer, and is safe to wipe/regenerate.

3. **Test fixtures.** Small deterministic datasets for the adapter-parity suite
   (`database/docs/testing.md`). Use the same seed modules with a fixed faker seed
   so assertions are stable.

## Recommended implementation shape (next objective)

```
database/src/seed-local.ts      # runner; mirrors launch-local.ts
database/src/seeds/*.ts          # composable seed modules (projects, missions, …)
```

- The runner resolves the DB path, asserts migrations are applied, then runs the
  seed modules in order — idempotently, with an optional `--reset` to truncate
  dev data first (never the bootstrap seed).
- Core-domain rows are created via the exported `createProject` / `createMission` /
  `createObjective` service functions so the change feed and revisions stay valid.
- `@faker-js/faker` (devDependency) generates names/descriptions/volume; the RNG
  is seeded with a constant for reproducibility.
- Add a script: `"db:seed:local": "tsx database/src/seed-local.ts"`.

No contract change is required: this introduces no new tables, vocabularies, or
interaction surfaces — it composes the existing service layer through a sanctioned
surface.
