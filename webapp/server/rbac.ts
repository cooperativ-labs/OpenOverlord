import { defaultAuthorizer, makeActor, Role, type Role as RoleType } from '@overlord/auth';

import { ACTOR_WORKSPACE_USER_ID, db, WORKSPACE } from './db.ts';
import { ApiError } from './errors.ts';

export function loadActorRoles({
  workspaceId = WORKSPACE.id,
  workspaceUserId = ACTOR_WORKSPACE_USER_ID
}: {
  workspaceId?: string;
  workspaceUserId?: string | null;
} = {}): RoleType[] {
  if (!workspaceUserId) return [];
  const rows = db
    .prepare(
      `SELECT role_key FROM role_assignments
         WHERE workspace_id = ? AND workspace_user_id = ? AND deleted_at IS NULL`
    )
    .all(workspaceId, workspaceUserId) as Array<{ role_key: string }>;
  return rows.map(row => row.role_key as RoleType);
}

export function actorIsAdmin({
  workspaceId = WORKSPACE.id,
  workspaceUserId = ACTOR_WORKSPACE_USER_ID
}: {
  workspaceId?: string;
  workspaceUserId?: string | null;
} = {}): boolean {
  const roles = loadActorRoles({ workspaceId, workspaceUserId });
  if (roles.length === 0) return false;
  const actor = makeActor(workspaceUserId ?? 'anonymous', roles);
  return defaultAuthorizer.can(actor, '*').allowed || roles.includes(Role.ADMIN);
}

export function requireAdmin(): void {
  if (!actorIsAdmin()) {
    throw new ApiError(403, 'Admin role required');
  }
}
