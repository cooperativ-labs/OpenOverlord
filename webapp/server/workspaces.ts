import { type DatabaseClient, DEFAULT_STATUSES } from '@overlord/database';

import type {
  CompleteInitialSetupBody,
  CreateWorkspaceBody,
  UpdateWorkspaceBody,
  WorkspaceDto,
  WorkspaceMemberDto
} from '../shared/contract.ts';

import {
  DATABASE_DIALECT,
  getActorWorkspaceUserId,
  newId,
  nowIso,
  recordChange,
  reloadActiveWorkspace,
  requireDatabaseClient,
  resolveActorForWorkspace,
  setActiveWorkspace,
  WORKSPACE
} from './db.ts';
import { ApiError } from './errors.ts';
import { actorIsAdmin, requireAdmin } from './rbac.ts';
import { syncSqlStudioForWorkspace } from './sql-studio-manager.ts';
import { readSqlStudioEnabled, writeSqlStudioEnabled } from './workspace-settings.ts';

// ---- row shapes ----------------------------------------------------------

interface WorkspaceListRow {
  id: string;
  slug: string;
  name: string;
  kind: string;
  created_at: string;
  project_count: number;
  member_count: number;
}

async function toWorkspaceDto(r: WorkspaceListRow): Promise<WorkspaceDto> {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    kind: r.kind,
    isActive: r.id === WORKSPACE.id,
    projectCount: r.project_count,
    memberCount: r.member_count,
    sqlStudioEnabled: await readSqlStudioEnabled({ workspaceId: r.id }),
    createdAt: r.created_at
  };
}

function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base.length > 0 ? base : 'workspace';
}

function workspaceIdFromInput(input: string): string {
  return slugify(input);
}

function desiredWorkspaceId(bodyId: string | undefined, name: string): string {
  return bodyId?.trim() ? workspaceIdFromInput(bodyId) : workspaceIdFromInput(name);
}

