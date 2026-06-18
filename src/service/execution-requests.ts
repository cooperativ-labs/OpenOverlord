import { existsSync } from 'node:fs';
import path from 'node:path';

import { recordChange } from './change-feed.js';
import type { ServiceContext } from './context.js';
import { resolveProjectId, resolveTicketId } from './context.js';
import { getDevice } from './devices.js';
import { ServiceError } from './errors.js';
import { assertPrimaryResourceConnected } from './projects.js';
import { newId, nowIso } from './util.js';

const ACTIVE_STATUSES = ['queued', 'claimed', 'launching'] as const;
const LAUNCHABLE_OBJECTIVE_STATES = ['draft', 'submitted', 'launching'] as const;

export type ExecutionRequestSummary = {
  id: string;
  projectId: string;
  ticketId: string;
  ticketDisplayId: string;
  objectiveId: string;
  objectiveTitle: string;
  objectiveState: string;
  requestedAgent: string | null;
  requestedModel: string | null;
  requestedReasoningEffort: string | null;
  launchFlags: Record<string, unknown>;
  requestedSource: string;
  status: string;
  claimedByDeviceId: string | null;
  claimExpiresAt: string | null;
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
  project_id: string;
  ticket_id: string;
  display_id: string;
  objective_id: string;
  title: string;
  state: string;
  requested_agent: string | null;
  requested_model: string | null;
  requested_reasoning_effort: string | null;
  launch_flags_json: string;
  requested_source: string;
  status: string;
  claimed_by_device_id: string | null;
  claim_expires_at: string | null;
  resolved_working_directory: string | null;
  last_error: string | null;
  attempt_count: number;
  created_at: string;
  updated_at: string;
}): ExecutionRequestSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    ticketId: row.ticket_id,
    ticketDisplayId: row.display_id,
    objectiveId: row.objective_id,
    objectiveTitle: row.title,
    objectiveState: row.state,
    requestedAgent: row.requested_agent,
    requestedModel: row.requested_model,
    requestedReasoningEffort: row.requested_reasoning_effort,
    launchFlags: parseJsonObject(row.launch_flags_json),
    requestedSource: row.requested_source,
    status: row.status,
    claimedByDeviceId: row.claimed_by_device_id,
    claimExpiresAt: row.claim_expires_at,
    resolvedWorkingDirectory: row.resolved_working_directory,
    lastError: row.last_error,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function getExecutionRequest({
  ctx,
  id
}: {
  ctx: ServiceContext;
  id: string;
}): ExecutionRequestSummary {
  const row = ctx.db
    .prepare(
      `SELECT er.*, t.display_id, o.title, o.state
       FROM execution_requests er
       JOIN tickets t ON t.id = er.ticket_id
       JOIN objectives o ON o.id = er.objective_id
       WHERE er.id = ? AND er.workspace_id = ? AND er.deleted_at IS NULL`
    )
    .get(id, ctx.workspace.id) as Parameters<typeof rowToSummary>[0] | undefined;

  if (!row) {
    throw new ServiceError('Execution request not found', 'execution_request_not_found', 404);
  }
  return rowToSummary(row);
}

function resolveWorkingDirectory({
  ctx,
  projectId,
  explicitWorkingDirectory,
  executionTargetId = null
}: {
  ctx: ServiceContext;
  projectId: string;
  explicitWorkingDirectory?: string | null | undefined;
  executionTargetId?: string | null;
}): { workingDirectory: string; resourceId: string | null } {
  if (explicitWorkingDirectory?.trim()) {
    const resolved = path.resolve(explicitWorkingDirectory);
    if (!existsSync(resolved)) {
      throw new ServiceError(
        `Working directory does not exist: ${resolved}`,
        'working_directory_missing'
      );
    }
    return { workingDirectory: resolved, resourceId: null };
  }

  const connected = assertPrimaryResourceConnected({ ctx, projectId, executionTargetId });
  return {
    workingDirectory: connected.workingDirectory,
    resourceId: connected.resource.id
  };
}

