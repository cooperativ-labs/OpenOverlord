import { OBJECTIVE_STATES } from '@overlord/database';

import { recordChange } from './change-feed.js';
import type { ServiceContext } from './context.js';
import { resolveProjectId, resolveTicketId } from './context.js';
import { ServiceError } from './errors.js';
import { initialTitleFromInstruction, newId, nowIso } from './util.js';

export type ObjectiveSummary = {
  id: string;
  ticketId: string;
  projectId: string;
  position: number;
  title: string | null;
  objective: string;
  state: string;
  autoAdvance: boolean;
};

export type TicketSummary = {
  id: string;
  displayId: string;
  projectId: string;
  title: string;
  statusType: string;
  statusId: string;
  priority: string | null;
  createdAt: string;
  updatedAt: string;
  objectiveCount: number;
};

export type TicketEventSummary = {
  id: string;
  type: string;
  phase: string | null;
  summary: string;
  createdAt: string;
  objectiveId: string | null;
};

export type SharedContextEntry = {
  key: string;
  value: unknown;
  tags: string[];
  updatedAt: string;
};

export type ArtifactSummary = {
  id: string;
  type: string;
  label: string;
  content: string | null;
  externalUrl: string | null;
};

export type AttachmentSummary = {
  id: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
  status: string;
};

function nextTicketSequence(ctx: ServiceContext): number {
  const row = ctx.db
    .prepare(
      `SELECT id, next_value FROM ticket_sequences
       WHERE workspace_id = ? AND scope_type = 'workspace' AND counter_name = 'ticket'`
    )
    .get(ctx.workspace.id) as { id: string; next_value: number } | undefined;

  if (!row) {
    throw new ServiceError('Ticket sequence not initialized', 'internal_error', 500);
  }

  const seq = row.next_value;
  ctx.db
    .prepare(`UPDATE ticket_sequences SET next_value = ?, updated_at = ? WHERE id = ?`)
    .run(seq + 1, nowIso(), row.id);
  return seq;
}

function getDefaultStatusId(
  ctx: ServiceContext,
  projectId: string
): {
  id: string;
  type: string;
} {
  const row = ctx.db
    .prepare(
      `SELECT id, type FROM project_statuses
       WHERE project_id = ? AND is_default = 1 AND deleted_at IS NULL LIMIT 1`
    )
    .get(projectId) as { id: string; type: string } | undefined;

  if (!row) {
    throw new ServiceError('Project has no default status', 'validation_error', 409);
  }
  return row;
}

function getReviewStatusId(
  ctx: ServiceContext,
  projectId: string
): {
  id: string;
  type: string;
} {
  const row = ctx.db
    .prepare(
      `SELECT id, type FROM project_statuses
       WHERE project_id = ? AND type = 'review' AND deleted_at IS NULL LIMIT 1`
    )
    .get(projectId) as { id: string; type: string } | undefined;

  if (!row) {
    throw new ServiceError('Project has no review status', 'validation_error', 409);
  }
  return row;
}

function getExecuteStatusId(
  ctx: ServiceContext,
  projectId: string
): {
  id: string;
  type: string;
} {
  const row = ctx.db
    .prepare(
      `SELECT id, type FROM project_statuses
       WHERE project_id = ? AND type = 'execute' AND deleted_at IS NULL LIMIT 1`
    )
    .get(projectId) as { id: string; type: string } | undefined;

  if (!row) {
    throw new ServiceError('Project has no execute status', 'validation_error', 409);
  }
  return row;
}

function topBoardPosition(ctx: ServiceContext, projectId: string, statusId: string): number {
  const row = ctx.db
    .prepare(
      `SELECT MIN(board_position) AS min_pos FROM tickets
       WHERE project_id = ? AND status_id = ? AND deleted_at IS NULL`
    )
    .get(projectId, statusId) as { min_pos: number | null };
  const minPos = row.min_pos;
  return minPos === null ? 100 : minPos - 100;
}

