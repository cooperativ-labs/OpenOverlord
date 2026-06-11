# Database Module

Overlord's persistence layer. PostgreSQL is the authoritative database for
shared/private-network deployments; SQLite remains the default local development
database. The schema is defined as a portable contract so adapters can implement
it and pass conformance tests. This module also hosts the **extension system** —
the sanctioned ways to extend the schema without forking it.

## Contract Components

This module is the developer-facing home for two components in
[`CONTRACT.md`](../CONTRACT.md):

| Component | Stable id | What it owns |
| --- | --- | --- |
| Database Layer | `database` | Table/column definitions, indexes, FKs, CHECK constraints, controlled vocabularies, soft-delete/revision semantics, migration versioning, logical types |
| Extension System | `extension` | `user_harness_extensions` authoring + `workspace_harness_extensions` promotion, `ext_<name>_` table namespace, `ext:<name>` migration component naming, namespaced JSON metadata keys |

The Database Layer does **not** own service-layer business logic or REST
response shapes (→ [webapp module](../webapp/README.md)).

## Documentation

- [09 — Database Schema Contract](docs/09-database-schema-contract.md): column/index/FK definitions, default-DB recommendation, core tables, realtime/sync, migration discipline, REST API Boundary, and Extension Points.
- [09 — Schema Contract Review](docs/09-database-schema-contract-review.md): review notes on the schema contract.
- [10 — Database Table Groups](docs/10-database-table-groups.md): which tables are core vs. à la carte, grouped optional sets, and the agent setup decision tree.
- [11 — SQLite Vs PostgreSQL For Multi-Agent Use](docs/11-sqlite-vs-postgresql-multi-agent.md): database tradeoffs for local agents, hosted deployments, remote runners, queue claiming, and write concurrency.
- [12 — Private-Network PostgreSQL Deployment Plan](docs/12-private-network-postgresql-deployment-plan.md): recommended architecture when shared organization state starts on a private-network database with multiple clients and distributed runners.
- [13 — Database Seeding Framework](docs/13-database-seeding-framework.md): recommendation for how to seed development/test data — a first-party Kysely + faker seed runner over the service layer, and why a third-party seeding framework (Prisma/Drizzle/Snaplet) is the wrong fit.
- [Test Plan](docs/testing.md): adapter-parity test plan implementing the schema contract's Adapter Conformance Suite (DDL, concurrency, change feed, uniqueness, queue claiming, soft delete, extension migrations) across SQLite and Postgres. Part of the root [TEST_PLAN.md](../TEST_PLAN.md).

## Code & Tests (colocated)

Migrations live here, numbered sequentially:

### `sqlite/migrations/001_initial_core.sql` and `postgres/migrations/001_initial_core.sql`
Core MVP slice: all tables for the local ticket/objective/session workflow, the
change feed, and idempotency. Seeds deterministic rows for the default local
workspace, implicit user, workspace membership, and workspace-scoped ticket sequence.

The PostgreSQL migration uses native `jsonb`, `boolean`, `timestamptz`, and a
`bigint` identity cursor for `entity_changes.seq`. It also adds a claimable
queue index for `execution_requests` so service-layer runner claims can use
`FOR UPDATE SKIP LOCKED` efficiently.

### `sqlite/migrations/002_rbac.sql` and `postgres/migrations/002_rbac.sql`
Group 1 (Multi-User Access and API Tokens):
- `role_assignments` — durable workspace-user-to-role membership. Empty-string sentinels for `resource_type`/`resource_id` represent workspace-level scope so the unique-active-assignment index works on both SQLite and Postgres.
- `user_tokens` — USER_TOKEN metadata and hashes only; raw secrets are never stored.
- `user_token_scopes` — reserved for future token-level permission restrictions.

Seeds an `ADMIN` role assignment for the implicit local workspace user. This
provides the schema foundation for the [Auth module](../auth/README.md); the
authorization logic itself lives above the database layer.

### `sqlite/migrations/003_better_auth.sql` and `postgres/migrations/003_better_auth.sql`
Auth-owned Better Auth implementation tables (`user`, `session`, `account`,
`verification`) in the same adapter database. No other component should read or
write these tables directly.

## Applying Locally

Use the Node-based local launcher for the default SQLite development database:

```sh
yarn db:launch:local
```

This creates `.overlord/Overlord.sqlite`, enables SQLite foreign keys, WAL mode,
and a short busy timeout for the launch connection, applies the core SQLite
migrations in order, and records each applied migration in `schema_migrations`
with a SHA-256 checksum. Set `OVERLORD_SQLITE_PATH=/path/to/Overlord.sqlite` to
launch a database file outside the default location.

If `yarn db:launch:local` or `yarn start:local` fails with `ERR_DLOPEN_FAILED`
or `invalid ELF header` while loading `better-sqlite3`, the repo is using a
`node_modules` tree built for a different OS or CPU architecture. Reinstall
dependencies inside the same environment where you run Overlord:

```sh
rm -rf node_modules
yarn install
```

Manual SQL application remains useful for adapter experiments:

```sh
sqlite3 .overlord/Overlord.sqlite < database/sqlite/migrations/001_initial_core.sql
sqlite3 .overlord/Overlord.sqlite < database/sqlite/migrations/002_rbac.sql
sqlite3 .overlord/Overlord.sqlite < database/sqlite/migrations/003_better_auth.sql

psql "$DATABASE_URL" -f database/postgres/migrations/001_initial_core.sql
psql "$DATABASE_URL" -f database/postgres/migrations/002_rbac.sql
psql "$DATABASE_URL" -f database/postgres/migrations/003_better_auth.sql
```

Each migration enables SQLite foreign-key checks for the connection. The local
launcher records the corresponding `schema_migrations` row with its computed
checksum after each migration commits. Real initialization code may replace the
seed IDs with generated stable IDs, but tests can rely on the deterministic
values from these migrations.

## Extension Surface

Extend the schema only through the sanctioned paths: `ext_<name>_`-prefixed
tables with `schema_migrations.component = 'ext:<name>'`, namespaced JSON
metadata keys, and reactions via service APIs / `entity_changes` / `outbox_messages`
— never direct writes to core tables. See the Extension Points section of
[`CONTRACT.md`](../CONTRACT.md) and [`contract/extension-points.yaml`](../contract/extension-points.yaml).
