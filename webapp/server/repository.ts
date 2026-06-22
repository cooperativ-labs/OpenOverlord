import { scopeGrantsForPreset } from '@overlord/auth';
import { previewTicketBranch, ticketWorktreePath } from '@overlord/automations';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readRepositoryTree, RepositoryReadError } from '../../src/repository/git-tree.ts';
import { ensureLocalExecutionTarget } from '../../src/service/execution-targets.ts';
import { writeProjectJson } from '../../src/service/projects.ts';
import type {
  ArtifactDto,
  CreateObjectiveBody,
  CreateProjectBody,
  CreateProjectResourceBody,
  CreateProjectTagBody,
  CreateTicketBody,
  CreateUserTokenBody,
  CreateUserTokenResultDto,
  CreateWorkspaceStatusBody,
  FileChangeDto,
  MyTicketDto,
  MyTicketReorderRequest,
  MyTicketsResponse,
  ObjectiveDto,
  ProfileDto,
  ProjectDto,
  ProjectRepositoryDto,
  ProjectResourceDto,
  ProjectTagDto,
  ReorderBoardColumnBody,
  ReorderFutureObjectivesBody,
  ReorderWorkspaceStatusesBody,
  StatusType,
  TicketBranchDto,
  TicketDetailDto,
  TicketDto,
  TicketEventDto,
  TokenScope,
  UpdateObjectiveBody,
  UpdateProfileBody,
  UpdateProjectBody,
  UpdateProjectResourceBody,
  UpdateProjectTagBody,
  UpdateTicketBody,
  UpdateUserTokenBody,
  UpdateWorkspaceStatusBody,
  UserTokenDto,
  WorkspaceStatusDto
} from '../shared/contract.ts';

import { ACTOR_WORKSPACE_USER_ID, db, newId, nowIso, recordChange, WORKSPACE } from './db.ts';
import { ApiError } from './errors.ts';
import {
  dequeueObjective,
  getLaunchPreference,
  LAUNCHABLE_STATES,
  listTicketExecutionRequests
} from './launch.ts';
import { loadActorRoles } from './rbac.ts';
import {
  initialTitleFromInstruction,
  scheduleObjectiveTitleGeneration,
  scheduleTicketTitleGeneration
} from './title-automation.ts';

export { ApiError };

// The default workflow seeded for every new project. The schema enforces (via
// partial unique indexes) at most one default, one `execute`, and one `review`
// status per project, so this set is intentionally one of each.
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

interface WorkspaceStatusRow {
  id: string;
  workspace_id: string;
  key: string;
  name: string;
  type: string;
  position: number;
  is_default: number;
  is_terminal: number;
  revision: number;
}

const STATUS_TYPES: StatusType[] = [
  'draft',
  'execute',
  'review',
  'complete',
  'blocked',
  'cancelled'
];

function assertValidStatusType(type: string): StatusType {
  if (!STATUS_TYPES.includes(type as StatusType)) {
    throw new ApiError(400, 'Invalid status type');
  }
  return type as StatusType;
}

function isTerminalStatusType(type: StatusType): boolean {
  return type === 'complete' || type === 'cancelled';
}

function uniqueStatusKey({ name }: { name: string }): string {
  const base = slugify(name).replace(/-/g, '_');
  let key = base;
  let suffix = 2;
  while (
    db
      .prepare(`SELECT 1 FROM workspace_statuses WHERE workspace_id = ? AND key = ?`)
      .get(WORKSPACE.id, key)
  ) {
    key = `${base}_${suffix}`;
    suffix += 1;
  }
  return key;
}

function getWorkspaceStatusRow(statusId: string): WorkspaceStatusRow {
  const row = db
    .prepare(
      `SELECT id, workspace_id, key, name, type, position, is_default, is_terminal, revision
         FROM workspace_statuses
        WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
    )
    .get(statusId, WORKSPACE.id) as WorkspaceStatusRow | undefined;
  if (!row) throw new ApiError(404, 'Status not found');
  return row;
}

function assertUniqueStatusName({
  name,
  excludeStatusId
}: {
  name: string;
  excludeStatusId?: string;
}): void {
  const existing = db
    .prepare(
      `SELECT 1 FROM workspace_statuses
        WHERE workspace_id = ? AND deleted_at IS NULL AND lower(name) = lower(?)
          AND id != ?`
    )
    .get(WORKSPACE.id, name, excludeStatusId ?? '');
  if (existing) throw new ApiError(409, `A status named "${name}" already exists`);
}

function countActiveStatusesByType({ type }: { type: string }): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM workspace_statuses
        WHERE workspace_id = ? AND type = ? AND deleted_at IS NULL`
    )
    .get(WORKSPACE.id, type) as { count: number };
  return row.count;
}

function countTicketsOnStatus(statusId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM tickets WHERE status_id = ? AND deleted_at IS NULL`)
    .get(statusId) as { count: number };
  return row.count;
}

function clearWorkspaceDefaultStatuses({ now }: { now: string }): void {
  db.prepare(
    `UPDATE workspace_statuses
        SET is_default = 0, updated_at = @now, revision = revision + 1
      WHERE workspace_id = @workspace_id AND is_default = 1 AND deleted_at IS NULL`
  ).run({ workspace_id: WORKSPACE.id, now });
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
  active_branch: string | null;
  objective_count: number;
  completed_objective_count: number;
  has_executing_objective: number;
  has_completed_objective: number;
  has_pending_objective_with_instructions: number;
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
  external_session_id?: string | null;
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

function toStatusDto(r: WorkspaceStatusRow): WorkspaceStatusDto {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    key: r.key,
    name: r.name,
    type: r.type as StatusType,
    position: r.position,
    isDefault: r.is_default === 1,
    isTerminal: r.is_terminal === 1
  };
}

function toProjectResourceDto(r: ProjectResourceRow): ProjectResourceDto {
  const status = r.status === 'archived' ? 'archived' : existsSync(r.path) ? 'active' : 'missing';
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    projectId: r.project_id,
    executionTargetId: r.execution_target_id,
    type: r.type as ProjectResourceDto['type'],
    label: r.label,
    path: r.path,
    isPrimary: r.is_primary === 1,
    status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    revision: r.revision
  };
}

function executionTargetBelongsToWorkspace(executionTargetId: string): boolean {
  const row = db
    .prepare(
      `SELECT id FROM execution_targets
        WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
    )
    .get(executionTargetId, WORKSPACE.id) as { id: string } | undefined;
  return Boolean(row);
}

function resolveResourceExecutionTargetId(
  executionTargetId: string | null | undefined
): string | null {
  if (executionTargetId === undefined) {
    return ensureLocalExecutionTarget({
      ctx: {
        db,
        workspace: { id: WORKSPACE.id, slug: WORKSPACE.slug, name: WORKSPACE.name },
        actorWorkspaceUserId: ACTOR_WORKSPACE_USER_ID,
        source: 'webapp'
      }
    }).executionTargetId;
  }

  if (executionTargetId === null) return null;

  const trimmed = executionTargetId.trim();
  if (!trimmed) return null;
  if (!executionTargetBelongsToWorkspace(trimmed)) {
    throw new ApiError(404, 'Execution target not found');
  }
  return trimmed;
}

function getProjectResourceRow(projectId: string, resourceId: string): ProjectResourceRow {
  getProject(projectId);
  const row = db
    .prepare(
      `SELECT id, workspace_id, project_id, execution_target_id, type, label, path,
              is_primary, status, created_at, updated_at, revision
         FROM project_resources
        WHERE id = ? AND project_id = ? AND deleted_at IS NULL`
    )
    .get(resourceId, projectId) as ProjectResourceRow | undefined;
  if (!row) throw new ApiError(404, 'Resource not found');
  return row;
}

function clearPrimaryResourcesForTarget({
  projectId,
  executionTargetId,
  now
}: {
  projectId: string;
  executionTargetId: string | null;
  now: string;
}): void {
  const targetPredicate =
    executionTargetId === null
      ? 'execution_target_id IS NULL'
      : 'execution_target_id = @execution_target_id';
  db.prepare(
    `UPDATE project_resources
        SET is_primary = 0, updated_at = @now, revision = revision + 1
      WHERE project_id = @project_id
        AND deleted_at IS NULL
        AND is_primary = 1
        AND ${targetPredicate}`
  ).run({ project_id: projectId, execution_target_id: executionTargetId, now });
}