export function listObjectives({
  ctx,
  ticketId
}: {
  ctx: ServiceContext;
  ticketId: string;
}): ObjectiveSummary[] {
  const resolved = resolveTicketId(ctx, ticketId);
  const rows = ctx.db
    .prepare(
      `SELECT id, ticket_id, project_id, position, title, instruction_text, state, auto_advance
       FROM objectives WHERE ticket_id = ? AND deleted_at IS NULL ORDER BY position ASC`
    )
    .all(resolved.id) as Array<{
    id: string;
    ticket_id: string;
    project_id: string;
    position: number;
    title: string | null;
    instruction_text: string;
    state: string;
    auto_advance: number;
  }>;

  return rows.map(toObjectiveSummary);
}

function toObjectiveSummary(row: {
  id: string;
  ticket_id: string;
  project_id: string;
  position: number;
  title: string | null;
  instruction_text: string;
  state: string;
  auto_advance: number;
}): ObjectiveSummary {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    projectId: row.project_id,
    position: row.position,
    title: row.title,
    objective: row.instruction_text,
    state: row.state,
    autoAdvance: row.auto_advance === 1
  };
}

export function insertObjective({
  ctx,
  ticketId,
  instructionText,
  title,
  state,
  autoAdvance = false
}: {
  ctx: ServiceContext;
  ticketId: string;
  instructionText: string;
  title?: string | null;
  state?: string;
  autoAdvance?: boolean;
}): ObjectiveSummary {
  const instruction = instructionText.trim();
  if (!instruction) {
    throw new ServiceError('Objective instruction is required', 'validation_error');
  }

  const ticket = resolveTicketId(ctx, ticketId);
  const requestedState = state ?? 'draft';
  if (!OBJECTIVE_STATES.includes(requestedState as (typeof OBJECTIVE_STATES)[number])) {
    throw new ServiceError(`Invalid objective state: ${requestedState}`, 'validation_error');
  }

  const draftRow = ctx.db
    .prepare(
      `SELECT id FROM objectives
       WHERE ticket_id = ? AND state = 'draft' AND deleted_at IS NULL
       LIMIT 1`
    )
    .get(ticket.id) as { id: string } | undefined;
  const resolvedState = requestedState === 'draft' && draftRow ? 'future' : requestedState;

  const maxRow = ctx.db
    .prepare(
      `SELECT MAX(position) AS max_pos FROM objectives WHERE ticket_id = ? AND deleted_at IS NULL`
    )
    .get(ticket.id) as { max_pos: number | null };
  const position = (maxRow.max_pos ?? -1) + 1;
  const now = nowIso();
  const id = newId();

  ctx.db
    .prepare(
      `INSERT INTO objectives
         (id, workspace_id, project_id, ticket_id, position, title, instruction_text, state,
          agent_flags_json, auto_advance, execution_metadata_json,
          created_by_workspace_user_id, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, '{}', ?, ?, ?, 1)`
    )
    .run(
      id,
      ctx.workspace.id,
      ticket.projectId,
      ticket.id,
      position,
      title?.trim() || initialTitleFromInstruction(instruction),
      instruction,
      resolvedState,
      autoAdvance ? 1 : 0,
      ctx.actorWorkspaceUserId,
      now,
      now
    );

  recordChange({
    ctx,
    entityType: 'objective',
    entityId: id,
    operation: 'insert',
    entityRevision: 1,
    projectId: ticket.projectId,
    ticketId: ticket.id,
    objectiveId: id
  });

  return toObjectiveSummary({
    id,
    ticket_id: ticket.id,
    project_id: ticket.projectId,
    position,
    title: title?.trim() || initialTitleFromInstruction(instruction),
    instruction_text: instruction,
    state: resolvedState,
    auto_advance: autoAdvance ? 1 : 0
  });
}

