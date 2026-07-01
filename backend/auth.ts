import { resolveUserTokenWorkspaceId, verifyUserToken } from '@overlord/auth';
import { resolveAdapter } from '@overlord/database';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import type { NextFunction, Request, Response } from 'express';

import { createAuth } from '../auth/src/auth/config.ts';

import { cascadeDeleteAccount } from './account-deletion.ts';
import { resolveAllowedBrowserOrigins } from './browser-origins.ts';
import { clientDeviceFromRequest } from './client-device.ts';
import {
  type ActiveWorkspace,
  authDomainDatabase,
  DATABASE_PATH,
  getActiveWorkspaceId,
  loadWorkspaceRow,
  requireDatabaseClient,
  resolveActorForWorkspace,
  setActiveProfileId,
  setActiveTokenAuth,
  setActiveWorkspaceContext,
  setActiveWorkspaceUser,
  setClientDeviceIdentity,
  withRequestContextAsync
} from './db.ts';
import { verificationEmailSenderFromEnv } from './email-verification.ts';
import { ApiError } from './errors.ts';
import { grantWorkspaceAdminRole } from './workspaces.ts';

/**
 * Cookie the client automatically resends to pick which of the profile's
 * memberships is active. Set by the `/api/workspaces/:id/activate` and
 * workspace-creation routes (`backend/index.ts`); read here and validated
 * against the profile's own `workspace_users` rows below — never trusted
 * blindly, since a forged value must still resolve to an actual membership or
 * the request is rejected with 403 rather than silently falling back.
 */
export const ACTIVE_WORKSPACE_COOKIE = 'overlord_active_workspace';

function getCookieValue(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

const authBaseHost =
  process.env.OVERLORD_WEB_HOST && process.env.OVERLORD_WEB_HOST !== '0.0.0.0'
    ? process.env.OVERLORD_WEB_HOST
    : '127.0.0.1';
const authBasePort = process.env.OVERLORD_WEB_PORT ?? '4310';
const authBaseUrl = process.env.BETTER_AUTH_URL ?? `http://${authBaseHost}:${authBasePort}`;
process.env.BETTER_AUTH_URL ??= authBaseUrl;

export function getAllowedBrowserOrigins(): string[] {
  return resolveAllowedBrowserOrigins({
    baseUrl: authBaseUrl,
    devPort: process.env.OVERLORD_WEB_DEV_PORT
  });
}

const authAdapter = resolveAdapter({ databasePath: DATABASE_PATH });
export const auth = createAuth({
  database:
    authAdapter.type === 'sqlite'
      ? { type: 'sqlite', path: authAdapter.path }
      : authAdapter.schema
        ? {
            type: 'postgres',
            connectionString: authAdapter.connectionString,
            schema: authAdapter.schema
          }
        : { type: 'postgres', connectionString: authAdapter.connectionString },
  trustedOrigins: getAllowedBrowserOrigins(),
  onDeleteUser: cascadeDeleteAccount,
  sendVerificationEmail: verificationEmailSenderFromEnv()
});
export const authNodeHandler = toNodeHandler(auth);

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token || null;
}

function usesNonBrowserAuthSurface(req: Request): boolean {
  const path = req.path || req.url || req.originalUrl;
  return (
    path === '/protocol' ||
    path.startsWith('/protocol/') ||
    path === '/runner' ||
    path.startsWith('/runner/')
  );
}

/** Whether the request originated from the loopback interface (the local host). */
function isLoopbackAddress(addr: string | null | undefined): boolean {
  if (!addr) return false;
  return addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.');
}

function isLoopbackRequest(req: Request): boolean {
  return isLoopbackAddress(req.ip) || isLoopbackAddress(req.socket?.remoteAddress);
}