function promoteFallbackPrimary({
  projectId,
  executionTargetId,
  now
}: {
  projectId: string;
  executionTargetId: string | null;
  now: string;
}): void {
  const targetPredicate =
    executionTargetId === null
      ? 'execution_target_id IS NULL'
      : 'execution_target_id = @execution_target_id';
  const fallback = db
    .prepare(
      `SELECT id FROM project_resources
        WHERE project_id = @project_id
          AND deleted_at IS NULL
          AND ${targetPredicate}
        ORDER BY created_at ASC
        LIMIT 1`
    )
    .get({ project_id: projectId, execution_target_id: executionTargetId }) as
    | { id: string }
    | undefined;
  if (!fallback) return;

  db.prepare(
    `UPDATE project_resources
        SET is_primary = 1, updated_at = @now, revision = revision + 1
      WHERE id = @id`
  ).run({ id: fallback.id, now });
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

function toTicketDto(r: TicketRow, tags: ProjectTagDto[] = []): TicketDto {
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
    objectiveCount: r.objective_count,
    completedObjectiveCount: r.completed_objective_count,
    hasExecutingObjective: r.has_executing_objective === 1,
    hasCompletedObjective: r.has_completed_objective === 1,
    hasPendingObjectiveWithInstructions: r.has_pending_objective_with_instructions === 1,
    tags
  };
}

function resolveWorktreeRoot(): string {
  const override = process.env.OVERLORD_WORKTREE_ROOT?.trim();
  if (override) return path.resolve(override);
  const home = process.env.OVLD_HOME?.trim() || process.env.OVERLORD_HOME?.trim();
  return path.join(home ? path.resolve(home) : path.join(os.homedir(), '.ovld'), 'worktrees');
}

function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 2 * 1024 * 1024
    }).trim();
  } catch {
    return '';
  }
}

