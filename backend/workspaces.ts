import { bindBool, type DatabaseClient, DEFAULT_STATUSES } from '@overlord/database';
import { createHash, randomBytes } from 'node:crypto';

import type {
  AcceptWorkspaceInvitationBody,
  CreateOrganizationOnboardingBody,
  CreateWorkspaceBody,
  InviteWorkspaceMemberBody,
  InviteWorkspaceMemberResultDto,
  UpdateWorkspaceBody,
  UpdateWorkspaceMemberRoleBody,
  WorkspaceDto,
  WorkspaceInvitationDto,
  WorkspaceMemberDto
} from '../webapp/shared/contract.ts';

import { syncSqlStudioForWorkspace } from './sql-studio/sql-studio-manager.ts';
import {
  findActiveMembershipId,
  getActiveProfileId,
  getActiveWorkspaceIdOrNull,
  getActorWorkspaceUserId,
  newId,
  nowIso,
  recordChange,
  reloadActiveWorkspace,
  requireDatabaseClient,
  resolveActiveProfileId,
  resolveActorForWorkspace,
  setActiveWorkspace,
  setActiveWorkspaceContext,
  setActiveWorkspaceUser
} from './db.ts';
import { invitationEmailSenderFromEnv, inviteAcceptUrl } from './email-invitation.ts';
import { ApiError } from './errors.ts';
import { deleteOrganizationIfEmpty } from './organizations.ts';
import { actorIsAdmin, isOrganizationAdmin, listOrganizationAdminProfileIds } from './rbac.ts';
import {
  readSqlStudioEnabled,
  sqlStudioEnabledFromSettingsJson,
  writeSqlStudioEnabled
} from './workspace-settings.ts';

// ---- row shapes ----------------------------------------------------------

interface WorkspaceListRow {
  id: string;
  organization_id: string;
  slug: string;
  name: string;
  kind: string;
  created_at: string;
  settings_json: string;
  project_count: number;
  member_count: number;
}

function toWorkspaceDto(r: WorkspaceListRow): WorkspaceDto {
  return {
    id: r.id,
    organizationId: r.organization_id,
    slug: r.slug,
    name: r.name,
    kind: r.kind,
    isActive: r.id === getActiveWorkspaceIdOrNull(),
    projectCount: r.project_count,
    memberCount: r.member_count,
    sqlStudioEnabled: sqlStudioEnabledFromSettingsJson(r.settings_json),
    createdAt: r.created_at
  };
}

function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_WORKSPACE_SLUG_LENGTH);
  return base.length > 0 ? base : 'workspace';
}

const MAX_WORKSPACE_SLUG_LENGTH = 48;

/** First three letters of the name as a slug, matching the onboarding UI's hint. */
function suggestSlugFromName(name: string): string {
  const letters = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 3);
  return letters.length > 0 ? letters : 'workspace';
}

/**
 * Workspace slugs are unique **per organization** (`idx_workspaces_organization_slug`),
 * not instance-wide — different organizations may reuse the same slug. Append a
 * numeric suffix until a free slug is found within the organization so creation
 * never trips the constraint. `excludeWorkspaceId` is unused today (workspaces
 * no longer support re-slugging) but kept for symmetry with the uniqueness
 * check callers might want against a specific row in the future.
 */
async function uniqueWorkspaceSlug({
  desired,
  organizationId,
  excludeWorkspaceId,
  client = requireDatabaseClient()
}: {
  desired: string;
  organizationId: string;
  excludeWorkspaceId?: string;
  client?: DatabaseClient;
}): Promise<string> {
  const taken = (
    excludeWorkspaceId
      ? await client.all<{ slug: string }>(
          `SELECT slug FROM workspaces WHERE organization_id = ? AND id <> ?`,
          [organizationId, excludeWorkspaceId]
        )
      : await client.all<{ slug: string }>(
          `SELECT slug FROM workspaces WHERE organization_id = ?`,
          [organizationId]
        )
  ).map(r => r.slug);
  const set = new Set(taken);
  if (!set.has(desired)) return desired;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const base = desired.slice(0, MAX_WORKSPACE_SLUG_LENGTH - suffix.length);
    const candidate = `${base}${suffix}`;
    if (!set.has(candidate)) return candidate;
  }
}

/**
 * The profile acting in this request: the authenticated session/token profile,
 * else the profile behind the currently-attributed workspace_user, else (the
 * single-operator bootstrap path, where nothing is authenticated yet) the
 * oldest active human profile in the database.
 */
async function resolveCurrentProfileId(
  client: DatabaseClient = requireDatabaseClient()
): Promise<string> {
  const resolved = await resolveActiveProfileId(client);
  if (resolved) return resolved;
  const fallback = await client.get<{ id: string }>(
    `SELECT id FROM profiles
       WHERE kind = 'human' AND status = 'active' AND deleted_at IS NULL
       ORDER BY created_at ASC LIMIT 1`
  );
  if (!fallback) throw new ApiError(409, 'No local user profile exists');
  return fallback.id;
}

/**
 * Require the calling profile to be an active member of `workspaceId` and
 * return their workspace_user id there. Non-members get the same 404 as a
 * nonexistent workspace so probing ids can't reveal which workspaces exist.
 * This is the tenancy gate every workspace-scoped operation that takes a
 * workspace id from the client must pass first — the route-level RBAC gate
 * only checks roles in the caller's *active* workspace, not the target.
 */
async function requireWorkspaceMember(workspaceId: string): Promise<string> {
  const membershipId = await findActiveMembershipId(workspaceId, await resolveCurrentProfileId());
  if (!membershipId) {
    throw new ApiError(404, 'Workspace not found or no active membership');
  }
  return membershipId;
}

/** `requireWorkspaceMember`, plus an ADMIN role in that workspace. */
async function requireWorkspaceAdmin(workspaceId: string): Promise<void> {
  const workspaceUserId = await requireWorkspaceMember(workspaceId);
  if (!(await actorIsAdmin({ workspaceId, workspaceUserId }))) {
    throw new ApiError(403, 'Admin role required');
  }
}

/**
 * `requireWorkspaceMember`, plus an ADMIN or MANAGER role in that workspace.
 * Returns whether the actor is a full ADMIN so callers can enforce MANAGER's
 * cap: a MANAGER may neither grant ADMIN nor demote/remove an existing ADMIN
 * (R6) — every call site below that grants/changes/removes a role checks
 * `isAdmin` itself; this helper only gates "may manage members/settings at
 * all".
 */
