import { resolveAdapter } from '@overlord/database';
import { verifyUserToken } from '@overlord/auth';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import type { NextFunction, Request, Response } from 'express';

import { createAuth } from '../../auth/src/auth/config.ts';

import {
  authDomainDatabase,
  DATABASE_PATH,
  newId,
  nowIso,
  recordChange,
  resolveActorForWorkspace,
  requireDatabaseClient,
  setActiveTokenAuth,
  setActiveWorkspaceUser,
  withRequestContextAsync,
  WORKSPACE
} from './db.ts';
import { grantWorkspaceAdminRole } from './workspaces.ts';

const authBaseHost =
  process.env.OVERLORD_WEB_HOST && process.env.OVERLORD_WEB_HOST !== '0.0.0.0'
    ? process.env.OVERLORD_WEB_HOST
    : '127.0.0.1';
const authBasePort = process.env.OVERLORD_WEB_PORT ?? '4310';
const authBaseUrl = process.env.BETTER_AUTH_URL ?? `http://${authBaseHost}:${authBasePort}`;
process.env.BETTER_AUTH_URL ??= authBaseUrl;

function resolveAuthTrustedOrigins({
  baseUrl,
  devPort
}: {
  baseUrl: string;
  devPort: string | undefined;
}): string[] {
  const origins = new Set<string>([baseUrl]);
  const vitePort = devPort ?? '5173';
  // Vite dev server runs on a separate port; localhost and 127.0.0.1 are distinct origins.
  origins.add(`http://localhost:${vitePort}`);
  origins.add(`http://127.0.0.1:${vitePort}`);
  return [...origins];
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
  trustedOrigins: resolveAuthTrustedOrigins({
    baseUrl: authBaseUrl,
    devPort: process.env.OVERLORD_WEB_DEV_PORT
  })
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
async function loadTokenScopeGrants(tokenId: string): Promise<string[]> {
  const rows = await requireDatabaseClient().all<{ permission: string }>(
    `SELECT permission FROM user_token_scopes
       WHERE token_id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [tokenId, WORKSPACE.id]
  );
  return rows.map(r => r.permission);
}

async function ensureWorkspaceUser(profileId: string): Promise<string> {
  const client = requireDatabaseClient();
  const existing = await client.get<{ id: string }>(
    `SELECT id
       FROM workspace_users
      WHERE workspace_id = ?
        AND profile_id = ?
        AND status = 'active'
        AND deleted_at IS NULL
      LIMIT 1`,
    [WORKSPACE.id, profileId]
  );
  if (existing) {
    await grantWorkspaceAdminRole({
      workspaceId: WORKSPACE.id,
      workspaceUserId: existing.id
    });
    return existing.id;
  }

  const profile = await client.get<{ id: string }>(
    `SELECT id FROM profiles WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    [profileId]
  );
  if (!profile) {
    throw new Error('Authenticated user is missing an Overlord profile');
  }

  const now = nowIso();
  const workspaceUserId = newId();

  await client.transaction(async tx => {
    await tx.run(
      `INSERT INTO workspace_users
         (id, workspace_id, profile_id, member_key, status, metadata_json,
          created_at, updated_at, revision)
       VALUES
         (?, ?, ?, ?, 'active', '{}', ?, ?, 1)`,
      [workspaceUserId, WORKSPACE.id, profileId, `auth:${profileId}`, now, now]
    );

    await grantWorkspaceAdminRole({
      workspaceId: WORKSPACE.id,
      workspaceUserId,
      client: tx
    });

    await recordChange(
      {
        entityType: 'workspace_user',
        entityId: workspaceUserId,
        operation: 'insert',
        entityRevision: 1,
        actorWorkspaceUserId: workspaceUserId
      },
      tx
    );
  });

  return workspaceUserId;
}

export async function requireAuthenticatedSession(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  return withRequestContextAsync(async () => {
    try {
      const nonBrowser = usesNonBrowserAuthSurface(req);

      // 1. Browser session auth (Better Auth cookies). The CLI protocol/runner
      //    surface never carries cookies, so skip the session lookup for it.
      if (!nonBrowser) {
        const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
        if (session) {
          const workspaceUserId = await ensureWorkspaceUser(session.user.id);
          setActiveWorkspaceUser(workspaceUserId);
          next();
          return;
        }
      }

      // 2. USER_TOKEN bearer auth (any surface). Resolve the token's scope grants so
      //    the `requirePermission` gate can intersect them with the user's role.
      const bearerToken = extractBearerToken(req);
      if (bearerToken?.startsWith('out_')) {
        const verified = await verifyUserToken(authDomainDatabase(), bearerToken, WORKSPACE.id);
        if (!verified) {
          res.status(401).json({ error: 'Invalid or expired USER_TOKEN' });
          return;
        }
        const scopeGrants = await loadTokenScopeGrants(verified.id);
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
      //    to an existing workspace user; on a fresh database, account creation must
      //    happen first so RBAC has a real actor to evaluate. Browser `/api` routes
      //    deliberately do NOT get this fallback, preserving web login.
      if (nonBrowser && isLoopbackRequest(req)) {
        setActiveWorkspaceUser(await resolveActorForWorkspace(WORKSPACE.id));
        next();
        return;
      }

      res.status(401).json({ error: 'Authentication required' });
    } catch (err) {
      next(err);
    }
  });
}