export function createTicketWithObjectives({
  ctx,
  projectId,
  objectives,
  title,
  statusType
}: {
  ctx: ServiceContext;
  projectId: string;
  objectives: Array<{ objective: string; title?: string | null; autoAdvance?: boolean }>;
  title?: string | null;
  statusType?: 'draft' | 'review';
}): { ticket: TicketSummary; objectives: ObjectiveSummary[] } {
  if (objectives.length === 0) {
    throw new ServiceError('At least one objective is required', 'validation_error');
  }

  const resolvedProjectId = resolveProjectId(ctx, projectId);
  const firstInstruction = objectives[0]?.objective.trim() ?? '';
  if (!firstInstruction) {
    throw new ServiceError('First objective instruction is required', 'validation_error');
  }

  const ticketTitle = title?.trim() || initialTitleFromInstruction(firstInstruction);
  const status =
    statusType === 'review'
      ? getReviewStatusId(ctx, resolvedProjectId)
      : getDefaultStatusId(ctx, resolvedProjectId);

  const now = nowIso();
  const ticketId = newId();
  const sequence = nextTicketSequence(ctx);
  const displayId = `${ctx.workspace.slug}:${sequence}`;

  const createdObjectives: ObjectiveSummary[] = [];

  const tx = ctx.db.transaction(() => {
    ctx.db
      .prepare(
        `INSERT INTO tickets
           (id, workspace_id, project_id, display_id, sequence_number, title,
            status_id, status_type, board_position, priority, available_tools_json,
            execution_target_intent_json, metadata_json, created_by_workspace_user_id,
            created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'normal', '[]', '{}', '{}', ?, ?, ?, 1)`
      )
      .run(
        ticketId,
        ctx.workspace.id,
        resolvedProjectId,
        displayId,
        sequence,
        ticketTitle,
        status.id,
        status.type,
        topBoardPosition(ctx, resolvedProjectId, status.id),
        ctx.actorWorkspaceUserId,
        now,
        now
      );

    recordChange({
      ctx,
      entityType: 'ticket',
      entityId: ticketId,
      operation: 'insert',
      entityRevision: 1,
      projectId: resolvedProjectId,
      ticketId
    });

    objectives.forEach((item, index) => {
      const instruction = item.objective.trim();
      if (!instruction) {
        throw new ServiceError(
          `Objective ${index + 1} instruction is required`,
          'validation_error'
        );
      }
      const objectiveState =
        statusType === 'review' ? 'complete' : index === 0 ? 'draft' : 'future';
      createdObjectives.push(
        insertObjective({
          ctx,
          ticketId,
          instructionText: instruction,
          ...(item.title !== undefined ? { title: item.title } : {}),
          state: objectiveState,
          autoAdvance: item.autoAdvance ?? false
        })
      );
    });
  });

  tx();

  return {
    ticket: getTicketSummary({ ctx, ticketId }),
    objectives: createdObjectives
  };
}

export function getTicketSummary({
  ctx,
  ticketId
}: {
  ctx: ServiceContext;
  ticketId: string;
}): TicketSummary {
  const resolved = resolveTicketId(ctx, ticketId);
  const row = ctx.db
    .prepare(
      `SELECT t.id, t.display_id, t.project_id, t.title, t.status_type, t.status_id,
              t.priority, t.created_at, t.updated_at,
              (SELECT COUNT(*) FROM objectives o WHERE o.ticket_id = t.id AND o.deleted_at IS NULL) AS objective_count
       FROM tickets t
       WHERE t.id = ? AND t.workspace_id = ? AND t.deleted_at IS NULL`
    )
    .get(resolved.id, ctx.workspace.id) as {
    id: string;
    display_id: string;
    project_id: string;
    title: string;
    status_type: string;
    status_id: string;
    priority: string | null;
    created_at: string;
    updated_at: string;
    objective_count: number;
  };

  if (!row) {
    throw new ServiceError('Ticket not found', 'ticket_not_found', 404);
  }

  return {
    id: row.id,
    displayId: row.display_id,
    projectId: row.project_id,
    title: row.title,
    statusType: row.status_type,
    statusId: row.status_id,
    priority: row.priority,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    objectiveCount: row.objective_count
  };
}

