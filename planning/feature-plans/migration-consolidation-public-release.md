# Migration Consolidation for Public Release (coo:144)

## Goal

Collapse the ~20 later migrations into the base set (`001`–`004`) so a fresh
public-release install runs a small, legible set of migrations that produce **the
exact same schema and seed state** as today's full migration chain — for both the
SQLite and Postgres adapters.

Decisions confirmed with the requester:

1. **Scope:** fold *everything except Everhour* into `001`–`004`. The Everhour
   integration migration (`20260625000000_missions_everhour_task.sql`) stays a
   standalone later migration.
2. **Existing databases:** the consolidated files are the source of truth for
   fresh installs; additionally ship a one-off **reconciliation SQL** that rewrites
   `schema_migrations` in an already-migrated DB (dev / staging / hosted) to the new
   version+checksum set, so it does not hit a checksum-mismatch and does not need a
   rebuild.
3. **Local seed:** seed **no** local-user / local-workspace. This matches the
   current end-state (`remove_seed_local_user` + `organizations.sql` strip them);
   identity is created via Better Auth sign-up.

## How the migration runner works (both adapters)

- `database/src/connection.ts` (SQLite) and `database/src/migrate-postgres.ts`
  (Postgres) each: list files matching `^\d+_[a-z0-9_]+\.sql$`, sort by filename,
  run in order, and record `version` (the numeric filename prefix) + a sha256
  `checksum` of the file's SQL into `schema_migrations`.
- On a **fresh** DB the runner records whatever checksums the files currently have,
  so consolidated files are internally self-consistent — there is nothing to "fix"
  for new installs.
- On an **existing** DB an already-recorded version whose file checksum changed
  raises `Migration <v> checksum mismatch`. This is the only reason step 2
  (reconciliation) exists.
- The two adapters keep **independent** `schema_migrations` rows (`adapter` column),
  and already have divergent version sets today (Postgres has two deferrable-FK
  migrations SQLite lacks). Consolidation is allowed to change each adapter's set
  independently.

## Per-migration disposition

Target base file each later migration folds into. "Additive" = append its
`CREATE`/`ALTER` statements into the base migration (usually into the relevant
table definition). "Seed edit" = do **not** append; instead edit the base file's
seed so the net result matches. "Rebuild→final shape" = drop the 12-step table
rebuild and instead define the base table in its final shape.

| Later migration | Target | Kind |
|---|---|---|
| `20260618010000_remove_seed_local_user` | 001 (+002/003) | Seed edit — stop seeding local-user; drop dependent seeds |
| `20260613120000_mission_search` | 002 | Additive (search_documents + FTS5 + triggers) |
| `20260617000000_project_tags` | 002 | Additive (project_tags, mission_tags) |
| `20260622000000_missions_active_branch` | 002 | Additive (missions.active_branch) |
| `20260623000000_objective_branch_and_override` | 002 | Additive (objectives.branch, missions.branch_override) |
| `20260623120000_missions_worktree_preference` | 002 | Additive (missions.worktree_preference) |
| `20260628120000_target_resource_observations` | 002 | Additive (table + index) |
| `20260628181800_mission_branch_observations` | 002 | Additive (table + index) |
| `20260701090000_sync_profile_email_from_auth` | 002 | Additive (trigger on `user`→profiles) |
| `20260701120000_workspace_invitations` | 002 | Additive (table + index) |
| `20260702103000_user_tokens_profile_scope` | 002 | Additive (3 indexes) |
| `20260703090000_mission_scheduling` | 002 | Additive (schedules table + missions.schedule_id/due_datetime) |
| `20260703120000_webhooks` | 002 | Additive (outbox_messages, webhook_subscriptions, webhook_delivery_attempts) |
| `20260703130000_project_position` | 002 | Additive column; drop the backfill (no rows on fresh install) |
| `20260704120000_organizations` | 002 (+004) | Rebuild→final shape (workspaces, storage_buckets, user_tokens) + new `organizations` table + seed strip |
| `20260702111500_workspace_files_storage_layout` | 004 | Seed edit — final storage_buckets layout + image/attachment path shape |
| `20260702090000_workspace_logo_storage` | 004 | Seed edit — workspace-images bucket path |
| `20260627000000_deferrable_workspace_fks` (PG only) | 002 (Postgres) | Declare affected FKs `DEFERRABLE` from the start |
| `20260705120000_deferrable_mission_project_fks` (PG only) | 002 (Postgres) | Declare affected FKs `DEFERRABLE` from the start |
| `20260625000000_missions_everhour_task` | — | **Stays separate** (per decision) |

