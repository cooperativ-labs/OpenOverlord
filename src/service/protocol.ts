import { UPDATE_EVENT_TYPES, UPDATE_PHASES } from '../database/constants.js';

import { recordChange } from './change-feed.js';
import type { ServiceContext } from './context.js';
import { resolveProjectId, resolveTicketId } from './context.js';
import { ServiceError } from './errors.js';
import { createExecutionRequest } from './execution-requests.js';
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

const PROTOCOL_WORKFLOW = `Required protocol workflow:
1. Attach first with \`ovld protocol attach --ticket-id <id>\`.
2. Post progress with \`ovld protocol update\` or liveness with \`ovld protocol heartbeat\`.
3. Ask blocking questions with \`ovld protocol ask\` and stop work.
4. Deliver with \`ovld protocol deliver\` when work is complete.
5. Do not continue implementation after delivery without \`--begin-follow-up-work\`.`;

function resolveActiveObjective(objectives: ObjectiveSummary[]): ObjectiveSummary {
  const active =
    objectives.find(o => o.state === 'executing') ??
    objectives.find(o => o.state === 'submitted') ??
    objectives.find(o => o.state === 'pending_delivery') ??
    objectives.find(o => o.state === 'draft') ??
    objectives.find(o => o.state !== 'complete');

  if (!active) {
    throw new ServiceError('No active objective found on ticket', 'no_active_objective', 409);
  }
  return active;
}

function getSessionByKey(
  ctx: ServiceContext,
  sessionKey: string
): {
  id: string;
  ticket_id: string;
  objective_id: string;
  phase: string;
  delivery_state: string;
} {
  const hash = hashSessionKey(sessionKey);
  const row = ctx.db
    .prepare(
      `SELECT id, ticket_id, objective_id, phase, delivery_state
       FROM agent_sessions
       WHERE workspace_id = ? AND session_key_hash = ? AND deleted_at IS NULL AND ended_at IS NULL
       ORDER BY started_at DESC LIMIT 1`
    )
    .get(ctx.workspace.id, hash) as
    | {
        id: string;
        ticket_id: string;
        objective_id: string;
        phase: string;
        delivery_state: string;
      }
    | undefined;

  if (!row) {
    throw new ServiceError('Invalid or expired session key', 'invalid_session', 401);
  }
  return row;
}

function assemblePromptContext({
  ticket,
  objective,
  projectName,
  history,
  artifacts,
  attachments,
  sharedState
}: {
  ticket: TicketSummary;
  objective: ObjectiveSummary;
  projectName: string;
  history: TicketEventSummary[];
  artifacts: ArtifactSummary[];
  attachments: AttachmentSummary[];
  sharedState: SharedContextEntry[];
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

  return [
    `# ${ticket.title}`,
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
    artifacts.length > 0 ? '## Artifacts' : '',
    artifacts.length > 0 ? artifactLines : '',
    attachments.length > 0 ? '## Attachments' : '',
    attachments.length > 0 ? attachmentLines : '',
    sharedState.length > 0 ? '## Shared Context' : '',
    sharedState.length > 0 ? sharedLines : '',
    '',
    PROTOCOL_WORKFLOW
  ]
    .filter((line, index, arr) => !(line === '' && arr[index - 1] === ''))
    .join('\n');
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
  const history = listTicketEvents({ ctx, ticketId: ticket.id });
  const artifacts = listArtifacts({ ctx, ticketId: ticket.id });
  const attachments = listAttachments({ ctx, ticketId: ticket.id, objectiveId: objective.id });
  const sharedState = listSharedContext({ ctx, ticketId: ticket.id });

  const project = ctx.db
    .prepare(`SELECT name FROM projects WHERE id = ?`)
    .get(ticket.projectId) as { name: string };

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
      sharedState
    })
  };
}

