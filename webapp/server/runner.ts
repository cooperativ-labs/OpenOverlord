import type { ServiceContext } from '../../src/service/context.ts';
import {
  claimNextExecutionRequest,
  clearExecutionRequests,
  type ExecutionRequestSummary,
  expireStaleExecutionRequests,
  listExecutionRequests,
  markExecutionFailed,
  markExecutionLaunched,
  markExecutionLaunching
} from '../../src/service/execution-requests.ts';

import { ACTOR_WORKSPACE_USER_ID, db, newId, nowIso, recordChange, WORKSPACE } from './db.ts';
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
    status: row.status,
    requestedSource: row.requestedSource,
    workingDirectory: row.resolvedWorkingDirectory,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function serviceContext(): ServiceContext {
  return {
    db,
    workspace: { id: WORKSPACE.id, slug: WORKSPACE.slug, name: WORKSPACE.name },
    actorWorkspaceUserId: ACTOR_WORKSPACE_USER_ID,
    source: 'runner' as const
  };
}

export function runnerStatus(projectId?: string | null): Record<string, unknown> {
  const ctx = serviceContext();
  expireStaleExecutionRequests({ ctx });
  const queue = listExecutionRequests({ ctx, projectId }).map(serviceSummaryToDto);
  return {
    workspace: WORKSPACE,
    queue,
    activeCount: queue.length
  };
}

export function claimRunnerRequest({ projectId }: { projectId?: string | null } = {}): {
  request: Record<string, unknown> | null;
} {
  const request = claimNextExecutionRequest({ ctx: serviceContext(), projectId });
  return { request: request ? serviceSummaryToDto(request) : null };
}

export function updateRunnerRequestStatus({
  requestId,
  status,
  error
}: {
  requestId: string;
  status: 'launching' | 'launched' | 'failed';
  error?: string | null;
}): Record<string, unknown> {
  const ctx = serviceContext();
  const request =
    status === 'launching'
      ? markExecutionLaunching({ ctx, requestId })
      : status === 'launched'
        ? markExecutionLaunched({ ctx, requestId })
        : markExecutionFailed({ ctx, requestId, error: error ?? 'Launch failed' });
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

export const recordBranchPrepared = db.transaction(
  ({
    missionId,
    requestId,
    payload
  }: {
    missionId: string;
    requestId?: string | null;
    payload: unknown;
  }): { ok: true } => {
    const branch = requireBranchPayload(payload);
    const mission = db
      .prepare(
        `SELECT id, project_id, revision FROM missions
          WHERE workspace_id = @workspace_id
            AND deleted_at IS NULL
            AND (id = @mission_id OR display_id = @mission_id)`
      )
      .get({ workspace_id: WORKSPACE.id, mission_id: missionId }) as
      | { id: string; project_id: string; revision: number }
      | undefined;
    if (!mission) throw new ApiError(404, 'Mission not found');

    let objectiveId: string | null = null;
    if (requestId) {
      const row = db
        .prepare(`SELECT ${EXECUTION_REQUEST_COLUMNS} FROM execution_requests WHERE id = ?`)
        .get(requestId) as ExecutionRequestRow | undefined;
      if (!row) throw new ApiError(404, 'Execution request not found');
      objectiveId = row.objective_id;
      const flags = parseLaunchFlagsObject(row.launch_flags_json);
      flags.branchAutomation = branch;
      const revision = row.revision + 1;
      db.prepare(
        `UPDATE execution_requests
            SET launch_flags_json = @launch_flags_json,
                resolved_working_directory = @worktree_path,
                updated_at = @now,
                revision = @revision
          WHERE id = @id`
      ).run({
        id: row.id,
        launch_flags_json: JSON.stringify(flags),
        worktree_path: branch.worktreePath,
        now: nowIso(),
        revision
      });
      recordChange({
        entityType: 'execution_request',
        entityId: row.id,
        operation: 'update',
        entityRevision: revision,
        projectId: row.project_id,
        missionId: row.mission_id,
        objectiveId: row.objective_id,
        changedFields: ['launch_flags_json', 'resolved_working_directory']
      });
    }

    const now = nowIso();

    // Record the branch this objective actually ran on (the runner is the only
    // place that knows the objective ↔ branch mapping at prepare time). Surfaced
    // per-objective in the mission panel and used for follow-on worktree reuse.
    if (objectiveId) {
      const objective = db
        .prepare(`SELECT revision FROM objectives WHERE id = ?`)
        .get(objectiveId) as { revision: number } | undefined;
      if (objective) {
        const objectiveRevision = objective.revision + 1;
        db.prepare(
          `UPDATE objectives
              SET branch = @branch, updated_at = @now, revision = @revision
            WHERE id = @id`
        ).run({ branch: branch.branchName, now, revision: objectiveRevision, id: objectiveId });
        recordChange({
          entityType: 'objective',
          entityId: objectiveId,
          operation: 'update',
          entityRevision: objectiveRevision,
          projectId: mission.project_id,
          missionId: mission.id,
          objectiveId,
          changedFields: ['branch']
        });
      }
    }

    // `missions.active_branch` is the source of truth for which branch a mission is
    // operating on (read by merge detection and the REST/mission-panel surfaces).
    // We also clear any `branch_override` here: the user's pinned choice has now
    // been consumed (it lives in `active_branch`, which the planner reuses), so
    // the mission returns to automatic selection for subsequent launches.
    const missionRevision = mission.revision + 1;
    db.prepare(
      `UPDATE missions
          SET active_branch = @active_branch, branch_override = NULL,
              updated_at = @now, revision = @revision
        WHERE id = @id`
    ).run({ active_branch: branch.branchName, now, revision: missionRevision, id: mission.id });
    recordChange({
      entityType: 'mission',
      entityId: mission.id,
      operation: 'update',
      entityRevision: missionRevision,
      projectId: mission.project_id,
      missionId: mission.id,
      objectiveId,
      changedFields: ['active_branch', 'branch_override']
    });

    // Human-readable audit entry for the activity feed. `branch_prepared` is not
    // part of the closed `mission_events.type` vocabulary, so this records under
    // the allowed `update` type with the structured detail in the payload.
    db.prepare(
      `INSERT INTO mission_events
         (id, workspace_id, project_id, mission_id, objective_id, type, phase, summary,
          payload_json, source, actor_workspace_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'update', 'execute', ?, ?, 'runner', NULL, ?)`
    ).run(
      newId(),
      WORKSPACE.id,
      mission.project_id,
      mission.id,
      objectiveId,
      `Prepared branch ${branch.branchName} in worktree ${branch.worktreePath}.`,
      JSON.stringify(branch),
      now
    );
    return { ok: true };
  }
);

export function clearRunnerRequests({
  objectiveId,
  projectId
}: { objectiveId?: string | null; projectId?: string | null } = {}): { cleared: number } {
  return clearExecutionRequests({ ctx: serviceContext(), objectiveId, projectId });
}