async function requireWorkspaceManager(
  workspaceId: string
): Promise<{ workspaceUserId: string; isAdmin: boolean }> {
  const workspaceUserId = await requireWorkspaceMember(workspaceId);
  const roleKeys = await listMemberRoleKeys({ workspaceId, workspaceUserId });
  const isAdmin = roleKeys.includes('ADMIN');
  if (!isAdmin && !roleKeys.includes('MANAGER')) {
    throw new ApiError(403, 'Manager role required');
  }
  return { workspaceUserId, isAdmin };
}

function csvCell(value: string | null | undefined): string {
  return `"${(value ?? '').replaceAll('"', '""')}"`;
}

export interface WorkspaceObjectivesCsvExport {
  filename: string;
  content: string;
}

/** Grant workspace-level ADMIN when a member has no active role rows yet. */
export async function grantWorkspaceAdminRole({
  workspaceId,
  workspaceUserId,
  assignedByWorkspaceUserId = workspaceUserId,
  client = requireDatabaseClient()
}: {
  workspaceId: string;
  workspaceUserId: string;
  assignedByWorkspaceUserId?: string;
  client?: DatabaseClient;
}): Promise<void> {
  const existing = await client.get(
    `SELECT 1 FROM role_assignments
       WHERE workspace_id = ? AND workspace_user_id = ? AND deleted_at IS NULL
       LIMIT 1`,
    [workspaceId, workspaceUserId]
  );
  if (existing) return;

  const now = nowIso();
  await client.run(
    `INSERT INTO role_assignments
       (id, workspace_id, workspace_user_id, role_key, resource_type, resource_id,
        assigned_by_workspace_user_id, created_at, updated_at, revision)
     VALUES
       (?, ?, ?, 'ADMIN', '', '',
        ?, ?, ?, 1)`,
    [newId(), workspaceId, workspaceUserId, assignedByWorkspaceUserId, now, now]
  );
}

// ---- operations ----------------------------------------------------------

const WORKSPACE_LIST_COLUMNS = `
  w.id, w.organization_id, w.slug, w.name, w.kind, w.created_at, w.settings_json,
  (SELECT COUNT(*) FROM projects p
     WHERE p.workspace_id = w.id AND p.deleted_at IS NULL) AS project_count,
  (SELECT COUNT(*) FROM workspace_users m
     WHERE m.workspace_id = w.id AND m.status = 'active'
       AND m.deleted_at IS NULL) AS member_count
`;

/** Every workspace the local operator is an active member of, across every organization. */
export async function listWorkspaces(): Promise<WorkspaceDto[]> {
  const localUserId = await resolveCurrentProfileId();
  const rows = await requireDatabaseClient().all<WorkspaceListRow>(
    `SELECT ${WORKSPACE_LIST_COLUMNS}
       FROM workspaces w
       JOIN workspace_users wu
         ON wu.workspace_id = w.id AND wu.profile_id = ?
        AND wu.status = 'active' AND wu.deleted_at IS NULL
      WHERE w.deleted_at IS NULL
      ORDER BY w.created_at ASC`,
    [localUserId]
  );
  return rows.map(toWorkspaceDto);
}

/**
 * Every workspace of `organizationId` the local operator is an active member
 * of. Used by `/api/meta` (the sidebar renders every accessible workspace of
 * the active organization at once) and by onboarding.
 */
export async function listWorkspacesForOrganization(
  organizationId: string
): Promise<WorkspaceDto[]> {
  const localUserId = await resolveCurrentProfileId();
  const rows = await requireDatabaseClient().all<WorkspaceListRow>(
    `SELECT ${WORKSPACE_LIST_COLUMNS}
       FROM workspaces w
       JOIN workspace_users wu
         ON wu.workspace_id = w.id AND wu.profile_id = ?
        AND wu.status = 'active' AND wu.deleted_at IS NULL
      WHERE w.organization_id = ? AND w.deleted_at IS NULL
      ORDER BY w.created_at ASC`,
    [localUserId, organizationId]
  );
  return rows.map(toWorkspaceDto);
}

/** Seed the workspace-level card statuses every new workspace starts with. */
async function seedWorkspaceStatuses({
  workspaceId,
  now,
  client
}: {
  workspaceId: string;
  now: string;
  client: DatabaseClient;
}): Promise<void> {
  for (const status of DEFAULT_STATUSES) {
    await client.run(
      `INSERT INTO workspace_statuses
         (id, workspace_id, key, name, type, position, is_default, is_terminal,
          created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, 1)`,
      [
        newId(),
        workspaceId,
        status.key,
        status.name,
        status.type,
        status.position,
        bindBool(client.dialect, status.isDefault),
        bindBool(client.dialect, status.isTerminal),
        now,
        now
      ]
    );
  }
}

/**
 * Provision the workspace's logical storage locations. Object keys carry the
 * canonical `user-images/<user-id>` and `workspace-files/<workspace-id>` path,
 * so local buckets share the storage root while RBAC stays workspace-scoped.
 */
async function seedWorkspaceStorageBuckets({
  workspaceId,
  createdByWorkspaceUserId,
  now,
  client
}: {
  workspaceId: string;
  createdByWorkspaceUserId: string;
  now: string;
  client: DatabaseClient;
}): Promise<void> {
  for (const bucketKey of ['workspace-images', 'user-images', 'attachments']) {
    await client.run(
      `INSERT INTO storage_buckets (
         id, workspace_id, bucket_key, storage_backend, base_url, local_path, settings_json,
         created_by_workspace_user_id, created_at, updated_at, revision
       ) VALUES (?, ?, ?, 'local_fs', NULL, 'database/.local/storage', '{}', ?, ?, ?, 1)`,
      [newId(), workspaceId, bucketKey, createdByWorkspaceUserId, now, now]
    );
  }
}

/**
 * Provision the organization's `organization-images` bucket. An organization
 * logo must outlive any single member workspace, so it lives in its own
 * bucket rather than a workspace's (R5) — created once, at organization
 * creation time (onboarding); never re-created by `createWorkspace`.
 */
async function seedOrganizationStorageBucket({
  organizationId,
  createdByWorkspaceUserId,
  now,
  client
}: {
  organizationId: string;
  createdByWorkspaceUserId: string;
  now: string;
  client: DatabaseClient;
}): Promise<void> {
  await client.run(
    `INSERT INTO storage_buckets (
       id, organization_id, bucket_key, storage_backend, base_url, local_path, settings_json,
       created_by_workspace_user_id, created_at, updated_at, revision
     ) VALUES (?, ?, 'organization-images', 'local_fs', NULL, 'database/.local/storage', '{}', ?, ?, ?, 1)`,
    [newId(), organizationId, createdByWorkspaceUserId, now, now]
  );
}