function branchIsMerged({
  projectId,
  branchName,
  baseBranch
}: {
  projectId: string;
  branchName: string;
  baseBranch: string | null;
}): boolean {
  if (!baseBranch) return false;
  const resource = db
    .prepare(
      `SELECT path FROM project_resources
        WHERE project_id = ? AND workspace_id = ? AND is_primary = 1
          AND status = 'active' AND deleted_at IS NULL
        ORDER BY created_at ASC
        LIMIT 1`
    )
    .get(projectId, WORKSPACE.id) as { path: string } | undefined;
  if (!resource || !existsSync(resource.path)) return false;
  const localExists = runGit(resource.path, ['show-ref', '--verify', `refs/heads/${branchName}`]);
  const remoteExists = runGit(resource.path, [
    'show-ref',
    '--verify',
    `refs/remotes/origin/${branchName}`
  ]);
  if (!localExists && !remoteExists) return true;
  const localMerged = runGit(resource.path, [
    'branch',
    '--merged',
    baseBranch,
    '--format=%(refname:short)'
  ])
    .split('\n')
    .map(line => line.trim());
  const remoteMerged = runGit(resource.path, [
    'branch',
    '-r',
    '--merged',
    `origin/${baseBranch}`,
    '--format=%(refname:short)'
  ])
    .split('\n')
    .map(line => line.trim().replace(/^origin\//, ''));
  return localMerged.includes(branchName) || remoteMerged.includes(branchName);
}

function getProjectSlug(projectId: string): string {
  const row = db
    .prepare(`SELECT slug FROM projects WHERE id = ? AND workspace_id = ?`)
    .get(projectId, WORKSPACE.id) as { slug: string } | undefined;
  return row?.slug ?? 'project';
}

// Derives the ticket-panel branch metadata from `tickets.active_branch` (the
// source of truth the runner writes). When it is null no branch has been
// prepared yet, so we surface the planner's predicted name with a pending status.
function ticketBranchDto(row: TicketRow): TicketBranchDto {
  const projectSlug = getProjectSlug(row.project_id);
  const worktreeRoot = resolveWorktreeRoot();
  const name = row.active_branch?.trim();
  if (name) {
    const baseBranch = 'main';
    return {
      name,
      baseBranch,
      worktreePath: ticketWorktreePath({ worktreeRoot, projectSlug, branch: name }),
      status: branchIsMerged({ projectId: row.project_id, branchName: name, baseBranch })
        ? 'merged'
        : 'active'
    };
  }

  const preview = previewTicketBranch({
    ticket: { title: row.title, sequence: row.sequence_number },
    project: { slug: projectSlug },
    base: 'main',
    worktreeRoot
  });
  return {
    name: preview.branch,
    baseBranch: preview.baseBranch,
    worktreePath: preview.worktreePath,
    status: 'pending'
  };
}

interface ProjectTagRow {
  id: string;
  workspace_id: string;
  project_id: string;
  label: string;
  color: string | null;
  active: number;
  revision: number;
}

function toProjectTagDto(r: ProjectTagRow): ProjectTagDto {
  return {
    id: r.id,
    projectId: r.project_id,
    label: r.label,
    color: r.color,
    active: r.active === 1
  };
}

/** Tags assigned to one ticket, ordered by label for stable rendering. */
function getTicketTags(ticketId: string): ProjectTagDto[] {
  const rows = db
    .prepare(
      `SELECT pt.id, pt.workspace_id, pt.project_id, pt.label, pt.color, pt.active, pt.revision
         FROM ticket_tags tt
         JOIN project_tags pt ON pt.id = tt.tag_id AND pt.deleted_at IS NULL
        WHERE tt.ticket_id = ?
        ORDER BY pt.label COLLATE NOCASE ASC`
    )
    .all(ticketId) as ProjectTagRow[];
  return rows.map(toProjectTagDto);
}

/**
 * Batch-resolve tags for many tickets in one query, returning a map keyed by
 * ticket id so board/list reads avoid an N+1 of per-ticket tag lookups.
 */
function getTagsByTicket(ticketIds: string[]): Map<string, ProjectTagDto[]> {
  const byTicket = new Map<string, ProjectTagDto[]>();
  if (ticketIds.length === 0) return byTicket;
  const placeholders = ticketIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT tt.ticket_id, pt.id, pt.workspace_id, pt.project_id, pt.label, pt.color, pt.active, pt.revision
         FROM ticket_tags tt
         JOIN project_tags pt ON pt.id = tt.tag_id AND pt.deleted_at IS NULL
        WHERE tt.ticket_id IN (${placeholders})
        ORDER BY pt.label COLLATE NOCASE ASC`
    )
    .all(...ticketIds) as Array<ProjectTagRow & { ticket_id: string }>;
  for (const row of rows) {
    const list = byTicket.get(row.ticket_id) ?? [];
    list.push(toProjectTagDto(row));
    byTicket.set(row.ticket_id, list);
  }
  return byTicket;
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
    revision: r.revision,
    externalSessionId: r.external_session_id ?? null
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

export function listWorkspaceStatuses(): WorkspaceStatusDto[] {
  const rows = db
    .prepare(
      `SELECT id, workspace_id, key, name, type, position, is_default, is_terminal, revision
         FROM workspace_statuses
        WHERE workspace_id = ? AND deleted_at IS NULL
        ORDER BY position ASC`
    )
    .all(WORKSPACE.id) as WorkspaceStatusRow[];
  return rows.map(toStatusDto);
}

export const createWorkspaceStatus = db.transaction(
  (body: CreateWorkspaceStatusBody): WorkspaceStatusDto => {
    const name = (body.name ?? '').trim();
    if (!name) throw new ApiError(400, 'Status name is required');
    assertUniqueStatusName({ name });

    const type = assertValidStatusType(body.type);
    if (type === 'execute' || type === 'review') {
      if (countActiveStatusesByType({ type }) > 0) {
        throw new ApiError(409, `This workspace already has a ${type} status`);
      }
    }

    const isDefault = body.isDefault ?? false;
    if (isDefault && type !== 'draft') {
      throw new ApiError(400, 'Only draft-type statuses can be the default');
    }

    const now = nowIso();
    const id = newId();
    const key = uniqueStatusKey({ name });
    const maxPos = db
      .prepare(
        `SELECT COALESCE(MAX(position), -1) AS max_pos FROM workspace_statuses
          WHERE workspace_id = ? AND deleted_at IS NULL`
      )
      .get(WORKSPACE.id) as { max_pos: number };
    const position = maxPos.max_pos + 1;

    if (isDefault) {
      clearWorkspaceDefaultStatuses({ now });
    }

    db.prepare(
      `INSERT INTO workspace_statuses
         (id, workspace_id, key, name, type, position, is_default, is_terminal,
          created_at, updated_at, revision)
       VALUES (@id, @workspace_id, @key, @name, @type, @position, @is_default, @is_terminal,
          @now, @now, 1)`
    ).run({
      id,
      workspace_id: WORKSPACE.id,
      key,
      name,
      type,
      position,
      is_default: isDefault ? 1 : 0,
      is_terminal: isTerminalStatusType(type) ? 1 : 0,
      now
    });

    recordChange({
      entityType: 'workspace_status',
      entityId: id,
      operation: 'insert',
      entityRevision: 1,
      changedFields: ['name', 'type', 'position', ...(isDefault ? ['is_default'] : [])]
    });

    return toStatusDto(getWorkspaceStatusRow(id));
  }
);

export const updateWorkspaceStatus = db.transaction(
  (statusId: string, body: UpdateWorkspaceStatusBody): WorkspaceStatusDto => {
    const existing = getWorkspaceStatusRow(statusId);
    const changed: string[] = [];
    const now = nowIso();
    const fields: string[] = [];
    const params: Record<string, unknown> = { id: statusId, workspace_id: WORKSPACE.id };

    if (body.name !== undefined) {
      const name = body.name.trim();
      if (!name) throw new ApiError(400, 'Status name cannot be empty');
      assertUniqueStatusName({ name, excludeStatusId: statusId });
      fields.push('name = @name');
      params.name = name;
      changed.push('name');
    }

    if (body.isDefault !== undefined) {
      if (body.isDefault) {
        if (existing.type !== 'draft') {
          throw new ApiError(400, 'Only draft-type statuses can be the default');
        }
        clearWorkspaceDefaultStatuses({ now });
        fields.push('is_default = 1');
        changed.push('is_default');
      } else if (existing.is_default === 1) {
        throw new ApiError(409, 'Choose another status as the default before clearing this one');
      }
    }

    if (fields.length === 0) {
      return toStatusDto(existing);
    }

    const revision = existing.revision + 1;
    db.prepare(
      `UPDATE workspace_statuses
          SET ${fields.join(', ')}, updated_at = @now, revision = @revision
        WHERE id = @id AND workspace_id = @workspace_id AND deleted_at IS NULL`
    ).run({ ...params, now, revision });

    recordChange({
      entityType: 'workspace_status',
      entityId: statusId,
      operation: 'update',
      entityRevision: revision,
      changedFields: changed
    });

    return toStatusDto(getWorkspaceStatusRow(statusId));
  }
);

export const deleteWorkspaceStatus = db.transaction((statusId: string): void => {
  const existing = getWorkspaceStatusRow(statusId);

  if (existing.type === 'execute' || existing.type === 'review') {
    throw new ApiError(409, 'Cannot remove the required execute or review status');
  }
  if (existing.is_default === 1) {
    throw new ApiError(409, 'Set another status as the default before deleting this one');
  }

  const ticketCount = countTicketsOnStatus(statusId);
  if (ticketCount > 0) {
    throw new ApiError(
      409,
      `Cannot delete a status used by ${ticketCount} ticket(s). Move them first.`
    );
  }

  const now = nowIso();
  const revision = existing.revision + 1;
  db.prepare(
    `UPDATE workspace_statuses
        SET deleted_at = @now, updated_at = @now, revision = @revision
      WHERE id = @id AND workspace_id = @workspace_id AND deleted_at IS NULL`
  ).run({ id: statusId, workspace_id: WORKSPACE.id, now, revision });

  recordChange({
    entityType: 'workspace_status',
    entityId: statusId,
    operation: 'delete',
    entityRevision: revision,
    changedFields: ['deleted_at']
  });
});

export const reorderWorkspaceStatuses = db.transaction(
  (body: ReorderWorkspaceStatusesBody): WorkspaceStatusDto[] => {
    const orderedIds = body.orderedStatusIds;
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      throw new ApiError(400, 'orderedStatusIds is required');
    }

    const current = listWorkspaceStatuses();
    if (orderedIds.length !== current.length) {
      throw new ApiError(400, 'orderedStatusIds must include every status');
    }

    const currentIds = new Set(current.map(status => status.id));
    for (const id of orderedIds) {
      if (!currentIds.has(id)) {
        throw new ApiError(400, 'Unknown status in reorder list');
      }
    }

    const now = nowIso();
    const updatePosition = db.prepare(
      `UPDATE workspace_statuses
          SET position = @position, updated_at = @now, revision = revision + 1
        WHERE id = @id AND workspace_id = @workspace_id AND deleted_at IS NULL`
    );

    orderedIds.forEach((id, position) => {
      updatePosition.run({ position, now, id, workspace_id: WORKSPACE.id });
      recordChange({
        entityType: 'workspace_status',
        entityId: id,
        operation: 'update',
        changedFields: ['position']
      });
    });

    return listWorkspaceStatuses();
  }
);

// ---- Project tags --------------------------------------------------------

const selectProjectTagColumns = `id, workspace_id, project_id, label, color, active, revision`;

function getProjectTagRow(projectId: string, tagId: string): ProjectTagRow {
  getProject(projectId);
  const row = db
    .prepare(
      `SELECT ${selectProjectTagColumns} FROM project_tags
        WHERE id = ? AND project_id = ? AND workspace_id = ? AND deleted_at IS NULL`
    )
    .get(tagId, projectId, WORKSPACE.id) as ProjectTagRow | undefined;
  if (!row) throw new ApiError(404, 'Tag not found');
  return row;
}

export function listProjectTags(projectId: string): ProjectTagDto[] {
  getProject(projectId);
  const rows = db
    .prepare(
      `SELECT ${selectProjectTagColumns} FROM project_tags
        WHERE project_id = ? AND workspace_id = ? AND deleted_at IS NULL
        ORDER BY label COLLATE NOCASE ASC`
    )
    .all(projectId, WORKSPACE.id) as ProjectTagRow[];
  return rows.map(toProjectTagDto);
}

function normalizeTagColor(color: string | null | undefined): string | null {
  if (color === null || color === undefined) return null;
  const trimmed = color.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export const createProjectTag = db.transaction(
  (projectId: string, body: CreateProjectTagBody): ProjectTagDto => {
    getProject(projectId);
    const label = (body.label ?? '').trim();
    if (!label) throw new ApiError(400, 'Tag label cannot be empty');

    const duplicate = db
      .prepare(
        `SELECT 1 FROM project_tags
          WHERE project_id = ? AND label = ? AND deleted_at IS NULL`
      )
      .get(projectId, label);
    if (duplicate) throw new ApiError(409, 'A tag with this label already exists');

    const now = nowIso();
    const id = newId();
    db.prepare(
      `INSERT INTO project_tags
         (id, workspace_id, project_id, label, color, active, created_at, updated_at, revision)
       VALUES (@id, @workspace_id, @project_id, @label, @color, 1, @now, @now, 1)`
    ).run({
      id,
      workspace_id: WORKSPACE.id,
      project_id: projectId,
      label,
      color: normalizeTagColor(body.color),
      now
    });

    recordChange({
      entityType: 'project_tag',
      entityId: id,
      operation: 'insert',
      entityRevision: 1,
      projectId
    });

    return toProjectTagDto(getProjectTagRow(projectId, id));
  }
);

export const updateProjectTag = db.transaction(
  (projectId: string, tagId: string, body: UpdateProjectTagBody): ProjectTagDto => {
    const existing = getProjectTagRow(projectId, tagId);

    const fields: string[] = [];
    const params: Record<string, unknown> = { id: tagId, project_id: projectId };

    if (body.label !== undefined) {
      const label = body.label.trim();
      if (!label) throw new ApiError(400, 'Tag label cannot be empty');
      const duplicate = db
        .prepare(
          `SELECT 1 FROM project_tags
            WHERE project_id = ? AND label = ? AND id != ? AND deleted_at IS NULL`
        )
        .get(projectId, label, tagId);
      if (duplicate) throw new ApiError(409, 'A tag with this label already exists');
      fields.push('label = @label');
      params.label = label;
    }
    if (body.color !== undefined) {
      fields.push('color = @color');
      params.color = normalizeTagColor(body.color);
    }
    if (body.active !== undefined) {
      fields.push('active = @active');
      params.active = body.active ? 1 : 0;
    }
    if (fields.length === 0) return toProjectTagDto(existing);

    const now = nowIso();
    const revision = existing.revision + 1;
    db.prepare(
      `UPDATE project_tags SET ${fields.join(', ')}, updated_at = @now, revision = @revision
         WHERE id = @id AND project_id = @project_id`
    ).run({ ...params, now, revision });

    recordChange({
      entityType: 'project_tag',
      entityId: tagId,
      operation: 'update',
      entityRevision: revision,
      projectId
    });

    return toProjectTagDto(getProjectTagRow(projectId, tagId));
  }
);

export const deleteProjectTag = db.transaction((projectId: string, tagId: string): void => {
  const existing = getProjectTagRow(projectId, tagId);
  const now = nowIso();
  const revision = existing.revision + 1;
  // Soft-delete the definition; `ticket_tags` rows cascade away via the FK so the
  // tag disappears from any ticket that carried it.
  db.prepare(`DELETE FROM ticket_tags WHERE tag_id = ?`).run(tagId);
  db.prepare(
    `UPDATE project_tags SET deleted_at = @now, updated_at = @now, revision = @revision
       WHERE id = @id AND project_id = @project_id`
  ).run({ id: tagId, project_id: projectId, now, revision });

  recordChange({
    entityType: 'project_tag',
    entityId: tagId,
    operation: 'delete',
    entityRevision: revision,
    projectId
  });
});

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

export const createProjectResource = db.transaction(
  (projectId: string, body: CreateProjectResourceBody & { path?: string }): ProjectResourceDto => {
    const project = getProject(projectId);
    const resourcePath = (body.directoryPath ?? body.path ?? '').trim();
    if (!resourcePath) throw new ApiError(400, 'directoryPath is required');
    const executionTargetId = resolveResourceExecutionTargetId(body.executionTargetId);

    const now = nowIso();
    if (body.isPrimary !== false) {
      clearPrimaryResourcesForTarget({ projectId, executionTargetId, now });
    }

    const id = newId();
    db.prepare(
      `INSERT INTO project_resources
         (id, workspace_id, project_id, execution_target_id, type, label, path,
          is_primary, status, metadata_json, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, 'local_directory', ?, ?, ?, 'active', '{}', ?, ?, 1)`
    ).run(
      id,
      project.workspaceId,
      projectId,
      executionTargetId,
      body.label ?? null,
      resourcePath,
      body.isPrimary === false ? 0 : 1,
      now,
      now
    );

    writeProjectJson({
      directoryPath: resourcePath,
      projectId,
      resourceId: id,
      isPrimary: body.isPrimary !== false
    });

    recordChange({
      entityType: 'project_resource',
      entityId: id,
      operation: 'insert',
      entityRevision: 1,
      projectId,
      changedFields: ['path', 'is_primary']
    });

    const row = db
      .prepare(
        `SELECT id, workspace_id, project_id, execution_target_id, type, label, path,
                is_primary, status, created_at, updated_at, revision
           FROM project_resources
          WHERE id = ?`
      )
      .get(id) as ProjectResourceRow;
    return toProjectResourceDto(row);
  }
);

export const updateProjectResource = db.transaction(
  (projectId: string, resourceId: string, body: UpdateProjectResourceBody): ProjectResourceDto => {
    const existing = getProjectResourceRow(projectId, resourceId);
    const now = nowIso();

    if (body.isPrimary === true && existing.is_primary !== 1) {
      clearPrimaryResourcesForTarget({
        projectId,
        executionTargetId: existing.execution_target_id,
        now
      });
      db.prepare(
        `UPDATE project_resources
            SET is_primary = 1, updated_at = @now, revision = revision + 1
          WHERE id = @id`
      ).run({ id: resourceId, now });
      recordChange({
        entityType: 'project_resource',
        entityId: resourceId,
        operation: 'update',
        entityRevision: existing.revision + 1,
        projectId,
        changedFields: ['is_primary']
      });
    }

    return toProjectResourceDto(getProjectResourceRow(projectId, resourceId));
  }
);

export const deleteProjectResource = db.transaction(
  (projectId: string, resourceId: string): void => {
    const existing = getProjectResourceRow(projectId, resourceId);
    const now = nowIso();
    const revision = existing.revision + 1;

    db.prepare(
      `UPDATE project_resources
        SET deleted_at = @now, updated_at = @now, revision = @revision
      WHERE id = @id`
    ).run({ id: resourceId, now, revision });

    if (existing.is_primary === 1) {
      promoteFallbackPrimary({
        projectId,
        executionTargetId: existing.execution_target_id,
        now
      });
    }

    recordChange({
      entityType: 'project_resource',
      entityId: resourceId,
      operation: 'delete',
      entityRevision: revision,
      projectId
    });
  }
);

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

  // Card statuses live at the workspace level (`workspace_statuses`) and are
  // seeded once per workspace, so creating a project no longer seeds statuses.

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

export const deleteProject = db.transaction((id: string): void => {
  const existing = db
    .prepare(
      `SELECT id, revision FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
    )
    .get(id, WORKSPACE.id) as { id: string; revision: number } | undefined;
  if (!existing) throw new ApiError(404, 'Project not found');

  const now = nowIso();
  const revision = existing.revision + 1;

  // Cascade soft-delete to tickets and their objectives.
  const ticketIds = (
    db
      .prepare(
        `SELECT id FROM tickets WHERE project_id = ? AND workspace_id = ? AND deleted_at IS NULL`
      )
      .all(id, WORKSPACE.id) as { id: string }[]
  ).map(r => r.id);

  for (const ticketId of ticketIds) {
    db.prepare(
      `UPDATE objectives SET deleted_at = @now, revision = revision + 1
         WHERE ticket_id = @ticketId AND deleted_at IS NULL`
    ).run({ ticketId, now });
  }

  if (ticketIds.length > 0) {
    db.prepare(
      `UPDATE tickets SET deleted_at = @now, revision = revision + 1
         WHERE project_id = @id AND workspace_id = @workspace_id AND deleted_at IS NULL`
    ).run({ id, workspace_id: WORKSPACE.id, now });
  }

  db.prepare(
    `UPDATE projects SET deleted_at = @now, updated_at = @now, revision = @revision
       WHERE id = @id AND workspace_id = @workspace_id`
  ).run({ id, workspace_id: WORKSPACE.id, now, revision });

  recordChange({
    entityType: 'project',
    entityId: id,
    operation: 'delete',
    entityRevision: revision,
    projectId: id
  });
});

