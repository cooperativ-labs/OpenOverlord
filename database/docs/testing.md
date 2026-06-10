# Database Module — Test Plan

Part of the [master test plan](../../TEST_PLAN.md). Covers the `database` and
`extension` contract components. Normative source:
[`09-database-schema-contract.md`](09-database-schema-contract.md).

The database module is the foundation: every other surface (CLI, protocol, REST,
runner) reaches persistence through its service layer. Its tests therefore carry
the heaviest weight in the suite and run against **both adapters** (SQLite and
Postgres) from a single test body via `withAdapter` (see
[Shared Test Infrastructure](../../TEST_PLAN.md#shared-test-infrastructure)).

## Adapter Parity Model

```
withAdapter(async (db, adapter) => {
  // body runs once with adapter='sqlite' (:memory:),
  // and once with adapter='postgres' (when OVERLORD_TEST_PG_URL set; else SKIP)
});
```

- Migrations are applied fresh per test; default seed rows
  (workspace/user/statuses/ticket sequence) are inserted by the harness.
- A behavior must pass identically on both adapters. A SQLite-only pass is a
  failing test, not an accepted divergence.
- Postgres absence yields an explicit `SKIP` line in output, never a silent green.

## 1. DDL Structural Conformance (Adapter Suite §1)

> Schema contract: "DDL contains every required table, column, FK, index, CHECK,
> and partial unique constraint."

- **Required tables present** — assert each table from the schema contract exists
  in both adapters' migrations (introspect `sqlite_master` / `information_schema`).
- **Columns + logical types** — each table's columns and adapter type mappings
  match the contract's Logical Types section (`Id`, `TimestampUTC`, `Json`, etc.).
- **Foreign keys** — every documented FK exists and points at the right column.
- **Indexes** — required indexes and **partial unique** indexes exist (e.g. one
  active default status per project, one active role assignment, unique active
  ticket position, unique active tags, unique idempotency key).
- **CHECK constraints** — closed-vocabulary columns carry CHECKs whose allowed
  set equals the contract list (shared with the [vocab conformance test](../../TEST_PLAN.md#32-controlled-vocabulary-enforcement)).
- **FK dependency order** — migrations create tables in an order that satisfies the
  ER dependency shape; a fresh migrate-from-zero succeeds on both adapters.

## 2. Timestamps and Ordering (Adapter Suite §2)

> "`TimestampUTC` round-trips and orders correctly."

- Write/read round-trip preserves UTC instant on both adapters.
- Rows ordered by a `TimestampUTC` column sort identically to insertion order
  using the injected fake clock; ties broken deterministically by id/seq.
- No adapter stores local time or drops sub-second precision required by the
  contract.

## 3. Optimistic Concurrency (Adapter Suite §3)

> "`revision` compare-and-set rejects stale writes."

- A write with the current `revision` succeeds and increments `revision`.
- A write with a stale `revision` mutates **zero rows** and surfaces a
  `409`-class domain conflict error (not a raw driver error).
- Two interleaved updates: the second loses and must re-read; no lost update.

## 4. Change Feed (Adapter Suite §4)

> "`entity_changes` is appended in the same transaction as mutations and exposes
> only commit-safe cursors."

- Every service-layer mutation appends exactly one `entity_changes` row in the
  **same transaction** (assert by row count + transaction rollback test: forced
  rollback leaves neither the domain row nor the change row).
- `entity_changes.seq` is monotonic; readers never observe a gap (commit-safe
  visibility). For Postgres, concurrent writers do not expose an uncommitted seq.
- SQLite WAL-mode variant: a reader polling `entity_changes.seq` catches up after
  a writer commits.
- `entity_type` / `source` open-vocab values are core values or namespaced.

## 5. Active-Uniqueness Rules (Adapter Suite §5)

> "Active uniqueness rules reject duplicate active statuses, role assignments,
> ticket positions, tags, and idempotency keys."

- Duplicate active `project_statuses` of the same type rejected; exactly one
  active `execute`, one active `review`, one active default per project.
- Duplicate active `role_assignments` (same workspace_user + role) rejected.
- Duplicate active ticket/objective position rejected.
- Duplicate active tag assignment rejected.
- Duplicate in-progress `idempotency_keys` (same scope+key) rejected; a completed
  key returns the stored result instead of re-applying.
- Soft-deleting a row frees the active-unique slot (a new active row may take it).

## 6. Queue Claiming Atomicity (Adapter Suite §6)

> "Queue claiming is atomic under concurrent runner attempts."

- Two concurrent `claimExecution` attempts on one `queued` request: exactly one
  wins (`claimed`), the other gets nothing — never both. Compare-and-set, single
  transaction.
- The winning claim appends `ticket_events` (execution-claimed) and
  `entity_changes` in the **same** transaction (rollback test confirms atomicity).
- A claim on a non-launchable objective is rejected before any state change.
- Postgres path may use `FOR UPDATE SKIP LOCKED`; SQLite uses a guarded
  compare-and-set — both must produce the single-winner guarantee.

## 7. Soft Delete and Tombstones (Adapter Suite §7)

> "Soft deletes produce tombstones and change-feed rows."

- Soft delete sets `deleted_at`, leaves the row addressable by id, and appends an
  `entity_changes` tombstone row.
- Default queries exclude soft-deleted rows; explicit tombstone queries include
  them.
- FK children behave per contract (block, cascade-soft, or orphan-tombstone as the
  contract specifies per relationship).

## 8. Record-Work Without Session (Adapter Suite §8)

> "`record-work` can create a delivery and rationales without an agent session."

- A delivery + change_rationales can be created with no `agent_sessions` row;
  delivery attribution fields tolerate the null-session case.
- The ticket lands in `review` status and a completed objective is created
  (matches `recordWork` side effects in `protocol-commands.yaml`).

## 9. Extension Migrations (Adapter Suite §9) — `extension` component

> "Extension migrations can run without colliding with core migration versions or
> table names."

- An extension migration using an `ext_<name>_` table applies cleanly alongside
  core migrations; `schema_migrations.component = 'ext:<name>'`.
- A bad extension that tries to create/alter a **core** table or uses a
  non-`ext_` table name is rejected by the conformance check.
- Two extensions with different names don't collide; same-name re-run is idempotent
  via `schema_migrations`.
- Namespaced JSON metadata keys in core `metadata_json`/`settings_json` columns are
  preserved; core code never reads extension-namespaced keys as first-class fields.

## 10. Security Boundaries (schema contract → Security Boundaries)

- Raw `USER_TOKEN` secrets and raw session keys are **never** persisted — only
  hash + non-secret prefix (shared assertion with the [auth test plan](../../auth/docs/testing.md)).
- Hook payloads, audit metadata, and outbox payloads are secret-redacted before
  persistence.
- Change tracking stores paths, VCS statuses, rationale text, and hunk headers —
  not full file contents (assert `changed_files`/`change_rationales` never hold a
  blob).
- Authorization data references domain capabilities, not table names.

## 11. Default Seed and First Migration Slice

- A from-zero migration of the "First Migration Slice" tables succeeds and seeds
  exactly one local workspace, implicit user + membership, default project
  statuses, and a workspace-scoped ticket sequence.
- Ticket `display_id` is workspace-scoped (`1:NNNN`) and monotonically increments
  via `ticket_sequences` under concurrency (no duplicate display IDs).

## Test Layout

```
database/
  test/
    harness.ts            # withAdapter, migrate, seed
    factories.ts          # service-layer row builders
    ddl.test.ts           # §1
    timestamps.test.ts    # §2
    concurrency.test.ts   # §3
    change-feed.test.ts   # §4
    uniqueness.test.ts    # §5
    queue.test.ts         # §6
    soft-delete.test.ts   # §7
    record-work.test.ts   # §8
    extension-migrations.test.ts  # §9
    security.test.ts      # §10
    seed.test.ts          # §11
```

The closed-vocabulary parity test (§1 CHECK constraints vs contract) is shared
with `contract/conformance/vocab` so both the DB suite and the cross-module
conformance suite assert it from the same parsed contract data.
