import { type OverlordDatabase, SEED_WORKSPACE_ID } from '@overlord/database';

import { ServiceError } from './errors.js';

export type WorkspaceContext = {
  id: string;
  slug: string;
  name: string;
};

export type ServiceContext = {
  db: OverlordDatabase;
  workspace: WorkspaceContext;
  actorWorkspaceUserId: string | null;
  source: 'cli' | 'protocol' | 'webapp' | 'runner';
};

export function createServiceContext({
  db,
  source
}: {
  db: OverlordDatabase;
  source: ServiceContext['source'];
}): ServiceContext {
  const workspace = db
    .prepare(
      `SELECT id, slug, name FROM workspaces
       WHERE deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`
    )
    .get() as WorkspaceContext | undefined;

  if (!workspace) {
    throw new ServiceError(
      'No workspace found. Run `ovld init` and `yarn start:local` first.',
      'no_workspace',
      503
    );
  }

  const actor = db
    .prepare(
      `SELECT id FROM workspace_users
       WHERE workspace_id = ? AND status = 'active' AND deleted_at IS NULL
       ORDER BY created_at ASC LIMIT 1`
    )
    .get(workspace.id) as { id: string } | undefined;

  return {
    db,
    workspace,
    actorWorkspaceUserId: actor?.id ?? null,
    source
  };
}

export function resolveTicketId(
  ctx: ServiceContext,
  ticketRef: string
): { id: string; displayId: string; projectId: string } {
  const byId = ctx.db
    .prepare(
      `SELECT id, display_id, project_id FROM tickets
       WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
    )
    .get(ticketRef, ctx.workspace.id) as
    | { id: string; display_id: string; project_id: string }
    | undefined;

  if (byId) {
    return { id: byId.id, displayId: byId.display_id, projectId: byId.project_id };
  }

  const byDisplay = ctx.db
    .prepare(
      `SELECT id, display_id, project_id FROM tickets
       WHERE display_id = ? AND workspace_id = ? AND deleted_at IS NULL`
    )
    .get(ticketRef, ctx.workspace.id) as
    | { id: string; display_id: string; project_id: string }
    | undefined;

  if (byDisplay) {
    return {
      id: byDisplay.id,
      displayId: byDisplay.display_id,
      projectId: byDisplay.project_id
    };
  }

  throw new ServiceError(`Ticket not found: ${ticketRef}`, 'ticket_not_found', 404);
}

export function resolveProjectId(ctx: ServiceContext, projectRef: string): string {
  const byId = ctx.db
    .prepare(
      `SELECT id FROM projects
       WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
    )
    .get(projectRef, ctx.workspace.id) as { id: string } | undefined;
  if (byId) return byId.id;

  const bySlug = ctx.db
    .prepare(
      `SELECT id FROM projects
       WHERE slug = ? AND workspace_id = ? AND deleted_at IS NULL`
    )
    .get(projectRef, ctx.workspace.id) as { id: string } | undefined;
  if (bySlug) return bySlug.id;

  const byName = ctx.db
    .prepare(
      `SELECT id FROM projects
       WHERE lower(name) = lower(?) AND workspace_id = ? AND deleted_at IS NULL`
    )
    .get(projectRef, ctx.workspace.id) as { id: string } | undefined;
  if (byName) return byName.id;

  throw new ServiceError(`Project not found: ${projectRef}`, 'project_not_found', 404);
}