export function attachSession({
  ctx,
  ticketId,
  agentIdentifier = 'unknown',
  modelIdentifier,
  connectionMethod = 'cli',
  existingSessionKey
}: {
  ctx: ServiceContext;
  ticketId: string;
  agentIdentifier?: string;
  modelIdentifier?: string | null;
  connectionMethod?: string;
  existingSessionKey?: string | null;
}): AttachResponse & { sessionKey: string } {
  const context = loadTicketContext({ ctx, ticketId });
  const objective = context.objective;

  if (existingSessionKey) {
    const existing = getSessionByKey(ctx, existingSessionKey);
    if (existing.ticket_id !== context.ticket.id) {
      throw new ServiceError('Session key belongs to a different ticket', 'invalid_session', 401);
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

  const tx = ctx.db.transaction(() => {
    ctx.db
      .prepare(
        `UPDATE objectives SET state = 'executing', updated_at = ?, revision = revision + 1
         WHERE id = ? AND ticket_id = ?`
      )
      .run(now, objective.id, context.ticket.id);

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
      }
    }

    moveTicketToExecute({ ctx, ticketId: context.ticket.id });

    ctx.db
      .prepare(
        `INSERT INTO agent_sessions
           (id, workspace_id, project_id, ticket_id, objective_id,
            session_key_prefix, session_key_hash, agent_identifier, model_identifier,
            connection_method, phase, delivery_state, started_at, last_heartbeat_at,
            metadata_json, created_by_workspace_user_id, created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'execute', 'not_delivered', ?, ?, '{}', ?, ?, ?, 1)`
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
  agentIdentifier = 'unknown'
}: {
  ctx: ServiceContext;
  ticketId: string;
  agentIdentifier?: string;
}): { sessionKey: string; ticketId: string; objectiveId: string } {
  const result = attachSession({ ctx, ticketId, agentIdentifier, connectionMethod: 'connect' });
  return {
    sessionKey: result.sessionKey,
    ticketId: result.ticket.id,
    objectiveId: result.objective.id
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
          ...(changeRationales ? { changeRationales } : {})
        }),
        externalUrl ?? null,
        ctx.source,
        ctx.actorWorkspaceUserId,
        now
      );

    if (externalSessionId) {
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
      for (const file of changedFiles) {
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
                   last_observed_event_id = ?, updated_at = ?, revision = revision + 1
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
  file_path: string;
  label: string;
  summary: string;
  why: string;
  impact: string;
  hunks?: Array<{ header: string }>;
};

export function deliverSession({
  ctx,
  ticketId,
  sessionKey,
  summary,
  artifacts = [],
  changeRationales = [],
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

  const changedFiles = ctx.db
    .prepare(
      `SELECT id, file_path FROM changed_files
       WHERE session_id = ? AND objective_id = ? AND deleted_at IS NULL
         AND current_diff_state = 'present'`
    )
    .all(session.id, session.objective_id) as Array<{ id: string; file_path: string }>;

  const meaningfulFiles = changedFiles.filter(file => !file.file_path.includes('package-lock'));
  if (meaningfulFiles.length > 0) {
    for (const file of meaningfulFiles) {
      const rationale = changeRationales.find(r => r.file_path === file.file_path);
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

  const now = nowIso();
  const deliveryId = newId();
  const eventId = newId();

  const tx = ctx.db.transaction(() => {
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
        JSON.stringify(payloadJson ?? {}),
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

    for (const rationale of changeRationales) {
      const changedFile = meaningfulFiles.find(f => f.file_path === rationale.file_path);
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
          changedFile?.id ?? null,
          rationale.file_path,
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

  const nextObjective = ctx.db
    .prepare(
      `SELECT id, title, auto_advance FROM objectives
       WHERE ticket_id = ? AND position > (
         SELECT position FROM objectives WHERE id = ?
       ) AND state = 'draft'
       ORDER BY position ASC LIMIT 1`
    )
    .get(ticket.id, session.objective_id) as
    | { id: string; title: string; auto_advance: number }
    | undefined;

  if (nextObjective) {
    const eventId = newId();
    const eventNow = nowIso();
    if (nextObjective.auto_advance === 1) {
      ctx.db
        .prepare(
          `UPDATE objectives SET state = 'submitted', updated_at = ?, revision = revision + 1
           WHERE id = ?`
        )
        .run(eventNow, nextObjective.id);
      try {
        createExecutionRequest({
          ctx,
          ticketId: ticket.id,
          objectiveId: nextObjective.id,
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
  objective,
  title
}: {
  ctx: ServiceContext;
  projectId?: string | null;
  objective: string;
  title?: string | null;
}): { ticket: TicketSummary; objectives: ObjectiveSummary[] } {
  const resolvedProjectId = projectId
    ? resolveProjectId(ctx, projectId)
    : discoverProject({ ctx }).projectId;
  return createTicketWithObjectives({
    ctx,
    projectId: resolvedProjectId,
    objectives: [{ objective }],
    ...(title !== undefined ? { title } : {})
  });
}

export function protocolPrompt({
  ctx,
  projectId,
  objective,
  title,
  agentIdentifier = 'unknown'
}: {
  ctx: ServiceContext;
  projectId?: string | null;
  objective: string;
  title?: string | null;
  agentIdentifier?: string;
}): AttachResponse & { sessionKey: string } {
  const discovery = projectId
    ? { projectId: resolveProjectId(ctx, projectId) }
    : discoverProject({ ctx });
  const created = createTicketWithObjectives({
    ctx,
    projectId: discovery.projectId,
    objectives: [{ objective }],
    ...(title !== undefined ? { title } : {})
  });

  const submitted = ctx.db
    .prepare(
      `UPDATE objectives SET state = 'submitted', updated_at = ?, revision = revision + 1
       WHERE id = ?`
    )
    .run(nowIso(), created.objectives[0]?.id);

  void submitted;

  return attachSession({
    ctx,
    ticketId: created.ticket.id,
    agentIdentifier,
    connectionMethod: 'prompt'
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

    for (const rationale of changeRationales) {
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
          rationale.file_path,
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
