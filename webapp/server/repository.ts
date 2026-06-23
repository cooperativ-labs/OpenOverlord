import { scopeGrantsForPreset } from '@overlord/auth';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readRepositoryTree, RepositoryReadError } from '../../src/repository/git-tree.ts';
import { ensureLocalExecutionTarget } from '../../src/service/execution-targets.ts';
import { writeProjectJson } from '../../src/service/projects.ts';
import type {
  ArtifactDto,
  CreateMissionBody,
  CreateObjectiveBody,
  CreateProjectBody,
  CreateProjectResourceBody,
  CreateProjectTagBody,
  CreateUserTokenBody,
  CreateUserTokenResultDto,
  CreateWorkspaceStatusBody,
  FileChangeDto,
  GenerateCommitMessageResultDto,
  MissionBranchDto,
  MissionBranchListDto,
  MissionBranchStatus,
  MissionDetailDto,
  MissionDto,
  MissionEventDto,
  MyMissionDto,
  MyMissionReorderRequest,
  MyMissionsResponse,
  ObjectiveDto,
  ProfileDto,
  ProjectDto,
  ProjectRepositoryDto,
  ProjectResourceDto,
  ProjectTagDto,
  PurgeWorktreesResultDto,
  RemoveWorktreeBody,
  ReorderBoardColumnBody,
  ReorderFutureObjectivesBody,
  ReorderWorkspaceStatusesBody,
  StatusType,
  TokenScope,
  UpdateMissionBody,
  UpdateObjectiveBody,
  UpdateProfileBody,
  UpdateProjectBody,
  UpdateProjectResourceBody,
  UpdateProjectTagBody,
  UpdateUserTokenBody,
  UpdateWorkspaceStatusBody,
  UserTokenDto,
  WorkspaceStatusDto,
  WorktreeDto
} from '../shared/contract.ts';

import { missionWorktreePath, previewMissionBranch } from './branch-planning.ts';
import { generateCommitMessageFromDiff } from './commit-message-automation.ts';
import { ACTOR_WORKSPACE_USER_ID, db, newId, nowIso, recordChange, WORKSPACE } from './db.ts';
import { ApiError } from './errors.ts';
import {
  dequeueObjective,
  getLaunchPreference,
  LAUNCHABLE_STATES,
  listMissionExecutionRequests
} from './launch.ts';
import { loadActorRoles } from './rbac.ts';
import {
  generateMissionTitleNow,
  initialTitleFromInstruction,
  scheduleMissionTitleGeneration,
  scheduleObjectiveTitleGeneration
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
  mission_count: number;
}

const PROJECT_COLOR_SETTINGS_KEY = 'overlord.color';
const PROJECT_DEFAULT_BRANCH_SETTINGS_KEY = 'overlord.defaultBranch';

function readProjectStringSetting(settingsJson: string, key: string): string | null {
  try {
    const parsed = JSON.parse(settingsJson) as Record<string, unknown>;
    const value = parsed[key];
    return typeof value === 'string' && value.trim() ? value : null;
  } catch {
    return null;
  }
}

function readProjectColor(settingsJson: string): string | null {
  return readProjectStringSetting(settingsJson, PROJECT_COLOR_SETTINGS_KEY);
}

// The project-configured base/parent branch for mission branches. `null` means
// "not configured"; callers fall back to the repo default (`main`).
function readProjectDefaultBranch(settingsJson: string): string | null {
  return readProjectStringSetting(settingsJson, PROJECT_DEFAULT_BRANCH_SETTINGS_KEY);
}

