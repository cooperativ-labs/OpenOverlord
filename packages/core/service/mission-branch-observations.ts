import { bindBool } from '@overlord/database';

import type { ServiceContext } from './context.js';
import { ServiceError } from './errors.js';
import { ensureActingDeviceTarget } from './execution-targets.js';
import { newId, nowIso } from './util.js';

export type ObservedMissionBranchStatus = 'created' | 'published' | 'merged_unpushed' | 'merged';

export type MissionBranchObservationInput = {
  missionId: string;
  resourceKey: string;
  status: ObservedMissionBranchStatus;
  dirty: boolean;
  worktreePath?: string | null;
  observedAt: string;
};

export type MissionBranchObservationRow = {
  executionTargetId: string;
  missionId: string;
  resourceKey: string;
  status: ObservedMissionBranchStatus;
  dirty: boolean;
  worktreePath: string | null;
  observedAt: string;
  updatedAt: string;
};

export type ControlPlaneMissionBranch = {
  status: string;
  dirty: boolean;
  worktreePath: string | null;
  observedAt?: string | null;
  observationSource?: string | null;
};

const OBSERVED_BRANCH_STATUSES = new Set<ObservedMissionBranchStatus>([
  'created',
  'published',
  'merged_unpushed',
  'merged'
]);

function parseBranchStatus(value: unknown): ObservedMissionBranchStatus {
  const status = typeof value === 'string' ? value.trim() : '';
  if (!OBSERVED_BRANCH_STATUSES.has(status as ObservedMissionBranchStatus)) {
    throw new ServiceError(
      `Invalid branch observation status: ${status || '(empty)'}`,
      'validation_error',
      400
    );
  }
  return status as ObservedMissionBranchStatus;
}

function parseObservationInput(value: unknown): MissionBranchObservationInput {
  if (!value || typeof value !== 'object') {
    throw new ServiceError('Each branch observation must be an object', 'validation_error', 400);
  }
  const row = value as Record<string, unknown>;
  const missionId = typeof row.missionId === 'string' ? row.missionId.trim() : '';
  if (!missionId) {
    throw new ServiceError(
      'missionId is required for each branch observation',
      'validation_error',
      400
    );
  }
  const observedAt = typeof row.observedAt === 'string' ? row.observedAt.trim() : '';
  if (!observedAt) {
    throw new ServiceError(
      'observedAt is required for each branch observation',
      'validation_error',
      400
    );
  }
  const resourceKey = typeof row.resourceKey === 'string' ? row.resourceKey.trim() : '';
  if (!resourceKey) {
    throw new ServiceError(
      'resourceKey is required for each branch observation',
      'validation_error',
      400
    );
  }
  if (typeof row.dirty !== 'boolean') {
    throw new ServiceError(
      'dirty is required for each branch observation',
      'validation_error',
      400
    );
  }
  return {
    missionId,
    resourceKey,
    status: parseBranchStatus(row.status),
    dirty: row.dirty,
    worktreePath: typeof row.worktreePath === 'string' ? row.worktreePath : null,
    observedAt
  };
}

async function executionTargetInWorkspace({
  ctx,
  executionTargetId
}: {
  ctx: ServiceContext;
  executionTargetId: string;
}): Promise<void> {
  const row = await ctx.db.get<{ id: string }>(
    `SELECT id FROM execution_targets
        WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [executionTargetId, ctx.workspace.id]
  );
  if (!row) {
    throw new ServiceError('Execution target not found', 'execution_target_not_found', 404);
  }
}

async function assertMissionsBelongToWorkspace({
  ctx,
  observations
}: {
  ctx: ServiceContext;
  observations: MissionBranchObservationInput[];
}): Promise<void> {
  for (const observation of observations) {
    const mission = await ctx.db.get<{ id: string }>(
      `SELECT id FROM missions
        WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      [observation.missionId, ctx.workspace.id]
    );
    if (!mission) {
      throw new ServiceError('Mission not found', 'mission_not_found', 404);
    }
  }
}

/**
 * Upsert client-observed branch state for missions on an execution target. The
 * caller must be acting as the same local execution target it reports for.
 */
