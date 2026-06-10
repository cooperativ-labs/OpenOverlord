import { makeActor } from '../rbac/authorizer.js';
import type { Actor, Role } from '../rbac/types.js';

import type { Auth } from './config.js';
import { type AuthDomainDatabase, queryAll, queryOne } from './database.js';

/**
 * Resolve a Better Auth session token to an Overlord Actor.
 *
 * Validates the session via Better Auth (bearer plugin extracts the token from
 * the Authorization header), then bridges to the Overlord identity model:
 *   Better Auth user.id  →  users.external_subject (auth_provider = 'better-auth')
 *                        →  workspace_users.id
 *                        →  role_assignments (active, workspace-scoped)
 *
 * Returns null when the session is invalid, expired, or the Better Auth user is
 * not linked to a workspace_user in workspaceId.
 */
export async function getActorForSession(
  auth: Auth,
  db: AuthDomainDatabase,
  sessionToken: string,
  workspaceId: string
): Promise<Actor | null> {
  const headers = new Headers({ authorization: `Bearer ${sessionToken}` });
  const result = await auth.api.getSession({ headers });
  if (!result) return null;

  const baUserId = result.user.id;

  const row = await queryOne<{ workspace_user_id: string }>(
    db,
    `SELECT wu.id AS workspace_user_id
     FROM workspace_users wu
     JOIN users u ON u.id = wu.user_id
     WHERE u.auth_provider = 'better-auth'
       AND u.external_subject = ?
       AND wu.workspace_id = ?
       AND wu.status = 'active'
       AND u.deleted_at IS NULL
       AND wu.deleted_at IS NULL
     LIMIT 1`,
    [baUserId, workspaceId]
  );

  if (!row) return null;

  const roleRows = await queryAll<{ role_key: string }>(
    db,
    `SELECT role_key
     FROM role_assignments
     WHERE workspace_user_id = ?
       AND workspace_id = ?
       AND deleted_at IS NULL`,
    [row.workspace_user_id, workspaceId]
  );

  const roles = roleRows.map(r => r.role_key as Role);
  return makeActor(row.workspace_user_id, roles);
}
