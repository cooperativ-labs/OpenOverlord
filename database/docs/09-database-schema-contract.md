# Database Schema Contract

Contract Version: `0.4-draft`

## Goal

Define the first-pass persistence contract for Overlord so local CLI, REST APIs, future web UI, runners, workers, and optional sync clients all operate on the same durable model.

This document is a schema contract, not a one-database implementation. PostgreSQL should be the authoritative database for shared deployments, SQLite should remain available for local development, and the logical schema must stay portable enough for both adapters.

## Recommendation: PostgreSQL For Shared Deployments, SQLite For Local Development

Overlord should use PostgreSQL as the authoritative database for shared
organization, hosted, private-network, or remote-runner deployments. SQLite
remains useful as the default local development and single-workstation database.

Reasons to keep SQLite for local development:

- The first product surface is local and CLI-first.
- SQLite has no separate service to install, configure, secure, or back up before `ovld init`.
- The local runner can poll a local SQLite database reliably when WAL mode and short transactions are used.
- Attachments and local repository metadata already have a local filesystem boundary.
- A single-user local instance does not need Postgres operational complexity.

Reasons to use PostgreSQL for shared deployments:

- Hosted REST APIs, edge functions, and remote workers need a network-addressable database.
- Postgres has stronger concurrent writer behavior for shared instances.
- `LISTEN/NOTIFY`, logical replication, and mature JSON/indexing are useful for realtime UI and sync.
- Managed Postgres is a common deployment target for open-source web apps.

This choice does not change the logical schema. It does affect implementation details:

- SQLite stores logical JSON as text, optionally validated with JSON functions. Postgres should use `jsonb`.
- SQLite uses `INTEGER` booleans and text timestamps. Postgres can use native `boolean` and `timestamptz`.
- SQLite has one writer at a time. Postgres can support higher concurrency.
- Realtime should not depend on Postgres-only triggers or notifications. The canonical realtime source should be an application-written change feed, with Postgres notifications as an optimization.
- Edge functions should use the REST/service layer or a Postgres adapter. They should not assume access to a user's local SQLite file.

## Contract Principles

- Clients should use application services or REST APIs, not direct table writes.
- The database schema is a durable implementation contract for adapters, migrations, tests, and extension authors.
- Domain state transitions live in services. Database constraints enforce shape, ownership, uniqueness, and referential integrity.
- Every persisted domain record should have a stable text ID that can survive export/import and client sync.
- All mutable domain tables should include `created_at`, `updated_at`, `deleted_at`, and `revision`.
- Deletes should normally be soft deletes so REST clients, realtime subscribers, and local sync clients can observe tombstones.
- Append-only history should be preferred for audit records, mission events, deliveries, and sync changes.
- The schema should avoid native database enums in the contract. Use stable text values plus adapter checks or application validation.
- Full repository contents, raw token secrets, and raw session secrets must not be persisted.
- Soft delete state is represented by `deleted_at`, not by duplicating terminal `deleted` or `removed` status values.
- Mutable row updates must use `revision` as an optimistic concurrency token.

## Conventions And Glossary

- `active` means `deleted_at IS NULL`.
- `TimestampUTC` values are UTC and fixed-width. SQLite must store them as ISO-8601 text in `YYYY-MM-DDTHH:MM:SS.SSSZ` form. Do not mix text timestamps with epoch integers in the same database.
- Public JSON/API fields use camelCase. Physical database columns use snake_case. A `*_json` column drops the suffix in public JSON names, for example `metadata_json` becomes `metadata`.
- Stable IDs should be UUIDv7 or ULID strings. Integer primary keys are not part of the portable contract.
- `revision` starts at `1` for inserted mutable rows and increments by exactly one for each service-layer mutation.
- `metadata_json` and `settings_json` are extension space, but extension keys must be namespaced. Use reverse-DNS or package-style keys such as `com.example.plugin`, with a nested `schemaVersion` where the extension stores structured data.
- Tables without `created_at`, `updated_at`, `deleted_at`, and `revision` are intentional operational or append-only tables. Current exemptions are `mission_sequences`, `mission_events`, `shared_context_tags`, `entity_changes`, `sync_cursors`, `outbox_messages`, `search_documents`, `audit_log`, and `schema_migrations`.
- Columns named `position` (and the mission board ordering column `board_position`) must use a reorder strategy that does not violate active uniqueness mid-transaction. Services should use gap-based integer positions by default, for example `100`, `200`, `300`; compacting positions is a maintenance operation. `board_position` is not uniqueness-constrained, so services may renumber a whole board column densely on each reorder.

## Logical Types

Adapters should map these logical types to their database-native equivalents.

| Logical type | SQLite | Postgres | Notes |
| --- | --- | --- | --- |
| `Id` | `TEXT` | `text` or `uuid` | Prefer UUIDv7 or ULID string. Do not require integer IDs. |
| `DisplayId` | `TEXT` | `text` | Human IDs such as `1:1204`. |
| `TimestampUTC` | `TEXT` ISO-8601 UTC | `timestamptz` | SQLite stores fixed-width `YYYY-MM-DDTHH:MM:SS.SSSZ`; services normalize to UTC. |
| `Json` | `TEXT` containing JSON | `jsonb` | Empty object default should be `{}`. |
| `Bool` | `INTEGER` 0/1 | `boolean` | Use service-layer normalization. |
| `SecretHash` | `TEXT` | `text` | Hash only. Never raw token/session secrets. |
| `Path` | `TEXT` | `text` | Store normalized display path, not file contents. |
| `ChangeSeq` | `INTEGER` | `bigint` | Monotonic change-feed cursor. |
| `BigCount` | `INTEGER` | `bigint` | File sizes, feed cursors, and counters that can exceed 32-bit integer range. |

The public contract should use canonical JSON field names even when physical columns are snake_case.

## Adapter Requirements

Any supported database adapter must provide:

- ACID transactions.
- Foreign key enforcement.
- Unique constraints.
- Indexed lookups by ID, workspace/project/mission, status, and updated time.
- Atomic compare-and-set updates for queue claiming and state transitions.
- A way to allocate monotonic mission sequence numbers.
- A way to append `entity_changes` in the same transaction as domain mutations.
- Commit-safe change-feed visibility for any multi-writer adapter.
- Migration tracking.

Adapters may add optimized indexes, generated columns, full-text indexes, triggers, or notification mechanisms as long as they preserve the logical contract.

In index notes, "active" means `deleted_at IS NULL`. SQLite and Postgres adapters must use partial unique indexes for "one active X" rules. Service-layer transaction checks may supplement those indexes, but must not replace them for invariants both supported adapters can enforce.

Adapter conformance tests must cover required tables, columns, indexes, foreign keys, active unique constraints, optimistic concurrency, soft delete visibility, queue claiming, and change-feed behavior.

Postgres foreign keys on workspace-scoped tables, including composite foreign
keys whose child columns include `workspace_id`, must be `DEFERRABLE INITIALLY
IMMEDIATE`. Services may temporarily defer them inside a transaction when moving
an entire workspace graph, such as re-keying the seeded first workspace during
initial setup. Constraints still validate at commit.

Adapters should express conditional requirements with CHECK constraints where possible, including:

- `shared_context_entries`: `value_text` is required when `value_kind = 'string'`; `value_json` is required when `value_kind = 'json'`.
- `execution_targets`: `device_id` is required when `type = 'local'`.
- `artifacts`: at least one of `content_text`, `content_json`, or `external_url` is required.
- `role_assignments`: `resource_type` and `resource_id` are non-null, using empty string sentinels for instance scope.

## Concurrency And Consistency

Services must own state transitions and run them in ACID transactions. Direct table writes by clients or extensions are outside the supported contract.

### Optimistic Concurrency

Every mutable table with `revision` must update through compare-and-set semantics:

```sql
UPDATE table_name
SET ..., revision = revision + 1, updated_at = ?
WHERE id = ? AND revision = ? AND deleted_at IS NULL
```

A zero-row update is a conflict and should surface as a `409` or equivalent domain error. The domain mutation, `revision` bump, related `mission_events`, `entity_changes`, and `outbox_messages` must be committed atomically.

### Tenant And Denormalized Column Invariants

Denormalized ownership columns such as `workspace_id`, `project_id`, `mission_id`, and cached `status_type` are part of the contract, not advisory metadata. Services and adapters must prevent cross-tenant rows.

Preferred enforcement is composite foreign keys such as `(workspace_id, project_id)` referencing `projects(workspace_id, id)`, plus similar constraints for mission/objective relationships. Where a database cannot express a denormalized invariant directly, the adapter conformance suite must test service enforcement.

When `missions.status_id` references `project_statuses`, `missions.status_type` must be copied from the referenced row in the same transaction. If a project status type changes, affected missions must be updated and emitted in `entity_changes`.

### Change-Feed Visibility

`entity_changes.seq` is a durable cursor only after the transaction containing the row has committed and the adapter's visibility rule says it is safe to advance past that sequence.

SQLite's single-writer mode can serve `WHERE seq > cursor ORDER BY seq` directly when writes are serialized. Multi-writer adapters such as Postgres must not expose a raw sequence as the only cursor because sequence allocation order can differ from commit visibility. A Postgres adapter must provide one of:

- a transactional outbox/change-feed writer that serializes visible feed rows,
- a safe high-water mark that only advances past the largest contiguous committed `seq`,
- logical-replication or snapshot-horizon semantics that preserve commit-safe consumption.

Sync clients should advance cursors only to the adapter-provided safe high-water mark. If a requested cursor is older than the retained feed window, the API must return a clear full-resync-required response.

### Idempotency Layering

Use `idempotency_keys` to guard request/response replay for protocol, REST, hooks, and worker calls. Per-table idempotency keys such as `mission_events.idempotency_key` or `execution_requests.idempotency_key` guard domain inserts and queue effects.