// Conservative branch-name validation for the user-entered default branch. The
// authoritative check (`git check-ref-format`) happens in the Runner Layer when
// it actually cuts/operates on the branch; this just rejects obviously invalid
// input at the REST boundary (whitespace, control chars, and the characters git
// forbids in ref names).
function isValidBranchName(branch: string): boolean {
  if (!branch || branch.length > 255) return false;
  if (/[\s~^:?*[\\]/.test(branch)) return false;
  if (branch.includes('..') || branch.includes('@{')) return false;
  if (branch.startsWith('/') || branch.endsWith('/') || branch.endsWith('.lock')) return false;
  if (branch.startsWith('-') || branch.startsWith('.')) return false;
  return true;
}

function buildProjectSettingsJson({ color }: { color?: string }): string {
  if (!color) return '{}';
  return JSON.stringify({ [PROJECT_COLOR_SETTINGS_KEY]: color });
}

function mergeProjectSettingsJson(
  existingJson: string,
  updates: { color?: string | null; defaultBranch?: string | null }
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
  if (updates.defaultBranch !== undefined) {
    if (updates.defaultBranch) {
      parsed[PROJECT_DEFAULT_BRANCH_SETTINGS_KEY] = updates.defaultBranch;
    } else {
      delete parsed[PROJECT_DEFAULT_BRANCH_SETTINGS_KEY];
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

function countMissionsOnStatus(statusId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM missions WHERE status_id = ? AND deleted_at IS NULL`)
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

interface MissionRow {
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
  branch_override: string | null;
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
  mission_id: string;
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
  branch: string | null;
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
    defaultBranch: readProjectDefaultBranch(r.settings_json),
    status: r.status as ProjectDto['status'],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    revision: r.revision,
    missionCount: r.mission_count
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

function toMissionDto(r: MissionRow, tags: ProjectTagDto[] = []): MissionDto {
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
    priority: r.priority as MissionDto['priority'],
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

// Resolves the absolute SHA a ref points at, or null when the ref does not exist.
function resolveRef(repoPath: string, ref: string): string | null {
  const sha = runGit(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return sha || null;
}

// True when `sha` sits on the base's first-parent trunk — the linear backbone you
// walk by always taking the first parent. Overlord's merge-with-parent flow brings
// a branch in with a `--no-ff` merge commit whose SECOND parent is the branch tip,
// so a genuinely merged branch tip is NOT on this trunk. A branch the base merely
// advanced past linearly (e.g. an empty mission branch whose parent moved forward)
// stays on it. This is what distinguishes "landed via merge" from "merely reachable".
function isOnFirstParentTrunk(repoPath: string, base: string, sha: string): boolean {
  const trunk = runGit(repoPath, ['rev-list', '--first-parent', base]);
  if (!trunk) return false;
  return trunk.split('\n').some(line => line.trim() === sha);
}

// True only when the branch has actually been merged into the base via the
// merge-with-parent flow: its tip must be fully contained in the base (no commits
// of its own absent from the base) AND off the base's first-parent trunk, meaning
// it entered through a `--no-ff` merge commit rather than being a plain ancestor.
// A branch freshly cut from the base shares the base's tip, and an empty branch the
// base later advanced past is still a first-parent ancestor — neither is "merged",
// fixing the bug where such branches reported as merged because they were merely
// reachable from the base (`git branch --merged <base>` / containment alone).
function branchMergedIntoBase(repoPath: string, branchSha: string, base: string): boolean {
  const baseSha = resolveRef(repoPath, base);
  if (!baseSha) return false;
  if (baseSha === branchSha) return false;
  const ahead = runGit(repoPath, ['rev-list', '--count', `${baseSha}..${branchSha}`]).trim();
  if (ahead !== '0') return false;
  return !isOnFirstParentTrunk(repoPath, base, branchSha);
}

// Derives the mission-panel branch status from the real git state in the project's
// primary worktree. `active_branch` being set means a branch was prepared, so the
// floor is `created`; we upgrade to `published` once a remote ref exists, to
// `merged_unpushed` once the branch has landed in the *local* base but the base
// has not been pushed, and to `merged` once it has landed in the *remote* base.
//
// The `merged` / `merged_unpushed` split is the intermediate the merge-with-parent
// flow needs: Action A advances the local parent to contain the branch (→
// `merged_unpushed`); Action B pushes that parent to origin (→ `merged`). The
// flow uses a `--no-ff` merge commit on the parent precisely so the parent tip
// diverges from the branch tip, keeping this derivation unambiguous (a plain
// fast-forward would leave parent and branch tips identical and indistinguishable
// from a freshly-cut branch — see the documented edge in CONTRACT.md 0.39-draft).
function deriveBranchStatus({
  projectId,
  branchName,
  baseBranch
}: {
  projectId: string;
  branchName: string;
  baseBranch: string | null;
}): 'created' | 'published' | 'merged_unpushed' | 'merged' {
  const resource = db
    .prepare(
      `SELECT path FROM project_resources
        WHERE project_id = ? AND workspace_id = ? AND is_primary = 1
          AND status = 'active' AND deleted_at IS NULL
        ORDER BY created_at ASC
        LIMIT 1`
    )
    .get(projectId, WORKSPACE.id) as { path: string } | undefined;
  // Without an inspectable checkout we can only trust that the branch was created.
  if (!resource || !existsSync(resource.path)) return 'created';
  const repoPath = resource.path;

  const branchSha =
    resolveRef(repoPath, `refs/heads/${branchName}`) ??
    resolveRef(repoPath, `refs/remotes/origin/${branchName}`);
  const remoteExists = resolveRef(repoPath, `refs/remotes/origin/${branchName}`) !== null;
  // No local or remote ref found: the branch is recorded but not present here.
  if (!branchSha) return 'created';

  if (baseBranch) {
    // Remote base contains the branch ⇒ the work has truly landed and been
    // published. Check this first: it supersedes the local-only intermediate.
    if (branchMergedIntoBase(repoPath, branchSha, `origin/${baseBranch}`)) return 'merged';
    // Only the local base contains the branch ⇒ merged but not yet pushed.
    if (branchMergedIntoBase(repoPath, branchSha, baseBranch)) return 'merged_unpushed';
  }

  return remoteExists ? 'published' : 'created';
}

function getProjectSlug(projectId: string): string {
  const row = db
    .prepare(`SELECT slug FROM projects WHERE id = ? AND workspace_id = ?`)
    .get(projectId, WORKSPACE.id) as { slug: string } | undefined;
  return row?.slug ?? 'project';
}

// The fallback base/parent branch when a project has not configured one.
const FALLBACK_BASE_BRANCH = 'main';

// Resolves the base/parent branch for a project's mission branches: the
// project-configured default branch (Resources settings) when set, otherwise the
// repo default `main`. This is both the branch missions are cut from and the
// parent that "Merge with parent" advances.
function resolveProjectBaseBranch(projectId: string): string {
  const row = db
    .prepare(`SELECT settings_json FROM projects WHERE id = ? AND workspace_id = ?`)
    .get(projectId, WORKSPACE.id) as { settings_json: string } | undefined;
  return (row && readProjectDefaultBranch(row.settings_json)) || FALLBACK_BASE_BRANCH;
}

// Derives the mission-panel branch metadata from `missions.active_branch` (the
// source of truth the runner writes). When it is null no branch has been
// prepared yet, so we surface the planner's predicted name with a pending status.
function missionBranchDto(row: MissionRow): MissionBranchDto {
  const projectSlug = getProjectSlug(row.project_id);
  const worktreeRoot = resolveWorktreeRoot();
  const baseBranch = resolveProjectBaseBranch(row.project_id);
  const overrideBranch = row.branch_override?.trim() || null;
  const name = row.active_branch?.trim();
  if (name) {
    const worktreePath = missionWorktreePath({ worktreeRoot, projectSlug, branch: name });
    return {
      name,
      baseBranch,
      worktreePath,
      status: deriveBranchStatus({ projectId: row.project_id, branchName: name, baseBranch }),
      dirty: existsSync(worktreePath) && worktreeIsDirty(worktreePath),
      overrideBranch
    };
  }

  // No branch prepared yet: preview the name the next launch will use. A pinned
  // override wins over the planner's canonical prediction so the panel reflects
  // exactly what the next launch will prepare.
  const preview = previewMissionBranch({
    mission: { title: row.title, sequence: row.sequence_number },
    project: { slug: projectSlug },
    base: baseBranch,
    worktreeRoot
  });
  const previewName = overrideBranch ?? preview.branch;
  return {
    name: previewName,
    baseBranch: preview.baseBranch,
    worktreePath:
      previewName === preview.branch
        ? preview.worktreePath
        : missionWorktreePath({ worktreeRoot, projectSlug, branch: previewName }),
    status: 'pending',
    // No branch/worktree exists yet, so there is nothing to be dirty.
    dirty: false,
    overrideBranch
  };
}

// ---- Branch actions (merge with parent / push / publish) -----------------
//
// On-demand git mutations the mission panel triggers. They run host-side against
// the project's worktrees (under ~/.ovld/worktrees) and primary repo, which the
// webapp server is co-located with — so it operates on them directly rather than
// delegating to the Runner Layer (whose job is launching the *agent* into the
// worktree, not these mutations). Conflicts are deliberately left in the branch's
// own worktree for the user to resolve in their IDE. See CONTRACT.md 0.41-draft.

type GitRun = { ok: boolean; stdout: string; stderr: string };

// Like `runGit` above, but surfaces failure (exit code + stderr) instead of
// swallowing it — required for merge/push, where the outcome drives typed errors.
function runGitResult(cwd: string, args: string[]): GitRun {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024
    });
    return { ok: true, stdout: stdout.trim(), stderr: '' };
  } catch (error) {
    const e = error as { stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      ok: false,
      stdout: (e.stdout ? String(e.stdout) : '').trim(),
      stderr: (e.stderr ? String(e.stderr) : '').trim()
    };
  }
}

export type BranchActionName = 'integrate' | 'commit' | 'push_parent' | 'publish';

interface BranchActionContext {
  missionId: string;
  projectId: string;
  branchName: string;
  baseBranch: string;
  worktreePath: string;
  primaryRepoPath: string;
}

function primaryResourcePath(projectId: string): string | null {
  const resource = db
    .prepare(
      `SELECT path FROM project_resources
        WHERE project_id = ? AND workspace_id = ? AND is_primary = 1
          AND status = 'active' AND deleted_at IS NULL
        ORDER BY created_at ASC
        LIMIT 1`
    )
    .get(projectId, WORKSPACE.id) as { path: string } | undefined;
  return resource?.path ?? null;
}

function loadBranchActionContext(missionRef: string): BranchActionContext {
  const row = getMissionRow(missionRef);
  const branchName = row.active_branch?.trim();
  if (!branchName) {
    throw new ApiError(
      409,
      'No branch has been prepared for this mission yet.',
      undefined,
      'BRANCH_NOT_PREPARED'
    );
  }
  const primaryRepoPath = primaryResourcePath(row.project_id);
  if (!primaryRepoPath || !existsSync(primaryRepoPath)) {
    throw new ApiError(
      409,
      'This project has no connected primary working directory on this device.',
      undefined,
      'BRANCH_NO_PRIMARY'
    );
  }
  return {
    missionId: row.id,
    projectId: row.project_id,
    branchName,
    baseBranch: resolveProjectBaseBranch(row.project_id),
    worktreePath: missionWorktreePath({
      worktreeRoot: resolveWorktreeRoot(),
      projectSlug: getProjectSlug(row.project_id),
      branch: branchName
    }),
    primaryRepoPath
  };
}

function missionHasActiveExecution(missionId: string): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM execution_requests
          WHERE mission_id = ? AND workspace_id = ?
            AND status IN ('queued', 'claimed', 'launching')
          LIMIT 1`
      )
      .get(missionId, WORKSPACE.id)
  );
}

// Locates the worktree that currently has `branch` checked out, so the parent can
// be advanced where it lives (git refuses to update a checked-out branch's ref
// from elsewhere). Returns null when the branch is not checked out anywhere.
function worktreePathForBranch(repoPath: string, branch: string): string | null {
  const out = runGitResult(repoPath, ['worktree', 'list', '--porcelain']);
  if (!out.ok) return null;
  let currentPath: string | null = null;
  for (const line of out.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      currentPath = line.slice('worktree '.length).trim();
    } else if (line.startsWith('branch ')) {
      const ref = line
        .slice('branch '.length)
        .trim()
        .replace(/^refs\/heads\//, '');
      if (ref === branch && currentPath) return currentPath;
    }
  }
  return null;
}

function worktreeIsDirty(worktreePath: string): boolean {
  const status = runGitResult(worktreePath, ['status', '--porcelain']);
  return status.ok && status.stdout.length > 0;
}

// Removes a worktree's git registration and on-disk directory, then prunes stale
// administrative entries. `git worktree remove` refuses a dirty worktree without
// `--force`; callers guard on dirtiness first when they want that protection.
// Best-effort: returns whether the directory is gone afterwards.
function removeGitWorktree(repoPath: string, worktreePath: string, force: boolean): boolean {
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(worktreePath);
  runGitResult(repoPath, args);
  // Prune so a removed (or externally-deleted) directory leaves no stale entry
  // that would later block `git worktree add` on the same path.
  runGitResult(repoPath, ['worktree', 'prune']);
  return !existsSync(worktreePath);
}

// Action A — bring the branch up to date with its parent inside the branch's own
// worktree (the only step that can conflict; left in place for IDE resolution),
// then advance the parent to the branch with a --no-ff merge commit so the parent
// tip diverges from the branch tip (keeps `deriveBranchStatus` unambiguous).
function integrateBranch(ctx: BranchActionContext): string {
  const { branchName, baseBranch, worktreePath, primaryRepoPath } = ctx;
  if (!existsSync(worktreePath)) {
    throw new ApiError(
      409,
      `The branch's worktree is not present at ${worktreePath}.`,
      undefined,
      'BRANCH_NO_WORKTREE'
    );
  }
  const wtBranch = runGitResult(worktreePath, ['branch', '--show-current']);
  if (!wtBranch.ok || wtBranch.stdout !== branchName) {
    throw new ApiError(
      409,
      `The worktree at ${worktreePath} is not checked out on ${branchName}.`,
      undefined,
      'BRANCH_WORKTREE_MISMATCH'
    );
  }
  if (worktreeIsDirty(worktreePath)) {
    throw new ApiError(
      409,
      `The branch worktree has uncommitted changes — resolve/commit them first: ${worktreePath}`,
      worktreePath,
      'BRANCH_DIRTY'
    );
  }

  // 1. Merge the parent into the branch, in the branch's worktree.
  const merge = runGitResult(worktreePath, ['merge', '--no-edit', baseBranch]);
  if (!merge.ok) {
    const conflicted = runGitResult(worktreePath, ['diff', '--name-only', '--diff-filter=U']);
    const files = conflicted.ok && conflicted.stdout ? conflicted.stdout.split('\n') : [];
    const detail =
      `Resolve the conflicts in ${worktreePath}, commit, then run "Update from ${baseBranch} & merge" again.` +
      (files.length ? ` Conflicted files: ${files.join(', ')}.` : '');
    throw new ApiError(
      409,
      `Merging ${baseBranch} into ${branchName} hit conflicts.`,
      detail,
      'BRANCH_MERGE_CONFLICT'
    );
  }

  // 2. Advance the parent to the branch (clean by construction).
  const parentWorktree = worktreePathForBranch(primaryRepoPath, baseBranch);
  if (!parentWorktree) {
    throw new ApiError(
      409,
      `Cannot advance ${baseBranch}: it is not checked out in any worktree. Check out ${baseBranch} in the primary repository and re-run.`,
      undefined,
      'BRANCH_PARENT_NOT_CHECKED_OUT'
    );
  }
  if (worktreeIsDirty(parentWorktree)) {
    throw new ApiError(
      409,
      `The ${baseBranch} checkout has uncommitted changes — commit or stash them first: ${parentWorktree}`,
      parentWorktree,
      'BRANCH_DIRTY'
    );
  }
  const advance = runGitResult(parentWorktree, [
    'merge',
    '--no-ff',
    '--no-edit',
    '-m',
    `Merge ${branchName} into ${baseBranch}`,
    branchName
  ]);
  if (!advance.ok) {
    throw new ApiError(
      500,
      `Failed to advance ${baseBranch} to ${branchName}.`,
      advance.stderr || advance.stdout,
      'BRANCH_MERGE_FAILED'
    );
  }
  return `Merged ${baseBranch} into ${branchName} and advanced ${baseBranch} locally.`;
}

// Commit — stage and commit all changes in the branch's own worktree. This is the
// "commit changes first" step the merge flow requires: the integrate action refuses
// a dirty worktree, so the panel offers this commit affordance while the branch has
// uncommitted work. Runs entirely in the branch's worktree (never the parent).
function commitBranch(ctx: BranchActionContext, message: string): string {
  const { branchName, worktreePath } = ctx;
  const trimmed = message.trim();
  if (!trimmed) {
    throw new ApiError(
      400,
      'A commit message is required.',
      undefined,
      'BRANCH_COMMIT_MESSAGE_REQUIRED'
    );
  }
  if (!existsSync(worktreePath)) {
    throw new ApiError(
      409,
      `The branch's worktree is not present at ${worktreePath}.`,
      undefined,
      'BRANCH_NO_WORKTREE'
    );
  }
  const wtBranch = runGitResult(worktreePath, ['branch', '--show-current']);
  if (!wtBranch.ok || wtBranch.stdout !== branchName) {
    throw new ApiError(
      409,
      `The worktree at ${worktreePath} is not checked out on ${branchName}.`,
      undefined,
      'BRANCH_WORKTREE_MISMATCH'
    );
  }
  if (!worktreeIsDirty(worktreePath)) {
    throw new ApiError(
      409,
      'There are no uncommitted changes in the branch worktree to commit.',
      worktreePath,
      'BRANCH_NOTHING_TO_COMMIT'
    );
  }

  const staged = runGitResult(worktreePath, ['add', '-A']);
  if (!staged.ok) {
    throw new ApiError(
      500,
      `Failed to stage changes in ${worktreePath}.`,
      staged.stderr || staged.stdout,
      'BRANCH_COMMIT_FAILED'
    );
  }
  const commit = runGitResult(worktreePath, ['commit', '-m', trimmed]);
  if (!commit.ok) {
    throw new ApiError(
      500,
      `Failed to commit changes on ${branchName}.`,
      commit.stderr || commit.stdout,
      'BRANCH_COMMIT_FAILED'
    );
  }
  return `Committed changes on ${branchName}.`;
}

// Action B — publish the merged parent to origin. Once pushed, the branch has
// truly landed (status → merged), so its worktree is no longer needed; we remove
// it automatically (best-effort, only when clean) to keep the worktree list tidy
// per the "auto-on-merge" purge policy. A dirty branch worktree is left alone.
function pushParent(ctx: BranchActionContext): string {
  const { branchName, baseBranch, worktreePath, primaryRepoPath } = ctx;
  const repo = worktreePathForBranch(primaryRepoPath, baseBranch) ?? primaryRepoPath;
  const push = runGitResult(repo, ['push', 'origin', baseBranch]);
  if (!push.ok) {
    throw new ApiError(
      502,
      `Failed to push ${baseBranch} to origin.`,
      push.stderr || push.stdout,
      'BRANCH_PUSH_FAILED'
    );
  }
  let summary = `Pushed ${baseBranch} to origin.`;
  if (existsSync(worktreePath) && !worktreeIsDirty(worktreePath)) {
    if (removeGitWorktree(primaryRepoPath, worktreePath, false)) {
      summary += ` Removed the merged worktree for ${branchName}.`;
    }
  }
  return summary;
}

// Publish — push the branch itself to origin (created → published), enabling PRs.
function publishBranch(ctx: BranchActionContext): string {
  const { branchName, worktreePath, primaryRepoPath } = ctx;
  const repo = existsSync(worktreePath) ? worktreePath : primaryRepoPath;
  const push = runGitResult(repo, ['push', '-u', 'origin', branchName]);
  if (!push.ok) {
    throw new ApiError(
      502,
      `Failed to publish ${branchName} to origin.`,
      push.stderr || push.stdout,
      'BRANCH_PUSH_FAILED'
    );
  }
  return `Published ${branchName} to origin.`;
}

const recordBranchActionActivity = db.transaction((ctx: BranchActionContext, summary: string) => {
  const mission = db
    .prepare(`SELECT revision FROM missions WHERE id = ? AND workspace_id = ?`)
    .get(ctx.missionId, WORKSPACE.id) as { revision: number } | undefined;
  const now = nowIso();
  if (mission) {
    const revision = mission.revision + 1;
    db.prepare(
      `UPDATE missions SET updated_at = @now, revision = @revision
         WHERE id = @id AND workspace_id = @workspace_id`
    ).run({ now, revision, id: ctx.missionId, workspace_id: WORKSPACE.id });
    recordChange({
      entityType: 'mission',
      entityId: ctx.missionId,
      operation: 'update',
      entityRevision: revision,
      projectId: ctx.projectId,
      missionId: ctx.missionId,
      changedFields: ['active_branch']
    });
  }
  db.prepare(
    `INSERT INTO mission_events
       (id, workspace_id, project_id, mission_id, objective_id, type, phase, summary,
        payload_json, source, actor_workspace_user_id, created_at)
     VALUES (?, ?, ?, ?, NULL, 'update', 'execute', ?, ?, 'webapp', ?, ?)`
  ).run(
    newId(),
    WORKSPACE.id,
    ctx.projectId,
    ctx.missionId,
    summary,
    JSON.stringify({ branch: ctx.branchName, baseBranch: ctx.baseBranch }),
    ACTOR_WORKSPACE_USER_ID,
    now
  );
});

// Runs an on-demand branch mutation and returns the refreshed mission detail.
// Git side-effects happen first (and throw typed ApiErrors on failure); only on
// success do we record the activity + realtime change in a single transaction.
export function performBranchAction(
  missionRef: string,
  body: { action?: unknown; message?: unknown; confirmBusy?: unknown }
): MissionDetailDto {
  const action = String(body.action ?? '');
  if (
    action !== 'integrate' &&
    action !== 'commit' &&
    action !== 'push_parent' &&
    action !== 'publish'
  ) {
    throw new ApiError(400, 'Invalid branch action.');
  }
  const ctx = loadBranchActionContext(missionRef);
  if (body.confirmBusy !== true && missionHasActiveExecution(ctx.missionId)) {
    throw new ApiError(
      409,
      'An objective is currently executing on this branch. Continuing may conflict with in-progress work in its worktree.',
      'Re-run with confirmation to proceed anyway.',
      'BRANCH_BUSY_EXECUTING'
    );
  }

  const summary =
    action === 'integrate'
      ? integrateBranch(ctx)
      : action === 'commit'
        ? commitBranch(ctx, typeof body.message === 'string' ? body.message : '')
        : action === 'push_parent'
          ? pushParent(ctx)
          : publishBranch(ctx);

  recordBranchActionActivity(ctx, summary);
  return getMissionDetail(ctx.missionId);
}

// Captures the uncommitted work in a worktree as text for the commit-message
// summarizer: the porcelain status (so the model sees every changed path,
// including untracked ones) followed by the tracked diff against HEAD. Read-only
// — never stages or mutates the index.
function collectWorktreeChanges(worktreePath: string): string {
  const status = runGitResult(worktreePath, ['status', '--porcelain']);
  const diff = runGitResult(worktreePath, ['diff', 'HEAD']);
  const sections: string[] = [];
  if (status.ok && status.stdout) {
    sections.push(`Changed files (git status --porcelain):\n${status.stdout}`);
  }
  if (diff.ok && diff.stdout) {
    sections.push(`Diff against HEAD:\n${diff.stdout}`);
  }
  return sections.join('\n\n');
}

/**
 * Drafts a commit message for the uncommitted changes in a mission branch's
 * worktree via the Automations Layer (Gemini). Gathers the diff host-side (the
 * same host-side git ownership as the branch actions), then summarizes it. Does
 * not persist anything — the client drops the draft into the editable commit
 * field. Throws typed errors when no work exists or the summarizer is
 * unavailable so the UI can explain why no draft appeared.
 */
export async function generateCommitMessage(
  missionRef: string
): Promise<GenerateCommitMessageResultDto> {
  const ctx = loadBranchActionContext(missionRef);
  if (!existsSync(ctx.worktreePath)) {
    throw new ApiError(
      409,
      `The branch's worktree is not present at ${ctx.worktreePath}.`,
      undefined,
      'BRANCH_NO_WORKTREE'
    );
  }
  if (!worktreeIsDirty(ctx.worktreePath)) {
    throw new ApiError(
      409,
      'There are no uncommitted changes to draft a commit message from.',
      ctx.worktreePath,
      'BRANCH_NOTHING_TO_COMMIT'
    );
  }

  const diff = collectWorktreeChanges(ctx.worktreePath);
  const message = await generateCommitMessageFromDiff({ diff, env: process.env });
  if (!message) {
    throw new ApiError(
      502,
      'Failed to draft a commit message. Check that the AI summarizer is configured.',
      undefined,
      'COMMIT_MESSAGE_GENERATION_FAILED'
    );
  }
  return { message };
}

// ---- Branch selection (available branches for a mission) ------------------
//
// Powers the mission panel's branch selector: when the planner's default branch
// is wrong, the user picks any existing branch in the project's primary repo and
// pins it as the mission's `branch_override` (consumed by the Runner Layer at the
// next launch). We list real refs so the choice is always valid.

function normalizeBranchRef(ref: string): string {
  return ref
    .replace(/^origin\//, '')
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\/origin\//, '')
    .trim();
}

// Returns the de-duplicated, sorted set of local + remote branch names in the
// mission project's primary repository, plus the branch the mission is (or will
// be) operating on. Returns an empty list when no inspectable checkout exists.
export function listMissionBranches(missionRef: string): MissionBranchListDto {
  const row = getMissionRow(missionRef);
  const current = row.active_branch?.trim() || row.branch_override?.trim() || null;
  const repoPath = primaryResourcePath(row.project_id);
  if (!repoPath || !existsSync(repoPath)) {
    return { branches: current ? [current] : [], current };
  }
  const local = runGit(repoPath, ['branch', '--format=%(refname:short)']);
  const remote = runGit(repoPath, ['branch', '-r', '--format=%(refname:short)']);
  const names = new Set<string>();
  for (const line of `${local}\n${remote}`.split('\n')) {
    const name = normalizeBranchRef(line);
    // Skip the symbolic `origin/HEAD -> origin/main` pointer git emits.
    if (name && !name.includes('->') && name !== 'HEAD') names.add(name);
  }
  if (current) names.add(current);
  return { branches: [...names].sort((a, b) => a.localeCompare(b)), current };
}

// ---- Worktree management (Settings → Worktrees) --------------------------
//
// Overlord's per-mission worktrees live under the worktree root (~/.ovld/worktrees).
// They are registered against each project's primary repository, so we enumerate
// them with `git worktree list` per project and filter to those under the root.
// The webapp server is co-located with these worktrees and operates on them
// directly (the same host-side ownership as the branch actions above).

interface WorktreeListEntry {
  path: string;
  branch: string | null;
  projectId: string;
  projectName: string;
  primaryRepoPath: string;
}

// Total size of a directory tree in bytes, skipping nested `.git` admin dirs to
// stay cheap. Best-effort: unreadable entries are ignored.
function directorySizeBytes(dir: string, budget = 20000): number {
  let total = 0;
  let visited = 0;
  const walk = (current: string): void => {
    if (visited >= budget) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= budget) return;
      visited += 1;
      const full = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          total += statSync(full).size;
        }
      } catch {
        /* skip unreadable entry */
      }
    }
  };
  walk(dir);
  return total;
}