/**
 * Create a workspace under an existing organization. Org-admin gated (Q3):
 * only an admin of every constituent workspace may add another. Every
 * *current* org admin is auto-granted ADMIN in the new workspace (joining
 * them to it if needed) so the org-admin invariant survives creation.
 */
export async function createWorkspace(body: CreateWorkspaceBody): Promise<WorkspaceDto> {
  const creatorProfileId = await resolveCurrentProfileId();
  const organizationId = (body.organizationId ?? '').trim();
  if (!organizationId) throw new ApiError(400, 'organizationId is required');
  if (!(await isOrganizationAdmin(creatorProfileId, organizationId))) {
    throw new ApiError(403, 'Organization admin required');
  }

  const workspaceId = await requireDatabaseClient().transaction(async tx => {
    const name = (body.name ?? '').trim();
    if (!name) throw new ApiError(400, 'Workspace name is required');

    const organization = await tx.get<{ id: string }>(
      `SELECT id FROM organizations WHERE id = ? AND deleted_at IS NULL`,
      [organizationId]
    );
    if (!organization) throw new ApiError(404, 'Organization not found');

    // Snapshot the org's current admins *before* inserting the new workspace,
    // so this query reflects "existing workspaces only" (the new one has no
    // rows yet to affect the invariant computation).
    const otherOrgAdminProfileIds = (
      await listOrganizationAdminProfileIds(organizationId, tx)
    ).filter(id => id !== creatorProfileId);

    const nextWorkspaceId = newId();
    const slug = await uniqueWorkspaceSlug({
      desired: body.slug?.trim() ? slugify(body.slug) : suggestSlugFromName(name),
      organizationId,
      client: tx
    });
    const now = nowIso();
    const workspaceUserId = newId();

    await tx.run(
      `INSERT INTO workspaces
         (id, organization_id, slug, name, kind, settings_json, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, 'local', '{}', ?, ?, 1)`,
      [nextWorkspaceId, organizationId, slug, name, now, now]
    );

    await tx.run(
      `INSERT INTO workspace_users
         (id, workspace_id, profile_id, member_key, status, metadata_json,
          created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, 'active', '{}', ?, ?, 1)`,
      [workspaceUserId, nextWorkspaceId, creatorProfileId, `auth:${creatorProfileId}`, now, now]
    );

    await grantWorkspaceAdminRole({ workspaceId: nextWorkspaceId, workspaceUserId, client: tx });

    await seedWorkspaceStatuses({ workspaceId: nextWorkspaceId, now, client: tx });
    await seedWorkspaceStorageBuckets({
      workspaceId: nextWorkspaceId,
      createdByWorkspaceUserId: workspaceUserId,
      now,
      client: tx
    });

    await recordChange(
      {
        entityType: 'workspace',
        entityId: nextWorkspaceId,
        operation: 'insert',
        entityRevision: 1,
        workspaceId: nextWorkspaceId,
        actorWorkspaceUserId: workspaceUserId
      },
      tx
    );

    await recordChange(
      {
        entityType: 'workspace_user',
        entityId: workspaceUserId,
        operation: 'insert',
        entityRevision: 1,
        workspaceId: nextWorkspaceId,
        actorWorkspaceUserId: workspaceUserId
      },
      tx
    );

    for (const adminProfileId of otherOrgAdminProfileIds) {
      const adminWorkspaceUserId = newId();
      await tx.run(
        `INSERT INTO workspace_users
           (id, workspace_id, profile_id, member_key, status, metadata_json,
            created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, 'active', '{}', ?, ?, 1)`,
        [adminWorkspaceUserId, nextWorkspaceId, adminProfileId, `auth:${adminProfileId}`, now, now]
      );
      await grantWorkspaceAdminRole({
        workspaceId: nextWorkspaceId,
        workspaceUserId: adminWorkspaceUserId,
        assignedByWorkspaceUserId: workspaceUserId,
        client: tx
      });
      await recordChange(
        {
          entityType: 'workspace_user',
          entityId: adminWorkspaceUserId,
          operation: 'insert',
          entityRevision: 1,
          workspaceId: nextWorkspaceId,
          actorWorkspaceUserId: workspaceUserId
        },
        tx
      );
    }

    return nextWorkspaceId;
  });

  // New workspaces become the active one, mirroring the team switcher: creating
  // a workspace drops you into it.
  await setActiveWorkspace(workspaceId);
  const created = (await listWorkspaces()).find(w => w.id === workspaceId);
  if (!created) throw new ApiError(500, 'Workspace was created but could not be loaded');
  return created;
}

/**
 * Combined organization + first-workspace onboarding (Q10): for an
 * authenticated profile with **zero** workspace memberships anywhere, creates
 * an organization, a workspace (default name `general`), the caller's `ADMIN`
 * membership, default statuses/buckets, and the organization's own
 * `organization-images` bucket, all in one transaction. `POST /api/onboarding`
 * shares this verbatim with the web onboarding screen and the future
 * `ovld org-setup` CLI command, so validation/slug suggestion/the
 * zero-membership gate cannot drift between the two.
 */
