-- Overlord PostgreSQL RBAC schema.
-- Implements Group 1 (Multi-User Access and API Tokens) from
-- database/docs/10-database-table-groups.md.

BEGIN;

-- role_assignments stores durable workspace-user-to-role membership.
-- resource_type and resource_id are non-null; use empty string sentinels for
-- instance/workspace-level roles so the unique index works across adapters.
CREATE TABLE role_assignments (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  workspace_user_id text NOT NULL REFERENCES workspace_users (id) ON DELETE RESTRICT,
  role_key text NOT NULL CHECK (char_length(btrim(role_key)) > 0),
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  assigned_by_workspace_user_id text REFERENCES workspace_users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX idx_role_assignments_active_user_role_scope ON role_assignments
  (workspace_id, workspace_user_id, role_key, resource_type, resource_id)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_role_assignments_workspace_role ON role_assignments (workspace_id, role_key);
CREATE INDEX idx_role_assignments_workspace_user ON role_assignments (workspace_id, workspace_user_id);

-- user_tokens stores USER_TOKEN metadata and hashes only. Raw secrets must never be persisted.
-- workspace_id and workspace_user_id are nullable audit-only metadata: a
-- zero-membership user has no workspace_users row in any workspace yet must be
-- able to mint a token and run `ovld org-setup` headless (coo:135).
CREATE TABLE user_tokens (
  id text PRIMARY KEY,
  workspace_id text REFERENCES workspaces (id) ON DELETE RESTRICT,
  profile_id text NOT NULL REFERENCES profiles (id) ON DELETE RESTRICT,
  workspace_user_id text REFERENCES workspace_users (id) ON DELETE RESTRICT,
  label text NOT NULL CHECK (char_length(btrim(label)) > 0),
  token_prefix text NOT NULL CHECK (char_length(btrim(token_prefix)) > 0),
  token_hash text NOT NULL CHECK (char_length(btrim(token_hash)) > 0),
  hash_algorithm text NOT NULL CHECK (char_length(btrim(hash_algorithm)) > 0),
  status text NOT NULL CHECK (status IN ('active', 'revoked', 'expired', 'rotated')),
  expires_at timestamptz,
  last_used_at timestamptz,
  last_used_context_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  revoked_at timestamptz,
  revoked_by_workspace_user_id text REFERENCES workspace_users (id) ON DELETE SET NULL,
  predecessor_token_id text REFERENCES user_tokens (id) ON DELETE SET NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX idx_user_tokens_workspace_prefix ON user_tokens (workspace_id, token_prefix);
CREATE INDEX idx_user_tokens_workspace_user_status ON user_tokens (workspace_id, workspace_user_id, status);
CREATE INDEX idx_user_tokens_profile_status ON user_tokens (profile_id, status);
CREATE INDEX idx_user_tokens_workspace_expires ON user_tokens (workspace_id, expires_at)
  WHERE expires_at IS NOT NULL;
-- Profile-owned token lookup: authentication resolves by hash first, then
-- authorization resolves the active workspace membership separately (coo:135).
CREATE INDEX idx_user_tokens_profile_prefix ON user_tokens (profile_id, token_prefix);
CREATE INDEX idx_user_tokens_hash_active ON user_tokens (token_hash)
  WHERE deleted_at IS NULL;

-- user_token_scopes reserves future token-level permission restrictions.
-- Absence of rows for a token means the token inherits the full permissions of the creating user.
CREATE TABLE user_token_scopes (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  token_id text NOT NULL REFERENCES user_tokens (id) ON DELETE RESTRICT,
  permission text NOT NULL CHECK (char_length(btrim(permission)) > 0),
  resource_type text,
  resource_id text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE INDEX idx_user_token_scopes_token ON user_token_scopes (token_id);
CREATE INDEX idx_user_token_scopes_workspace_token ON user_token_scopes (workspace_id, token_id);
CREATE INDEX idx_user_token_scopes_token_active ON user_token_scopes (token_id)
  WHERE deleted_at IS NULL;

COMMIT;