// Enumerates every Overlord-managed worktree across the workspace's projects.
function collectWorktreeEntries(): WorktreeListEntry[] {
  const worktreeRoot = path.resolve(resolveWorktreeRoot());
  const projects = db
    .prepare(
      `SELECT id, name FROM projects
        WHERE workspace_id = ? AND deleted_at IS NULL`
    )
    .all(WORKSPACE.id) as Array<{ id: string; name: string }>;

  const entries: WorktreeListEntry[] = [];
  const seen = new Set<string>();
  for (const project of projects) {
    const repoPath = primaryResourcePath(project.id);
    if (!repoPath || !existsSync(repoPath)) continue;
    const out = runGitResult(repoPath, ['worktree', 'list', '--porcelain']);
    if (!out.ok) continue;
    let currentPath: string | null = null;
    let currentBranch: string | null = null;
    const flush = (): void => {
      if (!currentPath) return;
      const resolved = path.resolve(currentPath);
      // Only Overlord-managed worktrees (under the root); never the primary repo.
      const underRoot = resolved === worktreeRoot || resolved.startsWith(worktreeRoot + path.sep);
      if (underRoot && !seen.has(resolved)) {
        seen.add(resolved);
        entries.push({
          path: resolved,
          branch: currentBranch,
          projectId: project.id,
          projectName: project.name,
          primaryRepoPath: repoPath
        });
      }
      currentPath = null;
      currentBranch = null;
    };
    for (const line of out.stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        flush();
        currentPath = line.slice('worktree '.length).trim();
      } else if (line.startsWith('branch ')) {
        currentBranch = line
          .slice('branch '.length)
          .trim()
          .replace(/^refs\/heads\//, '');
      } else if (line.trim() === '') {
        flush();
      }
    }
    flush();
  }
  return entries;
}

