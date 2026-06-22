import { assertPrimaryResourceConnected } from '../../src/service/projects.ts';

import { ACTOR_WORKSPACE_USER_ID, db, newId, nowIso, recordChange, WORKSPACE } from './db.ts';
import { ApiError } from './errors.ts';

type ExecutionRequestRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  ticket_id: string;
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
  id, workspace_id, project_id, ticket_id, objective_id, execution_target_id,
  requested_agent, requested_model, requested_reasoning_effort, launch_flags_json,
  status, requested_source, resolved_working_directory, last_error, created_at, updated_at, revision
`;

const EXECUTION_REQUEST_COLUMNS_WITH_ALIAS = `
  er.id, er.workspace_id, er.project_id, er.ticket_id, er.objective_id, er.execution_target_id,
  er.requested_agent, er.requested_model, er.requested_reasoning_effort, er.launch_flags_json,
  er.status, er.requested_source, er.resolved_working_directory, er.last_error,
  er.created_at, er.updated_at, er.revision
`;

function parseLaunchConfig(json: string): { preCommand: string; flags: string[] } {
  try {
    const parsed = JSON.parse(json) as { preCommand?: unknown; flags?: unknown };
    return {
      preCommand: typeof parsed.preCommand === 'string' ? parsed.preCommand : '',
      flags: Array.isArray(parsed.flags)
        ? parsed.flags.filter(flag => typeof flag === 'string')
        : []
    };
  } catch {
    return { preCommand: '', flags: [] };
  }
}

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

function toDto(row: ExecutionRequestRow): Record<string, unknown> {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    ticketId: row.ticket_id,
    objectiveId: row.objective_id,
    executionTargetId: row.execution_target_id,
    requestedAgent: row.requested_agent,
    requestedModel: row.requested_model,
    requestedReasoningEffort: row.requested_reasoning_effort,
    launchConfig: parseLaunchConfig(row.launch_flags_json),
    status: row.status,
    requestedSource: row.requested_source,
    workingDirectory: row.resolved_working_directory,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function activeRows(projectId?: string | null): ExecutionRequestRow[] {
  return db
    .prepare(
      `SELECT ${EXECUTION_REQUEST_COLUMNS}
         FROM execution_requests
        WHERE workspace_id = @workspace_id
          AND deleted_at IS NULL
          AND status IN ('queued', 'claimed', 'launching')
          AND (@project_id IS NULL OR project_id = @project_id)
        ORDER BY created_at ASC`
    )
    .all({ workspace_id: WORKSPACE.id, project_id: projectId ?? null }) as ExecutionRequestRow[];
}

function serviceContext() {
  return {
    db,
    workspace: { id: WORKSPACE.id, slug: WORKSPACE.slug, name: WORKSPACE.name },
    actorWorkspaceUserId: ACTOR_WORKSPACE_USER_ID,
    source: 'runner' as const
  };
}

function failQueuedRequest({ row, error }: { row: ExecutionRequestRow; error: string }): void {
  const now = nowIso();
  const revision = row.revision + 1;
  db.prepare(
    `UPDATE execution_requests
        SET status = 'failed',
            last_error = @error,
            launch_completed_at = @now,
            updated_at = @now,
            revision = @revision
      WHERE id = @id AND status = 'queued'`
  ).run({ id: row.id, error, now, revision });
  recordChange({
    entityType: 'execution_request',
    entityId: row.id,
    operation: 'update',
    entityRevision: revision,
    projectId: row.project_id,
    ticketId: row.ticket_id,
    objectiveId: row.objective_id,
    changedFields: ['status', 'last_error']
  });
  db.prepare(
    `INSERT INTO ticket_events
       (id, workspace_id, project_id, ticket_id, objective_id, type, phase, summary,
        payload_json, source, actor_workspace_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, 'status_change', 'execute', ?, ?, 'runner', NULL, ?)`
  ).run(
    newId(),
    WORKSPACE.id,
    row.project_id,
    row.ticket_id,
    row.objective_id,
    'Agent run failed: primary resource is not connected.',
    JSON.stringify({ executionRequestId: row.id, error }),
    now
  );
}

export function runnerStatus(projectId?: string | null): Record<string, unknown> {
  const queue = activeRows(projectId).map(toDto);
  return {
    workspace: WORKSPACE,
    queue,
    activeCount: queue.length
  };
}

export const claimRunnerRequest = db.transaction(
  ({ projectId }: { projectId?: string | null } = {}): {
    request: Record<string, unknown> | null;
  } => {
    const row = db
      .prepare(
        `SELECT ${EXECUTION_REQUEST_COLUMNS_WITH_ALIAS}
           FROM execution_requests er
           JOIN objectives o ON o.id = er.objective_id
          WHERE er.workspace_id = @workspace_id
            AND er.deleted_at IS NULL
            AND er.status = 'queued'
            AND o.deleted_at IS NULL
            AND o.state IN ('draft', 'submitted', 'launching')
            AND (@project_id IS NULL OR er.project_id = @project_id)
          ORDER BY er.created_at ASC
          LIMIT 1`
      )
      .get({ workspace_id: WORKSPACE.id, project_id: projectId ?? null }) as
      | ExecutionRequestRow
      | undefined;

    if (!row) return { request: null };

    let connected;
    try {
      connected = assertPrimaryResourceConnected({
        ctx: serviceContext(),
        projectId: row.project_id,
        executionTargetId: row.execution_target_id
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failQueuedRequest({ row, error: message });
      return { request: null };
    }

    const now = nowIso();
    const resource = {
      id: connected.resource.id,
      path: connected.workingDirectory
    };
    const revision = row.revision + 1;
    db.prepare(
      `UPDATE execution_requests
          SET status = 'claimed',
              claimed_at = @now,
              resolved_resource_id = @resource_id,
              resolved_working_directory = @working_directory,
              attempt_count = attempt_count + 1,
              updated_at = @now,
              revision = @revision
        WHERE id = @id AND status = 'queued'`
    ).run({
      id: row.id,
      now,
      resource_id: resource.id,
      working_directory: resource.path,
      revision
    });
    recordChange({
      entityType: 'execution_request',
      entityId: row.id,
      operation: 'update',
      entityRevision: revision,
      projectId: row.project_id,
      ticketId: row.ticket_id,
      objectiveId: row.objective_id,
      changedFields: ['status', 'claimed_at', 'resolved_working_directory']
    });
    db.prepare(
      `INSERT INTO ticket_events
         (id, workspace_id, project_id, ticket_id, objective_id, type, phase, summary,
          payload_json, source, actor_workspace_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'status_change', 'execute', ?, ?, 'runner', NULL, ?)`
    ).run(
      newId(),
      WORKSPACE.id,
      row.project_id,
      row.ticket_id,
      row.objective_id,
      'Runner claimed execution request.',
      JSON.stringify({ executionRequestId: row.id }),
      now
    );

    const updated = db
      .prepare(`SELECT ${EXECUTION_REQUEST_COLUMNS} FROM execution_requests WHERE id = ?`)
      .get(row.id) as ExecutionRequestRow;
    return { request: toDto(updated) };
  }
);

export const updateRunnerRequestStatus = db.transaction(
  ({
    requestId,
    status,
    error
  }: {
    requestId: string;
    status: 'launching' | 'launched' | 'failed';
    error?: string | null;
  }): Record<string, unknown> => {
    const row = db
      .prepare(`SELECT ${EXECUTION_REQUEST_COLUMNS} FROM execution_requests WHERE id = ?`)
      .get(requestId) as ExecutionRequestRow | undefined;
    if (!row) throw new ApiError(404, 'Execution request not found');

    const now = nowIso();
    const revision = row.revision + 1;
    const timestampColumn =
      status === 'launching'
        ? 'launch_started_at'
        : status === 'launched'
          ? 'launch_completed_at'
          : 'launch_completed_at';
    db.prepare(
      `UPDATE execution_requests
          SET status = @status,
              ${timestampColumn} = @now,
              last_error = @last_error,
              updated_at = @now,
              revision = @revision
        WHERE id = @id`
    ).run({
      id: requestId,
      status,
      now,
      last_error: status === 'failed' ? (error ?? 'Launch failed') : null,
      revision
    });
    recordChange({
      entityType: 'execution_request',
      entityId: requestId,
      operation: 'update',
      entityRevision: revision,
      projectId: row.project_id,
      ticketId: row.ticket_id,
      objectiveId: row.objective_id,
      changedFields: ['status']
    });

    const updated = db
      .prepare(`SELECT ${EXECUTION_REQUEST_COLUMNS} FROM execution_requests WHERE id = ?`)
      .get(requestId) as ExecutionRequestRow;
    return toDto(updated);
  }
);

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
    ticketId,
    requestId,
    payload
  }: {
    ticketId: string;
    requestId?: string | null;
    payload: unknown;
  }): { ok: true } => {
    const branch = requireBranchPayload(payload);
    const ticket = db
      .prepare(
        `SELECT id, project_id, revision FROM tickets
          WHERE workspace_id = @workspace_id
            AND deleted_at IS NULL
            AND (id = @ticket_id OR display_id = @ticket_id)`
      )
      .get({ workspace_id: WORKSPACE.id, ticket_id: ticketId }) as
      | { id: string; project_id: string; revision: number }
      | undefined;
    if (!ticket) throw new ApiError(404, 'Ticket not found');

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
        ticketId: row.ticket_id,
        objectiveId: row.objective_id,
        changedFields: ['launch_flags_json', 'resolved_working_directory']
      });
    }

    const now = nowIso();

    // `tickets.active_branch` is the source of truth for which branch a ticket is
    // operating on (read by merge detection and the REST/ticket-panel surfaces).
    const ticketRevision = ticket.revision + 1;
    db.prepare(
      `UPDATE tickets
          SET active_branch = @active_branch, updated_at = @now, revision = @revision
        WHERE id = @id`
    ).run({ active_branch: branch.branchName, now, revision: ticketRevision, id: ticket.id });
    recordChange({
      entityType: 'ticket',
      entityId: ticket.id,
      operation: 'update',
      entityRevision: ticketRevision,
      projectId: ticket.project_id,
      ticketId: ticket.id,
      objectiveId,
      changedFields: ['active_branch']
    });

    // Human-readable audit entry for the activity feed. `branch_prepared` is not
    // part of the closed `ticket_events.type` vocabulary, so this records under
    // the allowed `update` type with the structured detail in the payload.
    db.prepare(
      `INSERT INTO ticket_events
         (id, workspace_id, project_id, ticket_id, objective_id, type, phase, summary,
          payload_json, source, actor_workspace_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'update', 'execute', ?, ?, 'runner', NULL, ?)`
    ).run(
      newId(),
      WORKSPACE.id,
      ticket.project_id,
      ticket.id,
      objectiveId,
      `Prepared branch ${branch.branchName} in worktree ${branch.worktreePath}.`,
      JSON.stringify(branch),
      now
    );
    return { ok: true };
  }
);

export const clearRunnerRequests = db.transaction(
  ({ objectiveId, projectId }: { objectiveId?: string | null; projectId?: string | null } = {}) => {
    const rows = db
      .prepare(
        `SELECT ${EXECUTION_REQUEST_COLUMNS}
           FROM execution_requests
          WHERE workspace_id = @workspace_id
            AND deleted_at IS NULL
            AND status IN ('queued', 'claimed', 'launching')
            AND (@objective_id IS NULL OR objective_id = @objective_id)
            AND (@project_id IS NULL OR project_id = @project_id)`
      )
      .all({
        workspace_id: WORKSPACE.id,
        objective_id: objectiveId ?? null,
        project_id: projectId ?? null
      }) as ExecutionRequestRow[];

    const now = nowIso();
    for (const row of rows) {
      const revision = row.revision + 1;
      db.prepare(
        `UPDATE execution_requests
            SET status = 'cleared', updated_at = @now, revision = @revision
          WHERE id = @id`
      ).run({ id: row.id, now, revision });
      recordChange({
        entityType: 'execution_request',
        entityId: row.id,
        operation: 'update',
        entityRevision: revision,
        projectId: row.project_id,
        ticketId: row.ticket_id,
        objectiveId: row.objective_id,
        changedFields: ['status']
      });
    }

    return { cleared: rows.length };
  }
);
