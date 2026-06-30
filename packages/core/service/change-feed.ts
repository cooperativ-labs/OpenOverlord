import type { DatabaseClient } from '@overlord/database';

import type { ServiceContext } from './context.js';
import { newId, nowIso } from './util.js';

// Mirrors the canonical `ChangeOperation` in `@overlord/contract`. Kept as a
// local definition because `@overlord/core` does not depend on the contract
// package; it must stay a superset of every operation either data layer records.
export type ChangeOperation = 'insert' | 'update' | 'delete' | 'restore';

/**
 * The fully-resolved column values for one `entity_changes` row. Every caller
 * resolves its own context (workspace/actor/source/token) and hands the result
 * to {@link insertEntityChange}, so the raw SQL and column order live in exactly
 * one place and the REST and protocol writers cannot silently diverge.
 */
export interface EntityChangeFields {
  workspaceId: string;
  projectId?: string | null;
  missionId?: string | null;
  objectiveId?: string | null;
  entityType: string;
  entityId: string;
  operation: ChangeOperation;
  entityRevision?: number | null;
  changedFields?: string[];
  actorWorkspaceUserId: string | null;
  /** REST path fills this from the active token; the protocol path leaves it NULL. */
  actorTokenId?: string | null;
  source: string;
}

/**
 * The single `entity_changes` writer shared by both data layers (the REST
 * `webapp/server/db.ts` path and the protocol/CLI service path). This must run
 * inside the same transaction as the domain mutation so the realtime feed never
 * diverges from the data; the realtime poller turns these rows into SSE deltas.
 */
export async function insertEntityChange(
  client: DatabaseClient,
  fields: EntityChangeFields
): Promise<void> {
  await client.run(
    `INSERT INTO entity_changes (
         id, workspace_id, project_id, mission_id, objective_id,
         entity_type, entity_id, operation, entity_revision,
         changed_fields_json, actor_workspace_user_id, actor_token_id, source, occurred_at
       ) VALUES (
         ?, ?, ?, ?, ?,
         ?, ?, ?, ?,
         ?, ?, ?, ?, ?
       )`,
    [
      newId(),
      fields.workspaceId,
      fields.projectId ?? null,
      fields.missionId ?? null,
      fields.objectiveId ?? null,
      fields.entityType,
      fields.entityId,
      fields.operation,
      fields.entityRevision ?? null,
      JSON.stringify(fields.changedFields ?? []),
      fields.actorWorkspaceUserId,
      fields.actorTokenId ?? null,
      fields.source,
      nowIso()
    ]
  );
}

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
  await insertEntityChange(ctx.db, {
    workspaceId: ctx.workspace.id,
    projectId,
    missionId,
    objectiveId,
    entityType,
    entityId,
    operation,
    entityRevision,
    changedFields,
    actorWorkspaceUserId: ctx.actorWorkspaceUserId,
    // The protocol/service path does not attribute changes to a token.
    actorTokenId: null,
    source: ctx.source
  });
}
