import { createHash, randomBytes } from 'node:crypto';

import { readRepositoryTree, RepositoryReadError } from '../../src/repository/git-tree.ts';
import type {
  ArtifactDto,
  CreateObjectiveBody,
  CreateProjectBody,
  CreateTicketBody,
  CreateUserTokenBody,
  CreateUserTokenResultDto,
  FileChangeDto,
  ObjectiveDto,
  ProfileDto,
  ProjectDto,
  ProjectRepositoryDto,
  ProjectResourceDto,
  ProjectStatusDto,
  ReorderBoardColumnBody,
  ReorderFutureObjectivesBody,
  StatusType,
  TicketDetailDto,
  TicketDto,
  TicketEventDto,
  UpdateObjectiveBody,
  UpdateProfileBody,
  UpdateProjectBody,
  UpdateTicketBody,
  UpdateUserTokenBody,
  UserTokenDto
} from '../shared/contract.ts';

import { ACTOR_WORKSPACE_USER_ID, db, newId, nowIso, recordChange, WORKSPACE } from './db.ts';
import { ApiError } from './errors.ts';
import { listTicketExecutionRequests } from './launch.ts';
import {
  initialTitleFromInstruction,
  scheduleObjectiveTitleGeneration,
  scheduleTicketTitleGeneration
} from './title-automation.ts';

export { ApiError } from './errors.ts';

// The default workflow seeded for every new project. The schema enforces (via
// partial unique indexes) at most one default, one `execute`, and one `review`
// status per project, so this set is intentionally one of each.
const DEFAULT_STATUSES: Array<{
  key: string;
  name: string;
  type: StatusType;
  position: number;
  isDefault: boolean;
  isTerminal: boolean;
}> = [
  {
    key: 'backlog',
    name: 'Backlog',
    type: 'draft',
    position: 0,
    isDefault: true,
    isTerminal: false
  },
  {
    key: 'in_progress',
    name: 'In Progress',
    type: 'execute',
    position: 1,
    isDefault: false,
    isTerminal: false
  },
  {
    key: 'in_review',
    name: 'In Review',
    type: 'review',
    position: 2,
    isDefault: false,
    isTerminal: false
  },
  { key: 'done', name: 'Done', type: 'complete', position: 3, isDefault: false, isTerminal: true }
];

// ---- row shapes ----------------------------------------------------------

interface ProjectRow {
  id: string;
  workspace_id: string;
  slug: string;
  name: string;
  description: string | null;
  settings_json: string;
  status: string;
  created_at: string;
  updated_at: string;
  revision: number;
  ticket_count: number;
}

const PROJECT_COLOR_SETTINGS_KEY = 'overlord.color';

function readProjectColor(settingsJson: string): string | null {
  try {
    const parsed = JSON.parse(settingsJson) as Record<string, unknown>;
    const color = parsed[PROJECT_COLOR_SETTINGS_KEY];
    return typeof color === 'string' ? color : null;
  } catch {
    return null;
  }
}

function buildProjectSettingsJson({ color }: { color?: string }): string {
  if (!color) return '{}';
  return JSON.stringify({ [PROJECT_COLOR_SETTINGS_KEY]: color });
}

function mergeProjectSettingsJson(
  existingJson: string,
  updates: { color?: string | null }
): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(existingJson) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  if (updates.color !== undefined) {
    if (updates.color) {
      parsed[PROJECT_COLOR_SETTINGS_KEY] = updates.color;
    } else {
      delete parsed[PROJECT_COLOR_SETTINGS_KEY];
    }
  }
  return JSON.stringify(parsed);
}

interface ProjectStatusRow {
  id: string;
  project_id: string;
  key: string;
  name: string;
  type: string;
  position: number;
  is_default: number;
  is_terminal: number;
}

interface ProjectResourceRow {
  id: string;
  workspace_id: string;
  project_id: string;
  execution_target_id: string | null;
  type: string;
  label: string | null;
  path: string;
  is_primary: number;
  status: string;
  created_at: string;
  updated_at: string;
  revision: number;
}

interface TicketRow {
  id: string;
  workspace_id: string;
  project_id: string;
  display_id: string;
  sequence_number: number;
  title: string;
  status_id: string;
  status_type: string;
  board_position: number;
  priority: string | null;
  assigned_workspace_user_id: string | null;
  acceptance_criteria_text: string | null;
  available_tools_json: string;
  created_at: string;
  updated_at: string;
  revision: number;
  objective_count: number;
}

interface ObjectiveRow {
  id: string;
  workspace_id: string;
  project_id: string;
  ticket_id: string;
  position: number;
  title: string | null;
  instruction_text: string;
  state: string;
  auto_advance: number;
  assigned_agent: string | null;
  model: string | null;
  reasoning_effort: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
}

// ---- serializers ---------------------------------------------------------

function toProjectDto(r: ProjectRow): ProjectDto {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    color: readProjectColor(r.settings_json),
    status: r.status as ProjectDto['status'],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    revision: r.revision,
    ticketCount: r.ticket_count
  };
}

function toStatusDto(r: ProjectStatusRow): ProjectStatusDto {
  return {
    id: r.id,
    projectId: r.project_id,
    key: r.key,
    name: r.name,
    type: r.type as StatusType,
    position: r.position,
    isDefault: r.is_default === 1,
    isTerminal: r.is_terminal === 1
  };
}

function toProjectResourceDto(r: ProjectResourceRow): ProjectResourceDto {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    projectId: r.project_id,
    executionTargetId: r.execution_target_id,
    type: r.type as ProjectResourceDto['type'],
    label: r.label,
    path: r.path,
    isPrimary: r.is_primary === 1,
    status: r.status as ProjectResourceDto['status'],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    revision: r.revision
  };
}

function parseAvailableTools(json: string): string[] {
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr
      .map(item => (typeof item === 'string' ? item : ((item as { name?: string })?.name ?? '')))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function toTicketDto(r: TicketRow): TicketDto {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    projectId: r.project_id,
    displayId: r.display_id,
    sequenceNumber: r.sequence_number,
    title: r.title,
    statusId: r.status_id,
    statusType: r.status_type as StatusType,
    boardPosition: r.board_position,
    priority: r.priority as TicketDto['priority'],
    assignedWorkspaceUserId: r.assigned_workspace_user_id,
    acceptanceCriteria: r.acceptance_criteria_text,
    availableTools: parseAvailableTools(r.available_tools_json),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    revision: r.revision,
    objectiveCount: r.objective_count
  };
}

function toObjectiveDto(r: ObjectiveRow): ObjectiveDto {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    projectId: r.project_id,
    ticketId: r.ticket_id,
    position: r.position,
    title: r.title,
    instructionText: r.instruction_text,
    state: r.state as ObjectiveDto['state'],
    autoAdvance: r.auto_advance === 1,
    assignedAgent: r.assigned_agent,
    model: r.model,
    reasoningEffort: r.reasoning_effort,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    revision: r.revision
  };
}

function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base.length > 0 ? base : 'project';
}

// ---- Projects ------------------------------------------------------------

const selectProjectsSql = `
  SELECT p.*, (
    SELECT COUNT(*) FROM tickets t
      WHERE t.project_id = p.id AND t.deleted_at IS NULL
  ) AS ticket_count
  FROM projects p
  WHERE p.workspace_id = @workspace_id AND p.deleted_at IS NULL
`;

export function listProjects(): ProjectDto[] {
  const rows = db
    .prepare(`${selectProjectsSql} ORDER BY p.status ASC, p.created_at ASC`)
    .all({ workspace_id: WORKSPACE.id }) as ProjectRow[];
  return rows.map(toProjectDto);
}

export function getProject(id: string): ProjectDto {
  const row = db
    .prepare(`${selectProjectsSql} AND p.id = @id`)
    .get({ workspace_id: WORKSPACE.id, id }) as ProjectRow | undefined;
  if (!row) throw new ApiError(404, 'Project not found');
  return toProjectDto(row);
}

export function listProjectStatuses(projectId: string): ProjectStatusDto[] {
  const rows = db
    .prepare(
      `SELECT id, project_id, key, name, type, position, is_default, is_terminal
         FROM project_statuses
        WHERE project_id = ? AND deleted_at IS NULL
        ORDER BY position ASC`
    )
    .all(projectId) as ProjectStatusRow[];
  return rows.map(toStatusDto);
}

