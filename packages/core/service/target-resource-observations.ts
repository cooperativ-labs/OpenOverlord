import { mapObservationToResourceStatus } from './local-target/resource-status.ts';
import type { TargetObservationState } from './local-target/types.ts';
import type { ServiceContext } from './context.js';
import { ServiceError } from './errors.js';
import { ensureActingDeviceTarget } from './execution-targets.js';
import { newId, nowIso } from './util.js';

export type TargetResourceObservationInput = {
  resourceId: string;
  state: TargetObservationState;
  gitRoot?: string | null;
  branch?: string | null;
  commit?: string | null;
  observedAt: string;
};

export type TargetResourceObservationRow = {
  executionTargetId: string;
  resourceId: string;
  state: TargetObservationState;
  gitRoot: string | null;
  branch: string | null;
  commit: string | null;
  observedAt: string;
  updatedAt: string;
};

const OBSERVATION_STATES = new Set<TargetObservationState>([
  'available',
  'missing',
  'unreachable',
  'permission_denied',
  'not_git_repository',
  'unknown'
]);

function parseObservationState(value: unknown): TargetObservationState {
  const state = typeof value === 'string' ? value.trim() : '';
  if (!OBSERVATION_STATES.has(state as TargetObservationState)) {
    throw new ServiceError(
      `Invalid observation state: ${state || '(empty)'}`,
      'validation_error',
      400
    );
  }
  return state as TargetObservationState;
}

function parseObservationInput(value: unknown): TargetResourceObservationInput {
  if (!value || typeof value !== 'object') {
    throw new ServiceError('Each observation must be an object', 'validation_error', 400);
  }
  const row = value as Record<string, unknown>;
  const resourceId = typeof row.resourceId === 'string' ? row.resourceId.trim() : '';
  if (!resourceId) {
    throw new ServiceError('resourceId is required for each observation', 'validation_error', 400);
  }
  const observedAt = typeof row.observedAt === 'string' ? row.observedAt.trim() : '';
  if (!observedAt) {
    throw new ServiceError('observedAt is required for each observation', 'validation_error', 400);
  }
  return {
    resourceId,
    state: parseObservationState(row.state),
    gitRoot: typeof row.gitRoot === 'string' ? row.gitRoot : null,
    branch: typeof row.branch === 'string' ? row.branch : null,
    commit: typeof row.commit === 'string' ? row.commit : null,
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

async function assertResourcesBelongToTarget({
  ctx,
  executionTargetId,
  observations
}: {
  ctx: ServiceContext;
  executionTargetId: string;
  observations: TargetResourceObservationInput[];
}): Promise<void> {
  for (const observation of observations) {
    const resource = await ctx.db.get<{
      id: string;
      execution_target_id: string | null;
    }>(
      `SELECT id, execution_target_id
         FROM project_resources
        WHERE id = ?
          AND workspace_id = ?
          AND deleted_at IS NULL`,
      [observation.resourceId, ctx.workspace.id]
    );
    if (!resource) {
      throw new ServiceError('Resource not found', 'resource_not_found', 404);
    }
    if (
      resource.execution_target_id !== null &&
      resource.execution_target_id !== executionTargetId
    ) {
      throw new ServiceError(
        'Resource is not linked to this execution target',
        'resource_target_mismatch',
        409
      );
    }
  }
}

/**
 * Upsert client observations for resources on an execution target. The caller
 * must be acting as that target (device fingerprint resolves to the same
 * `execution_targets.id`).
 */
export async function recordTargetResourceObservations({
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
    throw new ServiceError('At least one observation is required', 'validation_error', 400);
  }

  const actingTarget = await ensureActingDeviceTarget({ ctx });
  if (actingTarget.executionTargetId !== targetId) {
    throw new ServiceError(
      'Observations must be reported for the acting execution target',
      'execution_target_mismatch',
      403
    );
  }

  await executionTargetInWorkspace({ ctx, executionTargetId: targetId });
  const observations = rawObservations.map(parseObservationInput);
  await assertResourcesBelongToTarget({ ctx, executionTargetId: targetId, observations });

  const now = nowIso();
  await ctx.db.transaction(async tx => {
    for (const observation of observations) {
      const existing = await tx.get<{ id: string }>(
        `SELECT id FROM target_resource_observations
            WHERE execution_target_id = ? AND resource_id = ?`,
        [targetId, observation.resourceId]
      );
      if (existing) {
        await tx.run(
          `UPDATE target_resource_observations
              SET state = ?, git_root = ?, branch = ?, git_commit = ?,
                  observed_at = ?, updated_at = ?
            WHERE id = ?`,
          [
            observation.state,
            observation.gitRoot,
            observation.branch,
            observation.commit,
            observation.observedAt,
            now,
            existing.id
          ]
        );
      } else {
        await tx.run(
          `INSERT INTO target_resource_observations
             (id, workspace_id, execution_target_id, resource_id, state, git_root,
              branch, git_commit, observed_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            newId(),
            ctx.workspace.id,
            targetId,
            observation.resourceId,
            observation.state,
            observation.gitRoot,
            observation.branch,
            observation.commit,
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

export async function loadTargetResourceObservations({
  ctx,
  resourceIds
}: {
  ctx: ServiceContext;
  resourceIds: string[];
}): Promise<Map<string, TargetResourceObservationRow>> {
  const byResource = new Map<string, TargetResourceObservationRow>();
  if (resourceIds.length === 0) return byResource;

  const placeholders = resourceIds.map(() => '?').join(', ');
  const rows = (await ctx.db.all(
    `SELECT execution_target_id, resource_id, state, git_root, branch, git_commit,
            observed_at, updated_at
       FROM target_resource_observations
      WHERE workspace_id = ?
        AND resource_id IN (${placeholders})`,
    [ctx.workspace.id, ...resourceIds]
  )) as Array<{
    execution_target_id: string;
    resource_id: string;
    state: string;
    git_root: string | null;
    branch: string | null;
    git_commit: string | null;
    observed_at: string;
    updated_at: string;
  }>;

  for (const row of rows) {
    byResource.set(row.resource_id, {
      executionTargetId: row.execution_target_id,
      resourceId: row.resource_id,
      state: row.state as TargetObservationState,
      gitRoot: row.git_root,
      branch: row.branch,
      commit: row.git_commit,
      observedAt: row.observed_at,
      updatedAt: row.updated_at
    });
  }
  return byResource;
}

/** Merge lifecycle status with a cached client observation when target ids align. */
export function mergeResourceStatusWithObservation({
  lifecycleStatus,
  resourceExecutionTargetId,
  observation
}: {
  lifecycleStatus: string;
  resourceExecutionTargetId: string | null;
  observation: TargetResourceObservationRow | null | undefined;
}): { status: string; observedAt: string | null } {
  if (
    !observation ||
    (resourceExecutionTargetId !== null &&
      observation.executionTargetId !== resourceExecutionTargetId)
  ) {
    return { status: lifecycleStatus, observedAt: null };
  }
  return {
    status: mapObservationToResourceStatus(lifecycleStatus, observation),
    observedAt: observation.observedAt
  };
}
