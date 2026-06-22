import { UPDATE_EVENT_TYPES, UPDATE_PHASES } from '@overlord/database';
import { createHash } from 'node:crypto';

import { recordChange } from './change-feed.js';
import { listRationalesForReview, type RationaleReview } from './changes.js';
import type { ServiceContext } from './context.js';
import { resolveProjectId, resolveTicketId } from './context.js';
import { ServiceError } from './errors.js';
import { createExecutionRequest } from './execution-requests.js';
import { loadAgentInstructionsForWorkspaceUser } from './profiles.js';
import { discoverProject } from './projects.js';
import {
  addObjectivesToTicket,
  type ArtifactSummary,
  type AttachmentSummary,
  createTicketWithObjectives,
  discussObjective,
  getTicketSummary,
  insertObjective,
  listArtifacts,
  listAttachments,
  listObjectives,
  listSharedContext,
  listTicketEvents,
  moveTicketToExecute,
  moveTicketToReview,
  type ObjectiveSummary,
  searchTickets,
  type SharedContextEntry,
  type TicketEventSummary,
  type TicketSummary
} from './tickets.js';
import { generateSessionKey, hashSessionKey, newId, nowIso } from './util.js';

export type SessionSummary = {
  id: string;
  sessionKey: string;
  state: string;
  objectiveId: string;
  ticketId: string;
  phase: string;
  deliveryState: string;
};

export type AttachResponse = {
  ticket: TicketSummary;
  objective: ObjectiveSummary;
  objectives: ObjectiveSummary[];
  session: SessionSummary;
  history: TicketEventSummary[];
  artifacts: ArtifactSummary[];
  attachments: AttachmentSummary[];
  sharedState: SharedContextEntry[];
  promptContext: string;
};

type SessionRow = {
  id: string;
  ticket_id: string;
  objective_id: string;
  phase: string;
  delivery_state: string;
  ended_at: string | null;
  external_session_id: string | null;
};

const PROTOCOL_WORKFLOW = `

1. Attach first with \`ovld protocol attach --ticket-id <id>\`.
2. Post progress with \`ovld protocol update\` or liveness with \`ovld protocol heartbeat\`.
3. Ask blocking questions with \`ovld protocol ask\` and stop work.
4. Deliver with \`ovld protocol deliver\` with \`change-rationales\` when work is complete.
5. Do not stage or commit changes unless explicitly instructed to do so.
6. Do not continue implementation after delivery without \`--begin-follow-up-work\`.`;

function resolveActiveObjective(objectives: ObjectiveSummary[]): ObjectiveSummary {
  const active =
    objectives.find(o => o.state === 'executing') ??
    objectives.find(o => o.state === 'launching') ??
    objectives.find(o => o.state === 'pending_delivery') ??
    objectives.find(o => o.state === 'draft') ??
    objectives.find(o => o.state !== 'complete');

  if (!active) {
    throw new ServiceError('No active objective found on ticket', 'no_active_objective', 409);
  }
  return active;
}

function getSessionByKeyMaybeEnded(
  ctx: ServiceContext,
  sessionKey: string,
  options: { includeEnded?: boolean } = {}
): SessionRow | undefined {
  const hash = hashSessionKey(sessionKey);
  const endedFilter = options.includeEnded ? '' : 'AND ended_at IS NULL';
  return ctx.db
    .prepare(
      `SELECT id, ticket_id, objective_id, phase, delivery_state, ended_at, external_session_id
       FROM agent_sessions
       WHERE workspace_id = ? AND session_key_hash = ? AND deleted_at IS NULL ${endedFilter}
       ORDER BY started_at DESC LIMIT 1`
    )
    .get(ctx.workspace.id, hash) as SessionRow | undefined;
}

function getSessionByKey(ctx: ServiceContext, sessionKey: string): SessionRow {
  const row = getSessionByKeyMaybeEnded(ctx, sessionKey);

  if (!row) {
    throw new ServiceError('Invalid or expired session key', 'invalid_session', 401);
  }
  return row;
}

function getLatestSessionByExternalId({
  ctx,
  ticketId,
  externalSessionId
}: {
  ctx: ServiceContext;
  ticketId: string;
  externalSessionId: string;
}): SessionRow | undefined {
  return ctx.db
    .prepare(
      `SELECT id, ticket_id, objective_id, phase, delivery_state, ended_at, external_session_id
       FROM agent_sessions
       WHERE workspace_id = ? AND ticket_id = ? AND external_session_id = ? AND deleted_at IS NULL
       ORDER BY started_at DESC LIMIT 1`
    )
    .get(ctx.workspace.id, ticketId, externalSessionId) as SessionRow | undefined;
}

function getLatestSessionForObjective({
  ctx,
  objectiveId,
  openOnly = false
}: {
  ctx: ServiceContext;
  objectiveId: string;
  openOnly?: boolean;
}): SessionRow | undefined {
  const endedFilter = openOnly ? 'AND ended_at IS NULL' : '';
  return ctx.db
    .prepare(
      `SELECT id, ticket_id, objective_id, phase, delivery_state, ended_at, external_session_id
       FROM agent_sessions
       WHERE workspace_id = ? AND objective_id = ? AND deleted_at IS NULL ${endedFilter}
       ORDER BY started_at DESC LIMIT 1`
    )
    .get(ctx.workspace.id, objectiveId) as SessionRow | undefined;
}

function persistExternalSessionId({
  ctx,
  session,
  externalSessionId,
  ticket
}: {
  ctx: ServiceContext;
  session: SessionRow;
  externalSessionId: string;
  ticket: TicketSummary;
}): void {
  if (session.external_session_id === externalSessionId) return;

  const now = nowIso();
  ctx.db
    .prepare(
      `UPDATE agent_sessions SET external_session_id = ?, updated_at = ?, revision = revision + 1
       WHERE id = ?`
    )
    .run(externalSessionId, now, session.id);

  const revision = (
    ctx.db.prepare(`SELECT revision FROM agent_sessions WHERE id = ?`).get(session.id) as
      | { revision: number }
      | undefined
  )?.revision;

  recordChange({
    ctx,
    entityType: 'agent_session',
    entityId: session.id,
    operation: 'update',
    entityRevision: revision ?? null,
    projectId: ticket.projectId,
    ticketId: ticket.id,
    objectiveId: session.objective_id,
    changedFields: ['external_session_id']
  });
}

function previousCompletedObjectives({
  objectives,
  currentObjective
}: {
  objectives: ObjectiveSummary[];
  currentObjective: ObjectiveSummary;
}): ObjectiveSummary[] {
  return objectives.filter(
    candidate => candidate.position < currentObjective.position && candidate.state === 'complete'
  );
}

function formatFileChangeLine(change: RationaleReview): string {
  return `- **${change.filePath}** (${change.label}): ${change.summary} — Why: ${change.why}. Impact: ${change.impact}`;
}

function formatPreviousObjectiveLine(objective: ObjectiveSummary): string {
  const heading = objective.title
    ? `### ${objective.title}`
    : `### Objective ${objective.position + 1}`;
  return [heading, objective.objective].join('\n');
}

