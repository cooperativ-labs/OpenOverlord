import {
  defaultAuthorizer,
  makeActor,
  type Permission,
  Role,
  type Role as RoleType,
  tokenScopeAllows
} from '@overlord/auth';
import { type DatabaseClient } from '@overlord/database';

import {
  findActiveMembershipId,
  getActiveTokenScopes,
  getActiveWorkspaceId,
  requireDatabaseClient,
  resolveActiveProfileId,
  type WorkspaceActorScope
} from './db.ts';
import { ApiError } from './errors.ts';

export async function loadActorRoles({
  workspaceId,
  workspaceUserId
}: {
  workspaceId: string;
  workspaceUserId?: string | null;
}): Promise<RoleType[]> {
  if (!workspaceUserId) return [];
  const rows = await requireDatabaseClient().all<{ role_key: string }>(
    `SELECT role_key FROM role_assignments
       WHERE workspace_id = ? AND workspace_user_id = ? AND deleted_at IS NULL`,
    [workspaceId, workspaceUserId]
  );
  return rows.map(row => row.role_key as RoleType);
}

export async function actorIsAdmin({
  workspaceId,
  workspaceUserId
}: {
  workspaceId: string;
  workspaceUserId?: string | null;
}): Promise<boolean> {
  const roles = await loadActorRoles({ workspaceId, workspaceUserId });
  if (roles.length === 0) return false;
  const actor = makeActor(workspaceUserId ?? 'anonymous', roles);
  return defaultAuthorizer.can(actor, '*').allowed || roles.includes(Role.ADMIN);
}

