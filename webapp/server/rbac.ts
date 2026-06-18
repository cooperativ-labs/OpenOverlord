import {
  defaultAuthorizer,
  makeActor,
  type Permission,
  Role,
  type Role as RoleType,
  tokenScopeAllows
} from '@overlord/auth';

import { ACTIVE_TOKEN_SCOPES, ACTOR_WORKSPACE_USER_ID, db, WORKSPACE } from './db.ts';
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

/**
 * Whether the current request's actor may perform `action`. The decision is the
 * actor's role grants **intersected with** the authenticating token's scope
 * (`ACTIVE_TOKEN_SCOPES`): a session or loopback-trusted operator has `null`
 * scopes (role grants only), while a scoped `USER_TOKEN` is further restricted to
 * its grant patterns. Returns `true`/`false`; callers needing a hard gate use
 * `requirePermission`.
 */
export function actorCan(
  action: Permission,
  {
    workspaceId = WORKSPACE.id,
    workspaceUserId = ACTOR_WORKSPACE_USER_ID,
    tokenScopes = ACTIVE_TOKEN_SCOPES
  }: {
    workspaceId?: string;
    workspaceUserId?: string | null;
    tokenScopes?: string[] | null;
  } = {}
): boolean {
  if (!workspaceUserId) return false;
  const roles = loadActorRoles({ workspaceId, workspaceUserId });
  if (roles.length === 0) return false;
  const actor = makeActor(workspaceUserId, roles);
  return defaultAuthorizer.can(actor, action).allowed && tokenScopeAllows(tokenScopes, action);
}

/**
 * Hard RBAC gate for a route/handler. Throws `ApiError(403)` when the current
 * actor (resolved from the request's auth method) cannot perform `action`,
 * accounting for both role grants and any token scope restriction.
 */
export function requirePermission(action: Permission): void {
  if (!actorCan(action)) {
    throw new ApiError(403, `Permission denied: ${action}`);
  }
}
