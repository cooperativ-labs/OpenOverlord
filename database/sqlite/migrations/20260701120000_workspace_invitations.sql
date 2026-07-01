-- Workspace member invitations (Phase 3 of
-- planning/feature-plans/multitenancy-access-control.md). The only way to add
-- another user to a workspace: an ADMIN issues a single-use, hashed token
-- (mirroring user_tokens, 003_rbac.sql) tied to an email address; accepting it
-- creates the workspace_users row. Raw tokens are never persisted.

PRAGMA foreign_keys = ON;

BEGIN;

CREATE TABLE workspace_invitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  email TEXT NOT NULL CHECK (length(trim(email)) > 0),
  role_key TEXT NOT NULL DEFAULT 'MEMBER' CHECK (length(trim(role_key)) > 0),
  token_prefix TEXT NOT NULL CHECK (length(trim(token_prefix)) > 0),
  token_hash TEXT NOT NULL CHECK (length(trim(token_hash)) > 0),
  hash_algorithm TEXT NOT NULL CHECK (length(trim(hash_algorithm)) > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  invited_by_workspace_user_id TEXT NOT NULL REFERENCES workspace_users (id) ON DELETE RESTRICT,
  accepted_by_workspace_user_id TEXT REFERENCES workspace_users (id) ON DELETE SET NULL,
  expires_at TEXT NOT NULL CHECK (expires_at GLOB '????-??-??T??:??:??.???Z'),
  accepted_at TEXT CHECK (accepted_at IS NULL OR accepted_at GLOB '????-??-??T??:??:??.???Z'),
  revoked_at TEXT CHECK (revoked_at IS NULL OR revoked_at GLOB '????-??-??T??:??:??.???Z'),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

-- Only one pending invitation per (workspace, email) at a time; re-inviting
-- after acceptance/revocation/expiry is allowed once the prior row is no
-- longer 'pending'.
CREATE UNIQUE INDEX idx_workspace_invitations_workspace_email_pending
  ON workspace_invitations (workspace_id, email)
  WHERE status = 'pending' AND deleted_at IS NULL;

CREATE UNIQUE INDEX idx_workspace_invitations_workspace_prefix
  ON workspace_invitations (workspace_id, token_prefix);

CREATE INDEX idx_workspace_invitations_workspace_status
  ON workspace_invitations (workspace_id, status);

COMMIT;