/** Active scope grant patterns for a token (empty = `full`, no restriction). */
async function loadTokenScopeGrants(tokenId: string, workspaceId: string): Promise<string[]> {
  const rows = await requireDatabaseClient().all<{ permission: string }>(
    `SELECT permission FROM user_token_scopes
       WHERE token_id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [tokenId, workspaceId]
  );
  return rows.map(r => r.permission);
}

export interface WorkspaceMembership {
  workspaceUserId: string;
  workspace: ActiveWorkspace;
}

async function activeMembership(
  profileId: string,
  workspaceId: string
): Promise<{ id: string } | undefined> {
  return requireDatabaseClient().get<{ id: string }>(
    `SELECT id FROM workspace_users
       WHERE workspace_id = ? AND profile_id = ? AND status = 'active' AND deleted_at IS NULL
       LIMIT 1`,
    [workspaceId, profileId]
  );
}

async function profileIdForWorkspaceUser(workspaceUserId: string): Promise<string | null> {
  const row = await requireDatabaseClient().get<{ profile_id: string }>(
    `SELECT profile_id FROM workspace_users
       WHERE id = ? AND deleted_at IS NULL
       LIMIT 1`,
    [workspaceUserId]
  );
  return row?.profile_id ?? null;
}

async function resolveMembership(
  workspaceUserId: string,
  workspaceId: string
): Promise<WorkspaceMembership> {
  // Every active member keeps at least one role; this only ever creates a row
  // for a legacy/edge-case membership with none (see `grantWorkspaceAdminRole`),
  // it never re-grants ADMIN to a member who already has some role assigned.
  await grantWorkspaceAdminRole({ workspaceId, workspaceUserId });
  const workspace = await loadWorkspaceRow(workspaceId);
  if (!workspace) {
    throw new ApiError(500, 'Workspace membership references a missing workspace');
  }
  return {
    workspaceUserId,
    workspace: {
      id: workspace.id,
      slug: workspace.slug,
      name: workspace.name,
      kind: workspace.kind
    }
  };
}

/**
 * Resolve the logged-in profile's active workspace for this request. There is
 * no auto-join: a profile only ever resolves to workspaces it already has an
 * active `workspace_users` row in. Membership is created solely via an
 * explicit workspace creation or (future) invitation-acceptance flow.
 *
 * `requestedWorkspaceId` (from `ACTIVE_WORKSPACE_COOKIE`) lets a profile with
 * more than one membership pick which workspace this request targets; it must
 * match an active membership or the request is rejected with 403 — this is
 * the IDOR guard that stops a crafted workspace id from scoping a request to
 * a workspace the caller does not belong to. With no requested id, the
 * profile's oldest active membership is used as the default. Returns `null`
 * when the profile has no active workspace membership at all.
 */
export async function ensureWorkspaceUser(
  profileId: string,
  requestedWorkspaceId?: string | null
): Promise<WorkspaceMembership | null> {
  if (requestedWorkspaceId) {
    const membership = await activeMembership(profileId, requestedWorkspaceId);
    if (!membership) {
      throw new ApiError(403, 'Not an active member of the requested workspace');
    }
    return resolveMembership(membership.id, requestedWorkspaceId);
  }

  const defaultMembership = await requireDatabaseClient().get<{ id: string; workspace_id: string }>(
    `SELECT id, workspace_id FROM workspace_users
       WHERE profile_id = ? AND status = 'active' AND deleted_at IS NULL
       ORDER BY created_at ASC LIMIT 1`,
    [profileId]
  );
  if (!defaultMembership) return null;

  return resolveMembership(defaultMembership.id, defaultMembership.workspace_id);
}

export async function requireAuthenticatedSession(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  return withRequestContextAsync(async () => {
    setClientDeviceIdentity(clientDeviceFromRequest(req));
    try {
      const nonBrowser = usesNonBrowserAuthSurface(req);

      // 1. Browser session auth (Better Auth cookies). The CLI protocol/runner
      //    surface never carries cookies, so skip the session lookup for it.
      if (!nonBrowser) {
        const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
        if (session) {
          setActiveProfileId(session.user.id);
          // `null` means the profile has no active workspace membership at all
          // (e.g. a brand-new signup with no invite). The request proceeds
          // authenticated but with no active workspace; RBAC gates below
          // (`requirePermission`/`actorCan`) reject it uniformly since they
          // treat a null actor as having no roles. A mismatched
          // `requestedWorkspaceId` (the client asked for a workspace it isn't
          // a member of) throws `ApiError(403)` instead of falling through.
          const requestedWorkspaceId = getCookieValue(req, ACTIVE_WORKSPACE_COOKIE);
          const membership = await ensureWorkspaceUser(session.user.id, requestedWorkspaceId);
          if (membership) {
            setActiveWorkspaceContext(membership.workspace);
            setActiveWorkspaceUser(membership.workspaceUserId);
          } else {
            setActiveWorkspaceContext(null);
            setActiveWorkspaceUser(null);
          }
          next();
          return;
        }
      }

      // 2. USER_TOKEN bearer auth (any surface). Tokens are workspace-scoped
      //    (`user_tokens.workspace_id`), so the token itself resolves the
      //    tenant for this request — no global/default needed. Resolve the
      //    token's scope grants so the `requirePermission` gate can intersect
      //    them with the user's role.
      const bearerToken = extractBearerToken(req);
      if (bearerToken?.startsWith('out_')) {
        const tokenWorkspaceId = await resolveUserTokenWorkspaceId(
          authDomainDatabase(),
          bearerToken
        );
        const workspace = tokenWorkspaceId ? await loadWorkspaceRow(tokenWorkspaceId) : undefined;
        if (!tokenWorkspaceId || !workspace) {
          res.status(401).json({ error: 'Invalid or expired USER_TOKEN' });
          return;
        }
        const verified = await verifyUserToken(authDomainDatabase(), bearerToken, tokenWorkspaceId);
        if (!verified) {
          res.status(401).json({ error: 'Invalid or expired USER_TOKEN' });
          return;
        }
        setActiveWorkspaceContext({
          id: workspace.id,
          slug: workspace.slug,
          name: workspace.name,
          kind: workspace.kind
        });
        setActiveProfileId(await profileIdForWorkspaceUser(verified.workspaceUserId));
        const scopeGrants = await loadTokenScopeGrants(verified.id, tokenWorkspaceId);
        setActiveTokenAuth({
          workspaceUserId: verified.workspaceUserId,
          tokenId: verified.id,
          scopeGrants: scopeGrants.length > 0 ? scopeGrants : null
        });
        next();
        return;
      }

      // 3. Loopback-trusted local operator for the CLI protocol/runner surface,
      //    which historically ran unauthenticated on localhost. This resolves only
      //    to an existing workspace user in the process-wide default workspace
      //    (self-hosted single-operator parity); on a fresh database, account
      //    creation must happen first so RBAC has a real actor to evaluate.
      //    Browser `/api` routes deliberately do NOT get this fallback,
      //    preserving web login.
      if (nonBrowser && isLoopbackRequest(req)) {
        const workspaceUserId = await resolveActorForWorkspace(getActiveWorkspaceId());
        setActiveProfileId(
          workspaceUserId ? await profileIdForWorkspaceUser(workspaceUserId) : null
        );
        setActiveWorkspaceUser(workspaceUserId);
        next();
        return;
      }

      res.status(401).json({ error: 'Authentication required' });
    } catch (err) {
      next(err);
    }
  });
}
