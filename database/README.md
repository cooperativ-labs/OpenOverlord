# Database Module

OpenOverlord's persistence layer. SQLite is the default local database; the
schema is defined as a portable contract so other adapters (e.g. Postgres) can
implement it and pass conformance tests. This module also hosts the **extension
system** — the sanctioned ways to extend the schema without forking it.

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

## Code & Tests (colocated)

Migrations live here, numbered sequentially:

### `sqlite/migrations/001_initial_core.sql`
Core MVP slice: all tables for the local ticket/objective/session workflow, the
change feed, and idempotency. Seeds deterministic rows for the default local
workspace, implicit user, workspace membership, and workspace-scoped ticket sequence.

### `sqlite/migrations/002_rbac.sql`
Group 1 (Multi-User Access and API Tokens):
- `role_assignments` — durable workspace-user-to-role membership. Empty-string sentinels for `resource_type`/`resource_id` represent workspace-level scope so the unique-active-assignment index works on both SQLite and Postgres.
- `user_tokens` — USER_TOKEN metadata and hashes only; raw secrets are never stored.
- `user_token_scopes` — reserved for future token-level permission restrictions.

Seeds an `ADMIN` role assignment for the implicit local workspace user. This
provides the schema foundation for the [Auth module](../auth/README.md); the
authorization logic itself lives above the database layer.

## Applying Locally

```sh
sqlite3 .overlord/openoverlord.sqlite < database/sqlite/migrations/001_initial_core.sql
sqlite3 .overlord/openoverlord.sqlite < database/sqlite/migrations/002_rbac.sql
```

Each migration enables SQLite foreign-key checks for the connection. A future
migration runner should insert the corresponding `schema_migrations` row with
its computed checksum after each migration commits. Real initialization code may
replace the seed IDs with generated stable IDs, but tests can rely on the
deterministic values from these migrations.

## Extension Surface

Extend the schema only through the sanctioned paths: `ext_<name>_`-prefixed
tables with `schema_migrations.component = 'ext:<name>'`, namespaced JSON
metadata keys, and reactions via service APIs / `entity_changes` / `outbox_messages`
— never direct writes to core tables. See the Extension Points section of
[`CONTRACT.md`](../CONTRACT.md) and [`contract/extension-points.yaml`](../contract/extension-points.yaml).
