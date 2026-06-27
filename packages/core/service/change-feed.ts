import type { ServiceContext } from './context.js';
import { newId, nowIso } from './util.js';

export type ChangeOperation = 'insert' | 'update' | 'delete';

export async function recordChange({
  ctx,
  entityType,
  entityId,
  operation,
  entityRevision,
  projectId,
  missionId,
  objectiveId,
  changedFields
}: {
  ctx: ServiceContext;
  entityType: string;
  entityId: string;
  operation: ChangeOperation;
  entityRevision?: number | null;
  projectId?: string | null;
  missionId?: string | null;
  objectiveId?: string | null;
  changedFields?: string[];
}): Promise<void> {
  await ctx.db.run(
    `INSERT INTO entity_changes (
         id, workspace_id, project_id, mission_id, objective_id,
         entity_type, entity_id, operation, entity_revision,
         changed_fields_json, actor_workspace_user_id, actor_token_id, source, occurred_at
       ) VALUES (
         ?, ?, ?, ?, ?,
         ?, ?, ?, ?,
         ?, ?, NULL, ?, ?
       )`,
    [
      newId(),
      ctx.workspace.id,
      projectId ?? null,
      missionId ?? null,
      objectiveId ?? null,
      entityType,
      entityId,
      operation,
      entityRevision ?? null,
      JSON.stringify(changedFields ?? []),
      ctx.actorWorkspaceUserId,
      ctx.source,
      nowIso()
    ]
  );
}