function toWorktreeDto(entry: WorktreeListEntry): WorktreeDto {
  // Map the worktree's branch back to the mission operating on it, when any.
  let missionId: string | null = null;
  let missionDisplayId: string | null = null;
  let status: MissionBranchStatus | null = null;
  if (entry.branch) {
    const mission = db
      .prepare(
        `SELECT id, display_id FROM missions
          WHERE workspace_id = ? AND project_id = ? AND active_branch = ? AND deleted_at IS NULL
          ORDER BY updated_at DESC LIMIT 1`
      )
      .get(WORKSPACE.id, entry.projectId, entry.branch) as
      | { id: string; display_id: string }
      | undefined;
    if (mission) {
      missionId = mission.id;
      missionDisplayId = mission.display_id;
    }
    const baseBranch = resolveProjectBaseBranch(entry.projectId);
    status = deriveBranchStatus({
      projectId: entry.projectId,
      branchName: entry.branch,
      baseBranch
    });
  }
  const merged = status === 'merged' || status === 'merged_unpushed';
  let sizeBytes: number | null = null;
  let lastModifiedAt: string | null = null;
  try {
    lastModifiedAt = statSync(entry.path).mtime.toISOString();
    sizeBytes = directorySizeBytes(entry.path);
  } catch {
    /* directory vanished between listing and stat */
  }
  return {
    path: entry.path,
    branch: entry.branch,
    projectId: entry.projectId,
    projectName: entry.projectName,
    missionId,
    missionDisplayId,
    status,
    merged,
    dirty: worktreeIsDirty(entry.path),
    sizeBytes,
    lastModifiedAt
  };
}

export function listWorktrees(): WorktreeDto[] {
  return collectWorktreeEntries()
    .map(toWorktreeDto)
    .sort((a, b) => a.path.localeCompare(b.path));
}

// Removes a single worktree by path. Refuses a dirty worktree unless `force`,
// returning a typed error so the UI can warn before destroying uncommitted work.
export function removeWorktree(body: RemoveWorktreeBody): PurgeWorktreesResultDto {
  const target = typeof body.path === 'string' ? path.resolve(body.path.trim()) : '';
  if (!target) throw new ApiError(400, 'A worktree path is required.');
  const entry = collectWorktreeEntries().find(e => e.path === target);
  if (!entry) {
    throw new ApiError(
      404,
      'No Overlord-managed worktree at that path.',
      undefined,
      'WORKTREE_NOT_FOUND'
    );
  }
  const force = body.force === true;
  if (!force && worktreeIsDirty(entry.path)) {
    throw new ApiError(
      409,
      `The worktree has uncommitted changes — removing it would lose work: ${entry.path}`,
      'Re-run with force to remove it anyway.',
      'WORKTREE_DIRTY'
    );
  }
  const removed = removeGitWorktree(entry.primaryRepoPath, entry.path, force);
  return {
    removed: removed ? [entry.path] : [],
    skipped: removed ? [] : [{ path: entry.path, reason: 'git refused to remove the worktree' }],
    worktrees: listWorktrees()
  };
}

