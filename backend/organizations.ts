/**
 * The organization service: the grouping + identity layer above workspaces
 * (organization → workspace → project). Workspaces remain the sole RBAC
 * layer — "organization admin" is a derived concept (`isOrganizationAdmin` in
 * `backend/rbac.ts`: ADMIN of every live constituent workspace), not a stored
 * role. See planning/feature-plans/organization-workspace-hierarchy.md.
 *
 * Org mutations (rename, logo, admin changes) don't fit the workspace-scoped
 * `entity_changes` feed (`workspace_id NOT NULL`) — every write here fans out
 * one `entity_changes` row per constituent workspace instead (R4), so every
 * client watching any of the org's workspaces observes the change.
 */

import { type DatabaseClient } from '@overlord/database';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  AddOrganizationAdminBody,
  OrganizationAdminDto,
  OrganizationDto,
  RemoveOrganizationAdminBody,
  UpdateOrganizationBody
} from '../webapp/shared/contract.ts';

import {
  getActiveWorkspaceIdOrNull,
  newId,
  nowIso,
  recordChange,
  requireDatabaseClient,
  resolveActiveProfileId
} from './db.ts';
import { ApiError } from './errors.ts';
import {
  isOrganizationAdmin,
  listOrganizationAdminProfileIds,
  liveOrganizationWorkspaceIds
} from './rbac.ts';
import { createStorageBackend } from './storage-backends.ts';

// backend/organizations.ts -> repo root is one level up from backend/.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface OrganizationRow {
  id: string;
  name: string;
  settings_json: string;
  created_at: string;
  revision: number;
}