export async function createOrganizationOnboarding(
  body: CreateOrganizationOnboardingBody
): Promise<WorkspaceDto> {
  const profileId = await resolveCurrentProfileId();

  const workspaceId = await requireDatabaseClient().transaction(async tx => {
    const existingMembership = await tx.get<{ id: string }>(
      `SELECT wu.id FROM workspace_users wu
         JOIN workspaces w ON w.id = wu.workspace_id AND w.deleted_at IS NULL
        WHERE wu.profile_id = ? AND wu.status = 'active' AND wu.deleted_at IS NULL
        LIMIT 1`,
      [profileId]
    );
    if (existingMembership) {
      throw new ApiError(
        409,
        'Onboarding is only available before your first workspace membership'
      );
    }

    const organizationName = (body.organizationName ?? '').trim();
    if (!organizationName) throw new ApiError(400, 'Organization name is required');
    const workspaceName = (body.workspaceName ?? '').trim() || 'general';

    const now = nowIso();
    const organizationId = newId();
    await tx.run(
      `INSERT INTO organizations (id, name, settings_json, created_at, updated_at, revision)
       VALUES (?, ?, '{}', ?, ?, 1)`,
      [organizationId, organizationName, now, now]
    );

    const nextWorkspaceId = newId();
    const slug = await uniqueWorkspaceSlug({
      desired: body.workspaceSlug?.trim()
        ? slugify(body.workspaceSlug)
        : suggestSlugFromName(workspaceName),
      organizationId,
      client: tx
    });
    const workspaceUserId = newId();

    await tx.run(
      `INSERT INTO workspaces
         (id, organization_id, slug, name, kind, settings_json, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, 'local', '{}', ?, ?, 1)`,
      [nextWorkspaceId, organizationId, slug, workspaceName, now, now]
    );
    await tx.run(
      `INSERT INTO workspace_users
         (id, workspace_id, profile_id, member_key, status, metadata_json,
          created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, 'active', '{}', ?, ?, 1)`,
      [workspaceUserId, nextWorkspaceId, profileId, `auth:${profileId}`, now, now]
    );
    await grantWorkspaceAdminRole({ workspaceId: nextWorkspaceId, workspaceUserId, client: tx });
    await seedWorkspaceStatuses({ workspaceId: nextWorkspaceId, now, client: tx });
    await seedWorkspaceStorageBuckets({
      workspaceId: nextWorkspaceId,
      createdByWorkspaceUserId: workspaceUserId,
      now,
      client: tx
    });
    await seedOrganizationStorageBucket({
      organizationId,
      createdByWorkspaceUserId: workspaceUserId,
      now,
      client: tx
    });

    await recordChange(
      {
        entityType: 'organization',
        entityId: organizationId,
        operation: 'insert',
        entityRevision: 1,
        workspaceId: nextWorkspaceId,
        actorWorkspaceUserId: workspaceUserId
      },
      tx
    );
    await recordChange(
      {
        entityType: 'workspace',
        entityId: nextWorkspaceId,
        operation: 'insert',
        entityRevision: 1,
        workspaceId: nextWorkspaceId,
        actorWorkspaceUserId: workspaceUserId
      },
      tx
    );
    await recordChange(
      {
        entityType: 'workspace_user',
        entityId: workspaceUserId,
        operation: 'insert',
        entityRevision: 1,
        workspaceId: nextWorkspaceId,
        actorWorkspaceUserId: workspaceUserId
      },
      tx
    );

    return nextWorkspaceId;
  });

  await setActiveWorkspace(workspaceId);
  const created = (await listWorkspaces()).find(w => w.id === workspaceId);
  if (!created) throw new ApiError(500, 'Workspace was created but could not be loaded');
  return created;
}

interface WorkspaceRevisionRow {
  id: string;
  name: string;
  revision: number;
}

/** Update a workspace (rename, settings). Target-workspace MANAGER or ADMIN. */
export async function updateWorkspace(
  id: string,
  body: UpdateWorkspaceBody
): Promise<WorkspaceDto> {
  await requireWorkspaceManager(id);
  await requireDatabaseClient().transaction(async tx => {
    const existing = await tx.get<WorkspaceRevisionRow>(
      `SELECT id, name, revision FROM workspaces WHERE id = ? AND deleted_at IS NULL`,
      [id]
    );
    if (!existing) throw new ApiError(404, 'Workspace not found');

    const changed: string[] = [];

    if (body.name !== undefined) {
      const name = body.name.trim();
      if (!name) throw new ApiError(400, 'Workspace name cannot be empty');
      if (name !== existing.name) {
        await tx.run(
          `UPDATE workspaces SET name = ?, updated_at = ?, revision = revision + 1 WHERE id = ?`,
          [name, nowIso(), id]
        );
        changed.push('name');
      }
    }

    if (body.sqlStudioEnabled !== undefined) {
      const current = await readSqlStudioEnabled({ workspaceId: id, client: tx });
      if (body.sqlStudioEnabled !== current) {
        await writeSqlStudioEnabled({
          workspaceId: id,
          enabled: body.sqlStudioEnabled,
          client: tx
        });
        changed.push('settings_json');
        if (id === getActiveWorkspaceIdOrNull()) {
          syncSqlStudioForWorkspace({ enabled: body.sqlStudioEnabled });
        }
      }
    }

    if (changed.length === 0) return;

    const latest = await tx.get<{ revision: number }>(
      `SELECT revision FROM workspaces WHERE id = ? AND deleted_at IS NULL`,
      [id]
    );

    await recordChange(
      {
        entityType: 'workspace',
        entityId: id,
        operation: 'update',
        entityRevision: latest?.revision,
        workspaceId: id,
        actorWorkspaceUserId: await resolveActorForWorkspace(id, tx),
        changedFields: changed
      },
      tx
    );
  });

  // Renaming the active workspace must be observed by the `WORKSPACE` live
  // binding so `/api/meta` and change attribution stay accurate.
  if (id === getActiveWorkspaceIdOrNull()) await reloadActiveWorkspace();
  const updated = (await listWorkspaces()).find(w => w.id === id);
  if (!updated) throw new ApiError(404, 'Workspace not found or no active membership');
  return updated;
}

/**
 * Soft-delete a workspace (tombstone via `deleted_at`; projects and missions
 * inside it are preserved but unreachable until restored). Deleting the last
 * workspace of an organization is allowed (Q9) — it also tombstones the
 * organization (`deleteOrganizationIfEmpty`). Deleting the active workspace
 * activates the next remaining one, or clears to no active workspace when
 * none remain. Target-workspace ADMIN only (unlike most workspace mutations,
 * deletion is not extended to MANAGER). Returns the refreshed workspace list.
 */
export async function deleteWorkspace(id: string): Promise<WorkspaceDto[]> {
  await requireWorkspaceAdmin(id);
  await requireDatabaseClient().transaction(async tx => {
    const existing = await tx.get<WorkspaceRevisionRow & { organization_id: string }>(
      `SELECT id, name, organization_id, revision FROM workspaces WHERE id = ? AND deleted_at IS NULL`,
      [id]
    );
    if (!existing) throw new ApiError(404, 'Workspace not found');

    const revision = existing.revision + 1;
    await tx.run(
      `UPDATE workspaces SET deleted_at = ?, updated_at = ?, revision = ?
         WHERE id = ?`,
      [nowIso(), nowIso(), revision, id]
    );

    await recordChange(
      {
        entityType: 'workspace',
        entityId: id,
        operation: 'delete',
        entityRevision: revision,
        workspaceId: id,
        actorWorkspaceUserId: await resolveActorForWorkspace(id, tx)
      },
      tx
    );

    await deleteOrganizationIfEmpty(existing.organization_id, tx);
  });

  if (id === getActiveWorkspaceIdOrNull()) {
    const next = (await listWorkspaces())[0];
    if (next) {
      await setActiveWorkspace(next.id);
    } else {
      setActiveWorkspaceContext(null);
      setActiveWorkspaceUser(null);
    }
  }
  return listWorkspaces();
}

