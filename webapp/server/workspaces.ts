import type { CreateWorkspaceBody, WorkspaceDto } from '../shared/contract.ts';

import {
  ACTOR_WORKSPACE_USER_ID,
  db,
  newId,
  nowIso,
  recordChange,
  resolveActorForWorkspace,
  setActiveWorkspace,
  WORKSPACE
} from './db.ts';
import { ApiError } from './errors.ts';

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

// Workspace slugs are globally unique (idx_workspaces_slug). Append a numeric
// suffix until we find a free slug so creation never trips the constraint.
function uniqueWorkspaceSlug(desired: string): string {
  const taken = (db.prepare(`SELECT slug FROM workspaces`).all() as Array<{ slug: string }>).map(
    r => r.slug
  );
  const set = new Set(taken);
  if (!set.has(desired)) return desired;
  for (let n = 2; ; n += 1) {
    const candidate = `${desired}-${n}`.slice(0, 48);
    if (!set.has(candidate)) return candidate;
  }
}

/**
 * The local operator user that new workspace memberships are attached to. We
 * reuse the user behind the active workspace's actor so the operator becomes a
 * member of every workspace they create; failing that, the oldest active human
 * user in the database.
 */
function resolveLocalUserId(): string {
  if (ACTOR_WORKSPACE_USER_ID) {
    const row = db
      .prepare(`SELECT user_id FROM workspace_users WHERE id = ?`)
      .get(ACTOR_WORKSPACE_USER_ID) as { user_id: string } | undefined;
    if (row) return row.user_id;
  }
  const fallback = db
    .prepare(
      `SELECT id FROM users
         WHERE kind = 'human' AND status = 'active' AND deleted_at IS NULL
         ORDER BY created_at ASC LIMIT 1`
    )
    .get() as { id: string } | undefined;
  if (!fallback) throw new ApiError(409, 'No local user exists to own the workspace');
  return fallback.id;
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
           ON wu.workspace_id = w.id AND wu.user_id = @user_id
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

  const slug = uniqueWorkspaceSlug(body.slug?.trim() ? slugify(body.slug) : slugify(name));
  const localUserId = resolveLocalUserId();

  const now = nowIso();
  const workspaceId = newId();
  const workspaceUserId = newId();

  db.prepare(
    `INSERT INTO workspaces (id, slug, name, kind, settings_json, created_at, updated_at, revision)
     VALUES (@id, @slug, @name, 'local', '{}', @now, @now, 1)`
  ).run({ id: workspaceId, slug, name, now });

  db.prepare(
    `INSERT INTO workspace_users
       (id, workspace_id, user_id, member_key, status, display_name, metadata_json,
        created_at, updated_at, revision)
     VALUES (@id, @workspace_id, @user_id, @member_key, 'active', NULL, '{}', @now, @now, 1)`
  ).run({
    id: workspaceUserId,
    workspace_id: workspaceId,
    user_id: localUserId,
    member_key: `local:${slug}`,
    now
  });

  recordChange({
    entityType: 'workspace',
    entityId: workspaceId,
    operation: 'insert',
    entityRevision: 1,
    workspaceId,
    actorWorkspaceUserId: workspaceUserId
  });

  return workspaceId;
});

/** Create a workspace, add the local operator as a member, and make it active. */
export function createWorkspace(body: CreateWorkspaceBody): WorkspaceDto {
  const workspaceId = createWorkspaceTx(body);
  // New workspaces become the active one, mirroring the team switcher: creating
  // a workspace drops you into it.
  setActiveWorkspace(workspaceId);
  const created = listWorkspaces().find(w => w.id === workspaceId);
  if (!created) throw new ApiError(500, 'Workspace was created but could not be loaded');
  return created;
}

/** Switch the active workspace and return the refreshed workspace list. */
export function activateWorkspace(id: string): WorkspaceDto[] {
  // Validate membership (which also implies existence) before switching so a
  // bad id never leaves the server pointed at a workspace with no actor.
  if (resolveActorForWorkspace(id) === null) {
    throw new ApiError(404, 'Workspace not found or no active membership');
  }
  if (!setActiveWorkspace(id)) throw new ApiError(404, 'Workspace not found');
  return listWorkspaces();
}