function assemblePromptContext({
  ticket,
  objective,
  projectName,
  history,
  artifacts,
  attachments,
  sharedState,
  fileChanges,
  previousObjectives,
  agentInstructions
}: {
  ticket: TicketSummary;
  objective: ObjectiveSummary;
  projectName: string;
  history: TicketEventSummary[];
  artifacts: ArtifactSummary[];
  attachments: AttachmentSummary[];
  sharedState: SharedContextEntry[];
  fileChanges: RationaleReview[];
  previousObjectives: ObjectiveSummary[];
  agentInstructions: string | null;
}): string {
  const recentHistory = history
    .slice(-10)
    .map(event => `- [${event.type}] ${event.summary}`)
    .join('\n');

  const artifactLines = artifacts.map(a => `- ${a.label} (${a.type})`).join('\n');
  const attachmentLines = attachments.map(a => `- ${a.filename}`).join('\n');
  const sharedLines = sharedState
    .map(entry => `- ${entry.key}: ${JSON.stringify(entry.value)}`)
    .join('\n');
  const fileChangesLines = fileChanges.map(formatFileChangeLine).join('\n');
  const previousObjectivesLines = previousObjectives.map(formatPreviousObjectiveLine).join('\n\n');

  return [
    `# Overlord Agent Instructions`,
    `You are an AI coding agent working on ticket **${ticket.displayId}** via Overlord.`,
    `Complete the Objective described below. Use the Overlord skill. Follow the required protocol workflow.`,
    ``,
    `Required protocol workflow:`,
    PROTOCOL_WORKFLOW,
    '',
    `Ticket ID: ${ticket.displayId}`,
    `Objective ID: ${objective.id}`,
    `Project: ${projectName}`,
    '',
    '## Objective',
    objective.objective,
    '',
    '## Recent Activity',
    recentHistory || '- (none)',
    '',
    attachments.length > 0 ? '## Attachments' : '',
    attachments.length > 0 ? attachmentLines : '',
    fileChanges.length > 0 ? '## Previous file Changes' : '',
    fileChanges.length > 0 ? fileChangesLines : '',
    artifacts.length > 0 ? '## Artifacts' : '',
    artifacts.length > 0 ? artifactLines : '',
    sharedState.length > 0 ? '## Shared Context' : '',
    sharedState.length > 0 ? sharedLines : '',
    previousObjectives.length > 0 ? '## Previous Objectives (already completed)' : '',
    previousObjectives.length > 0 ? previousObjectivesLines : '',
    '',
    '## Important Notes',
    `- Other agents may be working on the same branch as you, so you may notice file changes that are not yours. EXCLUDE THESE FROM THE FILE CHANGES YOU REPORT.`,
    agentInstructions ? '' : null,
    agentInstructions ? '## Additional Instructions' : null,
    agentInstructions
  ]
    .filter((line): line is string => line !== null)
    .filter((line, index, arr) => !(line === '' && arr[index - 1] === ''))
    .join('\n');
}

function contextForObjective({
  ctx,
  ticket,
  objective
}: {
  ctx: ServiceContext;
  ticket: TicketSummary;
  objective: ObjectiveSummary;
}): Omit<AttachResponse, 'session'> {
  const objectives = listObjectives({ ctx, ticketId: ticket.id });
  const history = listTicketEvents({ ctx, ticketId: ticket.id });
  const artifacts = listArtifacts({ ctx, ticketId: ticket.id });
  const attachments = listAttachments({ ctx, ticketId: ticket.id, objectiveId: objective.id });
  const sharedState = listSharedContext({ ctx, ticketId: ticket.id });
  const completedObjectives = previousCompletedObjectives({
    objectives,
    currentObjective: objective
  });
  const previousObjectiveIds = new Set(completedObjectives.map(entry => entry.id));
  const fileChanges = listRationalesForReview({ ctx, ticketId: ticket.id }).filter(change =>
    previousObjectiveIds.has(change.objectiveId)
  );

  const project = ctx.db
    .prepare(`SELECT name FROM projects WHERE id = ?`)
    .get(ticket.projectId) as { name: string };

  const agentInstructions = loadAgentInstructionsForWorkspaceUser({
    db: ctx.db,
    workspaceUserId: ctx.actorWorkspaceUserId
  });

  return {
    ticket,
    objective,
    objectives,
    history,
    artifacts,
    attachments,
    sharedState,
    promptContext: assemblePromptContext({
      ticket,
      objective,
      projectName: project.name,
      history,
      artifacts,
      attachments,
      sharedState,
      fileChanges,
      previousObjectives: completedObjectives,
      agentInstructions
    })
  };
}

export function loadTicketContext({
  ctx,
  ticketId
}: {
  ctx: ServiceContext;
  ticketId: string;
}): Omit<AttachResponse, 'session'> {
  const ticket = getTicketSummary({ ctx, ticketId });
  const objectives = listObjectives({ ctx, ticketId: ticket.id });
  const objective = resolveActiveObjective(objectives);
  return contextForObjective({ ctx, ticket, objective });
}

