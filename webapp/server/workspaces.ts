import type {
  CompleteInitialSetupBody,
  CreateWorkspaceBody,
  UpdateWorkspaceBody,
  WorkspaceDto,
  WorkspaceMemberDto
} from '../shared/contract.ts';

import {
  ACTOR_WORKSPACE_USER_ID,
  db,
  newId,
  nowIso,
  recordChange,
  reloadActiveWorkspace,
  resolveActorForWorkspace,
  setActiveWorkspace,
  WORKSPACE
} from './db.ts';
import { ApiError } from './errors.ts';
import { requireAdmin } from './rbac.ts';
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

function toWorkspaceDto(r: WorkspaceListRow): WorkspaceDto {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    kind: r.kind,
    isActive: r.id === WORKSPACE.id,
    projectCount: r.project_count,
    memberCount: r.member_count,
    sqlStudioEnabled: readSqlStudioEnabled({ workspaceId: r.id }),
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

function ensureWorkspaceIdAvailable(workspaceId: string, excludeWorkspaceId?: string): void {
  const existing = db
    .prepare(
      `SELECT id FROM workspaces
         WHERE id = @id AND deleted_at IS NULL
           AND (@exclude IS NULL OR id IS NOT @exclude)
         LIMIT 1`
    )
    .get({ id: workspaceId, exclude: excludeWorkspaceId ?? null }) as { id: string } | undefined;
  if (existing) throw new ApiError(409, 'A workspace with this ID already exists');
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

const workspaceScopedTables = (
  db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
       ORDER BY name ASC`
    )
    .all() as Array<{ name: string }>
)
  .map(row => row.name)
  .filter(name => name !== 'workspaces')
  .filter(name => {
    const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as Array<{
      name: string;
    }>;
    return columns.some(column => column.name === 'workspace_id');
  });

function rekeyWorkspaceReferences(oldWorkspaceId: string, newWorkspaceId: string): void {
  if (oldWorkspaceId === newWorkspaceId) return;
  db.exec('PRAGMA defer_foreign_keys = ON');
  for (const table of workspaceScopedTables) {
    db.prepare(
      `UPDATE ${quoteIdentifier(table)}
          SET workspace_id = @next
        WHERE workspace_id = @previous`
    ).run({ previous: oldWorkspaceId, next: newWorkspaceId });
  }
  db.prepare(
    `UPDATE ticket_sequences
        SET scope_id = @next
      WHERE scope_type = 'workspace' AND scope_id = @previous`
  ).run({ previous: oldWorkspaceId, next: newWorkspaceId });
}

// Workspace slugs are globally unique (idx_workspaces_slug). Append a numeric
// suffix until we find a free slug so creation never trips the constraint.
// `excludeWorkspaceId` lets re-slugging a workspace keep (or reuse) its own slug.
function uniqueWorkspaceSlug(desired: string, excludeWorkspaceId?: string): string {
  const taken = (
    db
      .prepare(`SELECT slug FROM workspaces WHERE id IS NOT @exclude`)
      .all({ exclude: excludeWorkspaceId ?? null }) as Array<{ slug: string }>
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
function resolveLocalUserId(): string {
  if (ACTOR_WORKSPACE_USER_ID) {
    const row = db
      .prepare(`SELECT profile_id FROM workspace_users WHERE id = ?`)
      .get(ACTOR_WORKSPACE_USER_ID) as { profile_id: string } | undefined;
    if (row) return row.profile_id;
  }
  const fallback = db
    .prepare(
      `SELECT id FROM profiles
         WHERE kind = 'human' AND status = 'active' AND deleted_at IS NULL
         ORDER BY created_at ASC LIMIT 1`
    )
    .get() as { id: string } | undefined;
  if (!fallback) throw new ApiError(409, 'No local user exists to own the workspace');
  return fallback.id;
}

/** Grant workspace-level ADMIN when a member has no active role rows yet. */
export function grantWorkspaceAdminRole({
  workspaceId,
  workspaceUserId,
  assignedByWorkspaceUserId = workspaceUserId
}: {
  workspaceId: string;
  workspaceUserId: string;
  assignedByWorkspaceUserId?: string;
}): void {
  const existing = db
    .prepare(
      `SELECT 1 FROM role_assignments
         WHERE workspace_id = ? AND workspace_user_id = ? AND deleted_at IS NULL
         LIMIT 1`
    )
    .get(workspaceId, workspaceUserId);
  if (existing) return;

  const now = nowIso();
  db.prepare(
    `INSERT INTO role_assignments
       (id, workspace_id, workspace_user_id, role_key, resource_type, resource_id,
        assigned_by_workspace_user_id, created_at, updated_at, revision)
     VALUES
       (@id, @workspace_id, @workspace_user_id, 'ADMIN', '', '',
        @assigned_by_workspace_user_id, @now, @now, 1)`
  ).run({
    id: newId(),
    workspace_id: workspaceId,
    workspace_user_id: workspaceUserId,
    assigned_by_workspace_user_id: assignedByWorkspaceUserId,
    now
  });
}

// ---- operations ----------------------------------------------------------

/** Every workspace the local operator is an active member of. */
export function listWorkspaces(): WorkspaceDto[] {
  const localUserId = resolveLocalUserId();
  const rows = db
    .prepare(
      `SELECT w.id, w.slug, w.name, w.kind, w.created_at,
              (SELECT COUNT(*) FROM projects p
                 WHERE p.workspace_id = w.id AND p.deleted_at IS NULL) AS project_count,
              (SELECT COUNT(*) FROM workspace_users m
                 WHERE m.workspace_id = w.id AND m.status = 'active'
                   AND m.deleted_at IS NULL) AS member_count
         FROM workspaces w
         JOIN workspace_users wu
           ON wu.workspace_id = w.id AND wu.profile_id = @user_id
          AND wu.status = 'active' AND wu.deleted_at IS NULL
        WHERE w.deleted_at IS NULL
        ORDER BY w.created_at ASC`
    )
    .all({ user_id: localUserId }) as WorkspaceListRow[];
  return rows.map(toWorkspaceDto);
}

const createWorkspaceTx = db.transaction((body: CreateWorkspaceBody): string => {
  const name = (body.name ?? '').trim();
  if (!name) throw new ApiError(400, 'Workspace name is required');

  const workspaceId = desiredWorkspaceId(body.id, name);
  ensureWorkspaceIdAvailable(workspaceId);
  const slug = uniqueWorkspaceSlug(
    body.slug?.trim() ? slugify(body.slug) : suggestSlugFromName(name)
  );
  const localUserId = resolveLocalUserId();

  const now = nowIso();
  const workspaceUserId = newId();

  db.prepare(
    `INSERT INTO workspaces (id, slug, name, kind, settings_json, created_at, updated_at, revision)
     VALUES (@id, @slug, @name, 'local', '{}', @now, @now, 1)`
  ).run({ id: workspaceId, slug, name, now });

  db.prepare(
    `INSERT INTO workspace_users
       (id, workspace_id, profile_id, member_key, status, metadata_json,
        created_at, updated_at, revision)
     VALUES (@id, @workspace_id, @user_id, @member_key, 'active', '{}', @now, @now, 1)`
  ).run({
    id: workspaceUserId,
    workspace_id: workspaceId,
    user_id: localUserId,
    member_key: `local:${slug}`,
    now
  });

  grantWorkspaceAdminRole({ workspaceId, workspaceUserId });

  recordChange({
    entityType: 'workspace',
    entityId: workspaceId,
    operation: 'insert',
    entityRevision: 1,
    workspaceId,
    actorWorkspaceUserId: workspaceUserId
  });

  recordChange({
    entityType: 'workspace_user',
    entityId: workspaceUserId,
    operation: 'insert',
    entityRevision: 1,
    workspaceId,
    actorWorkspaceUserId: workspaceUserId
  });

  return workspaceId;
});

/** Create a workspace, add the local operator as an admin member, and make it active. */
export function createWorkspace(body: CreateWorkspaceBody): WorkspaceDto {
  const workspaceId = createWorkspaceTx(body);
  // New workspaces become the active one, mirroring the team switcher: creating
  // a workspace drops you into it.
  setActiveWorkspace(workspaceId);
  const created = listWorkspaces().find(w => w.id === workspaceId);
  if (!created) throw new ApiError(500, 'Workspace was created but could not be loaded');
  return created;
}

// ---- initial instance setup ----------------------------------------------
//
// Migration 001 seeds every fresh instance with a placeholder first workspace.
// Until the operator has named it (and picked the slug that prefixes ticket
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
export function needsInitialSetup(): boolean {
  if (WORKSPACE.id !== SEED_WORKSPACE_ID) return false;
  const row = db
    .prepare(`SELECT name, slug, settings_json FROM workspaces WHERE id = ? AND deleted_at IS NULL`)
    .get(SEED_WORKSPACE_ID) as { name: string; slug: string; settings_json: string } | undefined;
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

const completeInitialSetupTx = db.transaction((body: CompleteInitialSetupBody): string => {
  // Setup only ever names the untouched seeded workspace; once done (or after
  // the operator has renamed/created workspaces) this endpoint must not rename
  // whatever workspace happens to be active.
  if (!needsInitialSetup()) throw new ApiError(409, 'Initial setup is already complete');

  const name = (body.name ?? '').trim();
  if (!name) throw new ApiError(400, 'Workspace name is required');

  const existing = db
    .prepare(
      `SELECT id, settings_json, revision FROM workspaces WHERE id = ? AND deleted_at IS NULL`
    )
    .get(WORKSPACE.id) as { id: string; settings_json: string; revision: number } | undefined;
  if (!existing) throw new ApiError(404, 'Workspace not found');

  const workspaceId = desiredWorkspaceId(body.id, name);
  ensureWorkspaceIdAvailable(workspaceId, existing.id);

  // Default the slug to the first three letters of the name, mirroring the
  // suggestion the setup UI shows.
  const desiredSlug = body.slug?.trim() ? slugify(body.slug) : suggestSlugFromName(name);
  const slug = uniqueWorkspaceSlug(desiredSlug, existing.id);

  const settings = parseSettings(existing.settings_json);
  settings[SETUP_COMPLETED_KEY] = nowIso();

  rekeyWorkspaceReferences(existing.id, workspaceId);

  const revision = existing.revision + 1;
  db.prepare(
    `UPDATE workspaces
        SET id = @workspace_id, name = @name, slug = @slug, settings_json = @settings,
            updated_at = @now, revision = @revision
      WHERE id = @id`
  ).run({
    id: existing.id,
    workspace_id: workspaceId,
    name,
    slug,
    settings: JSON.stringify(settings),
    now: nowIso(),
    revision
  });

  recordChange({
    entityType: 'workspace',
    entityId: workspaceId,
    operation: 'update',
    entityRevision: revision,
    workspaceId: workspaceId,
    actorWorkspaceUserId: resolveActorForWorkspace(workspaceId),
    changedFields: workspaceId === existing.id ? ['name', 'slug'] : ['id', 'name', 'slug']
  });

  return workspaceId;
});

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
 * slug that prefixes ticket identifiers, and mark setup done so the step never
 * reappears (even when the chosen values match the seed defaults).
 */
export function completeInitialSetup(body: CompleteInitialSetupBody): WorkspaceDto {
  const workspaceId = completeInitialSetupTx(body);
  // Initial setup may re-key the seeded workspace. Re-point the live workspace
  // binding when that happens so `/api/meta` and ticket display ids stay in sync.
  if (workspaceId === WORKSPACE.id) reloadActiveWorkspace();
  else setActiveWorkspace(workspaceId);
  const updated = listWorkspaces().find(w => w.id === workspaceId);
  if (!updated) throw new ApiError(500, 'Workspace was updated but could not be loaded');
  return updated;
}

interface WorkspaceRevisionRow {
  id: string;
  name: string;
  revision: number;
}

const updateWorkspaceTx = db.transaction((id: string, body: UpdateWorkspaceBody): void => {
  const existing = db
    .prepare(`SELECT id, name, revision FROM workspaces WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as WorkspaceRevisionRow | undefined;
  if (!existing) throw new ApiError(404, 'Workspace not found');

  const changed: string[] = [];

  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) throw new ApiError(400, 'Workspace name cannot be empty');
    if (name !== existing.name) {
      db.prepare(
        `UPDATE workspaces SET name = @name, updated_at = @now, revision = revision + 1 WHERE id = @id`
      ).run({ id, name, now: nowIso() });
      changed.push('name');
    }
  }

  if (body.sqlStudioEnabled !== undefined) {
    requireAdmin();
    const current = readSqlStudioEnabled({ workspaceId: id });
    if (body.sqlStudioEnabled !== current) {
      writeSqlStudioEnabled({ workspaceId: id, enabled: body.sqlStudioEnabled });
      changed.push('settings_json');
      if (id === WORKSPACE.id) {
        syncSqlStudioForWorkspace({ enabled: body.sqlStudioEnabled });
      }
    }
  }

  if (changed.length === 0) return;

  const latest = db
    .prepare(`SELECT revision FROM workspaces WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as { revision: number };

  recordChange({
    entityType: 'workspace',
    entityId: id,
    operation: 'update',
    entityRevision: latest.revision,
    workspaceId: id,
    actorWorkspaceUserId: resolveActorForWorkspace(id),
    changedFields: changed
  });
});

/** Update a workspace (rename) and return its refreshed DTO. */
export function updateWorkspace(id: string, body: UpdateWorkspaceBody): WorkspaceDto {
  updateWorkspaceTx(id, body);
  // Renaming the active workspace must be observed by the `WORKSPACE` live
  // binding so `/api/meta` and change attribution stay accurate.
  if (id === WORKSPACE.id) reloadActiveWorkspace();
  const updated = listWorkspaces().find(w => w.id === id);
  if (!updated) throw new ApiError(404, 'Workspace not found or no active membership');
  return updated;
}

const deleteWorkspaceTx = db.transaction((id: string): void => {
  const existing = db
    .prepare(`SELECT id, name, revision FROM workspaces WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as WorkspaceRevisionRow | undefined;
  if (!existing) throw new ApiError(404, 'Workspace not found');

  const remaining = listWorkspaces().filter(w => w.id !== id);
  if (remaining.length === 0) {
    throw new ApiError(409, 'Cannot delete the only workspace');
  }

  const revision = existing.revision + 1;
  db.prepare(
    `UPDATE workspaces SET deleted_at = @now, updated_at = @now, revision = @revision
       WHERE id = @id`
  ).run({ id, now: nowIso(), revision });

  recordChange({
    entityType: 'workspace',
    entityId: id,
    operation: 'delete',
    entityRevision: revision,
    workspaceId: id,
    actorWorkspaceUserId: resolveActorForWorkspace(id)
  });
});