// Removes every clean, merged worktree in one pass ("Purge all merged"). Dirty
// worktrees are skipped (never force-removed) so in-progress work is preserved.
export function purgeMergedWorktrees(): PurgeWorktreesResultDto {
  const removed: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  for (const dto of listWorktrees()) {
    if (!dto.merged) continue;
    if (dto.dirty) {
      skipped.push({ path: dto.path, reason: 'uncommitted changes' });
      continue;
    }
    const entry = collectWorktreeEntries().find(e => e.path === dto.path);
    if (!entry) continue;
    if (removeGitWorktree(entry.primaryRepoPath, entry.path, false)) {
      removed.push(dto.path);
    } else {
      skipped.push({ path: dto.path, reason: 'git refused to remove the worktree' });
    }
  }
  return { removed, skipped, worktrees: listWorktrees() };
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

/** Tags assigned to one mission, ordered by label for stable rendering. */
function getMissionTags(missionId: string): ProjectTagDto[] {
  const rows = db
    .prepare(
      `SELECT pt.id, pt.workspace_id, pt.project_id, pt.label, pt.color, pt.active, pt.revision
         FROM mission_tags tt
         JOIN project_tags pt ON pt.id = tt.tag_id AND pt.deleted_at IS NULL
        WHERE tt.mission_id = ?
        ORDER BY pt.label COLLATE NOCASE ASC`
    )
    .all(missionId) as ProjectTagRow[];
  return rows.map(toProjectTagDto);
}

/**
 * Batch-resolve tags for many missions in one query, returning a map keyed by
 * mission id so board/list reads avoid an N+1 of per-mission tag lookups.
 */
function getTagsByMission(missionIds: string[]): Map<string, ProjectTagDto[]> {
  const byMission = new Map<string, ProjectTagDto[]>();
  if (missionIds.length === 0) return byMission;
  const placeholders = missionIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT tt.mission_id, pt.id, pt.workspace_id, pt.project_id, pt.label, pt.color, pt.active, pt.revision
         FROM mission_tags tt
         JOIN project_tags pt ON pt.id = tt.tag_id AND pt.deleted_at IS NULL
        WHERE tt.mission_id IN (${placeholders})
        ORDER BY pt.label COLLATE NOCASE ASC`
    )
    .all(...missionIds) as Array<ProjectTagRow & { mission_id: string }>;
  for (const row of rows) {
    const list = byMission.get(row.mission_id) ?? [];
    list.push(toProjectTagDto(row));
    byMission.set(row.mission_id, list);
  }
  return byMission;
}

function toObjectiveDto(r: ObjectiveRow): ObjectiveDto {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    projectId: r.project_id,
    missionId: r.mission_id,
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
    externalSessionId: r.external_session_id ?? null,
    branch: r.branch ?? null
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
    SELECT COUNT(*) FROM missions t
      WHERE t.project_id = p.id AND t.deleted_at IS NULL
  ) AS mission_count
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

  const missionCount = countMissionsOnStatus(statusId);
  if (missionCount > 0) {
    throw new ApiError(
      409,
      `Cannot delete a status used by ${missionCount} mission(s). Move them first.`
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
  // Soft-delete the definition; `mission_tags` rows cascade away via the FK so the
  // tag disappears from any mission that carried it.
  db.prepare(`DELETE FROM mission_tags WHERE tag_id = ?`).run(tagId);
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
  // Both `color` and `defaultBranch` live in `settings_json`; merge them into a
  // single update so a request that sets both doesn't clobber one with the other.
  const settingsUpdates: { color?: string | null; defaultBranch?: string | null } = {};
  if (body.color !== undefined) {
    const color = body.color ? normalizeHexColor(body.color) : null;
    if (body.color && !color) {
      throw new ApiError(400, 'Use a valid 6-digit hex color, like #d4d4d8.');
    }
    settingsUpdates.color = color;
  }
  if (body.defaultBranch !== undefined) {
    const branch = body.defaultBranch?.trim() || null;
    if (branch && !isValidBranchName(branch)) {
      throw new ApiError(400, 'Enter a valid git branch name (e.g. main, develop, release/v2).');
    }
    settingsUpdates.defaultBranch = branch;
  }
  if (settingsUpdates.color !== undefined || settingsUpdates.defaultBranch !== undefined) {
    fields.push('settings_json = @settings_json');
    params.settings_json = mergeProjectSettingsJson(existing.settings_json, settingsUpdates);
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

  // Cascade soft-delete to missions and their objectives.
  const missionIds = (
    db
      .prepare(
        `SELECT id FROM missions WHERE project_id = ? AND workspace_id = ? AND deleted_at IS NULL`
      )
      .all(id, WORKSPACE.id) as { id: string }[]
  ).map(r => r.id);

  for (const missionId of missionIds) {
    db.prepare(
      `UPDATE objectives SET deleted_at = @now, revision = revision + 1
         WHERE mission_id = @missionId AND deleted_at IS NULL`
    ).run({ missionId, now });
  }

  if (missionIds.length > 0) {
    db.prepare(
      `UPDATE missions SET deleted_at = @now, revision = revision + 1
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

// ---- Missions -------------------------------------------------------------

const selectMissionsSql = `
  SELECT t.id, t.workspace_id, t.project_id, t.display_id, t.sequence_number, t.title,
         t.status_id, t.status_type, t.board_position, t.priority,
         t.assigned_workspace_user_id,
         t.acceptance_criteria_text, t.available_tools_json,
         t.created_at, t.updated_at, t.revision, t.active_branch, t.branch_override,
         (SELECT COUNT(*) FROM objectives o
            WHERE o.mission_id = t.id AND o.deleted_at IS NULL) AS objective_count,
         (SELECT COUNT(*) FROM objectives o
            WHERE o.mission_id = t.id AND o.deleted_at IS NULL AND o.state = 'complete')
            AS completed_objective_count,
         (SELECT COUNT(*) > 0 FROM objectives o
            WHERE o.mission_id = t.id AND o.deleted_at IS NULL AND o.state = 'executing')
            AS has_executing_objective,
         (SELECT COUNT(*) > 0 FROM objectives o
            WHERE o.mission_id = t.id AND o.deleted_at IS NULL AND o.state = 'complete')
            AS has_completed_objective,
         (SELECT COUNT(*) > 0 FROM objectives o
            WHERE o.mission_id = t.id AND o.deleted_at IS NULL
              AND o.state IN ('draft', 'future') AND TRIM(o.instruction_text) != '')
            AS has_pending_objective_with_instructions
  FROM missions t
  WHERE t.workspace_id = @workspace_id AND t.deleted_at IS NULL
`;

export function listMissions(projectId: string): MissionDto[] {
  // Board order: ascending board_position within each column, with
  // sequence_number DESC as a stable tiebreaker (e.g. brand-new missions that
  // share a position before the column is first reordered).
  const rows = db
    .prepare(
      `${selectMissionsSql} AND t.project_id = @project_id
         ORDER BY t.board_position ASC, t.sequence_number DESC`
    )
    .all({ workspace_id: WORKSPACE.id, project_id: projectId }) as MissionRow[];
  const tagsByMission = getTagsByMission(rows.map(row => row.id));
  return rows.map(row => toMissionDto(row, tagsByMission.get(row.id) ?? []));
}

/**
 * Turn free-form input into an FTS5 MATCH expression: lowercase alphanumeric
 * runs become OR-combined prefix tokens. Lowercasing also neutralises FTS5's
 * uppercase boolean keywords, and stripping to alphanumeric runs keeps the
 * expression injection-safe. Returns null when there is nothing to match.
 */
function buildMissionSearchMatch(query: string): string | null {
  const terms = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (terms.length === 0) return null;
  return terms.map(term => `${term}*`).join(' OR ');
}

/**
 * Full-text mission search ranked across mission titles, objective text, and
 * mission-event summaries via the `search_documents` FTS index. Every matched
 * document is scored (title column and mission-kind weighted highest), then the
 * scores are summed per mission. Mirrors the CLI/protocol `searchMissions` service
 * so both surfaces rank identically. An empty query lists recent missions.
 */
export function searchMissions({
  query,
  projectId,
  limit = 25
}: {
  query?: string | null;
  projectId?: string | null;
  limit?: number;
}): MissionDto[] {
  const match = query?.trim() ? buildMissionSearchMatch(query.trim()) : null;

  if (!match) {
    const sql = projectId
      ? `${selectMissionsSql} AND t.project_id = @project_id ORDER BY t.updated_at DESC LIMIT @limit`
      : `${selectMissionsSql} ORDER BY t.updated_at DESC LIMIT @limit`;
    const rows = db
      .prepare(sql)
      .all({ workspace_id: WORKSPACE.id, project_id: projectId ?? null, limit }) as MissionRow[];
    const tagsByMission = getTagsByMission(rows.map(row => row.id));
    return rows.map(row => toMissionDto(row, tagsByMission.get(row.id) ?? []));
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
                 WHERE o.mission_id = t.id AND o.deleted_at IS NULL) AS objective_count,
              (SELECT COUNT(*) FROM objectives o
                 WHERE o.mission_id = t.id AND o.deleted_at IS NULL AND o.state = 'complete')
                 AS completed_objective_count,
              (SELECT COUNT(*) > 0 FROM objectives o
                 WHERE o.mission_id = t.id AND o.deleted_at IS NULL AND o.state = 'executing')
                 AS has_executing_objective,
              (SELECT COUNT(*) > 0 FROM objectives o
                 WHERE o.mission_id = t.id AND o.deleted_at IS NULL AND o.state = 'complete')
                 AS has_completed_objective,
              (SELECT COUNT(*) > 0 FROM objectives o
                 WHERE o.mission_id = t.id AND o.deleted_at IS NULL
                   AND o.state IN ('draft', 'future') AND TRIM(o.instruction_text) != '')
                 AS has_pending_objective_with_instructions,
              (CASE search_documents_fts.entity_type
                 WHEN 'mission' THEN 3.0 WHEN 'objective' THEN 2.0 ELSE 1.0 END)
                * (-bm25(search_documents_fts, 10.0, 1.0)) AS doc_score
         FROM search_documents_fts
         JOIN missions t ON t.id = search_documents_fts.mission_id
           AND t.workspace_id = @workspace_id AND t.deleted_at IS NULL${projectFilter}
        WHERE search_documents_fts MATCH @match`
    )
    .all({ workspace_id: WORKSPACE.id, project_id: projectId ?? null, match }) as Array<
    MissionRow & { doc_score: number }
  >;

  // Aggregate per-document scores into one relevance per mission, then rank.
  const byMission = new Map<string, { row: MissionRow; relevance: number }>();
  for (const row of rows) {
    const existing = byMission.get(row.id);
    if (existing) {
      existing.relevance += row.doc_score;
      continue;
    }
    byMission.set(row.id, { row, relevance: row.doc_score });
  }

  const ranked = [...byMission.values()]
    .sort(
      (left, right) =>
        right.relevance - left.relevance || right.row.updated_at.localeCompare(left.row.updated_at)
    )
    .slice(0, limit);
  const tagsByMission = getTagsByMission(ranked.map(entry => entry.row.id));
  return ranked.map(entry => toMissionDto(entry.row, tagsByMission.get(entry.row.id) ?? []));
}

// New cards drop in at the top of their column. Gap-based: one step (100) above
// the current minimum so no renumber is needed until the column is reordered.
function topBoardPosition(projectId: string, statusId: string, excludeMissionId?: string): number {
  const row = db
    .prepare(
      `SELECT MIN(board_position) AS min_pos FROM missions
         WHERE project_id = @project_id AND status_id = @status_id
           AND deleted_at IS NULL AND (@exclude IS NULL OR id != @exclude)`
    )
    .get({ project_id: projectId, status_id: statusId, exclude: excludeMissionId ?? null }) as {
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

/** Repoint denormalized project_id columns on mission-owned rows. */
function cascadeMissionProjectId({
  missionId,
  newProjectId,
  now
}: {
  missionId: string;
  newProjectId: string;
  now: string;
}): void {
  db.prepare(
    `UPDATE objectives
       SET project_id = @project_id, updated_at = @now, revision = revision + 1
     WHERE mission_id = @mission_id AND workspace_id = @workspace_id`
  ).run({ project_id: newProjectId, mission_id: missionId, workspace_id: WORKSPACE.id, now });
  db.prepare(
    `UPDATE agent_sessions
       SET project_id = @project_id, updated_at = @now, revision = revision + 1
     WHERE mission_id = @mission_id AND workspace_id = @workspace_id`
  ).run({ project_id: newProjectId, mission_id: missionId, workspace_id: WORKSPACE.id, now });
  db.prepare(
    `UPDATE mission_events SET project_id = @project_id
     WHERE mission_id = @mission_id AND workspace_id = @workspace_id`
  ).run({ project_id: newProjectId, mission_id: missionId, workspace_id: WORKSPACE.id });
  db.prepare(
    `UPDATE deliveries
       SET project_id = @project_id, updated_at = @now, revision = revision + 1
     WHERE mission_id = @mission_id AND workspace_id = @workspace_id`
  ).run({ project_id: newProjectId, mission_id: missionId, workspace_id: WORKSPACE.id, now });
  db.prepare(
    `UPDATE artifacts
       SET project_id = @project_id, updated_at = @now, revision = revision + 1
     WHERE mission_id = @mission_id AND workspace_id = @workspace_id`
  ).run({ project_id: newProjectId, mission_id: missionId, workspace_id: WORKSPACE.id, now });
  db.prepare(
    `UPDATE changed_files
       SET project_id = @project_id, updated_at = @now, revision = revision + 1
     WHERE mission_id = @mission_id AND workspace_id = @workspace_id`
  ).run({ project_id: newProjectId, mission_id: missionId, workspace_id: WORKSPACE.id, now });
  db.prepare(
    `UPDATE change_rationales
       SET project_id = @project_id, updated_at = @now, revision = revision + 1
     WHERE mission_id = @mission_id AND workspace_id = @workspace_id`
  ).run({ project_id: newProjectId, mission_id: missionId, workspace_id: WORKSPACE.id, now });
  db.prepare(
    `UPDATE execution_requests
       SET project_id = @project_id, updated_at = @now, revision = revision + 1
     WHERE mission_id = @mission_id AND workspace_id = @workspace_id`
  ).run({ project_id: newProjectId, mission_id: missionId, workspace_id: WORKSPACE.id, now });
}

function getMissionRow(missionRef: string): MissionRow {
  const byId = db
    .prepare(`${selectMissionsSql} AND t.id = @id`)
    .get({ workspace_id: WORKSPACE.id, id: missionRef }) as MissionRow | undefined;
  if (byId) return byId;

  const byDisplayId = db
    .prepare(`${selectMissionsSql} AND t.display_id = @display_id`)
    .get({ workspace_id: WORKSPACE.id, display_id: missionRef }) as MissionRow | undefined;
  if (byDisplayId) return byDisplayId;

  throw new ApiError(404, 'Mission not found');
}

export function getMissionDetail(missionRef: string): MissionDetailDto {
  const row = getMissionRow(missionRef);
  const mission = toMissionDto(row, getMissionTags(row.id));
  const objectives = listObjectives(row.id);
  const statuses = listWorkspaceStatuses();
  const executionRequests = listMissionExecutionRequests(row.id);
  return { ...mission, objectives, statuses, executionRequests, branch: missionBranchDto(row) };
}

interface MissionEventRow {
  id: string;
  mission_id: string;
  objective_id: string | null;
  type: string;
  phase: string | null;
  summary: string;
  source: string;
  external_url: string | null;
  created_at: string;
}

/**
 * Returns a mission's workflow history newest-first for the live activity feed.
 * `mission_events` is append-only, so there is no soft-delete filter; the
 * workspace scope guards against cross-workspace reads.
 */
export function listMissionEvents(missionRef: string, limit = 200): MissionEventDto[] {
  const mission = getMissionRow(missionRef);
  const rows = db
    .prepare(
      `SELECT id, mission_id, objective_id, type, phase, summary, source, external_url, created_at
         FROM mission_events
        WHERE mission_id = @mission_id AND workspace_id = @workspace_id
        ORDER BY created_at DESC, id DESC
        LIMIT @limit`
    )
    .all({ mission_id: mission.id, workspace_id: WORKSPACE.id, limit }) as MissionEventRow[];
  return rows.map(row => ({
    id: row.id,
    missionId: row.mission_id,
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
  mission_id: string;
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
 * Returns a mission's structured per-file change rationales newest-first for the
 * File Changes section, joined to the `changed_files` row (when linked) for diff
 * state and VCS status. Like the activity feed, the global SSE change feed
 * invalidates the client query so changes recorded by the agent or CLI in
 * another process stream into the panel without a manual refresh.
 */
export function listMissionFileChanges(missionRef: string, limit = 200): FileChangeDto[] {
  const mission = getMissionRow(missionRef);
  const rows = db
    .prepare(
      `SELECT cr.id, cr.mission_id, cr.objective_id, cr.file_path, cr.label, cr.summary,
              cr.why, cr.impact, cr.created_at,
              cf.current_diff_state AS diff_state, cf.vcs_status AS vcs_status
         FROM change_rationales cr
         LEFT JOIN changed_files cf
           ON cf.id = cr.changed_file_id AND cf.deleted_at IS NULL
        WHERE cr.mission_id = @mission_id AND cr.workspace_id = @workspace_id
          AND cr.deleted_at IS NULL
        ORDER BY cr.created_at DESC, cr.id DESC
        LIMIT @limit`
    )
    .all({ mission_id: mission.id, workspace_id: WORKSPACE.id, limit }) as FileChangeRow[];
  return rows.map(row => ({
    id: row.id,
    missionId: row.mission_id,
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
  mission_id: string;
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

export function listArtifacts(missionRef: string, limit = 200): ArtifactDto[] {
  const mission = getMissionRow(missionRef);
  const rows = db
    .prepare(
      `SELECT id, workspace_id, project_id, mission_id, objective_id, session_id, delivery_id,
              type, label, content_text, content_json, external_url, created_at, updated_at
         FROM artifacts
        WHERE mission_id = @mission_id AND workspace_id = @workspace_id AND deleted_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT @limit`
    )
    .all({ mission_id: mission.id, workspace_id: WORKSPACE.id, limit }) as ArtifactRow[];
  return rows.map(row => ({
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    missionId: row.mission_id,
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

function nextMissionSequence(): number {
  // Allocate the next workspace-scoped mission number, creating the counter row
  // if a fresh database somehow lacks it.
  const row = db
    .prepare(
      `SELECT id, next_value FROM mission_sequences
         WHERE workspace_id = ? AND scope_type = 'workspace'
           AND scope_id = ? AND counter_name = 'mission'`
    )
    .get(WORKSPACE.id, WORKSPACE.id) as { id: string; next_value: number } | undefined;

  if (!row) {
    const seq = 1;
    db.prepare(
      `INSERT INTO mission_sequences (id, workspace_id, scope_type, scope_id, counter_name, next_value, updated_at)
       VALUES (@id, @ws, 'workspace', @ws, 'mission', @next, @now)`
    ).run({ id: newId(), ws: WORKSPACE.id, next: seq + 1, now: nowIso() });
    return seq;
  }

  const seq = row.next_value;
  db.prepare(`UPDATE mission_sequences SET next_value = ?, updated_at = ? WHERE id = ?`).run(
    seq + 1,
    nowIso(),
    row.id
  );
  return seq;
}

type CreateMissionResult = {
  detail: MissionDetailDto;
  objectiveIds: string[];
  instruction: string;
};

const createMissionTx = db.transaction((body: CreateMissionBody): CreateMissionResult => {
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
  const sequence = nextMissionSequence();
  const displayId = `${WORKSPACE.slug}:${sequence}`;
  const boardPosition = topBoardPosition(body.projectId, statusRow.id);
  const assignedWorkspaceUserId =
    body.assignedWorkspaceUserId === undefined
      ? ACTOR_WORKSPACE_USER_ID
      : resolveAssignedWorkspaceUserId(body.assignedWorkspaceUserId);

  db.prepare(
    `INSERT INTO missions
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
    entityType: 'mission',
    entityId: id,
    operation: 'insert',
    entityRevision: 1,
    projectId: body.projectId,
    missionId: id
  });

  const objectiveIds: string[] = [];
  for (const item of objectiveInputs) {
    if (!item.objective.trim()) {
      throw new ApiError(400, 'Objective instruction is required');
    }
    const objective = insertObjective({
      missionId: id,
      instructionText: item.objective,
      ...(item.title !== undefined ? { title: item.title ?? undefined } : {}),
      autoAdvance: item.autoAdvance ?? false
    });
    objectiveIds.push(objective.id);
  }

  assignMissionTags({ missionId: id, projectId: body.projectId, tagIds: body.tagIds, now });

  return { detail: getMissionDetail(id), objectiveIds, instruction };
});

