import { PERMISSIONS } from '@overlord/auth';
import type { DatabaseClient } from '@overlord/database';

import type { ServiceContext } from '../packages/core/service/context.ts';
import { ServiceError } from '../packages/core/service/errors.ts';
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
} from '../packages/core/service/execution-requests.ts';
import type { CapabilityResult } from '../packages/core/service/local-target/types.ts';
import { completeLocalTargetMutationRequest } from '../packages/core/service/local-target-mutations.ts';

import { recordRunnerBranchEvent } from './branch-activity.ts';
import { clientDeviceFromBody } from './client-device.ts';
import {
  buildWebappServiceContextForWorkspace,
  getClientDeviceIdentity,
  newId,
  nowIso,
  recordChange,
  requireDatabaseClient
} from './db.ts';
import { ApiError } from './errors.ts';
import { requireWorkspacePermission } from './rbac.ts';
import { callerMembershipsInActiveOrganization } from './repository.ts';

type ClientDeviceBody = {
  deviceFingerprint?: string | null;
  deviceLabel?: string | null;
  devicePlatform?: string | null;
} | null;

/**
 * A `ServiceContext` scoped to `workspaceId` with the caller's own membership
 * (`actorWorkspaceUserId`) in *that* workspace — never the active workspace's
 * actor. Every runner operation runs under the context of the workspace that
 * actually owns the execution request/mission it touches (coo:135), so a
 * desktop runner claims and drives executions queued in a secondary workspace,
 * and every mission_event / entity_changes row is attributed to the correct
 * workspace instead of whichever one the caller currently has active.
 */
async function workspaceServiceContext(
  workspaceId: string,
  actorWorkspaceUserId: string,
  clientDevice?: ClientDeviceBody
): Promise<ServiceContext> {
  const ctx = await buildWebappServiceContextForWorkspace(
    workspaceId,
    requireDatabaseClient(),
    actorWorkspaceUserId
  );
  return {
    ...ctx,
    clientDevice: clientDeviceFromBody(clientDevice) ?? getClientDeviceIdentity()
  };
}

/**
 * Resolve, authorize, and scope a `ServiceContext` for the workspace that owns
 * execution request `requestId`. Membership + `execution_request:claim` are
 * checked against the request's *own* workspace (`requireWorkspacePermission`),
 * so status transitions and completion work for a secondary-workspace request
 * without the caller having it active. A request the caller cannot reach is an
 * honest 404 (never leaks existence across the org boundary).
 */
async function requestRunnerContext(
  requestId: string,
  clientDevice?: ClientDeviceBody
): Promise<ServiceContext> {
  const row = (await requireDatabaseClient().get(
    `SELECT workspace_id FROM execution_requests WHERE id = ? AND deleted_at IS NULL`,
    [requestId]
  )) as { workspace_id: string } | undefined;
  if (!row) throw new ApiError(404, 'Execution request not found');
  const actor = await requireWorkspacePermission({
    workspaceId: row.workspace_id,
    permission: PERMISSIONS.EXECUTION_REQUEST_CLAIM,
    notFoundMessage: 'Execution request not found'
  });
  return workspaceServiceContext(row.workspace_id, actor, clientDevice);
}

/** The workspace that owns project `projectId` by id, or `null` (slug/name refs fall through). */
async function directProjectWorkspaceId(projectId: string): Promise<string | null> {
  const row = (await requireDatabaseClient().get(
    `SELECT workspace_id FROM projects WHERE id = ? AND deleted_at IS NULL`,
    [projectId]
  )) as { workspace_id: string } | undefined;
  return row?.workspace_id ?? null;
}

/**
 * The caller's runner scope: every workspace of the active organization the
 * caller is an active member of (every role grants `execution_request:claim`),
 * narrowed to a single workspace when `projectId` resolves to one by id. This
 * is the runner counterpart of My Missions' cross-workspace aggregation.
 */
async function resolveRunnerScopes(
  projectId?: string | null
): Promise<Array<{ workspaceId: string; workspaceUserId: string }>> {
  const scopes = await callerMembershipsInActiveOrganization();
  if (projectId) {
    const owningWorkspaceId = await directProjectWorkspaceId(projectId);
    if (owningWorkspaceId) return scopes.filter(scope => scope.workspaceId === owningWorkspaceId);
  }
  return scopes;
}

type ExecutionRequestRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  mission_id: string;
  objective_id: string;
  execution_target_id: string | null;
  claimed_by_execution_target_id: string | null;
  requested_agent: string | null;
  requested_model: string | null;
  requested_reasoning_effort: string | null;
  launch_flags_json: string;
  status: string;
  requested_source: string;
  resolved_resource_id: string | null;
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
  resourceKey: string;
  action: 'create' | 'reuse' | 'new_cycle';
  cycle: number;
};

const EXECUTION_REQUEST_COLUMNS = `
  id, workspace_id, project_id, mission_id, objective_id, execution_target_id,
  claimed_by_execution_target_id, requested_agent, requested_model, requested_reasoning_effort,
  launch_flags_json, status, requested_source, resolved_resource_id,
  resolved_working_directory, last_error, created_at, updated_at, revision
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

export async function runnerStatus(projectId?: string | null): Promise<Record<string, unknown>> {
  const scopes = await resolveRunnerScopes(projectId);
  const queue: Record<string, unknown>[] = [];
  for (const scope of scopes) {
    const ctx = await workspaceServiceContext(scope.workspaceId, scope.workspaceUserId);
    await expireStaleExecutionRequests({ ctx });
    try {
      const rows = await listExecutionRequests({ ctx, projectId });
      queue.push(...rows.map(serviceSummaryToDto));
    } catch (error) {
      // A slug/name `projectId` that doesn't resolve in this scope's workspace
      // is simply not this workspace's project — skip, don't fail the poll.
      if (error instanceof ServiceError && error.code === 'project_not_found') continue;
      throw error;
    }
  }
  return { queue, activeCount: queue.length };
}

export async function claimRunnerRequest({
  projectId,
  clientDevice
}: {
  projectId?: string | null;
  clientDevice?: ClientDeviceBody;
} = {}): Promise<{
  request: Record<string, unknown> | null;
}> {
  // Claim across every workspace the caller belongs to in the active
  // organization (the My Missions precedent). Iterate in membership order and
  // return the first workspace that yields a claimable request; the runner
  // polls repeatedly, so subsequent polls drain the remaining workspaces.
  for (const scope of await resolveRunnerScopes(projectId)) {
    const ctx = await workspaceServiceContext(
      scope.workspaceId,
      scope.workspaceUserId,
      clientDevice
    );
    let request;
    try {
      request = await claimNextExecutionRequest({
        ctx,
        projectId,
        clientDevice: clientDeviceFromBody(clientDevice)
      });
    } catch (error) {
      if (error instanceof ServiceError && error.code === 'project_not_found') continue;
      throw error;
    }
    if (request) return { request: serviceSummaryToDto(request) };
  }
  return { request: null };
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
  const ctx = await requestRunnerContext(requestId);
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
  const ctx = await requestRunnerContext(requestId);
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
    const { recordBranchActionActivityFromMutation } =
      await import('./local-target-mutation-queue.ts');
    await recordBranchActionActivityFromMutation({
      ctx,
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
  const resourceKey = typeof body.resourceKey === 'string' ? body.resourceKey.trim() : '';
  const action = body.action;
  const cycle = typeof body.cycle === 'number' && Number.isFinite(body.cycle) ? body.cycle : 1;
  if (!branchName || !baseBranch || !worktreePath || !resourceKey) {
    throw new ApiError(400, 'branchName, baseBranch, worktreePath, and resourceKey are required');
  }
  if (action !== 'create' && action !== 'reuse' && action !== 'new_cycle') {
    throw new ApiError(400, 'Invalid branch preparation action');
  }
  return { branchName, baseBranch, worktreePath, resourceKey, action, cycle };
}

async function resolveBranchResourceKey({
  tx,
  branch,
  requestRow
}: {
  tx: DatabaseClient;
  branch: BranchPreparedPayload;
  requestRow: ExecutionRequestRow | undefined;
}): Promise<string> {
  if (branch.resourceKey.trim()) return branch.resourceKey.trim();
  if (!requestRow?.resolved_resource_id) return 'project';
  const row = (await tx.get<{ resource_key: string | null }>(
    `SELECT resource_key FROM project_resources WHERE id = ?`,
    [requestRow.resolved_resource_id]
  )) as { resource_key: string | null } | undefined;
  return row?.resource_key?.trim() || 'project';
}

async function recordBranchPreparedTx(
  tx: DatabaseClient,
  {
    workspaceId,
    missionId,
    requestId,
    payload
  }: {
    workspaceId: string;
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
    [workspaceId, missionId, missionId]
  );
  if (!mission) throw new ApiError(404, 'Mission not found');

  let objectiveId: string | null = null;
  let requestRow: ExecutionRequestRow | undefined;
  if (requestId) {
    requestRow = await tx.get<ExecutionRequestRow>(
      `SELECT ${EXECUTION_REQUEST_COLUMNS} FROM execution_requests
         WHERE id = ? AND workspace_id = ?`,
      [requestId, workspaceId]
    );
    if (!requestRow) throw new ApiError(404, 'Execution request not found');
    objectiveId = requestRow.objective_id;
    const flags = parseLaunchFlagsObject(requestRow.launch_flags_json);
    flags.branchAutomation = branch;
    const revision = requestRow.revision + 1;
    await tx.run(
      `UPDATE execution_requests
          SET launch_flags_json = ?,
              resolved_working_directory = ?,
              updated_at = ?,
              revision = ?
        WHERE id = ?`,
      [JSON.stringify(flags), branch.worktreePath, nowIso(), revision, requestRow.id]
    );
    await recordChange(
      {
        workspaceId,
        entityType: 'execution_request',
        entityId: requestRow.id,
        operation: 'update',
        entityRevision: revision,
        projectId: requestRow.project_id,
        missionId: requestRow.mission_id,
        objectiveId: requestRow.objective_id,
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
          workspaceId,
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
      workspaceId,
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

  await recordRunnerBranchEvent(tx, {
    workspaceId,
    projectId: mission.project_id,
    missionId: mission.id,
    objectiveId,
    summary: `Prepared branch ${branch.branchName} in worktree ${branch.worktreePath}.`,
    payload: branch as unknown as Record<string, unknown>,
    now
  });

  const executionTargetId =
    requestRow?.claimed_by_execution_target_id?.trim() ||
    requestRow?.execution_target_id?.trim() ||
    null;
  if (executionTargetId) {
    const resourceKey = await resolveBranchResourceKey({ tx, branch, requestRow });
    const existing = await tx.get<{ id: string }>(
      `SELECT id FROM mission_branch_observations
        WHERE execution_target_id = ? AND mission_id = ? AND resource_key = ?`,
      [executionTargetId, mission.id, resourceKey]
    );
    if (existing) {
      await tx.run(
        `UPDATE mission_branch_observations
            SET status = ?, dirty = ?, worktree_path = ?, observed_at = ?, updated_at = ?
          WHERE id = ?`,
        ['created', 0, branch.worktreePath, now, now, existing.id]
      );
    } else {
      await tx.run(
        `INSERT INTO mission_branch_observations
           (id, workspace_id, execution_target_id, mission_id, resource_key, status, dirty,
            worktree_path, observed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId(),
          workspaceId,
          executionTargetId,
          mission.id,
          resourceKey,
          'created',
          0,
          branch.worktreePath,
          now,
          now,
          now
        ]
      );
    }
  }

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
  // Resolve the mission's own workspace across the caller's active-org
  // memberships — `missionId` may be a display_id (unique per workspace), so a
  // runner driving a secondary-workspace mission still resolves it (coo:135).
  const scopes = await callerMembershipsInActiveOrganization();
  if (scopes.length === 0) throw new ApiError(404, 'Mission not found');
  const placeholders = scopes.map(() => '?').join(', ');
  const mission = (await requireDatabaseClient().get(
    `SELECT workspace_id FROM missions
      WHERE (id = ? OR display_id = ?)
        AND deleted_at IS NULL
        AND workspace_id IN (${placeholders})`,
    [missionId, missionId, ...scopes.map(scope => scope.workspaceId)]
  )) as { workspace_id: string } | undefined;
  if (!mission) throw new ApiError(404, 'Mission not found');

  return requireDatabaseClient().transaction(async tx =>
    recordBranchPreparedTx(tx, { workspaceId: mission.workspace_id, missionId, requestId, payload })
  );
}

export async function clearRunnerRequests({
  objectiveId,
  projectId
}: { objectiveId?: string | null; projectId?: string | null } = {}): Promise<{ cleared: number }> {
  // Clear across every workspace the caller belongs to in the active
  // organization, narrowed to the project's own workspace when `projectId`
  // resolves to one — so clearing a secondary-workspace project's queue works
  // regardless of which workspace is active (coo:135).
  let cleared = 0;
  for (const scope of await resolveRunnerScopes(projectId)) {
    const ctx = await workspaceServiceContext(scope.workspaceId, scope.workspaceUserId);
    try {
      cleared += (await clearExecutionRequests({ ctx, objectiveId, projectId })).cleared;
    } catch (error) {
      if (error instanceof ServiceError && error.code === 'project_not_found') continue;
      throw error;
    }
  }
  return { cleared };
}