If the same idempotency scope/key is reused with a different `request_hash`, the operation must fail with a conflict. It must not replay a cached response for a different request body.

## Soft Delete, Foreign Keys, And Tombstones

- `deleted_at` is the single tombstone for soft-deletable rows. Status columns may include operational values such as `active`, `archived`, `disabled`, or `revoked`, but must not duplicate removal with `deleted` or `removed`.
- A `delete` operation in `entity_changes` means a soft-delete tombstone unless a table-specific purge process explicitly says otherwise.
- Services should cascade soft deletes where the child has no useful standalone meaning. Otherwise they should preserve children and filter by active parents in read models.
- Hard deletes are maintenance purges. A purge that removes retained tombstones must either emit a purge outbox/change notification or declare that older sync clients must full-resync.
- Every FK should declare an on-delete policy in the physical migration. Default to `RESTRICT` for durable history and review rows, `SET NULL` for optional actor/session attribution, and service-managed soft cascade for owned mutable children.
- Attachment bytes are stored outside the database. Soft-deleting an attachment should enqueue an outbox effect such as `attachment.delete_blob` after the tombstone is committed.

## Identity And Tenancy

The local MVP can run as one authenticated local operator in one seeded workspace. The first human identity is created through the Auth Layer, and the schema should still reserve the future multi-user shape.

### `workspaces`

Represents the local instance workspace now and a hosted organization/workspace later.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes | Stable workspace ID. |
| `slug` | text | yes | Unique human/config key. |
| `name` | text | yes | Human-readable name from `overlord.toml` by default. |
| `kind` | text | yes | `local`, `hosted`, or future adapter-defined kind. |
| `settings_json` | Json | yes | Instance defaults, feature flags, and workspace default agent/model/harness catalog for the CLI-first MVP. |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone. |
| `revision` | integer | yes | Increment on mutation. |

Indexes:

- Unique `slug`.

### `profiles`

Represents application-facing profile data for Better Auth users. Every interactive
actor must have a Better Auth `user` row first; the corresponding `profiles` row
uses the same `id` as the Better Auth user and is created automatically by the
auth migration bridge. A profile can exist independently of any one workspace.

The auth migration bridge also keeps `handle` synchronized with the account
username: it copies the Better Auth `user.name` (the account username) into
`profiles.handle` when the user row is inserted, and an `AFTER UPDATE OF name ON
"user"` trigger re-copies it (bumping `updated_at`/`revision`) whenever the
username changes. Because `handle` is bridge-managed it is **not** directly
editable through the application — `PATCH /api/profile` does not accept a
`handle` field. `display_name` is seeded from the username at sign-up but stays
independently editable thereafter.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes | Stable profile ID and FK to Better Auth `"user".id`. |
| `kind` | text | yes | `human`, `service`, or adapter-defined. |
| `display_name` | text | yes |  |
| `handle` | text | no | Globally unique, URL/display-safe username. Mirrors the Better Auth account username via the auth bridge; not directly editable. |
| `email` | text | no | Optional for local MVP. |
| `status` | text | yes | `active`, `disabled`. Removal is represented by `deleted_at`. |
| `metadata_json` | Json | yes | Auth provider metadata, not secrets. |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone. |
| `revision` | integer | yes |  |

Indexes:

- `(status)`.
- Optional unique lowercased `handle` where present.
- Optional unique `(email)` where present.

### `workspace_users`

Represents a profile's membership and effective identity inside a workspace. Workspace-scoped resources such as mission assignments, role assignments, project ownership, and workflow attribution should reference `workspace_users.id`, not the global `profiles.id`.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes | Stable workspace membership ID. |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `profile_id` | Id | yes | FK to `profiles`. |
| `member_key` | text | no | Optional human-readable key such as `<workspace>:<handle>` for URLs and assignee pickers. |
| `status` | text | yes | `active`, `disabled`. Removal is represented by `deleted_at`. |
| `metadata_json` | Json | yes | Workspace membership metadata. |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone. |
| `revision` | integer | yes |  |

Indexes:

- Unique active `(workspace_id, profile_id)`.
- Optional unique active `(workspace_id, member_key)` where present.
- `(workspace_id, status)`.
- `(profile_id, status)`.

### `role_assignments`

Stores durable workspace-user-to-role membership. Role definitions can live in config or a custom provider.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `workspace_user_id` | Id | yes | FK to `workspace_users`. |
| `role_key` | text | yes | Examples: `ADMIN`, `MEMBER`. |
| `resource_type` | text | yes | Scope discriminator. Use empty string for instance/workspace-level roles. |
| `resource_id` | Id | yes | Scope ID. Use empty string for instance/workspace-level roles. |
| `assigned_by_workspace_user_id` | Id | no | FK to `workspace_users`. |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Revocation tombstone. |
| `revision` | integer | yes |  |

Indexes:

- Unique active assignment on `(workspace_id, workspace_user_id, role_key, resource_type, resource_id)`. `resource_type` and `resource_id` are non-null so this protects instance-level roles on both SQLite and Postgres.
- `(workspace_id, role_key)`.

### `user_tokens`

Stores `USER_TOKEN` metadata and hashes only.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes | Token identifier. |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `profile_id` | Id | yes | Profile that owns the token. |
| `workspace_user_id` | Id | yes | Workspace membership whose permissions the token inherits. |
| `label` | text | yes | User supplied. |
| `token_prefix` | text | yes | Non-secret lookup/display prefix. |
| `token_hash` | SecretHash | yes | Hash of raw secret. |
| `hash_algorithm` | text | yes | Example: `argon2id`, `bcrypt`, `hmac-sha256`. |
| `status` | text | yes | `active`, `revoked`, `expired`, `rotated`. |
| `expires_at` | TimestampUTC | no | Optional expiration. |
| `last_used_at` | TimestampUTC | no | Updated after successful auth. |
| `last_used_context_json` | Json | yes | Coarse client metadata only. |
| `revoked_at` | TimestampUTC | no |  |
| `revoked_by_workspace_user_id` | Id | no | FK to `workspace_users`. |
| `predecessor_token_id` | Id | no | FK to `user_tokens` for rotation. |
| `metadata_json` | Json | yes | No raw secret. |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone. |
| `revision` | integer | yes |  |

Indexes:

- Unique `(workspace_id, token_prefix)`.
- `(workspace_id, workspace_user_id, status)`.
- `(profile_id, status)`.
- `(workspace_id, expires_at)`.

Token rotation stores `predecessor_token_id` only. The successor is derived by querying rows whose predecessor points at the current token, which avoids maintaining two linked-list directions in one transaction.

### Better Auth Implementation Tables

Better Auth (the embedded authentication library) manages its own tables in the same configured adapter database. These tables are **owned by the Auth Layer** and must not be read or written by other components directly.