/**
 * Assign tag definitions to a mission. De-duplicates the input and validates that
 * every tag belongs to the mission's project (and is not soft-deleted) so a mission
 * can never carry a foreign-project tag. Intended to run inside the create
 * transaction. Unknown or cross-project tag ids raise a 400.
 */
function assignMissionTags({
  missionId,
  projectId,
  tagIds,
  now
}: {
  missionId: string;
  projectId: string;
  tagIds: string[] | undefined;
  now: string;
}): void {
  if (!tagIds || tagIds.length === 0) return;
  const unique = [...new Set(tagIds.map(value => value.trim()).filter(Boolean))];
  if (unique.length === 0) return;

  const insert = db.prepare(
    `INSERT OR IGNORE INTO mission_tags (mission_id, tag_id, created_at) VALUES (?, ?, ?)`
  );
  const lookup = db.prepare(
    `SELECT id FROM project_tags
       WHERE id = ? AND project_id = ? AND workspace_id = ? AND deleted_at IS NULL`
  );
  for (const tagId of unique) {
    const tag = lookup.get(tagId, projectId, WORKSPACE.id) as { id: string } | undefined;
    if (!tag) throw new ApiError(400, 'Tag does not belong to this project');
    insert.run(missionId, tagId, now);
  }
}

export function createMission(body: CreateMissionBody): MissionDetailDto {
  const { detail, objectiveIds, instruction } = createMissionTx(body);

  scheduleMissionTitleGeneration({
    missionId: detail.id,
    projectId: detail.projectId,
    instructionText: instruction
  });

  const firstObjectiveId = objectiveIds[0];
  if (firstObjectiveId) {
    scheduleObjectiveTitleGeneration({
      objectiveId: firstObjectiveId,
      projectId: detail.projectId,
      missionId: detail.id,
      instructionText: instruction
    });
  }

  return detail;
}

/**
 * Manually (re)generates a mission's title via the Automations Layer
 * summarizer, using the same instruction-text source as creation-time
 * generation (the earliest-position objective with non-empty instructions).
 * Persists the result and returns the refreshed mission detail.
 */
export async function generateMissionTitle(missionRef: string): Promise<MissionDetailDto> {
  const detail = getMissionDetail(missionRef);
  const instructionText = detail.objectives
    .find(objective => objective.instructionText.trim().length > 0)
    ?.instructionText.trim();
  if (!instructionText) {
    throw new ApiError(400, 'Add an objective before generating a title.');
  }

  const title = await generateMissionTitleNow({
    missionId: detail.id,
    projectId: detail.projectId,
    instructionText
  });
  if (!title) {
    throw new ApiError(502, 'Failed to generate a title.');
  }

  return getMissionDetail(missionRef);
}

