import { createHash, randomBytes } from 'node:crypto';

import { makeActor } from '../rbac/authorizer.js';
import type { Actor, Role } from '../rbac/types.js';

import { type AuthDomainDatabase, execute, queryAll, queryOne } from './database.js';

// Raw tokens are prefixed with "out_" to make them identifiable as Overlord
// user tokens (vs session tokens, API keys from other systems, etc.).
const TOKEN_PREFIX = 'out_';
const HASH_ALGORITHM = 'sha256';

/**
 * Tokens default to a bounded lifetime (security audit 2026-06-18). Callers pass
 * an explicit `expiresAt`, or an explicit `null` to opt out (non-expiring).
 */
const DEFAULT_TOKEN_TTL_DAYS = 90;

function isoNow(): string {
  return new Date().toISOString();
}

/** ISO timestamp `days` from now, used for the default token expiry. */
function isoInDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function normalizeTimestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
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
  /** Explicit expiry; `null` opts out; omitting defaults to 90 days. */
  expiresAt?: string | null;
  /**
   * Scope grant patterns to persist in `user_token_scopes`. Empty/omitted means
   * a `full` token (no token-level restriction). Each entry needs a freshly
   * generated id for the row, supplied via `scopeRowIds` aligned by index.
   */
  scopeGrants?: readonly string[];
  scopeRowIds?: readonly string[];
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
export async function createUserToken(
  db: AuthDomainDatabase,
  params: CreateTokenParams
): Promise<{ meta: UserTokenMeta; rawToken: string }> {
  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const tokenPrefix = displayPrefix(rawToken);
  const now = isoNow();

  // Omitting `expiresAt` defaults to a bounded TTL; an explicit `null` opts out.
  const expiresAt =
    params.expiresAt === undefined ? isoInDays(DEFAULT_TOKEN_TTL_DAYS) : params.expiresAt;

  await execute(
    db,
    `INSERT INTO user_tokens (
       id, workspace_id, profile_id, workspace_user_id, label,
       token_prefix, token_hash, hash_algorithm,
       status, expires_at, last_used_at, last_used_context_json,
       metadata_json, created_at, updated_at, revision
     ) VALUES (
       ?, ?, ?, ?, ?,
       ?, ?, ?,
       'active', ?, NULL, '{}',
       '{}', ?, ?, 1
     )`,
    [
      params.id,
      params.workspaceId,
      params.userId,
      params.workspaceUserId,
      params.label,
      tokenPrefix,
      tokenHash,
      HASH_ALGORITHM,
      expiresAt,
      now,
      now
    ]
  );

  // Persist scope grants (empty = `full`, no token-level restriction).
  const scopeGrants = params.scopeGrants ?? [];
  for (let i = 0; i < scopeGrants.length; i += 1) {
    await execute(
      db,
      `INSERT INTO user_token_scopes (
         id, workspace_id, token_id, permission, resource_type, resource_id,
         created_at, updated_at, revision
       ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, 1)`,
      [
        params.scopeRowIds?.[i] ?? `${params.id}-scope-${i}`,
        params.workspaceId,
        params.id,
        scopeGrants[i],
        now,
        now
      ]
    );
  }

  const meta: UserTokenMeta = {
    id: params.id,
    workspaceId: params.workspaceId,
    workspaceUserId: params.workspaceUserId,
    label: params.label,
    tokenPrefix,
    status: 'active',
    expiresAt,
    lastUsedAt: null,
    createdAt: now
  };

  return { meta, rawToken };
}

