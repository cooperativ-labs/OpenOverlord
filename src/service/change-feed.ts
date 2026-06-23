import type { ServiceContext } from './context.js';
import { newId, nowIso } from './util.js';

export type ChangeOperation = 'insert' | 'update' | 'delete';

export function recordChange({
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
}): void {
  ctx.db
    .prepare(
      `INSERT INTO entity_changes (
         id, workspace_id, project_id, mission_id, objective_id,
         entity_type, entity_id, operation, entity_revision,
         changed_fields_json, actor_workspace_user_id, actor_token_id, source, occurred_at
       ) VALUES (
         @id, @workspace_id, @project_id, @mission_id, @objective_id,
         @entity_type, @entity_id, @operation, @entity_revision,
         @changed_fields_json, @actor_workspace_user_id, NULL, @source, @occurred_at
       )`
    )
    .run({
      id: newId(),
      workspace_id: ctx.workspace.id,
      project_id: projectId ?? null,
      mission_id: missionId ?? null,
      objective_id: objectiveId ?? null,
      entity_type: entityType,
      entity_id: entityId,
      operation,
      entity_revision: entityRevision ?? null,
      changed_fields_json: JSON.stringify(changedFields ?? []),
      actor_workspace_user_id: ctx.actorWorkspaceUserId,
      source: ctx.source,
      occurred_at: nowIso()
    });
}