export function attachSession({
  ctx,
  ticketId,
  agentIdentifier = 'unknown',
  modelIdentifier,
  connectionMethod = 'cli',
  existingSessionKey,
  externalSessionId
}: {
  ctx: ServiceContext;
  ticketId: string;
  agentIdentifier?: string;
  modelIdentifier?: string | null;
  connectionMethod?: string;
  existingSessionKey?: string | null;
  externalSessionId?: string | null;
}): AttachResponse & { sessionKey: string } {
  const context = loadTicketContext({ ctx, ticketId });
  const objective = context.objective;

  if (existingSessionKey) {
    const existing = getSessionByKey(ctx, existingSessionKey);
    if (existing.ticket_id !== context.ticket.id) {
      throw new ServiceError('Session key belongs to a different ticket', 'invalid_session', 401);
    }
    if (externalSessionId !== undefined) {
      ctx.db
        .prepare(
          `UPDATE agent_sessions SET external_session_id = ?, updated_at = ?, revision = revision + 1
           WHERE id = ?`
        )
        .run(externalSessionId, nowIso(), existing.id);
    }
    return {
      ...context,
      session: {
        id: existing.id,
        sessionKey: existingSessionKey,
        state: 'executing',
        objectiveId: existing.objective_id,
        ticketId: existing.ticket_id,
        phase: existing.phase,
        deliveryState: existing.delivery_state
      },
      sessionKey: existingSessionKey
    };
  }

  const { rawKey, prefix, hash } = generateSessionKey();
  const now = nowIso();
  const sessionId = newId();
  const currentObjectiveAssignment = ctx.db
    .prepare(
      `SELECT assigned_agent
       FROM objectives
       WHERE id = ? AND ticket_id = ? AND deleted_at IS NULL`
    )
    .get(objective.id, context.ticket.id) as { assigned_agent: string | null } | undefined;
  const inheritedDraftAgent = currentObjectiveAssignment?.assigned_agent?.trim() || agentIdentifier;

  const tx = ctx.db.transaction(() => {
    ctx.db
      .prepare(
        `UPDATE objectives
         SET state = 'executing',
             assigned_agent = COALESCE(assigned_agent, ?),
             updated_at = ?,
             revision = revision + 1
         WHERE id = ? AND ticket_id = ?`
      )
      .run(inheritedDraftAgent || null, now, objective.id, context.ticket.id);

    const existingDraft = ctx.db
      .prepare(
        `SELECT id FROM objectives
         WHERE ticket_id = ? AND state = 'draft' AND deleted_at IS NULL
         LIMIT 1`
      )
      .get(context.ticket.id) as { id: string } | undefined;

    if (!existingDraft) {
      const nextFuture = ctx.db
        .prepare(
          `SELECT id, revision FROM objectives
           WHERE ticket_id = ? AND state = 'future' AND deleted_at IS NULL
           ORDER BY position ASC, created_at ASC LIMIT 1`
        )
        .get(context.ticket.id) as { id: string; revision: number } | undefined;

      if (nextFuture) {
        const nextRevision = nextFuture.revision + 1;
        ctx.db
          .prepare(
            `UPDATE objectives SET state = 'draft', updated_at = ?, revision = ?
             WHERE id = ? AND ticket_id = ?`
          )
          .run(now, nextRevision, nextFuture.id, context.ticket.id);

        recordChange({
          ctx,
          entityType: 'objective',
          entityId: nextFuture.id,
          operation: 'update',
          entityRevision: nextRevision,
          projectId: context.ticket.projectId,
          ticketId: context.ticket.id,
          objectiveId: nextFuture.id,
          changedFields: ['state']
        });
      } else {
        insertObjective({
          ctx,
          ticketId: context.ticket.id,
          instructionText: '',
          state: 'draft',
          assignedAgent: inheritedDraftAgent || null
        });
      }
    }

    moveTicketToExecute({ ctx, ticketId: context.ticket.id });

    ctx.db
      .prepare(
        `INSERT INTO agent_sessions
           (id, workspace_id, project_id, ticket_id, objective_id,
            session_key_prefix, session_key_hash, agent_identifier, model_identifier,
            connection_method, external_session_id, phase, delivery_state, started_at, last_heartbeat_at,
            metadata_json, created_by_workspace_user_id, created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'execute', 'not_delivered', ?, ?, '{}', ?, ?, ?, 1)`
      )
      .run(
        sessionId,
        ctx.workspace.id,
        context.ticket.projectId,
        context.ticket.id,
        objective.id,
        prefix,
        hash,
        agentIdentifier,
        modelIdentifier ?? null,
        connectionMethod,
        externalSessionId ?? null,
        now,
        now,
        ctx.actorWorkspaceUserId,
        now,
        now
      );

    recordChange({
      ctx,
      entityType: 'agent_session',
      entityId: sessionId,
      operation: 'insert',
      entityRevision: 1,
      projectId: context.ticket.projectId,
      ticketId: context.ticket.id,
      objectiveId: objective.id
    });
  });

  tx();

  const refreshedTicket = getTicketSummary({ ctx, ticketId: context.ticket.id });
  const refreshedObjectives = listObjectives({ ctx, ticketId: context.ticket.id });
  const refreshedObjective = refreshedObjectives.find(o => o.id === objective.id) ?? {
    ...objective,
    state: 'executing'
  };

  return {
    ...context,
    ticket: refreshedTicket,
    objective: refreshedObjective,
    objectives: refreshedObjectives,
    session: {
      id: sessionId,
      sessionKey: rawKey,
      state: 'executing',
      objectiveId: objective.id,
      ticketId: context.ticket.id,
      phase: 'execute',
      deliveryState: 'not_delivered'
    },
    sessionKey: rawKey
  };
}

export function connectSession({
  ctx,
  ticketId,
  agentIdentifier = 'unknown',
  externalSessionId
}: {
  ctx: ServiceContext;
  ticketId: string;
  agentIdentifier?: string;
  externalSessionId?: string | null;
}): { sessionKey: string; ticketId: string; objectiveId: string } {
  const result = attachSession({
    ctx,
    ticketId,
    agentIdentifier,
    connectionMethod: 'connect',
    externalSessionId: externalSessionId ?? null
  });
  return {
    sessionKey: result.sessionKey,
    ticketId: result.ticket.id,
    objectiveId: result.objective.id
  };
}

function promptHash(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex');
}

function objectiveFromSession(
  objectives: ObjectiveSummary[],
  session: SessionRow | undefined
): ObjectiveSummary | undefined {
  if (!session) return undefined;
  return objectives.find(objective => objective.id === session.objective_id);
}

function latestCompletedObjective(objectives: ObjectiveSummary[]): ObjectiveSummary | undefined {
  return [...objectives].reverse().find(objective => objective.state === 'complete');
}

function resolveFollowUpObjective({
  ctx,
  ticket,
  objectives,
  sessionKey,
  externalSessionId
}: {
  ctx: ServiceContext;
  ticket: TicketSummary;
  objectives: ObjectiveSummary[];
  sessionKey?: string | null;
  externalSessionId?: string | null;
}): { objective: ObjectiveSummary | undefined; session: SessionRow | undefined } {
  const active =
    objectives.find(objective =>
      ['executing', 'pending_delivery', 'launching', 'submitted', 'draft'].includes(objective.state)
    ) ?? undefined;
  if (active) return { objective: active, session: undefined };

  const sessionFromKey = sessionKey
    ? getSessionByKeyMaybeEnded(ctx, sessionKey, { includeEnded: true })
    : undefined;
  const objectiveFromKey = objectiveFromSession(objectives, sessionFromKey);
  if (objectiveFromKey) return { objective: objectiveFromKey, session: sessionFromKey };

  const sessionFromExternal = externalSessionId
    ? getLatestSessionByExternalId({ ctx, ticketId: ticket.id, externalSessionId })
    : undefined;
  const objectiveFromExternal = objectiveFromSession(objectives, sessionFromExternal);
  if (objectiveFromExternal) {
    return { objective: objectiveFromExternal, session: sessionFromExternal };
  }

  return { objective: latestCompletedObjective(objectives), session: undefined };
}