/** List non-deleted token metadata for a workspace user (no hashes returned). */
export async function listUserTokens(
  db: AuthDomainDatabase,
  workspaceUserId: string,
  workspaceId: string
): Promise<UserTokenMeta[]> {
  const rows = await queryAll<{
    id: string;
    workspace_id: string;
    workspace_user_id: string;
    label: string;
    token_prefix: string;
    status: string;
    expires_at: Date | string | null;
    last_used_at: Date | string | null;
    created_at: Date | string;
  }>(
    db,
    `SELECT id, workspace_id, workspace_user_id, label, token_prefix,
            status, expires_at, last_used_at, created_at
     FROM user_tokens
     WHERE workspace_user_id = ?
       AND workspace_id = ?
       AND deleted_at IS NULL
     ORDER BY created_at DESC`,
    [workspaceUserId, workspaceId]
  );

  return rows.map(r => ({
    id: r.id,
    workspaceId: r.workspace_id,
    workspaceUserId: r.workspace_user_id,
    label: r.label,
    tokenPrefix: r.token_prefix,
    status: r.status as UserTokenMeta['status'],
    expiresAt: normalizeTimestamp(r.expires_at),
    lastUsedAt: normalizeTimestamp(r.last_used_at),
    createdAt: normalizeTimestamp(r.created_at) ?? ''
  }));
}

/** Revoke a token by its ID. No-ops if already revoked or not found. */
export async function revokeUserToken(
  db: AuthDomainDatabase,
  tokenId: string,
  revokedByWorkspaceUserId: string
): Promise<void> {
  const now = isoNow();
  await execute(
    db,
    `UPDATE user_tokens
     SET status = 'revoked',
         revoked_at = ?,
         revoked_by_workspace_user_id = ?,
         updated_at = ?,
         revision = revision + 1
     WHERE id = ?
       AND status = 'active'
       AND deleted_at IS NULL`,
    [now, revokedByWorkspaceUserId, now, tokenId]
  );
}

/**
 * Resolve which workspace a raw USER_TOKEN belongs to, from the token alone
 * (no workspace id required up front). Tokens are looked up by the SHA-256
 * hash of a 256-bit random secret, so a hash collision across workspaces is
 * not a practical concern even without a DB-level uniqueness constraint on
 * `token_hash` alone. Callers pass the resolved id back into `verifyUserToken`
 * to do the real (workspace-scoped) validation. Returns `null` if no active,
 * non-deleted token matches.
 */
export async function resolveUserTokenWorkspaceId(
  db: AuthDomainDatabase,
  rawToken: string
): Promise<string | null> {
  const tokenHash = hashToken(rawToken);
  const row = await queryOne<{ workspace_id: string }>(
    db,
    `SELECT workspace_id FROM user_tokens
     WHERE token_hash = ?
       AND status = 'active'
       AND deleted_at IS NULL
     LIMIT 1`,
    [tokenHash]
  );
  return row?.workspace_id ?? null;
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
export async function verifyUserToken(
  db: AuthDomainDatabase,
  rawToken: string,
  workspaceId: string
): Promise<VerifiedToken | null> {
  const tokenHash = hashToken(rawToken);
  const now = isoNow();

  const row = await queryOne<{
    id: string;
    workspace_id: string;
    workspace_user_id: string;
    status: string;
    expires_at: Date | string | null;
  }>(
    db,
    `SELECT id, workspace_id, workspace_user_id, status, expires_at
     FROM user_tokens
     WHERE token_hash = ?
       AND workspace_id = ?
       AND status = 'active'
       AND deleted_at IS NULL
     LIMIT 1`,
    [tokenHash, workspaceId]
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
    workspaceUserId: row.workspace_user_id,
    status: row.status,
    expiresAt
  };
}

/**
 * Verify a token and resolve it to an Actor by loading the workspace user's
 * current role assignments. Returns null if the token is invalid.
 */
export async function getActorForToken(
  db: AuthDomainDatabase,
  rawToken: string,
  workspaceId: string
): Promise<Actor | null> {
  const verified = await verifyUserToken(db, rawToken, workspaceId);
  if (!verified) return null;

  const roleRows = await queryAll<{ role_key: string }>(
    db,
    `SELECT role_key
     FROM role_assignments
     WHERE workspace_user_id = ?
       AND workspace_id = ?
       AND deleted_at IS NULL`,
    [verified.workspaceUserId, workspaceId]
  );

  const roles = roleRows.map(r => r.role_key as Role);
  return makeActor(verified.workspaceUserId, roles);
}
