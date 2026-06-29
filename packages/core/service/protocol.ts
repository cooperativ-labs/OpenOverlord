import { bindBool, UPDATE_EVENT_TYPES, UPDATE_PHASES } from '@overlord/database';
import { createHash } from 'node:crypto';

import { recordChange } from './change-feed.js';
import { listRationalesForReview, type RationaleReview } from './changes.js';
import type { ServiceContext } from './context.js';
import { resolveMissionId, resolveProjectId } from './context.js';
import { ServiceError } from './errors.js';
import { createExecutionRequest, linkExecutionRequestToSession } from './execution-requests.js';
import {
  type ArtifactSummary,
  type AttachmentSummary,
  createMissionWithObjectives,
  ensureNextDraftObjective,
  getMissionSummary,
  listArtifacts,
  listAttachments,
  listMissionEvents,
  listObjectives,
  listSharedContext,
  type MissionEventSummary,
  type MissionSummary,
  moveMissionToExecute,
  moveMissionToReview,
  type ObjectiveSummary,
  type SharedContextEntry
} from './missions.js';
import { loadAgentInstructionsForWorkspaceUser } from './profiles.js';
import { resolveLaunchConfig, resolveLaunchExecutionTarget } from './project-execution-target.js';
import { discoverProject } from './projects.js';
import { generateSessionKey, hashSessionKey, newId, nowIso } from './util.js';

export type SessionSummary = {
  id: string;
  sessionKey: string;
  state: string;
  objectiveId: string;
  missionId: string;
  phase: string;
  deliveryState: string;
};

export type AttachResponse = {
  mission: MissionSummary;
  objective: ObjectiveSummary;
  objectives: ObjectiveSummary[];
  session: SessionSummary;
  history: MissionEventSummary[];
  artifacts: ArtifactSummary[];
  attachments: AttachmentSummary[];
  sharedState: SharedContextEntry[];
  promptContext: string;
};

type SessionRow = {
  id: string;
  mission_id: string;
  objective_id: string;
  phase: string;
  delivery_state: string;
  ended_at: string | null;
  external_session_id: string | null;
};

const PROTOCOL_WORKFLOW = `

1. Attach first with \`ovld protocol attach --mission-id <id>\`.
2. Post progress with \`ovld protocol update\` or liveness with \`ovld protocol heartbeat\`.
3. Ask blocking questions with \`ovld protocol ask\` and stop work.
4. Deliver with \`ovld protocol deliver\` when work is complete, passing one change-rationale
   entry per meaningful file you changed for this mission.
5. Do not stage or commit changes unless explicitly instructed to do so.
6. Do not continue implementation after delivery without \`--begin-follow-up-work\`.

Change-rationale format (deliver requires this exact shape):
  Pass an array via \`--change-rationales-json '[ ... ]'\` (or stream it on stdin with
  \`--change-rationales-file -\` for large arrays). Each entry is a JSON object — use these
  exact field names:
    - \`file_path\` (string, required) — repo-relative path of the changed file. \`filePath\` is
      also accepted, but there is no \`path\` field.
    - \`label\`     (string, required) — short reviewer-facing title for the change.
    - \`summary\`   (string, required) — what changed. This field is named \`summary\`, NOT
      \`rationale\`; an entry whose explanation key is anything else is rejected.
    - \`why\`       (string, required) — why the change was made.
    - \`impact\`    (string, required) — behavioral impact of the change.
    - \`hunks\`     (optional) — array of { "header": "@@ -10,6 +10,14 @@" } diff-hunk headers.
  Do NOT wrap entries under a \`rationale\` key, and do not send a top-level \`file_changes\`
  artifact. Example single entry:
    {"file_path":"src/api.ts","label":"Add retry","summary":"Added retry with backoff.","why":"Transient failures.","impact":"Requests retry up to 3x."}
  Changed files are detected for you (VCS baseline at attach vs. \`git status\` at deliver); you
  only supply the rationale per file. If the run changed no files, deliver with \`--no-file-changes\`.`;

function resolveActiveObjective(objectives: ObjectiveSummary[]): ObjectiveSummary {
  const active =
    objectives.find(o => o.state === 'executing') ??
    objectives.find(o => o.state === 'launching') ??
    objectives.find(o => o.state === 'pending_delivery') ??
    objectives.find(o => o.state === 'draft') ??
    objectives.find(o => o.state !== 'complete');

  if (!active) {
    throw new ServiceError('No active objective found on mission', 'no_active_objective', 409);
  }
  return active;
}

async function getSessionByKeyMaybeEnded(
  ctx: ServiceContext,
  sessionKey: string,
  options: { includeEnded?: boolean } = {}
): Promise<SessionRow | undefined> {
  const hash = hashSessionKey(sessionKey);
  const endedFilter = options.includeEnded ? '' : 'AND ended_at IS NULL';
  return (await ctx.db.get(
    `SELECT id, mission_id, objective_id, phase, delivery_state, ended_at, external_session_id
       FROM agent_sessions
       WHERE workspace_id = ? AND session_key_hash = ? AND deleted_at IS NULL ${endedFilter}
       ORDER BY started_at DESC LIMIT 1`,
    [ctx.workspace.id, hash]
  )) as SessionRow | undefined;
}

async function getSessionByKey(ctx: ServiceContext, sessionKey: string): Promise<SessionRow> {
  const row = await getSessionByKeyMaybeEnded(ctx, sessionKey);

  if (!row) {
    throw new ServiceError('Invalid or expired session key', 'invalid_session', 401);
  }
  return row;
}

async function getLatestSessionByExternalId({
  ctx,
  missionId,
  externalSessionId
}: {
  ctx: ServiceContext;
  missionId: string;
  externalSessionId: string;
}): Promise<SessionRow | undefined> {
  return (await ctx.db.get(
    `SELECT id, mission_id, objective_id, phase, delivery_state, ended_at, external_session_id
       FROM agent_sessions
       WHERE workspace_id = ? AND mission_id = ? AND external_session_id = ? AND deleted_at IS NULL
       ORDER BY started_at DESC LIMIT 1`,
    [ctx.workspace.id, missionId, externalSessionId]
  )) as SessionRow | undefined;
}

