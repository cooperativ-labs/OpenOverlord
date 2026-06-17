import { createAuth } from '@overlord/auth';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import type { NextFunction, Request, Response } from 'express';

import {
  DATABASE_PATH,
  db,
  newId,
  nowIso,
  recordChange,
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

function usesNonBrowserAuthSurface(req: Request): boolean {
  const path = req.path || req.url || req.originalUrl;
  return (
    path === '/protocol' ||
    path.startsWith('/protocol/') ||
    path === '/runner' ||
    path.startsWith('/runner/')
  );
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
    if (usesNonBrowserAuthSurface(req)) {
      next();
      return;
    }

    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const workspaceUserId = ensureWorkspaceUser(session.user.id);
    setActiveWorkspaceUser(workspaceUserId);
    next();
  } catch (err) {
    next(err);
  }
}
