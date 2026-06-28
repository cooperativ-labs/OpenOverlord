import { existsSync } from 'node:fs';
import path from 'node:path';

import { recordChange } from './change-feed.js';
import type { ServiceContext } from './context.js';
import { resolveMissionId, resolveProjectId } from './context.js';
import { ServiceError } from './errors.js';
import {
  type ClientDeviceIdentity,
  resolveClaimingDeviceTarget
} from './execution-targets.js';
import { assertPrimaryResourceConnected } from './projects.js';
import { newId, nowIso } from './util.js';

export const ACTIVE_EXECUTION_REQUEST_STATUSES = ['queued', 'claimed', 'launching'] as const;
// Objective states from which a run may still proceed (create a request, claim a
// queued request, or remain a candidate for stale-launch expiry). One concept,
// one list — referenced directly in the SQL below so it never drifts.
const LAUNCHABLE_OBJECTIVE_STATES = ['draft', 'submitted', 'launching'] as const;
const CLAIM_TTL_MS = 15 * 60 * 1000;
const LAUNCH_ATTACH_TTL_MS = 15 * 60 * 1000;

export type ExecutionRequestSummary = {
  id: string;
  workspaceId: string;
  projectId: string;
  missionId: string;
  missionDisplayId: string;
  objectiveId: string;
  objectiveTitle: string;
  objectiveState: string;
  executionTargetId: string | null;
  requestedAgent: string | null;
  requestedModel: string | null;
  requestedReasoningEffort: string | null;
  launchFlags: Record<string, unknown>;
  requestedSource: string;
  status: string;
  claimedByDeviceId: string | null;
  claimedByExecutionTargetId: string | null;
  claimExpiresAt: string | null;
  launchedSessionId: string | null;
  resolvedWorkingDirectory: string | null;
  lastError: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
};

export type ClaimedExecutionRequest = ExecutionRequestSummary & {
  workingDirectory: string;
};

function parseJsonObject(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function rowToSummary(row: {
  id: string;
  workspace_id: string;
  project_id: string;
  mission_id: string;
  display_id: string;
  objective_id: string;
  title: string;
  state: string;
  execution_target_id: string | null;
  requested_agent: string | null;
  requested_model: string | null;
  requested_reasoning_effort: string | null;
  launch_flags_json: string;
  requested_source: string;
  status: string;
  claimed_by_device_id: string | null;
  claimed_by_execution_target_id: string | null;
  claim_expires_at: string | null;
  launched_session_id: string | null;
  resolved_working_directory: string | null;
  last_error: string | null;
  attempt_count: number;
  created_at: string;
  updated_at: string;
}): ExecutionRequestSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    missionId: row.mission_id,
    missionDisplayId: row.display_id,
    objectiveId: row.objective_id,
    objectiveTitle: row.title,
    objectiveState: row.state,
    executionTargetId: row.execution_target_id,
    requestedAgent: row.requested_agent,
    requestedModel: row.requested_model,
    requestedReasoningEffort: row.requested_reasoning_effort,
    launchFlags: parseJsonObject(row.launch_flags_json),
    requestedSource: row.requested_source,
    status: row.status,
    claimedByDeviceId: row.claimed_by_device_id,
    claimedByExecutionTargetId: row.claimed_by_execution_target_id,
    claimExpiresAt: row.claim_expires_at,
    launchedSessionId: row.launched_session_id,
    resolvedWorkingDirectory: row.resolved_working_directory,
    lastError: row.last_error,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

type ExecutionRequestStateRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  mission_id: string;
  objective_id: string;
  execution_target_id: string | null;
  status: string;
  revision: number;
  launch_flags_json: string;
  launched_session_id: string | null;
};