interface WorkspaceMemberRow {
  workspace_user_id: string;
  profile_id: string;
  display_name: string;
  handle: string | null;
  email: string | null;
  kind: string;
  joined_at: string;
  metadata_json: string;
}

async function listMemberRoleKeys({
  workspaceId,
  workspaceUserId,
  client = requireDatabaseClient()
}: {
  workspaceId: string;
  workspaceUserId: string;
  client?: DatabaseClient;
}): Promise<string[]> {
  const rows = await client.all<{ role_key: string }>(
    `SELECT role_key FROM role_assignments
      WHERE workspace_id = ? AND workspace_user_id = ? AND deleted_at IS NULL
      ORDER BY role_key ASC`,
    [workspaceId, workspaceUserId]
  );
  return rows.map(row => row.role_key);
}

/** Active members of a workspace (`workspace_users` joined to `profiles`). Members only. */
export async function listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMemberDto[]> {
  await requireWorkspaceMember(workspaceId);

  const currentProfileId = await resolveCurrentProfileId();
  const rows = await requireDatabaseClient().all<WorkspaceMemberRow>(
    `SELECT wu.id AS workspace_user_id, wu.profile_id,
            wu.created_at AS joined_at,
            p.display_name, p.handle, p.email, p.kind, p.metadata_json
       FROM workspace_users wu
       JOIN profiles p ON p.id = wu.profile_id AND p.deleted_at IS NULL
      WHERE wu.workspace_id = ? AND wu.status = 'active' AND wu.deleted_at IS NULL
      ORDER BY wu.created_at ASC`,
    [workspaceId]
  );

  return Promise.all(
    rows.map(async r => {
      const roleKeys = await listMemberRoleKeys({
        workspaceId,
        workspaceUserId: r.workspace_user_id
      });
      let avatarUrl: string | null = null;
      try {
        const meta = JSON.parse(r.metadata_json) as { avatarUrl?: unknown };
        if (typeof meta.avatarUrl === 'string' && meta.avatarUrl.trim()) {
          avatarUrl = meta.avatarUrl.trim();
        }
      } catch {
        // malformed metadata_json — avatarUrl stays null
      }
      return {
        workspaceUserId: r.workspace_user_id,
        userId: r.profile_id,
        displayName: r.display_name,
        handle: r.handle,
        email: r.email,
        kind: r.kind,
        roleKeys,
        isAdmin: roleKeys.includes('ADMIN'),
        isOperator: r.profile_id === currentProfileId,
        joinedAt: r.joined_at,
        avatarUrl
      };
    })
  );
}

interface WorkspaceObjectiveExportRow {
  mission_title: string;
  instruction_text: string;
  objective_created_at: string;
  project_name: string;
  mission_status_name: string | null;
  mission_status_type: string;
}

/**
 * Export every non-deleted objective in the requested workspace as a CSV
 * attachment payload. Only admins of the requested workspace may export it.
 */
export async function exportWorkspaceObjectivesCsv(
  workspaceId: string
): Promise<WorkspaceObjectivesCsvExport> {
  const workspace = await requireDatabaseClient().get<{ id: string; slug: string }>(
    `SELECT id, slug FROM workspaces WHERE id = ? AND deleted_at IS NULL`,
    [workspaceId]
  );
  if (!workspace) throw new ApiError(404, 'Workspace not found');

  await requireWorkspaceAdmin(workspaceId);

  const projectOrder =
    requireDatabaseClient().dialect === 'sqlite'
      ? 'p.name COLLATE NOCASE ASC'
      : 'LOWER(p.name) ASC';
  const missionOrder =
    requireDatabaseClient().dialect === 'sqlite'
      ? 'm.title COLLATE NOCASE ASC'
      : 'LOWER(m.title) ASC';

  const rows = await requireDatabaseClient().all<WorkspaceObjectiveExportRow>(
    `SELECT m.title AS mission_title,
            o.instruction_text,
            o.created_at AS objective_created_at,
            p.name AS project_name,
            ws.name AS mission_status_name,
            m.status_type AS mission_status_type
       FROM objectives o
       JOIN missions m
         ON m.id = o.mission_id AND m.deleted_at IS NULL
       JOIN projects p
         ON p.id = o.project_id AND p.deleted_at IS NULL
       LEFT JOIN workspace_statuses ws
         ON ws.id = m.status_id AND ws.deleted_at IS NULL
      WHERE o.workspace_id = ? AND o.deleted_at IS NULL
      ORDER BY ${projectOrder},
               ${missionOrder},
               o.position ASC,
               o.created_at ASC`,
    [workspaceId]
  );

  const lines = [
    ['Mission name', 'Objective instructions', 'Date created', 'Project name', 'Mission status'],
    ...rows.map(row => [
      row.mission_title,
      row.instruction_text,
      row.objective_created_at,
      row.project_name,
      row.mission_status_name ?? row.mission_status_type
    ])
  ];

  return {
    filename: `${workspace.slug}-objectives-${new Date().toISOString().slice(0, 10)}.csv`,
    content: `${lines.map(columns => columns.map(value => csvCell(value)).join(',')).join('\n')}\n`
  };
}

// ---- member invitations ---------------------------------------------------
//
// The only way to add another user to a workspace (Phase 3 of
// planning/feature-plans/multitenancy-access-control.md). An ADMIN or MANAGER
// issues a single-use, hashed token (mirroring `user_tokens`, 003_rbac.sql)
// tied to an email address; accepting it creates the `workspace_users` row.
// Raw tokens are returned to the caller once and never persisted. A MANAGER
// actor is capped at inviting MANAGER/MEMBER — never ADMIN (R6).

const INVITATION_TOKEN_SCHEME = 'inv';
const INVITATION_HASH_ALGORITHM = 'sha256';
const INVITATION_TTL_DAYS = 14;
const WORKSPACE_ROLE_KEYS = new Set(['ADMIN', 'MANAGER', 'MEMBER']);

function generateInvitationSecret(): { secret: string; prefix: string; hash: string } {
  const prefix = `${INVITATION_TOKEN_SCHEME}_${randomBytes(4).toString('hex')}`;
  const secret = `${prefix}${randomBytes(24).toString('hex')}`;
  const hash = createHash(INVITATION_HASH_ALGORITHM).update(secret).digest('hex');
  return { secret, prefix, hash };
}

interface WorkspaceInvitationRow {
  id: string;
  workspace_id: string;
  email: string;
  role_key: string;
  token_prefix: string;
  status: string;
  invited_by_workspace_user_id: string;
  expires_at: string;
  created_at: string;
  revision: number;
}

const INVITATION_COLUMNS =
  'id, workspace_id, email, role_key, token_prefix, status, invited_by_workspace_user_id, ' +
  'expires_at, created_at, revision';

