-- Workspace member invitations (Phase 3 of
-- planning/feature-plans/multitenancy-access-control.md). The only way to add
-- another user to a workspace: an ADMIN issues a single-use, hashed token
-- (mirroring user_tokens, 003_rbac.sql) tied to an email address; accepting it
-- creates the workspace_users row. Raw tokens are never persisted.

BEGIN;

CREATE TABLE workspace_invitations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  email text NOT NULL CHECK (char_length(btrim(email)) > 0),
  role_key text NOT NULL DEFAULT 'MEMBER' CHECK (char_length(btrim(role_key)) > 0),
  token_prefix text NOT NULL CHECK (char_length(btrim(token_prefix)) > 0),
  token_hash text NOT NULL CHECK (char_length(btrim(token_hash)) > 0),
  hash_algorithm text NOT NULL CHECK (char_length(btrim(hash_algorithm)) > 0),
  status text NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  invited_by_workspace_user_id text NOT NULL REFERENCES workspace_users (id) ON DELETE RESTRICT,
  accepted_by_workspace_user_id text REFERENCES workspace_users (id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
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
