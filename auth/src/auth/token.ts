import { createHash, randomBytes } from 'node:crypto';

import { makeActor } from '../rbac/authorizer.js';
import type { Actor, Role } from '../rbac/types.js';

import { type AuthDomainDatabase, execute, queryAll, queryOne } from './database.js';

/**
 * Recognizable prefix for Overlord user tokens (`out_…`), making them
 * identifiable vs session tokens, API keys from other systems, etc.
 */
export const USER_TOKEN_PREFIX = 'out_';
/** Algorithm recorded in `user_tokens.hash_algorithm` and used to hash secrets. */
export const USER_TOKEN_HASH_ALGORITHM = 'sha256';

/**
 * Tokens default to a bounded lifetime so a leaked-but-forgotten credential
 * stops working on its own (security audit 2026-06-18). Callers pass an
 * explicit expiry, or an explicit `null` to opt out (non-expiring).
 */
export const DEFAULT_USER_TOKEN_TTL_DAYS = 90;

function isoNow(): string {
  return new Date().toISOString();
}

function normalizeTimestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/** Hash a raw token secret the way `user_tokens.token_hash` stores it. */
export function hashUserTokenSecret(rawToken: string): string {
  return createHash(USER_TOKEN_HASH_ALGORITHM).update(rawToken).digest('hex');
}

/**
 * Generate a high-entropy secret of the form `out_<prefix><secret>`. The
 * `out_<prefix>` portion is the non-secret lookup/display prefix; the full
 * string is the raw secret. Only the SHA-256 hash of the raw secret is stored.
 * This is the single source of the token format — every writer of
 * `user_tokens` must mint secrets through it so verification stays uniform.
 */
export function generateUserTokenSecret(): { secret: string; prefix: string; hash: string } {
  const prefix = `${USER_TOKEN_PREFIX}${randomBytes(4).toString('hex')}`;
  const secret = `${prefix}${randomBytes(24).toString('hex')}`;
  return { secret, prefix, hash: hashUserTokenSecret(secret) };
}

/**
 * Active scope grant patterns persisted for a token in `user_token_scopes`.
 * Empty means a `full` token (no token-level restriction). Shared by the
 * request-auth path and the token DTO mapper so both read the same rows.
 */
export async function listActiveTokenScopeGrants(
  db: AuthDomainDatabase,
  tokenId: string
): Promise<string[]> {
  const rows = await queryAll<{ permission: string }>(
    db,
    `SELECT permission FROM user_token_scopes
     WHERE token_id = ? AND deleted_at IS NULL
     ORDER BY permission ASC`,
    [tokenId]
  );
  return rows.map(r => r.permission);
}

/**
 * Resolve which user profile owns a raw USER_TOKEN from the token alone. Tokens
 * are looked up by the SHA-256 hash of a 256-bit random secret, so a hash
 * collision across profiles/workspaces is not a practical concern even without
 * a DB-level uniqueness constraint on `token_hash` alone. Workspace membership
 * is resolved separately at request time.
 */
export async function resolveUserTokenProfileId(
  db: AuthDomainDatabase,
  rawToken: string
): Promise<string | null> {
  const tokenHash = hashUserTokenSecret(rawToken);
  const row = await queryOne<{ profile_id: string }>(
    db,
    `SELECT profile_id FROM user_tokens
     WHERE token_hash = ?
       AND status = 'active'
       AND deleted_at IS NULL
     LIMIT 1`,
    [tokenHash]
  );
  return row?.profile_id ?? null;
}

interface VerifiedToken {
  id: string;
  workspaceId: string;
  profileId: string;
  workspaceUserId: string;
  status: string;
  expiresAt: string | null;
}

/**
 * Verify a raw token string. Updates last_used_at on success.
 * Returns token row data on success, null if invalid/expired/revoked.
 */
export async function verifyUserToken(
  db: AuthDomainDatabase,
  rawToken: string
): Promise<VerifiedToken | null> {
  const tokenHash = hashUserTokenSecret(rawToken);
  const now = isoNow();

  const row = await queryOne<{
    id: string;
    workspace_id: string;
    profile_id: string;
    workspace_user_id: string;
    status: string;
    expires_at: Date | string | null;
  }>(
    db,
    `SELECT id, workspace_id, profile_id, workspace_user_id, status, expires_at
     FROM user_tokens
     WHERE token_hash = ?
       AND status = 'active'
       AND deleted_at IS NULL
     LIMIT 1`,
    [tokenHash]
  );

  if (!row) return null;

  // Check expiry.
  const expiresAt = normalizeTimestamp(row.expires_at);
  if (expiresAt !== null && expiresAt <= now) return null;

  await execute(
    db,
    `UPDATE user_tokens
     SET last_used_at = ?, updated_at = ?, revision = revision + 1
     WHERE id = ?`,
    [now, now, row.id]
  );

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    profileId: row.profile_id,
    workspaceUserId: row.workspace_user_id,
    status: row.status,
    expiresAt
  };
}

/**
 * Verify a token and resolve it to an Actor by loading the token owner's active
 * membership and role assignments in the requested workspace. Returns null if
 * the token is invalid or the owner is not an active member of that workspace.
 */
export async function getActorForToken(
  db: AuthDomainDatabase,
  rawToken: string,
  workspaceId: string
): Promise<Actor | null> {
  const verified = await verifyUserToken(db, rawToken);
  if (!verified) return null;

  const membership = await queryOne<{ id: string }>(
    db,
    `SELECT id
     FROM workspace_users
     WHERE workspace_id = ?
       AND profile_id = ?
       AND status = 'active'
       AND deleted_at IS NULL
     LIMIT 1`,
    [workspaceId, verified.profileId]
  );
  if (!membership) return null;

  const roleRows = await queryAll<{ role_key: string }>(
    db,
    `SELECT role_key
     FROM role_assignments
     WHERE workspace_user_id = ?
       AND workspace_id = ?
       AND deleted_at IS NULL`,
    [membership.id, workspaceId]
  );

  const roles = roleRows.map(r => r.role_key as Role);
  return makeActor(membership.id, roles);
}