function toWorkspaceInvitationDto(row: WorkspaceInvitationRow): WorkspaceInvitationDto {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    email: row.email,
    roleKey: row.role_key,
    status: row.status as WorkspaceInvitationDto['status'],
    tokenPrefix: row.token_prefix,
    expiresAt: row.expires_at,
    createdAt: row.created_at
  };
}

/**
 * Invite an email address to join a workspace with a given role (defaults to
 * `MEMBER`). ADMIN or MANAGER; a MANAGER may not issue an `ADMIN` invite
 * (R6). Re-inviting an email with an existing pending invitation supersedes
 * it (the settings "resend" action), so the unique active `(workspace_id,
 * email)` index is never tripped.
 */
export async function inviteWorkspaceMember(
  workspaceId: string,
  body: InviteWorkspaceMemberBody
): Promise<InviteWorkspaceMemberResultDto> {
  const { isAdmin } = await requireWorkspaceManager(workspaceId);

  const email = (body.email ?? '').trim().toLowerCase();
  if (!email || !email.includes('@')) throw new ApiError(400, 'A valid email is required');
  const roleKey = (body.roleKey ?? 'MEMBER').trim().toUpperCase();
  if (!WORKSPACE_ROLE_KEYS.has(roleKey)) throw new ApiError(400, `Unknown role: ${roleKey}`);
  if (roleKey === 'ADMIN' && !isAdmin) {
    throw new ApiError(403, 'A manager may not invite a new admin');
  }

  const client = requireDatabaseClient();
  const workspace = await client.get<{ id: string }>(
    `SELECT id FROM workspaces WHERE id = ? AND deleted_at IS NULL`,
    [workspaceId]
  );
  if (!workspace) throw new ApiError(404, 'Workspace not found');

  const existingMember = await client.get<{ id: string }>(
    `SELECT wu.id FROM workspace_users wu
       JOIN profiles p ON p.id = wu.profile_id AND p.deleted_at IS NULL
      WHERE wu.workspace_id = ? AND wu.status = 'active' AND wu.deleted_at IS NULL
        AND LOWER(p.email) = ?`,
    [workspaceId, email]
  );
  if (existingMember) throw new ApiError(409, 'This email already belongs to a member');

  const invitedByWorkspaceUserId = getActorWorkspaceUserId();
  if (!invitedByWorkspaceUserId) throw new ApiError(403, 'Manager role required');

  const { invitation, rawToken } = await client.transaction(async tx => {
    const pending = await tx.get<{ id: string }>(
      `SELECT id FROM workspace_invitations
         WHERE workspace_id = ? AND email = ? AND status = 'pending' AND deleted_at IS NULL`,
      [workspaceId, email]
    );
    const now = nowIso();
    if (pending) {
      await tx.run(
        `UPDATE workspace_invitations
            SET status = 'revoked', revoked_at = ?, updated_at = ?, revision = revision + 1
          WHERE id = ?`,
        [now, now, pending.id]
      );
    }

    let generated: ReturnType<typeof generateInvitationSecret> | null = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = generateInvitationSecret();
      const clash = await tx.get(
        `SELECT 1 FROM workspace_invitations WHERE workspace_id = ? AND token_prefix = ?`,
        [workspaceId, candidate.prefix]
      );
      if (!clash) {
        generated = candidate;
        break;
      }
    }
    if (!generated) {
      throw new ApiError(409, 'Could not allocate a unique invitation token; try again');
    }

    const id = newId();
    const expiresAt = new Date(
      Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();
    await tx.run(
      `INSERT INTO workspace_invitations (
         id, workspace_id, email, role_key, token_prefix, token_hash, hash_algorithm,
         status, invited_by_workspace_user_id, expires_at, created_at, updated_at, revision
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, 1)`,
      [
        id,
        workspaceId,
        email,
        roleKey,
        generated.prefix,
        generated.hash,
        INVITATION_HASH_ALGORITHM,
        invitedByWorkspaceUserId,
        expiresAt,
        now,
        now
      ]
    );

    await recordChange(
      {
        entityType: 'workspace_invitation',
        entityId: id,
        operation: 'insert',
        entityRevision: 1,
        workspaceId,
        actorWorkspaceUserId: invitedByWorkspaceUserId
      },
      tx
    );

    const row = await tx.get<WorkspaceInvitationRow>(
      `SELECT ${INVITATION_COLUMNS} FROM workspace_invitations WHERE id = ?`,
      [id]
    );
    if (!row) throw new ApiError(500, 'Invitation was created but could not be loaded');
    return { invitation: toWorkspaceInvitationDto(row), rawToken: generated.secret };
  });

  const sendEmail = invitationEmailSenderFromEnv();
  const acceptUrl = inviteAcceptUrl(rawToken);
  if (sendEmail) {
    await sendEmail({ email, confirmationUrl: acceptUrl });
    return { invitation };
  }

  // No email provider configured (self-hosted default) — the raw token never
  // leaves the server otherwise, so hand the link back for the admin to share
  // manually instead of silently creating an invite no one can accept.
  return { invitation, acceptUrl };
}

/** List every non-deleted invitation for a workspace (pending and resolved). ADMIN or MANAGER. */
export async function listWorkspaceInvitations(
  workspaceId: string
): Promise<WorkspaceInvitationDto[]> {
  await requireWorkspaceManager(workspaceId);
  const rows = await requireDatabaseClient().all<WorkspaceInvitationRow>(
    `SELECT ${INVITATION_COLUMNS} FROM workspace_invitations
       WHERE workspace_id = ? AND deleted_at IS NULL
       ORDER BY created_at DESC`,
    [workspaceId]
  );
  return rows.map(toWorkspaceInvitationDto);
}