// ---- Tickets -------------------------------------------------------------

const selectTicketsSql = `
  SELECT t.id, t.workspace_id, t.project_id, t.display_id, t.sequence_number, t.title,
         t.status_id, t.status_type, t.board_position, t.priority,
         t.assigned_workspace_user_id,
         t.acceptance_criteria_text, t.available_tools_json,
         t.created_at, t.updated_at, t.revision, t.active_branch,
         (SELECT COUNT(*) FROM objectives o
            WHERE o.ticket_id = t.id AND o.deleted_at IS NULL) AS objective_count,
         (SELECT COUNT(*) FROM objectives o
            WHERE o.ticket_id = t.id AND o.deleted_at IS NULL AND o.state = 'complete')
            AS completed_objective_count,
         (SELECT COUNT(*) > 0 FROM objectives o
            WHERE o.ticket_id = t.id AND o.deleted_at IS NULL AND o.state = 'executing')
            AS has_executing_objective,
         (SELECT COUNT(*) > 0 FROM objectives o
            WHERE o.ticket_id = t.id AND o.deleted_at IS NULL AND o.state = 'complete')
            AS has_completed_objective,
         (SELECT COUNT(*) > 0 FROM objectives o
            WHERE o.ticket_id = t.id AND o.deleted_at IS NULL
              AND o.state IN ('draft', 'future') AND TRIM(o.instruction_text) != '')
            AS has_pending_objective_with_instructions
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
  const tagsByTicket = getTagsByTicket(rows.map(row => row.id));
  return rows.map(row => toTicketDto(row, tagsByTicket.get(row.id) ?? []));
}

/**
 * Turn free-form input into an FTS5 MATCH expression: lowercase alphanumeric
 * runs become OR-combined prefix tokens. Lowercasing also neutralises FTS5's
 * uppercase boolean keywords, and stripping to alphanumeric runs keeps the
 * expression injection-safe. Returns null when there is nothing to match.
 */
function buildTicketSearchMatch(query: string): string | null {
  const terms = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (terms.length === 0) return null;
  return terms.map(term => `${term}*`).join(' OR ');
}

/**
 * Full-text ticket search ranked across ticket titles, objective text, and
 * ticket-event summaries via the `search_documents` FTS index. Every matched
 * document is scored (title column and ticket-kind weighted highest), then the
 * scores are summed per ticket. Mirrors the CLI/protocol `searchTickets` service
 * so both surfaces rank identically. An empty query lists recent tickets.
 */
export function searchTickets({
  query,
  projectId,
  limit = 25
}: {
  query?: string | null;
  projectId?: string | null;
  limit?: number;
}): TicketDto[] {
  const match = query?.trim() ? buildTicketSearchMatch(query.trim()) : null;

  if (!match) {
    const sql = projectId
      ? `${selectTicketsSql} AND t.project_id = @project_id ORDER BY t.updated_at DESC LIMIT @limit`
      : `${selectTicketsSql} ORDER BY t.updated_at DESC LIMIT @limit`;
    const rows = db
      .prepare(sql)
      .all({ workspace_id: WORKSPACE.id, project_id: projectId ?? null, limit }) as TicketRow[];
    const tagsByTicket = getTagsByTicket(rows.map(row => row.id));
    return rows.map(row => toTicketDto(row, tagsByTicket.get(row.id) ?? []));
  }

  const projectFilter = projectId ? ' AND t.project_id = @project_id' : '';
  const rows = db
    .prepare(
      `SELECT t.id, t.workspace_id, t.project_id, t.display_id, t.sequence_number, t.title,
              t.status_id, t.status_type, t.board_position, t.priority,
              t.assigned_workspace_user_id,
              t.acceptance_criteria_text, t.available_tools_json,
              t.created_at, t.updated_at, t.revision,
              (SELECT COUNT(*) FROM objectives o
                 WHERE o.ticket_id = t.id AND o.deleted_at IS NULL) AS objective_count,
              (SELECT COUNT(*) FROM objectives o
                 WHERE o.ticket_id = t.id AND o.deleted_at IS NULL AND o.state = 'complete')
                 AS completed_objective_count,
              (SELECT COUNT(*) > 0 FROM objectives o
                 WHERE o.ticket_id = t.id AND o.deleted_at IS NULL AND o.state = 'executing')
                 AS has_executing_objective,
              (SELECT COUNT(*) > 0 FROM objectives o
                 WHERE o.ticket_id = t.id AND o.deleted_at IS NULL AND o.state = 'complete')
                 AS has_completed_objective,
              (SELECT COUNT(*) > 0 FROM objectives o
                 WHERE o.ticket_id = t.id AND o.deleted_at IS NULL
                   AND o.state IN ('draft', 'future') AND TRIM(o.instruction_text) != '')
                 AS has_pending_objective_with_instructions,
              (CASE search_documents_fts.entity_type
                 WHEN 'ticket' THEN 3.0 WHEN 'objective' THEN 2.0 ELSE 1.0 END)
                * (-bm25(search_documents_fts, 10.0, 1.0)) AS doc_score
         FROM search_documents_fts
         JOIN tickets t ON t.id = search_documents_fts.ticket_id
           AND t.workspace_id = @workspace_id AND t.deleted_at IS NULL${projectFilter}
        WHERE search_documents_fts MATCH @match`
    )
    .all({ workspace_id: WORKSPACE.id, project_id: projectId ?? null, match }) as Array<
    TicketRow & { doc_score: number }
  >;

  // Aggregate per-document scores into one relevance per ticket, then rank.
  const byTicket = new Map<string, { row: TicketRow; relevance: number }>();
  for (const row of rows) {
    const existing = byTicket.get(row.id);
    if (existing) {
      existing.relevance += row.doc_score;
      continue;
    }
    byTicket.set(row.id, { row, relevance: row.doc_score });
  }

  const ranked = [...byTicket.values()]
    .sort(
      (left, right) =>
        right.relevance - left.relevance || right.row.updated_at.localeCompare(left.row.updated_at)
    )
    .slice(0, limit);
  const tagsByTicket = getTagsByTicket(ranked.map(entry => entry.row.id));
  return ranked.map(entry => toTicketDto(entry.row, tagsByTicket.get(entry.row.id) ?? []));
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

function getWorkspaceStatus(statusId: string): WorkspaceStatusRow {
  const statusRow = db
    .prepare(
      `SELECT * FROM workspace_statuses WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
    )
    .get(statusId, WORKSPACE.id) as WorkspaceStatusRow | undefined;
  if (!statusRow) throw new ApiError(400, 'Unknown status for workspace');
  return statusRow;
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

