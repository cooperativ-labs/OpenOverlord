-- Organization -> workspace -> project hierarchy (coo:135). Workspaces remain
-- the sole RBAC layer; an organization is a grouping + identity shell above
-- them. See planning/feature-plans/organization-workspace-hierarchy.md.
--
-- SQLite data-correctness scope (R2 in the plan): the local SQLite database is
-- wiped in practice, so this migration only has to be schema-correct and
-- harmless on a fresh/seed-only database. No UUID rekey and no organization
-- backfill run here (both are Postgres-only data paths, see the Postgres
-- migration of the same name) -- after the no-seed cleanup below, a fresh
-- database has zero workspace rows, so there is nothing to attach to an
-- organization and no data-preserving rekey to perform. If this ever runs
-- against a non-pristine local SQLite database with real workspace data, the
-- workspaces/storage_buckets rebuilds below will fail loudly on the added
-- NOT NULL organization_id (no backfill to satisfy it) rather than silently
-- losing data -- that scenario is explicitly out of scope (R2).
--
-- Table rebuilds below follow SQLite's documented twelve-step ALTER TABLE
-- procedure (https://www.sqlite.org/lang_altertable.html#otheralter) since
-- SQLite cannot add a NOT NULL column or a cross-column CHECK constraint via
-- plain ALTER TABLE ADD COLUMN.

PRAGMA foreign_keys = OFF;

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. organizations table.
-- ---------------------------------------------------------------------------

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

-- ---------------------------------------------------------------------------
-- 2. No-seed cleanup (Q10): delete the pristine `local-workspace` seed and its
-- seeded statuses/buckets/membership/role assignment, but only when this is
-- unambiguously a fresh/seed-only database -- see the matching Postgres
-- migration for the full rationale (same predicate here).
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE _organizations_migration_seed_check AS
SELECT (
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
) AS should_remove_seed;

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

DROP TABLE _organizations_migration_seed_check;

-- ---------------------------------------------------------------------------
-- 3. Rebuild `workspaces`: add organization_id NOT NULL, drop the instance-
-- wide slug index in favor of a per-organization one (Q1), strip `logoUrl`
-- from settings_json (moved to the organization). `(SELECT id FROM
-- organizations LIMIT 1)` is only ever read for a row that survives step 2,
-- which never happens on a supported (fresh/pristine) SQLite database.
-- ---------------------------------------------------------------------------

CREATE TABLE workspaces_new (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  slug TEXT NOT NULL CHECK (length(trim(slug)) > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('local', 'hosted')),
  settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

INSERT INTO workspaces_new (
  id, organization_id, slug, name, kind, settings_json,
  created_at, updated_at, deleted_at, revision
)
SELECT
  w.id,
  (SELECT id FROM organizations LIMIT 1),
  w.slug, w.name, w.kind, json_remove(w.settings_json, '$.logoUrl'),
  w.created_at, w.updated_at, w.deleted_at, w.revision
FROM workspaces w;

DROP TABLE workspaces;
ALTER TABLE workspaces_new RENAME TO workspaces;

CREATE UNIQUE INDEX idx_workspaces_organization_slug ON workspaces (organization_id, slug)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 4. Rebuild `storage_buckets`: add nullable organization_id with a CHECK
-- that exactly one of workspace_id/organization_id is set (SQLite cannot add
-- a cross-column CHECK via plain ALTER TABLE ADD COLUMN). No organization
-- exists to attach an `organization-images` bucket to on a fresh install
-- (Q10: zero orgs survive step 2 there), so no bucket row is inserted here --
-- contrast the Postgres migration, which does insert one.
-- ---------------------------------------------------------------------------

CREATE TABLE storage_buckets_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces (id) ON DELETE RESTRICT,
  organization_id TEXT REFERENCES organizations (id) ON DELETE RESTRICT,
  bucket_key TEXT NOT NULL CHECK (length(trim(bucket_key)) > 0),
  storage_backend TEXT NOT NULL CHECK (length(trim(storage_backend)) > 0),
  base_url TEXT,
  local_path TEXT,
  settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json)),
  created_by_workspace_user_id TEXT REFERENCES workspace_users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CHECK ((workspace_id IS NOT NULL) <> (organization_id IS NOT NULL))
);