export function listTickets({
  ctx,
  projectId,
  statusTypes,
  limit = 50
}: {
  ctx: ServiceContext;
  projectId?: string | null;
  statusTypes?: string[] | null;
  limit?: number;
}): TicketSummary[] {
  const params: Array<string | number> = [ctx.workspace.id];
  let sql = `SELECT t.id, t.display_id, t.project_id, t.title, t.status_type, t.status_id,
                    t.priority, t.created_at, t.updated_at,
                    (SELECT COUNT(*) FROM objectives o WHERE o.ticket_id = t.id AND o.deleted_at IS NULL) AS objective_count
             FROM tickets t
             WHERE t.workspace_id = ? AND t.deleted_at IS NULL`;

  if (projectId) {
    sql += ' AND t.project_id = ?';
    params.push(resolveProjectId(ctx, projectId));
  }

  if (statusTypes && statusTypes.length > 0) {
    const placeholders = statusTypes.map(() => '?').join(', ');
    sql += ` AND t.status_type IN (${placeholders})`;
    params.push(...statusTypes);
  }

  sql += ' ORDER BY t.updated_at DESC LIMIT ?';
  params.push(limit);

  const rows = ctx.db.prepare(sql).all(...params) as Array<{
    id: string;
    display_id: string;
    project_id: string;
    title: string;
    status_type: string;
    status_id: string;
    priority: string | null;
    created_at: string;
    updated_at: string;
    objective_count: number;
  }>;

  return rows.map(row => ({
    id: row.id,
    displayId: row.display_id,
    projectId: row.project_id,
    title: row.title,
    statusType: row.status_type,
    statusId: row.status_id,
    priority: row.priority,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    objectiveCount: row.objective_count
  }));
}

export function searchTickets({
  ctx,
  query,
  statusTypes,
  projectId,
  limit = 25
}: {
  ctx: ServiceContext;
  query?: string | null;
  statusTypes?: string[] | null;
  projectId?: string | null;
  limit?: number;
}): TicketSummary[] {
  const params: Array<string | number> = [ctx.workspace.id];
  let sql = `SELECT t.id, t.display_id, t.project_id, t.title, t.status_type, t.status_id,
                    t.priority, t.created_at, t.updated_at,
                    (SELECT COUNT(*) FROM objectives o WHERE o.ticket_id = t.id AND o.deleted_at IS NULL) AS objective_count
             FROM tickets t
             WHERE t.workspace_id = ? AND t.deleted_at IS NULL`;

  if (projectId) {
    sql += ' AND t.project_id = ?';
    params.push(resolveProjectId(ctx, projectId));
  }

  if (statusTypes && statusTypes.length > 0) {
    const placeholders = statusTypes.map(() => '?').join(', ');
    sql += ` AND t.status_type IN (${placeholders})`;
    params.push(...statusTypes);
  }

  if (query?.trim()) {
    const like = `%${query.trim()}%`;
    sql += ` AND (t.title LIKE ? OR t.display_id LIKE ?
              OR EXISTS (
                SELECT 1 FROM objectives o
                WHERE o.ticket_id = t.id AND o.deleted_at IS NULL
                  AND (o.instruction_text LIKE ? OR o.title LIKE ?)
              ))`;
    params.push(like, like, like, like);
  }

  sql += ' ORDER BY t.updated_at DESC LIMIT ?';
  params.push(limit);

  const rows = ctx.db.prepare(sql).all(...params) as Array<{
    id: string;
    display_id: string;
    project_id: string;
    title: string;
    status_type: string;
    status_id: string;
    priority: string | null;
    created_at: string;
    updated_at: string;
    objective_count: number;
  }>;

  return rows.map(row => ({
    id: row.id,
    displayId: row.display_id,
    projectId: row.project_id,
    title: row.title,
    statusType: row.status_type,
    statusId: row.status_id,
    priority: row.priority,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    objectiveCount: row.objective_count
  }));
}

export function addObjectivesToTicket({
  ctx,
  ticketId,
  objectives
}: {
  ctx: ServiceContext;
  ticketId: string;
  objectives: Array<{ objective: string; title?: string | null }>;
}): ObjectiveSummary[] {
  if (objectives.length === 0) {
    throw new ServiceError('At least one objective is required', 'validation_error');
  }

  const resolved = resolveTicketId(ctx, ticketId);
  const created: ObjectiveSummary[] = [];

  const tx = ctx.db.transaction(() => {
    for (const item of objectives) {
      created.push(
        insertObjective({
          ctx,
          ticketId: resolved.id,
          instructionText: item.objective,
          ...(item.title !== undefined ? { title: item.title } : {}),
          state: 'draft'
        })
      );
    }
  });

  tx();
  return created;
}

