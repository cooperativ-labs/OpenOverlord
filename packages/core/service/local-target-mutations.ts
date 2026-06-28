import { recordChange } from './change-feed.ts';
import type { ServiceContext } from './context.ts';
import { resolveMissionId, resolveProjectId } from './context.ts';
import { ServiceError } from './errors.ts';
import type { CapabilityFailure, CapabilitySuccess } from './local-target/types.ts';
import { newId, nowIso } from './util.ts';

export const LOCAL_TARGET_MUTATION_METADATA_KEY = 'overlord.localTargetMutation';
export const LOCAL_TARGET_MUTATION_REQUESTED_SOURCE = 'local_target_mutation';

export type LocalTargetMutationKind = 'branch_action' | 'worktree_purge';

export type LocalTargetMutationCapability =
  | 'performBranchAction'
  | 'purgeMergedWorktrees'
  | 'removeWorktree';

export type LocalTargetMutationPayload = {
  kind: LocalTargetMutationKind;
  capability: LocalTargetMutationCapability;
  input: Record<string, unknown>;
  result?:
    | { ok: true; value: unknown }
    | { ok: false; code: string; message: string; details?: unknown };
};

export type LocalTargetMutationResult =
  | CapabilitySuccess<unknown>
  | CapabilityFailure;

function parseMetadataObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function buildLocalTargetMutationMetadata({
  kind,
  capability,
  input
}: {
  kind: LocalTargetMutationKind;
  capability: LocalTargetMutationCapability;
  input: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    [LOCAL_TARGET_MUTATION_METADATA_KEY]: {
      kind,
      capability,
      input
    } satisfies LocalTargetMutationPayload
  };
}

export function parseLocalTargetMutation(
  metadataJson: string | Record<string, unknown>
): LocalTargetMutationPayload | null {
  const metadata =
    typeof metadataJson === 'string' ? parseMetadataObject(metadataJson) : metadataJson;
  const raw = metadata[LOCAL_TARGET_MUTATION_METADATA_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const payload = raw as Record<string, unknown>;
  const kind = payload.kind;
  const capability = payload.capability;
  if (kind !== 'branch_action' && kind !== 'worktree_purge') return null;
  if (
    capability !== 'performBranchAction' &&
    capability !== 'purgeMergedWorktrees' &&
    capability !== 'removeWorktree'
  ) {
    return null;
  }
  const input =
    payload.input && typeof payload.input === 'object' && !Array.isArray(payload.input)
      ? (payload.input as Record<string, unknown>)
      : {};
  const result = payload.result;
  const parsedResult =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as LocalTargetMutationPayload['result'])
      : undefined;
  return {
    kind,
    capability,
    input,
    ...(parsedResult ? { result: parsedResult } : {})
  };
}

export function isLocalTargetMutationMetadata(metadataJson: string): boolean {
  return parseLocalTargetMutation(metadataJson) !== null;
}

async function resolveMutationObjectiveId({
  ctx,
  missionId
}: {
  ctx: ServiceContext;
  missionId: string;
}): Promise<string> {
  const row = (await ctx.db.get(
    `SELECT id FROM objectives
        WHERE mission_id = ? AND workspace_id = ? AND deleted_at IS NULL
        ORDER BY position ASC
        LIMIT 1`,
    [missionId, ctx.workspace.id]
  )) as { id: string } | undefined;
  if (!row) {
    throw new ServiceError(
      'Mission has no objectives to anchor a local-target mutation request.',
      'no_objective_for_mutation',
      409
    );
  }
  return row.id;
}

export async function createLocalTargetMutationRequest({
  ctx,
  projectId,
  missionId,
  executionTargetId,
  kind,
  capability,
  input,
  eventSummary
}: {
  ctx: ServiceContext;
  projectId: string;
  missionId: string;
  executionTargetId: string;
  kind: LocalTargetMutationKind;
  capability: LocalTargetMutationCapability;
  input: Record<string, unknown>;
  eventSummary?: string;
}): Promise<{ id: string }> {
  const mission = await resolveMissionId(ctx, missionId);
  const resolvedProjectId = await resolveProjectId(ctx, projectId);
  const objectiveId = await resolveMutationObjectiveId({ ctx, missionId: mission.id });
  const now = nowIso();
  const id = newId();
  const metadata = buildLocalTargetMutationMetadata({ kind, capability, input });

  await ctx.db.transaction(async tx => {
    const txCtx = { ...ctx, db: tx };
    await txCtx.db.run(
      `INSERT INTO execution_requests
           (id, workspace_id, project_id, mission_id, objective_id, execution_target_id,
            requested_agent, requested_model, requested_reasoning_effort, launch_mode,
            launch_flags_json, target_kind, requested_source, idempotency_key, status,
            requested_by_workspace_user_id, resolved_resource_id, resolved_working_directory,
            metadata_json, created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'run', '{}', 'local', ?, NULL, 'queued', ?, NULL, NULL, ?, ?, ?, 1)`,
      [
        id,
        ctx.workspace.id,
        resolvedProjectId,
        mission.id,
        objectiveId,
        executionTargetId,
        LOCAL_TARGET_MUTATION_REQUESTED_SOURCE,
        ctx.actorWorkspaceUserId,
        JSON.stringify(metadata),
        now,
        now
      ]
    );
    await recordChange({
      ctx: txCtx,
      entityType: 'execution_request',
      entityId: id,
      operation: 'insert',
      entityRevision: 1,
      projectId: resolvedProjectId,
      missionId: mission.id,
      objectiveId,
      changedFields: ['status', 'requested_source', 'metadata_json']
    });
    await txCtx.db.run(
      `INSERT INTO mission_events
           (id, workspace_id, project_id, mission_id, objective_id, type, phase, summary,
            payload_json, source, actor_workspace_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, 'execution_requested', 'execute', ?, ?, 'webapp', ?, ?)`,
      [
        newId(),
        ctx.workspace.id,
        resolvedProjectId,
        mission.id,
        objectiveId,
        eventSummary ?? `Queued ${kind.replace('_', ' ')} on remote execution target.`,
        JSON.stringify({ executionRequestId: id, kind, capability }),
        ctx.actorWorkspaceUserId,
        now
      ]
    );
  });

  return { id };
}

