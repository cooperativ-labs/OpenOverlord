-- Organization -> workspace -> project hierarchy (coo:135). Workspaces remain
-- the sole RBAC layer; an organization is a grouping + identity shell above
-- them. See planning/feature-plans/organization-workspace-hierarchy.md.
--
-- Data-correctness scope (R2 in the plan): this migration's data path is
-- authored for the real production database (currently three live
-- workspaces). On a fresh/seed-only database it degrades to schema-only
-- changes plus the no-seed cleanup below, ending the migration chain at zero
-- orgs and zero workspaces (Q10).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. organizations table.
-- ---------------------------------------------------------------------------

CREATE TABLE organizations (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (char_length(btrim(name)) > 0),
  settings_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

-- ---------------------------------------------------------------------------
-- 2. No-seed cleanup (Q10): delete the pristine `local-workspace` seed and its
-- seeded statuses/buckets/membership/role assignment, but only when this is
-- unambiguously a fresh/seed-only database -- the seed workspace is untouched
-- (original name/slug, no projects/missions) AND it is the *only* workspace in
-- the database. The second condition matters: without it, a production
-- database whose oldest real workspace happens to still be named "Local
-- Workspace"/"local" (unlikely, but not impossible) would have that workspace
-- deleted here instead of preserved as the org's identity source in step 3.
-- Mirrors the existence-check-in-a-temp-table style of
-- 20260618010000_remove_seed_local_user.sql.
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE _organizations_migration_seed_check ON COMMIT DROP AS
SELECT
  EXISTS (
    SELECT 1 FROM workspaces
     WHERE id = 'local-workspace'
       AND slug = 'local'
       AND name = 'Local Workspace'
       AND kind = 'local'
       AND deleted_at IS NULL
  )
  AND (SELECT COUNT(*) FROM workspaces) = 1
  AND NOT EXISTS (SELECT 1 FROM projects WHERE workspace_id = 'local-workspace')
  AND NOT EXISTS (SELECT 1 FROM missions WHERE workspace_id = 'local-workspace')
  AS should_remove_seed;

DELETE FROM role_assignments
 WHERE workspace_id = 'local-workspace'
   AND EXISTS (SELECT 1 FROM _organizations_migration_seed_check WHERE should_remove_seed);

DELETE FROM workspace_users
 WHERE workspace_id = 'local-workspace'
   AND EXISTS (SELECT 1 FROM _organizations_migration_seed_check WHERE should_remove_seed);

DELETE FROM storage_buckets
 WHERE workspace_id = 'local-workspace'
   AND EXISTS (SELECT 1 FROM _organizations_migration_seed_check WHERE should_remove_seed);

DELETE FROM workspace_statuses
 WHERE workspace_id = 'local-workspace'
   AND EXISTS (SELECT 1 FROM _organizations_migration_seed_check WHERE should_remove_seed);

DELETE FROM mission_sequences
 WHERE workspace_id = 'local-workspace'
   AND EXISTS (SELECT 1 FROM _organizations_migration_seed_check WHERE should_remove_seed);

DELETE FROM workspaces
 WHERE id = 'local-workspace'
   AND EXISTS (SELECT 1 FROM _organizations_migration_seed_check WHERE should_remove_seed);

-- ---------------------------------------------------------------------------
-- 3. Backfill exactly one organization from whatever workspace(s) remain.
-- Identity (name/logo) prefers the oldest *live* workspace, falling back to
-- the oldest workspace overall if none are live (so a NOT NULL
-- organization_id is always satisfiable in step 4, even for a database that
-- somehow has only soft-deleted workspace history left). Skipped entirely
-- when zero workspace rows remain, which is the expected fresh-install
-- outcome of step 2.
-- ---------------------------------------------------------------------------

INSERT INTO organizations (id, name, settings_json, created_at, updated_at, revision)
SELECT
  gen_random_uuid()::text,
  identity.name,
  CASE
    WHEN identity.settings_json ? 'logoUrl' AND identity.settings_json ->> 'logoUrl' IS NOT NULL
      THEN jsonb_build_object('logoUrl', identity.settings_json ->> 'logoUrl')
    ELSE '{}'::jsonb
  END,
  now(),
  now(),
  1
FROM (
  SELECT name, settings_json
    FROM workspaces
   ORDER BY (deleted_at IS NULL) DESC, created_at ASC, id ASC
   LIMIT 1
) AS identity
WHERE EXISTS (SELECT 1 FROM workspaces);

-- ---------------------------------------------------------------------------
-- 4. Attach every remaining workspace (live or soft-deleted) to the single
-- organization; strip `logoUrl` from workspace settings now that it lives on
-- the organization.
-- ---------------------------------------------------------------------------

ALTER TABLE workspaces
  ADD COLUMN organization_id text REFERENCES organizations (id) ON DELETE RESTRICT;

UPDATE workspaces
   SET organization_id = (SELECT id FROM organizations LIMIT 1),
       settings_json = settings_json - 'logoUrl',
       updated_at = now(),
       revision = revision + 1;

ALTER TABLE workspaces ALTER COLUMN organization_id SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. UUID rekey: workspace IDs move from slugified names to opaque UUIDs.
-- Technique: repoint workspaces.id and every workspace_id-bearing table's
-- rows to a new UUID within one transaction, with every FK involving
-- workspace_id made DEFERRABLE (and deferred for this transaction only) so
-- Postgres validates once at COMMIT instead of after each statement.
--
-- A pure statement-ordering approach (repoint parents before children)
-- cannot work here: several workspace-scoped tables are simultaneously an FK
-- *child* of workspaces and an FK *parent* of a composite key including
-- workspace_id (e.g. `missions (workspace_id, project_id) REFERENCES
-- projects (workspace_id, id)`). With immediate (non-deferred) checking,
-- changing the parent side of that composite key (projects.workspace_id)
-- while the child (missions) still points at the old value is *itself* a
-- violation raised on the parent's own UPDATE statement -- before a later
-- statement ever gets to update the child. Neither repoint order avoids
-- this without deferring the check to end-of-transaction.
--
-- 20260627000000_deferrable_workspace_fks.sql already made every workspace_id
-- FK that existed *at that time* deferrable for exactly this kind of rekey;
-- the DO block below re-applies the same idempotent sweep so it also covers
-- every workspace_id FK added by later migrations (target_resource_observations,
-- mission_branch_observations, workspace_invitations, schedules, webhooks).
-- display_id values are never touched (R3).
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  fk record;
BEGIN
  FOR fk IN
    SELECT n.nspname AS schema_name,
           c.relname AS table_name,
           con.conname AS constraint_name
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE con.contype = 'f'
       AND n.nspname = current_schema()
       AND EXISTS (
         SELECT 1
           FROM unnest(con.conkey) AS key(attnum)
           JOIN pg_attribute a
             ON a.attrelid = con.conrelid
            AND a.attnum = key.attnum
          WHERE a.attname = 'workspace_id'
       )
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ALTER CONSTRAINT %I DEFERRABLE INITIALLY IMMEDIATE',
      fk.schema_name,
      fk.table_name,
      fk.constraint_name
    );
  END LOOP;