/**
 * Validate a mission assignee. Returns the `workspace_users.id` when it names an
 * active member of the current workspace, or `null` to unassign. Throws 400 for
 * an unknown member so callers cannot point a mission at a foreign workspace.
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

const patchMissionFieldsTx = db.transaction(
  (id: string, body: UpdateMissionBody): MissionDetailDto => {
    const existing = getMissionRow(id);

    const fields: string[] = [];
    const params: Record<string, unknown> = { id, workspace_id: WORKSPACE.id };
    const changed: string[] = [];

    if (body.title !== undefined) {
      const title = body.title.trim();
      if (!title) throw new ApiError(400, 'Mission title cannot be empty');
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
    if (body.branchOverride !== undefined) {
      const override = body.branchOverride?.trim() || null;
      fields.push('branch_override = @branch_override');
      params.branch_override = override;
      changed.push('branch_override');
    }
    if (fields.length === 0) return getMissionDetail(id);

    const now = nowIso();
    const revision = existing.revision + 1;
    db.prepare(
      `UPDATE missions SET ${fields.join(', ')}, updated_at = @now, revision = @revision
         WHERE id = @id AND workspace_id = @workspace_id`
    ).run({ ...params, now, revision });

    recordChange({
      entityType: 'mission',
      entityId: id,
      operation: 'update',
      entityRevision: revision,
      projectId: existing.project_id,
      missionId: id,
      changedFields: changed
    });
    return getMissionDetail(id);
  }
);

const moveMissionProjectTx = db.transaction(
  ({
    id,
    body,
    existing,
    targetProjectId,
    statusRow
  }: {
    id: string;
    body: UpdateMissionBody;
    existing: MissionRow;
    targetProjectId: string;
    statusRow: WorkspaceStatusRow;
  }): MissionDetailDto => {
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
      if (!title) throw new ApiError(400, 'Mission title cannot be empty');
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
    cascadeMissionProjectId({ missionId: id, newProjectId: targetProjectId, now });
    db.prepare(
      `UPDATE missions SET ${fields.join(', ')}, updated_at = @now, revision = @revision
         WHERE id = @id AND workspace_id = @workspace_id`
    ).run({ ...params, now, revision });

    recordChange({
      entityType: 'mission',
      entityId: id,
      operation: 'update',
      entityRevision: revision,
      projectId: targetProjectId,
      missionId: id,
      changedFields: changed
    });
    return getMissionDetail(id);
  }
);

/** PATCH /api/missions/:id — field updates and cross-project moves. */
export function updateMission(id: string, body: UpdateMissionBody): MissionDetailDto {
  const existing = getMissionRow(id);
  if (body.projectId !== undefined && body.projectId !== existing.project_id) {
    const targetProject = db
      .prepare(`SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`)
      .get(body.projectId, WORKSPACE.id) as { id: string } | undefined;
    if (!targetProject) throw new ApiError(404, 'Project not found');

    // Statuses are workspace-shared, so a cross-project move keeps the mission's
    // current status unless the caller explicitly chooses a different one.
    const statusRow = getWorkspaceStatus(body.statusId ?? existing.status_id);

    // Composite mission/objective FKs require briefly disabling enforcement; SQLite
    // will not allow toggling the pragma inside an open transaction.
    db.pragma('foreign_keys = OFF');
    try {
      return moveMissionProjectTx({
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

  return patchMissionFieldsTx(id, body);
}

export const deleteMission = db.transaction((id: string): void => {
  const existing = getMissionRow(id);
  const now = nowIso();
  const revision = existing.revision + 1;
  // Soft-delete the mission and its objectives so referential integrity holds.
  db.prepare(
    `UPDATE objectives SET deleted_at = @now, revision = revision + 1
       WHERE mission_id = @id AND deleted_at IS NULL`
  ).run({ id, now });
  db.prepare(
    `UPDATE missions SET deleted_at = @now, revision = @revision
       WHERE id = @id AND workspace_id = @workspace_id`
  ).run({ id, now, revision, workspace_id: WORKSPACE.id });

  recordChange({
    entityType: 'mission',
    entityId: id,
    operation: 'delete',
    entityRevision: revision,
    projectId: existing.project_id,
    missionId: id
  });
});

/**
 * Reorder one board column. `orderedMissionIds` is the full top-to-bottom order
 * the `statusId` column should have afterwards. Each mission is renumbered to a
 * dense gap-based position (100, 200, 300, …); any mission arriving from another
 * column also has its status changed to match. Missions whose status and
 * position are already correct are skipped so no redundant change feed rows are
 * written. Returns the destination column in its new order.
 */
export const reorderBoardColumn = db.transaction(
  (projectId: string, body: ReorderBoardColumnBody): MissionDto[] => {
    const statusId = body.statusId;
    const orderedIds = body.orderedMissionIds;
    if (!statusId) throw new ApiError(400, 'statusId is required');
    if (!Array.isArray(orderedIds)) throw new ApiError(400, 'orderedMissionIds must be an array');

    const statusRow = db
      .prepare(
        `SELECT * FROM workspace_statuses WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
      )
      .get(statusId, WORKSPACE.id) as WorkspaceStatusRow | undefined;
    if (!statusRow) throw new ApiError(400, 'Unknown status for workspace');

    if (new Set(orderedIds).size !== orderedIds.length) {
      throw new ApiError(400, 'orderedMissionIds contains duplicates');
    }

    const now = nowIso();
    orderedIds.forEach((missionId, index) => {
      const existing = db
        .prepare(
          `SELECT * FROM missions
             WHERE id = ? AND workspace_id = ? AND project_id = ? AND deleted_at IS NULL`
        )
        .get(missionId, WORKSPACE.id, projectId) as MissionRow | undefined;
      if (!existing) throw new ApiError(404, `Mission ${missionId} not found in project`);

      const boardPosition = (index + 1) * 100;
      const statusChanged = existing.status_id !== statusId;
      const positionChanged = existing.board_position !== boardPosition;
      if (!statusChanged && !positionChanged) return;

      const setClauses = ['board_position = @board_position'];
      const sqlParams: Record<string, unknown> = {
        id: missionId,
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
        `UPDATE missions SET ${setClauses.join(', ')}, updated_at = @now, revision = @revision
           WHERE id = @id AND workspace_id = @workspace_id`
      ).run({ ...sqlParams, now, revision });

      recordChange({
        entityType: 'mission',
        entityId: missionId,
        operation: 'update',
        entityRevision: revision,
        projectId,
        missionId,
        changedFields: changed
      });
    });

    return listMissions(projectId).filter(t => t.statusId === statusId);
  }
);

// ---- My Missions (selected-workspace aggregate) ---------------------------

/** Typed error code the client renders as a workspace-specific status alert. */
const STATUS_UNAVAILABLE_FOR_WORKSPACE = 'STATUS_UNAVAILABLE_FOR_WORKSPACE';

// Gap-based spacing for a personal column position; mirrors the board's
// (index + 1) * 100 scheme so dense personal renumbers read naturally.
const MY_POSITION_STEP = 100;

interface MyMissionRow extends MissionRow {
  project_name: string;
  project_settings_json: string;
  my_position: number | null;
}

function toMyMissionDto(r: MyMissionRow, tags: ProjectTagDto[]): MyMissionDto {
  return {
    ...toMissionDto(r, tags),
    projectName: r.project_name,
    projectColor: readProjectColor(r.project_settings_json),
    myPosition: r.my_position
  };
}

// Missions assigned to the active operator across the active workspace, joined to
// their (non-deleted) project for name/color and to the operator's personal
// column position. The position only applies when its stored status_id still
// matches the mission's current status, so a status change made on the project
// board self-corrects (the mission falls back to the default order in its new
// column).
const selectMyMissionsSql = `
  SELECT t.id, t.workspace_id, t.project_id, t.display_id, t.sequence_number, t.title,
         t.status_id, t.status_type, t.board_position, t.priority,
         t.assigned_workspace_user_id,
         t.acceptance_criteria_text, t.available_tools_json,
         t.created_at, t.updated_at, t.revision,
         p.name AS project_name, p.settings_json AS project_settings_json,
         mtp.position AS my_position,
         (SELECT COUNT(*) FROM objectives o
            WHERE o.mission_id = t.id AND o.deleted_at IS NULL) AS objective_count,
         (SELECT COUNT(*) FROM objectives o
            WHERE o.mission_id = t.id AND o.deleted_at IS NULL AND o.state = 'complete')
            AS completed_objective_count,
         (SELECT COUNT(*) > 0 FROM objectives o
            WHERE o.mission_id = t.id AND o.deleted_at IS NULL AND o.state = 'executing')
            AS has_executing_objective,
         (SELECT COUNT(*) > 0 FROM objectives o
            WHERE o.mission_id = t.id AND o.deleted_at IS NULL AND o.state = 'complete')
            AS has_completed_objective,
         (SELECT COUNT(*) > 0 FROM objectives o
            WHERE o.mission_id = t.id AND o.deleted_at IS NULL
              AND o.state IN ('draft', 'future') AND TRIM(o.instruction_text) != '')
            AS has_pending_objective_with_instructions
    FROM missions t
    JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
      AND p.deleted_at IS NULL
    LEFT JOIN my_mission_positions mtp
      ON mtp.workspace_id = t.workspace_id AND mtp.mission_id = t.id
        AND mtp.workspace_user_id = @actor AND mtp.status_id = t.status_id
   WHERE t.workspace_id = @workspace_id AND t.deleted_at IS NULL
     AND t.assigned_workspace_user_id = @actor
`;

/**
 * GET /api/workspace/my-missions — missions assigned to the active operator across
 * the active workspace. Read-time merge order: positioned missions first by their
 * personal position, then unpositioned missions by the approximate default
 * aggregate order (board_position, then recency, then a stable tiebreaker). The
 * client regroups by statusId, preserving this within-column order. If no actor
 * workspace-user resolves, returns an empty list rather than broadening.
 */
export function listWorkspaceMyMissions(): MyMissionsResponse {
  if (!ACTOR_WORKSPACE_USER_ID) return { missions: [] };
  const rows = db
    .prepare(
      `${selectMyMissionsSql}
         ORDER BY (mtp.position IS NULL) ASC, mtp.position ASC,
                  t.board_position ASC, t.updated_at DESC, t.sequence_number DESC, t.id ASC`
    )
    .all({ workspace_id: WORKSPACE.id, actor: ACTOR_WORKSPACE_USER_ID }) as MyMissionRow[];
  const tagsByMission = getTagsByMission(rows.map(row => row.id));
  return { missions: rows.map(row => toMyMissionDto(row, tagsByMission.get(row.id) ?? [])) };
}

/** Insert or update one operator's personal position for a mission in a column. */
function upsertMyMissionPosition({
  missionId,
  statusId,
  position,
  actor,
  now
}: {
  missionId: string;
  statusId: string;
  position: number;
  actor: string;
  now: string;
}): void {
  const existing = db
    .prepare(
      `SELECT id, revision FROM my_mission_positions
         WHERE workspace_id = ? AND workspace_user_id = ? AND mission_id = ?`
    )
    .get(WORKSPACE.id, actor, missionId) as { id: string; revision: number } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE my_mission_positions
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
    `INSERT INTO my_mission_positions
       (id, workspace_id, workspace_user_id, mission_id, status_id, position, created_at, updated_at, revision)
     VALUES (@id, @workspace_id, @actor, @mission_id, @status_id, @position, @now, @now, 1)`
  ).run({
    id: newId(),
    workspace_id: WORKSPACE.id,
    actor,
    mission_id: missionId,
    status_id: statusId,
    position,
    now
  });
}

const reorderWorkspaceMyMissionsTx = db.transaction(
  (body: MyMissionReorderRequest): MyMissionsResponse => {
    const actor = ACTOR_WORKSPACE_USER_ID;
    if (!actor) throw new ApiError(403, 'No active workspace operator to reorder for');

    const statusId = body.statusId;
    const orderedIds = body.orderedMissionIds;
    if (!statusId) throw new ApiError(400, 'statusId is required');
    if (!Array.isArray(orderedIds)) throw new ApiError(400, 'orderedMissionIds must be an array');
    if (new Set(orderedIds).size !== orderedIds.length) {
      throw new ApiError(400, 'orderedMissionIds contains duplicates');
    }

    // Resolve the target column against the active workspace. A status the
    // workspace doesn't own can never satisfy a mission's composite FK, so reject
    // early with a typed, workspace-specific code the client renders as an alert.
    const statusRow = db
      .prepare(
        `SELECT * FROM workspace_statuses WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
      )
      .get(statusId, WORKSPACE.id) as WorkspaceStatusRow | undefined;
    if (!statusRow) {
      throw new ApiError(
        409,
        `That status is not available for missions in the ${WORKSPACE.name} workspace`,
        undefined,
        STATUS_UNAVAILABLE_FOR_WORKSPACE
      );
    }

    const now = nowIso();

    orderedIds.forEach((missionId, index) => {
      const existing = db
        .prepare(`SELECT * FROM missions WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`)
        .get(missionId, WORKSPACE.id) as MissionRow | undefined;
      if (!existing) throw new ApiError(404, `Mission ${missionId} not found in workspace`);
      if (existing.assigned_workspace_user_id !== actor) {
        throw new ApiError(403, `Mission ${missionId} is not assigned to you`);
      }

      // Cross-column drag: a real status change. Apply the canonical status-change
      // writes (status_id + denormalized status_type + reset board_position to
      // top-of-new-column) so the project board and the My Missions unpositioned
      // fallback both stay correct. The composite FK backstops invalid statuses.
      if (existing.status_id !== statusRow.id) {
        const revision = existing.revision + 1;
        db.prepare(
          `UPDATE missions
              SET status_id = @status_id, status_type = @status_type,
                  board_position = @board_position, updated_at = @now, revision = @revision
            WHERE id = @id AND workspace_id = @workspace_id`
        ).run({
          id: missionId,
          workspace_id: WORKSPACE.id,
          status_id: statusRow.id,
          status_type: statusRow.type,
          board_position: topBoardPosition(existing.project_id, statusRow.id, missionId),
          now,
          revision
        });
        recordChange({
          entityType: 'mission',
          entityId: missionId,
          operation: 'update',
          entityRevision: revision,
          projectId: existing.project_id,
          missionId,
          changedFields: ['status_id', 'status_type', 'board_position']
        });
      }

      // Personal slot within the (operator, status) column. Writes only
      // my_mission_positions — never missions.board_position for a within-column move.
      upsertMyMissionPosition({
        missionId,
        statusId: statusRow.id,
        position: (index + 1) * MY_POSITION_STEP,
        actor,
        now
      });
    });

    return listWorkspaceMyMissions();
  }
);

/**
 * PATCH /api/workspace/my-missions/order — persist a personal reorder of one My
 * Missions status column for the active operator. Translates a foreign-key
 * rejection (a status the mission's workspace lacks) into the typed
 * `STATUS_UNAVAILABLE_FOR_WORKSPACE` error so the client can alert and revert.
 */
export function reorderWorkspaceMyMissions(body: MyMissionReorderRequest): MyMissionsResponse {
  try {
    return reorderWorkspaceMyMissionsTx(body);
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      (err as { code?: string }).code === 'SQLITE_CONSTRAINT_FOREIGNKEY'
    ) {
      throw new ApiError(
        409,
        `That status is not available for missions in the ${WORKSPACE.name} workspace`,
        undefined,
        STATUS_UNAVAILABLE_FOR_WORKSPACE
      );
    }
    throw err;
  }
}

// ---- Objectives ----------------------------------------------------------

export function listObjectives(missionId: string): ObjectiveDto[] {
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
        WHERE o.mission_id = ? AND o.deleted_at IS NULL
        ORDER BY o.position ASC`
    )
    .all(missionId) as ObjectiveRow[];
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
 * Reorder a mission's `future` objectives. `orderedObjectiveIds` is the full
 * top-to-bottom order the future group should have afterwards. The future rows
 * are renumbered relative to one another starting at the lowest position they
 * currently occupy, so they keep sitting after any non-future objectives.
 * Objectives whose position is already correct are skipped so no redundant
 * change-feed rows are written. Returns the mission's full objective list in its
 * new order.
 */
export const reorderFutureObjectives = db.transaction(
  (missionId: string, body: ReorderFutureObjectivesBody): ObjectiveDto[] => {
    const orderedIds = body.orderedObjectiveIds;
    if (!Array.isArray(orderedIds)) {
      throw new ApiError(400, 'orderedObjectiveIds must be an array');
    }
    if (new Set(orderedIds).size !== orderedIds.length) {
      throw new ApiError(400, 'orderedObjectiveIds contains duplicates');
    }

    const mission = db
      .prepare(
        `SELECT id, project_id FROM missions WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
      )
      .get(missionId, WORKSPACE.id) as { id: string; project_id: string } | undefined;
    if (!mission) throw new ApiError(404, 'Mission not found');

    const rows = db
      .prepare(
        `SELECT * FROM objectives
           WHERE mission_id = ? AND workspace_id = ? AND deleted_at IS NULL`
      )
      .all(missionId, WORKSPACE.id) as ObjectiveRow[];
    const byId = new Map(rows.map(row => [row.id, row]));

    const targets = orderedIds.map(id => {
      const row = byId.get(id);
      if (!row) throw new ApiError(404, `Objective ${id} not found on mission`);
      if (row.state !== 'future') {
        throw new ApiError(400, `Objective ${id} is not a future objective`);
      }
      return row;
    });
    if (targets.length === 0) return listObjectives(missionId);

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
        projectId: mission.project_id,
        missionId,
        objectiveId: existing.id,
        changedFields: ['position']
      });
    });

    return listObjectives(missionId);
  }
);