export function recordHookEvent({
  ctx,
  ticketId,
  hookType,
  prompt,
  sessionKey,
  externalSessionId,
  turnIndex
}: {
  ctx: ServiceContext;
  ticketId: string;
  hookType: string;
  prompt: string;
  sessionKey?: string | null;
  externalSessionId?: string | null;
  turnIndex?: string | null;
}): { eventId: string; objectiveId: string | null; sessionId: string | null } {
  if (hookType !== 'UserPromptSubmit') {
    throw new ServiceError(`Unsupported hook type: ${hookType}`, 'validation_error');
  }

  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) {
    throw new ServiceError('Hook prompt is required', 'validation_error');
  }

  const ticket = getTicketSummary({ ctx, ticketId });
  const objectives = listObjectives({ ctx, ticketId: ticket.id });
  let { objective, session } = resolveFollowUpObjective({
    ctx,
    ticket,
    objectives,
    sessionKey: sessionKey ?? null,
    externalSessionId: externalSessionId ?? null
  });

  if (!session && sessionKey) {
    session = getSessionByKeyMaybeEnded(ctx, sessionKey, { includeEnded: true });
  }

  if (!session && objective && ['executing', 'pending_delivery'].includes(objective.state)) {
    session = getLatestSessionForObjective({ ctx, objectiveId: objective.id, openOnly: true });
  }

  const hash = promptHash(trimmedPrompt);
  const dedupeParts = [
    hookType,
    ticket.id,
    externalSessionId || session?.id || 'unknown-session',
    turnIndex || 'unknown-turn',
    hash
  ];
  const idempotencyKey = dedupeParts.join(':');

  const existing = ctx.db
    .prepare(
      `SELECT id, objective_id, session_id FROM ticket_events
       WHERE workspace_id = ? AND source = ? AND idempotency_key = ?
       LIMIT 1`
    )
    .get(ctx.workspace.id, ctx.source, idempotencyKey) as
    | { id: string; objective_id: string | null; session_id: string | null }
    | undefined;
  if (existing) {
    return {
      eventId: existing.id,
      objectiveId: existing.objective_id,
      sessionId: existing.session_id
    };
  }

  const eventId = newId();
  const now = nowIso();
  const phase =
    objective && ['executing', 'pending_delivery'].includes(objective.state) ? 'execute' : 'review';

  ctx.db
    .prepare(
      `INSERT INTO ticket_events
         (id, workspace_id, project_id, ticket_id, objective_id, session_id,
          type, phase, summary, payload_json, source, actor_workspace_user_id,
          idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'user_follow_up', ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      eventId,
      ctx.workspace.id,
      ticket.projectId,
      ticket.id,
      objective?.id ?? null,
      session?.id ?? null,
      phase,
      trimmedPrompt,
      JSON.stringify({
        hookType,
        ...(turnIndex ? { turnIndex } : {}),
        ...(externalSessionId ? { externalSessionId } : {}),
        promptHash: hash
      }),
      ctx.source,
      ctx.actorWorkspaceUserId,
      idempotencyKey,
      now
    );

  if (externalSessionId && session) {
    persistExternalSessionId({ ctx, session, externalSessionId, ticket });
  }

  return { eventId, objectiveId: objective?.id ?? null, sessionId: session?.id ?? null };
}

export function resumeFollowUp({
  ctx,
  ticketId,
  objectiveId,
  agentIdentifier = 'unknown',
  modelIdentifier,
  connectionMethod = 'cli',
  externalSessionId,
  summary = 'Beginning follow-up work.'
}: {
  ctx: ServiceContext;
  ticketId: string;
  objectiveId?: string | null;
  agentIdentifier?: string;
  modelIdentifier?: string | null;
  connectionMethod?: string;
  externalSessionId?: string | null;
  summary?: string | null;
}): AttachResponse & { sessionKey: string } {
  const trimmedSummary = summary?.trim() || 'Beginning follow-up work.';
  const ticket = getTicketSummary({ ctx, ticketId });
  const objectives = listObjectives({ ctx, ticketId: ticket.id });
  const selectedObjective = objectiveId
    ? objectives.find(objective => objective.id === objectiveId)
    : latestCompletedObjective(objectives);

  if (!selectedObjective) {
    throw new ServiceError(
      'No completed objective found for follow-up',
      'no_active_objective',
      409
    );
  }

  const activeObjective = objectives.find(objective =>
    ['executing', 'pending_delivery'].includes(objective.state)
  );
  if (activeObjective) {
    throw new ServiceError(
      'Ticket already has active follow-up or execution work',
      'active_objective_exists',
      409
    );
  }

  if (selectedObjective.state !== 'complete') {
    throw new ServiceError(
      'Follow-up resume requires a completed objective',
      'validation_error',
      409
    );
  }

  const { rawKey, prefix, hash } = generateSessionKey();
  const now = nowIso();
  const sessionId = newId();
  const eventId = newId();

  const tx = ctx.db.transaction(() => {
    ctx.db
      .prepare(
        `UPDATE objectives
         SET state = 'pending_delivery', completed_at = NULL, updated_at = ?, revision = revision + 1
         WHERE id = ? AND ticket_id = ? AND state = 'complete'`
      )
      .run(now, selectedObjective.id, ticket.id);

    ctx.db
      .prepare(
        `INSERT INTO agent_sessions
           (id, workspace_id, project_id, ticket_id, objective_id,
            session_key_prefix, session_key_hash, agent_identifier, model_identifier,
            connection_method, external_session_id, phase, delivery_state, started_at, last_heartbeat_at,
            metadata_json, created_by_workspace_user_id, created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'execute', 'pending_redelivery', ?, ?, '{}', ?, ?, ?, 1)`
      )
      .run(
        sessionId,
        ctx.workspace.id,
        ticket.projectId,
        ticket.id,
        selectedObjective.id,
        prefix,
        hash,
        agentIdentifier,
        modelIdentifier ?? null,
        connectionMethod,
        externalSessionId ?? null,
        now,
        now,
        ctx.actorWorkspaceUserId,
        now,
        now
      );

    ctx.db
      .prepare(
        `INSERT INTO ticket_events
           (id, workspace_id, project_id, ticket_id, objective_id, session_id,
            type, phase, summary, payload_json, source, actor_workspace_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'update', 'execute', ?, ?, ?, ?, ?)`
      )
      .run(
        eventId,
        ctx.workspace.id,
        ticket.projectId,
        ticket.id,
        selectedObjective.id,
        sessionId,
        trimmedSummary,
        JSON.stringify({ followUpIntent: 'execution', reactivated: true }),
        ctx.source,
        ctx.actorWorkspaceUserId,
        now
      );

    moveTicketToExecute({ ctx, ticketId: ticket.id });

    recordChange({
      ctx,
      entityType: 'objective',
      entityId: selectedObjective.id,
      operation: 'update',
      projectId: ticket.projectId,
      ticketId: ticket.id,
      objectiveId: selectedObjective.id,
      changedFields: ['state', 'completed_at']
    });

    recordChange({
      ctx,
      entityType: 'agent_session',
      entityId: sessionId,
      operation: 'insert',
      entityRevision: 1,
      projectId: ticket.projectId,
      ticketId: ticket.id,
      objectiveId: selectedObjective.id
    });
  });

  tx();

  const refreshedTicket = getTicketSummary({ ctx, ticketId: ticket.id });
  const refreshedObjective = listObjectives({ ctx, ticketId: ticket.id }).find(
    objective => objective.id === selectedObjective.id
  ) ?? {
    ...selectedObjective,
    state: 'pending_delivery'
  };
  const context = contextForObjective({
    ctx,
    ticket: refreshedTicket,
    objective: refreshedObjective
  });

  return {
    ...context,
    session: {
      id: sessionId,
      sessionKey: rawKey,
      state: 'executing',
      objectiveId: selectedObjective.id,
      ticketId: ticket.id,
      phase: 'execute',
      deliveryState: 'pending_redelivery'
    },
    sessionKey: rawKey
  };
}

export function heartbeatSession({
  ctx,
  ticketId,
  sessionKey,
  phase,
  note
}: {
  ctx: ServiceContext;
  ticketId: string;
  sessionKey: string;
  phase?: string | null;
  note?: string | null;
}): { ok: true } {
  const ticket = resolveTicketId(ctx, ticketId);
  const session = getSessionByKey(ctx, sessionKey);
  if (session.ticket_id !== ticket.id) {
    throw new ServiceError('Session key does not match ticket', 'invalid_session', 401);
  }

  const now = nowIso();
  const fields = ['last_heartbeat_at = ?', 'updated_at = ?', 'revision = revision + 1'];
  const params: Array<string | null> = [now, now];

  if (phase) {
    if (!['attach', 'execute', 'review', 'complete', 'blocked'].includes(phase)) {
      throw new ServiceError(`Invalid phase: ${phase}`, 'validation_error');
    }
    fields.unshift('phase = ?');
    params.unshift(phase);
  }

  if (note?.trim()) {
    const metadata = JSON.stringify({ lastHeartbeatNote: note.trim() });
    fields.unshift('metadata_json = ?');
    params.unshift(metadata);
  }

  params.push(session.id);
  ctx.db.prepare(`UPDATE agent_sessions SET ${fields.join(', ')} WHERE id = ?`).run(...params);

  return { ok: true };
}

/**
 * Upsert mechanically-observed changed files for a session/objective, keyed by
 * normalized path so repeated observations revise the same row. Stores only
 * metadata (path + status), never diffs or file contents. Must run inside a
 * transaction supplied by the caller.
 */
function upsertChangedFiles({
  ctx,
  ticket,
  session,
  files,
  eventId,
  now
}: {
  ctx: ServiceContext;
  ticket: { id: string; projectId: string };
  session: { id: string; objective_id: string };
  files: Array<{ filePath: string; vcsStatus?: string | null }>;
  /** Observing event id, or null when no event row exists yet (e.g. deliver). */
  eventId: string | null;
  now: string;
}): void {
  for (const file of files) {
    const normalizedPath = file.filePath.replace(/\\/g, '/');
    const existing = ctx.db
      .prepare(
        `SELECT id FROM changed_files
         WHERE session_id = ? AND objective_id = ? AND file_path = ? AND deleted_at IS NULL`
      )
      .get(session.id, session.objective_id, normalizedPath) as { id: string } | undefined;

    if (existing) {
      ctx.db
        .prepare(
          `UPDATE changed_files
           SET vcs_status = ?, current_diff_state = 'present', last_observed_at = ?,
               last_observed_event_id = COALESCE(?, last_observed_event_id),
               updated_at = ?, revision = revision + 1
           WHERE id = ?`
        )
        .run(file.vcsStatus ?? null, now, eventId, now, existing.id);
    } else {
      ctx.db
        .prepare(
          `INSERT INTO changed_files
             (id, workspace_id, project_id, ticket_id, objective_id, session_id,
              file_path, vcs_status, current_diff_state, first_observed_at, last_observed_at,
              last_observed_event_id, observed_metadata_json, created_at, updated_at, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'present', ?, ?, ?, '{}', ?, ?, 1)`
        )
        .run(
          newId(),
          ctx.workspace.id,
          ticket.projectId,
          ticket.id,
          session.objective_id,
          session.id,
          normalizedPath,
          file.vcsStatus ?? null,
          now,
          now,
          eventId,
          now,
          now
        );
    }
  }
}

export function updateSession({
  ctx,
  ticketId,
  sessionKey,
  summary,
  phase,
  eventType = 'update',
  payloadJson,
  externalUrl,
  externalSessionId,
  beginFollowUpWork = false,
  followUpIntent,
  changedFiles,
  changeRationales
}: {
  ctx: ServiceContext;
  ticketId: string;
  sessionKey: string;
  summary: string;
  phase?: string | null;
  eventType?: string | null;
  payloadJson?: Record<string, unknown> | null;
  externalUrl?: string | null;
  externalSessionId?: string | null;
  beginFollowUpWork?: boolean;
  followUpIntent?: string | null;
  changedFiles?: Array<{ filePath: string; vcsStatus?: string | null }> | null;
  changeRationales?: Array<Record<string, unknown>> | null;
}): { eventId: string } {
  const trimmedSummary = summary.trim();
  if (!trimmedSummary) {
    throw new ServiceError('Update summary is required', 'validation_error');
  }

  const ticket = resolveTicketId(ctx, ticketId);
  const session = getSessionByKey(ctx, sessionKey);
  if (session.ticket_id !== ticket.id) {
    throw new ServiceError('Session key does not match ticket', 'invalid_session', 401);
  }

  if (session.delivery_state === 'delivered' && !beginFollowUpWork) {
    throw new ServiceError(
      'Ticket was delivered. Use --begin-follow-up-work before posting execution updates.',
      'delivery_boundary',
      409
    );
  }

  if (phase && !UPDATE_PHASES.includes(phase as (typeof UPDATE_PHASES)[number])) {
    throw new ServiceError(`Invalid phase: ${phase}`, 'validation_error');
  }

  if (eventType && !UPDATE_EVENT_TYPES.includes(eventType as (typeof UPDATE_EVENT_TYPES)[number])) {
    throw new ServiceError(`Invalid event type: ${eventType}`, 'validation_error');
  }

  const now = nowIso();
  const eventId = newId();

  const tx = ctx.db.transaction(() => {
    if (beginFollowUpWork) {
      ctx.db
        .prepare(
          `UPDATE objectives SET state = 'pending_delivery', updated_at = ?, revision = revision + 1
           WHERE id = ?`
        )
        .run(now, session.objective_id);
      ctx.db
        .prepare(
          `UPDATE agent_sessions SET delivery_state = 'pending_redelivery', updated_at = ?, revision = revision + 1
           WHERE id = ?`
        )
        .run(now, session.id);
    }

    ctx.db
      .prepare(
        `INSERT INTO ticket_events
           (id, workspace_id, project_id, ticket_id, objective_id, session_id,
            type, phase, summary, payload_json, external_url, source,
            actor_workspace_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        eventId,
        ctx.workspace.id,
        ticket.projectId,
        ticket.id,
        session.objective_id,
        session.id,
        eventType ?? 'update',
        phase ?? null,
        trimmedSummary,
        JSON.stringify({
          ...(payloadJson ?? {}),
          ...(followUpIntent ? { followUpIntent } : {}),
          ...(changeRationales
            ? {
                changeRationales: normalizeChangeRationales(
                  changeRationales as ChangeRationaleInput[]
                )
              }
            : {})
        }),
        externalUrl ?? null,
        ctx.source,
        ctx.actorWorkspaceUserId,
        now
      );

    if (externalSessionId !== undefined) {
      ctx.db
        .prepare(
          `UPDATE agent_sessions SET external_session_id = ?, updated_at = ?, revision = revision + 1
           WHERE id = ?`
        )
        .run(externalSessionId, now, session.id);
    }

    if (phase) {
      ctx.db
        .prepare(
          `UPDATE agent_sessions SET phase = ?, updated_at = ?, revision = revision + 1 WHERE id = ?`
        )
        .run(phase, now, session.id);
    }

    if (changedFiles && changedFiles.length > 0) {
      upsertChangedFiles({ ctx, ticket, session, files: changedFiles, eventId, now });
    }
  });

  tx();
  return { eventId };
}

