-- Overlord SQLite RBAC schema.
-- Implements Group 1 (Multi-User Access and API Tokens) from
-- planning/feature-plans/10-database-table-groups.md.
-- See planning/feature-plans/08-role-based-access-control.md and
-- planning/feature-plans/09-database-schema-contract.md for the full contract.

PRAGMA foreign_keys = ON;

BEGIN;

-- role_assignments stores durable workspace-user-to-role membership.
-- resource_type and resource_id are non-null; use empty string sentinels for
-- instance/workspace-level roles so the unique index works on both SQLite and Postgres.
CREATE TABLE role_assignments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  workspace_user_id TEXT NOT NULL REFERENCES workspace_users (id) ON DELETE RESTRICT,
  role_key TEXT NOT NULL CHECK (length(trim(role_key)) > 0),
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  assigned_by_workspace_user_id TEXT REFERENCES workspace_users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX idx_role_assignments_active_user_role_scope ON role_assignments
  (workspace_id, workspace_user_id, role_key, resource_type, resource_id)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_role_assignments_workspace_role ON role_assignments (workspace_id, role_key);
CREATE INDEX idx_role_assignments_workspace_user ON role_assignments (workspace_id, workspace_user_id);

-- user_tokens stores USER_TOKEN metadata and hashes only. Raw secrets must never be persisted.
CREATE TABLE user_tokens (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  profile_id TEXT NOT NULL REFERENCES profiles (id) ON DELETE RESTRICT,
  workspace_user_id TEXT NOT NULL REFERENCES workspace_users (id) ON DELETE RESTRICT,
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

CREATE UNIQUE INDEX idx_user_tokens_workspace_prefix ON user_tokens (workspace_id, token_prefix);
CREATE INDEX idx_user_tokens_workspace_user_status ON user_tokens (workspace_id, workspace_user_id, status);
CREATE INDEX idx_user_tokens_profile_status ON user_tokens (profile_id, status);
CREATE INDEX idx_user_tokens_workspace_expires ON user_tokens (workspace_id, expires_at)
  WHERE expires_at IS NOT NULL;

-- user_token_scopes reserves future token-level permission restrictions.
-- Absence of rows for a token means the token inherits the full permissions of the creating user.
CREATE TABLE user_token_scopes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  token_id TEXT NOT NULL REFERENCES user_tokens (id) ON DELETE RESTRICT,
  permission TEXT NOT NULL CHECK (length(trim(permission)) > 0),
  resource_type TEXT,
  resource_id TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE INDEX idx_user_token_scopes_token ON user_token_scopes (token_id);
CREATE INDEX idx_user_token_scopes_workspace_token ON user_token_scopes (workspace_id, token_id);

-- Seed: grant ADMIN to the implicit local workspace user.
-- Empty string sentinels for resource_type and resource_id represent workspace-level scope.
INSERT INTO role_assignments (
  id, workspace_id, workspace_user_id, role_key, resource_type, resource_id,
  assigned_by_workspace_user_id, created_at, updated_at, revision
) VALUES (
  'local-admin-role', 'local-workspace', 'local-workspace-user', 'ADMIN', '', '',
  NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1
);

COMMIT;