// Internal insert used by both createObjective and createMission's first objective.
// Assumes it runs within a transaction.
function insertObjective(body: CreateObjectiveBody): ObjectiveDto {
  const instruction = (body.instructionText ?? '').trim();

  const mission = db
    .prepare(
      `SELECT id, project_id FROM missions WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
    )
    .get(body.missionId, WORKSPACE.id) as { id: string; project_id: string } | undefined;
  if (!mission) throw new ApiError(404, 'Mission not found');

  const requestedState = body.state ?? 'draft';
  if (!VALID_STATES.includes(requestedState)) throw new ApiError(400, 'Invalid objective state');

  const draftRow = db
    .prepare(
      `SELECT id FROM objectives
       WHERE mission_id = ? AND workspace_id = ? AND state = 'draft' AND deleted_at IS NULL
       LIMIT 1`
    )
    .get(body.missionId, WORKSPACE.id) as { id: string } | undefined;
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
      `SELECT MAX(position) AS max_pos FROM objectives WHERE mission_id = ? AND deleted_at IS NULL`
    )
    .get(body.missionId) as { max_pos: number | null };
  const position = (maxRow.max_pos ?? -1) + 1;

  // Editable slots (draft/future) default to the project's last-used launch
  // selection so the agent is always recorded on the objective. The launch button
  // reads the stored agent, and auto-advance/execution use it, so what the user
  // sees and what runs stay in agreement instead of falling back to a hardcoded
  // runner default.
  const launchSelection =
    state === 'draft' || state === 'future'
      ? getLaunchPreference(mission.project_id)
      : { selectedAgent: null, selectedModel: null, selectedReasoningEffort: null };

  const now = nowIso();
  const id = newId();
  db.prepare(
    `INSERT INTO objectives
       (id, workspace_id, project_id, mission_id, position, title, instruction_text, state,
        assigned_agent, model, reasoning_effort, agent_flags_json, auto_advance,
        execution_metadata_json, created_by_workspace_user_id, created_at, updated_at, revision)
     VALUES (@id, @ws, @project_id, @mission_id, @position, @title, @instruction, @state,
        @assigned_agent, @model, @reasoning_effort, '{}', @auto_advance, '{}', @actor,
        @now, @now, 1)`
  ).run({
    id,
    ws: WORKSPACE.id,
    project_id: mission.project_id,
    mission_id: body.missionId,
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
    projectId: mission.project_id,
    missionId: body.missionId,
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
      missionId: objective.missionId,
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
           WHERE mission_id = ? AND workspace_id = ? AND state = 'draft'
             AND id <> ? AND deleted_at IS NULL`
        )
        .all(existing.mission_id, WORKSPACE.id, id) as Array<{ id: string; revision: number }>;

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
          missionId: existing.mission_id,
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
      missionId: existing.mission_id,
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
        missionId: existing.mission_id,
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
      missionId: objective.missionId,
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
    missionId: existing.mission_id,
    objectiveId: id
  });

  // A deleted objective must also leave the runner queue: the runner's claim
  // query joins objectives without filtering soft-deletes, so stale queued
  // requests could otherwise still be claimed.
  dequeueObjective({
    objectiveId: id,
    projectId: existing.project_id,
    missionId: existing.mission_id,
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
    scope: scopeGrants.length > 0 ? 'mission_lifecycle' : 'full',
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
    if (scope !== 'full' && scope !== 'mission_lifecycle') {
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
