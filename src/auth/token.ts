import { createHash, randomBytes } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { makeActor } from '../rbac/authorizer.js';
import type { Actor, Role } from '../rbac/types.js';

// Raw tokens are prefixed with "out_" to make them identifiable as OpenOverlord
// user tokens (vs session tokens, API keys from other systems, etc.).
const TOKEN_PREFIX = 'out_';
const HASH_ALGORITHM = 'sha256';

function isoNow(): string {
  return new Date().toISOString();
}

function hashToken(rawToken: string): string {
  return createHash(HASH_ALGORITHM).update(rawToken).digest('hex');
}

function generateRawToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

// Prefix stored in the DB for display: "out_" + first 8 chars of the random part.
function displayPrefix(rawToken: string): string {
  return rawToken.slice(0, TOKEN_PREFIX.length + 8) + '…';
}

export interface CreateTokenParams {
  id: string;
  workspaceId: string;
  userId: string;
  workspaceUserId: string;
  label: string;
  expiresAt?: string | null;
}

export interface UserTokenMeta {
  id: string;
  workspaceId: string;
  workspaceUserId: string;
  label: string;
  tokenPrefix: string;
  status: 'active' | 'revoked' | 'expired' | 'rotated';
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

/**
 * Create a new USER_TOKEN. Returns the raw token string ONCE — it is never
 * retrievable again. The caller must deliver it to the user immediately.
 */
export function createUserToken(
  db: BetterSqlite3.Database,
  params: CreateTokenParams,
): { meta: UserTokenMeta; rawToken: string } {
  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const tokenPrefix = displayPrefix(rawToken);
  const now = isoNow();

  db.prepare(
    `INSERT INTO user_tokens (
       id, workspace_id, user_id, workspace_user_id, label,
       token_prefix, token_hash, hash_algorithm,
       status, expires_at, last_used_at, last_used_context_json,
       metadata_json, created_at, updated_at, revision
     ) VALUES (
       ?, ?, ?, ?, ?,
       ?, ?, ?,
       'active', ?, NULL, '{}',
       '{}', ?, ?, 1
     )`,
  ).run(
    params.id,
    params.workspaceId,
    params.userId,
    params.workspaceUserId,
    params.label,
    tokenPrefix,
    tokenHash,
    HASH_ALGORITHM,
    params.expiresAt ?? null,
    now,
    now,
  );

  const meta: UserTokenMeta = {
    id: params.id,
    workspaceId: params.workspaceId,
    workspaceUserId: params.workspaceUserId,
    label: params.label,
    tokenPrefix,
    status: 'active',
    expiresAt: params.expiresAt ?? null,
    lastUsedAt: null,
    createdAt: now,
  };

  return { meta, rawToken };
}

/** List non-deleted token metadata for a workspace user (no hashes returned). */
export function listUserTokens(
  db: BetterSqlite3.Database,
  workspaceUserId: string,
  workspaceId: string,
): UserTokenMeta[] {
  const rows = db
    .prepare<
      [string, string],
      {
        id: string;
        workspace_id: string;
        workspace_user_id: string;
        label: string;
        token_prefix: string;
        status: string;
        expires_at: string | null;
        last_used_at: string | null;
        created_at: string;
      }
    >(
      `SELECT id, workspace_id, workspace_user_id, label, token_prefix,
              status, expires_at, last_used_at, created_at
       FROM user_tokens
       WHERE workspace_user_id = ?
         AND workspace_id = ?
         AND deleted_at IS NULL
       ORDER BY created_at DESC`,
    )
    .all(workspaceUserId, workspaceId);

  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    workspaceUserId: r.workspace_user_id,
    label: r.label,
    tokenPrefix: r.token_prefix,
    status: r.status as UserTokenMeta['status'],
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
  }));
}

/** Revoke a token by its ID. No-ops if already revoked or not found. */
export function revokeUserToken(
  db: BetterSqlite3.Database,
  tokenId: string,
  revokedByWorkspaceUserId: string,
): void {
  const now = isoNow();
  db.prepare(
    `UPDATE user_tokens
     SET status = 'revoked',
         revoked_at = ?,
         revoked_by_workspace_user_id = ?,
         updated_at = ?,
         revision = revision + 1
     WHERE id = ?
       AND status = 'active'
       AND deleted_at IS NULL`,
  ).run(now, revokedByWorkspaceUserId, now, tokenId);
}

interface VerifiedToken {
  id: string;
  workspaceId: string;
  workspaceUserId: string;
  status: string;
  expiresAt: string | null;
}

/**
 * Verify a raw token string. Updates last_used_at on success.
 * Returns token row data on success, null if invalid/expired/revoked.
 */
export function verifyUserToken(
  db: BetterSqlite3.Database,
  rawToken: string,
  workspaceId: string,
): VerifiedToken | null {
  const tokenHash = hashToken(rawToken);
  const now = isoNow();

  const row = db
    .prepare<
      [string, string],
      { id: string; workspace_id: string; workspace_user_id: string; status: string; expires_at: string | null }
    >(
      `SELECT id, workspace_id, workspace_user_id, status, expires_at
       FROM user_tokens
       WHERE token_hash = ?
         AND workspace_id = ?
         AND status = 'active'
         AND deleted_at IS NULL
       LIMIT 1`,
    )
    .get(tokenHash, workspaceId);

  if (!row) return null;

  // Check expiry.
  if (row.expires_at !== null && row.expires_at <= now) return null;

  db.prepare(
    `UPDATE user_tokens
     SET last_used_at = ?, updated_at = ?, revision = revision + 1
     WHERE id = ?`,
  ).run(now, now, row.id);

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workspaceUserId: row.workspace_user_id,
    status: row.status,
    expiresAt: row.expires_at,
  };
}

/**
 * Verify a token and resolve it to an Actor by loading the workspace user's
 * current role assignments. Returns null if the token is invalid.
 */
export function getActorForToken(
  db: BetterSqlite3.Database,
  rawToken: string,
  workspaceId: string,
): Actor | null {
  const verified = verifyUserToken(db, rawToken, workspaceId);
  if (!verified) return null;

  const roleRows = db
    .prepare<[string, string], { role_key: string }>(
      `SELECT role_key
       FROM role_assignments
       WHERE workspace_user_id = ?
         AND workspace_id = ?
         AND deleted_at IS NULL`,
    )
    .all(verified.workspaceUserId, workspaceId);

  const roles = roleRows.map((r) => r.role_key as Role);
  return makeActor(verified.workspaceUserId, roles);
}
