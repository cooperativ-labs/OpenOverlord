import {
  defaultAuthorizer,
  makeActor,
  type Permission,
  Role,
  type Role as RoleType,
  tokenScopeAllows
} from '@overlord/auth';

import {
  getActiveTokenScopes,
  getActorWorkspaceUserId,
  requireDatabaseClient,
  WORKSPACE
} from './db.ts';
import { ApiError } from './errors.ts';

export async function loadActorRoles({
  workspaceId = WORKSPACE.id,
  workspaceUserId = getActorWorkspaceUserId()
}: {
  workspaceId?: string;
  workspaceUserId?: string | null;
} = {}): Promise<RoleType[]> {
  if (!workspaceUserId) return [];
  const rows = await requireDatabaseClient().all<{ role_key: string }>(
    `SELECT role_key FROM role_assignments
       WHERE workspace_id = ? AND workspace_user_id = ? AND deleted_at IS NULL`,
    [workspaceId, workspaceUserId]
  );
  return rows.map(row => row.role_key as RoleType);
}

export async function actorIsAdmin({
  workspaceId = WORKSPACE.id,
  workspaceUserId = getActorWorkspaceUserId()
}: {
  workspaceId?: string;
  workspaceUserId?: string | null;
} = {}): Promise<boolean> {
  const roles = await loadActorRoles({ workspaceId, workspaceUserId });
  if (roles.length === 0) return false;
  const actor = makeActor(workspaceUserId ?? 'anonymous', roles);
  return defaultAuthorizer.can(actor, '*').allowed || roles.includes(Role.ADMIN);
}

export async function requireAdmin(): Promise<void> {
  if (!(await actorIsAdmin())) {
    throw new ApiError(403, 'Admin role required');
  }
}

/**
 * Whether the current request's actor may perform `action`. The decision is the
 * actor's role grants **intersected with** the authenticating token's scope
 * (`getActiveTokenScopes()`): a session or loopback-trusted operator has `null`
 * scopes (role grants only), while a scoped `USER_TOKEN` is further restricted to
 * its grant patterns. Returns `true`/`false`; callers needing a hard gate use
 * `requirePermission`.
 */
export async function actorCan(
  action: Permission,
  {
    workspaceId = WORKSPACE.id,
    workspaceUserId = getActorWorkspaceUserId(),
    tokenScopes = getActiveTokenScopes()
  }: {
    workspaceId?: string;
    workspaceUserId?: string | null;
    tokenScopes?: string[] | null;
  } = {}
): Promise<boolean> {
  if (!workspaceUserId) return false;
  const roles = await loadActorRoles({ workspaceId, workspaceUserId });
  if (roles.length === 0) return false;
  const actor = makeActor(workspaceUserId, roles);
  return defaultAuthorizer.can(actor, action).allowed && tokenScopeAllows(tokenScopes, action);
}

/**
 * Hard RBAC gate for a route/handler. Throws `ApiError(403)` when the current
 * actor (resolved from the request's auth method) cannot perform `action`,
 * accounting for both role grants and any token scope restriction.
 */
export async function requirePermission(action: Permission): Promise<void> {
  if (!(await actorCan(action))) {
    throw new ApiError(403, `Permission denied: ${action}`);
  }
}