async function getLatestSessionForObjective({
  ctx,
  objectiveId,
  openOnly = false
}: {
  ctx: ServiceContext;
  objectiveId: string;
  openOnly?: boolean;
}): Promise<SessionRow | undefined> {
  const endedFilter = openOnly ? 'AND ended_at IS NULL' : '';
  return (await ctx.db.get(
    `SELECT id, mission_id, objective_id, phase, delivery_state, ended_at, external_session_id
       FROM agent_sessions
       WHERE workspace_id = ? AND objective_id = ? AND deleted_at IS NULL ${endedFilter}
       ORDER BY started_at DESC LIMIT 1`,
    [ctx.workspace.id, objectiveId]
  )) as SessionRow | undefined;
}

async function persistExternalSessionId({
  ctx,
  session,
  externalSessionId,
  mission
}: {
  ctx: ServiceContext;
  session: SessionRow;
  externalSessionId: string;
  mission: MissionSummary;
}): Promise<void> {
  if (session.external_session_id === externalSessionId) return;

  const now = nowIso();
  await ctx.db.run(
    `UPDATE agent_sessions SET external_session_id = ?, updated_at = ?, revision = revision + 1
       WHERE id = ?`,
    [externalSessionId, now, session.id]
  );

  const revision = (
    (await ctx.db.get(`SELECT revision FROM agent_sessions WHERE id = ?`, [session.id])) as
      | { revision: number }
      | undefined
  )?.revision;

  await recordChange({
    ctx,
    entityType: 'agent_session',
    entityId: session.id,
    operation: 'update',
    entityRevision: revision ?? null,
    projectId: mission.projectId,
    missionId: mission.id,
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
  mission,
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
  mission: MissionSummary;
  objective: ObjectiveSummary;
  projectName: string;
  history: MissionEventSummary[];
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
    `You are an AI coding agent working on mission **${mission.displayId}** via Overlord.`,
    `Complete the Objective described below. Use the Overlord skill. Follow the required protocol workflow.`,
    ``,
    `Required protocol workflow:`,
    PROTOCOL_WORKFLOW,
    '',
    `Mission ID: ${mission.displayId}`,
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

async function contextForObjective({
  ctx,
  mission,
  objective
}: {
  ctx: ServiceContext;
  mission: MissionSummary;
  objective: ObjectiveSummary;
}): Promise<Omit<AttachResponse, 'session'>> {
  const objectives = await listObjectives({ ctx, missionId: mission.id });
  const history = await listMissionEvents({ ctx, missionId: mission.id });
  const artifacts = await listArtifacts({ ctx, missionId: mission.id });
  const attachments = await listAttachments({
    ctx,
    missionId: mission.id,
    objectiveId: objective.id
  });
  const sharedState = await listSharedContext({ ctx, missionId: mission.id });
  const completedObjectives = previousCompletedObjectives({
    objectives,
    currentObjective: objective
  });
  const previousObjectiveIds = new Set(completedObjectives.map(entry => entry.id));
  const fileChanges = (await listRationalesForReview({ ctx, missionId: mission.id })).filter(
    change => previousObjectiveIds.has(change.objectiveId)
  );

  const project = (await ctx.db.get(`SELECT name FROM projects WHERE id = ?`, [
    mission.projectId
  ])) as { name: string };

  const agentInstructions = await loadAgentInstructionsForWorkspaceUser({
    db: ctx.db,
    workspaceUserId: ctx.actorWorkspaceUserId
  });

  return {
    mission,
    objective,
    objectives,
    history,
    artifacts,
    attachments,
    sharedState,
    promptContext: assemblePromptContext({
      mission,
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

export async function loadMissionContext({
  ctx,
  missionId
}: {
  ctx: ServiceContext;
  missionId: string;
}): Promise<Omit<AttachResponse, 'session'>> {
  const mission = await getMissionSummary({ ctx, missionId });
  const objectives = await listObjectives({ ctx, missionId: mission.id });
  const objective = resolveActiveObjective(objectives);
  return await contextForObjective({ ctx, mission, objective });
}

export async function attachSession({
  ctx,
  missionId,
  agentIdentifier = 'unknown',
  modelIdentifier,
  connectionMethod = 'cli',
  existingSessionKey,
  externalSessionId,
  executionRequestId
}: {
  ctx: ServiceContext;
  missionId: string;
  agentIdentifier?: string;
  modelIdentifier?: string | null;
  connectionMethod?: string;
  existingSessionKey?: string | null;
  externalSessionId?: string | null;
  executionRequestId?: string | null;
}): Promise<AttachResponse & { sessionKey: string }> {
  const context = await loadMissionContext({ ctx, missionId });
  const objective = context.objective;

  if (existingSessionKey) {
    const existing = await getSessionByKey(ctx, existingSessionKey);
    if (existing.mission_id !== context.mission.id) {
      throw new ServiceError('Session key belongs to a different mission', 'invalid_session', 401);
    }
    if (externalSessionId !== undefined) {
      await ctx.db.run(
        `UPDATE agent_sessions SET external_session_id = ?, updated_at = ?, revision = revision + 1
           WHERE id = ?`,
        [externalSessionId, nowIso(), existing.id]
      );
    }
    await linkExecutionRequestToSession({
      ctx,
      missionId: context.mission.id,
      objectiveId: existing.objective_id,
      sessionId: existing.id,
      executionRequestId: executionRequestId ?? null
    });
    return {
      ...context,
      session: {
        id: existing.id,
        sessionKey: existingSessionKey,
        state: 'executing',
        objectiveId: existing.objective_id,
        missionId: existing.mission_id,
        phase: existing.phase,
        deliveryState: existing.delivery_state
      },
      sessionKey: existingSessionKey
    };
  }

  const { rawKey, prefix, hash } = generateSessionKey();
  const now = nowIso();
  const sessionId = newId();
  const currentObjectiveAssignment = (await ctx.db.get(
    `SELECT assigned_agent, revision
       FROM objectives
       WHERE id = ? AND mission_id = ? AND deleted_at IS NULL`,
    [objective.id, context.mission.id]
  )) as { assigned_agent: string | null; revision: number } | undefined;
  const inheritedDraftAgent = currentObjectiveAssignment?.assigned_agent?.trim() || agentIdentifier;

  await ctx.db.transaction(async tx => {
    const txCtx = { ...ctx, db: tx };
    await txCtx.db.run(
      `UPDATE objectives
         SET state = 'executing',
             assigned_agent = COALESCE(assigned_agent, ?),
             updated_at = ?,
             revision = revision + 1
         WHERE id = ? AND mission_id = ?`,
      [inheritedDraftAgent || null, now, objective.id, context.mission.id]
    );
    await recordChange({
      ctx: txCtx,
      entityType: 'objective',
      entityId: objective.id,
      operation: 'update',
      entityRevision: (currentObjectiveAssignment?.revision ?? 0) + 1,
      projectId: context.mission.projectId,
      missionId: context.mission.id,
      objectiveId: objective.id,
      changedFields: [
        'state',
        ...(currentObjectiveAssignment?.assigned_agent ? [] : ['assigned_agent'])
      ]
    });

    await ensureNextDraftObjective({
      ctx: txCtx,
      missionId: context.mission.id,
      projectId: context.mission.projectId,
      assignedAgent: inheritedDraftAgent || null,
      now
    });

    await moveMissionToExecute({ ctx: txCtx, missionId: context.mission.id });

    await txCtx.db.run(
      `INSERT INTO agent_sessions
           (id, workspace_id, project_id, mission_id, objective_id,
            session_key_prefix, session_key_hash, agent_identifier, model_identifier,
            connection_method, external_session_id, phase, delivery_state, started_at, last_heartbeat_at,
            metadata_json, created_by_workspace_user_id, created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'execute', 'not_delivered', ?, ?, '{}', ?, ?, ?, 1)`,
      [
        sessionId,
        ctx.workspace.id,
        context.mission.projectId,
        context.mission.id,
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
      ]
    );

    await recordChange({
      ctx: txCtx,
      entityType: 'agent_session',
      entityId: sessionId,
      operation: 'insert',
      entityRevision: 1,
      projectId: context.mission.projectId,
      missionId: context.mission.id,
      objectiveId: objective.id
    });

    await linkExecutionRequestToSession({
      ctx: txCtx,
      missionId: context.mission.id,
      objectiveId: objective.id,
      sessionId,
      executionRequestId: executionRequestId ?? null
    });
  });

  const refreshedMission = await getMissionSummary({ ctx, missionId: context.mission.id });
  const refreshedObjectives = await listObjectives({ ctx, missionId: context.mission.id });
  const refreshedObjective = refreshedObjectives.find(o => o.id === objective.id) ?? {
    ...objective,
    state: 'executing'
  };

  return {
    ...context,
    mission: refreshedMission,
    objective: refreshedObjective,
    objectives: refreshedObjectives,
    session: {
      id: sessionId,
      sessionKey: rawKey,
      state: 'executing',
      objectiveId: objective.id,
      missionId: context.mission.id,
      phase: 'execute',
      deliveryState: 'not_delivered'
    },
    sessionKey: rawKey
  };
}

export async function connectSession({
  ctx,
  missionId,
  agentIdentifier = 'unknown',
  externalSessionId
}: {
  ctx: ServiceContext;
  missionId: string;
  agentIdentifier?: string;
  externalSessionId?: string | null;
}): Promise<{ sessionKey: string; missionId: string; objectiveId: string }> {
  const result = await attachSession({
    ctx,
    missionId,
    agentIdentifier,
    connectionMethod: 'connect',
    externalSessionId: externalSessionId ?? null
  });
  return {
    sessionKey: result.sessionKey,
    missionId: result.mission.id,
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

async function resolveFollowUpObjective({
  ctx,
  mission,
  objectives,
  sessionKey,
  externalSessionId
}: {
  ctx: ServiceContext;
  mission: MissionSummary;
  objectives: ObjectiveSummary[];
  sessionKey?: string | null;
  externalSessionId?: string | null;
}): Promise<{ objective: ObjectiveSummary | undefined; session: SessionRow | undefined }> {
  const active =
    objectives.find(objective =>
      ['executing', 'pending_delivery', 'launching', 'submitted', 'draft'].includes(objective.state)
    ) ?? undefined;
  if (active) return { objective: active, session: undefined };

  const sessionFromKey = sessionKey
    ? await getSessionByKeyMaybeEnded(ctx, sessionKey, { includeEnded: true })
    : undefined;
  const objectiveFromKey = objectiveFromSession(objectives, sessionFromKey);
  if (objectiveFromKey) return { objective: objectiveFromKey, session: sessionFromKey };

  const sessionFromExternal = externalSessionId
    ? await getLatestSessionByExternalId({ ctx, missionId: mission.id, externalSessionId })
    : undefined;
  const objectiveFromExternal = objectiveFromSession(objectives, sessionFromExternal);
  if (objectiveFromExternal) {
    return { objective: objectiveFromExternal, session: sessionFromExternal };
  }

  return { objective: latestCompletedObjective(objectives), session: undefined };
}

export async function recordHookEvent({
  ctx,
  missionId,
  hookType,
  prompt,
  sessionKey,
  externalSessionId,
  turnIndex
}: {
  ctx: ServiceContext;
  missionId: string;
  hookType: string;
  prompt: string;
  sessionKey?: string | null;
  externalSessionId?: string | null;
  turnIndex?: string | null;
}): Promise<{ eventId: string; objectiveId: string | null; sessionId: string | null }> {
  if (hookType !== 'UserPromptSubmit') {
    throw new ServiceError(`Unsupported hook type: ${hookType}`, 'validation_error');
  }

  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) {
    throw new ServiceError('Hook prompt is required', 'validation_error');
  }

  const mission = await getMissionSummary({ ctx, missionId });
  const objectives = await listObjectives({ ctx, missionId: mission.id });
  let { objective, session } = await resolveFollowUpObjective({
    ctx,
    mission,
    objectives,
    sessionKey: sessionKey ?? null,
    externalSessionId: externalSessionId ?? null
  });

  if (!session && sessionKey) {
    session = await getSessionByKeyMaybeEnded(ctx, sessionKey, { includeEnded: true });
  }

  if (!session && objective && ['executing', 'pending_delivery'].includes(objective.state)) {
    session = await getLatestSessionForObjective({
      ctx,
      objectiveId: objective.id,
      openOnly: true
    });
  }

  const hash = promptHash(trimmedPrompt);
  const dedupeParts = [
    hookType,
    mission.id,
    externalSessionId || session?.id || 'unknown-session',
    turnIndex || 'unknown-turn',
    hash
  ];
  const idempotencyKey = dedupeParts.join(':');

  const existing = (await ctx.db.get(
    `SELECT id, objective_id, session_id FROM mission_events
       WHERE workspace_id = ? AND source = ? AND idempotency_key = ?
       LIMIT 1`,
    [ctx.workspace.id, ctx.source, idempotencyKey]
  )) as { id: string; objective_id: string | null; session_id: string | null } | undefined;
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

  await ctx.db.run(
    `INSERT INTO mission_events
         (id, workspace_id, project_id, mission_id, objective_id, session_id,
          type, phase, summary, payload_json, source, actor_workspace_user_id,
          idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'user_follow_up', ?, ?, ?, ?, ?, ?, ?)`,
    [
      eventId,
      ctx.workspace.id,
      mission.projectId,
      mission.id,
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
    ]
  );

  if (externalSessionId && session) {
    await persistExternalSessionId({ ctx, session, externalSessionId, mission });
  }

  return { eventId, objectiveId: objective?.id ?? null, sessionId: session?.id ?? null };
}

export async function resumeFollowUp({
  ctx,
  missionId,
  objectiveId,
  agentIdentifier = 'unknown',
  modelIdentifier,
  connectionMethod = 'cli',
  externalSessionId,
  summary = 'Beginning follow-up work.'
}: {
  ctx: ServiceContext;
  missionId: string;
  objectiveId?: string | null;
  agentIdentifier?: string;
  modelIdentifier?: string | null;
  connectionMethod?: string;
  externalSessionId?: string | null;
  summary?: string | null;
}): Promise<AttachResponse & { sessionKey: string }> {
  const trimmedSummary = summary?.trim() || 'Beginning follow-up work.';
  const mission = await getMissionSummary({ ctx, missionId });
  const objectives = await listObjectives({ ctx, missionId: mission.id });
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
      'Mission already has active follow-up or execution work',
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

  await ctx.db.transaction(async tx => {
    const txCtx = { ...ctx, db: tx };
    await txCtx.db.run(
      `UPDATE objectives
         SET state = 'pending_delivery', completed_at = NULL, updated_at = ?, revision = revision + 1
         WHERE id = ? AND mission_id = ? AND state = 'complete'`,
      [now, selectedObjective.id, mission.id]
    );

    await txCtx.db.run(
      `INSERT INTO agent_sessions
           (id, workspace_id, project_id, mission_id, objective_id,
            session_key_prefix, session_key_hash, agent_identifier, model_identifier,
            connection_method, external_session_id, phase, delivery_state, started_at, last_heartbeat_at,
            metadata_json, created_by_workspace_user_id, created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'execute', 'pending_redelivery', ?, ?, '{}', ?, ?, ?, 1)`,
      [
        sessionId,
        ctx.workspace.id,
        mission.projectId,
        mission.id,
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
      ]
    );

    await txCtx.db.run(
      `INSERT INTO mission_events
           (id, workspace_id, project_id, mission_id, objective_id, session_id,
            type, phase, summary, payload_json, source, actor_workspace_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'update', 'execute', ?, ?, ?, ?, ?)`,
      [
        eventId,
        ctx.workspace.id,
        mission.projectId,
        mission.id,
        selectedObjective.id,
        sessionId,
        trimmedSummary,
        JSON.stringify({ followUpIntent: 'execution', reactivated: true }),
        ctx.source,
        ctx.actorWorkspaceUserId,
        now
      ]
    );

    await moveMissionToExecute({ ctx: txCtx, missionId: mission.id });

    await recordChange({
      ctx: txCtx,
      entityType: 'objective',
      entityId: selectedObjective.id,
      operation: 'update',
      projectId: mission.projectId,
      missionId: mission.id,
      objectiveId: selectedObjective.id,
      changedFields: ['state', 'completed_at']
    });

    await recordChange({
      ctx: txCtx,
      entityType: 'agent_session',
      entityId: sessionId,
      operation: 'insert',
      entityRevision: 1,
      projectId: mission.projectId,
      missionId: mission.id,
      objectiveId: selectedObjective.id
    });
  });

  const refreshedMission = await getMissionSummary({ ctx, missionId: mission.id });
  const refreshedObjective = (await listObjectives({ ctx, missionId: mission.id })).find(
    objective => objective.id === selectedObjective.id
  ) ?? {
    ...selectedObjective,
    state: 'pending_delivery'
  };
  const context = await contextForObjective({
    ctx,
    mission: refreshedMission,
    objective: refreshedObjective
  });

  return {
    ...context,
    session: {
      id: sessionId,
      sessionKey: rawKey,
      state: 'executing',
      objectiveId: selectedObjective.id,
      missionId: mission.id,
      phase: 'execute',
      deliveryState: 'pending_redelivery'
    },
    sessionKey: rawKey
  };
}

export async function heartbeatSession({
  ctx,
  missionId,
  sessionKey,
  phase,
  note
}: {
  ctx: ServiceContext;
  missionId: string;
  sessionKey: string;
  phase?: string | null;
  note?: string | null;
}): Promise<{ ok: true }> {
  const mission = await resolveMissionId(ctx, missionId);
  const session = await getSessionByKey(ctx, sessionKey);
  if (session.mission_id !== mission.id) {
    throw new ServiceError('Session key does not match mission', 'invalid_session', 401);
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
  await ctx.db.run(`UPDATE agent_sessions SET ${fields.join(', ')} WHERE id = ?`, params);

  return { ok: true };
}

/**
 * Upsert mechanically-observed changed files for a session/objective, keyed by
 * normalized path so repeated observations revise the same row. Stores only
 * metadata (path + status), never diffs or file contents. Must run inside a
 * transaction supplied by the caller.
 */
async function upsertChangedFiles({
  ctx,
  mission,
  session,
  files,
  eventId,
  now
}: {
  ctx: ServiceContext;
  mission: { id: string; projectId: string };
  session: { id: string; objective_id: string };
  files: Array<{ filePath: string; vcsStatus?: string | null }>;
  /** Observing event id, or null when no event row exists yet (e.g. deliver). */
  eventId: string | null;
  now: string;
}): Promise<void> {
  for (const file of files) {
    const normalizedPath = file.filePath.replace(/\\/g, '/');
    const existing = (await ctx.db.get(
      `SELECT id FROM changed_files
         WHERE session_id = ? AND objective_id = ? AND file_path = ? AND deleted_at IS NULL`,
      [session.id, session.objective_id, normalizedPath]
    )) as { id: string } | undefined;

    if (existing) {
      await ctx.db.run(
        `UPDATE changed_files
           SET vcs_status = ?, current_diff_state = 'present', last_observed_at = ?,
               last_observed_event_id = COALESCE(?, last_observed_event_id),
               updated_at = ?, revision = revision + 1
           WHERE id = ?`,
        [file.vcsStatus ?? null, now, eventId, now, existing.id]
      );
    } else {
      await ctx.db.run(
        `INSERT INTO changed_files
             (id, workspace_id, project_id, mission_id, objective_id, session_id,
              file_path, vcs_status, current_diff_state, first_observed_at, last_observed_at,
              last_observed_event_id, observed_metadata_json, created_at, updated_at, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'present', ?, ?, ?, '{}', ?, ?, 1)`,
        [
          newId(),
          ctx.workspace.id,
          mission.projectId,
          mission.id,
          session.objective_id,
          session.id,
          normalizedPath,
          file.vcsStatus ?? null,
          now,
          now,
          eventId,
          now,
          now
        ]
      );
    }
  }
}

export async function updateSession({
  ctx,
  missionId,
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
  missionId: string;
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
}): Promise<{ eventId: string }> {
  const trimmedSummary = summary.trim();
  if (!trimmedSummary) {
    throw new ServiceError('Update summary is required', 'validation_error');
  }

  const mission = await resolveMissionId(ctx, missionId);
  const session = await getSessionByKey(ctx, sessionKey);
  if (session.mission_id !== mission.id) {
    throw new ServiceError('Session key does not match mission', 'invalid_session', 401);
  }

  if (session.delivery_state === 'delivered' && !beginFollowUpWork) {
    throw new ServiceError(
      'Mission was delivered. Use --begin-follow-up-work before posting execution updates.',
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

  await ctx.db.transaction(async tx => {
    const txCtx = { ...ctx, db: tx };
    if (beginFollowUpWork) {
      await txCtx.db.run(
        `UPDATE objectives SET state = 'pending_delivery', updated_at = ?, revision = revision + 1
           WHERE id = ?`,
        [now, session.objective_id]
      );
      await txCtx.db.run(
        `UPDATE agent_sessions SET delivery_state = 'pending_redelivery', updated_at = ?, revision = revision + 1
           WHERE id = ?`,
        [now, session.id]
      );
    }

    await txCtx.db.run(
      `INSERT INTO mission_events
           (id, workspace_id, project_id, mission_id, objective_id, session_id,
            type, phase, summary, payload_json, external_url, source,
            actor_workspace_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        eventId,
        ctx.workspace.id,
        mission.projectId,
        mission.id,
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
      ]
    );

    if (externalSessionId !== undefined) {
      await txCtx.db.run(
        `UPDATE agent_sessions SET external_session_id = ?, updated_at = ?, revision = revision + 1
           WHERE id = ?`,
        [externalSessionId, now, session.id]
      );
    }

    if (phase) {
      await txCtx.db.run(
        `UPDATE agent_sessions SET phase = ?, updated_at = ?, revision = revision + 1 WHERE id = ?`,
        [phase, now, session.id]
      );
    }

    if (changedFiles && changedFiles.length > 0) {
      await upsertChangedFiles({ ctx: txCtx, mission, session, files: changedFiles, eventId, now });
    }
  });
  return { eventId };
}

export async function askQuestion({
  ctx,
  missionId,
  sessionKey,
  question
}: {
  ctx: ServiceContext;
  missionId: string;
  sessionKey: string;
  question: string;
}): Promise<{ eventId: string }> {
  const trimmed = question.trim();
  if (!trimmed) {
    throw new ServiceError('Question is required', 'validation_error');
  }

  const mission = await resolveMissionId(ctx, missionId);
  const session = await getSessionByKey(ctx, sessionKey);
  if (session.mission_id !== mission.id) {
    throw new ServiceError('Session key does not match mission', 'invalid_session', 401);
  }

  const now = nowIso();
  const eventId = newId();

  await ctx.db.transaction(async tx => {
    const txCtx = { ...ctx, db: tx };
    await txCtx.db.run(
      `INSERT INTO mission_events
           (id, workspace_id, project_id, mission_id, objective_id, session_id,
            type, phase, summary, payload_json, source, actor_workspace_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'ask', 'blocked', ?, '{}', ?, ?, ?)`,
      [
        eventId,
        ctx.workspace.id,
        mission.projectId,
        mission.id,
        session.objective_id,
        session.id,
        trimmed,
        ctx.source,
        ctx.actorWorkspaceUserId,
        now
      ]
    );
    await recordChange({
      ctx: txCtx,
      entityType: 'mission_event',
      entityId: eventId,
      operation: 'insert',
      projectId: mission.projectId,
      missionId: mission.id,
      objectiveId: session.objective_id
    });

    await moveMissionToReview({ ctx: txCtx, missionId: mission.id });
  });

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

export type SkipRationaleForInput = {
  filePath?: string;
  /** @deprecated alias for {@link SkipRationaleForInput.filePath}. */
  file_path?: string;
  reason: string;
};

type NormalizedSkipRationaleFor = {
  filePath: string;
  reason: string;
};

function normalizeSkipRationaleFor(
  input: ReadonlyArray<SkipRationaleForInput>
): NormalizedSkipRationaleFor[] {
  return input.map(entry => ({
    filePath: (entry.filePath ?? entry.file_path ?? '').replace(/\\/g, '/'),
    reason: entry.reason
  }));
}

export async function deliverSession({
  ctx,
  missionId,
  sessionKey,
  summary,
  artifacts = [],
  changeRationales = [],
  changedFiles,
  noFileChanges = false,
  skipRationaleFor = [],
  payloadJson,
  verificationSummary,
  followUpNotes
}: {
  ctx: ServiceContext;
  missionId: string;
  sessionKey: string;
  summary: string;
  artifacts?: Array<{ type: string; label: string; content?: string | null; url?: string | null }>;
  changeRationales?: ChangeRationaleInput[];
  /** Mechanically observed changes for this run (client-side VCS delta). */
  changedFiles?: Array<{ filePath: string; vcsStatus?: string | null }> | null;
  /** Agent's explicit assertion that this run changed no files. */
  noFileChanges?: boolean;
  /** Per-file rationale overrides for changes the agent did not make. */
  skipRationaleFor?: SkipRationaleForInput[];
  payloadJson?: Record<string, unknown> | null;
  verificationSummary?: string | null;
  followUpNotes?: string | null;
}): Promise<{ deliveryId: string; eventId: string }> {
  const trimmedSummary = summary.trim();
  if (!trimmedSummary) {
    throw new ServiceError('Delivery summary is required', 'validation_error');
  }

  const mission = await resolveMissionId(ctx, missionId);
  const session = await getSessionByKey(ctx, sessionKey);
  if (session.mission_id !== mission.id) {
    throw new ServiceError('Session key does not match mission', 'invalid_session', 401);
  }

  const normalizedRationales = normalizeChangeRationales(changeRationales);
  const normalizedSkips = normalizeSkipRationaleFor(skipRationaleFor);
  const skipPathSet = new Set(normalizedSkips.map(entry => entry.filePath));

  for (const skip of normalizedSkips) {
    if (!skip.filePath.trim()) {
      throw new ServiceError(
        'Each skip-rationale-for entry requires a non-empty file_path.',
        'invalid_rationale_skip',
        400
      );
    }
    if (!skip.reason.trim()) {
      throw new ServiceError(
        `Change rationale skip for ${skip.filePath} is missing required field: reason`,
        'invalid_rationale_skip',
        400
      );
    }
  }

  for (const rationale of normalizedRationales) {
    if (skipPathSet.has(rationale.filePath)) {
      throw new ServiceError(
        `Cannot skip and provide a rationale for the same file: ${rationale.filePath}`,
        'invalid_rationale_skip',
        400
      );
    }
  }

  const now = nowIso();
  const deliveryId = newId();
  const eventId = newId();

  // Populated inside the transaction once the run's changed files are recorded,
  // then used to link rationales to their changed-file rows.
  let changedFileIdByPath = new Map<string, string>();

  await ctx.db.transaction(async tx => {
    const txCtx = { ...ctx, db: tx };
    // Record the run's mechanically-observed changed files (client-side VCS
    // delta) so review reflects what actually changed — unless the agent
    // explicitly declared this run made no file changes.
    if (!noFileChanges && changedFiles && changedFiles.length > 0) {
      // The delivery event row is inserted later in this transaction, so there is
      // no observing event to link yet; pass null (COALESCE keeps prior links).
      await upsertChangedFiles({
        ctx: txCtx,
        mission,
        session,
        files: changedFiles,
        eventId: null,
        now
      });
    }

    // Coverage is objective-scoped: aggregate observed changes across every
    // session for the objective (and no-session record-work records).
    const objectiveChangedFiles = (await txCtx.db.all(
      `SELECT id, file_path, current_diff_state FROM changed_files
         WHERE objective_id = ? AND deleted_at IS NULL`,
      [session.objective_id]
    )) as Array<{
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
        if (skipPathSet.has(file.file_path)) {
          continue;
        }
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

    await txCtx.db.run(
      `INSERT INTO deliveries
           (id, workspace_id, project_id, mission_id, objective_id, session_id,
            summary, payload_json, verification_summary, follow_up_notes,
            delivered_at, delivered_by_workspace_user_id, created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        deliveryId,
        ctx.workspace.id,
        mission.projectId,
        mission.id,
        session.objective_id,
        session.id,
        trimmedSummary,
        JSON.stringify({
          ...(payloadJson ?? {}),
          ...(noFileChanges ? { noFileChanges: true } : {}),
          ...(normalizedSkips.length > 0
            ? {
                rationaleSkips: normalizedSkips.map(entry => ({
                  filePath: entry.filePath,
                  reason: entry.reason
                }))
              }
            : {})
        }),
        verificationSummary ?? null,
        followUpNotes ?? null,
        now,
        ctx.actorWorkspaceUserId,
        now,
        now
      ]
    );

    for (const artifact of artifacts) {
      await txCtx.db.run(
        `INSERT INTO artifacts
             (id, workspace_id, project_id, mission_id, objective_id, session_id, delivery_id,
              type, label, content_text, external_url, created_at, updated_at, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          newId(),
          ctx.workspace.id,
          mission.projectId,
          mission.id,
          session.objective_id,
          session.id,
          deliveryId,
          artifact.type,
          artifact.label,
          artifact.content ?? null,
          artifact.url ?? null,
          now,
          now
        ]
      );
    }

    for (const rationale of normalizedRationales) {
      const changedFileId = changedFileIdByPath.get(rationale.filePath) ?? null;
      await txCtx.db.run(
        `INSERT INTO change_rationales
             (id, workspace_id, project_id, mission_id, objective_id, session_id, delivery_id,
              changed_file_id, file_path, label, summary, why, impact, hunks_json,
              is_final, created_at, updated_at, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          newId(),
          ctx.workspace.id,
          mission.projectId,
          mission.id,
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
          bindBool(txCtx.db.dialect, true),
          now,
          now
        ]
      );
    }

    for (const skip of normalizedSkips) {
      const changedFileId = changedFileIdByPath.get(skip.filePath);
      if (!changedFileId) continue;
      await txCtx.db.run(
        `UPDATE changed_files
           SET observed_metadata_json = ?, updated_at = ?, revision = revision + 1
           WHERE id = ?`,
        [
          JSON.stringify({
            rationaleSkipped: true,
            skipReason: skip.reason,
            skippedAtDeliveryId: deliveryId
          }),
          now,
          changedFileId
        ]
      );
    }

    await txCtx.db.run(
      `INSERT INTO mission_events
           (id, workspace_id, project_id, mission_id, objective_id, session_id,
            type, phase, summary, payload_json, source, actor_workspace_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'delivery', 'deliver', ?, ?, ?, ?, ?)`,
      [
        eventId,
        ctx.workspace.id,
        mission.projectId,
        mission.id,
        session.objective_id,
        session.id,
        trimmedSummary,
        JSON.stringify({ deliveryId }),
        ctx.source,
        ctx.actorWorkspaceUserId,
        now
      ]
    );
    await recordChange({
      ctx: txCtx,
      entityType: 'mission_event',
      entityId: eventId,
      operation: 'insert',
      projectId: mission.projectId,
      missionId: mission.id,
      objectiveId: session.objective_id
    });

    await txCtx.db.run(
      `UPDATE objectives SET state = 'complete', completed_at = ?, updated_at = ?, revision = revision + 1
         WHERE id = ?`,
      [now, now, session.objective_id]
    );
    const objectiveRevision = (
      (await txCtx.db.get(`SELECT revision FROM objectives WHERE id = ?`, [
        session.objective_id
      ])) as { revision: number } | undefined
    )?.revision;
    await recordChange({
      ctx: txCtx,
      entityType: 'objective',
      entityId: session.objective_id,
      operation: 'update',
      entityRevision: objectiveRevision ?? null,
      projectId: mission.projectId,
      missionId: mission.id,
      objectiveId: session.objective_id,
      changedFields: ['state', 'completed_at']
    });

    await txCtx.db.run(
      `UPDATE agent_sessions
         SET delivery_state = 'delivered', phase = 'review', ended_at = ?, updated_at = ?, revision = revision + 1
         WHERE id = ?`,
      [now, now, session.id]
    );
    const sessionRevision = (
      (await txCtx.db.get(`SELECT revision FROM agent_sessions WHERE id = ?`, [session.id])) as
        | { revision: number }
        | undefined
    )?.revision;
    await recordChange({
      ctx: txCtx,
      entityType: 'agent_session',
      entityId: session.id,
      operation: 'update',
      entityRevision: sessionRevision ?? null,
      projectId: mission.projectId,
      missionId: mission.id,
      objectiveId: session.objective_id,
      changedFields: ['delivery_state', 'phase', 'ended_at']
    });

    await moveMissionToReview({ ctx: txCtx, missionId: mission.id });
  });

  // The objective that just delivered is the agent the user last ran. Auto-advance
  // inherits it when the next objective has not been given its own agent, so the
  // chain never silently falls back to the runner's hardcoded default.
  const deliveredObjective = (await ctx.db.get(
    `SELECT assigned_agent, model, reasoning_effort FROM objectives WHERE id = ?`,
    [session.objective_id]
  )) as
    | { assigned_agent: string | null; model: string | null; reasoning_effort: string | null }
    | undefined;

  await ensureNextDraftObjective({
    ctx: ctx,
    missionId: mission.id,
    projectId: mission.projectId,
    assignedAgent: deliveredObjective?.assigned_agent ?? null,
    now: nowIso()
  });

  const nextObjective = (await ctx.db.get(
    `SELECT id, title, auto_advance, assigned_agent, model, reasoning_effort, launch_config_json
       FROM objectives
       WHERE mission_id = ? AND position > (
         SELECT position FROM objectives WHERE id = ?
       ) AND state = 'draft'
       ORDER BY position ASC LIMIT 1`,
    [mission.id, session.objective_id]
  )) as
    | {
        id: string;
        title: string;
        auto_advance: number;
        assigned_agent: string | null;
        model: string | null;
        reasoning_effort: string | null;
        launch_config_json: string | null;
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
      await ctx.db.run(
        `UPDATE objectives SET ${objectiveFields.join(', ')}, updated_at = ?, revision = revision + 1
           WHERE id = ?`,
        [...objectiveParams, eventNow, nextObjective.id]
      );
      const updatedRevision = (await ctx.db.get(`SELECT revision FROM objectives WHERE id = ?`, [
        nextObjective.id
      ])) as { revision: number };
      await recordChange({
        ctx: ctx,
        entityType: 'objective',
        entityId: nextObjective.id,
        operation: 'update',
        entityRevision: updatedRevision.revision,
        projectId: mission.projectId,
        missionId: mission.id,
        objectiveId: nextObjective.id,
        changedFields
      });
      try {
        // Mirror the manual launch path (webapp launchObjective): resolve the
        // project's execution target and the effective launch config (pre-command
        // + flags) for the resolved agent, then stamp both onto the queued request.
        // Without this, auto-advanced requests were written with launch_flags_json
        // = '{}' and a null target, so the agent launched with no pre-command and
        // none of the configured flags.
        const resolvedAgent =
          nextObjective.assigned_agent ?? deliveredObjective?.assigned_agent ?? null;
        const { executionTargetId, agentConfigs } = await resolveLaunchExecutionTarget({
          ctx: ctx,
          projectId: mission.projectId
        });
        const resolvedLaunch = await resolveLaunchConfig({
          ctx: ctx,
          objectiveLaunchConfigJson: nextObjective.launch_config_json,
          executionTargetId,
          agentKey: resolvedAgent ?? '',
          userConfigs: agentConfigs
        });
        await createExecutionRequest({
          ctx: ctx,
          missionId: mission.id,
          objectiveId: nextObjective.id,
          requestedAgent: resolvedAgent,
          requestedModel: nextObjective.assigned_agent
            ? nextObjective.model
            : (deliveredObjective?.model ?? null),
          requestedReasoningEffort: nextObjective.assigned_agent
            ? nextObjective.reasoning_effort
            : (deliveredObjective?.reasoning_effort ?? null),
          launchFlags: {
            preCommand: resolvedLaunch.config.preCommand,
            flags: resolvedLaunch.config.flags
          },
          executionTargetId,
          requestedSource: 'auto_advance',
          metadata: { launchConfigSource: resolvedLaunch.source },
          idempotencyKey: `auto_advance:${nextObjective.id}`
        });
      } catch (error) {
        await ctx.db.run(
          `INSERT INTO mission_events
               (id, workspace_id, project_id, mission_id, objective_id,
                type, phase, summary, payload_json, source, actor_workspace_user_id, created_at)
             VALUES (?, ?, ?, ?, ?, 'alert', 'review', ?, ?, ?, ?, ?)`,
          [
            eventId,
            ctx.workspace.id,
            mission.projectId,
            mission.id,
            nextObjective.id,
            `Auto-advance could not queue the next objective: ${
              error instanceof Error ? error.message : String(error)
            }`,
            JSON.stringify({ autoAdvanceFailed: true }),
            ctx.source,
            ctx.actorWorkspaceUserId,
            eventNow
          ]
        );
      }
    } else {
      await ctx.db.run(
        `INSERT INTO mission_events
             (id, workspace_id, project_id, mission_id, objective_id,
              type, phase, summary, payload_json, source, actor_workspace_user_id, created_at)
           VALUES (?, ?, ?, ?, ?, 'awaiting_approval', 'review', ?, '{}', ?, ?, ?)`,
        [
          eventId,
          ctx.workspace.id,
          mission.projectId,
          mission.id,
          nextObjective.id,
          `Next objective is waiting for approval: ${nextObjective.title}`,
          ctx.source,
          ctx.actorWorkspaceUserId,
          eventNow
        ]
      );
    }
  }

  return { deliveryId, eventId };
}

export async function protocolCreate({
  ctx,
  projectId,
  objectives,
  title
}: {
  ctx: ServiceContext;
  projectId?: string | null;
  objectives: Array<{ objective: string; title?: string | null; autoAdvance?: boolean }>;
  title?: string | null;
}): Promise<{ mission: MissionSummary; objectives: ObjectiveSummary[] }> {
  const resolvedProjectId = projectId
    ? await resolveProjectId(ctx, projectId)
    : (await discoverProject({ ctx })).projectId;
  return await createMissionWithObjectives({
    ctx,
    projectId: resolvedProjectId,
    objectives,
    ...(title !== undefined ? { title } : {})
  });
}

export async function protocolPrompt({
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
}): Promise<AttachResponse & { sessionKey: string }> {
  const discovery = projectId
    ? { projectId: await resolveProjectId(ctx, projectId) }
    : await discoverProject({ ctx });
  const created = await createMissionWithObjectives({
    ctx,
    projectId: discovery.projectId,
    objectives,
    ...(title !== undefined ? { title } : {})
  });

  const submitted = await ctx.db.run(
    `UPDATE objectives SET state = 'launching', updated_at = ?, revision = revision + 1
       WHERE id = ?`,
    [nowIso(), created.objectives[0]?.id]
  );

  void submitted;

  return await attachSession({
    ctx,
    missionId: created.mission.id,
    agentIdentifier,
    connectionMethod: 'prompt',
    externalSessionId: externalSessionId ?? null
  });
}

export async function recordWork({
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
}): Promise<{ mission: MissionSummary; deliveryId: string }> {
  const trimmedSummary = summary.trim();
  if (!trimmedSummary) {
    throw new ServiceError('Summary is required for record-work', 'validation_error');
  }

  const resolvedProjectId = projectId
    ? await resolveProjectId(ctx, projectId)
    : (await discoverProject({ ctx })).projectId;

  const created = await createMissionWithObjectives({
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

  await ctx.db.transaction(async tx => {
    const txCtx = { ...ctx, db: tx };
    await txCtx.db.run(
      `INSERT INTO deliveries
           (id, workspace_id, project_id, mission_id, objective_id, session_id,
            summary, payload_json, delivered_at, delivered_by_workspace_user_id,
            created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, NULL, ?, '{}', ?, ?, ?, ?, 1)`,
      [
        deliveryId,
        ctx.workspace.id,
        resolvedProjectId,
        created.mission.id,
        objectiveId,
        trimmedSummary,
        now,
        ctx.actorWorkspaceUserId,
        now,
        now
      ]
    );

    for (const artifact of artifacts) {
      await txCtx.db.run(
        `INSERT INTO artifacts
             (id, workspace_id, project_id, mission_id, objective_id, delivery_id,
              type, label, content_text, external_url, created_at, updated_at, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          newId(),
          ctx.workspace.id,
          resolvedProjectId,
          created.mission.id,
          objectiveId,
          deliveryId,
          artifact.type,
          artifact.label,
          artifact.content ?? null,
          artifact.url ?? null,
          now,
          now
        ]
      );
    }

    for (const rationale of normalizeChangeRationales(changeRationales)) {
      await txCtx.db.run(
        `INSERT INTO change_rationales
             (id, workspace_id, project_id, mission_id, objective_id, delivery_id,
              file_path, label, summary, why, impact, hunks_json, is_final, created_at, updated_at, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          newId(),
          ctx.workspace.id,
          resolvedProjectId,
          created.mission.id,
          objectiveId,
          deliveryId,
          rationale.filePath,
          rationale.label,
          rationale.summary,
          rationale.why,
          rationale.impact,
          JSON.stringify(rationale.hunks ?? []),
          bindBool(txCtx.db.dialect, true),
          now,
          now
        ]
      );
    }

    await txCtx.db.run(
      `INSERT INTO mission_events
           (id, workspace_id, project_id, mission_id, objective_id,
            type, phase, summary, payload_json, source, actor_workspace_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, 'delivery', 'deliver', ?, ?, ?, ?, ?)`,
      [
        newId(),
        ctx.workspace.id,
        resolvedProjectId,
        created.mission.id,
        objectiveId,
        trimmedSummary,
        JSON.stringify({ deliveryId, recordWork: true }),
        ctx.source,
        ctx.actorWorkspaceUserId,
        now
      ]
    );
  });
  return { mission: created.mission, deliveryId };
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
  addObjectivesToMission,
  createMissionWithObjectives,
  discussObjective,
  listSharedContext,
  searchMissions,
  writeSharedContext
} from './missions.js';