export function listProjectResources(projectId: string): ProjectResourceDto[] {
  getProject(projectId);

  const rows = db
    .prepare(
      `SELECT id, workspace_id, project_id, execution_target_id, type, label, path,
              is_primary, status, created_at, updated_at, revision
         FROM project_resources
        WHERE project_id = ? AND deleted_at IS NULL
        ORDER BY status ASC, is_primary DESC, label ASC, path ASC`
    )
    .all(projectId) as ProjectResourceRow[];
  return rows.map(toProjectResourceDto);
}

function getProjectRepositoryResource(
  projectId: string,
  executionTargetId: string | null
): ProjectResourceDto | null {
  const targetPredicate =
    executionTargetId === null
      ? ''
      : 'AND (execution_target_id = @execution_target_id OR execution_target_id IS NULL)';
  const row = db
    .prepare(
      `SELECT id, workspace_id, project_id, execution_target_id, type, label, path,
              is_primary, status, created_at, updated_at, revision
         FROM project_resources
        WHERE project_id = @project_id
          ${targetPredicate}
          AND status = 'active'
          AND deleted_at IS NULL
        ORDER BY
          CASE WHEN execution_target_id = @execution_target_id THEN 0 ELSE 1 END,
          is_primary DESC,
          created_at ASC
        LIMIT 1`
    )
    .get({ project_id: projectId, execution_target_id: executionTargetId }) as
    | ProjectResourceRow
    | undefined;
  return row ? toProjectResourceDto(row) : null;
}

export function getProjectRepository(
  projectId: string,
  executionTargetId: string | null
): ProjectRepositoryDto {
  getProject(projectId);

  const scannedAt = nowIso();
  const resource = getProjectRepositoryResource(projectId, executionTargetId);
  if (!resource) {
    return {
      projectId,
      executionTargetId,
      resource: null,
      status: 'no_resource',
      rootPath: null,
      gitRoot: null,
      branch: null,
      commit: null,
      entries: [],
      truncated: false,
      scannedAt,
      message: 'No active project resource is linked for this execution target.'
    };
  }

  if (resource.type !== 'local_directory') {
    return {
      projectId,
      executionTargetId,
      resource,
      status: 'unsupported_resource',
      rootPath: resource.path,
      gitRoot: null,
      branch: null,
      commit: null,
      entries: [],
      truncated: false,
      scannedAt,
      message: `Repository reading is not supported for ${resource.type} resources yet.`
    };
  }

  try {
    const tree = readRepositoryTree(resource.path);
    return {
      projectId,
      executionTargetId,
      resource,
      status: 'ready',
      rootPath: tree.rootPath,
      gitRoot: tree.gitRoot,
      branch: tree.branch,
      commit: tree.commit,
      entries: tree.entries,
      truncated: tree.truncated,
      scannedAt,
      message: null
    };
  } catch (error) {
    const status =
      error instanceof RepositoryReadError && error.code === 'not_git_repository'
        ? 'not_git_repository'
        : 'unreadable';
    return {
      projectId,
      executionTargetId,
      resource,
      status,
      rootPath: resource.path,
      gitRoot: null,
      branch: null,
      commit: null,
      entries: [],
      truncated: false,
      scannedAt,
      message: error instanceof Error ? error.message : 'Could not read repository.'
    };
  }
}

const hexColorPattern = /^#?[0-9a-fA-F]{6}$/;

function normalizeHexColor(value: string): string | null {
  const trimmed = value.trim();
  const withHash = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  return hexColorPattern.test(withHash) ? withHash.toLowerCase() : null;
}

export const createProject = db.transaction((body: CreateProjectBody): ProjectDto => {
  const name = (body.name ?? '').trim();
  if (!name) throw new ApiError(400, 'Project name is required');

  const color = body.color ? normalizeHexColor(body.color) : null;
  if (body.color && !color) {
    throw new ApiError(400, 'Use a valid 6-digit hex color, like #d4d4d8.');
  }

  const now = nowIso();
  const id = newId();
  const slug = body.slug?.trim() ? slugify(body.slug) : slugify(name);
  const settingsJson = buildProjectSettingsJson({ color: color ?? undefined });

  db.prepare(
    `INSERT INTO projects
       (id, workspace_id, slug, name, description, status, settings_json,
        created_by_workspace_user_id, created_at, updated_at, revision)
     VALUES (@id, @workspace_id, @slug, @name, @description, 'active', @settings_json,
        @actor, @now, @now, 1)`
  ).run({
    id,
    workspace_id: WORKSPACE.id,
    slug,
    name,
    description: body.description?.trim() || null,
    settings_json: settingsJson,
    actor: ACTOR_WORKSPACE_USER_ID,
    now
  });

  const insertStatus = db.prepare(
    `INSERT INTO project_statuses
       (id, workspace_id, project_id, key, name, type, position, is_default, is_terminal,
        created_at, updated_at, revision)
     VALUES (@id, @workspace_id, @project_id, @key, @name, @type, @position, @is_default, @is_terminal,
        @now, @now, 1)`
  );
  for (const s of DEFAULT_STATUSES) {
    insertStatus.run({
      id: newId(),
      workspace_id: WORKSPACE.id,
      project_id: id,
      key: s.key,
      name: s.name,
      type: s.type,
      position: s.position,
      is_default: s.isDefault ? 1 : 0,
      is_terminal: s.isTerminal ? 1 : 0,
      now
    });
  }

  recordChange({
    entityType: 'project',
    entityId: id,
    operation: 'insert',
    entityRevision: 1,
    projectId: id
  });
  return getProject(id);
});

export const updateProject = db.transaction((id: string, body: UpdateProjectBody): ProjectDto => {
  const existing = db
    .prepare(`SELECT * FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`)
    .get(id, WORKSPACE.id) as ProjectRow | undefined;
  if (!existing) throw new ApiError(404, 'Project not found');

  const fields: string[] = [];
  const params: Record<string, unknown> = { id, workspace_id: WORKSPACE.id };
  const changed: string[] = [];

  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) throw new ApiError(400, 'Project name cannot be empty');
    fields.push('name = @name');
    params.name = name;
    changed.push('name');
  }
  if (body.description !== undefined) {
    fields.push('description = @description');
    params.description = body.description?.trim() || null;
    changed.push('description');
  }
  if (body.status !== undefined) {
    if (body.status !== 'active' && body.status !== 'archived') {
      throw new ApiError(400, 'Invalid project status');
    }
    fields.push('status = @status');
    params.status = body.status;
    changed.push('status');
  }
  if (body.color !== undefined) {
    const color = body.color ? normalizeHexColor(body.color) : null;
    if (body.color && !color) {
      throw new ApiError(400, 'Use a valid 6-digit hex color, like #d4d4d8.');
    }
    fields.push('settings_json = @settings_json');
    params.settings_json = mergeProjectSettingsJson(existing.settings_json, { color });
    changed.push('settings_json');
  }
  if (fields.length === 0) return getProject(id);

  const now = nowIso();
  const revision = existing.revision + 1;
  db.prepare(
    `UPDATE projects SET ${fields.join(', ')}, updated_at = @now, revision = @revision
         WHERE id = @id AND workspace_id = @workspace_id`
  ).run({ ...params, now, revision });

  recordChange({
    entityType: 'project',
    entityId: id,
    operation: 'update',
    entityRevision: revision,
    projectId: id,
    changedFields: changed
  });
  return getProject(id);
});

// ---- Tickets -------------------------------------------------------------

const selectTicketsSql = `
  SELECT t.id, t.workspace_id, t.project_id, t.display_id, t.sequence_number, t.title,
         t.status_id, t.status_type, t.board_position, t.priority,
         t.assigned_workspace_user_id,
         t.acceptance_criteria_text, t.available_tools_json,
         t.created_at, t.updated_at, t.revision,
         (SELECT COUNT(*) FROM objectives o
            WHERE o.ticket_id = t.id AND o.deleted_at IS NULL) AS objective_count
  FROM tickets t
  WHERE t.workspace_id = @workspace_id AND t.deleted_at IS NULL
`;

export function listTickets(projectId: string): TicketDto[] {
  // Board order: ascending board_position within each column, with
  // sequence_number DESC as a stable tiebreaker (e.g. brand-new tickets that
  // share a position before the column is first reordered).
  const rows = db
    .prepare(
      `${selectTicketsSql} AND t.project_id = @project_id
         ORDER BY t.board_position ASC, t.sequence_number DESC`
    )
    .all({ workspace_id: WORKSPACE.id, project_id: projectId }) as TicketRow[];
  return rows.map(toTicketDto);
}

