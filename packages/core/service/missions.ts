import { OBJECTIVE_STATES } from '@overlord/database';

import { recordChange } from './change-feed.js';
import type { ServiceContext } from './context.js';
import { resolveMissionId, resolveProjectId } from './context.js';
import { ServiceError } from './errors.js';
import { initialTitleFromInstruction, newId, nowIso } from './util.js';

export type ObjectiveSummary = {
  id: string;
  missionId: string;
  projectId: string;
  position: number;
  title: string | null;
  objective: string;
  state: string;
  autoAdvance: boolean;
};

export type MissionSummary = {
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

export type MissionEventSummary = {
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

async function nextMissionSequence(ctx: ServiceContext): Promise<number> {
  const row = (await ctx.db.get(
    `SELECT id, next_value FROM mission_sequences
       WHERE workspace_id = ? AND scope_type = 'workspace' AND counter_name = 'mission'`,
    [ctx.workspace.id]
  )) as { id: string; next_value: number } | undefined;

  if (!row) {
    throw new ServiceError('Mission sequence not initialized', 'internal_error', 500);
  }

  const seq = row.next_value;
  await ctx.db.run(`UPDATE mission_sequences SET next_value = ?, updated_at = ? WHERE id = ?`, [
    seq + 1,
    nowIso(),
    row.id
  ]);
  return seq;
}

async function getDefaultStatusId(ctx: ServiceContext): Promise<{
  id: string;
  type: string;
}> {
  const row = (await ctx.db.get(
    `SELECT id, type FROM workspace_statuses
       WHERE workspace_id = ? AND is_default = 1 AND deleted_at IS NULL LIMIT 1`,
    [ctx.workspace.id]
  )) as { id: string; type: string } | undefined;

  if (!row) {
    throw new ServiceError('Workspace has no default status', 'validation_error', 409);
  }
  return row;
}

async function getReviewStatusId(ctx: ServiceContext): Promise<{
  id: string;
  type: string;
}> {
  const row = (await ctx.db.get(
    `SELECT id, type FROM workspace_statuses
       WHERE workspace_id = ? AND type = 'review' AND deleted_at IS NULL LIMIT 1`,
    [ctx.workspace.id]
  )) as { id: string; type: string } | undefined;

  if (!row) {
    throw new ServiceError('Workspace has no review status', 'validation_error', 409);
  }
  return row;
}

async function getExecuteStatusId(ctx: ServiceContext): Promise<{
  id: string;
  type: string;
}> {
  const row = (await ctx.db.get(
    `SELECT id, type FROM workspace_statuses
       WHERE workspace_id = ? AND type = 'execute' AND deleted_at IS NULL LIMIT 1`,
    [ctx.workspace.id]
  )) as { id: string; type: string } | undefined;

  if (!row) {
    throw new ServiceError('Workspace has no execute status', 'validation_error', 409);
  }
  return row;
}

async function topBoardPosition(
  ctx: ServiceContext,
  projectId: string,
  statusId: string
): Promise<number> {
  const row = (await ctx.db.get(
    `SELECT MIN(board_position) AS min_pos FROM missions
       WHERE project_id = ? AND status_id = ? AND deleted_at IS NULL`,
    [projectId, statusId]
  )) as { min_pos: number | null };
  const minPos = row.min_pos;
  return minPos === null ? 100 : minPos - 100;
}

export async function listObjectives({
  ctx,
  missionId
}: {
  ctx: ServiceContext;
  missionId: string;
}): Promise<ObjectiveSummary[]> {
  const resolved = await resolveMissionId(ctx, missionId);
  const rows = (await ctx.db.all(
    `SELECT id, mission_id, project_id, position, title, instruction_text, state, auto_advance
       FROM objectives WHERE mission_id = ? AND deleted_at IS NULL ORDER BY position ASC`,
    [resolved.id]
  )) as Array<{
    id: string;
    mission_id: string;
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
  mission_id: string;
  project_id: string;
  position: number;
  title: string | null;
  instruction_text: string;
  state: string;
  auto_advance: number;
}): ObjectiveSummary {
  return {
    id: row.id,
    missionId: row.mission_id,
    projectId: row.project_id,
    position: row.position,
    title: row.title,
    objective: row.instruction_text,
    state: row.state,
    autoAdvance: row.auto_advance === 1
  };
}

/**
 * The project's last-used launch selection, stored by the webapp on
 * `project_user_preferences.preferences_json.launchPreference`. New draft slots
 * inherit it so the agent recorded on the objective (and the launch button that
 * reads it) matches what the user last chose, rather than leaving the agent unset
 * and letting execution fall back to a hardcoded default.
 */
async function readProjectLaunchSelection(
  ctx: ServiceContext,
  projectId: string
): Promise<{ agent: string | null; model: string | null; reasoningEffort: string | null }> {
  const empty = { agent: null, model: null, reasoningEffort: null };
  if (!ctx.actorWorkspaceUserId) return empty;
  const row = (await ctx.db.get(
    `SELECT preferences_json FROM project_user_preferences
        WHERE workspace_id = ? AND project_id = ? AND workspace_user_id = ? AND deleted_at IS NULL`,
    [ctx.workspace.id, projectId, ctx.actorWorkspaceUserId]
  )) as { preferences_json: string } | undefined;
  if (!row) return empty;
  try {
    const prefs = JSON.parse(row.preferences_json) as {
      launchPreference?: {
        selectedAgent?: string | null;
        selectedModel?: string | null;
        selectedReasoningEffort?: string | null;
      };
    };
    const launch = prefs.launchPreference ?? {};
    return {
      agent: launch.selectedAgent ?? null,
      model: launch.selectedModel ?? null,
      reasoningEffort: launch.selectedReasoningEffort ?? null
    };
  } catch {
    return empty;
  }
}

export async function insertObjective({
  ctx,
  missionId,
  instructionText,
  title,
  state,
  autoAdvance = false,
  assignedAgent
}: {
  ctx: ServiceContext;
  missionId: string;
  instructionText: string;
  title?: string | null;
  state?: string;
  autoAdvance?: boolean;
  assignedAgent?: string | null;
}): Promise<ObjectiveSummary> {
  const instruction = instructionText.trim();

  const mission = await resolveMissionId(ctx, missionId);
  const requestedState = state ?? 'draft';
  if (!OBJECTIVE_STATES.includes(requestedState as (typeof OBJECTIVE_STATES)[number])) {
    throw new ServiceError(`Invalid objective state: ${requestedState}`, 'validation_error');
  }

  const draftRow = (await ctx.db.get(
    `SELECT id FROM objectives
       WHERE mission_id = ? AND state = 'draft' AND deleted_at IS NULL
       LIMIT 1`,
    [mission.id]
  )) as { id: string } | undefined;
  const resolvedState = requestedState === 'draft' && draftRow ? 'future' : requestedState;
  const allowsBlankInstruction = resolvedState === 'draft' || resolvedState === 'future';
  if (!instruction && !allowsBlankInstruction) {
    throw new ServiceError('Objective instruction is required', 'validation_error');
  }

  const maxRow = (await ctx.db.get(
    `SELECT MAX(position) AS max_pos FROM objectives WHERE mission_id = ? AND deleted_at IS NULL`,
    [mission.id]
  )) as { max_pos: number | null };
  const position = (maxRow.max_pos ?? -1) + 1;
  const now = nowIso();
  const id = newId();
  const resolvedTitle =
    title?.trim() || (instruction ? initialTitleFromInstruction(instruction) : 'New objective');
  // Editable slots (draft/future) default to the project's last-used selection so
  // the agent is always recorded in the db; an explicit agent passed by the caller
  // still wins. Executed/complete states are created with whatever the caller set.
  const explicitAgent = assignedAgent?.trim() || null;
  const launchSelection =
    !explicitAgent && (resolvedState === 'draft' || resolvedState === 'future')
      ? await readProjectLaunchSelection(ctx, mission.projectId)
      : { agent: null, model: null, reasoningEffort: null };
  const resolvedAssignedAgent = explicitAgent ?? launchSelection.agent;
  const resolvedModel = explicitAgent ? null : launchSelection.model;
  const resolvedReasoningEffort = explicitAgent ? null : launchSelection.reasoningEffort;

  await ctx.db.run(
    `INSERT INTO objectives
         (id, workspace_id, project_id, mission_id, position, title, instruction_text, state,
          assigned_agent, model, reasoning_effort, agent_flags_json, auto_advance,
          execution_metadata_json, created_by_workspace_user_id, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, '{}', ?, ?, ?, 1)`,
    [
      id,
      ctx.workspace.id,
      mission.projectId,
      mission.id,
      position,
      resolvedTitle,
      instruction,
      resolvedState,
      resolvedAssignedAgent,
      resolvedModel,
      resolvedReasoningEffort,
      autoAdvance ? 1 : 0,
      ctx.actorWorkspaceUserId,
      now,
      now
    ]
  );

  await recordChange({
    ctx,
    entityType: 'objective',
    entityId: id,
    operation: 'insert',
    entityRevision: 1,
    projectId: mission.projectId,
    missionId: mission.id,
    objectiveId: id
  });

  return toObjectiveSummary({
    id,
    mission_id: mission.id,
    project_id: mission.projectId,
    position,
    title: resolvedTitle,
    instruction_text: instruction,
    state: resolvedState,
    auto_advance: autoAdvance ? 1 : 0
  });
}

export async function ensureNextDraftObjective({
  ctx,
  missionId,
  projectId,
  assignedAgent,
  now
}: {
  ctx: ServiceContext;
  missionId: string;
  projectId: string;
  assignedAgent: string | null;
  now: string;
}): Promise<void> {
  const drafts = (await ctx.db.all(
    `SELECT id, instruction_text, revision FROM objectives
       WHERE mission_id = ? AND state = 'draft' AND deleted_at IS NULL
       ORDER BY position ASC, created_at ASC`,
    [missionId]
  )) as Array<{ id: string; instruction_text: string; revision: number }>;

  if (drafts.some(draft => draft.instruction_text.trim())) return;

  const nextFuture = (await ctx.db.get(
    `SELECT id, revision FROM objectives
       WHERE mission_id = ? AND state = 'future' AND deleted_at IS NULL
       ORDER BY position ASC, created_at ASC LIMIT 1`,
    [missionId]
  )) as { id: string; revision: number } | undefined;

  if (nextFuture) {
    for (const draft of drafts) {
      const revision = draft.revision + 1;
      await ctx.db.run(
        `UPDATE objectives SET deleted_at = ?, updated_at = ?, revision = ?
           WHERE id = ? AND mission_id = ?`,
        [now, now, revision, draft.id, missionId]
      );
      await recordChange({
        ctx,
        entityType: 'objective',
        entityId: draft.id,
        operation: 'delete',
        entityRevision: revision,
        projectId,
        missionId,
        objectiveId: draft.id
      });
    }

    const revision = nextFuture.revision + 1;
    await ctx.db.run(
      `UPDATE objectives SET state = 'draft', updated_at = ?, revision = ?
         WHERE id = ? AND mission_id = ?`,
      [now, revision, nextFuture.id, missionId]
    );

    await recordChange({
      ctx,
      entityType: 'objective',
      entityId: nextFuture.id,
      operation: 'update',
      entityRevision: revision,
      projectId,
      missionId,
      objectiveId: nextFuture.id,
      changedFields: ['state']
    });
    return;
  }

  if (drafts.length === 0) {
    await insertObjective({
      ctx,
      missionId,
      instructionText: '',
      state: 'draft',
      assignedAgent
    });
  }
}

export async function createMissionWithObjectives({
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
}): Promise<{ mission: MissionSummary; objectives: ObjectiveSummary[] }> {
  if (objectives.length === 0) {
    throw new ServiceError('At least one objective is required', 'validation_error');
  }

  const resolvedProjectId = await resolveProjectId(ctx, projectId);
  const firstInstruction = objectives[0]?.objective.trim() ?? '';
  if (!firstInstruction) {
    throw new ServiceError('First objective instruction is required', 'validation_error');
  }

  const missionTitle = title?.trim() || initialTitleFromInstruction(firstInstruction);
  const status =
    statusType === 'review' ? await getReviewStatusId(ctx) : await getDefaultStatusId(ctx);

  const now = nowIso();
  const missionId = newId();
  const sequence = await nextMissionSequence(ctx);
  const displayId = `${ctx.workspace.slug}:${sequence}`;

  const createdObjectives: ObjectiveSummary[] = [];

  await ctx.db.transaction(async tx => {
    const txCtx = { ...ctx, db: tx };
    await txCtx.db.run(
      `INSERT INTO missions
           (id, workspace_id, project_id, display_id, sequence_number, title,
            status_id, status_type, board_position, priority, available_tools_json,
            execution_target_intent_json, metadata_json, created_by_workspace_user_id,
            created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'normal', '[]', '{}', '{}', ?, ?, ?, 1)`,
      [
        missionId,
        ctx.workspace.id,
        resolvedProjectId,
        displayId,
        sequence,
        missionTitle,
        status.id,
        status.type,
        await topBoardPosition(txCtx, resolvedProjectId, status.id),
        ctx.actorWorkspaceUserId,
        now,
        now
      ]
    );

    await recordChange({
      ctx: txCtx,
      entityType: 'mission',
      entityId: missionId,
      operation: 'insert',
      entityRevision: 1,
      projectId: resolvedProjectId,
      missionId
    });

    for (let index = 0; index < objectives.length; index++) {
      const item = objectives[index]!;
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
        await insertObjective({
          ctx: txCtx,
          missionId,
          instructionText: instruction,
          ...(item.title !== undefined ? { title: item.title } : {}),
          state: objectiveState,
          autoAdvance: item.autoAdvance ?? false
        })
      );
    }
  });

  return {
    mission: await getMissionSummary({ ctx, missionId }),
    objectives: createdObjectives
  };
}

export async function getMissionSummary({
  ctx,
  missionId
}: {
  ctx: ServiceContext;
  missionId: string;
}): Promise<MissionSummary> {
  const resolved = await resolveMissionId(ctx, missionId);
  const row = (await ctx.db.get(
    `SELECT t.id, t.display_id, t.project_id, t.title, t.status_type, t.status_id,
              t.priority, t.created_at, t.updated_at,
              (SELECT COUNT(*) FROM objectives o WHERE o.mission_id = t.id AND o.deleted_at IS NULL) AS objective_count
       FROM missions t
       WHERE t.id = ? AND t.workspace_id = ? AND t.deleted_at IS NULL`,
    [resolved.id, ctx.workspace.id]
  )) as {
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
    throw new ServiceError('Mission not found', 'mission_not_found', 404);
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

export async function listMissions({
  ctx,
  projectId,
  statusTypes,
  limit = 50
}: {
  ctx: ServiceContext;
  projectId?: string | null;
  statusTypes?: string[] | null;
  limit?: number;
}): Promise<MissionSummary[]> {
  const params: Array<string | number> = [ctx.workspace.id];
  let sql = `SELECT t.id, t.display_id, t.project_id, t.title, t.status_type, t.status_id,
                    t.priority, t.created_at, t.updated_at,
                    (SELECT COUNT(*) FROM objectives o WHERE o.mission_id = t.id AND o.deleted_at IS NULL) AS objective_count
             FROM missions t
             WHERE t.workspace_id = ? AND t.deleted_at IS NULL`;

  if (projectId) {
    sql += ' AND t.project_id = ?';
    params.push(await resolveProjectId(ctx, projectId));
  }

  if (statusTypes && statusTypes.length > 0) {
    const placeholders = statusTypes.map(() => '?').join(', ');
    sql += ` AND t.status_type IN (${placeholders})`;
    params.push(...statusTypes);
  }

  sql += ' ORDER BY t.updated_at DESC LIMIT ?';
  params.push(limit);

  const rows = (await ctx.db.all(sql, params)) as Array<{
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

/**
 * Build an FTS5 MATCH expression from free-form user input.
 *
 * Each run of letters/digits becomes a lowercase prefix token (`term*`) so
 * partial words match, and tokens are OR-combined for recall — a mission surfaces
 * when any of its indexed documents (title, objective, or event) contains any
 * term, and ranking decides ordering. Lowercasing also neutralises the
 * uppercase-only FTS5 boolean keywords (`AND`/`OR`/`NOT`), and stripping to
 * alphanumeric runs keeps the expression injection-safe.
 */
function buildFtsMatch(query: string): string | null {
  const terms = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (terms.length === 0) return null;
  return terms.map(term => `${term}*`).join(' OR ');
}

export async function searchMissions({
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
}): Promise<MissionSummary[]> {
  const trimmed = query?.trim();
  const match = trimmed ? buildFtsMatch(trimmed) : null;

  // No usable search terms → fall back to a recency-ordered browse of the same
  // filtered set rather than running an empty full-text query.
  if (!match) {
    return await listMissions({
      ctx,
      projectId: projectId ?? null,
      statusTypes: statusTypes ?? null,
      limit
    });
  }

  // Score every matching source document, then aggregate per mission below.
  // Per-document relevance weights the title column above the body (bm25 column
  // weights) and the source kind by importance (mission title > objective >
  // event). bm25() returns smaller values for better matches, so we negate it to
  // accumulate a higher-is-better score. The score is computed in a single
  // full-text query without GROUP BY or a join back to `search_documents`,
  // because either would move bm25() out of the context FTS5 allows it in.
  const params: Array<string | number> = [ctx.workspace.id, match];
  let sql = `SELECT t.id, t.display_id, t.project_id, t.title, t.status_type, t.status_id,
                    t.priority, t.created_at, t.updated_at,
                    (SELECT COUNT(*) FROM objectives o WHERE o.mission_id = t.id AND o.deleted_at IS NULL) AS objective_count,
                    (CASE search_documents_fts.entity_type
                       WHEN 'mission' THEN 3.0 WHEN 'objective' THEN 2.0 ELSE 1.0 END)
                      * (-bm25(search_documents_fts, 10.0, 1.0)) AS doc_score
             FROM search_documents_fts
             JOIN missions t ON t.id = search_documents_fts.mission_id
               AND t.workspace_id = ? AND t.deleted_at IS NULL
             WHERE search_documents_fts MATCH ?`;

  if (projectId) {
    sql += ' AND t.project_id = ?';
    params.push(await resolveProjectId(ctx, projectId));
  }

  if (statusTypes && statusTypes.length > 0) {
    const placeholders = statusTypes.map(() => '?').join(', ');
    sql += ` AND t.status_type IN (${placeholders})`;
    params.push(...statusTypes);
  }

  const rows = (await ctx.db.all(sql, params)) as Array<{
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
    doc_score: number;
  }>;

  // Aggregate per-document scores into one relevance per mission.
  const byMission = new Map<string, { mission: MissionSummary; relevance: number }>();
  for (const row of rows) {
    const existing = byMission.get(row.id);
    if (existing) {
      existing.relevance += row.doc_score;
      continue;
    }
    byMission.set(row.id, {
      relevance: row.doc_score,
      mission: {
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
      }
    });
  }

  return [...byMission.values()]
    .sort(
      (left, right) =>
        right.relevance - left.relevance ||
        right.mission.updatedAt.localeCompare(left.mission.updatedAt)
    )
    .slice(0, limit)
    .map(entry => entry.mission);
}

export async function addObjectivesToMission({
  ctx,
  missionId,
  objectives
}: {
  ctx: ServiceContext;
  missionId: string;
  objectives: Array<{ objective: string; title?: string | null }>;
}): Promise<ObjectiveSummary[]> {
  if (objectives.length === 0) {
    throw new ServiceError('At least one objective is required', 'validation_error');
  }

  const resolved = await resolveMissionId(ctx, missionId);
  const created: ObjectiveSummary[] = [];

  await ctx.db.transaction(async tx => {
    const txCtx = { ...ctx, db: tx };
    for (const item of objectives) {
      created.push(
        await insertObjective({
          ctx: txCtx,
          missionId: resolved.id,
          instructionText: item.objective,
          ...(item.title !== undefined ? { title: item.title } : {}),
          state: 'draft'
        })
      );
    }
  });
  return created;
}

export async function discussObjective({
  ctx,
  missionId
}: {
  ctx: ServiceContext;
  missionId: string;
}): Promise<ObjectiveSummary> {
  const objectives = await listObjectives({ ctx, missionId });
  const draft = objectives.find(o => o.state === 'draft');
  if (!draft) {
    throw new ServiceError('No draft objective found on mission', 'validation_error');
  }

  const now = nowIso();
  await ctx.db.run(
    `UPDATE objectives SET state = 'launching', updated_at = ?, revision = revision + 1
       WHERE id = ? AND mission_id = ?`,
    [now, draft.id, draft.missionId]
  );

  await recordChange({
    ctx,
    entityType: 'objective',
    entityId: draft.id,
    operation: 'update',
    projectId: draft.projectId,
    missionId: draft.missionId,
    objectiveId: draft.id,
    changedFields: ['state']
  });

  return { ...draft, state: 'launching' };
}

export async function listMissionEvents({
  ctx,
  missionId,
  limit = 100
}: {
  ctx: ServiceContext;
  missionId: string;
  limit?: number;
}): Promise<MissionEventSummary[]> {
  const resolved = await resolveMissionId(ctx, missionId);
  const rows = (await ctx.db.all(
    `SELECT id, type, phase, summary, created_at, objective_id
       FROM mission_events WHERE mission_id = ? ORDER BY created_at ASC LIMIT ?`,
    [resolved.id, limit]
  )) as Array<{
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

export async function listSharedContext({
  ctx,
  missionId,
  keySubstring,
  limit = 50
}: {
  ctx: ServiceContext;
  missionId: string;
  keySubstring?: string | null;
  limit?: number;
}): Promise<SharedContextEntry[]> {
  const resolved = await resolveMissionId(ctx, missionId);
  const params: Array<string | number> = [resolved.id];
  let sql = `SELECT key, value_kind, value_text, value_json, updated_at
             FROM shared_context_entries
             WHERE mission_id = ? AND deleted_at IS NULL`;

  if (keySubstring?.trim()) {
    sql += ' AND key LIKE ?';
    params.push(`%${keySubstring.trim()}%`);
  }

  sql += ' ORDER BY updated_at DESC LIMIT ?';
  params.push(limit);

  const rows = (await ctx.db.all(sql, params)) as Array<{
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

export async function writeSharedContext({
  ctx,
  missionId,
  key,
  value
}: {
  ctx: ServiceContext;
  missionId: string;
  key: string;
  value: unknown;
  tags?: string[];
}): Promise<SharedContextEntry> {
  const trimmedKey = key.trim();
  if (!trimmedKey) {
    throw new ServiceError('Shared context key is required', 'validation_error');
  }

  const resolved = await resolveMissionId(ctx, missionId);
  const now = nowIso();
  const existing = (await ctx.db.get(
    `SELECT id FROM shared_context_entries
       WHERE mission_id = ? AND key = ? AND deleted_at IS NULL`,
    [resolved.id, trimmedKey]
  )) as { id: string } | undefined;

  const isJson = typeof value === 'object' && value !== null;
  const valueKind = isJson ? 'json' : 'string';
  const valueText = isJson ? null : String(value);
  const valueJson = isJson ? JSON.stringify(value) : null;

  if (existing) {
    await ctx.db.run(
      `UPDATE shared_context_entries
         SET value_kind = ?, value_text = ?, value_json = ?, updated_at = ?, revision = revision + 1
         WHERE id = ?`,
      [valueKind, valueText, valueJson, now, existing.id]
    );
  } else {
    await ctx.db.run(
      `INSERT INTO shared_context_entries
           (id, workspace_id, mission_id, key, value_kind, value_text, value_json,
            created_by_workspace_user_id, created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
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
      ]
    );
  }

  return { key: trimmedKey, value, tags: [], updatedAt: now };
}

export async function listArtifacts({
  ctx,
  missionId
}: {
  ctx: ServiceContext;
  missionId: string;
}): Promise<ArtifactSummary[]> {
  const resolved = await resolveMissionId(ctx, missionId);
  const rows = (await ctx.db.all(
    `SELECT id, type, label, content_text, external_url
       FROM artifacts WHERE mission_id = ? AND deleted_at IS NULL ORDER BY created_at ASC`,
    [resolved.id]
  )) as Array<{
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

export async function listAttachments({
  ctx,
  missionId,
  objectiveId
}: {
  ctx: ServiceContext;
  missionId: string;
  objectiveId?: string | null;
}): Promise<AttachmentSummary[]> {
  const resolved = await resolveMissionId(ctx, missionId);
  const params: string[] = [resolved.id];
  let sql = `SELECT id, filename, content_type, size_bytes, upload_status
             FROM objective_attachments
             WHERE mission_id = ? AND deleted_at IS NULL`;

  if (objectiveId) {
    sql += ' AND objective_id = ?';
    params.push(objectiveId);
  }

  sql += ' ORDER BY created_at ASC';
  const rows = (await ctx.db.all(sql, params)) as Array<{
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

export async function moveMissionToReview({
  ctx,
  missionId
}: {
  ctx: ServiceContext;
  missionId: string;
}): Promise<void> {
  const mission = await getMissionSummary({ ctx, missionId });
  const reviewStatus = await getReviewStatusId(ctx);
  const now = nowIso();
  const boardPosition = await topBoardPosition(ctx, mission.projectId, reviewStatus.id);

  await ctx.db.run(
    `UPDATE missions SET status_id = ?, status_type = ?, board_position = ?, updated_at = ?, revision = revision + 1
       WHERE id = ?`,
    [reviewStatus.id, reviewStatus.type, boardPosition, now, mission.id]
  );

  await recordChange({
    ctx,
    entityType: 'mission',
    entityId: mission.id,
    operation: 'update',
    projectId: mission.projectId,
    missionId: mission.id,
    changedFields: ['status_id', 'status_type', 'board_position']
  });
}

export async function moveMissionToExecute({
  ctx,
  missionId
}: {
  ctx: ServiceContext;
  missionId: string;
}): Promise<void> {
  const mission = await getMissionSummary({ ctx, missionId });
  const executeStatus = await getExecuteStatusId(ctx);
  if (mission.statusId === executeStatus.id && mission.statusType === executeStatus.type) {
    return;
  }

  const now = nowIso();
  const boardPosition = await topBoardPosition(ctx, mission.projectId, executeStatus.id);

  await ctx.db.run(
    `UPDATE missions
       SET status_id = ?, status_type = ?, board_position = ?, updated_at = ?, revision = revision + 1
       WHERE id = ?`,
    [executeStatus.id, executeStatus.type, boardPosition, now, mission.id]
  );

  await recordChange({
    ctx,
    entityType: 'mission',
    entityId: mission.id,
    operation: 'update',
    projectId: mission.projectId,
    missionId: mission.id,
    changedFields: ['status_id', 'status_type', 'board_position']
  });
}

export { getDefaultStatusId, getExecuteStatusId, getReviewStatusId };