export function askQuestion({
  ctx,
  ticketId,
  sessionKey,
  question
}: {
  ctx: ServiceContext;
  ticketId: string;
  sessionKey: string;
  question: string;
}): { eventId: string } {
  const trimmed = question.trim();
  if (!trimmed) {
    throw new ServiceError('Question is required', 'validation_error');
  }

  const ticket = resolveTicketId(ctx, ticketId);
  const session = getSessionByKey(ctx, sessionKey);
  if (session.ticket_id !== ticket.id) {
    throw new ServiceError('Session key does not match ticket', 'invalid_session', 401);
  }

  const now = nowIso();
  const eventId = newId();

  ctx.db
    .prepare(
      `INSERT INTO ticket_events
         (id, workspace_id, project_id, ticket_id, objective_id, session_id,
          type, phase, summary, payload_json, source, actor_workspace_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'ask', 'blocked', ?, '{}', ?, ?, ?)`
    )
    .run(
      eventId,
      ctx.workspace.id,
      ticket.projectId,
      ticket.id,
      session.objective_id,
      session.id,
      trimmed,
      ctx.source,
      ctx.actorWorkspaceUserId,
      now
    );

  moveTicketToReview({ ctx, ticketId: ticket.id });

  return { eventId };
}

export type ChangeRationaleInput = {
  /**
   * Canonical camelCase path for the changed file, matching the `filePath` used by
   * changed-files inputs. The snake_case `file_path` is accepted as a backward-
   * compatible alias during migration.
   */
  filePath?: string;
  /** @deprecated alias for {@link ChangeRationaleInput.filePath}. */
  file_path?: string;
  label: string;
  summary: string;
  why: string;
  impact: string;
  hunks?: Array<{ header: string }>;
};