async function getExecutionRequestStateRow({
  ctx,
  requestId
}: {
  ctx: ServiceContext;
  requestId: string;
}): Promise<ExecutionRequestStateRow> {
  const row = (await ctx.db.get(
    `SELECT id, workspace_id, project_id, mission_id, objective_id, execution_target_id,
              status, revision, launch_flags_json, launched_session_id
         FROM execution_requests
        WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [requestId, ctx.workspace.id]
  )) as ExecutionRequestStateRow | undefined;
  if (!row) {
    throw new ServiceError('Execution request not found', 'execution_request_not_found', 404);
  }
  return row;
}

async function appendExecutionRequestEvent({
  ctx,
  row,
  summary,
  payload
}: {
  ctx: ServiceContext;
  row: Pick<ExecutionRequestStateRow, 'id' | 'project_id' | 'mission_id' | 'objective_id'>;
  summary: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await ctx.db.run(
    `INSERT INTO mission_events
         (id, workspace_id, project_id, mission_id, objective_id,
          type, phase, summary, payload_json, source, actor_workspace_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'status_change', 'execute', ?, ?, ?, ?, ?)`,
    [
      newId(),
      ctx.workspace.id,
      row.project_id,
      row.mission_id,
      row.objective_id,
      summary,
      JSON.stringify({ executionRequestId: row.id, ...(payload ?? {}) }),
      ctx.source,
      ctx.actorWorkspaceUserId,
      nowIso()
    ]
  );
}

async function recordExecutionRequestUpdate({
  ctx,
  row,
  revision,
  changedFields
}: {
  ctx: ServiceContext;
  row: Pick<ExecutionRequestStateRow, 'id' | 'project_id' | 'mission_id' | 'objective_id'>;
  revision: number;
  changedFields: string[];
}): Promise<void> {
  await recordChange({
    ctx,
    entityType: 'execution_request',
    entityId: row.id,
    operation: 'update',
    entityRevision: revision,
    projectId: row.project_id,
    missionId: row.mission_id,
    objectiveId: row.objective_id,
    changedFields
  });
}

function assertTransition({
  row,
  allowedFrom,
  to
}: {
  row: ExecutionRequestStateRow;
  allowedFrom: readonly string[];
  to: string;
}): void {
  if (!allowedFrom.includes(row.status)) {
    throw new ServiceError(
      `Cannot transition execution request ${row.id} from ${row.status} to ${to}`,
      'invalid_execution_request_transition',
      409
    );
  }
}

async function getExecutionRequest({
  ctx,
  id
}: {
  ctx: ServiceContext;
  id: string;
}): Promise<ExecutionRequestSummary> {
  const row = (await ctx.db.get(
    `SELECT er.*, t.display_id, o.title, o.state
       FROM execution_requests er
       JOIN missions t ON t.id = er.mission_id
       JOIN objectives o ON o.id = er.objective_id
       WHERE er.id = ? AND er.workspace_id = ? AND er.deleted_at IS NULL`,
    [id, ctx.workspace.id]
  )) as Parameters<typeof rowToSummary>[0] | undefined;

  if (!row) {
    throw new ServiceError('Execution request not found', 'execution_request_not_found', 404);
  }
  return rowToSummary(row);
}

async function resolveWorkingDirectory({
  ctx,
  projectId,
  explicitWorkingDirectory,
  executionTargetId = null
}: {
  ctx: ServiceContext;
  projectId: string;
  explicitWorkingDirectory?: string | null | undefined;
  executionTargetId?: string | null;
}): Promise<{ workingDirectory: string; resourceId: string | null }> {
  if (explicitWorkingDirectory?.trim()) {
    const resolved = path.resolve(explicitWorkingDirectory);
    if (ctx.db.dialect === 'sqlite' && !existsSync(resolved)) {
      throw new ServiceError(
        `Working directory does not exist: ${resolved}`,
        'working_directory_missing'
      );
    }
    return { workingDirectory: resolved, resourceId: null };
  }

  const connected = await assertPrimaryResourceConnected({ ctx, projectId, executionTargetId });
  return {
    workingDirectory: connected.workingDirectory,
    resourceId: connected.resource.id
  };
}

export async function createExecutionRequest({
  ctx,
  missionId,
  objectiveId,
  requestedAgent,
  requestedModel,
  requestedReasoningEffort,
  launchFlags = {},
  requestedSource,
  idempotencyKey,
  workingDirectory,
  executionTargetId = null,
  metadata = {},
  eventSummary,
  eventPayload = {}
}: {
  ctx: ServiceContext;
  missionId: string;
  objectiveId?: string | null;
  requestedAgent?: string | null;
  requestedModel?: string | null;
  requestedReasoningEffort?: string | null;
  launchFlags?: Record<string, unknown>;
  requestedSource: string;
  idempotencyKey?: string | null;
  workingDirectory?: string | null;
  executionTargetId?: string | null;
  metadata?: Record<string, unknown>;
  eventSummary?: string | null;
  eventPayload?: Record<string, unknown>;
}): Promise<ExecutionRequestSummary> {
  const mission = await resolveMissionId(ctx, missionId);
  type LaunchableObjectiveRow = {
    id: string;
    state: string;
    assigned_agent: string | null;
    model: string | null;
    reasoning_effort: string | null;
  };
  const objective = objectiveId
    ? ((await ctx.db.get(
        `SELECT id, state, assigned_agent, model, reasoning_effort
             FROM objectives WHERE id = ? AND mission_id = ?`,
        [objectiveId, mission.id]
      )) as LaunchableObjectiveRow | undefined)
    : ((await ctx.db.get(
        `SELECT id, state, assigned_agent, model, reasoning_effort FROM objectives
           WHERE mission_id = ? AND state IN (${LAUNCHABLE_OBJECTIVE_STATES.map(() => '?').join(', ')})
           ORDER BY position ASC LIMIT 1`,
        [mission.id, ...LAUNCHABLE_OBJECTIVE_STATES]
      )) as LaunchableObjectiveRow | undefined);

  if (!objective) {
    throw new ServiceError(
      'No launchable objective found for mission',
      'no_launchable_objective',
      409
    );
  }
  if (
    !LAUNCHABLE_OBJECTIVE_STATES.includes(
      objective.state as (typeof LAUNCHABLE_OBJECTIVE_STATES)[number]
    )
  ) {
    throw new ServiceError(
      `Objective is not launchable from state: ${objective.state}`,
      'objective_not_launchable',
      409
    );
  }

  if (idempotencyKey) {
    const existing = (await ctx.db.get(
      `SELECT id FROM execution_requests
         WHERE workspace_id = ? AND idempotency_key = ? AND deleted_at IS NULL`,
      [ctx.workspace.id, idempotencyKey]
    )) as { id: string } | undefined;
    if (existing) return await getExecutionRequest({ ctx, id: existing.id });
  }

  // The objective row is the source of truth for the agent/model selection. When
  // the caller does not name an agent (e.g. auto-advance), fall back to what is
  // stored on the objective so execution never silently reverts to the hardcoded
  // runner default. An explicit agent still wins, but only carries an explicit
  // model/reasoning — it must not borrow the objective's model for a different agent.
  const useObjectiveDefaults = requestedAgent === undefined || requestedAgent === null;
  const resolvedAgent = requestedAgent ?? objective.assigned_agent ?? null;
  const resolvedModel = useObjectiveDefaults
    ? (requestedModel ?? objective.model ?? null)
    : (requestedModel ?? null);
  const resolvedReasoningEffort = useObjectiveDefaults
    ? (requestedReasoningEffort ?? objective.reasoning_effort ?? null)
    : (requestedReasoningEffort ?? null);

  const now = nowIso();
  const id = newId();
  const resolvedProjectId = await resolveProjectId(ctx, mission.projectId);
  const { workingDirectory: resolvedDirectory, resourceId } = await resolveWorkingDirectory({
    ctx,
    projectId: resolvedProjectId,
    explicitWorkingDirectory: workingDirectory,
    executionTargetId
  });

  await ctx.db.transaction(async tx => {
    const txCtx = { ...ctx, db: tx };
    await txCtx.db.run(
      `INSERT INTO execution_requests
           (id, workspace_id, project_id, mission_id, objective_id, execution_target_id,
            requested_agent,
            requested_model, requested_reasoning_effort, launch_mode, launch_flags_json,
            target_kind, requested_source, idempotency_key, status, requested_by_workspace_user_id,
            resolved_resource_id, resolved_working_directory, metadata_json,
            created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'run', ?, 'local', ?, ?, 'queued', ?, ?, ?, ?, ?, ?, 1)`,
      [
        id,
        ctx.workspace.id,
        resolvedProjectId,
        mission.id,
        objective.id,
        executionTargetId,
        resolvedAgent,
        resolvedModel,
        resolvedReasoningEffort,
        JSON.stringify(launchFlags),
        requestedSource,
        idempotencyKey ?? null,
        ctx.actorWorkspaceUserId,
        resourceId,
        resolvedDirectory,
        JSON.stringify(metadata),
        now,
        now
      ]
    );

    await txCtx.db.run(
      `INSERT INTO mission_events
           (id, workspace_id, project_id, mission_id, objective_id,
            type, phase, summary, payload_json, source, actor_workspace_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, 'execution_requested', 'execute', ?, ?, ?, ?, ?)`,
      [
        newId(),
        ctx.workspace.id,
        resolvedProjectId,
        mission.id,
        objective.id,
        eventSummary ?? `Queued execution request for ${resolvedAgent ?? 'default agent'}.`,
        JSON.stringify({ executionRequestId: id, requestedSource, ...eventPayload }),
        ctx.source,
        ctx.actorWorkspaceUserId,
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
      objectiveId: objective.id
    });
  });
  return await getExecutionRequest({ ctx, id });
}

export async function listExecutionRequests({
  ctx,
  projectId,
  includeInactive = false,
  limit = 50
}: {
  ctx: ServiceContext;
  projectId?: string | null;
  includeInactive?: boolean;
  limit?: number;
}): Promise<ExecutionRequestSummary[]> {
  const conditions = ['er.workspace_id = ?', 'er.deleted_at IS NULL'];
  const params: Array<string | number> = [ctx.workspace.id];
  if (!includeInactive) {
    conditions.push(
      `er.status IN (${ACTIVE_EXECUTION_REQUEST_STATUSES.map(() => '?').join(', ')})`
    );
    params.push(...ACTIVE_EXECUTION_REQUEST_STATUSES);
  }
  if (projectId) {
    conditions.push('er.project_id = ?');
    params.push(await resolveProjectId(ctx, projectId));
  }
  params.push(limit);

  const rows = (await ctx.db.all(
    `SELECT er.*, t.display_id, o.title, o.state
       FROM execution_requests er
       JOIN missions t ON t.id = er.mission_id
       JOIN objectives o ON o.id = er.objective_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY er.created_at ASC
       LIMIT ?`,
    params
  )) as Array<Parameters<typeof rowToSummary>[0]>;
  return rows.map(rowToSummary);
}

export async function claimNextExecutionRequest({
  ctx,
  projectId,
  claimTtlMs = CLAIM_TTL_MS,
  clientDevice
}: {
  ctx: ServiceContext;
  projectId?: string | null;
  claimTtlMs?: number;
  clientDevice?: ClientDeviceIdentity | null;
}): Promise<ClaimedExecutionRequest | null> {
  await expireStaleExecutionRequests({ ctx });
  const target = await resolveClaimingDeviceTarget({ ctx, clientDevice });
  const conditions = [
    'er.workspace_id = ?',
    "er.status = 'queued'",
    'er.deleted_at IS NULL',
    'o.deleted_at IS NULL',
    `o.state IN (${LAUNCHABLE_OBJECTIVE_STATES.map(() => '?').join(', ')})`,
    '(er.execution_target_id IS NULL OR er.execution_target_id = ?)'
  ];
  const params: string[] = [
    ctx.workspace.id,
    ...LAUNCHABLE_OBJECTIVE_STATES,
    target.executionTargetId
  ];
  if (projectId) {
    conditions.push('er.project_id = ?');
    params.push(await resolveProjectId(ctx, projectId));
  }

  return await ctx.db.transaction(async (tx): Promise<ClaimedExecutionRequest | null> => {
    const txCtx = { ...ctx, db: tx };
    const candidate = (await txCtx.db.get(
      `SELECT er.id, er.workspace_id, er.project_id, er.mission_id, er.objective_id,
                er.execution_target_id, er.status, er.revision, er.launch_flags_json,
                er.launched_session_id, er.resolved_working_directory
           FROM execution_requests er
           JOIN objectives o ON o.id = er.objective_id
          WHERE ${conditions.join(' AND ')}
          ORDER BY er.created_at ASC
          LIMIT 1`,
      params
    )) as (ExecutionRequestStateRow & { resolved_working_directory: string | null }) | undefined;

    if (!candidate) return null;

    let workingDirectory: string;
    let resourceId: string | null;
    try {
      ({ workingDirectory, resourceId } = await resolveWorkingDirectory({
        ctx: txCtx,
        projectId: candidate.project_id,
        explicitWorkingDirectory: candidate.resolved_working_directory,
        executionTargetId: candidate.execution_target_id ?? target.executionTargetId
      }));
    } catch (error) {
      if (
        error instanceof ServiceError &&
        (error.code === 'primary_resource_not_connected' ||
          error.code === 'working_directory_missing')
      ) {
        await markExecutionFailed({ ctx: txCtx, requestId: candidate.id, error: error.message });
        return null;
      }
      throw error;
    }

    const now = nowIso();
    const expires = new Date(Date.now() + claimTtlMs).toISOString();
    const revision = candidate.revision + 1;
    const updated = await txCtx.db.run(
      `UPDATE execution_requests
            SET status = 'claimed',
                claimed_by_device_id = ?,
                claimed_by_execution_target_id = ?,
                claimed_at = ?,
                claim_expires_at = ?,
                resolved_resource_id = COALESCE(resolved_resource_id, ?),
                resolved_working_directory = ?,
                attempt_count = attempt_count + 1,
                updated_at = ?,
                revision = ?
          WHERE id = ? AND status = 'queued' AND revision = ?`,
      [
        target.deviceId,
        target.executionTargetId,
        now,
        expires,
        resourceId,
        workingDirectory,
        now,
        revision,
        candidate.id,
        candidate.revision
      ]
    );

    if (updated.changes === 0) return null;

    await recordExecutionRequestUpdate({
      ctx: txCtx,
      row: candidate,
      revision,
      changedFields: [
        'status',
        'claimed_by_device_id',
        'claimed_by_execution_target_id',
        'claimed_at',
        'claim_expires_at',
        'resolved_working_directory'
      ]
    });
    await appendExecutionRequestEvent({
      ctx: txCtx,
      row: candidate,
      summary: 'Runner claimed execution request.'
    });

    const claimed = await getExecutionRequest({ ctx: txCtx, id: candidate.id });
    return { ...claimed, workingDirectory };
  });
}

export async function markExecutionLaunching({
  ctx,
  requestId
}: {
  ctx: ServiceContext;
  requestId: string;
}): Promise<ExecutionRequestSummary> {
  return await ctx.db.transaction(async tx => {
    const txCtx = { ...ctx, db: tx };
    const row = await getExecutionRequestStateRow({ ctx: txCtx, requestId });
    assertTransition({ row, allowedFrom: ['claimed'], to: 'launching' });
    const now = nowIso();
    const revision = row.revision + 1;
    const updated = await txCtx.db.run(
      `UPDATE execution_requests
            SET status = 'launching',
                launch_started_at = ?,
                updated_at = ?,
                revision = ?
          WHERE id = ? AND status = 'claimed' AND revision = ?`,
      [now, now, revision, requestId, row.revision]
    );
    if (updated.changes === 0) {
      throw new ServiceError(
        'Execution request changed while marking launch started',
        'execution_request_conflict',
        409
      );
    }
    await recordExecutionRequestUpdate({
      ctx: txCtx,
      row,
      revision,
      changedFields: ['status', 'launch_started_at']
    });
    await appendExecutionRequestEvent({
      ctx: txCtx,
      row,
      summary: 'Runner started launching execution request.'
    });
    return await getExecutionRequest({ ctx: txCtx, id: requestId });
  });
}

export async function markExecutionLaunched({
  ctx,
  requestId
}: {
  ctx: ServiceContext;
  requestId: string;
}): Promise<ExecutionRequestSummary> {
  return await ctx.db.transaction(async tx => {
    const txCtx = { ...ctx, db: tx };
    const row = await getExecutionRequestStateRow({ ctx: txCtx, requestId });
    assertTransition({ row, allowedFrom: ['launching'], to: 'launched' });
    const now = nowIso();
    const revision = row.revision + 1;
    const updated = await txCtx.db.run(
      `UPDATE execution_requests
            SET status = 'launched',
                launch_completed_at = ?,
                updated_at = ?,
                revision = ?
          WHERE id = ? AND status = 'launching' AND revision = ?`,
      [now, now, revision, requestId, row.revision]
    );
    if (updated.changes === 0) {
      throw new ServiceError(
        'Execution request changed while marking launch complete',
        'execution_request_conflict',
        409
      );
    }
    await recordExecutionRequestUpdate({
      ctx: txCtx,
      row,
      revision,
      changedFields: ['status', 'launch_completed_at']
    });
    await appendExecutionRequestEvent({
      ctx: txCtx,
      row,
      summary: 'Runner opened the agent launch command.'
    });
    return await getExecutionRequest({ ctx: txCtx, id: requestId });
  });
}

export async function markExecutionFailed({
  ctx,
  requestId,
  error
}: {
  ctx: ServiceContext;
  requestId: string;
  error: string;
}): Promise<ExecutionRequestSummary> {
  return await ctx.db.transaction(async tx => {
    const txCtx = { ...ctx, db: tx };
    const row = await getExecutionRequestStateRow({ ctx: txCtx, requestId });
    assertTransition({ row, allowedFrom: ['queued', 'claimed', 'launching'], to: 'failed' });
    const now = nowIso();
    const revision = row.revision + 1;
    const updated = await txCtx.db.run(
      `UPDATE execution_requests
            SET status = 'failed',
                last_error = ?,
                launch_completed_at = ?,
                updated_at = ?,
                revision = ?
          WHERE id = ? AND status = ? AND revision = ?`,
      [error, now, now, revision, requestId, row.status, row.revision]
    );
    if (updated.changes === 0) {
      throw new ServiceError(
        'Execution request changed while marking launch failed',
        'execution_request_conflict',
        409
      );
    }
    await recordExecutionRequestUpdate({
      ctx: txCtx,
      row,
      revision,
      changedFields: ['status', 'last_error', 'launch_completed_at']
    });
    await appendExecutionRequestEvent({
      ctx: txCtx,
      row,
      summary: `Agent run failed: ${error}`,
      payload: { error }
    });
    return await getExecutionRequest({ ctx: txCtx, id: requestId });
  });
}

export async function clearExecutionRequests({
  ctx,
  objectiveId,
  projectId,
  now = nowIso(),
  emitEvents = true,
  eventSummary = 'Cleared execution request.'
}: {
  ctx: ServiceContext;
  objectiveId?: string | null;
  projectId?: string | null;
  now?: string;
  emitEvents?: boolean;
  eventSummary?: string;
}): Promise<{ cleared: number }> {
  return await ctx.db.transaction(async tx => {
    const txCtx = { ...ctx, db: tx };
    const conditions = [
      `workspace_id = ?`,
      `deleted_at IS NULL`,
      `status IN (${ACTIVE_EXECUTION_REQUEST_STATUSES.map(() => '?').join(', ')})`
    ];
    const params: Array<string> = [ctx.workspace.id, ...ACTIVE_EXECUTION_REQUEST_STATUSES];
    if (objectiveId) {
      conditions.push('objective_id = ?');
      params.push(objectiveId);
    }
    if (projectId) {
      conditions.push('project_id = ?');
      params.push(await resolveProjectId(txCtx, projectId));
    }
    const rows = (await txCtx.db.all(
      `SELECT id, workspace_id, project_id, mission_id, objective_id, execution_target_id,
                status, revision, launch_flags_json, launched_session_id
           FROM execution_requests
          WHERE ${conditions.join(' AND ')}`,
      params
    )) as ExecutionRequestStateRow[];
    for (const row of rows) {
      const revision = row.revision + 1;
      await txCtx.db.run(
        `UPDATE execution_requests
              SET status = 'cleared',
                  updated_at = ?,
                  revision = ?
            WHERE id = ? AND status = ? AND revision = ?`,
        [now, revision, row.id, row.status, row.revision]
      );
      await recordExecutionRequestUpdate({
        ctx: txCtx,
        row,
        revision,
        changedFields: ['status']
      });
      if (emitEvents) {
        await appendExecutionRequestEvent({
          ctx: txCtx,
          row,
          summary: eventSummary
        });
      }
    }
    return { cleared: rows.length };
  });
}

export async function expireStaleExecutionRequests({
  ctx,
  now = nowIso(),
  launchAttachTtlMs = LAUNCH_ATTACH_TTL_MS
}: {
  ctx: ServiceContext;
  now?: string;
  launchAttachTtlMs?: number;
}): Promise<{ expired: number }> {
  return await ctx.db.transaction(async tx => {
    const txCtx = { ...ctx, db: tx };
    const attachCutoff = new Date(Date.now() - launchAttachTtlMs).toISOString();
    const rows = (await txCtx.db.all(
      `SELECT er.id, er.workspace_id, er.project_id, er.mission_id, er.objective_id,
                er.execution_target_id, er.status, er.revision, er.launch_flags_json,
                er.launched_session_id
           FROM execution_requests er
           JOIN objectives o ON o.id = er.objective_id
          WHERE er.workspace_id = ?
            AND er.deleted_at IS NULL
            AND (
              (er.status = 'claimed' AND er.claim_expires_at IS NOT NULL AND er.claim_expires_at < ?)
              OR
              (er.status = 'launched' AND er.launched_session_id IS NULL
                AND er.launch_completed_at IS NOT NULL AND er.launch_completed_at < ?
                AND o.state IN (${LAUNCHABLE_OBJECTIVE_STATES.map(() => '?').join(', ')}))
            )`,
      [ctx.workspace.id, now, attachCutoff, ...LAUNCHABLE_OBJECTIVE_STATES]
    )) as ExecutionRequestStateRow[];

    for (const row of rows) {
      const revision = row.revision + 1;
      const message =
        row.status === 'claimed'
          ? 'Execution request expired before launch started.'
          : 'Execution request expired before the launched agent attached.';
      await txCtx.db.run(
        `UPDATE execution_requests
              SET status = 'expired',
                  last_error = ?,
                  updated_at = ?,
                  revision = ?
            WHERE id = ? AND status = ? AND revision = ?`,
        [message, now, revision, row.id, row.status, row.revision]
      );
      await recordExecutionRequestUpdate({
        ctx: txCtx,
        row,
        revision,
        changedFields: ['status', 'last_error']
      });
      await appendExecutionRequestEvent({
        ctx: txCtx,
        row,
        summary: message
      });
    }

    return { expired: rows.length };
  });
}

export async function linkExecutionRequestToSession({
  ctx,
  missionId,
  objectiveId,
  sessionId,
  executionRequestId
}: {
  ctx: ServiceContext;
  missionId: string;
  objectiveId: string;
  sessionId: string;
  executionRequestId?: string | null;
}): Promise<ExecutionRequestSummary | null> {
  return await ctx.db.transaction(async tx => {
    const txCtx = { ...ctx, db: tx };
    const row = executionRequestId
      ? ((await txCtx.db.get(
          `SELECT id, workspace_id, project_id, mission_id, objective_id, execution_target_id,
                    status, revision, launch_flags_json, launched_session_id
               FROM execution_requests
              WHERE id = ?
                AND workspace_id = ?
                AND mission_id = ?
                AND objective_id = ?
                AND deleted_at IS NULL`,
          [executionRequestId, ctx.workspace.id, missionId, objectiveId]
        )) as ExecutionRequestStateRow | undefined)
      : ((await txCtx.db.get(
          `SELECT id, workspace_id, project_id, mission_id, objective_id, execution_target_id,
                    status, revision, launch_flags_json, launched_session_id
               FROM execution_requests
              WHERE workspace_id = ?
                AND mission_id = ?
                AND objective_id = ?
                AND status IN ('launching', 'launched')
                AND launched_session_id IS NULL
                AND deleted_at IS NULL
              ORDER BY updated_at DESC, created_at DESC
              LIMIT 1`,
          [ctx.workspace.id, missionId, objectiveId]
        )) as ExecutionRequestStateRow | undefined);

    if (!row) {
      if (executionRequestId) {
        throw new ServiceError(
          'Execution request does not match this mission/objective',
          'execution_request_mismatch',
          409
        );
      }
      return null;
    }

    if (!['launching', 'launched'].includes(row.status)) {
      throw new ServiceError(
        `Cannot link execution request in ${row.status} state to a session`,
        'invalid_execution_request_transition',
        409
      );
    }

    if (row.launched_session_id && row.launched_session_id !== sessionId) {
      throw new ServiceError(
        'Execution request is already linked to another session',
        'execution_request_already_linked',
        409
      );
    }
    if (row.launched_session_id === sessionId)
      return await getExecutionRequest({ ctx: txCtx, id: row.id });

    const now = nowIso();
    const revision = row.revision + 1;
    const updated = await txCtx.db.run(
      `UPDATE execution_requests
            SET launched_session_id = ?,
                updated_at = ?,
                revision = ?
          WHERE id = ?
            AND revision = ?
            AND (launched_session_id IS NULL OR launched_session_id = ?)`,
      [sessionId, now, revision, row.id, row.revision, sessionId]
    );
    if (updated.changes === 0) {
      throw new ServiceError(
        'Execution request changed while linking session',
        'execution_request_conflict',
        409
      );
    }
    await recordExecutionRequestUpdate({
      ctx: txCtx,
      row,
      revision,
      changedFields: ['launched_session_id']
    });
    return await getExecutionRequest({ ctx: txCtx, id: row.id });
  });
}