export async function requireAdmin({
  workspaceId,
  workspaceUserId
}: {
  workspaceId: string;
  workspaceUserId?: string | null;
}): Promise<void> {
  if (!(await actorIsAdmin({ workspaceId, workspaceUserId }))) {
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
    workspaceId,
    workspaceUserId,
    tokenScopes = getActiveTokenScopes()
  }: {
    workspaceId: string;
    workspaceUserId?: string | null;
    tokenScopes?: string[] | null;
  }
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
export async function requirePermission(
  action: Permission,
  scope: { workspaceId: string; workspaceUserId?: string | null }
): Promise<void> {
  if (!(await actorCan(action, scope))) {
    throw new ApiError(403, `Permission denied: ${action}`);
  }
}

/**
 * Per-target-workspace gate (coo:96/coo:135 pattern): the caller must be an
 * active member of `workspaceId` — independent of which workspace is currently
 * active — and hold `permission` there. Returns the caller's membership id in
 * that workspace. Non-membership reads as `notFoundMessage` (404) so foreign
 * workspace/resource ids don't leak existence; permission denial inside a real
 * membership is an honest 403.
 */
export async function requireWorkspacePermission({
  workspaceId,
  permission,
  db = requireDatabaseClient(),
  notFoundMessage = 'Workspace not found'
}: {
  workspaceId: string;
  permission: Permission;
  db?: DatabaseClient;
  notFoundMessage?: string;
}): Promise<string> {
  const profileId = await resolveActiveProfileId(db);
  if (!profileId) throw new ApiError(401, 'Authentication required');
  const membershipId = await findActiveMembershipId(workspaceId, profileId, db);
  if (!membershipId) throw new ApiError(404, notFoundMessage);
  if (!(await actorCan(permission, { workspaceId, workspaceUserId: membershipId }))) {
    throw new ApiError(403, `Permission denied: ${permission}`);
  }
  return membershipId;
}

export type AuthorizedWorkspaceScope = WorkspaceActorScope & { workspaceUserId: string };

/** Resolve and authorize a workspace together with the caller membership that belongs to it. */
export async function requireWorkspaceScope(args: {
  workspaceId: string;
  permission: Permission;
  db?: DatabaseClient;
  notFoundMessage?: string;
}): Promise<AuthorizedWorkspaceScope> {
  const workspaceUserId = await requireWorkspacePermission(args);
  return { workspaceId: args.workspaceId, workspaceUserId };
}

/**
 * Resolves a project to its owning workspace and checks `permission` there via
 * `requireWorkspacePermission`, so a project in a secondary workspace resolves
 * even when a different workspace is active (coo:135).
 */
export async function requireProjectPermission({
  projectId,
  permission,
  db = requireDatabaseClient()
}: {
  projectId: string;
  permission: Permission;
  db?: DatabaseClient;
}): Promise<AuthorizedWorkspaceScope> {
  const project = (await db.get(
    `SELECT workspace_id FROM projects WHERE id = ? AND deleted_at IS NULL`,
    [projectId]
  )) as { workspace_id: string } | undefined;
  if (!project) throw new ApiError(404, 'Project not found');
  return requireWorkspaceScope({
    workspaceId: project.workspace_id,
    permission,
    db,
    notFoundMessage: 'Project not found'
  });
}

/** Resolve a mission's owning workspace and authorize it there, independent of
 * the caller's active workspace. */
export async function requireMissionPermission({
  missionRef,
  permission,
  db = requireDatabaseClient()
}: {
  missionRef: string;
  permission: Permission;
  db?: DatabaseClient;
}): Promise<AuthorizedWorkspaceScope & { missionId: string }> {
  const mission = (await db.get(
    `SELECT id, workspace_id FROM missions WHERE id = ? AND deleted_at IS NULL`,
    [missionRef]
  )) as { id: string; workspace_id: string } | undefined;
  const resolved =
    mission ??
    ((await db.get(
      `SELECT id, workspace_id FROM missions
        WHERE display_id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      [missionRef, getActiveWorkspaceId()]
    )) as { id: string; workspace_id: string } | undefined);
  if (!resolved) throw new ApiError(404, 'Mission not found');
  const scope = await requireWorkspaceScope({
    workspaceId: resolved.workspace_id,
    permission,
    db,
    notFoundMessage: 'Mission not found'
  });
  return { ...scope, missionId: resolved.id };
}

// ---- Organization admin (derived, not a stored role) ----------------------
//
// "Organization admin" has no row of its own: it is ADMIN of every live
// constituent workspace of the organization (Q2 in
// planning/feature-plans/organization-workspace-hierarchy.md). Any workspace
// admin may *view* org settings; only a full org admin may mutate them —
// otherwise a single-workspace ADMIN could add themselves as org admin and
// escalate to every workspace in the org (R1).

/** Ids of an organization's live (non-deleted) constituent workspaces. */
export async function liveOrganizationWorkspaceIds(
  organizationId: string,
  client: DatabaseClient
): Promise<string[]> {
  const rows = await client.all<{ id: string }>(
    `SELECT id FROM workspaces WHERE organization_id = ? AND deleted_at IS NULL`,
    [organizationId]
  );
  return rows.map(row => row.id);
}

async function profileIsWorkspaceAdmin(
  profileId: string,
  workspaceId: string,
  client: DatabaseClient
): Promise<boolean> {
  const row = await client.get<{ id: string }>(
    `SELECT ra.id
       FROM workspace_users wu
       JOIN role_assignments ra
         ON ra.workspace_id = wu.workspace_id AND ra.workspace_user_id = wu.id
        AND ra.role_key = 'ADMIN' AND ra.deleted_at IS NULL
      WHERE wu.workspace_id = ? AND wu.profile_id = ?
        AND wu.status = 'active' AND wu.deleted_at IS NULL
      LIMIT 1`,
    [workspaceId, profileId]
  );
  return !!row;
}

/**
 * Whether `profileId` is an "organization admin" of `organizationId`: an
 * active `ADMIN` role assignment in **every** live constituent workspace.
 * `false` for an organization with zero live workspaces (it should already be
 * gone — see `deleteOrganizationIfEmpty`).
 */
export async function isOrganizationAdmin(
  profileId: string,
  organizationId: string,
  client: DatabaseClient = requireDatabaseClient()
): Promise<boolean> {
  const workspaceIds = await liveOrganizationWorkspaceIds(organizationId, client);
  if (workspaceIds.length === 0) return false;
  for (const workspaceId of workspaceIds) {
    if (!(await profileIsWorkspaceAdmin(profileId, workspaceId, client))) return false;
  }
  return true;
}

/**
 * Whether `profileId` may *view* `organizationId`'s settings: an active
 * `ADMIN` role assignment in at least one live constituent workspace. Viewing
 * is intentionally broader than mutating (`isOrganizationAdmin`) so a
 * partial-admin state (an artifact of a bug, or an org mid-repair) is still
 * visible to someone who can help fix it.
 */
export async function canViewOrganizationSettings(
  profileId: string,
  organizationId: string,
  client: DatabaseClient = requireDatabaseClient()
): Promise<boolean> {
  const workspaceIds = await liveOrganizationWorkspaceIds(organizationId, client);
  for (const workspaceId of workspaceIds) {
    if (await profileIsWorkspaceAdmin(profileId, workspaceId, client)) return true;
  }
  return false;
}

/**
 * The full set of "organization admins" of `organizationId`: profile ids with
 * an active `ADMIN` role assignment in **every** live constituent workspace.
 * Shared by `backend/organizations.ts` (listing/adding/removing org admins)
 * and `backend/workspaces.ts` (auto-granting `ADMIN` to every current org
 * admin when a new workspace is created under the org, Q3) so both stay
 * derived from the same invariant instead of drifting.
 */
export async function listOrganizationAdminProfileIds(
  organizationId: string,
  client: DatabaseClient = requireDatabaseClient()
): Promise<string[]> {
  const rows = await client.all<{ profile_id: string }>(
    `SELECT wu.profile_id
       FROM workspace_users wu
       JOIN role_assignments ra
         ON ra.workspace_id = wu.workspace_id AND ra.workspace_user_id = wu.id
        AND ra.role_key = 'ADMIN' AND ra.deleted_at IS NULL
       JOIN workspaces w ON w.id = wu.workspace_id AND w.deleted_at IS NULL
      WHERE w.organization_id = ? AND wu.status = 'active' AND wu.deleted_at IS NULL
      GROUP BY wu.profile_id
     HAVING COUNT(DISTINCT wu.workspace_id) = (
       SELECT COUNT(*) FROM workspaces WHERE organization_id = ? AND deleted_at IS NULL
     )`,
    [organizationId, organizationId]
  );
  return rows.map(row => row.profile_id);
}