/**
 * Soft-delete a workspace (tombstone via `deleted_at`; projects and tickets
 * inside it are preserved but unreachable until restored). The last remaining
 * workspace cannot be deleted. Deleting the active workspace activates the
 * oldest remaining one. Returns the refreshed workspace list.
 */
export function deleteWorkspace(id: string): WorkspaceDto[] {
  deleteWorkspaceTx(id);
  if (id === WORKSPACE.id) {
    const next = listWorkspaces()[0];
    if (next) setActiveWorkspace(next.id);
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
export function listWorkspaceMembers(workspaceId: string): WorkspaceMemberDto[] {
  const workspace = db
    .prepare(`SELECT id FROM workspaces WHERE id = ? AND deleted_at IS NULL`)
    .get(workspaceId) as { id: string } | undefined;
  if (!workspace) throw new ApiError(404, 'Workspace not found');

  const localUserId = resolveLocalUserId();
  const rows = db
    .prepare(
      `SELECT wu.id AS workspace_user_id, wu.profile_id,
              wu.created_at AS joined_at,
              p.display_name, p.handle, p.email, p.kind, p.metadata_json
         FROM workspace_users wu
         JOIN profiles p ON p.id = wu.profile_id AND p.deleted_at IS NULL
        WHERE wu.workspace_id = ? AND wu.status = 'active' AND wu.deleted_at IS NULL
        ORDER BY wu.created_at ASC`
    )
    .all(workspaceId) as WorkspaceMemberRow[];

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

/** Switch the active workspace and return the refreshed workspace list. */
export function activateWorkspace(id: string): WorkspaceDto[] {
  // Validate membership (which also implies existence) before switching so a
  // bad id never leaves the server pointed at a workspace with no actor.
  if (resolveActorForWorkspace(id) === null) {
    throw new ApiError(404, 'Workspace not found or no active membership');
  }
  if (!setActiveWorkspace(id)) throw new ApiError(404, 'Workspace not found');
  syncSqlStudioForWorkspace({ enabled: readSqlStudioEnabled({ workspaceId: id }) });
  return listWorkspaces();
}