export function discussObjective({
  ctx,
  ticketId
}: {
  ctx: ServiceContext;
  ticketId: string;
}): ObjectiveSummary {
  const objectives = listObjectives({ ctx, ticketId });
  const draft = objectives.find(o => o.state === 'draft');
  if (!draft) {
    throw new ServiceError('No draft objective found on ticket', 'validation_error');
  }

  const now = nowIso();
  ctx.db
    .prepare(
      `UPDATE objectives SET state = 'submitted', updated_at = ?, revision = revision + 1
       WHERE id = ? AND ticket_id = ?`
    )
    .run(now, draft.id, draft.ticketId);

  recordChange({
    ctx,
    entityType: 'objective',
    entityId: draft.id,
    operation: 'update',
    projectId: draft.projectId,
    ticketId: draft.ticketId,
    objectiveId: draft.id,
    changedFields: ['state']
  });

  return { ...draft, state: 'submitted' };
}

export function listTicketEvents({
  ctx,
  ticketId,
  limit = 100
}: {
  ctx: ServiceContext;
  ticketId: string;
  limit?: number;
}): TicketEventSummary[] {
  const resolved = resolveTicketId(ctx, ticketId);
  const rows = ctx.db
    .prepare(
      `SELECT id, type, phase, summary, created_at, objective_id
       FROM ticket_events WHERE ticket_id = ? ORDER BY created_at ASC LIMIT ?`
    )
    .all(resolved.id, limit) as Array<{
    id: string;
    type: string;
    phase: string | null;
    summary: string;
    created_at: string;
    objective_id: string | null;
  }>;

  return rows.map(row => ({
    id: row.id,
    type: row.type,
    phase: row.phase,
    summary: row.summary,
    createdAt: row.created_at,
    objectiveId: row.objective_id
  }));
}

export function listSharedContext({
  ctx,
  ticketId,
  keySubstring,
  limit = 50
}: {
  ctx: ServiceContext;
  ticketId: string;
  keySubstring?: string | null;
  limit?: number;
}): SharedContextEntry[] {
  const resolved = resolveTicketId(ctx, ticketId);
  const params: Array<string | number> = [resolved.id];
  let sql = `SELECT key, value_kind, value_text, value_json, updated_at
             FROM shared_context_entries
             WHERE ticket_id = ? AND deleted_at IS NULL`;

  if (keySubstring?.trim()) {
    sql += ' AND key LIKE ?';
    params.push(`%${keySubstring.trim()}%`);
  }

  sql += ' ORDER BY updated_at DESC LIMIT ?';
  params.push(limit);

  const rows = ctx.db.prepare(sql).all(...params) as Array<{
    key: string;
    value_kind: string;
    value_text: string | null;
    value_json: string | null;
    updated_at: string;
  }>;

  return rows.map(row => ({
    key: row.key,
    value:
      row.value_kind === 'json' && row.value_json
        ? (JSON.parse(row.value_json) as unknown)
        : row.value_text,
    tags: [],
    updatedAt: row.updated_at
  }));
}