Schema is managed by Better Auth's configured database adapter. Adapter migration `001_better_auth.sql` creates these tables before the core migration so `profiles.id` can reference Better Auth `"user".id`. Column names follow Better Auth's camelCase conventions (different from Overlord's snake_case domain tables).

| Table | Purpose |
| --- | --- |
| `user` | Better Auth user identity (email, name, emailVerified). Linked to Overlord `profiles` by matching primary key (`profiles.id = user.id`). |
| `session` | Active browser/client sessions issued by Better Auth. |
| `account` | OAuth2 / credential accounts linked to a Better Auth user. |
| `verification` | Email verification and magic-link tokens. |
| `apikey` | USER_TOKEN credentials managed by Better Auth's apiKey plugin. `key` column stores the hashed value; the `start` prefix is the non-secret display prefix. |

These tables are created by each adapter's migration `001_better_auth.sql`. They do not carry Overlord's `workspace_id`, `revision`, or `deleted_at` fields — lifecycle is managed entirely by Better Auth.

### `user_token_scopes`

Reserved for future token-level restrictions.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `token_id` | Id | yes | FK to `user_tokens`. |
| `permission` | text | yes | Same canonical permission names as RBAC. |
| `resource_type` | text | no | Optional scope. |
| `resource_id` | Id | no | Optional scope. |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone. |
| `revision` | integer | yes |  |

Absence of scope rows means "no token-level restriction" in v1.

## Project Model

### `projects`

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes | Stable project ID. |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `slug` | text | yes | Unique within workspace. |
| `name` | text | yes |  |
| `description` | text | no |  |
| `status` | text | yes | `active`, `archived`. Deletion is represented by `deleted_at`. |
| `settings_json` | Json | yes | Project behavior settings. Do not store model availability or shared model defaults here. |
| `created_by_workspace_user_id` | Id | no | FK to `workspace_users`. |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone. |
| `revision` | integer | yes |  |

Indexes:

- Unique `(workspace_id, slug)` among active rows (`deleted_at IS NULL`). Soft-deleted projects release their slug for reuse.
- `(workspace_id, status, updated_at)`.

### `project_statuses`

Configurable mission statuses per project, with stable semantic types.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `project_id` | Id | yes | FK to `projects`. |
| `key` | text | yes | Example: `next-up`. |
| `name` | text | yes | Display name. |
| `type` | text | yes | `draft`, `execute`, `review`, `complete`, `blocked`, `cancelled`. |
| `position` | integer | yes | Ordering in board/UI. |
| `is_default` | Bool | yes | One default per project. |
| `is_terminal` | Bool | yes | Complete/cancelled-style statuses. |
| `metadata_json` | Json | yes | UI hints, colors, etc. |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone. |
| `revision` | integer | yes |  |

Indexes:

- Unique `(project_id, key)`.
- Unique one active default status per project.
- Unique one active `execute` type per project, enforced by adapter partial unique index.
- Unique one active `review` type per project, enforced by adapter partial unique index.

### `devices`

Represents a local or remote runner-capable device identity.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `fingerprint` | text | yes | Stable value from `~/.ovld/device.json` for local MVP. |
| `label` | text | yes | Human readable. |
| `platform` | text | no | OS/platform summary. |
| `status` | text | yes | `active`, `disabled`, `missing`. |
| `last_seen_at` | TimestampUTC | no | Runner heartbeat/status. |
| `metadata_json` | Json | yes | No secrets. |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone. |
| `revision` | integer | yes |  |

Indexes:

- Unique `(workspace_id, fingerprint)`.

### `execution_targets`

Represents where an objective can run. The local MVP has one local target per device.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `device_id` | Id | no | FK to `devices`; required for local targets. |
| `owner_workspace_user_id` | Id | no | FK to `workspace_users`. |
| `type` | text | yes | `local`, `ssh`, future adapter-defined. |
| `label` | text | yes |  |
| `status` | text | yes | `active`, `disabled`, `unavailable`. |
| `connection_json` | Json | yes | SSH host metadata later. No raw credentials. |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone. |
| `revision` | integer | yes |  |

Indexes:

- `(workspace_id, type, status)`.
- `(workspace_id, device_id)`.

### `workspace_user_execution_targets`

Represents a workspace user's access to a workspace execution target. Reusable user launch preferences live in `user_execution_target_preferences`, keyed by profile and stable target fingerprint.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `workspace_user_id` | Id | yes | FK to `workspace_users`. |
| `execution_target_id` | Id | yes | FK to `execution_targets`. |
| `default_username` | text | no | SSH/local username hint. |
| `access_status` | text | yes | `active`, `pending`, `disabled`, `error`. |
| `last_connected_at` | TimestampUTC | no |  |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone. |
| `revision` | integer | yes |  |

Indexes:

- Unique active `(workspace_user_id, execution_target_id)`.
- `(workspace_id, execution_target_id, access_status)`.

### `user_execution_target_preferences`

Represents reusable per-profile launch preferences for a stable execution target identity. Local targets use the device fingerprint as `target_fingerprint`, so the same user's laptop keeps one terminal and agent launch profile across multiple workspace memberships.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `profile_id` | Id | yes | FK to `profiles`. |
| `target_type` | text | yes | `local`, `ssh`, future adapter-defined. |
| `target_fingerprint` | text | yes | Stable user-target identity. For local targets, the device fingerprint. |
| `agent_configs_json` | Json | yes | Per-user/per-target agent launch config, keyed by agent identifier. |
| `terminal_profile_json` | Json | yes | Per-user terminal profile for this target fingerprint. |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone. |
| `revision` | integer | yes |  |

Indexes:

- Unique active `(profile_id, target_type, target_fingerprint)`.
- `(profile_id, target_type, updated_at)`.

### `project_resources`

Links projects to directories/resources on execution targets.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `project_id` | Id | yes | FK to `projects`. |
| `execution_target_id` | Id | no | FK to `execution_targets`. Null allowed during import/config repair. |
| `type` | text | yes | `local_directory`, `remote_directory`, future resource types. |
| `label` | text | no |  |
| `path` | Path | yes | Local or remote path. |
| `is_primary` | Bool | yes | Primary resource for project/target. |
| `status` | text | yes | `active`, `missing`, `archived`. |
| `metadata_json` | Json | yes | `.overlord/project.json` details, VCS hints. |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone. |
| `revision` | integer | yes |  |

Indexes:

- `(project_id, execution_target_id, is_primary)`.
- Unique active `(project_id, execution_target_id, path)`.

### `target_resource_observations`

Latest client-reported availability for a linked resource on a specific execution target.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `execution_target_id` | Id | yes | FK to `execution_targets`. |
| `resource_id` | Id | yes | FK to `project_resources`. |
| `state` | text | yes | Open vocabulary: `available`, `missing`, `unreachable`, `permission_denied`, `not_git_repository`, `unknown` (§5 target observation). |
| `git_root` | Path | no | Observed git root when `state = available`. |
| `branch` | text | no | Observed branch when available. |
| `git_commit` | text | no | Observed commit SHA when available. |
| `observed_at` | TimestampUTC | yes | When the target made the observation. |
| `created_at` | TimestampUTC | yes | First writeback row time. |
| `updated_at` | TimestampUTC | yes | Last upsert time. |

Indexes:

- Unique `(execution_target_id, resource_id)`.
- `(resource_id)` for project resource list merges.

### `mission_branch_observations`

Latest client-reported git state for a prepared mission branch on a specific execution target.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `execution_target_id` | Id | yes | FK to `execution_targets`. |
| `mission_id` | Id | yes | FK to `missions`. |
| `status` | text | yes | Closed vocabulary: `created`, `published`, `merged_unpushed`, `merged`. Pending branches are not observed because no branch exists yet. |
| `dirty` | Bool | yes | Whether the target observed uncommitted work in the branch worktree. |
| `worktree_path` | Path | no | Target-reported worktree path when available. |
| `observed_at` | TimestampUTC | yes | When the target made the observation. |
| `created_at` | TimestampUTC | yes | First writeback row time. |
| `updated_at` | TimestampUTC | yes | Last upsert time. |

Indexes:

- Unique `(execution_target_id, mission_id)`.
- `(mission_id)` for mission detail branch DTO merges.

### `project_user_preferences`

Stores user-specific project preferences without overloading project resource directory rows.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `project_id` | Id | yes | FK to `projects`. |
| `workspace_user_id` | Id | yes | FK to `workspace_users`. |
| `preferences_json` | Json | yes | UI preferences, recently used options, and local hints. |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone. |
| `revision` | integer | yes |  |

Indexes:

- Unique active `(project_id, workspace_user_id)`.

### `project_tag_definitions`

Project-scoped mission tag definitions.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `project_id` | Id | yes | FK to `projects`. |
| `key` | text | yes | Stable lowercase key. |
| `label` | text | yes | Human display label. |
| `description` | text | no |  |
| `color` | text | no | Optional hex color. |
| `is_active` | Bool | yes |  |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone. |
| `revision` | integer | yes |  |

Indexes:

- Unique active `(project_id, key)`.
- Unique active `(project_id, lower(label))` where supported.

### `mission_tag_assignments`

Assigns project tags to missions.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `mission_id` | Id | yes | FK to `missions`. |
| `tag_definition_id` | Id | yes | FK to `project_tag_definitions`. |
| `source` | text | yes | `user`, `engine`, or adapter-defined. |
| `applied_by_workspace_user_id` | Id | no | FK to `workspace_users`. |
| `applied_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone or user-suppressed engine tag. |
| `revision` | integer | yes |  |

Indexes:

- Unique active `(mission_id, tag_definition_id, source)`.
- `(tag_definition_id, mission_id)`.

Mission tag services must verify the tag definition belongs to the mission's project.

## Missions, Objectives, And Sessions

### `mission_sequences`

Portable sequence allocator for human mission numbers.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `scope_type` | text | yes | `workspace` for the default `<workspace>:<sequence>` display ID; future `project` is a migration, not a config toggle. |
| `scope_id` | Id | yes | Workspace/project ID. |
| `counter_name` | text | yes | Example: `mission`. |
| `next_value` | integer | yes | Claim inside a transaction. |
| `updated_at` | TimestampUTC | yes |  |

Indexes:

- Unique `(workspace_id, scope_type, scope_id, counter_name)`.

### `missions`

Durable work unit and review record.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes | Stable mission ID. |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `project_id` | Id | yes | FK to `projects`. |
| `display_id` | DisplayId | yes | Example: `1:1204`. |
| `sequence_number` | BigCount | yes | Human sequence. |
| `title` | text | yes |  |
| `status_id` | Id | yes | FK to `project_statuses`. |
| `status_type` | text | yes | Cached semantic type for fast filters. |
| `board_position` | integer | yes | Ordering of the mission within its board column (the `(project_id, status_id)` group). Gap-based; lower sorts first. See Conventions on reorder strategy. |
| `priority` | text | no | Example: `low`, `normal`, `high`, `urgent`. |
| `constraints_text` | text | no | Human-readable constraints. |
| `acceptance_criteria_text` | text | no |  |
| `available_tools_json` | Json | yes | Contracted tool list. |
| `output_format_text` | text | no |  |
| `execution_target_intent_json` | Json | yes | Target preference/intent, not necessarily resolved target. |
| `metadata_json` | Json | yes | Extension data. |
| `active_branch` | text | no | Git branch the mission is currently operating on under worktree automation; null until the first launch prepares one. |
| `branch_override` | text | no | User-pinned branch chosen in the mission panel to override the planner's default; consumed (and cleared) by the runner at the next branch preparation. Null means automatic selection. |
| `worktree_preference` | text | no | Per-mission override of the workspace `worktreeBranchAutomationEnabled` setting. `null` inherits the workspace setting; `'worktree'` forces a branch + worktree for this mission even when automation is off; `'branch'` forces a branch without a dedicated worktree (checked out in the project's primary repo). Persistent (not cleared by the runner). App-validated open set (no DB CHECK). |
| `everhour_task_id` | text | no | Everhour task this mission is linked to for time tracking, written when a user first starts a timer or links the mission from the mission panel. Everhour task IDs are platform-prefixed strings (for example `ev:3000010034`), so this is text. Null until the mission is linked. The workspace Everhour API key lives in `workspaces.settings_json` and the linked Everhour project id/name/section live in `projects.settings_json`. |
| `created_by_workspace_user_id` | Id | no | FK to `workspace_users`. |
| `assigned_workspace_user_id` | Id | no | FK to `workspace_users`. |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone. |
| `revision` | integer | yes |  |

Indexes:

- Unique `(workspace_id, display_id)`.
- Unique `(workspace_id, sequence_number)` while `mission_sequences.scope_type = 'workspace'`.
- `(project_id, status_type, updated_at)`.
- `(project_id, status_id, board_position)` — ordered reads of a board column.
- `(workspace_id, created_by_workspace_user_id, updated_at)`.

The default human ID format is workspace-scoped, for example `1:1204`, and `sequence_number` uniqueness must match that scope. If a future deployment introduces project-scoped display IDs, it must add a new `mission_sequences.scope_type = 'project'` migration and adjust the unique index at the same time.

### `objectives`

One ordered agent pass inside a mission.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes | Stable objective ID. |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `project_id` | Id | yes | FK to `projects`. |
| `mission_id` | Id | yes | FK to `missions`. |
| `position` | integer | yes | Ordered within mission. |
| `title` | text | no |  |
| `instruction_text` | text | no | Agent-facing objective text. May be null or empty while an objective is an inline-authored `draft`/`future` slot (including clearing it back to blank after authoring); submitted and later objectives require non-empty text at the service/API boundary. |
| `state` | text | yes | `future`, `draft`, `submitted`, `launching`, `executing`, `pending_delivery`, `complete`. |
| `assigned_agent` | text | no | Connector/agent identifier. |
| `model` | text | no | Model identifier. |
| `reasoning_effort` | text | no | Agent-specific effort/thinking value. |
| `agent_flags_json` | Json | yes | Launch passthrough flags. |
| `launch_config_json` | Json | no | Per-objective override for target/user launch config; null means inherit at claim time. |
| `auto_advance` | Bool | yes |  |
| `approval_reason` | text | no | Human-facing reason auto-advance stopped for approval. |
| `auto_advanced_at` | TimestampUTC | no | Time this objective was queued by auto-advance. |
| `completed_at` | TimestampUTC | no | Set when state enters `complete`; cleared if reopened. |
| `execution_metadata_json` | Json | yes | Runtime details, no secrets. |
| `branch` | text | no | Git branch this objective actually ran on, recorded by the runner at branch-prepared time; null until the objective is launched with a prepared branch. |
| `created_by_workspace_user_id` | Id | no | FK to `workspace_users`. |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone. |
| `revision` | integer | yes |  |

Indexes:

- Unique active `(mission_id, position)`.
- `(project_id, state, updated_at)`.
- `(mission_id, state, position)`.

Services should set `completed_at` when an objective enters `complete`. A null `launch_config_json` means the runner should inherit execution-target or user-target launch defaults; a non-null object means the objective intentionally overrides those defaults, even when the override contains empty flags or no pre-command.

### `project_tags`

Per-project tag definition. Tags are authored in project settings and assigned to missions via `mission_tags`.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes | Stable tag ID. |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `project_id` | Id | yes | FK to `projects`. |
| `label` | text | yes | Human-readable tag label; unique per project among non-deleted rows. |
| `color` | text | no | Optional display color (e.g. hex). |
| `active` | Bool | yes | Inactive tags are hidden from the mission-create picker but kept for history. |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone. |
| `revision` | integer | yes |  |

Indexes:

- Unique active `(project_id, label)`.
- Unique `(project_id, id)` — composite FK target for `mission_tags`-style joins.
- `(project_id, active)`.

### `mission_tags`

Assignment of a `project_tags` definition to a mission. The composite primary key makes an assignment idempotent.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `mission_id` | Id | yes | FK to `missions`; `ON DELETE CASCADE`. |
| `tag_id` | Id | yes | FK to `project_tags`; `ON DELETE CASCADE`. |
| `created_at` | TimestampUTC | yes |  |

Indexes:

- Primary key `(mission_id, tag_id)`.
- `(tag_id)` — reverse lookup of missions carrying a tag.

A mission and its tags must belong to the same project; the service layer validates `tag_id` against the mission's `project_id` before inserting.

### `my_mission_positions`

Personal, per-status-column drag ordering for the **My Missions** selected-workspace view. A row records where one operator (`workspace_user`) has manually placed one mission within one status column on their My Missions board. Distinct from `missions.board_position`, which is the shared per-project board order: My Missions ordering must never reorder another user's view or the source project boards.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes | Stable row ID. |
| `workspace_id` | Id | yes | FK to `workspaces`; `ON DELETE CASCADE`. |
| `workspace_user_id` | Id | yes | FK to `workspace_users`; the operator this ordering belongs to. `ON DELETE CASCADE`. |
| `mission_id` | Id | yes | FK to `missions`; `ON DELETE CASCADE`. |
| `status_id` | Id | yes | The status column the position applies to. A position only applies at read time when it matches the mission's current `status_id`, so a status change made elsewhere self-corrects. |
| `position` | Float | yes | Numeric order within the column; lower sorts first. Gap-based so inserts need not renumber the whole column. |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `revision` | integer | yes |  |

Indexes / constraints:

- `UNIQUE (workspace_id, workspace_user_id, mission_id)` — one position per operator per mission.
- Composite FK `(workspace_id, mission_id) → missions (workspace_id, id)` `ON DELETE CASCADE` — keeps the row in the mission's own workspace.
- Composite FK `(workspace_id, status_id) → workspace_statuses (workspace_id, id)` `ON DELETE CASCADE` — the column must be a status of the same workspace.
- `(workspace_id, workspace_user_id, status_id, position)` — ordered reads of one operator's column.

Rows are sparse: one exists only for a mission the operator has dragged. Cascades fire only on **hard** delete; because missions and statuses are soft-deleted, the read path filters non-deleted missions and ignores positions whose `status_id` no longer matches the mission's current column. Keyed by `workspace_id`, the table is forward-compatible with a future cross-workspace My Missions board.

### `agent_sessions`

Live or historical attachment between an agent and one objective.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes | Stable session ID. |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `project_id` | Id | yes | FK to `projects`. |
| `mission_id` | Id | yes | FK to `missions`. |
| `objective_id` | Id | yes | FK to `objectives`. |
| `session_key_prefix` | text | yes | Non-secret display/lookup prefix. |
| `session_key_hash` | SecretHash | yes | Hash raw session key. |
| `agent_identifier` | text | yes | `codex`, `claude`, etc. |
| `model_identifier` | text | no |  |
| `connection_method` | text | yes | `cli`, `api`, `connector`, `runner`, etc. |
| `external_session_id` | text | no | Native harness session/resume ID when available. |
| `phase` | text | yes | Protocol phase. |
| `delivery_state` | text | yes | `not_delivered`, `delivered`, `pending_redelivery`. |
| `started_at` | TimestampUTC | yes |  |
| `last_heartbeat_at` | TimestampUTC | no | Heartbeats do not need mission events. |
| `ended_at` | TimestampUTC | no |  |
| `metadata_json` | Json | yes | No secrets. |
| `created_by_workspace_user_id` | Id | no | FK to `workspace_users`. |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone. |
| `revision` | integer | yes |  |

Indexes:

- Unique `(workspace_id, session_key_prefix)`.
- `(objective_id, started_at)`.
- `(mission_id, started_at)`.
- `(external_session_id)` where present.

## Activity, Context, Attachments, And Review Records

### `mission_events`

Append-only mission timeline. Heartbeats should update `agent_sessions.last_heartbeat_at` and should not normally create rows here.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `project_id` | Id | yes | FK to `projects`. |
| `mission_id` | Id | yes | FK to `missions`. |
| `objective_id` | Id | no | FK to `objectives`. |
| `session_id` | Id | no | FK to `agent_sessions`. |
| `type` | text | yes | `update`, `user_follow_up`, `alert`, `discussion_summary`, `decision`, `ask`, `permission_request`, `delivery`, `execution_requested`, `awaiting_approval`, `status_change`. |
| `phase` | text | no | Protocol phase if applicable. |
| `summary` | text | yes | Human-readable timeline entry. |
| `payload_json` | Json | yes | Structured details. |
| `external_url` | text | no | Optional external link. |
| `source` | text | yes | `cli`, `api`, `hook`, `runner`, `web`, etc. |
| `actor_workspace_user_id` | Id | no | FK to `workspace_users`. |
| `actor_token_id` | Id | no | FK to `user_tokens`. |
| `idempotency_key` | text | no | Prevent duplicate hook/API events. |
| `created_at` | TimestampUTC | yes | Event time. |

Indexes:

- `(mission_id, created_at)`.
- `(objective_id, created_at)`.
- Unique `(workspace_id, source, idempotency_key)` where `idempotency_key` is present.

When a protocol write omits `objective_id`, services should resolve it to the active executing objective for the mission, then the most recently completed objective. Postgres adapters may implement the same behavior with triggers, but service behavior is the portable contract.

### `shared_context_entries`

Durable mission memory for stable facts.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `mission_id` | Id | yes | FK to `missions`. |
| `objective_id` | Id | no | FK to `objectives` when a context entry was written for a specific objective. |
| `key` | text | yes | Example: `repo.testing`. |
| `value_kind` | text | yes | `string` or `json`. |
| `value_text` | text | no | Required when `value_kind = string`. |
| `value_json` | Json | no | Required when `value_kind = json`. |
| `created_by_session_id` | Id | no | FK to `agent_sessions`. |
| `created_by_workspace_user_id` | Id | no | FK to `workspace_users`. |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone. |
| `revision` | integer | yes |  |

Indexes:

- Unique active `(mission_id, key)`.
- `(objective_id, updated_at)` where `objective_id` is present.
- `(mission_id, updated_at)`.
- Optional key substring/full-text index by adapter.

### `shared_context_tags`

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `context_entry_id` | Id | yes | FK to `shared_context_entries`. |
| `tag` | text | yes |  |
| `created_at` | TimestampUTC | yes |  |

Indexes:

- Unique `(context_entry_id, tag)`.
- `(workspace_id, tag)`.

### `objective_attachments`

File metadata for explicit objective-scoped uploads/imports.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `mission_id` | Id | yes | FK to `missions`. |
| `objective_id` | Id | yes | FK to `objectives`. |
| `storage_backend` | text | yes | `local_fs`, `s3`, `blob`, etc. |
| `storage_key` | text | yes | Backend key/path. |
| `filename` | text | yes | Original/display filename. |
| `content_type` | text | no |  |
| `size_bytes` | BigCount | no |  |
| `checksum_sha256` | text | no |  |
| `upload_status` | text | yes | `prepared`, `uploaded`, `available`, `failed`, `deleted`. |
| `metadata_json` | Json | yes |  |
| `created_by_workspace_user_id` | Id | no | FK to `workspace_users`. |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone. |
| `revision` | integer | yes |  |

Indexes:

- `(objective_id, created_at)`.
- `(mission_id, created_at)`.

### `storage_buckets`

Workspace-scoped storage backend configuration for durable objects. Buckets describe where bytes live; object tables below store metadata and backend keys only.

SQLite/local deployments may use `local_fs` buckets rooted on the local device. PostgreSQL/shared deployments should use a managed storage provider such as Supabase Storage, S3-compatible storage, or a Railway volume. Credentials must not be stored in this table; use deployment secrets and store only non-secret provider metadata.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `bucket_key` | text | yes | Stable logical bucket key such as `workspace-images`, `user-images`, or `attachments`. |
| `storage_backend` | text | yes | `local_fs`, `supabase`, `s3`, `railway_volume`, or adapter-defined. |
| `base_url` | text | no | Public or signed URL origin when the provider exposes one; no credentials. |
| `local_path` | Path | no | Local filesystem root for `local_fs` / volume-style backends. |
| `settings_json` | Json | yes | Non-secret provider settings such as region, bucket name, or path prefix. |
| `created_by_workspace_user_id` | Id | no | FK to `workspace_users`. |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone. |
| `revision` | integer | yes |  |

Indexes:

- Unique active `(workspace_id, bucket_key)`.
- `(workspace_id, storage_backend)`.

### `workspace_images`

Publicly readable image metadata owned by a workspace. Administrators, or equivalent custom RBAC policy, manage inserts, updates, and deletes.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `storage_bucket_id` | Id | yes | FK to `storage_buckets`. |
| `storage_key` | text | yes | Backend key/path, unique within the bucket for active rows. |
| `filename` | text | yes | Original/display filename. |
| `content_type` | text | yes | Must be an image media type. |
| `size_bytes` | BigCount | no |  |
| `checksum_sha256` | text | no |  |
| `width_px` | integer | no |  |
| `height_px` | integer | no |  |
| `alt_text` | text | no | Human-facing accessibility text. |
| `public_url` | text | no | Cached public URL when the provider exposes one; no credentials. |
| `metadata_json` | Json | yes |  |
| `created_by_workspace_user_id` | Id | no | FK to `workspace_users`. |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone. |
| `revision` | integer | yes |  |

Indexes:

- Unique active `(storage_bucket_id, storage_key)`.
- `(workspace_id, created_at)`.

### `user_images`

Publicly readable image metadata associated with a user. The associated user, or equivalent custom RBAC policy, manages inserts, updates, and deletes.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `profile_id` | Id | yes | FK to `profiles`. |
| `storage_bucket_id` | Id | yes | FK to `storage_buckets`. |
| `storage_key` | text | yes | Backend key/path, unique within the bucket for active rows. |
| `filename` | text | yes | Original/display filename. |
| `content_type` | text | yes | Must be an image media type. |
| `size_bytes` | BigCount | no |  |
| `checksum_sha256` | text | no |  |
| `width_px` | integer | no |  |
| `height_px` | integer | no |  |
| `alt_text` | text | no | Human-facing accessibility text. |
| `public_url` | text | no | Cached public URL when the provider exposes one; no credentials. |
| `metadata_json` | Json | yes |  |
| `created_by_workspace_user_id` | Id | no | FK to `workspace_users`. |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone. |
| `revision` | integer | yes |  |

Indexes:

- Unique active `(storage_bucket_id, storage_key)`.
- `(workspace_id, profile_id, created_at)`.

### `attachments`

Workspace attachment metadata for files that are not limited to a single objective. Workspace members, or equivalent custom RBAC policy, may create, read, update, and delete attachments.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `project_id` | Id | no | FK to `projects` for project-scoped attachments. |
| `mission_id` | Id | no | FK to `missions` for mission-scoped attachments. |
| `objective_id` | Id | no | FK to `objectives` for objective-scoped attachments. |
| `storage_bucket_id` | Id | yes | FK to `storage_buckets`. |
| `storage_key` | text | yes | Backend key/path, unique within the bucket for active rows. |
| `filename` | text | yes | Original/display filename. |
| `content_type` | text | no |  |
| `size_bytes` | BigCount | no |  |
| `checksum_sha256` | text | no |  |
| `upload_status` | text | yes | `prepared`, `uploaded`, `available`, `failed`, `deleted`. |
| `metadata_json` | Json | yes |  |
| `created_by_workspace_user_id` | Id | no | FK to `workspace_users`. |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone. |
| `revision` | integer | yes |  |

Indexes:

- Unique active `(storage_bucket_id, storage_key)`.
- `(workspace_id, created_at)`.
- `(project_id, created_at)` where `project_id` is present.
- `(mission_id, created_at)` where `mission_id` is present.
- `(objective_id, created_at)` where `objective_id` is present.

Storage object deletes are soft deletes. Services should enqueue provider cleanup through `outbox_messages` after the metadata tombstone commits.

### `deliveries`

Final or follow-up delivery review boundary.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `project_id` | Id | yes | FK to `projects`. |
| `mission_id` | Id | yes | FK to `missions`. |
| `objective_id` | Id | yes | FK to `objectives`. |
| `session_id` | Id | no | FK to `agent_sessions`; null for `record-work` deliveries created without an attached session. |
| `summary` | text | yes | Narrative delivery summary. |
| `verification_summary` | text | no | Tests/checks run. |
| `follow_up_notes` | text | no | Known remaining work. |
| `payload_json` | Json | yes | Structured delivery payload. |
| `delivered_by_workspace_user_id` | Id | no | FK to `workspace_users`. |
| `delivered_at` | TimestampUTC | yes |  |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone, rarely used. |
| `revision` | integer | yes |  |

Indexes:

- `(mission_id, delivered_at)`.
- `(objective_id, delivered_at)`.
- `(session_id)`.

### `artifacts`

Structured review artifacts, usually attached to a delivery.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `project_id` | Id | yes | FK to `projects`. |
| `mission_id` | Id | yes | FK to `missions`. |
| `objective_id` | Id | no | FK to `objectives`. |
| `session_id` | Id | no | FK to `agent_sessions`. |
| `delivery_id` | Id | no | FK to `deliveries`. |
| `type` | text | yes | `test_results`, `next_steps`, `note`, `url`, `decision`, `migration`. |
| `label` | text | yes |  |
| `content_text` | text | no | Human-readable content. |
| `content_json` | Json | no | Structured content. |
| `external_url` | text | no | For URL artifacts or external systems. |
| `created_by_workspace_user_id` | Id | no | FK to `workspace_users`. |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone. |
| `revision` | integer | yes |  |

Indexes:

- `(mission_id, created_at)`.
- `(delivery_id, type)`.

## Change Tracking

### `changed_files`

Update-time file metadata, upserted by session/objective/path.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `project_id` | Id | yes | FK to `projects`. |
| `mission_id` | Id | yes | FK to `missions`. |
| `objective_id` | Id | yes | FK to `objectives`. |
| `session_id` | Id | no | FK to `agent_sessions`; null for `record-work` changed-file metadata. |
| `resource_id` | Id | no | FK to `project_resources` when known. |
| `file_path` | Path | yes | Normalized repo-relative path. |
| `vcs_status` | text | no | `modified`, `added`, `deleted`, etc. |
| `current_diff_state` | text | yes | `present`, `resolved`, `unknown`, `unavailable`. |
| `first_observed_at` | TimestampUTC | yes |  |
| `last_observed_at` | TimestampUTC | yes |  |
| `last_observed_event_id` | Id | no | FK to `mission_events`. |
| `observed_metadata_json` | Json | yes | No full diff or file contents. |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone. |
| `revision` | integer | yes |  |

Indexes:

- Unique active `(session_id, objective_id, file_path)` where `session_id` is present.
- `(mission_id, objective_id, file_path)`.
- `(project_id, updated_at)`.

When an update-time changed-file record omits `objective_id`, services should apply the same objective auto-association rule as `mission_events`.

Delivery coverage is objective-scoped. Validators must aggregate `changed_files` across every session for the objective, plus any null-session `record-work` records. If multiple sessions observed the same file, `present` wins over `unknown`/`unavailable`, and `resolved` removes the file from final coverage only when the final local workspace state no longer contains a meaningful change.

### `change_rationales`

Structured rationale records for meaningful file changes.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `project_id` | Id | yes | FK to `projects`. |
| `mission_id` | Id | yes | FK to `missions`. |
| `objective_id` | Id | yes | FK to `objectives`. |
| `session_id` | Id | no | FK to `agent_sessions`. |
| `delivery_id` | Id | no | FK to `deliveries`. |
| `changed_file_id` | Id | no | FK to `changed_files`. |
| `file_path` | Path | yes | Normalized repo-relative path. |
| `label` | text | yes | Short reviewer title. |
| `summary` | text | yes | What changed. |
| `why` | text | yes | Why it changed. |
| `impact` | text | yes | Behavioral impact. |
| `hunks_json` | Json | yes | Hunk headers/metadata only. |
| `source_event_id` | Id | no | FK to `mission_events`. |
| `is_final` | Bool | yes | True when associated with a delivery boundary. |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone. |
| `revision` | integer | yes |  |

Indexes:

- `(mission_id, objective_id, file_path)`.
- `(delivery_id, file_path)`.
- Optional unique active final rationale `(delivery_id, file_path)`.

Delivery validation should require final rationales for meaningful `changed_files` still present in the final workspace state, unless explicitly skipped.

## Runner, Jobs, And Protocol Idempotency

### `execution_requests`

Durable queue for manual run and auto-advance.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `project_id` | Id | yes | FK to `projects`. |
| `mission_id` | Id | yes | FK to `missions`. |
| `objective_id` | Id | yes | FK to `objectives`. |
| `execution_target_id` | Id | no | FK to `execution_targets`. |
| `requested_agent` | text | no |  |
| `requested_model` | text | no |  |
| `requested_reasoning_effort` | text | no |  |
| `launch_mode` | text | yes | `run`, `ask`, or adapter-defined. |
| `launch_flags_json` | Json | yes |  |
| `target_kind` | text | yes | `any`, `local`, `ssh`, or adapter-defined. |
| `requested_source` | text | yes | `manual_run`, `auto_advance`, `api`, `cli`, etc. |
| `idempotency_key` | text | no | Required for auto-advance. |
| `status` | text | yes | `queued`, `claimed`, `launching`, `launched`, `failed`, `cleared`, `cancelled`, `expired`. |
| `requested_by_workspace_user_id` | Id | no | FK to `workspace_users`. |
| `claimed_by_device_id` | Id | no | FK to `devices` for local compatibility/diagnostics. |
| `claimed_by_execution_target_id` | Id | no | FK to `execution_targets`. |
| `claimed_at` | TimestampUTC | no |  |
| `claim_expires_at` | TimestampUTC | no | Stale claims can be retried/failed. |
| `launch_started_at` | TimestampUTC | no |  |
| `launch_completed_at` | TimestampUTC | no |  |
| `launched_session_id` | Id | no | FK to `agent_sessions` when known. |
| `resolved_resource_id` | Id | no | FK to `project_resources`. |
| `resolved_working_directory` | Path | no | No repository contents. |
| `last_error` | text | no |  |
| `attempt_count` | integer | yes | Increment on each claim/launch attempt. |
| `metadata_json` | Json | yes |  |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone. |
| `revision` | integer | yes |  |

Indexes:

- `(workspace_id, status, created_at)` for queue polling.
- `(project_id, status, created_at)`.
- `(objective_id, status)`.
- Unique `(workspace_id, idempotency_key)` where present.

Claiming must happen in one transaction:

1. Select the oldest compatible active request.
2. Verify the objective is launchable.
3. Update status to `claimed`, set `claimed_by_execution_target_id`, optional `claimed_by_device_id`, `claimed_at`, and `claim_expires_at`.
4. Append `mission_events` and `entity_changes`.

### `idempotency_keys`

Protects REST, protocol, hook, and worker requests from duplicate effects.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `scope` | text | yes | Example: `protocol.update`, `api.mission.create`. |
| `key` | text | yes | Caller-supplied key. |
| `request_hash` | text | yes | Hash of normalized request. |
| `response_json` | Json | no | Optional cached response. |
| `status` | text | yes | `in_progress`, `completed`, `failed`. |
| `actor_workspace_user_id` | Id | no | FK to `workspace_users`. |
| `expires_at` | TimestampUTC | yes | Cleanup boundary. |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |

Indexes:

- Unique `(workspace_id, scope, key)`.
- `(expires_at)`.

### `worker_jobs`

General background job queue for non-agent side effects. Agent execution should use `execution_requests`.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `type` | text | yes | Job kind. |
| `status` | text | yes | `queued`, `running`, `succeeded`, `failed`, `cancelled`. |
| `priority` | integer | yes | Lower number means higher priority. |
| `run_after` | TimestampUTC | yes | Scheduling. |
| `attempt_count` | integer | yes |  |
| `max_attempts` | integer | yes |  |
| `locked_by` | text | no | Worker identity. |
| `locked_until` | TimestampUTC | no | Stale lock expiry. |
| `payload_json` | Json | yes |  |
| `last_error` | text | no |  |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone. |
| `revision` | integer | yes |  |

Indexes:

- `(workspace_id, status, run_after, priority)`.
- `(locked_until)`.

## Connector And Hook Records

### `user_harness_extensions`

Stores user-authored custom harness extension definitions. These are personal draft/private
definitions and are not automatically available to every workspace member.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `owner_profile_id` | Id | yes | FK to `profiles`. |
| `extension_key` | text | yes | Stable user-owned key, for example `my-local-review-agent`. |
| `version` | text | yes | User-managed extension version. |
| `visibility` | text | yes | `private`, `workspace_candidate`, or future adapter-defined value. |
| `display_name` | text | yes | Human label. |
| `description` | text | no |  |
| `bundle_uri` | text | no | Local path or hosted blob URI for extension files. No credentials. |
| `manifest_json` | Json | yes | Entrypoint, file checksums, managed files, and package metadata. |
| `connector_config_json` | Json | yes | Command templates, capabilities, hook support, and model flag mapping. No secrets. |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone. |
| `revision` | integer | yes |  |

Indexes:

- Unique active `(owner_profile_id, extension_key, version)`.
- `(owner_profile_id, extension_key, updated_at)`.

Personal extension records are the source for authoring and iteration. Promoting one into a
workspace should snapshot a specific version into `workspace_harness_extensions`; workspace behavior
must not depend on mutable personal draft state.

### `workspace_harness_extensions`

Stores custom harness extensions installed into a workspace catalog.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `source_user_harness_extension_id` | Id | no | FK to `user_harness_extensions`; null for imported bundles. |
| `installed_by_workspace_user_id` | Id | no | FK to `workspace_users`. |
| `extension_key` | text | yes | Workspace catalog key. |
| `version` | text | yes | Installed extension version. |
| `status` | text | yes | `enabled`, `disabled`, `stale`, `error`. |
| `display_name` | text | yes | Human label. |
| `bundle_uri` | text | no | Local path or hosted blob URI for installed bundle. No credentials. |
| `manifest_json` | Json | yes | Snapshot of the installed version's manifest and checksums. |
| `connector_config_json` | Json | yes | Snapshot of command templates and connector capabilities. No secrets. |
| `policy_json` | Json | yes | Availability defaults and optional workspace-user restrictions. |
| `installed_at` | TimestampUTC | yes |  |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone. |
| `revision` | integer | yes |  |

Indexes:

- Unique active `(workspace_id, extension_key)`.
- `(workspace_id, status)`.
- `(source_user_harness_extension_id)` where present.

Workspace extension rows are catalog entries. They answer "what custom harnesses are available to
this workspace?" and should be resolved alongside built-in packaged harnesses when constructing the
agent/model selector.

### `connector_installations`

Tracks setup/doctor state for agent connectors.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `agent_identifier` | text | yes | `codex`, `claude`, `cursor`, etc. |
| `installed_version` | text | no | Managed connector version. |
| `status` | text | yes | `installed`, `missing`, `stale`, `error`. |
| `install_path` | Path | no |  |
| `capabilities_json` | Json | yes | Follow-up hook, permission hook, native resume, etc. |
| `manifest_json` | Json | yes | Managed files summary. |
| `last_checked_at` | TimestampUTC | no | Doctor/setup check time. |
| `last_error` | text | no |  |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone. |
| `revision` | integer | yes |  |

Indexes:

- Unique `(workspace_id, agent_identifier)`.

### `hook_events`

Raw-ish but sanitized connector lifecycle events. Important hook events should also create `mission_events`.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `project_id` | Id | no | FK to `projects`. |
| `mission_id` | Id | no | FK to `missions`. |
| `objective_id` | Id | no | FK to `objectives`. |
| `session_id` | Id | no | FK to `agent_sessions`. |
| `agent_identifier` | text | no |  |
| `hook_type` | text | yes | `UserPromptSubmit`, `PermissionRequest`, `Stop`, etc. |
| `native_session_id` | text | no |  |
| `payload_json` | Json | yes | Sanitized payload. |
| `handled_at` | TimestampUTC | no |  |
| `created_at` | TimestampUTC | yes |  |

Indexes:

- `(mission_id, created_at)`.
- `(session_id, created_at)`.
- `(workspace_id, hook_type, created_at)`.

### `permission_requests`

Structured record for permission prompts, linked to events.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `mission_id` | Id | yes | FK to `missions`. |
| `objective_id` | Id | no | FK to `objectives`. |
| `session_id` | Id | no | FK to `agent_sessions`. |
| `event_id` | Id | no | FK to `mission_events`. |
| `tool_name` | text | no |  |
| `request_summary` | text | yes | Secret-redacted. |
| `payload_json` | Json | yes | Secret-redacted. |
| `status` | text | yes | `requested`, `approved`, `denied`, `expired`, `not_required`. |
| `resolved_by_workspace_user_id` | Id | no | FK to `workspace_users`. |
| `resolved_at` | TimestampUTC | no |  |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone. |
| `revision` | integer | yes |  |

Indexes:

- `(mission_id, created_at)`.
- `(status, created_at)`.

## Realtime, REST, And Sync

### `entity_changes`

Canonical change feed for web realtime, REST polling, workers, and optional local client database sync.

Every service-layer mutation should append one or more `entity_changes` rows in the same transaction as the domain change. This table is the portable source of "what changed after cursor X".

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `seq` | ChangeSeq | yes | Monotonic per database. Primary cursor. |
| `id` | Id | yes | Stable change ID for export/import. |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `project_id` | Id | no | Denormalized filter. |
| `mission_id` | Id | no | Denormalized filter. |
| `objective_id` | Id | no | Denormalized filter. |
| `entity_type` | text | yes | Domain type, not necessarily physical table. |
| `entity_id` | Id | yes | Changed entity ID. |
| `operation` | text | yes | `insert`, `update`, `delete`, `restore`. |
| `entity_revision` | integer | no | New revision where applicable. |
| `changed_fields_json` | Json | yes | Field names or compact summary. No secrets. |
| `actor_workspace_user_id` | Id | no | FK to `workspace_users`. |
| `actor_token_id` | Id | no | FK to `user_tokens`. |
| `source` | text | yes | `cli`, `api`, `runner`, `worker`, `hook`, `migration`. |
| `occurred_at` | TimestampUTC | yes |  |

Indexes:

- Primary/unique `seq`.
- Unique `id`.
- `(workspace_id, seq)`.
- `(project_id, seq)`.
- `(mission_id, seq)`.
- `(entity_type, entity_id, seq)`.

Usage:

- REST list/detail endpoints return records plus current revisions.
- REST sync endpoint can return visible committed changes after the client cursor, ordered by `seq`, up to the adapter's safe high-water mark.
- Web UI can receive changes over SSE/WebSocket backed by this table.
- SQLite adapter can poll by `seq`.
- Postgres adapter can additionally `NOTIFY` listeners after commit, but notifications are only wakeups; consumers still read through the commit-safe change-feed contract.
- Local client DB sync can store the last applied `seq` and request deltas.

The change feed should not contain raw token hashes, session key hashes, file contents, raw diffs, or attachment bytes.

Retention:

- Keep a `minimum_retained_seq` value available through the sync endpoint or database metadata.
- A client asking for `after < minimum_retained_seq` must receive a full-resync-required response.
- Pruning append-only tables such as `entity_changes`, `mission_events`, `hook_events`, and `audit_log` should be explicit maintenance, not silent normal writes.

### `sync_clients`

Optional registry for persistent local client databases or long-lived realtime consumers.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `workspace_user_id` | Id | no | FK to `workspace_users`. |
| `label` | text | yes |  |
| `client_kind` | text | yes | `web`, `desktop`, `mobile`, `local_db`, `worker`. |
| `last_seen_at` | TimestampUTC | no |  |
| `metadata_json` | Json | yes | No secrets. |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |
| `deleted_at` | TimestampUTC | no | Tombstone. |
| `revision` | integer | yes |  |

### `sync_cursors`

Tracks delivered/applied cursors per client and stream.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `sync_client_id` | Id | yes | FK to `sync_clients`. |
| `stream_key` | text | yes | `workspace`, `project:<id>`, `mission:<id>`, etc. |
| `last_seq` | ChangeSeq | yes | Last delivered/applied `entity_changes.seq`. |
| `updated_at` | TimestampUTC | yes |  |

Indexes:

- Unique `(sync_client_id, stream_key)`.

### `outbox_messages`

Durable side-effect queue for notifications, webhooks, index updates, or future hosted integrations. This is separate from `entity_changes`; the change feed is for state sync, while outbox messages are for effects.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `topic` | text | yes |  |
| `payload_json` | Json | yes | Secret-redacted. |
| `status` | text | yes | `pending`, `processing`, `sent`, `failed`, `cancelled`. |
| `available_at` | TimestampUTC | yes |  |
| `attempt_count` | integer | yes |  |
| `last_error` | text | no |  |
| `created_at` | TimestampUTC | yes |  |
| `updated_at` | TimestampUTC | yes |  |

Indexes:

- `(workspace_id, status, available_at)`.
- `(topic, created_at)`.

## Search

### `search_documents`

Portable search indexing table. Adapters can replace or augment this with SQLite FTS5 or Postgres `tsvector`. Every searchable document maps back to a mission via `mission_id`, so mission search always returns missions while ranking aggregates content across all source entity types.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `project_id` | Id | no | FK to `projects`. |
| `mission_id` | Id | yes | Owning mission. For `entity_type = 'mission'` this equals `entity_id`; for objectives and events it is the parent mission so all documents aggregate per mission. |
| `entity_type` | text | yes | `mission`, `objective`, `event`, etc. |
| `entity_id` | Id | yes |  |
| `title` | text | no |  |
| `body_text` | text | yes | Redacted searchable text. |
| `content_hash` | text | no | Hash of indexed title/body/source metadata for incremental reindex. |
| `source_revision` | integer | no | Source entity revision indexed. |
| `metadata_json` | Json | yes | Filter fields. |
| `indexed_at` | TimestampUTC | yes |  |

Indexes:

- Unique `(workspace_id, entity_type, entity_id)`.
- `(workspace_id, project_id, entity_type)`.
- `(mission_id)` for per-mission aggregation and cascade cleanup.
- Adapter full-text index on `title` and `body_text`.

Mission search should support:

- Exact lookup by `display_id`.
- Ranked text search over title, display ID, objective text, and mission-event summaries.
- Filters for workspace, project, status list, creator, and updated date range.
- A bounded result limit suitable for protocol `search-missions`.

Ranking aggregates per-document relevance into one score per mission. The reference implementation weights the title column above the body and weights source kinds by importance (mission title > objective > event), so a query that hits a mission's title outranks one that only appears in an event.

The index is maintained by adapter triggers, not application writes: insert/update/delete on `missions`, `objectives`, and `mission_events` keep `search_documents` (and the adapter full-text index) in sync, and a soft delete of a mission removes every document for that mission so deleted missions never surface. `content_hash` and `source_revision` allow incremental reindexing instead of blind rebuilds.

- **SQLite** implements the full-text index as an external-content FTS5 virtual table (`search_documents_fts`) over `search_documents`, with `mission_id`/`entity_type` carried as `UNINDEXED` columns so a single `bm25()`-ranked query can return and weight missions without a join back to the base table.
- **Postgres** implements it as a generated `tsvector` column with a GIN index and `plpgsql` sync triggers; trigram indexes and a stable search RPC may be added as adapter details.

## Audit And Migrations

### `audit_log`

Security and administration audit log. Mission workflow history remains in `mission_events`.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | Id | yes |  |
| `workspace_id` | Id | yes | FK to `workspaces`. |
| `actor_workspace_user_id` | Id | no | FK to `workspace_users`. |
| `actor_token_id` | Id | no | FK to `user_tokens`. |
| `action` | text | yes | Permission/action name. |
| `resource_type` | text | no |  |
| `resource_id` | Id | no |  |
| `result` | text | yes | `allowed`, `denied`, `failed`. |
| `reason` | text | no | Machine-readable denial/failure reason. |
| `metadata_json` | Json | yes | Secret-redacted. |
| `created_at` | TimestampUTC | yes |  |

Indexes:

- `(workspace_id, created_at)`.
- `(actor_workspace_user_id, created_at)`.
- `(resource_type, resource_id, created_at)`.
- `(workspace_id, action, created_at)`.
- `(workspace_id, result, created_at)`.

### `schema_migrations`

Adapter migration history.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `version` | text | yes | Migration ID. |
| `adapter` | text | yes | `sqlite`, `postgres`, etc. |
| `component` | text | yes | `core` or `ext:<extension-name>`. |
| `contract_version` | text | yes | Schema contract version implemented. |
| `checksum` | text | yes | Migration checksum. |
| `applied_at` | TimestampUTC | yes |  |

Indexes:

- Primary key `(adapter, component, version)`.

Migration rules:

- Core migration versions should be zero-padded or timestamped strings with a total lexical order.
- Extension migrations use `component = 'ext:<extension-name>'` and must not write to core tables except through documented extension points.
- Extension-owned tables must use a reserved prefix such as `ext_<extension_name>_`.
- Migrations are forward-only by default. Recovery should use backup/restore or a new corrective migration.

## Controlled Vocabularies

The schema stores controlled vocabularies as text for portability, but allowed values and transitions are part of this contract. Extensions may add values only where marked open.

Closed values:

- `project_statuses.type`: `draft`, `execute`, `review`, `complete`, `blocked`, `cancelled`.
- Default status mapping: `draft -> draft`, `next-up -> draft`, `execute -> execute`, `review -> review`, `complete -> complete`, `blocked -> blocked`, `cancelled -> cancelled`.
- `objectives.state`: `future`, `draft`, `submitted`, `launching`, `executing`, `pending_delivery`, `complete`.
- `execution_requests.status`: `queued`, `claimed`, `launching`, `launched`, `failed`, `cleared`, `cancelled`, `expired`.
- `agent_sessions.delivery_state`: `not_delivered`, `delivered`, `pending_redelivery`.
- `mission_events.type`: `update`, `user_follow_up`, `alert`, `discussion_summary`, `decision`, `ask`, `permission_request`, `delivery`, `execution_requested`, `awaiting_approval`, `status_change`.
- `permission_requests.status`: `requested`, `approved`, `denied`, `expired`, `not_required`.
- `idempotency_keys.status`: `in_progress`, `completed`, `failed`.
- `audit_log.result`: `allowed`, `denied`, `failed`.

Open extension values:

- `workspaces.kind`, `profiles.kind`, `execution_targets.type`, `project_resources.type`, `storage_buckets.storage_backend`, `artifacts.type`, `mission_events.source`, `entity_changes.entity_type`, `entity_changes.source`, `outbox_messages.topic`, `worker_jobs.type`, RBAC permission names, and connector identifiers.
- Extension values must be namespaced unless they are accepted into core documentation.

State transition rules:

- Objectives normally move `future -> draft -> submitted -> launching -> executing -> complete`.
- `pending_delivery` is allowed only after a delivered objective starts explicit follow-up execution.
- `complete` objectives can be reopened only through an explicit follow-up or administrative transition that records a `mission_events` decision/status change.
- Execution requests move `queued -> claimed -> launching -> launched`; failures can move to `failed`, user cleanup to `cleared`, cancellation to `cancelled`, and stale unlaunchable requests to `expired`.

## Contracted JSON Columns

JSON columns are either extension space or contracted structures:

- `available_tools_json`: array of tool descriptors with stable `name`, optional `description`, and optional `source`.
- `execution_target_intent_json`: object with optional `targetKind`, `targetId`, `deviceFingerprint`, `resourceId`, and `workingDirectory`.
- `agent_flags_json`: legacy/objective/request object keyed by agent identifier; values contain launch flags, optional pre-command, and connector-specific settings.
- `agent_configs_json`: user execution-target preference object keyed by agent identifier; values contain launch flags, optional pre-command, and connector-specific settings.
- `launch_config_json`: object with resolved per-objective overrides for agent flags, model, reasoning effort, execution target, and terminal profile.
- `connection_json`: target-specific connection metadata; must not contain raw credentials.
- `terminal_profile_json`: terminal application/profile/command template metadata for local launches; reusable user defaults live in `user_execution_target_preferences`.
- `capabilities_json`: object of connector or target capability booleans and version hints.
- `manifest_json`: connector-managed file manifest and checksums.
- `connector_config_json`: custom harness command templates, launch argument mapping, hook support, and connector capabilities. Must not contain secrets.
- `policy_json`: workspace extension availability policy, such as default availability and optional workspace-user restrictions.
- `hunks_json`: rationale hunk headers/metadata only, as defined in the review plan.
- `metadata_json` and `settings_json`: namespaced extension/core metadata unless a table note defines a stricter structure.

Adapters may validate contracted JSON with CHECK constraints or generated schema tests. Services must validate it before persistence.

## Default Seed

Every fresh local database should seed the same logical minimum:

- One local `workspaces` row from `overlord.toml` defaults.
- One implicit Better Auth `user`, matching human `profiles` row, and active `workspace_users` membership.
- One `ADMIN` role assignment for the implicit user when RBAC tables are present.
- Default project statuses for each project: `draft`, `next-up`, `execute`, `review`, `complete`, `blocked`, `cancelled`, with the `next-up` status mapped to `type = 'draft'`.
- One workspace-scoped `mission_sequences` row for `counter_name = 'mission'`.
- One local `devices` row and one local `execution_targets` row when runner features are initialized.

Seed values should be deterministic enough for tests but should still use stable generated IDs in real installs.

## Extension Points

Overlord should be extensible without making core upgrades fragile.

- Extension-owned database objects use the `ext_<extension_name>_` prefix.
- Extension migrations are tracked by `schema_migrations.component`.
- Extension metadata inside core rows uses namespaced JSON keys.
- Extension event, artifact, outbox, permission, resource, and entity-type names must be namespaced unless promoted to core.
- Extensions should react through service APIs, `entity_changes`, and `outbox_messages`, not direct writes to core tables.
- Custom authentication and authorization providers should integrate through the auth/RBAC service boundaries while preserving core audit and attribution records.

## Adapter Conformance Suite

The project should ship shared tests that every database adapter must pass. Required coverage:

- DDL contains every required table, column, FK, index, CHECK, and partial unique constraint.
- `TimestampUTC` round-trips and orders correctly.
- `revision` compare-and-set rejects stale writes.
- `entity_changes` is appended in the same transaction as mutations and exposes only commit-safe cursors.
- Active uniqueness rules reject duplicate active statuses, role assignments, mission positions, tags, and idempotency keys.
- Queue claiming is atomic under concurrent runner attempts.
- Soft deletes produce tombstones and change-feed rows.
- `record-work` can create a delivery and rationales without an agent session.
- Extension migrations can run without colliding with core migration versions or table names.

## ER Diagram

The implementation docs should include a generated Mermaid ER diagram and an FK dependency order. Until generation exists, maintain at least this dependency shape:

```mermaid
erDiagram
  workspaces ||--o{ workspace_users : has
  profiles ||--o{ workspace_users : joins
  workspaces ||--o{ projects : owns
  projects ||--o{ project_statuses : configures
  projects ||--o{ missions : contains
  missions ||--o{ objectives : contains
  objectives ||--o{ agent_sessions : runs
  missions ||--o{ mission_events : records
  objectives ||--o{ deliveries : completes
  deliveries ||--o{ change_rationales : includes
  missions ||--o{ entity_changes : emits
```

## REST API Boundary

The REST API should be the primary remote access path. It should expose domain resources and protocol commands, not raw tables.

Recommended boundary:

- `/projects`, `/projects/:id/resources`, `/projects/:id/repository`, `/missions`, `/missions/:id/objectives`, `/missions/:id/events`, `/missions/:id/context`, `/missions/:id/deliveries`, `/workspaces/:id/objectives.csv`.
- `/workspace/my-missions` (read: missions assigned to the active actor across the active workspace, with personal `my_mission_positions` ordering) and `/workspace/my-missions/order` (persist a personal column reorder; a cross-column drag is a real mission status change validated by the `(workspace_id, status_id)` composite FK).
- `/protocol/*` endpoints mirroring `ovld protocol`.
- `/execution-requests` for runner queue operations.
- `/uploads/:bucketKey` (core upload service) accepts raw image bytes, persists them to the `storage_buckets` backend, records the matching object table row (e.g. `user_images`), and returns the stored descriptor; `/storage/:bucketKey/:storageKey` serves the bytes for a recorded object.
- `/sync/changes?after=<seq>` for realtime catch-up and local DB sync.
- `/realtime` SSE/WebSocket endpoint backed by `entity_changes`.

REST handlers should:

- Authenticate to a user/token/session identity.
- Authorize by domain permission.
- Run service-layer state transitions in transactions.
- Append `mission_events` and `entity_changes`.
- Use `idempotency_keys` for retried writes.
- Return entity revisions and the latest change `seq` when useful.

## Realtime Strategy

Realtime should be service-layer portable:

1. A write transaction mutates domain tables.
2. The same transaction appends `mission_events` where applicable.
3. The same transaction appends `entity_changes`.
4. After commit, the API server wakes subscribers.
5. Subscribers fetch or receive compact changes and then load resource details through REST.

SQLite implementation:

- Enable WAL mode.
- Use a short polling loop or in-process notification after writes.
- Read `entity_changes.seq` for catch-up.

Postgres implementation:

- Use the same `entity_changes` table.
- Optionally call `NOTIFY` after commit with the latest `seq`.
- Use `FOR UPDATE SKIP LOCKED` where available for worker and runner queues.

## Local Client DB Sync

A future local client database should treat the server/API database as authoritative unless a separate offline editing strategy is designed.

Required support from this schema:

- Stable IDs for all entities.
- Per-entity `revision`.
- Soft-delete tombstones via `deleted_at`.
- Monotonic `entity_changes.seq`.
- Sync client cursors.
- Idempotency keys for client-originated mutations.

Conflict handling can start simple:

- Most client DBs should be read-through caches.
- Writes go through REST and return authoritative revisions.
- If offline write support is later added, mutations need client mutation IDs, base revisions, and explicit conflict responses.

## Security Boundaries

- Raw `USER_TOKEN` secrets are displayed once and never persisted.
- Raw session keys should not be persisted. Store hashes and prefixes.
- Attachment bytes live in storage backends, not inline database rows.
- Repository files and full diffs are not persisted unless explicitly uploaded as attachments.
- Change tracking stores paths, VCS statuses, rationale text, and hunk headers, not full file contents.
- Hook payloads, audit metadata, and outbox payloads must be secret-redacted before persistence.
- Authorization grants use domain capabilities, not table names.

## First Migration Slice

The first implementable migration does not need every table above. A practical MVP slice:

1. Better Auth `user`, `workspaces`, `profiles`, `workspace_users`; the placeholder workspace is seeded, but the first human user/profile/membership is created by the Auth Layer account creation flow.
2. `projects`, `project_statuses`, `devices`, `execution_targets`, `workspace_user_execution_targets`, `user_execution_target_preferences`, `project_resources`, `project_user_preferences`.
3. `mission_sequences`, `missions`, `objectives`, `agent_sessions`.
4. `mission_events`, `shared_context_entries`, `objective_attachments`.
5. `deliveries`, `artifacts`, `changed_files`, `change_rationales`.
6. `execution_requests`, `idempotency_keys`.
7. `entity_changes`, `schema_migrations`.
8. Default seed rows for the local workspace/statuses/mission sequence.

Auth/RBAC expansion can then add:

- `role_assignments`
- `user_tokens`
- `user_token_scopes`
- `audit_log`

Operational expansion can then add:

- `worker_jobs`
- `connector_installations`
- `hook_events`
- `permission_requests`
- `project_tag_definitions`
- `mission_tag_assignments`
- `sync_clients`
- `sync_cursors`
- `outbox_messages`
- `search_documents`

## Open Design Questions

- Human `display_id` should remain workspace-scoped as `1:1204` for MVP. Per-project IDs require an explicit migration.
- Session keys should be treated like tokens from day one: one-time display, hash-only storage, and non-secret prefix lookup.
- `project_statuses` should be stored as rows, seeded from defaults at project creation. ANSWER: keep it by workspace.
- A central machine-readable schema source should emit SQLite/Postgres DDL, REST DTO field names, documentation tables, and adapter conformance tests.
- Hosted deployments should start with database-backed queue claiming. If an external queue is added later, drive it from `outbox_messages` instead of coupling domain tables to a broker.

## Contract Maintenance

To keep this contract up to date:

- Each schema migration should reference the contract section it implements or changes.
- Any service/API change that adds persisted fields should update this document in the same PR.
- Adapter migrations should include contract tests that verify required tables, columns, indexes, and constraints.
- REST response schemas should derive from or be reviewed against the same logical field names.
- The implementation should define the schema once in a typed/declarative source and generate adapter DDL, documentation tables, and conformance fixtures from it.
- Extension authors should treat `metadata_json` fields as namespaced extension space, not a reason to skip first-class columns for core behavior.

## Changelog

- `0.2-draft`: Adds concurrency, soft-delete, extension, migration, vocabulary, default seed, and conformance requirements from the database schema review.
- `0.1-draft`: Initial portable schema contract.