/** Revoke a still-pending invitation. No-op if already accepted/revoked/expired. ADMIN or MANAGER. */
export async function revokeWorkspaceInvitation(
  workspaceId: string,
  invitationId: string
): Promise<void> {
  await requireWorkspaceManager(workspaceId);
  await requireDatabaseClient().transaction(async tx => {
    const invitation = await tx.get<{ id: string; status: string; revision: number }>(
      `SELECT id, status, revision FROM workspace_invitations
         WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      [invitationId, workspaceId]
    );
    if (!invitation) throw new ApiError(404, 'Invitation not found');
    if (invitation.status !== 'pending') return;

    const now = nowIso();
    const revision = invitation.revision + 1;
    await tx.run(
      `UPDATE workspace_invitations
          SET status = 'revoked', revoked_at = ?, updated_at = ?, revision = ?
        WHERE id = ?`,
      [now, now, revision, invitationId]
    );
    await recordChange(
      {
        entityType: 'workspace_invitation',
        entityId: invitationId,
        operation: 'update',
        entityRevision: revision,
        workspaceId,
        actorWorkspaceUserId: getActorWorkspaceUserId()
      },
      tx
    );
  });
}

/**
 * Accept an invitation by its raw token. Binds the authenticated caller's
 * profile to the invitation's workspace with the invited role, and makes that
 * workspace active for the caller. The token is looked up by hash alone (no
 * workspace id required up front), then the email on the accepting profile must
 * match the invited email exactly.
 */
export async function acceptWorkspaceInvitation(
  body: AcceptWorkspaceInvitationBody
): Promise<WorkspaceDto> {
  const rawToken = (body.token ?? '').trim();
  if (!rawToken) throw new ApiError(400, 'Invitation token is required');
  const profileId = getActiveProfileId();
  if (!profileId) throw new ApiError(401, 'Authentication required');

  const tokenHash = createHash(INVITATION_HASH_ALGORITHM).update(rawToken).digest('hex');
  const client = requireDatabaseClient();

  const outcome = await client.transaction<
    { kind: 'accepted'; workspaceId: string } | { kind: 'expired' }
  >(async tx => {
    const invitation = await tx.get<WorkspaceInvitationRow>(
      `SELECT ${INVITATION_COLUMNS} FROM workspace_invitations
         WHERE token_hash = ? AND deleted_at IS NULL`,
      [tokenHash]
    );
    if (!invitation) throw new ApiError(404, 'Invitation not found or already used');
    if (invitation.status !== 'pending') {
      throw new ApiError(409, `Invitation has already been ${invitation.status}`);
    }
    const now = nowIso();
    if (invitation.expires_at <= now) {
      const revision = invitation.revision + 1;
      await tx.run(
        `UPDATE workspace_invitations
            SET status = 'expired', updated_at = ?, revision = ?
          WHERE id = ?`,
        [now, revision, invitation.id]
      );
      await recordChange(
        {
          entityType: 'workspace_invitation',
          entityId: invitation.id,
          operation: 'update',
          entityRevision: revision,
          workspaceId: invitation.workspace_id,
          actorWorkspaceUserId: getActorWorkspaceUserId(),
          changedFields: ['status']
        },
        tx
      );
      return { kind: 'expired' };
    }

    const profile = await tx.get<{ email: string | null }>(
      `SELECT email FROM profiles WHERE id = ? AND deleted_at IS NULL`,
      [profileId]
    );
    if (!profile?.email || profile.email.trim().toLowerCase() !== invitation.email) {
      throw new ApiError(403, 'This invitation was sent to a different email address');
    }

    const existingMembershipId = await findActiveMembershipId(
      invitation.workspace_id,
      profileId,
      tx
    );

    let workspaceUserId: string;
    if (existingMembershipId) {
      workspaceUserId = existingMembershipId;
    } else {
      workspaceUserId = newId();
      await tx.run(
        `INSERT INTO workspace_users
           (id, workspace_id, profile_id, member_key, status, metadata_json,
            created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, 'active', '{}', ?, ?, 1)`,
        [workspaceUserId, invitation.workspace_id, profileId, `auth:${profileId}`, now, now]
      );
      await recordChange(
        {
          entityType: 'workspace_user',
          entityId: workspaceUserId,
          operation: 'insert',
          entityRevision: 1,
          workspaceId: invitation.workspace_id,
          actorWorkspaceUserId: workspaceUserId
        },
        tx
      );
    }

    // Grant the invited role only when this member has no active role rows
    // yet — re-accepting (or an already-a-member invite) never re-grants or
    // downgrades an existing membership's roles.
    const hasRole = await tx.get(
      `SELECT 1 FROM role_assignments
         WHERE workspace_id = ? AND workspace_user_id = ? AND deleted_at IS NULL LIMIT 1`,
      [invitation.workspace_id, workspaceUserId]
    );
    if (!hasRole) {
      if (invitation.role_key === 'ADMIN') {
        await grantWorkspaceAdminRole({
          workspaceId: invitation.workspace_id,
          workspaceUserId,
          client: tx
        });
      } else {
        await tx.run(
          `INSERT INTO role_assignments
             (id, workspace_id, workspace_user_id, role_key, resource_type, resource_id,
              assigned_by_workspace_user_id, created_at, updated_at, revision)
           VALUES (?, ?, ?, ?, '', '', ?, ?, ?, 1)`,
          [
            newId(),
            invitation.workspace_id,
            workspaceUserId,
            invitation.role_key,
            invitation.invited_by_workspace_user_id,
            now,
            now
          ]
        );
      }
    }

    const revision = invitation.revision + 1;
    await tx.run(
      `UPDATE workspace_invitations
          SET status = 'accepted', accepted_by_workspace_user_id = ?, accepted_at = ?,
              updated_at = ?, revision = ?
        WHERE id = ?`,
      [workspaceUserId, now, now, revision, invitation.id]
    );
    await recordChange(
      {
        entityType: 'workspace_invitation',
        entityId: invitation.id,
        operation: 'update',
        entityRevision: revision,
        workspaceId: invitation.workspace_id,
        actorWorkspaceUserId: workspaceUserId
      },
      tx
    );

    return { kind: 'accepted', workspaceId: invitation.workspace_id };
  });

  if (outcome.kind === 'expired') {
    throw new ApiError(410, 'Invitation has expired');
  }

  const workspaceId = outcome.workspaceId;
  await setActiveWorkspace(workspaceId);
  const workspace = (await listWorkspaces()).find(w => w.id === workspaceId);
  if (!workspace) throw new ApiError(500, 'Joined workspace could not be loaded');
  return workspace;
}

/**
 * Count active ADMIN members for the last-admin guard. This intentionally joins
 * through active workspace_users so stale role rows on disabled members do not
 * keep a workspace administrable.
 */
async function countActiveWorkspaceAdmins({
  workspaceId,
  client = requireDatabaseClient()
}: {
  workspaceId: string;
  client?: DatabaseClient;
}): Promise<number> {
  const row = await client.get<{ count: number }>(
    `SELECT COUNT(DISTINCT wu.id) AS count
       FROM workspace_users wu
       JOIN role_assignments ra
         ON ra.workspace_user_id = wu.id
        AND ra.workspace_id = wu.workspace_id
        AND ra.role_key = 'ADMIN'
        AND ra.deleted_at IS NULL
      WHERE wu.workspace_id = ?
        AND wu.status = 'active'
        AND wu.deleted_at IS NULL`,
    [workspaceId]
  );
  return row?.count ?? 0;
}

async function assertNotLastWorkspaceAdmin({
  workspaceId,
  workspaceUserId,
  client
}: {
  workspaceId: string;
  workspaceUserId: string;
  client: DatabaseClient;
}): Promise<void> {
  const roles = await listMemberRoleKeys({ workspaceId, workspaceUserId, client });
  if (!roles.includes('ADMIN')) return;
  if ((await countActiveWorkspaceAdmins({ workspaceId, client })) <= 1) {
    throw new ApiError(409, 'Cannot remove or demote the last workspace admin');
  }
}

/**
 * Set a member's workspace-level role. ADMIN or MANAGER; a MANAGER may
 * neither grant `ADMIN` nor demote/remove an existing `ADMIN` (R6). Replaces
 * active role rows with exactly the requested role and refuses to demote the
 * final ADMIN.
 */
export async function updateWorkspaceMemberRole(
  workspaceId: string,
  workspaceUserId: string,
  body: UpdateWorkspaceMemberRoleBody
): Promise<WorkspaceMemberDto> {
  const { isAdmin } = await requireWorkspaceManager(workspaceId);

  const roleKey = (body.roleKey ?? '').trim().toUpperCase();
  if (!WORKSPACE_ROLE_KEYS.has(roleKey)) throw new ApiError(400, `Unknown role: ${roleKey}`);
  if (roleKey === 'ADMIN' && !isAdmin) {
    throw new ApiError(403, 'A manager may not grant admin');
  }

  await requireDatabaseClient().transaction(async tx => {
    const membership = await tx.get<{ id: string }>(
      `SELECT id FROM workspace_users
         WHERE id = ? AND workspace_id = ? AND status = 'active' AND deleted_at IS NULL`,
      [workspaceUserId, workspaceId]
    );
    if (!membership) throw new ApiError(404, 'Member not found');

    const existingRoles = await listMemberRoleKeys({ workspaceId, workspaceUserId, client: tx });
    if (existingRoles.includes('ADMIN') && !isAdmin) {
      throw new ApiError(403, 'A manager may not change an admin’s role');
    }

    if (roleKey !== 'ADMIN') {
      await assertNotLastWorkspaceAdmin({ workspaceId, workspaceUserId, client: tx });
    }

    if (existingRoles.length === 1 && existingRoles[0] === roleKey) return;

    const now = nowIso();
    await tx.run(
      `UPDATE role_assignments
          SET deleted_at = ?, updated_at = ?, revision = revision + 1
        WHERE workspace_id = ? AND workspace_user_id = ? AND deleted_at IS NULL`,
      [now, now, workspaceId, workspaceUserId]
    );
    await tx.run(
      `INSERT INTO role_assignments
         (id, workspace_id, workspace_user_id, role_key, resource_type, resource_id,
          assigned_by_workspace_user_id, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, '', '', ?, ?, ?, 1)`,
      [newId(), workspaceId, workspaceUserId, roleKey, getActorWorkspaceUserId(), now, now]
    );
    await recordChange(
      {
        entityType: 'role_assignment',
        entityId: workspaceUserId,
        operation: 'update',
        workspaceId,
        actorWorkspaceUserId: getActorWorkspaceUserId(),
        changedFields: ['role_key']
      },
      tx
    );
  });

  const updated = (await listWorkspaceMembers(workspaceId)).find(
    member => member.workspaceUserId === workspaceUserId
  );
  if (!updated) throw new ApiError(404, 'Member not found');
  return updated;
}

/**
 * Remove an active member from a workspace: soft-deletes their `workspace_users`
 * row and revokes their role rows. ADMIN or MANAGER; a MANAGER may not remove
 * an existing ADMIN (R6). Refuses to remove the workspace's only remaining
 * active member and the final ADMIN.
 */
export async function removeWorkspaceMember(
  workspaceId: string,
  workspaceUserId: string
): Promise<void> {
  const { isAdmin } = await requireWorkspaceManager(workspaceId);
  await requireDatabaseClient().transaction(async tx => {
    const membership = await tx.get<{ id: string; revision: number }>(
      `SELECT id, revision FROM workspace_users
         WHERE id = ? AND workspace_id = ? AND status = 'active' AND deleted_at IS NULL`,
      [workspaceUserId, workspaceId]
    );
    if (!membership) throw new ApiError(404, 'Member not found');

    const existingRoles = await listMemberRoleKeys({ workspaceId, workspaceUserId, client: tx });
    if (existingRoles.includes('ADMIN') && !isAdmin) {
      throw new ApiError(403, 'A manager may not remove an admin');
    }

    await assertNotLastWorkspaceAdmin({ workspaceId, workspaceUserId, client: tx });

    const activeCount = await tx.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM workspace_users
         WHERE workspace_id = ? AND status = 'active' AND deleted_at IS NULL`,
      [workspaceId]
    );
    if ((activeCount?.count ?? 0) <= 1) {
      throw new ApiError(409, 'Cannot remove the only member of a workspace');
    }

    const now = nowIso();
    const revision = membership.revision + 1;
    await tx.run(
      `UPDATE workspace_users
          SET status = 'disabled', deleted_at = ?, updated_at = ?, revision = ?
        WHERE id = ?`,
      [now, now, revision, workspaceUserId]
    );
    await tx.run(
      `UPDATE role_assignments
          SET deleted_at = ?, updated_at = ?, revision = revision + 1
        WHERE workspace_id = ? AND workspace_user_id = ? AND deleted_at IS NULL`,
      [now, now, workspaceId, workspaceUserId]
    );
    await recordChange(
      {
        entityType: 'workspace_user',
        entityId: workspaceUserId,
        operation: 'delete',
        entityRevision: revision,
        workspaceId,
        actorWorkspaceUserId: getActorWorkspaceUserId()
      },
      tx
    );
  });
}

/** Switch the active workspace and return the refreshed workspace list. */
export async function activateWorkspace(id: string): Promise<WorkspaceDto[]> {
  // Validate that the *calling* profile — not just some member of `id` — has
  // an active membership before switching. This is per-user: it changes this
  // caller's own active workspace (this request's context, persisted for
  // future requests via the route's `ACTIVE_WORKSPACE_COOKIE`), never a
  // process-wide default that would affect other tenants' sessions.
  await requireWorkspaceMember(id);
  if (!(await setActiveWorkspace(id))) throw new ApiError(404, 'Workspace not found');
  syncSqlStudioForWorkspace({ enabled: await readSqlStudioEnabled({ workspaceId: id }) });
  return listWorkspaces();
}