/** A change rationale after casing normalization — `filePath` is always present. */
type NormalizedChangeRationale = {
  filePath: string;
  label: string;
  summary: string;
  why: string;
  impact: string;
  hunks?: Array<{ header: string }>;
};

/**
 * Normalize change-rationale inputs to the canonical `filePath` casing, accepting
 * the legacy snake_case `file_path` alias. Backslashes are converted to forward
 * slashes so paths line up with the normalized `file_path` stored on changed-file
 * rows (see `upsertChangedFiles`).
 */
function normalizeChangeRationales(
  input: ReadonlyArray<ChangeRationaleInput>
): NormalizedChangeRationale[] {
  return input.map(rationale => ({
    filePath: (rationale.filePath ?? rationale.file_path ?? '').replace(/\\/g, '/'),
    label: rationale.label,
    summary: rationale.summary,
    why: rationale.why,
    impact: rationale.impact,
    ...(rationale.hunks ? { hunks: rationale.hunks } : {})
  }));
}

export function deliverSession({
  ctx,
  ticketId,
  sessionKey,
  summary,
  artifacts = [],
  changeRationales = [],
  changedFiles,
  noFileChanges = false,
  payloadJson,
  verificationSummary,
  followUpNotes
}: {
  ctx: ServiceContext;
  ticketId: string;
  sessionKey: string;
  summary: string;
  artifacts?: Array<{ type: string; label: string; content?: string | null; url?: string | null }>;
  changeRationales?: ChangeRationaleInput[];
  /** Mechanically observed changes for this run (client-side VCS delta). */
  changedFiles?: Array<{ filePath: string; vcsStatus?: string | null }> | null;
  /** Agent's explicit assertion that this run changed no files. */
  noFileChanges?: boolean;
  payloadJson?: Record<string, unknown> | null;
  verificationSummary?: string | null;
  followUpNotes?: string | null;
}): { deliveryId: string; eventId: string } {
  const trimmedSummary = summary.trim();
  if (!trimmedSummary) {
    throw new ServiceError('Delivery summary is required', 'validation_error');
  }

  const ticket = resolveTicketId(ctx, ticketId);
  const session = getSessionByKey(ctx, sessionKey);
  if (session.ticket_id !== ticket.id) {
    throw new ServiceError('Session key does not match ticket', 'invalid_session', 401);
  }

  const normalizedRationales = normalizeChangeRationales(changeRationales);

  const now = nowIso();
  const deliveryId = newId();
  const eventId = newId();

  // Populated inside the transaction once the run's changed files are recorded,
  // then used to link rationales to their changed-file rows.
  let changedFileIdByPath = new Map<string, string>();

  const tx = ctx.db.transaction(() => {
    // Record the run's mechanically-observed changed files (client-side VCS
    // delta) so review reflects what actually changed — unless the agent
    // explicitly declared this run made no file changes.
    if (!noFileChanges && changedFiles && changedFiles.length > 0) {
      // The delivery event row is inserted later in this transaction, so there is
      // no observing event to link yet; pass null (COALESCE keeps prior links).
      upsertChangedFiles({ ctx, ticket, session, files: changedFiles, eventId: null, now });
    }

    // Coverage is objective-scoped: aggregate observed changes across every
    // session for the objective (and no-session record-work records).
    const objectiveChangedFiles = ctx.db
      .prepare(
        `SELECT id, file_path, current_diff_state FROM changed_files
         WHERE objective_id = ? AND deleted_at IS NULL`
      )
      .all(session.objective_id) as Array<{
      id: string;
      file_path: string;
      current_diff_state: string | null;
    }>;
    changedFileIdByPath = new Map(objectiveChangedFiles.map(row => [row.file_path, row.id]));

    if (!noFileChanges) {
      const meaningfulFiles = objectiveChangedFiles.filter(
        file => file.current_diff_state === 'present' && !file.file_path.includes('package-lock')
      );
      for (const file of meaningfulFiles) {
        const rationale = normalizedRationales.find(r => r.filePath === file.file_path);
        if (!rationale) {
          throw new ServiceError(
            `Missing change rationale for ${file.file_path}. Every meaningful tracked file change requires a rationale.`,
            'missing_rationale',
            400
          );
        }
        for (const field of ['label', 'summary', 'why', 'impact'] as const) {
          if (!rationale[field]?.trim()) {
            throw new ServiceError(
              `Change rationale for ${file.file_path} is missing required field: ${field}`,
              'invalid_rationale',
              400
            );
          }
        }
      }
    }

    ctx.db
      .prepare(
        `INSERT INTO deliveries
           (id, workspace_id, project_id, ticket_id, objective_id, session_id,
            summary, payload_json, verification_summary, follow_up_notes,
            delivered_at, delivered_by_workspace_user_id, created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
      )
      .run(
        deliveryId,
        ctx.workspace.id,
        ticket.projectId,
        ticket.id,
        session.objective_id,
        session.id,
        trimmedSummary,
        JSON.stringify({
          ...(payloadJson ?? {}),
          ...(noFileChanges ? { noFileChanges: true } : {})
        }),
        verificationSummary ?? null,
        followUpNotes ?? null,
        now,
        ctx.actorWorkspaceUserId,
        now,
        now
      );

    for (const artifact of artifacts) {
      ctx.db
        .prepare(
          `INSERT INTO artifacts
             (id, workspace_id, project_id, ticket_id, objective_id, session_id, delivery_id,
              type, label, content_text, external_url, created_at, updated_at, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
        )
        .run(
          newId(),
          ctx.workspace.id,
          ticket.projectId,
          ticket.id,
          session.objective_id,
          session.id,
          deliveryId,
          artifact.type,
          artifact.label,
          artifact.content ?? null,
          artifact.url ?? null,
          now,
          now
        );
    }

    for (const rationale of normalizedRationales) {
      const changedFileId = changedFileIdByPath.get(rationale.filePath) ?? null;
      ctx.db
        .prepare(
          `INSERT INTO change_rationales
             (id, workspace_id, project_id, ticket_id, objective_id, session_id, delivery_id,
              changed_file_id, file_path, label, summary, why, impact, hunks_json,
              is_final, created_at, updated_at, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 1)`
        )
        .run(
          newId(),
          ctx.workspace.id,
          ticket.projectId,
          ticket.id,
          session.objective_id,
          session.id,
          deliveryId,
          changedFileId,
          rationale.filePath,
          rationale.label,
          rationale.summary,
          rationale.why,
          rationale.impact,
          JSON.stringify(rationale.hunks ?? []),
          now,
          now
        );
    }

    ctx.db
      .prepare(
        `INSERT INTO ticket_events
           (id, workspace_id, project_id, ticket_id, objective_id, session_id,
            type, phase, summary, payload_json, source, actor_workspace_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'delivery', 'deliver', ?, ?, ?, ?, ?)`
      )
      .run(
        eventId,
        ctx.workspace.id,
        ticket.projectId,
        ticket.id,
        session.objective_id,
        session.id,
        trimmedSummary,
        JSON.stringify({ deliveryId }),
        ctx.source,
        ctx.actorWorkspaceUserId,
        now
      );

    ctx.db
      .prepare(
        `UPDATE objectives SET state = 'complete', completed_at = ?, updated_at = ?, revision = revision + 1
         WHERE id = ?`
      )
      .run(now, now, session.objective_id);

    ctx.db
      .prepare(
        `UPDATE agent_sessions
         SET delivery_state = 'delivered', phase = 'review', ended_at = ?, updated_at = ?, revision = revision + 1
         WHERE id = ?`
      )
      .run(now, now, session.id);

    moveTicketToReview({ ctx, ticketId: ticket.id });
  });

  tx();

  // The objective that just delivered is the agent the user last ran. Auto-advance
  // inherits it when the next objective has not been given its own agent, so the
  // chain never silently falls back to the runner's hardcoded default.
  const deliveredObjective = ctx.db
    .prepare(`SELECT assigned_agent, model, reasoning_effort FROM objectives WHERE id = ?`)
    .get(session.objective_id) as
    | { assigned_agent: string | null; model: string | null; reasoning_effort: string | null }
    | undefined;

  const nextObjective = ctx.db
    .prepare(
      `SELECT id, title, auto_advance, assigned_agent, model, reasoning_effort FROM objectives
       WHERE ticket_id = ? AND position > (
         SELECT position FROM objectives WHERE id = ?
       ) AND state = 'draft'
       ORDER BY position ASC LIMIT 1`
    )
    .get(ticket.id, session.objective_id) as
    | {
        id: string;
        title: string;
        auto_advance: number;
        assigned_agent: string | null;
        model: string | null;
        reasoning_effort: string | null;
      }
    | undefined;

  if (nextObjective) {
    const eventId = newId();
    const eventNow = nowIso();
    if (nextObjective.auto_advance === 1) {
      // Resolve the agent from the database: the next objective's own assignment
      // wins, otherwise inherit the just-delivered objective's selection. Persist
      // any inherited choice onto the objective so the stored agent, the launch
      // button that reads it, and the queued execution request all agree.
      const inheritAgent =
        !nextObjective.assigned_agent && Boolean(deliveredObjective?.assigned_agent);
      const objectiveFields = ["state = 'launching'"];
      const objectiveParams: unknown[] = [];
      const changedFields = ['state'];
      if (inheritAgent && deliveredObjective) {
        objectiveFields.push('assigned_agent = ?', 'model = ?', 'reasoning_effort = ?');
        objectiveParams.push(
          deliveredObjective.assigned_agent,
          deliveredObjective.model,
          deliveredObjective.reasoning_effort
        );
        changedFields.push('assigned_agent', 'model', 'reasoning_effort');
      }
      ctx.db
        .prepare(
          `UPDATE objectives SET ${objectiveFields.join(', ')}, updated_at = ?, revision = revision + 1
           WHERE id = ?`
        )
        .run(...objectiveParams, eventNow, nextObjective.id);
      const updatedRevision = ctx.db
        .prepare(`SELECT revision FROM objectives WHERE id = ?`)
        .get(nextObjective.id) as { revision: number };
      recordChange({
        ctx,
        entityType: 'objective',
        entityId: nextObjective.id,
        operation: 'update',
        entityRevision: updatedRevision.revision,
        projectId: ticket.projectId,
        ticketId: ticket.id,
        objectiveId: nextObjective.id,
        changedFields
      });
      try {
        createExecutionRequest({
          ctx,
          ticketId: ticket.id,
          objectiveId: nextObjective.id,
          requestedAgent:
            nextObjective.assigned_agent ?? deliveredObjective?.assigned_agent ?? null,
          requestedModel: nextObjective.assigned_agent
            ? nextObjective.model
            : (deliveredObjective?.model ?? null),
          requestedReasoningEffort: nextObjective.assigned_agent
            ? nextObjective.reasoning_effort
            : (deliveredObjective?.reasoning_effort ?? null),
          requestedSource: 'auto_advance',
          idempotencyKey: `auto_advance:${nextObjective.id}`
        });
      } catch (error) {
        ctx.db
          .prepare(
            `INSERT INTO ticket_events
               (id, workspace_id, project_id, ticket_id, objective_id,
                type, phase, summary, payload_json, source, actor_workspace_user_id, created_at)
             VALUES (?, ?, ?, ?, ?, 'alert', 'review', ?, ?, ?, ?, ?)`
          )
          .run(
            eventId,
            ctx.workspace.id,
            ticket.projectId,
            ticket.id,
            nextObjective.id,
            `Auto-advance could not queue the next objective: ${
              error instanceof Error ? error.message : String(error)
            }`,
            JSON.stringify({ autoAdvanceFailed: true }),
            ctx.source,
            ctx.actorWorkspaceUserId,
            eventNow
          );
      }
    } else {
      ctx.db
        .prepare(
          `INSERT INTO ticket_events
             (id, workspace_id, project_id, ticket_id, objective_id,
              type, phase, summary, payload_json, source, actor_workspace_user_id, created_at)
           VALUES (?, ?, ?, ?, ?, 'awaiting_approval', 'review', ?, '{}', ?, ?, ?)`
        )
        .run(
          eventId,
          ctx.workspace.id,
          ticket.projectId,
          ticket.id,
          nextObjective.id,
          `Next objective is waiting for approval: ${nextObjective.title}`,
          ctx.source,
          ctx.actorWorkspaceUserId,
          eventNow
        );
    }
  }

  return { deliveryId, eventId };
}

