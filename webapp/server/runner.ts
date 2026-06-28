import type { DatabaseClient } from '@overlord/database';

import type { ServiceContext } from '../../packages/core/service/context.ts';
import {
  claimNextExecutionRequest,
  clearExecutionRequests,
  type ExecutionRequestSummary,
  expireStaleExecutionRequests,
  getExecutionRequest,
  listExecutionRequests,
  markExecutionFailed,
  markExecutionLaunched,
  markExecutionLaunching
} from '../../packages/core/service/execution-requests.ts';
import { completeLocalTargetMutationRequest } from '../../packages/core/service/local-target-mutations.ts';
import type { CapabilityResult } from '../../packages/core/service/local-target/types.ts';

import {
  buildWebappServiceContext,
  getActorWorkspaceUserId,
  newId,
  nowIso,
  recordChange,
  requireDatabaseClient,
  serviceDatabaseClient,
  WORKSPACE
} from './db.ts';
import { clientDeviceFromBody } from './client-device.ts';
import { ApiError } from './errors.ts';

type ExecutionRequestRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  mission_id: string;
  objective_id: string;
  execution_target_id: string | null;
  requested_agent: string | null;
  requested_model: string | null;
  requested_reasoning_effort: string | null;
  launch_flags_json: string;
  status: string;
  requested_source: string;
  resolved_working_directory: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
};

type BranchPreparedPayload = {
  branchName: string;
  baseBranch: string;
  worktreePath: string;
  action: 'create' | 'reuse' | 'new_cycle';
  cycle: number;
};

const EXECUTION_REQUEST_COLUMNS = `
  id, workspace_id, project_id, mission_id, objective_id, execution_target_id,
  requested_agent, requested_model, requested_reasoning_effort, launch_flags_json,
  status, requested_source, resolved_working_directory, last_error, created_at, updated_at, revision
`;