END $$;

SET CONSTRAINTS ALL DEFERRED;

CREATE TEMP TABLE _workspace_rekey_map (
  old_id text PRIMARY KEY,
  new_id text NOT NULL
) ON COMMIT DROP;

INSERT INTO _workspace_rekey_map (old_id, new_id)
SELECT id, gen_random_uuid()::text FROM workspaces;

UPDATE workspaces w SET id = m.new_id FROM _workspace_rekey_map m WHERE w.id = m.old_id;

-- Repoint every workspace_id-bearing table (39 tables as of authoring time,
-- enumerated below; search_documents is not repointed here, see the next
-- step). Deferred constraints mean the order below is not load-bearing, but
-- it is kept roughly parent-first for readability.
UPDATE workspace_users x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE projects x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE workspace_statuses x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE devices x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE execution_targets x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE workspace_user_execution_targets x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE project_resources x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE project_user_preferences x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE schedules x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE missions x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE my_mission_positions x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE objectives x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE agent_sessions x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE mission_events x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE shared_context_entries x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE objective_attachments x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE deliveries x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE artifacts x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE changed_files x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE change_rationales x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE execution_requests x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE idempotency_keys x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE entity_changes x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE role_assignments x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE user_tokens x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE user_token_scopes x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE storage_buckets x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE workspace_images x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE user_images x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE attachments x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE project_tags x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE target_resource_observations x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE mission_branch_observations x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE workspace_invitations x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE outbox_messages x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE webhook_subscriptions x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;
UPDATE webhook_delivery_attempts x SET workspace_id = m.new_id FROM _workspace_rekey_map m WHERE x.workspace_id = m.old_id;

