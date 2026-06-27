import { type DatabaseClient } from '@overlord/database';

import { ServiceError } from './errors.js';

export type WorkspaceContext = {
  id: string;
  slug: string;
  name: string;
};

export type ServiceContext = {
  db: DatabaseClient;
  workspace: WorkspaceContext;
  actorWorkspaceUserId: string | null;
  source: 'cli' | 'protocol' | 'webapp' | 'runner';
};

export async function createServiceContext({
  db,
  source
}: {
  db: DatabaseClient;
  source: ServiceContext['source'];
}): Promise<ServiceContext> {
  const workspace = await db.get<WorkspaceContext>(
    `SELECT id, slug, name FROM workspaces
       WHERE deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`
  );

  if (!workspace) {
    throw new ServiceError(
      'No workspace found. Run `ovld init` and `yarn start:local` first.',
      'no_workspace',
      503
    );
  }

  const actor = await db.get<{ id: string }>(
    `SELECT id FROM workspace_users
       WHERE workspace_id = ? AND status = 'active' AND deleted_at IS NULL
       ORDER BY created_at ASC LIMIT 1`,
    [workspace.id]
  );

  return {
    db,
    workspace,
    actorWorkspaceUserId: actor?.id ?? null,
    source
  };
}

export async function resolveMissionId(
  ctx: ServiceContext,
  missionRef: string
): Promise<{ id: string; displayId: string; projectId: string }> {
  const byId = await ctx.db.get<{ id: string; display_id: string; project_id: string }>(
    `SELECT id, display_id, project_id FROM missions
       WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [missionRef, ctx.workspace.id]
  );

  if (byId) {
    return { id: byId.id, displayId: byId.display_id, projectId: byId.project_id };
  }

  const byDisplay = await ctx.db.get<{ id: string; display_id: string; project_id: string }>(
    `SELECT id, display_id, project_id FROM missions
       WHERE display_id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [missionRef, ctx.workspace.id]
  );

  if (byDisplay) {
    return {
      id: byDisplay.id,
      displayId: byDisplay.display_id,
      projectId: byDisplay.project_id
    };
  }

  throw new ServiceError(`Mission not found: ${missionRef}`, 'mission_not_found', 404);
}

export async function resolveProjectId(ctx: ServiceContext, projectRef: string): Promise<string> {
  const byId = await ctx.db.get<{ id: string }>(
    `SELECT id FROM projects
       WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [projectRef, ctx.workspace.id]
  );
  if (byId) return byId.id;

  const bySlug = await ctx.db.get<{ id: string }>(
    `SELECT id FROM projects
       WHERE slug = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [projectRef, ctx.workspace.id]
  );
  if (bySlug) return bySlug.id;

  const byName = await ctx.db.get<{ id: string }>(
    `SELECT id FROM projects
       WHERE lower(name) = lower(?) AND workspace_id = ? AND deleted_at IS NULL`,
    [projectRef, ctx.workspace.id]
  );
  if (byName) return byName.id;

  throw new ServiceError(`Project not found: ${projectRef}`, 'project_not_found', 404);
}