async function ensureWorkspaceIdAvailable({
  workspaceId,
  excludeWorkspaceId,
  client = requireDatabaseClient()
}: {
  workspaceId: string;
  excludeWorkspaceId?: string;
  client?: DatabaseClient;
}): Promise<void> {
  const exclude = excludeWorkspaceId ?? null;
  const existing = await client.get<{ id: string }>(
    `SELECT id FROM workspaces
       WHERE id = ? AND deleted_at IS NULL
         AND (? IS NULL OR id <> ?)
       LIMIT 1`,
    [workspaceId, exclude, exclude]
  );
  if (existing) throw new ApiError(409, 'A workspace with this ID already exists');
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function workspaceScopedTables(
  client: DatabaseClient = requireDatabaseClient()
): Promise<string[]> {
  if (DATABASE_DIALECT === 'sqlite') {
    const rows = await client.all<{ name: string }>(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
       ORDER BY name ASC`
    );
    const tables: string[] = [];
    for (const row of rows) {
      if (row.name === 'workspaces') continue;
      const columns = await client.all<{ name: string }>(
        `PRAGMA table_info(${quoteIdentifier(row.name)})`
      );
      if (columns.some(column => column.name === 'workspace_id')) {
        tables.push(row.name);
      }
    }
    return tables;
  }

  const rows = await client.all<{ table_name: string }>(
    `SELECT c.table_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = current_schema()
        AND t.table_type = 'BASE TABLE'
        AND c.column_name = 'workspace_id'
        AND c.table_name <> 'workspaces'
      ORDER BY c.table_name ASC`
  );
  return rows.map(row => row.table_name);
}

async function rekeyWorkspaceReferences({
  oldWorkspaceId,
  newWorkspaceId,
  client
}: {
  oldWorkspaceId: string;
  newWorkspaceId: string;
  client: DatabaseClient;
}): Promise<void> {
  if (oldWorkspaceId === newWorkspaceId) return;
  if (DATABASE_DIALECT === 'sqlite') {
    await client.exec('PRAGMA defer_foreign_keys = ON');
  } else {
    await client.exec('SET CONSTRAINTS ALL DEFERRED');
  }
  for (const table of await workspaceScopedTables(client)) {
    await client.run(
      `UPDATE ${quoteIdentifier(table)}
          SET workspace_id = ?
        WHERE workspace_id = ?`,
      [newWorkspaceId, oldWorkspaceId]
    );
  }
  await client.run(
    `UPDATE mission_sequences
        SET scope_id = ?
      WHERE scope_type = 'workspace' AND scope_id = ?`,
    [newWorkspaceId, oldWorkspaceId]
  );
}

// Workspace slugs are globally unique (idx_workspaces_slug). Append a numeric
// suffix until we find a free slug so creation never trips the constraint.
// `excludeWorkspaceId` lets re-slugging a workspace keep (or reuse) its own slug.
async function uniqueWorkspaceSlug({
  desired,
  excludeWorkspaceId,
  client = requireDatabaseClient()
}: {
  desired: string;
  excludeWorkspaceId?: string;
  client?: DatabaseClient;
}): Promise<string> {
  const taken = (
    await client.all<{ slug: string }>(`SELECT slug FROM workspaces WHERE id IS NOT ?`, [
      excludeWorkspaceId ?? null
    ])
  ).map(r => r.slug);
  const set = new Set(taken);
  if (!set.has(desired)) return desired;
  for (let n = 2; ; n += 1) {
    const candidate = `${desired}-${n}`.slice(0, 48);
    if (!set.has(candidate)) return candidate;
  }
}

/**
 * The local operator profile that new workspace memberships are attached to.
 * We reuse the profile behind the active workspace's actor so the operator
 * becomes a member of every workspace they create; failing that, the oldest
 * active human profile in the database.
 */
async function resolveLocalUserId(
  client: DatabaseClient = requireDatabaseClient()
): Promise<string> {
  if (getActorWorkspaceUserId()) {
    const row = await client.get<{ profile_id: string }>(
      `SELECT profile_id FROM workspace_users WHERE id = ?`,
      [getActorWorkspaceUserId()]
    );
    if (row) return row.profile_id;
  }
  const fallback = await client.get<{ id: string }>(
    `SELECT id FROM profiles
       WHERE kind = 'human' AND status = 'active' AND deleted_at IS NULL
       ORDER BY created_at ASC LIMIT 1`
  );
  if (!fallback) throw new ApiError(409, 'No local user exists to own the workspace');
  return fallback.id;
}

async function resolveCurrentProfileId(
  client: DatabaseClient = requireDatabaseClient()
): Promise<string> {
  if (getActorWorkspaceUserId()) {
    const row = await client.get<{ profile_id: string }>(
      `SELECT profile_id FROM workspace_users WHERE id = ?`,
      [getActorWorkspaceUserId()]
    );
    if (row) return row.profile_id;
  }
  return resolveLocalUserId(client);
}

async function requireWorkspaceAdmin(workspaceId: string): Promise<void> {
  const membership = await requireDatabaseClient().get<{ id: string }>(
    `SELECT id FROM workspace_users
       WHERE workspace_id = ? AND profile_id = ? AND status = 'active' AND deleted_at IS NULL
       ORDER BY created_at ASC LIMIT 1`,
    [workspaceId, await resolveCurrentProfileId()]
  );
  if (!membership || !(await actorIsAdmin({ workspaceId, workspaceUserId: membership.id }))) {
    throw new ApiError(403, 'Admin role required');
  }
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

/** Every workspace the local operator is an active member of. */
export async function listWorkspaces(): Promise<WorkspaceDto[]> {
  const localUserId = await resolveLocalUserId();
  const rows = await requireDatabaseClient().all<WorkspaceListRow>(
    `SELECT w.id, w.slug, w.name, w.kind, w.created_at,
            (SELECT COUNT(*) FROM projects p
               WHERE p.workspace_id = w.id AND p.deleted_at IS NULL) AS project_count,
            (SELECT COUNT(*) FROM workspace_users m
               WHERE m.workspace_id = w.id AND m.status = 'active'
                 AND m.deleted_at IS NULL) AS member_count
       FROM workspaces w
       JOIN workspace_users wu
         ON wu.workspace_id = w.id AND wu.profile_id = ?
        AND wu.status = 'active' AND wu.deleted_at IS NULL
      WHERE w.deleted_at IS NULL
      ORDER BY w.created_at ASC`,
    [localUserId]
  );
  return Promise.all(rows.map(toWorkspaceDto));
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
        status.isDefault ? 1 : 0,
        status.isTerminal ? 1 : 0,
        now,
        now
      ]
    );
  }
}

/** Create a workspace, add the local operator as an admin member, and make it active. */
export async function createWorkspace(body: CreateWorkspaceBody): Promise<WorkspaceDto> {
  const workspaceId = await requireDatabaseClient().transaction(async tx => {
    const name = (body.name ?? '').trim();
    if (!name) throw new ApiError(400, 'Workspace name is required');

    const nextWorkspaceId = desiredWorkspaceId(body.id, name);
    await ensureWorkspaceIdAvailable({ workspaceId: nextWorkspaceId, client: tx });
    const slug = await uniqueWorkspaceSlug({
      desired: body.slug?.trim() ? slugify(body.slug) : suggestSlugFromName(name),
      client: tx
    });
    const localUserId = await resolveLocalUserId(tx);

    const now = nowIso();
    const workspaceUserId = newId();

    await tx.run(
      `INSERT INTO workspaces (id, slug, name, kind, settings_json, created_at, updated_at, revision)
       VALUES (?, ?, ?, 'local', '{}', ?, ?, 1)`,
      [nextWorkspaceId, slug, name, now, now]
    );

    await tx.run(
      `INSERT INTO workspace_users
         (id, workspace_id, profile_id, member_key, status, metadata_json,
          created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, 'active', '{}', ?, ?, 1)`,
      [workspaceUserId, nextWorkspaceId, localUserId, `local:${slug}`, now, now]
    );

    await grantWorkspaceAdminRole({ workspaceId: nextWorkspaceId, workspaceUserId, client: tx });

    await seedWorkspaceStatuses({ workspaceId: nextWorkspaceId, now, client: tx });

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

  // New workspaces become the active one, mirroring the team switcher: creating
  // a workspace drops you into it.
  await setActiveWorkspace(workspaceId);
  const created = (await listWorkspaces()).find(w => w.id === workspaceId);
  if (!created) throw new ApiError(500, 'Workspace was created but could not be loaded');
  return created;
}

// ---- initial instance setup ----------------------------------------------
//
// Migration 001 seeds every fresh instance with a placeholder first workspace.
// Until the operator has named it (and picked the slug that prefixes mission
// identifiers like `<slug>:42`), the web UI shows a one-time setup step.

const SEED_WORKSPACE_ID = 'local-workspace';
const SEED_WORKSPACE_NAME = 'Local Workspace';
const SEED_WORKSPACE_SLUG = 'local';
/** `settings_json` key set once the operator completes (or re-confirms) setup. */
const SETUP_COMPLETED_KEY = 'initialSetupCompletedAt';

/**
 * Whether the active workspace is still the untouched seeded placeholder. True
 * only while it keeps the exact seed identity and setup was never completed,
 * so existing instances that already renamed their workspace are never gated.
 */
export async function needsInitialSetup(): Promise<boolean> {
  if (WORKSPACE.id !== SEED_WORKSPACE_ID) return false;
  const row = await requireDatabaseClient().get<{
    name: string;
    slug: string;
    settings_json: string;
  }>(`SELECT name, slug, settings_json FROM workspaces WHERE id = ? AND deleted_at IS NULL`, [
    SEED_WORKSPACE_ID
  ]);
  if (!row) return false;
  if (row.name !== SEED_WORKSPACE_NAME || row.slug !== SEED_WORKSPACE_SLUG) return false;
  return !parseSettings(row.settings_json)[SETUP_COMPLETED_KEY];
}

function parseSettings(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** First three letters of the name as a slug, matching the setup UI's hint. */
function suggestSlugFromName(name: string): string {
  const letters = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 3);
  return letters.length > 0 ? letters : 'workspace';
}

/**
 * Complete initial instance setup: name the seeded first workspace, set the
 * slug that prefixes mission identifiers, and mark setup done so the step never
 * reappears (even when the chosen values match the seed defaults).
 */
export async function completeInitialSetup(body: CompleteInitialSetupBody): Promise<WorkspaceDto> {
  const workspaceId = await requireDatabaseClient().transaction(async tx => {
    // Setup only ever names the untouched seeded workspace; once done (or after
    // the operator has renamed/created workspaces) this endpoint must not rename
    // whatever workspace happens to be active.
    if (!(await needsInitialSetup())) throw new ApiError(409, 'Initial setup is already complete');

    const name = (body.name ?? '').trim();
    if (!name) throw new ApiError(400, 'Workspace name is required');

    const existing = await tx.get<{ id: string; settings_json: string; revision: number }>(
      `SELECT id, settings_json, revision FROM workspaces WHERE id = ? AND deleted_at IS NULL`,
      [WORKSPACE.id]
    );
    if (!existing) throw new ApiError(404, 'Workspace not found');

    const nextWorkspaceId = desiredWorkspaceId(body.id, name);
    await ensureWorkspaceIdAvailable({
      workspaceId: nextWorkspaceId,
      excludeWorkspaceId: existing.id,
      client: tx
    });

    // Default the slug to the first three letters of the name, mirroring the
    // suggestion the setup UI shows.
    const desiredSlug = body.slug?.trim() ? slugify(body.slug) : suggestSlugFromName(name);
    const slug = await uniqueWorkspaceSlug({
      desired: desiredSlug,
      excludeWorkspaceId: existing.id,
      client: tx
    });

    const settings = parseSettings(existing.settings_json);
    settings[SETUP_COMPLETED_KEY] = nowIso();

    await rekeyWorkspaceReferences({
      oldWorkspaceId: existing.id,
      newWorkspaceId: nextWorkspaceId,
      client: tx
    });

    const revision = existing.revision + 1;
    await tx.run(
      `UPDATE workspaces
          SET id = ?, name = ?, slug = ?, settings_json = ?,
              updated_at = ?, revision = ?
        WHERE id = ?`,
      [nextWorkspaceId, name, slug, JSON.stringify(settings), nowIso(), revision, existing.id]
    );

    await recordChange(
      {
        entityType: 'workspace',
        entityId: nextWorkspaceId,
        operation: 'update',
        entityRevision: revision,
        workspaceId: nextWorkspaceId,
        actorWorkspaceUserId: await resolveActorForWorkspace(nextWorkspaceId, tx),
        changedFields: nextWorkspaceId === existing.id ? ['name', 'slug'] : ['id', 'name', 'slug']
      },
      tx
    );

    return nextWorkspaceId;
  });

  // Initial setup may re-key the seeded workspace. Re-point the live workspace
  // binding when that happens so `/api/meta` and mission display ids stay in sync.
  if (workspaceId === WORKSPACE.id) await reloadActiveWorkspace();
  else await setActiveWorkspace(workspaceId);
  const updated = (await listWorkspaces()).find(w => w.id === workspaceId);
  if (!updated) throw new ApiError(500, 'Workspace was updated but could not be loaded');
  return updated;
}

interface WorkspaceRevisionRow {
  id: string;
  name: string;
  revision: number;
}

/** Update a workspace (rename) and return its refreshed DTO. */
export async function updateWorkspace(
  id: string,
  body: UpdateWorkspaceBody
): Promise<WorkspaceDto> {
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
      await requireAdmin();
      const current = await readSqlStudioEnabled({ workspaceId: id });
      if (body.sqlStudioEnabled !== current) {
        await writeSqlStudioEnabled({ workspaceId: id, enabled: body.sqlStudioEnabled });
        changed.push('settings_json');
        if (id === WORKSPACE.id) {
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
  if (id === WORKSPACE.id) await reloadActiveWorkspace();
  const updated = (await listWorkspaces()).find(w => w.id === id);
  if (!updated) throw new ApiError(404, 'Workspace not found or no active membership');
  return updated;
}

/**
 * Soft-delete a workspace (tombstone via `deleted_at`; projects and missions
 * inside it are preserved but unreachable until restored). The last remaining
 * workspace cannot be deleted. Deleting the active workspace activates the
 * oldest remaining one. Returns the refreshed workspace list.
 */
export async function deleteWorkspace(id: string): Promise<WorkspaceDto[]> {
  await requireDatabaseClient().transaction(async tx => {
    const existing = await tx.get<WorkspaceRevisionRow>(
      `SELECT id, name, revision FROM workspaces WHERE id = ? AND deleted_at IS NULL`,
      [id]
    );
    if (!existing) throw new ApiError(404, 'Workspace not found');

    const remaining = (await listWorkspaces()).filter(w => w.id !== id);
    if (remaining.length === 0) {
      throw new ApiError(409, 'Cannot delete the only workspace');
    }

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
  });

  if (id === WORKSPACE.id) {
    const next = (await listWorkspaces())[0];
    if (next) await setActiveWorkspace(next.id);
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

/** Active members of a workspace (`workspace_users` joined to `profiles`). */
export async function listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMemberDto[]> {
  const workspace = await requireDatabaseClient().get<{ id: string }>(
    `SELECT id FROM workspaces WHERE id = ? AND deleted_at IS NULL`,
    [workspaceId]
  );
  if (!workspace) throw new ApiError(404, 'Workspace not found');

  const localUserId = await resolveLocalUserId();
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

  return rows.map(r => {
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
      isOperator: r.profile_id === localUserId,
      joinedAt: r.joined_at,
      avatarUrl
    };
  });
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
    DATABASE_DIALECT === 'sqlite' ? 'p.name COLLATE NOCASE ASC' : 'LOWER(p.name) ASC';
  const missionOrder =
    DATABASE_DIALECT === 'sqlite' ? 'm.title COLLATE NOCASE ASC' : 'LOWER(m.title) ASC';

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

/** Switch the active workspace and return the refreshed workspace list. */
export async function activateWorkspace(id: string): Promise<WorkspaceDto[]> {
  // Validate membership (which also implies existence) before switching so a
  // bad id never leaves the server pointed at a workspace with no actor.
  if ((await resolveActorForWorkspace(id)) === null) {
    throw new ApiError(404, 'Workspace not found or no active membership');
  }
  if (!(await setActiveWorkspace(id))) throw new ApiError(404, 'Workspace not found');
  syncSqlStudioForWorkspace({ enabled: await readSqlStudioEnabled({ workspaceId: id }) });
  return listWorkspaces();
}