-- mission_sequences.scope_id equals workspace_id whenever scope_type =
-- 'workspace' (the only value the CHECK constraint allows today), so both
-- columns move together.
UPDATE mission_sequences x
   SET workspace_id = m.new_id, scope_id = m.new_id
  FROM _workspace_rekey_map m
 WHERE x.workspace_id = m.old_id;

-- search_documents is purged rather than rekeyed (reindexed lazily): the
-- search-sync triggers on missions/objectives/mission_events
-- (20260613120000_mission_search.sql) already relocate most rows to the new
-- workspace_id as a side effect of the UPDATEs above, but matching on both
-- the old *and* new id guarantees a full purge regardless.
DELETE FROM search_documents x
 USING _workspace_rekey_map m
 WHERE x.workspace_id IN (m.old_id, m.new_id);

-- Every workspace_id-bearing row is now fully consistent (workspaces.id and
-- every dependent column moved together). Force the deferred FK checks to
-- run now instead of waiting for COMMIT: Postgres refuses DDL like CREATE
-- INDEX on a table with pending deferred trigger events, and the slug-index
-- swap and later ALTER TABLEs below need `workspaces` (and others) clear of
-- them. Checking now, rather than at COMMIT, is safe precisely because every
-- repoint above already completed.
SET CONSTRAINTS ALL IMMEDIATE;

-- ---------------------------------------------------------------------------
-- 6. Slug uniqueness moves from instance-wide to per-organization (Q1):
-- workspaces in different organizations may now share a slug.
-- ---------------------------------------------------------------------------

DROP INDEX idx_workspaces_slug;

CREATE UNIQUE INDEX idx_workspaces_organization_slug ON workspaces (organization_id, slug)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 7. storage_buckets: add nullable organization_id with a CHECK that exactly
-- one of workspace_id/organization_id is set (an organization logo must
-- outlive any single member workspace, so it cannot live in a workspace's
-- bucket); insert an organization-images bucket for the organization. The
-- logo URL itself already moved to organizations.settings_json in step 3;
-- bytes are not moved (same precedent as 20260702111500).
-- ---------------------------------------------------------------------------

ALTER TABLE storage_buckets
  ADD COLUMN organization_id text REFERENCES organizations (id) ON DELETE RESTRICT;

ALTER TABLE storage_buckets ALTER COLUMN workspace_id DROP NOT NULL;

ALTER TABLE storage_buckets
  ADD CONSTRAINT storage_buckets_workspace_xor_organization
  CHECK ((workspace_id IS NOT NULL) <> (organization_id IS NOT NULL));

CREATE UNIQUE INDEX idx_storage_buckets_active_organization_key ON storage_buckets
  (organization_id, bucket_key)
  WHERE organization_id IS NOT NULL AND deleted_at IS NULL;

INSERT INTO storage_buckets (
  id, organization_id, bucket_key, storage_backend, base_url, local_path, settings_json,
  created_at, updated_at, revision
)
SELECT
  gen_random_uuid()::text, o.id, 'organization-images', 'local_fs',
  NULL, 'database/.local/storage', '{}'::jsonb, now(), now(), 1
FROM organizations o;

-- ---------------------------------------------------------------------------
-- 8. user_tokens: workspace_id and workspace_user_id both become nullable.
-- Both have been audit-only metadata since 20260702103000 (auth resolves by
-- token hash + profile, then validates the requested workspace separately),
-- and a zero-membership user has no workspace_users row in *any* workspace to
-- reference -- both columns must accept NULL for such a user to mint a token
-- and run `ovld org-setup` headless.
-- ---------------------------------------------------------------------------

ALTER TABLE user_tokens ALTER COLUMN workspace_id DROP NOT NULL;
ALTER TABLE user_tokens ALTER COLUMN workspace_user_id DROP NOT NULL;

COMMIT;