export function createExecutionRequest({
  ctx,
  ticketId,
  objectiveId,
  requestedAgent,
  requestedModel,
  requestedReasoningEffort,
  launchFlags = {},
  requestedSource,
  idempotencyKey,
  workingDirectory
}: {
  ctx: ServiceContext;
  ticketId: string;
  objectiveId?: string | null;
  requestedAgent?: string | null;
  requestedModel?: string | null;
  requestedReasoningEffort?: string | null;
  launchFlags?: Record<string, unknown>;
  requestedSource: string;
  idempotencyKey?: string | null;
  workingDirectory?: string | null;
}): ExecutionRequestSummary {
  const ticket = resolveTicketId(ctx, ticketId);
  const objective = objectiveId
    ? (ctx.db
        .prepare(`SELECT id, state FROM objectives WHERE id = ? AND ticket_id = ?`)
        .get(objectiveId, ticket.id) as { id: string; state: string } | undefined)
    : (ctx.db
        .prepare(
          `SELECT id, state FROM objectives
           WHERE ticket_id = ? AND state IN ('draft', 'submitted', 'launching')
           ORDER BY position ASC LIMIT 1`
        )
        .get(ticket.id) as { id: string; state: string } | undefined);

  if (!objective) {
    throw new ServiceError(
      'No launchable objective found for ticket',
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
    const existing = ctx.db
      .prepare(
        `SELECT id FROM execution_requests
         WHERE workspace_id = ? AND idempotency_key = ? AND deleted_at IS NULL`
      )
      .get(ctx.workspace.id, idempotencyKey) as { id: string } | undefined;
    if (existing) return getExecutionRequest({ ctx, id: existing.id });
  }

  const now = nowIso();
  const id = newId();
  const resolvedProjectId = resolveProjectId(ctx, ticket.projectId);
  const { workingDirectory: resolvedDirectory, resourceId } = resolveWorkingDirectory({
    ctx,
    projectId: resolvedProjectId,
    explicitWorkingDirectory: workingDirectory
  });

  const tx = ctx.db.transaction(() => {
    ctx.db
      .prepare(
        `INSERT INTO execution_requests
           (id, workspace_id, project_id, ticket_id, objective_id, requested_agent,
            requested_model, requested_reasoning_effort, launch_mode, launch_flags_json,
            target_kind, requested_source, idempotency_key, status, requested_by_workspace_user_id,
            resolved_resource_id, resolved_working_directory, created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'run', ?, 'local', ?, ?, 'queued', ?, ?, ?, ?, ?, 1)`
      )
      .run(
        id,
        ctx.workspace.id,
        resolvedProjectId,
        ticket.id,
        objective.id,
        requestedAgent ?? null,
        requestedModel ?? null,
        requestedReasoningEffort ?? null,
        JSON.stringify(launchFlags),
        requestedSource,
        idempotencyKey ?? null,
        ctx.actorWorkspaceUserId,
        resourceId,
        resolvedDirectory,
        now,
        now
      );

    ctx.db
      .prepare(
        `INSERT INTO ticket_events
           (id, workspace_id, project_id, ticket_id, objective_id,
            type, phase, summary, payload_json, source, actor_workspace_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, 'execution_requested', 'execute', ?, ?, ?, ?, ?)`
      )
      .run(
        newId(),
        ctx.workspace.id,
        resolvedProjectId,
        ticket.id,
        objective.id,
        `Queued execution request for ${requestedAgent ?? 'default agent'}.`,
        JSON.stringify({ executionRequestId: id, requestedSource }),
        ctx.source,
        ctx.actorWorkspaceUserId,
        now
      );

    recordChange({
      ctx,
      entityType: 'execution_request',
      entityId: id,
      operation: 'insert',
      entityRevision: 1,
      projectId: resolvedProjectId,
      ticketId: ticket.id,
      objectiveId: objective.id
    });
  });

  tx();
  return getExecutionRequest({ ctx, id });
}

export function listExecutionRequests({
  ctx,
  projectId,
  includeInactive = false,
  limit = 50
}: {
  ctx: ServiceContext;
  projectId?: string | null;
  includeInactive?: boolean;
  limit?: number;
}): ExecutionRequestSummary[] {
  const conditions = ['er.workspace_id = ?', 'er.deleted_at IS NULL'];
  const params: Array<string | number> = [ctx.workspace.id];
  if (!includeInactive) {
    conditions.push(`er.status IN (${ACTIVE_STATUSES.map(() => '?').join(', ')})`);
    params.push(...ACTIVE_STATUSES);
  }
  if (projectId) {
    conditions.push('er.project_id = ?');
    params.push(resolveProjectId(ctx, projectId));
  }
  params.push(limit);

  const rows = ctx.db
    .prepare(
      `SELECT er.*, t.display_id, o.title, o.state
       FROM execution_requests er
       JOIN tickets t ON t.id = er.ticket_id
       JOIN objectives o ON o.id = er.objective_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY er.created_at ASC
       LIMIT ?`
    )
    .all(...params) as Array<Parameters<typeof rowToSummary>[0]>;
  return rows.map(rowToSummary);
}

export function claimNextExecutionRequest({
  ctx,
  projectId,
  claimTtlMs = 15 * 60 * 1000
}: {
  ctx: ServiceContext;
  projectId?: string | null;
  claimTtlMs?: number;
}): ClaimedExecutionRequest | null {
  const device = getDevice({ ctx });
  const conditions = [
    'er.workspace_id = ?',
    "er.status = 'queued'",
    'er.deleted_at IS NULL',
    'o.deleted_at IS NULL',
    "o.state IN ('draft', 'submitted', 'launching')"
  ];
  const params: string[] = [ctx.workspace.id];
  if (projectId) {
    conditions.push('er.project_id = ?');
    params.push(resolveProjectId(ctx, projectId));
  }

  const candidate = ctx.db
    .prepare(
      `SELECT er.id, er.project_id, er.execution_target_id, er.resolved_working_directory
       FROM execution_requests er
       JOIN objectives o ON o.id = er.objective_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY er.created_at ASC
       LIMIT 1`
    )
    .get(...params) as
    | {
        id: string;
        project_id: string;
        execution_target_id: string | null;
        resolved_working_directory: string | null;
      }
    | undefined;

  if (!candidate) return null;

  let workingDirectory: string;
  let resourceId: string | null;
  try {
    ({ workingDirectory, resourceId } = resolveWorkingDirectory({
      ctx,
      projectId: candidate.project_id,
      explicitWorkingDirectory: candidate.resolved_working_directory,
      executionTargetId: candidate.execution_target_id
    }));
  } catch (error) {
    if (
      error instanceof ServiceError &&
      (error.code === 'primary_resource_not_connected' ||
        error.code === 'working_directory_missing')
    ) {
      markExecutionFailed({ ctx, requestId: candidate.id, error: error.message });
      return null;
    }
    throw error;
  }

  const now = nowIso();
  const expires = new Date(Date.now() + claimTtlMs).toISOString();
  const updated = ctx.db
    .prepare(
      `UPDATE execution_requests
       SET status = 'claimed', claimed_by_device_id = ?, claimed_at = ?, claim_expires_at = ?,
           resolved_resource_id = COALESCE(resolved_resource_id, ?),
           resolved_working_directory = ?, attempt_count = attempt_count + 1,
           updated_at = ?, revision = revision + 1
       WHERE id = ? AND status = 'queued'`
    )
    .run(device.id, now, expires, resourceId, workingDirectory, now, candidate.id);

  if (updated.changes === 0) return null;

  const claimed = getExecutionRequest({ ctx, id: candidate.id });
  return { ...claimed, workingDirectory };
}

export function markExecutionLaunching({
  ctx,
  requestId
}: {
  ctx: ServiceContext;
  requestId: string;
}): ExecutionRequestSummary {
  const now = nowIso();
  ctx.db
    .prepare(
      `UPDATE execution_requests
       SET status = 'launching', launch_started_at = ?, updated_at = ?, revision = revision + 1
       WHERE id = ? AND status = 'claimed'`
    )
    .run(now, now, requestId);
  return getExecutionRequest({ ctx, id: requestId });
}

export function markExecutionLaunched({
  ctx,
  requestId
}: {
  ctx: ServiceContext;
  requestId: string;
}): ExecutionRequestSummary {
  const now = nowIso();
  ctx.db
    .prepare(
      `UPDATE execution_requests
       SET status = 'launched', launch_completed_at = ?, updated_at = ?, revision = revision + 1
       WHERE id = ?`
    )
    .run(now, now, requestId);
  return getExecutionRequest({ ctx, id: requestId });
}

export function markExecutionFailed({
  ctx,
  requestId,
  error
}: {
  ctx: ServiceContext;
  requestId: string;
  error: string;
}): ExecutionRequestSummary {
  const now = nowIso();
  ctx.db
    .prepare(
      `UPDATE execution_requests
       SET status = 'failed', last_error = ?, launch_completed_at = ?, updated_at = ?, revision = revision + 1
       WHERE id = ?`
    )
    .run(error, now, now, requestId);
  return getExecutionRequest({ ctx, id: requestId });
}

export function clearExecutionRequests({
  ctx,
  objectiveId,
  projectId
}: {
  ctx: ServiceContext;
  objectiveId?: string | null;
  projectId?: string | null;
}): { cleared: number } {
  const conditions = [
    `workspace_id = ?`,
    `deleted_at IS NULL`,
    `status IN (${ACTIVE_STATUSES.map(() => '?').join(', ')})`
  ];
  const params: Array<string> = [ctx.workspace.id, ...ACTIVE_STATUSES];
  if (objectiveId) {
    conditions.push('objective_id = ?');
    params.push(objectiveId);
  }
  if (projectId) {
    conditions.push('project_id = ?');
    params.push(resolveProjectId(ctx, projectId));
  }
  const now = nowIso();
  const result = ctx.db
    .prepare(
      `UPDATE execution_requests
       SET status = 'cleared', updated_at = ?, revision = revision + 1
       WHERE ${conditions.join(' AND ')}`
    )
    .run(now, ...params);
  return { cleared: result.changes };
}