INSERT INTO storage_buckets_new (
  id, workspace_id, bucket_key, storage_backend, base_url, local_path, settings_json,
  created_by_workspace_user_id, created_at, updated_at, deleted_at, revision
)
SELECT
  id, workspace_id, bucket_key, storage_backend, base_url, local_path, settings_json,
  created_by_workspace_user_id, created_at, updated_at, deleted_at, revision
FROM storage_buckets;

DROP TABLE storage_buckets;
ALTER TABLE storage_buckets_new RENAME TO storage_buckets;

CREATE UNIQUE INDEX idx_storage_buckets_active_workspace_key ON storage_buckets (workspace_id, bucket_key)
  WHERE workspace_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX idx_storage_buckets_active_organization_key ON storage_buckets (organization_id, bucket_key)
  WHERE organization_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_storage_buckets_workspace_backend ON storage_buckets (workspace_id, storage_backend);

-- ---------------------------------------------------------------------------
-- 5. Rebuild `user_tokens`: workspace_id and workspace_user_id both become
-- nullable (SQLite cannot drop a NOT NULL constraint via plain ALTER TABLE).
-- Both have been audit-only metadata since 20260702103000, and a zero-
-- membership user has no workspace_users row in *any* workspace to reference
-- -- both columns must accept NULL for such a user to mint a token and run
-- `ovld org-setup` headless.
-- ---------------------------------------------------------------------------

CREATE TABLE user_tokens_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces (id) ON DELETE RESTRICT,
  profile_id TEXT NOT NULL REFERENCES profiles (id) ON DELETE RESTRICT,
  workspace_user_id TEXT REFERENCES workspace_users (id) ON DELETE RESTRICT,
  label TEXT NOT NULL CHECK (length(trim(label)) > 0),
  token_prefix TEXT NOT NULL CHECK (length(trim(token_prefix)) > 0),
  token_hash TEXT NOT NULL CHECK (length(trim(token_hash)) > 0),
  hash_algorithm TEXT NOT NULL CHECK (length(trim(hash_algorithm)) > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired', 'rotated')),
  expires_at TEXT CHECK (expires_at IS NULL OR expires_at GLOB '????-??-??T??:??:??.???Z'),
  last_used_at TEXT CHECK (last_used_at IS NULL OR last_used_at GLOB '????-??-??T??:??:??.???Z'),
  last_used_context_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(last_used_context_json)),
  revoked_at TEXT CHECK (revoked_at IS NULL OR revoked_at GLOB '????-??-??T??:??:??.???Z'),
  revoked_by_workspace_user_id TEXT REFERENCES workspace_users (id) ON DELETE SET NULL,
  predecessor_token_id TEXT REFERENCES user_tokens (id) ON DELETE SET NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

INSERT INTO user_tokens_new (
  id, workspace_id, profile_id, workspace_user_id, label, token_prefix, token_hash,
  hash_algorithm, status, expires_at, last_used_at, last_used_context_json,
  revoked_at, revoked_by_workspace_user_id, predecessor_token_id, metadata_json,
  created_at, updated_at, deleted_at, revision
)
SELECT
  id, workspace_id, profile_id, workspace_user_id, label, token_prefix, token_hash,
  hash_algorithm, status, expires_at, last_used_at, last_used_context_json,
  revoked_at, revoked_by_workspace_user_id, predecessor_token_id, metadata_json,
  created_at, updated_at, deleted_at, revision
FROM user_tokens;

DROP TABLE user_tokens;
ALTER TABLE user_tokens_new RENAME TO user_tokens;

CREATE UNIQUE INDEX idx_user_tokens_workspace_prefix ON user_tokens (workspace_id, token_prefix);
CREATE INDEX idx_user_tokens_workspace_user_status ON user_tokens (workspace_id, workspace_user_id, status);
CREATE INDEX idx_user_tokens_profile_status ON user_tokens (profile_id, status);
CREATE INDEX idx_user_tokens_workspace_expires ON user_tokens (workspace_id, expires_at)
  WHERE expires_at IS NOT NULL;
CREATE INDEX idx_user_tokens_profile_prefix ON user_tokens (profile_id, token_prefix);
CREATE INDEX idx_user_tokens_hash_active ON user_tokens (token_hash)
  WHERE deleted_at IS NULL;

COMMIT;

PRAGMA foreign_keys = ON;