### Notes / gotchas

- **Seed removal must cascade.** `001` inserts `local-user`; `002` inserts
  `local-workspace`, the `local-user` profile, `local-workspace-user`,
  `mission_sequences`, and 7 `workspace_statuses`; `003` inserts the
  `local-admin-role` role_assignment. `remove_seed_local_user` +
  `organizations.sql`'s seed-strip remove all of it in the current chain. Folded
  result: **delete every one of those seed `INSERT`s** from 001/002/003 rather than
  seed-then-delete. Net fresh-install state = empty identity/workspace tables.
- **`organizations.sql` is the hard one.** It rebuilds `workspaces`,
  `storage_buckets`, and `user_tokens` (12-step) and adds the `organizations`
  table. Fold by writing those three tables in their post-rebuild final shape
  directly in 002/004 and adding `organizations` (and its FK from `workspaces`) in
  002 — the rebuild statements then disappear entirely.
- **Storage final state.** `004` seed + `workspace_logo_storage` +
  `workspace_files_storage_layout` + `organizations.sql`'s `storage_buckets` rebuild
  and delete all interact. The final seeded `storage_buckets`/path shape will be
  taken from the empirical reference dump (below), not reasoned by hand.
- **Postgres deferrable FKs** have no SQLite analogue; SQLite base files are
  unchanged for those two. Only the Postgres 002 gains `DEFERRABLE` on the relevant
  constraints.
- **Everhour stays separate**, so its file/checksum is unchanged and existing DBs
  keep its `schema_migrations` row untouched. On fresh installs it runs after 004
  and only needs `missions` (in 002).

## Verification strategy (the safety net)

Because several folds involve rebuilds and seed strips, correctness is proven
empirically, not by inspection:

1. **Capture reference (before any edits):**
   - SQLite: run the full current chain on a throwaway file DB via the
     better-sqlite3 redirect; dump `sqlite_schema` (normalized) + every table's
     rows into `/<scratch>/migration-ref/sqlite-before.sql`.
   - Postgres: run the full current chain on an embedded PGlite instance; dump
     schema (`pg_dump`-style via information_schema/pg_catalog introspection) +
     seed rows into `sqlite-.../postgres-before.sql`.
   - Also copy the current `database/{sqlite,postgres}/migrations/` into the ref
     folder verbatim.
2. **Apply the consolidation** to `database/sqlite/migrations` and
   `database/postgres/migrations`.
3. **Rebuild + diff:** run the new (consolidated) chain on fresh DBs, dump again,
   and assert **zero diff** in schema and seed rows against the "before" dumps for
   each adapter. Any diff is a fold error to fix before delivery.
4. Re-sync the copies under `backend/{sqlite,postgres}/migrations` and
   `desktop/sqlite/migrations` (currently byte-identical to `database/`), and
   confirm the build scripts (`backend/scripts/build-server.mjs`,
   `scripts/build-desktop.ts`) still resolve them.
5. Run the existing Postgres conformance test
   (`database/src/organizations-migration.postgres-conformance.test.ts`) and the
   SQLite core suite via the documented redirects.

> No docker/psql in the pod — Postgres execution uses `@electric-sql/pglite`
> (embedded WASM Postgres) as a scratch dependency, and deferred constraints must
> be declared `DEFERRABLE` (not reordered) for composite-FK rekeys.

## Step 2 — reconciliation for already-migrated databases

Ship `database/{sqlite,postgres}/reconcile_schema_migrations.sql` (name TBD; run
manually / by a one-off tool, not auto-discovered by the runner since it doesn't
match the migration filename pattern). It must, for the relevant adapter:

- `UPSERT` `schema_migrations` rows for the surviving files (`001`,`002`,`003`,
  `004`, and `20260625` everhour) with their **new** checksums, and
- `DELETE` `schema_migrations` rows for every folded version that no longer has a
  file (all the other timestamped versions).

The exact checksums are generated from the finished files (sha256 of each file's
bytes) so the reconciled rows match what a fresh install would record. Verify by
pointing the runner at a reconciled copy of an old DB and confirming it reports no
pending work and no checksum mismatch.

## Deliverable of the *next* objective (execution)

Edited `001`–`004` for both adapters, deleted folded files, retained everhour,
re-synced backend/desktop copies, reconciliation SQL, and passing before/after
schema+seed diffs for both adapters.