export async function recordMissionBranchObservations({
  ctx,
  executionTargetId,
  observations: rawObservations
}: {
  ctx: ServiceContext;
  executionTargetId: string;
  observations: unknown;
}): Promise<{ recorded: number }> {
  const targetId = executionTargetId.trim();
  if (!targetId) {
    throw new ServiceError('executionTargetId is required', 'validation_error', 400);
  }
  if (!Array.isArray(rawObservations) || rawObservations.length === 0) {
    throw new ServiceError('At least one branch observation is required', 'validation_error', 400);
  }

  const actingTarget = await ensureActingDeviceTarget({ ctx });
  if (actingTarget.executionTargetId !== targetId) {
    throw new ServiceError(
      'Branch observations must be reported for the acting execution target',
      'execution_target_mismatch',
      403
    );
  }

  await executionTargetInWorkspace({ ctx, executionTargetId: targetId });
  const observations = rawObservations.map(parseObservationInput);
  await assertMissionsBelongToWorkspace({ ctx, observations });

  const now = nowIso();
  await ctx.db.transaction(async tx => {
    for (const observation of observations) {
      const existing = await tx.get<{ id: string }>(
        `SELECT id FROM mission_branch_observations
          WHERE execution_target_id = ? AND mission_id = ? AND resource_key = ?`,
        [targetId, observation.missionId, observation.resourceKey]
      );
      if (existing) {
        await tx.run(
          `UPDATE mission_branch_observations
              SET status = ?, dirty = ?, worktree_path = ?, observed_at = ?, updated_at = ?
            WHERE id = ?`,
          [
            observation.status,
            bindBool(ctx.db.dialect, observation.dirty),
            observation.worktreePath,
            observation.observedAt,
            now,
            existing.id
          ]
        );
      } else {
        await tx.run(
          `INSERT INTO mission_branch_observations
             (id, workspace_id, execution_target_id, mission_id, resource_key, status, dirty,
              worktree_path, observed_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            newId(),
            ctx.workspace.id,
            targetId,
            observation.missionId,
            observation.resourceKey,
            observation.status,
            bindBool(ctx.db.dialect, observation.dirty),
            observation.worktreePath,
            observation.observedAt,
            now,
            now
          ]
        );
      }
    }
  });

  return { recorded: observations.length };
}

export async function loadMissionBranchObservationsForMissions({
  ctx,
  executionTargetId,
  missionIds,
  resourceKey
}: {
  ctx: ServiceContext;
  executionTargetId: string | null;
  missionIds: string[];
  resourceKey?: string | null;
}): Promise<Map<string, MissionBranchObservationRow>> {
  const byMission = new Map<string, MissionBranchObservationRow>();
  if (!executionTargetId || missionIds.length === 0) return byMission;

  const placeholders = missionIds.map(() => '?').join(', ');
  const normalizedKey = resourceKey?.trim() || null;
  const params: Array<string> = [ctx.workspace.id, executionTargetId, ...missionIds];
  const resourceFilter = normalizedKey ? 'AND resource_key = ?' : '';
  if (normalizedKey) {
    params.push(normalizedKey);
  }

  const rows = (await ctx.db.all(
    `SELECT execution_target_id, mission_id, resource_key, status, dirty, worktree_path, observed_at, updated_at
       FROM mission_branch_observations
      WHERE workspace_id = ?
        AND execution_target_id = ?
        AND mission_id IN (${placeholders})
        ${resourceFilter}`,
    params
  )) as Array<{
    execution_target_id: string;
    mission_id: string;
    resource_key: string;
    status: string;
    dirty: boolean | number;
    worktree_path: string | null;
    observed_at: string;
    updated_at: string;
  }>;

  for (const row of rows) {
    byMission.set(row.mission_id, {
      executionTargetId: row.execution_target_id,
      missionId: row.mission_id,
      resourceKey: row.resource_key,
      status: row.status as ObservedMissionBranchStatus,
      dirty: row.dirty === true || row.dirty === 1,
      worktreePath: row.worktree_path,
      observedAt: row.observed_at,
      updatedAt: row.updated_at
    });
  }
  return byMission;
}

export function mergeMissionBranchObservation<T extends ControlPlaneMissionBranch>({
  controlPlaneBranch,
  observation
}: {
  controlPlaneBranch: T;
  observation: MissionBranchObservationRow | null | undefined;
}): T {
  if (!observation?.observedAt) return controlPlaneBranch;
  return {
    ...controlPlaneBranch,
    status: observation.status,
    dirty: observation.dirty,
    worktreePath: observation.worktreePath ?? controlPlaneBranch.worktreePath,
    observedAt: observation.observedAt,
    observationSource: 'client'
  } as T;
}