export async function completeLocalTargetMutationRequest({
  ctx,
  requestId,
  result
}: {
  ctx: ServiceContext;
  requestId: string;
  result: LocalTargetMutationResult;
}): Promise<LocalTargetMutationPayload | null> {
  const row = (await ctx.db.get(
    `SELECT id, workspace_id, project_id, mission_id, objective_id, status, revision, metadata_json,
            requested_source
       FROM execution_requests
      WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [requestId, ctx.workspace.id]
  )) as
    | {
        id: string;
        workspace_id: string;
        project_id: string;
        mission_id: string;
        objective_id: string;
        status: string;
        revision: number;
        metadata_json: string;
        requested_source: string;
      }
    | undefined;

  if (!row) {
    throw new ServiceError('Execution request not found', 'execution_request_not_found', 404);
  }
  if (row.requested_source !== LOCAL_TARGET_MUTATION_REQUESTED_SOURCE) {
    throw new ServiceError(
      'Execution request is not a local-target mutation.',
      'not_local_target_mutation',
      409
    );
  }
  if (row.status !== 'launching' && row.status !== 'claimed') {
    throw new ServiceError(
      `Cannot complete local-target mutation from status ${row.status}.`,
      'invalid_execution_request_transition',
      409
    );
  }

  const mutation = parseLocalTargetMutation(row.metadata_json);
  if (!mutation) {
    throw new ServiceError(
      'Execution request is missing local-target mutation metadata.',
      'invalid_local_target_mutation',
      409
    );
  }

  const storedResult = result.ok
    ? { ok: true as const, value: result.value }
    : {
        ok: false as const,
        code: result.code,
        message: result.message,
        ...(result.details !== undefined ? { details: result.details } : {})
      };

  const metadata = parseMetadataObject(row.metadata_json);
  metadata[LOCAL_TARGET_MUTATION_METADATA_KEY] = {
    ...mutation,
    result: storedResult
  };

  const now = nowIso();
  const revision = row.revision + 1;
  const nextStatus = result.ok ? 'launched' : 'failed';
  const lastError = result.ok ? null : result.message;

  await ctx.db.transaction(async tx => {
    const txCtx = { ...ctx, db: tx };
    const updated = await txCtx.db.run(
      `UPDATE execution_requests
          SET status = ?,
              metadata_json = ?,
              last_error = ?,
              launch_completed_at = ?,
              updated_at = ?,
              revision = ?
        WHERE id = ? AND status = ? AND revision = ?`,
      [
        nextStatus,
        JSON.stringify(metadata),
        lastError,
        now,
        now,
        revision,
        row.id,
        row.status,
        row.revision
      ]
    );
    if (updated.changes === 0) {
      throw new ServiceError(
        'Execution request changed while completing local-target mutation.',
        'execution_request_conflict',
        409
      );
    }
    await recordChange({
      ctx: txCtx,
      entityType: 'execution_request',
      entityId: row.id,
      operation: 'update',
      entityRevision: revision,
      projectId: row.project_id,
      missionId: row.mission_id,
      objectiveId: row.objective_id,
      changedFields: ['status', 'metadata_json', 'last_error', 'launch_completed_at']
    });
    await txCtx.db.run(
      `INSERT INTO mission_events
           (id, workspace_id, project_id, mission_id, objective_id, type, phase, summary,
            payload_json, source, actor_workspace_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, 'update', 'execute', ?, ?, 'runner', NULL, ?)`,
      [
        newId(),
        ctx.workspace.id,
        row.project_id,
        row.mission_id,
        row.objective_id,
        result.ok
          ? `Completed ${mutation.kind.replace('_', ' ')} on execution target.`
          : `Local-target mutation failed: ${result.message}`,
        JSON.stringify({ executionRequestId: row.id, result: storedResult }),
        now
      ]
    );
  });

  return parseLocalTargetMutation(JSON.stringify(metadata));
}