export function protocolCreate({
  ctx,
  projectId,
  objectives,
  title
}: {
  ctx: ServiceContext;
  projectId?: string | null;
  objectives: Array<{ objective: string; title?: string | null; autoAdvance?: boolean }>;
  title?: string | null;
}): { ticket: TicketSummary; objectives: ObjectiveSummary[] } {
  const resolvedProjectId = projectId
    ? resolveProjectId(ctx, projectId)
    : discoverProject({ ctx }).projectId;
  return createTicketWithObjectives({
    ctx,
    projectId: resolvedProjectId,
    objectives,
    ...(title !== undefined ? { title } : {})
  });
}

export function protocolPrompt({
  ctx,
  projectId,
  objectives,
  title,
  agentIdentifier = 'unknown',
  externalSessionId
}: {
  ctx: ServiceContext;
  projectId?: string | null;
  objectives: Array<{ objective: string; title?: string | null; autoAdvance?: boolean }>;
  title?: string | null;
  agentIdentifier?: string;
  externalSessionId?: string | null;
}): AttachResponse & { sessionKey: string } {
  const discovery = projectId
    ? { projectId: resolveProjectId(ctx, projectId) }
    : discoverProject({ ctx });
  const created = createTicketWithObjectives({
    ctx,
    projectId: discovery.projectId,
    objectives,
    ...(title !== undefined ? { title } : {})
  });

  const submitted = ctx.db
    .prepare(
      `UPDATE objectives SET state = 'launching', updated_at = ?, revision = revision + 1
       WHERE id = ?`
    )
    .run(nowIso(), created.objectives[0]?.id);

  void submitted;

  return attachSession({
    ctx,
    ticketId: created.ticket.id,
    agentIdentifier,
    connectionMethod: 'prompt',
    externalSessionId: externalSessionId ?? null
  });
}

