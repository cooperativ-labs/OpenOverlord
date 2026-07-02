-- Support profile-owned USER_TOKEN lookup and management. Token rows keep their
-- issuance workspace for audit, but authentication resolves by hash first and
-- authorization resolves the active workspace membership separately.

CREATE INDEX IF NOT EXISTS idx_user_tokens_profile_prefix
  ON user_tokens (profile_id, token_prefix);

CREATE INDEX IF NOT EXISTS idx_user_tokens_hash_active
  ON user_tokens (token_hash)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_user_token_scopes_token_active
  ON user_token_scopes (token_id)
  WHERE deleted_at IS NULL;