function parseLaunchFlagsObject(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function serviceSummaryToDto(row: ExecutionRequestSummary): Record<string, unknown> {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    missionId: row.missionId,
    objectiveId: row.objectiveId,
    executionTargetId: row.executionTargetId,
    requestedAgent: row.requestedAgent,
    requestedModel: row.requestedModel,
    requestedReasoningEffort: row.requestedReasoningEffort,
    launchConfig: {
      preCommand: typeof row.launchFlags.preCommand === 'string' ? row.launchFlags.preCommand : '',
      flags: Array.isArray(row.launchFlags.flags)
        ? row.launchFlags.flags.filter((flag): flag is string => typeof flag === 'string')
        : []
    },
    metadata: row.metadata,
    status: row.status,
    requestedSource: row.requestedSource,
    workingDirectory: row.resolvedWorkingDirectory,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function serviceContext(clientDevice?: {
  deviceFingerprint?: string | null;
  deviceLabel?: string | null;
  devicePlatform?: string | null;
} | null): ServiceContext {
  return {
    ...buildWebappServiceContext(),
    clientDevice: clientDeviceFromBody(clientDevice) ?? buildWebappServiceContext().clientDevice
  };
}

export async function runnerStatus(projectId?: string | null): Promise<Record<string, unknown>> {
  const ctx = serviceContext();
  await expireStaleExecutionRequests({ ctx });
  const queue = (await listExecutionRequests({ ctx, projectId })).map(serviceSummaryToDto);
  return {
    workspace: WORKSPACE,
    queue,
    activeCount: queue.length
  };
}

export async function claimRunnerRequest({
  projectId,
  clientDevice
}: {
  projectId?: string | null;
  clientDevice?: {
    deviceFingerprint?: string | null;
    deviceLabel?: string | null;
    devicePlatform?: string | null;
  } | null;
} = {}): Promise<{
  request: Record<string, unknown> | null;
}> {
  const request = await claimNextExecutionRequest({
    ctx: serviceContext(clientDevice),
    projectId,
    clientDevice: clientDeviceFromBody(clientDevice)
  });
  return { request: request ? serviceSummaryToDto(request) : null };
}

export async function updateRunnerRequestStatus({
  requestId,
  status,
  error
}: {
  requestId: string;
  status: 'launching' | 'launched' | 'failed';
  error?: string | null;
}): Promise<Record<string, unknown>> {
  const ctx = serviceContext();
  const request =
    status === 'launching'
      ? await markExecutionLaunching({ ctx, requestId })
      : status === 'launched'
        ? await markExecutionLaunched({ ctx, requestId })
        : await markExecutionFailed({ ctx, requestId, error: error ?? 'Launch failed' });
  return serviceSummaryToDto(request);
}

export async function completeRunnerMutationRequest({
  requestId,
  mutationResult
}: {
  requestId: string;
  mutationResult: unknown;
}): Promise<Record<string, unknown>> {
  if (
    !mutationResult ||
    typeof mutationResult !== 'object' ||
    !('ok' in mutationResult) ||
    typeof (mutationResult as { ok: unknown }).ok !== 'boolean'
  ) {
    throw new ApiError(400, 'mutationResult must be a CapabilityResult envelope.');
  }
  const result = mutationResult as CapabilityResult<unknown>;
  const ctx = serviceContext();
  const completed = await completeLocalTargetMutationRequest({
    ctx,
    requestId,
    result
  });
  if (
    completed?.kind === 'branch_action' &&
    result.ok &&
    result.value &&
    typeof result.value === 'object' &&
    result.value !== null &&
    typeof (result.value as { summary?: unknown }).summary === 'string'
  ) {
    const { recordBranchActionActivityFromMutation } = await import(
      './local-target-mutation-queue.ts'
    );
    await recordBranchActionActivityFromMutation({
      requestId,
      summary: (result.value as { summary: string }).summary
    });
  }
  const request = await getExecutionRequest({ ctx, id: requestId });
  return serviceSummaryToDto(request);
}

function requireBranchPayload(value: unknown): BranchPreparedPayload {
  const body = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const branchName = typeof body.branchName === 'string' ? body.branchName.trim() : '';
  const baseBranch = typeof body.baseBranch === 'string' ? body.baseBranch.trim() : '';
  const worktreePath = typeof body.worktreePath === 'string' ? body.worktreePath.trim() : '';
  const action = body.action;
  const cycle = typeof body.cycle === 'number' && Number.isFinite(body.cycle) ? body.cycle : 1;
  if (!branchName || !baseBranch || !worktreePath) {
    throw new ApiError(400, 'branchName, baseBranch, and worktreePath are required');
  }
  if (action !== 'create' && action !== 'reuse' && action !== 'new_cycle') {
    throw new ApiError(400, 'Invalid branch preparation action');
  }
  return { branchName, baseBranch, worktreePath, action, cycle };
}

async function recordBranchPreparedTx(
  tx: DatabaseClient,
  {
    missionId,
    requestId,
    payload
  }: {
    missionId: string;
    requestId?: string | null;
    payload: unknown;
  }
): Promise<{ ok: true }> {
  const branch = requireBranchPayload(payload);
  const mission = await tx.get<{ id: string; project_id: string; revision: number }>(
    `SELECT id, project_id, revision FROM missions
      WHERE workspace_id = ?
        AND deleted_at IS NULL
        AND (id = ? OR display_id = ?)`,
    [WORKSPACE.id, missionId, missionId]
  );
  if (!mission) throw new ApiError(404, 'Mission not found');

  let objectiveId: string | null = null;
  if (requestId) {
    const row = await tx.get<ExecutionRequestRow>(
      `SELECT ${EXECUTION_REQUEST_COLUMNS} FROM execution_requests WHERE id = ?`,
      [requestId]
    );
    if (!row) throw new ApiError(404, 'Execution request not found');
    objectiveId = row.objective_id;
    const flags = parseLaunchFlagsObject(row.launch_flags_json);
    flags.branchAutomation = branch;
    const revision = row.revision + 1;
    await tx.run(
      `UPDATE execution_requests
          SET launch_flags_json = ?,
              resolved_working_directory = ?,
              updated_at = ?,
              revision = ?
        WHERE id = ?`,
      [JSON.stringify(flags), branch.worktreePath, nowIso(), revision, row.id]
    );
    await recordChange(
      {
        entityType: 'execution_request',
        entityId: row.id,
        operation: 'update',
        entityRevision: revision,
        projectId: row.project_id,
        missionId: row.mission_id,
        objectiveId: row.objective_id,
        changedFields: ['launch_flags_json', 'resolved_working_directory']
      },
      tx
    );
  }

  const now = nowIso();

  if (objectiveId) {
    const objective = await tx.get<{ revision: number }>(
      `SELECT revision FROM objectives WHERE id = ?`,
      [objectiveId]
    );
    if (objective) {
      const objectiveRevision = objective.revision + 1;
      await tx.run(
        `UPDATE objectives
            SET branch = ?, updated_at = ?, revision = ?
          WHERE id = ?`,
        [branch.branchName, now, objectiveRevision, objectiveId]
      );
      await recordChange(
        {
          entityType: 'objective',
          entityId: objectiveId,
          operation: 'update',
          entityRevision: objectiveRevision,
          projectId: mission.project_id,
          missionId: mission.id,
          objectiveId,
          changedFields: ['branch']
        },
        tx
      );
    }
  }

  const missionRevision = mission.revision + 1;
  await tx.run(
    `UPDATE missions
        SET active_branch = ?, branch_override = NULL,
            updated_at = ?, revision = ?
      WHERE id = ?`,
    [branch.branchName, now, missionRevision, mission.id]
  );
  await recordChange(
    {
      entityType: 'mission',
      entityId: mission.id,
      operation: 'update',
      entityRevision: missionRevision,
      projectId: mission.project_id,
      missionId: mission.id,
      objectiveId,
      changedFields: ['active_branch', 'branch_override']
    },
    tx
  );

  await tx.run(
    `INSERT INTO mission_events
       (id, workspace_id, project_id, mission_id, objective_id, type, phase, summary,
        payload_json, source, actor_workspace_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, 'update', 'execute', ?, ?, 'runner', NULL, ?)`,
    [
      newId(),
      WORKSPACE.id,
      mission.project_id,
      mission.id,
      objectiveId,
      `Prepared branch ${branch.branchName} in worktree ${branch.worktreePath}.`,
      JSON.stringify(branch),
      now
    ]
  );
  return { ok: true };
}

export async function recordBranchPrepared({
  missionId,
  requestId,
  payload
}: {
  missionId: string;
  requestId?: string | null;
  payload: unknown;
}): Promise<{ ok: true }> {
  return requireDatabaseClient().transaction(async tx =>
    recordBranchPreparedTx(tx, { missionId, requestId, payload })
  );
}

export async function clearRunnerRequests({
  objectiveId,
  projectId
}: { objectiveId?: string | null; projectId?: string | null } = {}): Promise<{ cleared: number }> {
  return clearExecutionRequests({ ctx: serviceContext(), objectiveId, projectId });
}
