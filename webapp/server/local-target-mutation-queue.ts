import {
  createLocalTargetMutationRequest,
  parseLocalTargetMutation,
  type LocalTargetMutationCapability,
  type LocalTargetMutationKind
} from '../../packages/core/service/local-target-mutations.ts';
import { findActingDeviceExecutionTargetId } from '../../packages/core/service/execution-targets.ts';
import { resolveProjectExecutionTargetForLaunch } from '../../packages/core/service/project-execution-target.ts';
import type { ServiceContext } from '../../packages/core/service/context.ts';

import { buildWebappServiceContext, newId, nowIso, recordChange, WORKSPACE } from './db.ts';
import { ApiError } from './errors.ts';

export async function resolveRemoteMutationTarget({
  ctx,
  projectId,
  executionTargetId
}: {
  ctx: ServiceContext;
  projectId: string;
  executionTargetId?: string | null;
}): Promise<{ queue: true; executionTargetId: string } | { queue: false }> {
  const actingTargetId = await findActingDeviceExecutionTargetId({ ctx });
  const selectedTargetId =
    executionTargetId?.trim() ||
    (await resolveProjectExecutionTargetForLaunch({ ctx, projectId }));
  if (!selectedTargetId) return { queue: false };
  if (actingTargetId === null || selectedTargetId !== actingTargetId) {
    return { queue: true, executionTargetId: selectedTargetId };
  }
  return { queue: false };
}

export async function queueLocalTargetMutation({
  projectId,
  missionId,
  executionTargetId,
  kind,
  capability,
  input,
  eventSummary
}: {
  projectId: string;
  missionId: string;
  executionTargetId: string;
  kind: LocalTargetMutationKind;
  capability: LocalTargetMutationCapability;
  input: Record<string, unknown>;
  eventSummary?: string;
}): Promise<{ executionRequestId: string }> {
  const ctx = buildWebappServiceContext();
  const created = await createLocalTargetMutationRequest({
    ctx,
    projectId,
    missionId,
    executionTargetId,
    kind,
    capability,
    input,
    eventSummary
  });
  return { executionRequestId: created.id };
}

export async function resolveMutationAnchorMissionId(projectId: string): Promise<string> {
  const ctx = buildWebappServiceContext();
  const row = (await ctx.db.get(
    `SELECT m.id
       FROM missions m
      WHERE m.project_id = ?
        AND m.workspace_id = ?
        AND m.deleted_at IS NULL
      ORDER BY m.updated_at DESC
      LIMIT 1`,
    [projectId, ctx.workspace.id]
  )) as { id: string } | undefined;
  if (!row) {
    throw new ApiError(
      409,
      'No mission exists in this project to anchor a remote git mutation.',
      undefined,
      'MUTATION_ANCHOR_MISSING'
    );
  }
  return row.id;
}

export async function recordBranchActionActivityFromMutation({
  requestId,
  summary
}: {
  requestId: string;
  summary: string;
}): Promise<void> {
  const ctx = buildWebappServiceContext();
  const row = (await ctx.db.get(
    `SELECT mission_id, project_id, metadata_json
       FROM execution_requests
      WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [requestId, ctx.workspace.id]
  )) as { mission_id: string; project_id: string; metadata_json: string } | undefined;
  if (!row) return;

  const mutation = parseLocalTargetMutation(row.metadata_json);
  const branchName =
    typeof mutation?.input.branchName === 'string' ? mutation.input.branchName : '';
  const baseBranch =
    typeof mutation?.input.baseBranch === 'string' ? mutation.input.baseBranch : '';

  await ctx.db.transaction(async tx => {
    const mission = (await tx.get(
      `SELECT revision FROM missions WHERE id = ? AND workspace_id = ?`,
      [row.mission_id, WORKSPACE.id]
    )) as { revision: number } | undefined;
    const now = nowIso();
    if (mission) {
      const revision = mission.revision + 1;
      await tx.run(
        `UPDATE missions SET updated_at = ?, revision = ?
         WHERE id = ? AND workspace_id = ?`,
        [now, revision, row.mission_id, WORKSPACE.id]
      );
      await recordChange(
        {
          entityType: 'mission',
          entityId: row.mission_id,
          operation: 'update',
          entityRevision: revision,
          projectId: row.project_id,
          missionId: row.mission_id,
          changedFields: ['active_branch']
        },
        tx
      );
    }
    await tx.run(
      `INSERT INTO mission_events
       (id, workspace_id, project_id, mission_id, objective_id, type, phase, summary,
        payload_json, source, actor_workspace_user_id, created_at)
     VALUES (?, ?, ?, ?, NULL, 'update', 'execute', ?, ?, 'runner', NULL, ?)`,
      [
        newId(),
        WORKSPACE.id,
        row.project_id,
        row.mission_id,
        summary,
        JSON.stringify({ branch: branchName, baseBranch }),
        now
      ]
    );
  });
}