function parseSettings(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function logoUrlFromSettings(raw: string): string | null {
  const value = parseSettings(raw).logoUrl;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function workspaceCountForOrganization(
  organizationId: string,
  client: DatabaseClient
): Promise<number> {
  const row = await client.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM workspaces WHERE organization_id = ? AND deleted_at IS NULL`,
    [organizationId]
  );
  return row?.count ?? 0;
}

async function toOrganizationDto(
  row: OrganizationRow,
  { activeOrganizationId, client }: { activeOrganizationId: string | null; client: DatabaseClient }
): Promise<OrganizationDto> {
  return {
    id: row.id,
    name: row.name,
    logoUrl: logoUrlFromSettings(row.settings_json),
    workspaceCount: await workspaceCountForOrganization(row.id, client),
    isActive: row.id === activeOrganizationId,
    createdAt: row.created_at
  };
}

/** The organization a live workspace belongs to, or `null` if the workspace doesn't exist. */
export async function resolveOrganizationIdForWorkspace(
  workspaceId: string,
  client: DatabaseClient = requireDatabaseClient()
): Promise<string | null> {
  const row = await client.get<{ organization_id: string }>(
    `SELECT organization_id FROM workspaces WHERE id = ? AND deleted_at IS NULL`,
    [workspaceId]
  );
  return row?.organization_id ?? null;
}

/**
 * The caller's currently active organization id, derived from the active
 * workspace (there is no separate "active organization" binding — Q6 keeps
 * the existing active-workspace preference as the scope of record). `null`
 * pre-onboarding (zero-workspace boot, Q10).
 */
export async function getActiveOrganizationIdOrNull(
  client: DatabaseClient = requireDatabaseClient()
): Promise<string | null> {
  const workspaceId = getActiveWorkspaceIdOrNull();
  if (!workspaceId) return null;
  return resolveOrganizationIdForWorkspace(workspaceId, client);
}

/** Every organization `profileId` has at least one active workspace membership in. */
export async function listOrganizationsForUser(
  profileId: string,
  client: DatabaseClient = requireDatabaseClient()
): Promise<OrganizationDto[]> {
  const activeOrganizationId = await getActiveOrganizationIdOrNull(client);
  const rows = await client.all<OrganizationRow>(
    `SELECT DISTINCT o.id, o.name, o.settings_json, o.created_at, o.revision
       FROM organizations o
       JOIN workspaces w ON w.organization_id = o.id AND w.deleted_at IS NULL
       JOIN workspace_users wu
         ON wu.workspace_id = w.id AND wu.profile_id = ?
        AND wu.status = 'active' AND wu.deleted_at IS NULL
      WHERE o.deleted_at IS NULL
      ORDER BY o.created_at ASC`,
    [profileId]
  );
  return Promise.all(rows.map(row => toOrganizationDto(row, { activeOrganizationId, client })));
}

async function getOrganizationRow(id: string, client: DatabaseClient): Promise<OrganizationRow> {
  const row = await client.get<OrganizationRow>(
    `SELECT id, name, settings_json, created_at, revision
       FROM organizations WHERE id = ? AND deleted_at IS NULL`,
    [id]
  );
  if (!row) throw new ApiError(404, 'Organization not found');
  return row;
}

async function requireCurrentProfileId(
  client: DatabaseClient = requireDatabaseClient()
): Promise<string> {
  const profileId = await resolveActiveProfileId(client);
  if (!profileId) throw new ApiError(401, 'Authentication required');
  return profileId;
}

/**
 * The shared gate for every org mutation/admin read: authenticated caller,
 * existing organization, and org-admin status (ADMIN in every live
 * constituent workspace, Q2). Returns the caller's profile id.
 */
async function requireOrganizationAdmin(
  organizationId: string,
  client: DatabaseClient
): Promise<string> {
  const profileId = await requireCurrentProfileId(client);
  await getOrganizationRow(organizationId, client);
  if (!(await isOrganizationAdmin(profileId, organizationId, client))) {
    throw new ApiError(403, 'Organization admin required');
  }
  return profileId;
}

/**
 * Make `roleKey` the member's sole role in a workspace: soft-delete every
 * current assignment and insert the new one, recording the change. No-op when
 * the member already holds exactly that one role. Shared by the org-admin
 * add (→ ADMIN everywhere) and remove (→ MEMBER everywhere) invariants.
 */
async function setSoleRoleAssignment(
  tx: DatabaseClient,
  {
    workspaceId,
    workspaceUserId,
    roleKey,
    assignedByWorkspaceUserId,
    now
  }: {
    workspaceId: string;
    workspaceUserId: string;
    roleKey: 'ADMIN' | 'MEMBER';
    assignedByWorkspaceUserId: string;
    now: string;
  }
): Promise<void> {
  const roles = await tx.all<{ role_key: string }>(
    `SELECT role_key FROM role_assignments
       WHERE workspace_id = ? AND workspace_user_id = ? AND deleted_at IS NULL`,
    [workspaceId, workspaceUserId]
  );
  if (roles.length === 1 && roles[0].role_key === roleKey) return;

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
    [newId(), workspaceId, workspaceUserId, roleKey, assignedByWorkspaceUserId, now, now]
  );
  await recordChange(
    {
      entityType: 'role_assignment',
      entityId: workspaceUserId,
      operation: 'update',
      workspaceId,
      changedFields: ['role_key']
    },
    tx
  );
}

/** Fan out one `entity_changes` row per constituent workspace (R4). */
async function recordOrganizationChange({
  organizationId,
  operation,
  entityRevision,
  changedFields,
  client
}: {
  organizationId: string;
  operation: 'insert' | 'update' | 'delete';
  entityRevision?: number;
  changedFields?: string[];
  client: DatabaseClient;
}): Promise<void> {
  const workspaceIds = await liveOrganizationWorkspaceIds(organizationId, client);
  for (const workspaceId of workspaceIds) {
    await recordChange(
      {
        entityType: 'organization',
        entityId: organizationId,
        operation,
        entityRevision,
        changedFields,
        workspaceId
      },
      client
    );
  }
}

/** Update an organization's name/logo. Org-admin gated (Q2). */
export async function updateOrganization(
  id: string,
  body: UpdateOrganizationBody
): Promise<OrganizationDto> {
  const client = requireDatabaseClient();
  await requireOrganizationAdmin(id, client);

  await client.transaction(async tx => {
    const existing = await getOrganizationRow(id, tx);
    const settings = parseSettings(existing.settings_json);
    const changed: string[] = [];
    let name = existing.name;

    if (body.name !== undefined) {
      const trimmed = body.name.trim();
      if (!trimmed) throw new ApiError(400, 'Organization name cannot be empty');
      if (trimmed !== existing.name) changed.push('name');
      name = trimmed;
    }

    if (body.logoUrl !== undefined) {
      const logoUrl = body.logoUrl?.trim() || null;
      if (logoUrl && !/^(https?:\/\/|\/)/i.test(logoUrl)) {
        throw new ApiError(400, 'Logo URL must be an http(s) URL or an uploaded image path');
      }
      if (logoUrl !== logoUrlFromSettings(existing.settings_json)) {
        if (logoUrl) settings.logoUrl = logoUrl;
        else delete settings.logoUrl;
        changed.push('settings_json');
      }
    }

    if (changed.length === 0) return;

    const revision = existing.revision + 1;
    await tx.run(
      `UPDATE organizations
          SET name = ?, settings_json = ?, updated_at = ?, revision = ?
        WHERE id = ?`,
      [name, JSON.stringify(settings), nowIso(), revision, id]
    );

    await recordOrganizationChange({
      organizationId: id,
      operation: 'update',
      entityRevision: revision,
      changedFields: changed,
      client: tx
    });
  });

  const updated = await getOrganizationRow(id, client);
  return toOrganizationDto(updated, {
    activeOrganizationId: await getActiveOrganizationIdOrNull(client),
    client
  });
}

interface OrganizationAdminRow {
  user_id: string;
  display_name: string;
  handle: string | null;
  email: string | null;
  metadata_json: string;
}

function toOrganizationAdminDto(row: OrganizationAdminRow): OrganizationAdminDto {
  let avatarUrl: string | null = null;
  try {
    const meta = JSON.parse(row.metadata_json) as { avatarUrl?: unknown };
    if (typeof meta.avatarUrl === 'string' && meta.avatarUrl.trim()) {
      avatarUrl = meta.avatarUrl.trim();
    }
  } catch {
    // malformed metadata_json — avatarUrl stays null
  }
  return {
    userId: row.user_id,
    displayName: row.display_name,
    handle: row.handle,
    email: row.email,
    avatarUrl
  };
}

async function loadOrganizationAdmins(
  organizationId: string,
  client: DatabaseClient
): Promise<OrganizationAdminDto[]> {
  const profileIds = await listOrganizationAdminProfileIds(organizationId, client);
  if (profileIds.length === 0) return [];
  const placeholders = profileIds.map(() => '?').join(', ');
  const rows = await client.all<OrganizationAdminRow>(
    `SELECT id AS user_id, display_name, handle, email, metadata_json
       FROM profiles
      WHERE id IN (${placeholders}) AND deleted_at IS NULL
      ORDER BY display_name ASC`,
    profileIds
  );
  return rows.map(toOrganizationAdminDto);
}

/** List an organization's admins (ADMIN in every live constituent workspace). Org-admin-only. */
export async function listOrganizationAdmins(
  organizationId: string
): Promise<OrganizationAdminDto[]> {
  const client = requireDatabaseClient();
  await requireOrganizationAdmin(organizationId, client);
  return loadOrganizationAdmins(organizationId, client);
}

/**
 * Grant `ADMIN` to `body.userId` in every live constituent workspace,
 * auto-joining any workspace they aren't already a member of (mirroring the
 * auto-grant `createWorkspace` performs for existing org admins, Q3). The
 * target must already belong to at least one constituent workspace — org
 * admin status is granted to existing members, not used to invite strangers.
 * Org-admin-only.
 */
export async function addOrganizationAdmin(
  organizationId: string,
  body: AddOrganizationAdminBody
): Promise<OrganizationAdminDto[]> {
  const client = requireDatabaseClient();
  const actingProfileId = await requireOrganizationAdmin(organizationId, client);

  const targetProfileId = (body.userId ?? '').trim();
  if (!targetProfileId) throw new ApiError(400, 'userId is required');

  await client.transaction(async tx => {
    const targetProfile = await tx.get<{ id: string }>(
      `SELECT id FROM profiles WHERE id = ? AND deleted_at IS NULL`,
      [targetProfileId]
    );
    if (!targetProfile) throw new ApiError(404, 'User not found');

    const workspaceIds = await liveOrganizationWorkspaceIds(organizationId, tx);
    if (workspaceIds.length === 0) throw new ApiError(404, 'Organization has no workspaces');

    const hasAnyMembership = await tx.get(
      `SELECT 1 FROM workspace_users wu
         JOIN workspaces w ON w.id = wu.workspace_id AND w.deleted_at IS NULL
        WHERE w.organization_id = ? AND wu.profile_id = ?
          AND wu.status = 'active' AND wu.deleted_at IS NULL
        LIMIT 1`,
      [organizationId, targetProfileId]
    );
    if (!hasAnyMembership) {
      throw new ApiError(400, 'User must already belong to a workspace in this organization');
    }

    const now = nowIso();
    for (const workspaceId of workspaceIds) {
      const membership = await tx.get<{ id: string }>(
        `SELECT id FROM workspace_users
           WHERE workspace_id = ? AND profile_id = ? AND status = 'active' AND deleted_at IS NULL`,
        [workspaceId, targetProfileId]
      );

      let workspaceUserId: string;
      if (membership) {
        workspaceUserId = membership.id;
      } else {
        workspaceUserId = newId();
        await tx.run(
          `INSERT INTO workspace_users
             (id, workspace_id, profile_id, member_key, status, metadata_json,
              created_at, updated_at, revision)
           VALUES (?, ?, ?, ?, 'active', '{}', ?, ?, 1)`,
          [workspaceUserId, workspaceId, targetProfileId, `auth:${targetProfileId}`, now, now]
        );
        await recordChange(
          {
            entityType: 'workspace_user',
            entityId: workspaceUserId,
            operation: 'insert',
            entityRevision: 1,
            workspaceId,
            actorWorkspaceUserId: workspaceUserId
          },
          tx
        );
      }

      const actingMembership = await tx.get<{ id: string }>(
        `SELECT id FROM workspace_users
           WHERE workspace_id = ? AND profile_id = ? AND status = 'active' AND deleted_at IS NULL`,
        [workspaceId, actingProfileId]
      );

      await setSoleRoleAssignment(tx, {
        workspaceId,
        workspaceUserId,
        roleKey: 'ADMIN',
        assignedByWorkspaceUserId: actingMembership?.id ?? workspaceUserId,
        now
      });
    }
  });

  return loadOrganizationAdmins(organizationId, client);
}

/**
 * Demote `body.userId` to `MEMBER` in every live constituent workspace they
 * belong to. Refuses to remove the organization's last admin. Org-admin-only.
 */
export async function removeOrganizationAdmin(
  organizationId: string,
  body: RemoveOrganizationAdminBody
): Promise<OrganizationAdminDto[]> {
  const client = requireDatabaseClient();
  await requireOrganizationAdmin(organizationId, client);

  const targetProfileId = (body.userId ?? '').trim();
  if (!targetProfileId) throw new ApiError(400, 'userId is required');

  const currentAdminIds = await listOrganizationAdminProfileIds(organizationId, client);
  if (!currentAdminIds.includes(targetProfileId)) {
    throw new ApiError(404, 'User is not an organization admin');
  }
  if (currentAdminIds.length <= 1) {
    throw new ApiError(409, 'Cannot remove the last organization admin');
  }

  await client.transaction(async tx => {
    const workspaceIds = await liveOrganizationWorkspaceIds(organizationId, tx);
    const now = nowIso();
    for (const workspaceId of workspaceIds) {
      const membership = await tx.get<{ id: string }>(
        `SELECT id FROM workspace_users
           WHERE workspace_id = ? AND profile_id = ? AND status = 'active' AND deleted_at IS NULL`,
        [workspaceId, targetProfileId]
      );
      if (!membership) continue;

      await setSoleRoleAssignment(tx, {
        workspaceId,
        workspaceUserId: membership.id,
        roleKey: 'MEMBER',
        assignedByWorkspaceUserId: membership.id,
        now
      });
    }
  });

  return loadOrganizationAdmins(organizationId, client);
}

/** Best-effort purge of the org logo's stored bytes (never blocks org deletion on failure). */
async function purgeOrganizationLogoObject(
  organizationId: string,
  settingsJson: string,
  client: DatabaseClient
): Promise<void> {
  const logoUrl = logoUrlFromSettings(settingsJson);
  if (!logoUrl) return;
  const match = logoUrl.match(/^\/api\/storage\/organization-images\/(.+)$/);
  if (!match) return;

  const bucket = await client.get<{
    id: string;
    bucket_key: string;
    storage_backend: string;
    local_path: string | null;
    settings_json: string;
  }>(
    `SELECT id, bucket_key, storage_backend, local_path, settings_json
       FROM storage_buckets
      WHERE organization_id = ? AND bucket_key = 'organization-images' AND deleted_at IS NULL`,
    [organizationId]
  );
  if (!bucket) return;

  try {
    const backend = createStorageBackend({ bucket, repoRoot });
    await backend.deleteObject?.({ key: decodeURIComponent(match[1]) });
  } catch {
    // Best-effort only — a storage cleanup failure must never block deleting
    // the last workspace of an organization.
  }
}

/**
 * Tombstone the organization once its last live workspace is gone (Q9),
 * purging the org logo object and soft-deleting its storage buckets. No-op if
 * the organization still has a live workspace, or is already deleted. Must be
 * called with the same transaction client as the workspace deletion that
 * triggered it, so the two tombstones commit atomically.
 */
export async function deleteOrganizationIfEmpty(
  organizationId: string,
  client: DatabaseClient
): Promise<void> {
  if ((await workspaceCountForOrganization(organizationId, client)) > 0) return;

  const org = await client.get<{
    settings_json: string;
    revision: number;
    deleted_at: string | null;
  }>(`SELECT settings_json, revision, deleted_at FROM organizations WHERE id = ?`, [
    organizationId
  ]);
  if (!org || org.deleted_at) return;

  await purgeOrganizationLogoObject(organizationId, org.settings_json, client);

  const now = nowIso();
  await client.run(
    `UPDATE organizations SET deleted_at = ?, updated_at = ?, revision = ? WHERE id = ?`,
    [now, now, org.revision + 1, organizationId]
  );
  await client.run(
    `UPDATE storage_buckets
        SET deleted_at = ?, updated_at = ?, revision = revision + 1
      WHERE organization_id = ? AND deleted_at IS NULL`,
    [now, now, organizationId]
  );
}