export function recordWork({
  ctx,
  projectId,
  summary,
  objective,
  title,
  artifacts = [],
  changeRationales = []
}: {
  ctx: ServiceContext;
  projectId?: string | null;
  summary: string;
  objective: string;
  title?: string | null;
  artifacts?: Array<{ type: string; label: string; content?: string | null; url?: string | null }>;
  changeRationales?: ChangeRationaleInput[];
}): { ticket: TicketSummary; deliveryId: string } {
  const trimmedSummary = summary.trim();
  if (!trimmedSummary) {
    throw new ServiceError('Summary is required for record-work', 'validation_error');
  }

  const resolvedProjectId = projectId
    ? resolveProjectId(ctx, projectId)
    : discoverProject({ ctx }).projectId;

  const created = createTicketWithObjectives({
    ctx,
    projectId: resolvedProjectId,
    objectives: [{ objective }],
    statusType: 'review',
    ...(title !== undefined ? { title } : {})
  });

  const now = nowIso();
  const deliveryId = newId();
  const objectiveId = created.objectives[0]?.id;
  if (!objectiveId) {
    throw new ServiceError('Failed to create objective for record-work', 'internal_error', 500);
  }

  const tx = ctx.db.transaction(() => {
    ctx.db
      .prepare(
        `INSERT INTO deliveries
           (id, workspace_id, project_id, ticket_id, objective_id, session_id,
            summary, payload_json, delivered_at, delivered_by_workspace_user_id,
            created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, NULL, ?, '{}', ?, ?, ?, ?, 1)`
      )
      .run(
        deliveryId,
        ctx.workspace.id,
        resolvedProjectId,
        created.ticket.id,
        objectiveId,
        trimmedSummary,
        now,
        ctx.actorWorkspaceUserId,
        now,
        now
      );

    for (const artifact of artifacts) {
      ctx.db
        .prepare(
          `INSERT INTO artifacts
             (id, workspace_id, project_id, ticket_id, objective_id, delivery_id,
              type, label, content_text, external_url, created_at, updated_at, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
        )
        .run(
          newId(),
          ctx.workspace.id,
          resolvedProjectId,
          created.ticket.id,
          objectiveId,
          deliveryId,
          artifact.type,
          artifact.label,
          artifact.content ?? null,
          artifact.url ?? null,
          now,
          now
        );
    }

    for (const rationale of normalizeChangeRationales(changeRationales)) {
      ctx.db
        .prepare(
          `INSERT INTO change_rationales
             (id, workspace_id, project_id, ticket_id, objective_id, delivery_id,
              file_path, label, summary, why, impact, hunks_json, is_final, created_at, updated_at, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 1)`
        )
        .run(
          newId(),
          ctx.workspace.id,
          resolvedProjectId,
          created.ticket.id,
          objectiveId,
          deliveryId,
          rationale.filePath,
          rationale.label,
          rationale.summary,
          rationale.why,
          rationale.impact,
          JSON.stringify(rationale.hunks ?? []),
          now,
          now
        );
    }

    ctx.db
      .prepare(
        `INSERT INTO ticket_events
           (id, workspace_id, project_id, ticket_id, objective_id,
            type, phase, summary, payload_json, source, actor_workspace_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, 'delivery', 'deliver', ?, ?, ?, ?, ?)`
      )
      .run(
        newId(),
        ctx.workspace.id,
        resolvedProjectId,
        created.ticket.id,
        objectiveId,
        trimmedSummary,
        JSON.stringify({ deliveryId, recordWork: true }),
        ctx.source,
        ctx.actorWorkspaceUserId,
        now
      );
  });

  tx();
  return { ticket: created.ticket, deliveryId };
}

export function authStatus({ ctx }: { ctx: ServiceContext }): {
  ready: boolean;
  workspaceId: string;
  workspaceName: string;
  authMode: 'local_implicit';
  actorWorkspaceUserId: string | null;
} {
  return {
    ready: true,
    workspaceId: ctx.workspace.id,
    workspaceName: ctx.workspace.name,
    authMode: 'local_implicit',
    actorWorkspaceUserId: ctx.actorWorkspaceUserId
  };
}

export {
  addObjectivesToTicket,
  createTicketWithObjectives,
  discussObjective,
  listSharedContext,
  searchTickets,
  writeSharedContext
} from './tickets.js';