// New cards drop in at the top of their column. Gap-based: one step (100) above
// the current minimum so no renumber is needed until the column is reordered.
function topBoardPosition(projectId: string, statusId: string, excludeTicketId?: string): number {
  const row = db
    .prepare(
      `SELECT MIN(board_position) AS min_pos FROM tickets
         WHERE project_id = @project_id AND status_id = @status_id
           AND deleted_at IS NULL AND (@exclude IS NULL OR id != @exclude)`
    )
    .get({ project_id: projectId, status_id: statusId, exclude: excludeTicketId ?? null }) as {
    min_pos: number | null;
  };
  return row.min_pos === null ? 100 : row.min_pos - 100;
}

function getProjectStatusForProject({
  projectId,
  statusId
}: {
  projectId: string;
  statusId: string;
}): ProjectStatusRow {
  const statusRow = db
    .prepare(
      `SELECT * FROM project_statuses WHERE id = ? AND project_id = ? AND deleted_at IS NULL`
    )
    .get(statusId, projectId) as ProjectStatusRow | undefined;
  if (!statusRow) throw new ApiError(400, 'Unknown status for project');
  return statusRow;
}

function resolveStatusForProjectMove({
  targetProjectId,
  currentStatusType
}: {
  targetProjectId: string;
  currentStatusType: string;
}): ProjectStatusRow {
  const byType = db
    .prepare(
      `SELECT * FROM project_statuses
         WHERE project_id = ? AND type = ? AND deleted_at IS NULL
         ORDER BY position ASC LIMIT 1`
    )
    .get(targetProjectId, currentStatusType) as ProjectStatusRow | undefined;
  if (byType) return byType;

  const defaultStatus = db
    .prepare(
      `SELECT * FROM project_statuses
         WHERE project_id = ? AND is_default = 1 AND deleted_at IS NULL LIMIT 1`
    )
    .get(targetProjectId) as ProjectStatusRow | undefined;
  if (!defaultStatus) throw new ApiError(409, 'Target project has no default status');
  return defaultStatus;
}

/** Repoint denormalized project_id columns on ticket-owned rows. */
function cascadeTicketProjectId({
  ticketId,
  newProjectId,
  now
}: {
  ticketId: string;
  newProjectId: string;
  now: string;
}): void {
  db.prepare(
    `UPDATE objectives
       SET project_id = @project_id, updated_at = @now, revision = revision + 1
     WHERE ticket_id = @ticket_id AND workspace_id = @workspace_id`
  ).run({ project_id: newProjectId, ticket_id: ticketId, workspace_id: WORKSPACE.id, now });
  db.prepare(
    `UPDATE agent_sessions
       SET project_id = @project_id, updated_at = @now, revision = revision + 1
     WHERE ticket_id = @ticket_id AND workspace_id = @workspace_id`
  ).run({ project_id: newProjectId, ticket_id: ticketId, workspace_id: WORKSPACE.id, now });
  db.prepare(
    `UPDATE ticket_events SET project_id = @project_id
     WHERE ticket_id = @ticket_id AND workspace_id = @workspace_id`
  ).run({ project_id: newProjectId, ticket_id: ticketId, workspace_id: WORKSPACE.id });
  db.prepare(
    `UPDATE deliveries
       SET project_id = @project_id, updated_at = @now, revision = revision + 1
     WHERE ticket_id = @ticket_id AND workspace_id = @workspace_id`
  ).run({ project_id: newProjectId, ticket_id: ticketId, workspace_id: WORKSPACE.id, now });
  db.prepare(
    `UPDATE artifacts
       SET project_id = @project_id, updated_at = @now, revision = revision + 1
     WHERE ticket_id = @ticket_id AND workspace_id = @workspace_id`
  ).run({ project_id: newProjectId, ticket_id: ticketId, workspace_id: WORKSPACE.id, now });
  db.prepare(
    `UPDATE changed_files
       SET project_id = @project_id, updated_at = @now, revision = revision + 1
     WHERE ticket_id = @ticket_id AND workspace_id = @workspace_id`
  ).run({ project_id: newProjectId, ticket_id: ticketId, workspace_id: WORKSPACE.id, now });
  db.prepare(
    `UPDATE change_rationales
       SET project_id = @project_id, updated_at = @now, revision = revision + 1
     WHERE ticket_id = @ticket_id AND workspace_id = @workspace_id`
  ).run({ project_id: newProjectId, ticket_id: ticketId, workspace_id: WORKSPACE.id, now });
  db.prepare(
    `UPDATE execution_requests
       SET project_id = @project_id, updated_at = @now, revision = revision + 1
     WHERE ticket_id = @ticket_id AND workspace_id = @workspace_id`
  ).run({ project_id: newProjectId, ticket_id: ticketId, workspace_id: WORKSPACE.id, now });
}

function getTicketRow(id: string): TicketRow {
  const row = db
    .prepare(`${selectTicketsSql} AND t.id = @id`)
    .get({ workspace_id: WORKSPACE.id, id }) as TicketRow | undefined;
  if (!row) throw new ApiError(404, 'Ticket not found');
  return row;
}

export function getTicketDetail(id: string): TicketDetailDto {
  const ticket = toTicketDto(getTicketRow(id));
  const objectives = listObjectives(id);
  const statuses = listProjectStatuses(ticket.projectId);
  const executionRequests = listTicketExecutionRequests(id);
  return { ...ticket, objectives, statuses, executionRequests };
}

interface TicketEventRow {
  id: string;
  ticket_id: string;
  objective_id: string | null;
  type: string;
  phase: string | null;
  summary: string;
  source: string;
  external_url: string | null;
  created_at: string;
}

/**
 * Returns a ticket's workflow history newest-first for the live activity feed.
 * `ticket_events` is append-only, so there is no soft-delete filter; the
 * workspace scope guards against cross-workspace reads.
 */
export function listTicketEvents(ticketId: string, limit = 200): TicketEventDto[] {
  // Validate the ticket exists and belongs to the active workspace (throws 404).
  getTicketRow(ticketId);
  const rows = db
    .prepare(
      `SELECT id, ticket_id, objective_id, type, phase, summary, source, external_url, created_at
         FROM ticket_events
        WHERE ticket_id = @ticket_id AND workspace_id = @workspace_id
        ORDER BY created_at DESC, id DESC
        LIMIT @limit`
    )
    .all({ ticket_id: ticketId, workspace_id: WORKSPACE.id, limit }) as TicketEventRow[];
  return rows.map(row => ({
    id: row.id,
    ticketId: row.ticket_id,
    objectiveId: row.objective_id,
    type: row.type,
    phase: row.phase,
    summary: row.summary,
    source: row.source,
    externalUrl: row.external_url,
    createdAt: row.created_at
  }));
}

interface FileChangeRow {
  id: string;
  ticket_id: string;
  objective_id: string | null;
  file_path: string;
  label: string;
  summary: string;
  why: string;
  impact: string;
  diff_state: string | null;
  vcs_status: string | null;
  created_at: string;
}

/**
 * Returns a ticket's structured per-file change rationales newest-first for the
 * File Changes section, joined to the `changed_files` row (when linked) for diff
 * state and VCS status. Like the activity feed, the global SSE change feed
 * invalidates the client query so changes recorded by the agent or CLI in
 * another process stream into the panel without a manual refresh.
 */
export function listTicketFileChanges(ticketId: string, limit = 200): FileChangeDto[] {
  // Validate the ticket exists and belongs to the active workspace (throws 404).
  getTicketRow(ticketId);
  const rows = db
    .prepare(
      `SELECT cr.id, cr.ticket_id, cr.objective_id, cr.file_path, cr.label, cr.summary,
              cr.why, cr.impact, cr.created_at,
              cf.current_diff_state AS diff_state, cf.vcs_status AS vcs_status
         FROM change_rationales cr
         LEFT JOIN changed_files cf
           ON cf.id = cr.changed_file_id AND cf.deleted_at IS NULL
        WHERE cr.ticket_id = @ticket_id AND cr.workspace_id = @workspace_id
          AND cr.deleted_at IS NULL
        ORDER BY cr.created_at DESC, cr.id DESC
        LIMIT @limit`
    )
    .all({ ticket_id: ticketId, workspace_id: WORKSPACE.id, limit }) as FileChangeRow[];
  return rows.map(row => ({
    id: row.id,
    ticketId: row.ticket_id,
    objectiveId: row.objective_id,
    filePath: row.file_path,
    fileName: row.file_path.split('/').pop() || row.file_path,
    label: row.label,
    summary: row.summary,
    why: row.why,
    impact: row.impact,
    diffState: (row.diff_state as FileChangeDto['diffState']) ?? null,
    vcsStatus: row.vcs_status,
    createdAt: row.created_at
  }));
}