function getTicketRow(ticketRef: string): TicketRow {
  const byId = db
    .prepare(`${selectTicketsSql} AND t.id = @id`)
    .get({ workspace_id: WORKSPACE.id, id: ticketRef }) as TicketRow | undefined;
  if (byId) return byId;

  const byDisplayId = db
    .prepare(`${selectTicketsSql} AND t.display_id = @display_id`)
    .get({ workspace_id: WORKSPACE.id, display_id: ticketRef }) as TicketRow | undefined;
  if (byDisplayId) return byDisplayId;

  throw new ApiError(404, 'Ticket not found');
}

export function getTicketDetail(ticketRef: string): TicketDetailDto {
  const row = getTicketRow(ticketRef);
  const ticket = toTicketDto(row, getTicketTags(row.id));
  const objectives = listObjectives(row.id);
  const statuses = listWorkspaceStatuses();
  const executionRequests = listTicketExecutionRequests(row.id);
  return { ...ticket, objectives, statuses, executionRequests, branch: ticketBranchDto(row) };
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
export function listTicketEvents(ticketRef: string, limit = 200): TicketEventDto[] {
  const ticket = getTicketRow(ticketRef);
  const rows = db
    .prepare(
      `SELECT id, ticket_id, objective_id, type, phase, summary, source, external_url, created_at
         FROM ticket_events
        WHERE ticket_id = @ticket_id AND workspace_id = @workspace_id
        ORDER BY created_at DESC, id DESC
        LIMIT @limit`
    )
    .all({ ticket_id: ticket.id, workspace_id: WORKSPACE.id, limit }) as TicketEventRow[];
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
export function listTicketFileChanges(ticketRef: string, limit = 200): FileChangeDto[] {
  const ticket = getTicketRow(ticketRef);
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
    .all({ ticket_id: ticket.id, workspace_id: WORKSPACE.id, limit }) as FileChangeRow[];
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

export function listArtifacts(ticketRef: string, limit = 200): ArtifactDto[] {
  const ticket = getTicketRow(ticketRef);
  const rows = db
    .prepare(
      `SELECT id, workspace_id, project_id, ticket_id, objective_id, session_id, delivery_id,
              type, label, content_text, content_json, external_url, created_at, updated_at
         FROM artifacts
        WHERE ticket_id = @ticket_id AND workspace_id = @workspace_id AND deleted_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT @limit`
    )
    .all({ ticket_id: ticket.id, workspace_id: WORKSPACE.id, limit }) as ArtifactRow[];
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
  objectiveIds: string[];
  instruction: string;
};

const createTicketTx = db.transaction((body: CreateTicketBody): CreateTicketResult => {
  const objectiveInputs =
    body.objectives && body.objectives.length > 0
      ? body.objectives
      : body.firstObjective
        ? [{ objective: body.firstObjective }]
        : [];
  const instruction = (objectiveInputs[0]?.objective ?? body.title ?? '').trim();
  if (!instruction) {
    throw new ApiError(400, 'Describe the work to be done (title or first objective)');
  }

  const title = (body.title ?? '').trim() || initialTitleFromInstruction(instruction);

  const project = db
    .prepare(`SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`)
    .get(body.projectId, WORKSPACE.id) as { id: string } | undefined;
  if (!project) throw new ApiError(404, 'Project not found');

  // Resolve the target status: explicit choice or the workspace's default.
  let statusRow: WorkspaceStatusRow | undefined;
  if (body.statusId) {
    statusRow = db
      .prepare(
        `SELECT * FROM workspace_statuses WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
      )
      .get(body.statusId, WORKSPACE.id) as WorkspaceStatusRow | undefined;
    if (!statusRow) throw new ApiError(400, 'Unknown status for workspace');
  } else {
    statusRow = db
      .prepare(
        `SELECT * FROM workspace_statuses
           WHERE workspace_id = ? AND is_default = 1 AND deleted_at IS NULL LIMIT 1`
      )
      .get(WORKSPACE.id) as WorkspaceStatusRow | undefined;
    if (!statusRow) throw new ApiError(409, 'Workspace has no default status');
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
  const assignedWorkspaceUserId =
    body.assignedWorkspaceUserId === undefined
      ? ACTOR_WORKSPACE_USER_ID
      : resolveAssignedWorkspaceUserId(body.assignedWorkspaceUserId);

  db.prepare(
    `INSERT INTO tickets
       (id, workspace_id, project_id, display_id, sequence_number, title,
        status_id, status_type, board_position, priority, available_tools_json, execution_target_intent_json,
        metadata_json, created_by_workspace_user_id, assigned_workspace_user_id, created_at, updated_at, revision)
     VALUES (@id, @ws, @project_id, @display_id, @sequence, @title,
        @status_id, @status_type, @board_position, @priority, '[]', '{}',
        '{}', @actor, @assigned_workspace_user_id, @now, @now, 1)`
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
    assigned_workspace_user_id: assignedWorkspaceUserId,
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

  const objectiveIds: string[] = [];
  for (const item of objectiveInputs) {
    if (!item.objective.trim()) {
      throw new ApiError(400, 'Objective instruction is required');
    }
    const objective = insertObjective({
      ticketId: id,
      instructionText: item.objective,
      ...(item.title !== undefined ? { title: item.title ?? undefined } : {}),
      autoAdvance: item.autoAdvance ?? false
    });
    objectiveIds.push(objective.id);
  }

  assignTicketTags({ ticketId: id, projectId: body.projectId, tagIds: body.tagIds, now });

  return { detail: getTicketDetail(id), objectiveIds, instruction };
});

/**
 * Assign tag definitions to a ticket. De-duplicates the input and validates that
 * every tag belongs to the ticket's project (and is not soft-deleted) so a ticket
 * can never carry a foreign-project tag. Intended to run inside the create
 * transaction. Unknown or cross-project tag ids raise a 400.
 */
function assignTicketTags({
  ticketId,
  projectId,
  tagIds,
  now
}: {
  ticketId: string;
  projectId: string;
  tagIds: string[] | undefined;
  now: string;
}): void {
  if (!tagIds || tagIds.length === 0) return;
  const unique = [...new Set(tagIds.map(value => value.trim()).filter(Boolean))];
  if (unique.length === 0) return;

  const insert = db.prepare(
    `INSERT OR IGNORE INTO ticket_tags (ticket_id, tag_id, created_at) VALUES (?, ?, ?)`
  );
  const lookup = db.prepare(
    `SELECT id FROM project_tags
       WHERE id = ? AND project_id = ? AND workspace_id = ? AND deleted_at IS NULL`
  );
  for (const tagId of unique) {
    const tag = lookup.get(tagId, projectId, WORKSPACE.id) as { id: string } | undefined;
    if (!tag) throw new ApiError(400, 'Tag does not belong to this project');
    insert.run(ticketId, tagId, now);
  }
}

export function createTicket(body: CreateTicketBody): TicketDetailDto {
  const { detail, objectiveIds, instruction } = createTicketTx(body);

  scheduleTicketTitleGeneration({
    ticketId: detail.id,
    projectId: detail.projectId,
    instructionText: instruction
  });

  const firstObjectiveId = objectiveIds[0];
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
      const statusRow = getWorkspaceStatus(body.statusId);
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
    statusRow: WorkspaceStatusRow;
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

    // Statuses are workspace-shared, so a cross-project move keeps the ticket's
    // current status unless the caller explicitly chooses a different one.
    const statusRow = getWorkspaceStatus(body.statusId ?? existing.status_id);

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
        `SELECT * FROM workspace_statuses WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
      )
      .get(statusId, WORKSPACE.id) as WorkspaceStatusRow | undefined;
    if (!statusRow) throw new ApiError(400, 'Unknown status for workspace');

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

// ---- My Tickets (selected-workspace aggregate) ---------------------------

/** Typed error code the client renders as a workspace-specific status alert. */
const STATUS_UNAVAILABLE_FOR_WORKSPACE = 'STATUS_UNAVAILABLE_FOR_WORKSPACE';

// Gap-based spacing for a personal column position; mirrors the board's
// (index + 1) * 100 scheme so dense personal renumbers read naturally.
const MY_POSITION_STEP = 100;

interface MyTicketRow extends TicketRow {
  project_name: string;
  project_settings_json: string;
  my_position: number | null;
}

function toMyTicketDto(r: MyTicketRow, tags: ProjectTagDto[]): MyTicketDto {
  return {
    ...toTicketDto(r, tags),
    projectName: r.project_name,
    projectColor: readProjectColor(r.project_settings_json),
    myPosition: r.my_position
  };
}

// Tickets assigned to the active operator across the active workspace, joined to
// their (non-deleted) project for name/color and to the operator's personal
// column position. The position only applies when its stored status_id still
// matches the ticket's current status, so a status change made on the project
// board self-corrects (the ticket falls back to the default order in its new
// column).
const selectMyTicketsSql = `
  SELECT t.id, t.workspace_id, t.project_id, t.display_id, t.sequence_number, t.title,
         t.status_id, t.status_type, t.board_position, t.priority,
         t.assigned_workspace_user_id,
         t.acceptance_criteria_text, t.available_tools_json,
         t.created_at, t.updated_at, t.revision,
         p.name AS project_name, p.settings_json AS project_settings_json,
         mtp.position AS my_position,
         (SELECT COUNT(*) FROM objectives o
            WHERE o.ticket_id = t.id AND o.deleted_at IS NULL) AS objective_count,
         (SELECT COUNT(*) FROM objectives o
            WHERE o.ticket_id = t.id AND o.deleted_at IS NULL AND o.state = 'complete')
            AS completed_objective_count,
         (SELECT COUNT(*) > 0 FROM objectives o
            WHERE o.ticket_id = t.id AND o.deleted_at IS NULL AND o.state = 'executing')
            AS has_executing_objective,
         (SELECT COUNT(*) > 0 FROM objectives o
            WHERE o.ticket_id = t.id AND o.deleted_at IS NULL AND o.state = 'complete')
            AS has_completed_objective,
         (SELECT COUNT(*) > 0 FROM objectives o
            WHERE o.ticket_id = t.id AND o.deleted_at IS NULL
              AND o.state IN ('draft', 'future') AND TRIM(o.instruction_text) != '')
            AS has_pending_objective_with_instructions
    FROM tickets t
    JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
      AND p.deleted_at IS NULL
    LEFT JOIN my_ticket_positions mtp
      ON mtp.workspace_id = t.workspace_id AND mtp.ticket_id = t.id
        AND mtp.workspace_user_id = @actor AND mtp.status_id = t.status_id
   WHERE t.workspace_id = @workspace_id AND t.deleted_at IS NULL
     AND t.assigned_workspace_user_id = @actor
`;

/**
 * GET /api/workspace/my-tickets — tickets assigned to the active operator across
 * the active workspace. Read-time merge order: positioned tickets first by their
 * personal position, then unpositioned tickets by the approximate default
 * aggregate order (board_position, then recency, then a stable tiebreaker). The
 * client regroups by statusId, preserving this within-column order. If no actor
 * workspace-user resolves, returns an empty list rather than broadening.
 */
export function listWorkspaceMyTickets(): MyTicketsResponse {
  if (!ACTOR_WORKSPACE_USER_ID) return { tickets: [] };
  const rows = db
    .prepare(
      `${selectMyTicketsSql}
         ORDER BY (mtp.position IS NULL) ASC, mtp.position ASC,
                  t.board_position ASC, t.updated_at DESC, t.sequence_number DESC, t.id ASC`
    )
    .all({ workspace_id: WORKSPACE.id, actor: ACTOR_WORKSPACE_USER_ID }) as MyTicketRow[];
  const tagsByTicket = getTagsByTicket(rows.map(row => row.id));
  return { tickets: rows.map(row => toMyTicketDto(row, tagsByTicket.get(row.id) ?? [])) };
}

/** Insert or update one operator's personal position for a ticket in a column. */
function upsertMyTicketPosition({
  ticketId,
  statusId,
  position,
  actor,
  now
}: {
  ticketId: string;
  statusId: string;
  position: number;
  actor: string;
  now: string;
}): void {
  const existing = db
    .prepare(
      `SELECT id, revision FROM my_ticket_positions
         WHERE workspace_id = ? AND workspace_user_id = ? AND ticket_id = ?`
    )
    .get(WORKSPACE.id, actor, ticketId) as { id: string; revision: number } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE my_ticket_positions
          SET status_id = @status_id, position = @position, updated_at = @now, revision = @revision
        WHERE id = @id`
    ).run({
      id: existing.id,
      status_id: statusId,
      position,
      now,
      revision: existing.revision + 1
    });
    return;
  }
  db.prepare(
    `INSERT INTO my_ticket_positions
       (id, workspace_id, workspace_user_id, ticket_id, status_id, position, created_at, updated_at, revision)
     VALUES (@id, @workspace_id, @actor, @ticket_id, @status_id, @position, @now, @now, 1)`
  ).run({
    id: newId(),
    workspace_id: WORKSPACE.id,
    actor,
    ticket_id: ticketId,
    status_id: statusId,
    position,
    now
  });
}

const reorderWorkspaceMyTicketsTx = db.transaction(
  (body: MyTicketReorderRequest): MyTicketsResponse => {
    const actor = ACTOR_WORKSPACE_USER_ID;
    if (!actor) throw new ApiError(403, 'No active workspace operator to reorder for');

    const statusId = body.statusId;
    const orderedIds = body.orderedTicketIds;
    if (!statusId) throw new ApiError(400, 'statusId is required');
    if (!Array.isArray(orderedIds)) throw new ApiError(400, 'orderedTicketIds must be an array');
    if (new Set(orderedIds).size !== orderedIds.length) {
      throw new ApiError(400, 'orderedTicketIds contains duplicates');
    }

    // Resolve the target column against the active workspace. A status the
    // workspace doesn't own can never satisfy a ticket's composite FK, so reject
    // early with a typed, workspace-specific code the client renders as an alert.
    const statusRow = db
      .prepare(
        `SELECT * FROM workspace_statuses WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
      )
      .get(statusId, WORKSPACE.id) as WorkspaceStatusRow | undefined;
    if (!statusRow) {
      throw new ApiError(
        409,
        `That status is not available for tickets in the ${WORKSPACE.name} workspace`,
        undefined,
        STATUS_UNAVAILABLE_FOR_WORKSPACE
      );
    }

    const now = nowIso();

    orderedIds.forEach((ticketId, index) => {
      const existing = db
        .prepare(`SELECT * FROM tickets WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`)
        .get(ticketId, WORKSPACE.id) as TicketRow | undefined;
      if (!existing) throw new ApiError(404, `Ticket ${ticketId} not found in workspace`);
      if (existing.assigned_workspace_user_id !== actor) {
        throw new ApiError(403, `Ticket ${ticketId} is not assigned to you`);
      }

      // Cross-column drag: a real status change. Apply the canonical status-change
      // writes (status_id + denormalized status_type + reset board_position to
      // top-of-new-column) so the project board and the My Tickets unpositioned
      // fallback both stay correct. The composite FK backstops invalid statuses.
      if (existing.status_id !== statusRow.id) {
        const revision = existing.revision + 1;
        db.prepare(
          `UPDATE tickets
              SET status_id = @status_id, status_type = @status_type,
                  board_position = @board_position, updated_at = @now, revision = @revision
            WHERE id = @id AND workspace_id = @workspace_id`
        ).run({
          id: ticketId,
          workspace_id: WORKSPACE.id,
          status_id: statusRow.id,
          status_type: statusRow.type,
          board_position: topBoardPosition(existing.project_id, statusRow.id, ticketId),
          now,
          revision
        });
        recordChange({
          entityType: 'ticket',
          entityId: ticketId,
          operation: 'update',
          entityRevision: revision,
          projectId: existing.project_id,
          ticketId,
          changedFields: ['status_id', 'status_type', 'board_position']
        });
      }

      // Personal slot within the (operator, status) column. Writes only
      // my_ticket_positions — never tickets.board_position for a within-column move.
      upsertMyTicketPosition({
        ticketId,
        statusId: statusRow.id,
        position: (index + 1) * MY_POSITION_STEP,
        actor,
        now
      });
    });

    return listWorkspaceMyTickets();
  }
);

/**
 * PATCH /api/workspace/my-tickets/order — persist a personal reorder of one My
 * Tickets status column for the active operator. Translates a foreign-key
 * rejection (a status the ticket's workspace lacks) into the typed
 * `STATUS_UNAVAILABLE_FOR_WORKSPACE` error so the client can alert and revert.
 */
export function reorderWorkspaceMyTickets(body: MyTicketReorderRequest): MyTicketsResponse {
  try {
    return reorderWorkspaceMyTicketsTx(body);
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      (err as { code?: string }).code === 'SQLITE_CONSTRAINT_FOREIGNKEY'
    ) {
      throw new ApiError(
        409,
        `That status is not available for tickets in the ${WORKSPACE.name} workspace`,
        undefined,
        STATUS_UNAVAILABLE_FOR_WORKSPACE
      );
    }
    throw err;
  }
}

// ---- Objectives ----------------------------------------------------------

export function listObjectives(ticketId: string): ObjectiveDto[] {
  const rows = db
    .prepare(
      `SELECT o.*,
         (
           SELECT s.external_session_id
             FROM agent_sessions s
            WHERE s.objective_id = o.id AND s.deleted_at IS NULL
            ORDER BY s.started_at DESC
            LIMIT 1
         ) AS external_session_id
         FROM objectives o
        WHERE o.ticket_id = ? AND o.deleted_at IS NULL
        ORDER BY o.position ASC`
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

  // Blank instructions are allowed only for editable slots that are authored
  // inline afterwards (`draft`/`future`) — the add-objective affordance creates
  // such a slot and renders it directly as a DraftObjective card. Submitted and
  // later states still require instruction text.
  const allowsBlankInstruction = state === 'draft' || state === 'future';
  if (!instruction && !allowsBlankInstruction) {
    throw new ApiError(400, 'Objective instruction is required');
  }

  const maxRow = db
    .prepare(
      `SELECT MAX(position) AS max_pos FROM objectives WHERE ticket_id = ? AND deleted_at IS NULL`
    )
    .get(body.ticketId) as { max_pos: number | null };
  const position = (maxRow.max_pos ?? -1) + 1;

  // Editable slots (draft/future) default to the project's last-used launch
  // selection so the agent is always recorded on the objective. The launch button
  // reads the stored agent, and auto-advance/execution use it, so what the user
  // sees and what runs stay in agreement instead of falling back to a hardcoded
  // runner default.
  const launchSelection =
    state === 'draft' || state === 'future'
      ? getLaunchPreference(ticket.project_id)
      : { selectedAgent: null, selectedModel: null, selectedReasoningEffort: null };

  const now = nowIso();
  const id = newId();
  db.prepare(
    `INSERT INTO objectives
       (id, workspace_id, project_id, ticket_id, position, title, instruction_text, state,
        assigned_agent, model, reasoning_effort, agent_flags_json, auto_advance,
        execution_metadata_json, created_by_workspace_user_id, created_at, updated_at, revision)
     VALUES (@id, @ws, @project_id, @ticket_id, @position, @title, @instruction, @state,
        @assigned_agent, @model, @reasoning_effort, '{}', @auto_advance, '{}', @actor,
        @now, @now, 1)`
  ).run({
    id,
    ws: WORKSPACE.id,
    project_id: ticket.project_id,
    ticket_id: body.ticketId,
    position,
    title:
      body.title?.trim() ||
      (instruction ? initialTitleFromInstruction(instruction) : 'New objective'),
    instruction,
    state,
    assigned_agent: launchSelection.selectedAgent,
    model: launchSelection.selectedModel,
    reasoning_effort: launchSelection.selectedReasoningEffort,
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

  if (!body.title?.trim() && objective.instructionText.trim()) {
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
      const resultingState = body.state ?? existing.state;
      const allowsBlankInstruction = resultingState === 'draft' || resultingState === 'future';
      if (!instruction && !allowsBlankInstruction) {
        throw new ApiError(400, 'Objective instruction is required');
      }
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

    // When a user manually moves an objective out of the launch pipeline
    // (completing it, or disconnecting it back to future/executing/pending),
    // the runner must stop seeing it: clear queued work and end open sessions.
    if (
      body.state !== undefined &&
      body.state !== existing.state &&
      !LAUNCHABLE_STATES.includes(body.state)
    ) {
      dequeueObjective({
        objectiveId: id,
        projectId: existing.project_id,
        ticketId: existing.ticket_id,
        reason: body.state === 'complete' ? 'completed' : 'disconnected',
        newState: body.state,
        now
      });
    }

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

  // A deleted objective must also leave the runner queue: the runner's claim
  // query joins objectives without filtering soft-deletes, so stale queued
  // requests could otherwise still be claimed.
  dequeueObjective({
    objectiveId: id,
    projectId: existing.project_id,
    ticketId: existing.ticket_id,
    reason: 'deleted',
    newState: null,
    now
  });
});

// ---- Profile -------------------------------------------------------------
//
// This build runs as a single trusted local operator, so "the profile" is the
// operator's row in the `profiles` table. The avatar URL has no dedicated
// column in the core schema, so it lives in `profiles.metadata_json.avatarUrl`.

interface UserRow {
  id: string;
  kind: string;
  display_name: string;
  handle: string | null;
  email: string | null;
  metadata_json: string;
  created_at: string;
  revision: number;
}

/**
 * Resolve the local operator's `profiles` row. Prefers the profile behind the active
 * workspace's actor; falls back to the oldest active human user so a freshly
 * switched workspace without a recorded actor still resolves an identity.
 */
function loadOperatorUserRow(): UserRow {
  if (ACTOR_WORKSPACE_USER_ID) {
    const row = db
      .prepare(
        `SELECT p.id, p.kind, p.display_name, p.handle, p.email,
                p.metadata_json, p.created_at, p.revision
           FROM profiles p
           JOIN workspace_users wu ON wu.profile_id = p.id
          WHERE wu.id = ? AND p.deleted_at IS NULL`
      )
      .get(ACTOR_WORKSPACE_USER_ID) as UserRow | undefined;
    if (row) return row;
  }
  const fallback = db
    .prepare(
      `SELECT id, kind, display_name, handle, email,
              metadata_json, created_at, revision
         FROM profiles
        WHERE kind = 'human' AND status = 'active' AND deleted_at IS NULL
        ORDER BY created_at ASC LIMIT 1`
    )
    .get() as UserRow | undefined;
  if (!fallback) throw new ApiError(409, 'No local user profile exists');
  return fallback;
}

function parseProfileMetadata(metadataJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function avatarUrlFromMetadata(metadataJson: string): string | null {
  const avatarUrl = parseProfileMetadata(metadataJson).avatarUrl;
  return typeof avatarUrl === 'string' && avatarUrl.trim() ? avatarUrl : null;
}

function agentInstructionsFromMetadata(metadataJson: string): string | null {
  const agentInstructions = parseProfileMetadata(metadataJson).agentInstructions;
  return typeof agentInstructions === 'string' && agentInstructions.trim()
    ? agentInstructions.trim()
    : null;
}

function editorSchemeFromMetadata(metadataJson: string): string | null {
  const editorScheme = parseProfileMetadata(metadataJson).editorScheme;
  return typeof editorScheme === 'string' && editorScheme.trim() ? editorScheme.trim() : null;
}

/** Merge profile metadata without dropping unrelated keys. */
function mergeProfileMetadataJson({
  metadataJson,
  avatarUrl,
  agentInstructions,
  editorScheme
}: {
  metadataJson: string;
  avatarUrl?: string | null;
  agentInstructions?: string | null;
  editorScheme?: string | null;
}): string {
  const parsed = parseProfileMetadata(metadataJson);
  if (avatarUrl) parsed.avatarUrl = avatarUrl;
  else if (avatarUrl !== undefined) delete parsed.avatarUrl;

  if (agentInstructions !== undefined) {
    const trimmed = agentInstructions?.trim() ?? '';
    if (trimmed) parsed.agentInstructions = trimmed;
    else delete parsed.agentInstructions;
  }

  if (editorScheme !== undefined) {
    const trimmed = editorScheme?.trim() ?? '';
    if (trimmed) parsed.editorScheme = trimmed;
    else delete parsed.editorScheme;
  }

  return JSON.stringify(parsed);
}

function toProfileDto(row: UserRow): ProfileDto {
  return {
    userId: row.id,
    displayName: row.display_name,
    handle: row.handle,
    email: row.email,
    avatarUrl: avatarUrlFromMetadata(row.metadata_json),
    agentInstructions: agentInstructionsFromMetadata(row.metadata_json),
    editorScheme: editorSchemeFromMetadata(row.metadata_json),
    kind: row.kind,
    authProvider: 'better-auth',
    roles: loadActorRoles(),
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
  // `handle` is not directly editable: it mirrors the Better Auth account
  // username via the auth→profiles bridge trigger. The username is changed
  // through the Auth surface (Account settings), not this profile patch.
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
    if (!fields.includes('metadata_json = @metadata_json'))
      fields.push('metadata_json = @metadata_json');
    params.metadata_json = mergeProfileMetadataJson({
      metadataJson: existing.metadata_json,
      avatarUrl
    });
    if (!changed.includes('metadata_json')) changed.push('metadata_json');
  }
  if (body.agentInstructions !== undefined) {
    if (!fields.includes('metadata_json = @metadata_json'))
      fields.push('metadata_json = @metadata_json');
    params.metadata_json = mergeProfileMetadataJson({
      metadataJson: (params.metadata_json as string | undefined) ?? existing.metadata_json,
      agentInstructions: body.agentInstructions
    });
    if (!changed.includes('metadata_json')) changed.push('metadata_json');
  }
  if (body.editorScheme !== undefined) {
    if (!fields.includes('metadata_json = @metadata_json'))
      fields.push('metadata_json = @metadata_json');
    params.metadata_json = mergeProfileMetadataJson({
      metadataJson: (params.metadata_json as string | undefined) ?? existing.metadata_json,
      editorScheme: body.editorScheme
    });
    if (!changed.includes('metadata_json')) changed.push('metadata_json');
  }
  if (fields.length === 0) return toProfileDto(existing);

  const now = nowIso();
  const revision = existing.revision + 1;
  db.prepare(
    `UPDATE profiles SET ${fields.join(', ')}, updated_at = @now, revision = @revision
       WHERE id = @id`
  ).run({ ...params, now, revision });

  recordChange({
    entityType: 'profile',
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

/**
 * Tokens default to a bounded lifetime so a leaked-but-forgotten credential stops
 * working on its own (security audit 2026-06-18). Callers can pass an explicit
 * expiry, or an explicit `null` to opt out and mint a non-expiring token.
 */
const DEFAULT_TOKEN_TTL_DAYS = 90;

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

/** Load the active scope grant patterns for a token (empty = full, no restriction). */
function loadTokenScopeGrants(tokenId: string): string[] {
  const rows = db
    .prepare(
      `SELECT permission FROM user_token_scopes
         WHERE token_id = ? AND workspace_id = ? AND deleted_at IS NULL
         ORDER BY permission ASC`
    )
    .all(tokenId, WORKSPACE.id) as Array<{ permission: string }>;
  return rows.map(r => r.permission);
}

function toUserTokenDto(row: UserTokenRow): UserTokenDto {
  const scopeGrants = loadTokenScopeGrants(row.id);
  return {
    id: row.id,
    label: row.label,
    tokenPrefix: row.token_prefix,
    status: row.status as UserTokenDto['status'],
    scope: scopeGrants.length > 0 ? 'ticket_lifecycle' : 'full',
    scopeGrants,
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
         WHERE workspace_id = ? AND profile_id = ? AND deleted_at IS NULL
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

    // Expiry resolution: an explicit value is validated and used; an explicit
    // `null` opts out (non-expiring); omitting the field defaults to 90 days so a
    // forgotten leaked token stops working on its own (security audit 2026-06-18).
    let expiresAt: string | null = null;
    if (body.expiresAt === undefined) {
      expiresAt = new Date(Date.now() + DEFAULT_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    } else if (body.expiresAt !== null && String(body.expiresAt).trim()) {
      const parsed = new Date(body.expiresAt);
      if (Number.isNaN(parsed.getTime())) throw new ApiError(400, 'Expiry must be a valid date');
      if (parsed.getTime() <= Date.now()) throw new ApiError(400, 'Expiry must be in the future');
      expiresAt = parsed.toISOString();
    }

    const scope: TokenScope = body.scope ?? 'full';
    if (scope !== 'full' && scope !== 'ticket_lifecycle') {
      throw new ApiError(400, `Unknown token scope: ${String(scope)}`);
    }
    const scopeGrants = scopeGrantsForPreset(scope);

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
         id, workspace_id, profile_id, workspace_user_id, label,
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

    // A `full` token carries no scope rows (no token-level restriction). A scoped
    // token persists one grant pattern per row; auth-time enforcement intersects
    // these with the creating user's role grants.
    const insertScope = db.prepare(
      `INSERT INTO user_token_scopes (
         id, workspace_id, token_id, permission, resource_type, resource_id,
         created_at, updated_at, revision
       ) VALUES (@id, @workspace_id, @token_id, @permission, NULL, NULL, @now, @now, 1)`
    );
    for (const permission of scopeGrants) {
      insertScope.run({
        id: newId(),
        workspace_id: WORKSPACE.id,
        token_id: id,
        permission,
        now
      });
    }

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
