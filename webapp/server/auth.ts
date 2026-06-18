import { createAuth, verifyUserToken } from '@overlord/auth';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import type { NextFunction, Request, Response } from 'express';

import {
  DATABASE_PATH,
  db,
  newId,
  nowIso,
  recordChange,
  resolveActorForWorkspace,
  setActiveTokenAuth,
  setActiveWorkspaceUser,
  WORKSPACE
} from './db.ts';

const authBaseHost =
  process.env.OVERLORD_WEB_HOST && process.env.OVERLORD_WEB_HOST !== '0.0.0.0'
    ? process.env.OVERLORD_WEB_HOST
    : '127.0.0.1';
const authBasePort = process.env.OVERLORD_WEB_PORT ?? '4310';
process.env.BETTER_AUTH_URL ??= `http://${authBaseHost}:${authBasePort}`;

export const auth = createAuth(DATABASE_PATH);
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
function loadTokenScopeGrants(tokenId: string): string[] {
  const rows = db
    .prepare(
      `SELECT permission FROM user_token_scopes
         WHERE token_id = ? AND workspace_id = ? AND deleted_at IS NULL`
    )
    .all(tokenId, WORKSPACE.id) as Array<{ permission: string }>;
  return rows.map(r => r.permission);
}

function ensureWorkspaceUser(profileId: string): string {
  const existing = db
    .prepare(
      `SELECT id
         FROM workspace_users
        WHERE workspace_id = ?
          AND profile_id = ?
          AND status = 'active'
          AND deleted_at IS NULL
        LIMIT 1`
    )
    .get(WORKSPACE.id, profileId) as { id: string } | undefined;
  if (existing) return existing.id;

  const profile = db
    .prepare(`SELECT id FROM profiles WHERE id = ? AND deleted_at IS NULL LIMIT 1`)
    .get(profileId) as { id: string } | undefined;
  if (!profile) {
    throw new Error('Authenticated user is missing an Overlord profile');
  }

  const now = nowIso();
  const workspaceUserId = newId();
  const roleAssignmentId = newId();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO workspace_users
         (id, workspace_id, profile_id, member_key, status, metadata_json,
          created_at, updated_at, revision)
       VALUES
         (@id, @workspace_id, @profile_id, @member_key, 'active', '{}',
          @now, @now, 1)`
    ).run({
      id: workspaceUserId,
      workspace_id: WORKSPACE.id,
      profile_id: profileId,
      member_key: `auth:${profileId}`,
      now
    });

    db.prepare(
      `INSERT INTO role_assignments
         (id, workspace_id, workspace_user_id, role_key, resource_type, resource_id,
          assigned_by_workspace_user_id, created_at, updated_at, revision)
       VALUES
         (@id, @workspace_id, @workspace_user_id, 'ADMIN', '', '',
          @workspace_user_id, @now, @now, 1)`
    ).run({
      id: roleAssignmentId,
      workspace_id: WORKSPACE.id,
      workspace_user_id: workspaceUserId,
      now
    });

    recordChange({
      entityType: 'workspace_user',
      entityId: workspaceUserId,
      operation: 'insert',
      entityRevision: 1,
      actorWorkspaceUserId: workspaceUserId
    });
  })();

  return workspaceUserId;
}

export async function requireAuthenticatedSession(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const nonBrowser = usesNonBrowserAuthSurface(req);

    // 1. Browser session auth (Better Auth cookies). The CLI protocol/runner
    //    surface never carries cookies, so skip the session lookup for it.
    if (!nonBrowser) {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (session) {
        const workspaceUserId = ensureWorkspaceUser(session.user.id);
        setActiveWorkspaceUser(workspaceUserId);
        next();
        return;
      }
    }

    // 2. USER_TOKEN bearer auth (any surface). Resolve the token's scope grants so
    //    the `requirePermission` gate can intersect them with the user's role.
    const bearerToken = extractBearerToken(req);
    if (bearerToken?.startsWith('out_')) {
      const verified = await verifyUserToken(db, bearerToken, WORKSPACE.id);
      if (!verified) {
        res.status(401).json({ error: 'Invalid or expired USER_TOKEN' });
        return;
      }
      const scopeGrants = loadTokenScopeGrants(verified.id);
      setActiveTokenAuth({
        workspaceUserId: verified.workspaceUserId,
        tokenId: verified.id,
        scopeGrants: scopeGrants.length > 0 ? scopeGrants : null
      });
      next();
      return;
    }

    // 3. Loopback-trusted local operator for the CLI protocol/runner surface,
    //    which historically ran unauthenticated on localhost. The audit threat
    //    model is a leaked token, not localhost, so a tokenless loopback CLI keeps
    //    the single-trusted-user behavior — but now flows through actor resolution
    //    so RBAC gates still apply (the local operator is ADMIN). Browser `/api`
    //    routes deliberately do NOT get this fallback, preserving web login.
    if (nonBrowser && isLoopbackRequest(req)) {
      setActiveWorkspaceUser(resolveActorForWorkspace(WORKSPACE.id));
      next();
      return;
    }

    res.status(401).json({ error: 'Authentication required' });
  } catch (err) {
    next(err);
  }
}