interface ArtifactRow {
  id: string;
  workspace_id: string;
  project_id: string;
  ticket_id: string;
  objective_id: string | null;
  session_id: string | null;
  delivery_id: string | null;
  type: string;
  label: string;
  content_text: string | null;
  content_json: string | null;
  external_url: string | null;
  created_at: string;
  updated_at: string;
}

export function listArtifacts(ticketId: string, limit = 200): ArtifactDto[] {
  getTicketRow(ticketId);
  const rows = db
    .prepare(
      `SELECT id, workspace_id, project_id, ticket_id, objective_id, session_id, delivery_id,
              type, label, content_text, content_json, external_url, created_at, updated_at
         FROM artifacts
        WHERE ticket_id = @ticket_id AND workspace_id = @workspace_id AND deleted_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT @limit`
    )
    .all({ ticket_id: ticketId, workspace_id: WORKSPACE.id, limit }) as ArtifactRow[];
  return rows.map(row => ({
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    ticketId: row.ticket_id,
    objectiveId: row.objective_id,
    sessionId: row.session_id,
    deliveryId: row.delivery_id,
    type: row.type,
    label: row.label,
    contentText: row.content_text,
    contentJson: row.content_json ? (JSON.parse(row.content_json) as unknown) : null,
    externalUrl: row.external_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

function nextTicketSequence(): number {
  // Allocate the next workspace-scoped ticket number, creating the counter row
  // if a fresh database somehow lacks it.
  const row = db
    .prepare(
      `SELECT id, next_value FROM ticket_sequences
         WHERE workspace_id = ? AND scope_type = 'workspace'
           AND scope_id = ? AND counter_name = 'ticket'`
    )
    .get(WORKSPACE.id, WORKSPACE.id) as { id: string; next_value: number } | undefined;

  if (!row) {
    const seq = 1;
    db.prepare(
      `INSERT INTO ticket_sequences (id, workspace_id, scope_type, scope_id, counter_name, next_value, updated_at)
       VALUES (@id, @ws, 'workspace', @ws, 'ticket', @next, @now)`
    ).run({ id: newId(), ws: WORKSPACE.id, next: seq + 1, now: nowIso() });
    return seq;
  }

  const seq = row.next_value;
  db.prepare(`UPDATE ticket_sequences SET next_value = ?, updated_at = ? WHERE id = ?`).run(
    seq + 1,
    nowIso(),
    row.id
  );
  return seq;
}

type CreateTicketResult = {
  detail: TicketDetailDto;
  firstObjectiveId?: string;
  instruction: string;
};

const createTicketTx = db.transaction((body: CreateTicketBody): CreateTicketResult => {
  const instruction = (body.firstObjective ?? body.title ?? '').trim();
  if (!instruction) {
    throw new ApiError(400, 'Describe the work to be done (title or first objective)');
  }

  const title = (body.title ?? '').trim() || initialTitleFromInstruction(instruction);

  const project = db
    .prepare(`SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`)
    .get(body.projectId, WORKSPACE.id) as { id: string } | undefined;
  if (!project) throw new ApiError(404, 'Project not found');

  // Resolve the target status: explicit choice or the project's default.
  let statusRow: ProjectStatusRow | undefined;
  if (body.statusId) {
    statusRow = db
      .prepare(
        `SELECT * FROM project_statuses WHERE id = ? AND project_id = ? AND deleted_at IS NULL`
      )
      .get(body.statusId, body.projectId) as ProjectStatusRow | undefined;
    if (!statusRow) throw new ApiError(400, 'Unknown status for project');
  } else {
    statusRow = db
      .prepare(
        `SELECT * FROM project_statuses
           WHERE project_id = ? AND is_default = 1 AND deleted_at IS NULL LIMIT 1`
      )
      .get(body.projectId) as ProjectStatusRow | undefined;
    if (!statusRow) throw new ApiError(409, 'Project has no default status');
  }

  const priority = body.priority ?? 'normal';
  if (!['low', 'normal', 'high', 'urgent'].includes(priority)) {
    throw new ApiError(400, 'Invalid priority');
  }

  const now = nowIso();
  const id = newId();
  const sequence = nextTicketSequence();
  const displayId = `${WORKSPACE.slug}:${sequence}`;
  const boardPosition = topBoardPosition(body.projectId, statusRow.id);

  db.prepare(
    `INSERT INTO tickets
       (id, workspace_id, project_id, display_id, sequence_number, title,
        status_id, status_type, board_position, priority, available_tools_json, execution_target_intent_json,
        metadata_json, created_by_workspace_user_id, created_at, updated_at, revision)
     VALUES (@id, @ws, @project_id, @display_id, @sequence, @title,
        @status_id, @status_type, @board_position, @priority, '[]', '{}',
        '{}', @actor, @now, @now, 1)`
  ).run({
    id,
    ws: WORKSPACE.id,
    project_id: body.projectId,
    display_id: displayId,
    sequence,
    title,
    status_id: statusRow.id,
    status_type: statusRow.type,
    board_position: boardPosition,
    priority,
    actor: ACTOR_WORKSPACE_USER_ID,
    now
  });

  recordChange({
    entityType: 'ticket',
    entityId: id,
    operation: 'insert',
    entityRevision: 1,
    projectId: body.projectId,
    ticketId: id
  });

  let firstObjectiveId: string | undefined;
  if (body.firstObjective?.trim()) {
    const objective = insertObjective({
      ticketId: id,
      instructionText: body.firstObjective
    });
    firstObjectiveId = objective.id;
  }

  return { detail: getTicketDetail(id), firstObjectiveId, instruction };
});

export function createTicket(body: CreateTicketBody): TicketDetailDto {
  const { detail, firstObjectiveId, instruction } = createTicketTx(body);

  scheduleTicketTitleGeneration({
    ticketId: detail.id,
    projectId: detail.projectId,
    instructionText: instruction
  });

  if (firstObjectiveId) {
    scheduleObjectiveTitleGeneration({
      objectiveId: firstObjectiveId,
      projectId: detail.projectId,
      ticketId: detail.id,
      instructionText: instruction
    });
  }

  return detail;
}

/**
 * Validate a ticket assignee. Returns the `workspace_users.id` when it names an
 * active member of the current workspace, or `null` to unassign. Throws 400 for
 * an unknown member so callers cannot point a ticket at a foreign workspace.
 */
function resolveAssignedWorkspaceUserId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const member = db
    .prepare(
      `SELECT id FROM workspace_users
        WHERE id = ? AND workspace_id = ? AND status = 'active' AND deleted_at IS NULL`
    )
    .get(trimmed, WORKSPACE.id) as { id: string } | undefined;
  if (!member) throw new ApiError(400, 'Assignee is not a member of this workspace');
  return member.id;
}

const patchTicketFieldsTx = db.transaction(
  (id: string, body: UpdateTicketBody): TicketDetailDto => {
    const existing = getTicketRow(id);

    const fields: string[] = [];
    const params: Record<string, unknown> = { id, workspace_id: WORKSPACE.id };
    const changed: string[] = [];

    if (body.title !== undefined) {
      const title = body.title.trim();
      if (!title) throw new ApiError(400, 'Ticket title cannot be empty');
      fields.push('title = @title');
      params.title = title;
      changed.push('title');
    }
    if (body.priority !== undefined) {
      if (body.priority !== null && !['low', 'normal', 'high', 'urgent'].includes(body.priority)) {
        throw new ApiError(400, 'Invalid priority');
      }
      fields.push('priority = @priority');
      params.priority = body.priority;
      changed.push('priority');
    }
    if (body.assignedWorkspaceUserId !== undefined) {
      fields.push('assigned_workspace_user_id = @assigned_workspace_user_id');
      params.assigned_workspace_user_id = resolveAssignedWorkspaceUserId(
        body.assignedWorkspaceUserId
      );
      changed.push('assigned_workspace_user_id');
    }
    if (body.statusId !== undefined) {
      const statusRow = getProjectStatusForProject({
        projectId: existing.project_id,
        statusId: body.statusId
      });
      fields.push('status_id = @status_id', 'status_type = @status_type');
      params.status_id = statusRow.id;
      params.status_type = statusRow.type;
      changed.push('status_id', 'status_type');
      if (statusRow.id !== existing.status_id) {
        fields.push('board_position = @board_position');
        params.board_position = topBoardPosition(existing.project_id, statusRow.id, id);
        changed.push('board_position');
      }
    }
    if (body.acceptanceCriteria !== undefined) {
      fields.push('acceptance_criteria_text = @acceptance_criteria_text');
      params.acceptance_criteria_text = body.acceptanceCriteria?.trim() || null;
      changed.push('acceptance_criteria_text');
    }
    if (body.availableTools !== undefined) {
      if (!Array.isArray(body.availableTools))
        throw new ApiError(400, 'availableTools must be an array');
      const toolsJson = JSON.stringify(body.availableTools.map(name => ({ name })));
      fields.push('available_tools_json = @available_tools_json');
      params.available_tools_json = toolsJson;
      changed.push('available_tools_json');
    }
    if (fields.length === 0) return getTicketDetail(id);

    const now = nowIso();
    const revision = existing.revision + 1;
    db.prepare(
      `UPDATE tickets SET ${fields.join(', ')}, updated_at = @now, revision = @revision
         WHERE id = @id AND workspace_id = @workspace_id`
    ).run({ ...params, now, revision });

    recordChange({
      entityType: 'ticket',
      entityId: id,
      operation: 'update',
      entityRevision: revision,
      projectId: existing.project_id,
      ticketId: id,
      changedFields: changed
    });
    return getTicketDetail(id);
  }
);

const moveTicketProjectTx = db.transaction(
  ({
    id,
    body,
    existing,
    targetProjectId,
    statusRow
  }: {
    id: string;
    body: UpdateTicketBody;
    existing: TicketRow;
    targetProjectId: string;
    statusRow: ProjectStatusRow;
  }): TicketDetailDto => {
    const fields = [
      'project_id = @project_id',
      'status_id = @status_id',
      'status_type = @status_type',
      'board_position = @board_position'
    ];
    const params: Record<string, unknown> = {
      id,
      workspace_id: WORKSPACE.id,
      project_id: targetProjectId,
      status_id: statusRow.id,
      status_type: statusRow.type,
      board_position: topBoardPosition(targetProjectId, statusRow.id, id)
    };
    const changed = ['project_id', 'status_id', 'status_type', 'board_position'];

    if (body.title !== undefined) {
      const title = body.title.trim();
      if (!title) throw new ApiError(400, 'Ticket title cannot be empty');
      fields.push('title = @title');
      params.title = title;
      changed.push('title');
    }
    if (body.priority !== undefined) {
      if (body.priority !== null && !['low', 'normal', 'high', 'urgent'].includes(body.priority)) {
        throw new ApiError(400, 'Invalid priority');
      }
      fields.push('priority = @priority');
      params.priority = body.priority;
      changed.push('priority');
    }
    if (body.assignedWorkspaceUserId !== undefined) {
      fields.push('assigned_workspace_user_id = @assigned_workspace_user_id');
      params.assigned_workspace_user_id = resolveAssignedWorkspaceUserId(
        body.assignedWorkspaceUserId
      );
      changed.push('assigned_workspace_user_id');
    }
    if (body.acceptanceCriteria !== undefined) {
      fields.push('acceptance_criteria_text = @acceptance_criteria_text');
      params.acceptance_criteria_text = body.acceptanceCriteria?.trim() || null;
      changed.push('acceptance_criteria_text');
    }
    if (body.availableTools !== undefined) {
      if (!Array.isArray(body.availableTools))
        throw new ApiError(400, 'availableTools must be an array');
      fields.push('available_tools_json = @available_tools_json');
      params.available_tools_json = JSON.stringify(body.availableTools.map(name => ({ name })));
      changed.push('available_tools_json');
    }

    const now = nowIso();
    const revision = existing.revision + 1;
    cascadeTicketProjectId({ ticketId: id, newProjectId: targetProjectId, now });
    db.prepare(
      `UPDATE tickets SET ${fields.join(', ')}, updated_at = @now, revision = @revision
         WHERE id = @id AND workspace_id = @workspace_id`
    ).run({ ...params, now, revision });

    recordChange({
      entityType: 'ticket',
      entityId: id,
      operation: 'update',
      entityRevision: revision,
      projectId: targetProjectId,
      ticketId: id,
      changedFields: changed
    });
    return getTicketDetail(id);
  }
);

/** PATCH /api/tickets/:id — field updates and cross-project moves. */
export function updateTicket(id: string, body: UpdateTicketBody): TicketDetailDto {
  const existing = getTicketRow(id);
  if (body.projectId !== undefined && body.projectId !== existing.project_id) {
    const targetProject = db
      .prepare(`SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`)
      .get(body.projectId, WORKSPACE.id) as { id: string } | undefined;
    if (!targetProject) throw new ApiError(404, 'Project not found');

    const statusRow =
      body.statusId !== undefined
        ? getProjectStatusForProject({ projectId: body.projectId, statusId: body.statusId })
        : resolveStatusForProjectMove({
            targetProjectId: body.projectId,
            currentStatusType: existing.status_type
          });

    // Composite ticket/objective FKs require briefly disabling enforcement; SQLite
    // will not allow toggling the pragma inside an open transaction.
    db.pragma('foreign_keys = OFF');
    try {
      return moveTicketProjectTx({
        id,
        body,
        existing,
        targetProjectId: body.projectId,
        statusRow
      });
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }

  return patchTicketFieldsTx(id, body);
}

export const deleteTicket = db.transaction((id: string): void => {
  const existing = getTicketRow(id);
  const now = nowIso();
  const revision = existing.revision + 1;
  // Soft-delete the ticket and its objectives so referential integrity holds.
  db.prepare(
    `UPDATE objectives SET deleted_at = @now, revision = revision + 1
       WHERE ticket_id = @id AND deleted_at IS NULL`
  ).run({ id, now });
  db.prepare(
    `UPDATE tickets SET deleted_at = @now, revision = @revision
       WHERE id = @id AND workspace_id = @workspace_id`
  ).run({ id, now, revision, workspace_id: WORKSPACE.id });

  recordChange({
    entityType: 'ticket',
    entityId: id,
    operation: 'delete',
    entityRevision: revision,
    projectId: existing.project_id,
    ticketId: id
  });
});

/**
 * Reorder one board column. `orderedTicketIds` is the full top-to-bottom order
 * the `statusId` column should have afterwards. Each ticket is renumbered to a
 * dense gap-based position (100, 200, 300, …); any ticket arriving from another
 * column also has its status changed to match. Tickets whose status and
 * position are already correct are skipped so no redundant change feed rows are
 * written. Returns the destination column in its new order.
 */
export const reorderBoardColumn = db.transaction(
  (projectId: string, body: ReorderBoardColumnBody): TicketDto[] => {
    const statusId = body.statusId;
    const orderedIds = body.orderedTicketIds;
    if (!statusId) throw new ApiError(400, 'statusId is required');
    if (!Array.isArray(orderedIds)) throw new ApiError(400, 'orderedTicketIds must be an array');

    const statusRow = db
      .prepare(
        `SELECT * FROM project_statuses WHERE id = ? AND project_id = ? AND deleted_at IS NULL`
      )
      .get(statusId, projectId) as ProjectStatusRow | undefined;
    if (!statusRow) throw new ApiError(400, 'Unknown status for project');

    if (new Set(orderedIds).size !== orderedIds.length) {
      throw new ApiError(400, 'orderedTicketIds contains duplicates');
    }

    const now = nowIso();
    orderedIds.forEach((ticketId, index) => {
      const existing = db
        .prepare(
          `SELECT * FROM tickets
             WHERE id = ? AND workspace_id = ? AND project_id = ? AND deleted_at IS NULL`
        )
        .get(ticketId, WORKSPACE.id, projectId) as TicketRow | undefined;
      if (!existing) throw new ApiError(404, `Ticket ${ticketId} not found in project`);

      const boardPosition = (index + 1) * 100;
      const statusChanged = existing.status_id !== statusId;
      const positionChanged = existing.board_position !== boardPosition;
      if (!statusChanged && !positionChanged) return;

      const setClauses = ['board_position = @board_position'];
      const sqlParams: Record<string, unknown> = {
        id: ticketId,
        workspace_id: WORKSPACE.id,
        board_position: boardPosition
      };
      const changed = ['board_position'];
      if (statusChanged) {
        setClauses.push('status_id = @status_id', 'status_type = @status_type');
        sqlParams.status_id = statusId;
        sqlParams.status_type = statusRow.type;
        changed.push('status_id', 'status_type');
      }

      const revision = existing.revision + 1;
      db.prepare(
        `UPDATE tickets SET ${setClauses.join(', ')}, updated_at = @now, revision = @revision
           WHERE id = @id AND workspace_id = @workspace_id`
      ).run({ ...sqlParams, now, revision });

      recordChange({
        entityType: 'ticket',
        entityId: ticketId,
        operation: 'update',
        entityRevision: revision,
        projectId,
        ticketId,
        changedFields: changed
      });
    });

    return listTickets(projectId).filter(t => t.statusId === statusId);
  }
);

// ---- Objectives ----------------------------------------------------------

export function listObjectives(ticketId: string): ObjectiveDto[] {
  const rows = db
    .prepare(
      `SELECT * FROM objectives
         WHERE ticket_id = ? AND deleted_at IS NULL
         ORDER BY position ASC`
    )
    .all(ticketId) as ObjectiveRow[];
  return rows.map(toObjectiveDto);
}

const VALID_STATES = [
  'future',
  'draft',
  'submitted',
  'launching',
  'executing',
  'pending_delivery',
  'complete'
];

/**
 * Reorder a ticket's `future` objectives. `orderedObjectiveIds` is the full
 * top-to-bottom order the future group should have afterwards. The future rows
 * are renumbered relative to one another starting at the lowest position they
 * currently occupy, so they keep sitting after any non-future objectives.
 * Objectives whose position is already correct are skipped so no redundant
 * change-feed rows are written. Returns the ticket's full objective list in its
 * new order.
 */
export const reorderFutureObjectives = db.transaction(
  (ticketId: string, body: ReorderFutureObjectivesBody): ObjectiveDto[] => {
    const orderedIds = body.orderedObjectiveIds;
    if (!Array.isArray(orderedIds)) {
      throw new ApiError(400, 'orderedObjectiveIds must be an array');
    }
    if (new Set(orderedIds).size !== orderedIds.length) {
      throw new ApiError(400, 'orderedObjectiveIds contains duplicates');
    }

    const ticket = db
      .prepare(
        `SELECT id, project_id FROM tickets WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
      )
      .get(ticketId, WORKSPACE.id) as { id: string; project_id: string } | undefined;
    if (!ticket) throw new ApiError(404, 'Ticket not found');

    const rows = db
      .prepare(
        `SELECT * FROM objectives
           WHERE ticket_id = ? AND workspace_id = ? AND deleted_at IS NULL`
      )
      .all(ticketId, WORKSPACE.id) as ObjectiveRow[];
    const byId = new Map(rows.map(row => [row.id, row]));

    const targets = orderedIds.map(id => {
      const row = byId.get(id);
      if (!row) throw new ApiError(404, `Objective ${id} not found on ticket`);
      if (row.state !== 'future') {
        throw new ApiError(400, `Objective ${id} is not a future objective`);
      }
      return row;
    });
    if (targets.length === 0) return listObjectives(ticketId);

    // Renumber starting at the lowest position the future group currently holds,
    // keeping the whole group after any non-future objectives.
    const basePosition = Math.min(...targets.map(row => row.position));

    const now = nowIso();
    targets.forEach((existing, index) => {
      const position = basePosition + index;
      if (existing.position === position) return;

      const revision = existing.revision + 1;
      db.prepare(
        `UPDATE objectives SET position = @position, updated_at = @now, revision = @revision
           WHERE id = @id AND workspace_id = @workspace_id`
      ).run({ id: existing.id, workspace_id: WORKSPACE.id, position, now, revision });

      recordChange({
        entityType: 'objective',
        entityId: existing.id,
        operation: 'update',
        entityRevision: revision,
        projectId: ticket.project_id,
        ticketId,
        objectiveId: existing.id,
        changedFields: ['position']
      });
    });

    return listObjectives(ticketId);
  }
);

// Internal insert used by both createObjective and createTicket's first objective.
// Assumes it runs within a transaction.
function insertObjective(body: CreateObjectiveBody): ObjectiveDto {
  const instruction = (body.instructionText ?? '').trim();
  if (!instruction) throw new ApiError(400, 'Objective instruction is required');

  const ticket = db
    .prepare(
      `SELECT id, project_id FROM tickets WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
    )
    .get(body.ticketId, WORKSPACE.id) as { id: string; project_id: string } | undefined;
  if (!ticket) throw new ApiError(404, 'Ticket not found');

  const requestedState = body.state ?? 'draft';
  if (!VALID_STATES.includes(requestedState)) throw new ApiError(400, 'Invalid objective state');

  const draftRow = db
    .prepare(
      `SELECT id FROM objectives
       WHERE ticket_id = ? AND workspace_id = ? AND state = 'draft' AND deleted_at IS NULL
       LIMIT 1`
    )
    .get(body.ticketId, WORKSPACE.id) as { id: string } | undefined;
  const state = requestedState === 'draft' && draftRow ? 'future' : requestedState;

  const maxRow = db
    .prepare(
      `SELECT MAX(position) AS max_pos FROM objectives WHERE ticket_id = ? AND deleted_at IS NULL`
    )
    .get(body.ticketId) as { max_pos: number | null };
  const position = (maxRow.max_pos ?? -1) + 1;

  const now = nowIso();
  const id = newId();
  db.prepare(
    `INSERT INTO objectives
       (id, workspace_id, project_id, ticket_id, position, title, instruction_text, state,
        agent_flags_json, auto_advance, execution_metadata_json,
        created_by_workspace_user_id, created_at, updated_at, revision)
     VALUES (@id, @ws, @project_id, @ticket_id, @position, @title, @instruction, @state,
        '{}', @auto_advance, '{}', @actor, @now, @now, 1)`
  ).run({
    id,
    ws: WORKSPACE.id,
    project_id: ticket.project_id,
    ticket_id: body.ticketId,
    position,
    title: body.title?.trim() || initialTitleFromInstruction(instruction),
    instruction,
    state,
    auto_advance: body.autoAdvance ? 1 : 0,
    actor: ACTOR_WORKSPACE_USER_ID,
    now
  });

  recordChange({
    entityType: 'objective',
    entityId: id,
    operation: 'insert',
    entityRevision: 1,
    projectId: ticket.project_id,
    ticketId: body.ticketId,
    objectiveId: id
  });

  const row = db.prepare(`SELECT * FROM objectives WHERE id = ?`).get(id) as ObjectiveRow;
  return toObjectiveDto(row);
}

const createObjectiveTx = db.transaction(insertObjective);

export function createObjective(body: CreateObjectiveBody): ObjectiveDto {
  const objective = createObjectiveTx(body);

  if (!body.title?.trim()) {
    scheduleObjectiveTitleGeneration({
      objectiveId: objective.id,
      projectId: objective.projectId,
      ticketId: objective.ticketId,
      instructionText: objective.instructionText
    });
  }

  return objective;
}

const updateObjectiveTx = db.transaction(
  (
    id: string,
    body: UpdateObjectiveBody
  ): { objective: ObjectiveDto; regenerateTitle: boolean } => {
    const existing = db
      .prepare(`SELECT * FROM objectives WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`)
      .get(id, WORKSPACE.id) as ObjectiveRow | undefined;
    if (!existing) throw new ApiError(404, 'Objective not found');

    const fields: string[] = [];
    const params: Record<string, unknown> = { id, workspace_id: WORKSPACE.id };
    const changed: string[] = [];

    let instructionChanged = false;
    if (body.instructionText !== undefined) {
      const instruction = body.instructionText.trim();
      if (!instruction) throw new ApiError(400, 'Objective instruction cannot be empty');
      fields.push('instruction_text = @instruction');
      params.instruction = instruction;
      changed.push('instruction_text');
      instructionChanged = true;
    }
    if (body.title !== undefined) {
      fields.push('title = @title');
      params.title = body.title?.trim() || null;
      changed.push('title');
    }
    if (body.state !== undefined) {
      if (!VALID_STATES.includes(body.state)) throw new ApiError(400, 'Invalid objective state');
      fields.push('state = @state');
      params.state = body.state;
      changed.push('state');
      if (body.state === 'complete') {
        fields.push('completed_at = @now_completed');
        params.now_completed = nowIso();
      }
    }
    if (body.autoAdvance !== undefined) {
      fields.push('auto_advance = @auto_advance');
      params.auto_advance = body.autoAdvance ? 1 : 0;
      changed.push('auto_advance');
    }
    if (body.position !== undefined) {
      if (!Number.isInteger(body.position) || body.position < 0) {
        throw new ApiError(400, 'Invalid position');
      }
      fields.push('position = @position');
      params.position = body.position;
      changed.push('position');
    }
    if (body.assignedAgent !== undefined) {
      fields.push('assigned_agent = @assigned_agent');
      params.assigned_agent = body.assignedAgent?.trim() || null;
      changed.push('assigned_agent');
    }
    if (body.model !== undefined) {
      fields.push('model = @model');
      params.model = body.model?.trim() || null;
      changed.push('model');
    }
    if (body.reasoningEffort !== undefined) {
      fields.push('reasoning_effort = @reasoning_effort');
      params.reasoning_effort = body.reasoningEffort?.trim() || null;
      changed.push('reasoning_effort');
    }
    if (fields.length === 0) {
      return { objective: toObjectiveDto(existing), regenerateTitle: false };
    }

    const now = nowIso();
    const revision = existing.revision + 1;
    if (body.state === 'draft') {
      const otherDrafts = db
        .prepare(
          `SELECT id, revision FROM objectives
           WHERE ticket_id = ? AND workspace_id = ? AND state = 'draft'
             AND id <> ? AND deleted_at IS NULL`
        )
        .all(existing.ticket_id, WORKSPACE.id, id) as Array<{ id: string; revision: number }>;

      for (const draft of otherDrafts) {
        const draftRevision = draft.revision + 1;
        db.prepare(
          `UPDATE objectives SET state = 'future', updated_at = @now, revision = @revision
           WHERE id = @id AND workspace_id = @workspace_id`
        ).run({
          id: draft.id,
          workspace_id: WORKSPACE.id,
          now,
          revision: draftRevision
        });

        recordChange({
          entityType: 'objective',
          entityId: draft.id,
          operation: 'update',
          entityRevision: draftRevision,
          projectId: existing.project_id,
          ticketId: existing.ticket_id,
          objectiveId: draft.id,
          changedFields: ['state']
        });
      }
    }

    db.prepare(
      `UPDATE objectives SET ${fields.join(', ')}, updated_at = @now, revision = @revision
         WHERE id = @id AND workspace_id = @workspace_id`
    ).run({ ...params, now, revision });

    recordChange({
      entityType: 'objective',
      entityId: id,
      operation: 'update',
      entityRevision: revision,
      projectId: existing.project_id,
      ticketId: existing.ticket_id,
      objectiveId: id,
      changedFields: changed
    });

    const row = db.prepare(`SELECT * FROM objectives WHERE id = ?`).get(id) as ObjectiveRow;
    const objective = toObjectiveDto(row);

    return {
      objective,
      regenerateTitle: instructionChanged && body.title === undefined
    };
  }
);

export function updateObjective(id: string, body: UpdateObjectiveBody): ObjectiveDto {
  const { objective, regenerateTitle } = updateObjectiveTx(id, body);

  if (regenerateTitle) {
    scheduleObjectiveTitleGeneration({
      objectiveId: objective.id,
      projectId: objective.projectId,
      ticketId: objective.ticketId,
      instructionText: objective.instructionText
    });
  }

  return objective;
}

export const deleteObjective = db.transaction((id: string): void => {
  const existing = db
    .prepare(`SELECT * FROM objectives WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`)
    .get(id, WORKSPACE.id) as ObjectiveRow | undefined;
  if (!existing) throw new ApiError(404, 'Objective not found');

  const now = nowIso();
  const revision = existing.revision + 1;
  db.prepare(
    `UPDATE objectives SET deleted_at = @now, revision = @revision
       WHERE id = @id AND workspace_id = @workspace_id`
  ).run({ id, now, revision, workspace_id: WORKSPACE.id });

  recordChange({
    entityType: 'objective',
    entityId: id,
    operation: 'delete',
    entityRevision: revision,
    projectId: existing.project_id,
    ticketId: existing.ticket_id,
    objectiveId: id
  });
});

// ---- Profile -------------------------------------------------------------
//
// This build runs as a single trusted local operator, so "the profile" is the
// operator's row in the `users` table. The avatar URL has no dedicated column
// in the core schema, so it lives in `users.metadata_json.avatarUrl`. Password
// management is intentionally absent: local installs have no Better Auth
// credential to rotate.

interface UserRow {
  id: string;
  kind: string;
  display_name: string;
  handle: string | null;
  email: string | null;
  auth_provider: string | null;
  metadata_json: string;
  created_at: string;
  revision: number;
}

/**
 * Resolve the local operator's `users` row. Prefers the user behind the active
 * workspace's actor; falls back to the oldest active human user so a freshly
 * switched workspace without a recorded actor still resolves an identity.
 */
function loadOperatorUserRow(): UserRow {
  if (ACTOR_WORKSPACE_USER_ID) {
    const row = db
      .prepare(
        `SELECT u.id, u.kind, u.display_name, u.handle, u.email, u.auth_provider,
                u.metadata_json, u.created_at, u.revision
           FROM users u
           JOIN workspace_users wu ON wu.user_id = u.id
          WHERE wu.id = ? AND u.deleted_at IS NULL`
      )
      .get(ACTOR_WORKSPACE_USER_ID) as UserRow | undefined;
    if (row) return row;
  }
  const fallback = db
    .prepare(
      `SELECT id, kind, display_name, handle, email, auth_provider,
              metadata_json, created_at, revision
         FROM users
        WHERE kind = 'human' AND status = 'active' AND deleted_at IS NULL
        ORDER BY created_at ASC LIMIT 1`
    )
    .get() as UserRow | undefined;
  if (!fallback) throw new ApiError(409, 'No local user profile exists');
  return fallback;
}

function avatarUrlFromMetadata(metadataJson: string): string | null {
  try {
    const parsed = JSON.parse(metadataJson) as { avatarUrl?: unknown };
    return typeof parsed.avatarUrl === 'string' && parsed.avatarUrl.trim()
      ? parsed.avatarUrl
      : null;
  } catch {
    return null;
  }
}

/** Merge an avatar URL into the existing metadata JSON without dropping other keys. */
function mergeAvatarMetadataJson(metadataJson: string, avatarUrl: string | null): string {
  let parsed: Record<string, unknown> = {};
  try {
    const candidate = JSON.parse(metadataJson) as unknown;
    if (candidate && typeof candidate === 'object') parsed = candidate as Record<string, unknown>;
  } catch {
    /* corrupt metadata is replaced rather than propagated */
  }
  if (avatarUrl) parsed.avatarUrl = avatarUrl;
  else delete parsed.avatarUrl;
  return JSON.stringify(parsed);
}

function toProfileDto(row: UserRow): ProfileDto {
  return {
    userId: row.id,
    displayName: row.display_name,
    handle: row.handle,
    email: row.email,
    avatarUrl: avatarUrlFromMetadata(row.metadata_json),
    kind: row.kind,
    authProvider: row.auth_provider,
    createdAt: row.created_at
  };
}

export function getProfile(): ProfileDto {
  return toProfileDto(loadOperatorUserRow());
}

export const updateProfile = db.transaction((body: UpdateProfileBody): ProfileDto => {
  const existing = loadOperatorUserRow();

  const fields: string[] = [];
  const params: Record<string, unknown> = { id: existing.id };
  const changed: string[] = [];

  if (body.displayName !== undefined) {
    const displayName = body.displayName.trim();
    if (!displayName) throw new ApiError(400, 'Display name cannot be empty');
    fields.push('display_name = @display_name');
    params.display_name = displayName;
    changed.push('display_name');
  }
  if (body.handle !== undefined) {
    fields.push('handle = @handle');
    params.handle = body.handle?.trim() || null;
    changed.push('handle');
  }
  if (body.email !== undefined) {
    const email = body.email?.trim() || null;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new ApiError(400, 'Enter a valid email address');
    }
    fields.push('email = @email');
    params.email = email;
    changed.push('email');
  }
  if (body.avatarUrl !== undefined) {
    const avatarUrl = body.avatarUrl?.trim() || null;
    // Accept absolute http(s) URLs or a server-relative path (e.g. an image
    // uploaded through the core upload service: `/api/storage/user-images/…`).
    if (avatarUrl && !/^(https?:\/\/|\/)/i.test(avatarUrl)) {
      throw new ApiError(400, 'Avatar URL must be an http(s) URL or an uploaded image path');
    }
    fields.push('metadata_json = @metadata_json');
    params.metadata_json = mergeAvatarMetadataJson(existing.metadata_json, avatarUrl);
    changed.push('metadata_json');
  }
  if (fields.length === 0) return toProfileDto(existing);

  const now = nowIso();
  const revision = existing.revision + 1;
  db.prepare(
    `UPDATE users SET ${fields.join(', ')}, updated_at = @now, revision = @revision
       WHERE id = @id`
  ).run({ ...params, now, revision });

  recordChange({
    entityType: 'user',
    entityId: existing.id,
    operation: 'update',
    entityRevision: revision,
    changedFields: changed
  });

  return getProfile();
});

// ---- User tokens ---------------------------------------------------------
//
// `USER_TOKEN`s are long-lived credentials the local operator can mint for CLI,
// agent, runner, and future API use (see auth/docs/07-user-token-authentication.md).
// In this single-trusted-user build a token confers the operator's identity. We
// store only a hash of the secret plus a non-secret display prefix; the raw
// secret is returned exactly once at creation and never persisted or shown again.

/** Recognizable scheme for Overlord user tokens: `out_…`. */
const USER_TOKEN_SCHEME = 'out';
/** Algorithm recorded in `user_tokens.hash_algorithm` and used to hash secrets. */
const USER_TOKEN_HASH_ALGORITHM = 'sha256';

const USER_TOKEN_COLUMNS =
  'id, label, token_prefix, status, expires_at, last_used_at, revoked_at, created_at';

interface UserTokenRow {
  id: string;
  label: string;
  token_prefix: string;
  status: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

interface UserTokenMutableRow {
  id: string;
  status: string;
  revision: number;
}

interface OperatorIdentity {
  userId: string;
  workspaceUserId: string;
}

function toUserTokenDto(row: UserTokenRow): UserTokenDto {
  return {
    id: row.id,
    label: row.label,
    tokenPrefix: row.token_prefix,
    status: row.status as UserTokenDto['status'],
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at
  };
}

/**
 * Resolve both the global user id and the active-workspace membership id the
 * token is owned by. The membership records whose permissions the token inherits.
 */
function loadOperatorIdentity(): OperatorIdentity {
  const user = loadOperatorUserRow();
  const membership = db
    .prepare(
      `SELECT id FROM workspace_users
         WHERE workspace_id = ? AND user_id = ? AND deleted_at IS NULL
         ORDER BY created_at ASC LIMIT 1`
    )
    .get(WORKSPACE.id, user.id) as { id: string } | undefined;
  if (!membership) {
    throw new ApiError(409, 'No workspace membership for the local operator');
  }
  return { userId: user.id, workspaceUserId: membership.id };
}

/**
 * Generate a high-entropy secret of the form `out_<prefix><secret>`. The
 * `out_<prefix>` portion is the non-secret lookup/display prefix; the full
 * string is the raw secret. Only the SHA-256 hash of the raw secret is stored.
 */
function generateUserTokenSecret(): { secret: string; prefix: string; hash: string } {
  const prefix = `${USER_TOKEN_SCHEME}_${randomBytes(4).toString('hex')}`;
  const secret = `${prefix}${randomBytes(24).toString('hex')}`;
  const hash = createHash(USER_TOKEN_HASH_ALGORITHM).update(secret).digest('hex');
  return { secret, prefix, hash };
}

function loadUserTokenForUpdate(id: string): UserTokenMutableRow {
  const row = db
    .prepare(
      `SELECT id, status, revision FROM user_tokens
         WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
    )
    .get(id, WORKSPACE.id) as UserTokenMutableRow | undefined;
  if (!row) throw new ApiError(404, 'Token not found');
  return row;
}

function reloadUserToken(id: string): UserTokenRow {
  return db
    .prepare(`SELECT ${USER_TOKEN_COLUMNS} FROM user_tokens WHERE id = ?`)
    .get(id) as UserTokenRow;
}

export function listUserTokens(): UserTokenDto[] {
  const rows = db
    .prepare(
      `SELECT ${USER_TOKEN_COLUMNS} FROM user_tokens
         WHERE workspace_id = ? AND deleted_at IS NULL
         ORDER BY created_at DESC`
    )
    .all(WORKSPACE.id) as UserTokenRow[];
  return rows.map(toUserTokenDto);
}

export const createUserToken = db.transaction(
  (body: CreateUserTokenBody): CreateUserTokenResultDto => {
    const label = body.label?.trim();
    if (!label) throw new ApiError(400, 'Token label cannot be empty');

    let expiresAt: string | null = null;
    if (body.expiresAt !== null && body.expiresAt !== undefined && String(body.expiresAt).trim()) {
      const parsed = new Date(body.expiresAt);
      if (Number.isNaN(parsed.getTime())) throw new ApiError(400, 'Expiry must be a valid date');
      if (parsed.getTime() <= Date.now()) throw new ApiError(400, 'Expiry must be in the future');
      expiresAt = parsed.toISOString();
    }

    const { userId, workspaceUserId } = loadOperatorIdentity();

    // The (workspace_id, token_prefix) index is unique; retry on the rare clash.
    let generated: ReturnType<typeof generateUserTokenSecret> | null = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = generateUserTokenSecret();
      const clash = db
        .prepare('SELECT 1 FROM user_tokens WHERE workspace_id = ? AND token_prefix = ?')
        .get(WORKSPACE.id, candidate.prefix);
      if (!clash) {
        generated = candidate;
        break;
      }
    }
    if (!generated) throw new ApiError(409, 'Could not allocate a unique token prefix; try again');

    const id = newId();
    const now = nowIso();
    db.prepare(
      `INSERT INTO user_tokens (
         id, workspace_id, user_id, workspace_user_id, label,
         token_prefix, token_hash, hash_algorithm, status, expires_at,
         last_used_context_json, metadata_json, created_at, updated_at, revision
       ) VALUES (
         @id, @workspace_id, @user_id, @workspace_user_id, @label,
         @token_prefix, @token_hash, @hash_algorithm, 'active', @expires_at,
         '{}', '{}', @now, @now, 1
       )`
    ).run({
      id,
      workspace_id: WORKSPACE.id,
      user_id: userId,
      workspace_user_id: workspaceUserId,
      label,
      token_prefix: generated.prefix,
      token_hash: generated.hash,
      hash_algorithm: USER_TOKEN_HASH_ALGORITHM,
      expires_at: expiresAt,
      now
    });

    recordChange({
      entityType: 'user_token',
      entityId: id,
      operation: 'insert',
      entityRevision: 1
    });

    return { token: toUserTokenDto(reloadUserToken(id)), secret: generated.secret };
  }
);

export const renameUserToken = db.transaction(
  (id: string, body: UpdateUserTokenBody): UserTokenDto => {
    const existing = loadUserTokenForUpdate(id);
    const label = body.label?.trim();
    if (!label) throw new ApiError(400, 'Token label cannot be empty');

    const now = nowIso();
    const revision = existing.revision + 1;
    db.prepare(
      `UPDATE user_tokens SET label = @label, updated_at = @now, revision = @revision
         WHERE id = @id AND workspace_id = @workspace_id`
    ).run({ id, workspace_id: WORKSPACE.id, label, now, revision });

    recordChange({
      entityType: 'user_token',
      entityId: id,
      operation: 'update',
      entityRevision: revision,
      changedFields: ['label']
    });

    return toUserTokenDto(reloadUserToken(id));
  }
);

export const revokeUserToken = db.transaction((id: string): UserTokenDto => {
  const existing = loadUserTokenForUpdate(id);
  // Revocation is idempotent: revoking an already-revoked token is a no-op.
  if (existing.status === 'revoked') return toUserTokenDto(reloadUserToken(id));

  const { workspaceUserId } = loadOperatorIdentity();
  const now = nowIso();
  const revision = existing.revision + 1;
  db.prepare(
    `UPDATE user_tokens
        SET status = 'revoked', revoked_at = @now,
            revoked_by_workspace_user_id = @actor,
            updated_at = @now, revision = @revision
      WHERE id = @id AND workspace_id = @workspace_id`
  ).run({ id, workspace_id: WORKSPACE.id, now, actor: workspaceUserId, revision });

  recordChange({
    entityType: 'user_token',
    entityId: id,
    operation: 'update',
    entityRevision: revision,
    changedFields: ['status', 'revoked_at']
  });

  return toUserTokenDto(reloadUserToken(id));
});