export function writeSharedContext({
  ctx,
  ticketId,
  key,
  value
}: {
  ctx: ServiceContext;
  ticketId: string;
  key: string;
  value: unknown;
  tags?: string[];
}): SharedContextEntry {
  const trimmedKey = key.trim();
  if (!trimmedKey) {
    throw new ServiceError('Shared context key is required', 'validation_error');
  }

  const resolved = resolveTicketId(ctx, ticketId);
  const now = nowIso();
  const existing = ctx.db
    .prepare(
      `SELECT id FROM shared_context_entries
       WHERE ticket_id = ? AND key = ? AND deleted_at IS NULL`
    )
    .get(resolved.id, trimmedKey) as { id: string } | undefined;

  const isJson = typeof value === 'object' && value !== null;
  const valueKind = isJson ? 'json' : 'string';
  const valueText = isJson ? null : String(value);
  const valueJson = isJson ? JSON.stringify(value) : null;

  if (existing) {
    ctx.db
      .prepare(
        `UPDATE shared_context_entries
         SET value_kind = ?, value_text = ?, value_json = ?, updated_at = ?, revision = revision + 1
         WHERE id = ?`
      )
      .run(valueKind, valueText, valueJson, now, existing.id);
  } else {
    ctx.db
      .prepare(
        `INSERT INTO shared_context_entries
           (id, workspace_id, ticket_id, key, value_kind, value_text, value_json,
            created_by_workspace_user_id, created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
      )
      .run(
        newId(),
        ctx.workspace.id,
        resolved.id,
        trimmedKey,
        valueKind,
        valueText,
        valueJson,
        ctx.actorWorkspaceUserId,
        now,
        now
      );
  }

  return { key: trimmedKey, value, tags: [], updatedAt: now };
}

export function listArtifacts({
  ctx,
  ticketId
}: {
  ctx: ServiceContext;
  ticketId: string;
}): ArtifactSummary[] {
  const resolved = resolveTicketId(ctx, ticketId);
  const rows = ctx.db
    .prepare(
      `SELECT id, type, label, content_text, external_url
       FROM artifacts WHERE ticket_id = ? AND deleted_at IS NULL ORDER BY created_at ASC`
    )
    .all(resolved.id) as Array<{
    id: string;
    type: string;
    label: string;
    content_text: string | null;
    external_url: string | null;
  }>;

  return rows.map(row => ({
    id: row.id,
    type: row.type,
    label: row.label,
    content: row.content_text,
    externalUrl: row.external_url
  }));
}

export function listAttachments({
  ctx,
  ticketId,
  objectiveId
}: {
  ctx: ServiceContext;
  ticketId: string;
  objectiveId?: string | null;
}): AttachmentSummary[] {
  const resolved = resolveTicketId(ctx, ticketId);
  const params: string[] = [resolved.id];
  let sql = `SELECT id, filename, content_type, size_bytes, upload_status
             FROM objective_attachments
             WHERE ticket_id = ? AND deleted_at IS NULL`;

  if (objectiveId) {
    sql += ' AND objective_id = ?';
    params.push(objectiveId);
  }

  sql += ' ORDER BY created_at ASC';
  const rows = ctx.db.prepare(sql).all(...params) as Array<{
    id: string;
    filename: string;
    content_type: string | null;
    size_bytes: number | null;
    upload_status: string;
  }>;

  return rows.map(row => ({
    id: row.id,
    filename: row.filename,
    mimeType: row.content_type,
    sizeBytes: row.size_bytes,
    status: row.upload_status
  }));
}

export function moveTicketToReview({
  ctx,
  ticketId
}: {
  ctx: ServiceContext;
  ticketId: string;
}): void {
  const ticket = getTicketSummary({ ctx, ticketId });
  const reviewStatus = getReviewStatusId(ctx, ticket.projectId);
  const now = nowIso();

  ctx.db
    .prepare(
      `UPDATE tickets SET status_id = ?, status_type = ?, updated_at = ?, revision = revision + 1
       WHERE id = ?`
    )
    .run(reviewStatus.id, reviewStatus.type, now, ticket.id);

  recordChange({
    ctx,
    entityType: 'ticket',
    entityId: ticket.id,
    operation: 'update',
    projectId: ticket.projectId,
    ticketId: ticket.id,
    changedFields: ['status_id', 'status_type']
  });
}

export function moveTicketToExecute({
  ctx,
  ticketId
}: {
  ctx: ServiceContext;
  ticketId: string;
}): void {
  const ticket = getTicketSummary({ ctx, ticketId });
  const executeStatus = getExecuteStatusId(ctx, ticket.projectId);
  if (ticket.statusId === executeStatus.id && ticket.statusType === executeStatus.type) {
    return;
  }

  const now = nowIso();
  const boardPosition = topBoardPosition(ctx, ticket.projectId, executeStatus.id);

  ctx.db
    .prepare(
      `UPDATE tickets
       SET status_id = ?, status_type = ?, board_position = ?, updated_at = ?, revision = revision + 1
       WHERE id = ?`
    )
    .run(executeStatus.id, executeStatus.type, boardPosition, now, ticket.id);

  recordChange({
    ctx,
    entityType: 'ticket',
    entityId: ticket.id,
    operation: 'update',
    projectId: ticket.projectId,
    ticketId: ticket.id,
    changedFields: ['status_id', 'status_type', 'board_position']
  });
}

export { getDefaultStatusId, getExecuteStatusId, getReviewStatusId };
