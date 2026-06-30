import { scopeGrantsForPreset } from '@overlord/auth';
import { bindBool, type DatabaseClient } from '@overlord/database';
import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { ensureActingDeviceTarget } from '../packages/core/service/execution-targets.ts';
import { resolveBackendResourceProvider } from '../packages/core/service/local-target/index.ts';
import type { TargetMetadata } from '../packages/core/service/local-target/types.ts';
import {
  loadMissionBranchObservationsForMissions,
  mergeMissionBranchObservation
} from '../packages/core/service/mission-branch-observations.ts';
import { resolveProjectExecutionTargetForLaunch } from '../packages/core/service/project-execution-target.ts';
import {
  loadTargetResourceObservations,
  mergeResourceStatusWithObservation,
  type TargetResourceObservationRow
} from '../packages/core/service/target-resource-observations.ts';
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
  MissionDetailDto,
  MissionDto,
  MissionEventDto,
  MissionWorktreePreference,
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
} from '../webapp/shared/contract.ts';

import { missionWorktreePath, previewMissionBranch } from './branch-planning.ts';
import { generateCommitMessageFromDiff } from './commit-message-automation.ts';
import {
  buildWebappServiceContext,
  DATABASE_DIALECT,
  getActorWorkspaceUserId,
  newId,
  nowIso,
  recordChange,
  type RecordChangeInput,
  requireDatabaseClient,
  WORKSPACE
} from './db.ts';
import { ApiError } from './errors.ts';
import {
  dequeueObjective,
  getLaunchPreference,
  LAUNCHABLE_STATES,
  listMissionExecutionRequests,
  readWorktreeBranchAutomationEnabled
} from './launch.ts';
import {
  queueLocalTargetMutation,
  resolveMutationAnchorMissionId,
  resolveRemoteMutationTarget
} from './local-target-mutation-queue.ts';
import { loadActorRoles } from './rbac.ts';
import {
  generateMissionTitleNow,
  initialTitleFromInstruction,
  scheduleMissionTitleGeneration,
  scheduleObjectiveTitleGeneration
} from './title-automation.ts';

export { ApiError };

/** Control-plane provider: never touches linked checkout paths on the server (WS-F3). */
function checkoutControlPlaneProvider(target: TargetMetadata) {
  return resolveBackendResourceProvider(false, target);
}

function throwCheckoutLocalRequired(): never {
  throw new ApiError(
    409,
    'Checkout-local work must run on a local execution target (Overlord Desktop or the dev invoke proxy).',
    'The hosted Overlord backend stores metadata and queues work, but it cannot inspect or mutate your local filesystem.',
    'LOCAL_FILESYSTEM_UNAVAILABLE'
  );
}

/** Metadata for capability calls that must not run on the control-plane backend. */
function backendTargetMetadata(executionTargetId: string | null): TargetMetadata {
  return { executionTargetId, deviceLabel: null, transport: 'in_process' };
}

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
export const PROJECT_EVERHOUR_PROJECT_ID_SETTINGS_KEY = 'overlord.everhourProjectId';
export const PROJECT_EVERHOUR_PROJECT_NAME_SETTINGS_KEY = 'overlord.everhourProjectName';
export const PROJECT_EVERHOUR_SECTION_ID_SETTINGS_KEY = 'overlord.everhourSectionId';

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

export function readProjectEverhourProjectId(settingsJson: string): string | null {
  return readProjectStringSetting(settingsJson, PROJECT_EVERHOUR_PROJECT_ID_SETTINGS_KEY);
}

export function readProjectEverhourProjectName(settingsJson: string): string | null {
  return readProjectStringSetting(settingsJson, PROJECT_EVERHOUR_PROJECT_NAME_SETTINGS_KEY);
}

export function readProjectEverhourSectionId(settingsJson: string): string | null {
  return readProjectStringSetting(settingsJson, PROJECT_EVERHOUR_SECTION_ID_SETTINGS_KEY);
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

async function uniqueStatusKey(db: DatabaseClient, { name }: { name: string }): Promise<string> {
  const base = slugify(name).replace(/-/g, '_');
  let key = base;
  let suffix = 2;
  while (
    await db.get(`SELECT 1 FROM workspace_statuses WHERE workspace_id = ? AND key = ?`, [
      WORKSPACE.id,
      key
    ])
  ) {
    key = `${base}_${suffix}`;
    suffix += 1;
  }
  return key;
}

async function getWorkspaceStatusRow(
  db: DatabaseClient,
  statusId: string
): Promise<WorkspaceStatusRow> {
  const row = (await db.get(
    `SELECT id, workspace_id, key, name, type, position, is_default, is_terminal, revision
         FROM workspace_statuses
        WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [statusId, WORKSPACE.id]
  )) as WorkspaceStatusRow | undefined;
  if (!row) throw new ApiError(404, 'Status not found');
  return row;
}

async function assertUniqueStatusName(
  db: DatabaseClient,
  {
    name,
    excludeStatusId
  }: {
    name: string;
    excludeStatusId?: string;
  }
): Promise<void> {
  const existing = await db.get(
    `SELECT 1 FROM workspace_statuses
        WHERE workspace_id = ? AND deleted_at IS NULL AND lower(name) = lower(?)
          AND id != ?`,
    [WORKSPACE.id, name, excludeStatusId ?? '']
  );
  if (existing) throw new ApiError(409, `A status named "${name}" already exists`);
}

async function countActiveStatusesByType(
  db: DatabaseClient,
  { type }: { type: string }
): Promise<number> {
  const row = (await db.get(
    `SELECT COUNT(*) AS count FROM workspace_statuses
        WHERE workspace_id = ? AND type = ? AND deleted_at IS NULL`,
    [WORKSPACE.id, type]
  )) as { count: number };
  return row.count;
}

async function countMissionsOnStatus(db: DatabaseClient, statusId: string): Promise<number> {
  const row = (await db.get(
    `SELECT COUNT(*) AS count FROM missions WHERE status_id = ? AND deleted_at IS NULL`,
    [statusId]
  )) as { count: number };
  return row.count;
}

async function clearWorkspaceDefaultStatuses(
  db: DatabaseClient,
  { now }: { now: string }
): Promise<void> {
  await db.run(
    `UPDATE workspace_statuses
        SET is_default = ?, updated_at = ?, revision = revision + 1
      WHERE workspace_id = ? AND is_default = ? AND deleted_at IS NULL`,
    [bindBool(DATABASE_DIALECT, false), now, WORKSPACE.id, bindBool(DATABASE_DIALECT, true)]
  );
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
  worktree_preference: string | null;
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

function orderByLabelAsc(column: string): string {
  return DATABASE_DIALECT === 'sqlite' ? `${column} COLLATE NOCASE ASC` : `LOWER(${column}) ASC`;
}

function toProjectDto(r: ProjectRow): ProjectDto {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    color: readProjectColor(r.settings_json),
    defaultBranch: readProjectDefaultBranch(r.settings_json),
    everhourProjectName: readProjectEverhourProjectName(r.settings_json),
    everhourProjectId: readProjectEverhourProjectId(r.settings_json),
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

function isTruthyFlag(value: unknown): boolean {
  return value === true || value === 1;
}

async function toProjectResourceDto(
  r: ProjectResourceRow,
  observationsByResourceId: Map<string, TargetResourceObservationRow> = new Map()
): Promise<ProjectResourceDto> {
  const merged = mergeResourceStatusWithObservation({
    lifecycleStatus: r.status,
    resourceExecutionTargetId: r.execution_target_id,
    observation: observationsByResourceId.get(r.id)
  });
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    projectId: r.project_id,
    executionTargetId: r.execution_target_id,
    type: r.type as ProjectResourceDto['type'],
    label: r.label,
    path: r.path,
    isPrimary: isTruthyFlag(r.is_primary),
    status: merged.status as ProjectResourceDto['status'],
    observedAt: merged.observedAt,
    observationSource: merged.observedAt ? 'client' : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    revision: r.revision
  };
}

async function executionTargetBelongsToWorkspace(
  db: DatabaseClient,
  executionTargetId: string
): Promise<boolean> {
  const row = (await db.get(
    `SELECT id FROM execution_targets
        WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [executionTargetId, WORKSPACE.id]
  )) as { id: string } | undefined;
  return Boolean(row);
}

async function resolveResourceExecutionTargetId(
  db: DatabaseClient,
  executionTargetId: string | null | undefined
): Promise<string | null> {
  if (executionTargetId === undefined) {
    return (
      await ensureActingDeviceTarget({
        ctx: buildWebappServiceContext(db)
      })
    ).executionTargetId;
  }

  if (executionTargetId === null) return null;

  const trimmed = executionTargetId.trim();
  if (!trimmed) return null;
  if (!(await executionTargetBelongsToWorkspace(db, trimmed))) {
    throw new ApiError(404, 'Execution target not found');
  }
  return trimmed;
}

async function getProjectResourceRow(
  db: DatabaseClient,
  projectId: string,
  resourceId: string
): Promise<ProjectResourceRow> {
  await getProject(projectId, db);
  const row = (await db.get(
    `SELECT id, workspace_id, project_id, execution_target_id, type, label, path,
              is_primary, status, created_at, updated_at, revision
         FROM project_resources
        WHERE id = ? AND project_id = ? AND deleted_at IS NULL`,
    [resourceId, projectId]
  )) as ProjectResourceRow | undefined;
  if (!row) throw new ApiError(404, 'Resource not found');
  return row;
}

async function clearPrimaryResourcesForTarget(
  db: DatabaseClient,
  {
    projectId,
    executionTargetId,
    now
  }: {
    projectId: string;
    executionTargetId: string | null;
    now: string;
  }
): Promise<void> {
  if (executionTargetId === null) {
    await db.run(
      `UPDATE project_resources
        SET is_primary = ?, updated_at = ?, revision = revision + 1
      WHERE project_id = ?
        AND deleted_at IS NULL
        AND is_primary = ?
        AND execution_target_id IS NULL`,
      [bindBool(DATABASE_DIALECT, false), now, projectId, bindBool(DATABASE_DIALECT, true)]
    );
  } else {
    await db.run(
      `UPDATE project_resources
        SET is_primary = ?, updated_at = ?, revision = revision + 1
      WHERE project_id = ?
        AND deleted_at IS NULL
        AND is_primary = ?
        AND execution_target_id = ?`,
      [
        bindBool(DATABASE_DIALECT, false),
        now,
        projectId,
        bindBool(DATABASE_DIALECT, true),
        executionTargetId
      ]
    );
  }
}

async function promoteFallbackPrimary(
  db: DatabaseClient,
  {
    projectId,
    executionTargetId,
    now
  }: {
    projectId: string;
    executionTargetId: string | null;
    now: string;
  }
): Promise<void> {
  const primary = (await (executionTargetId === null
    ? db.get(
        `SELECT id FROM project_resources
        WHERE project_id = ?
          AND deleted_at IS NULL
          AND is_primary = ?
          AND execution_target_id IS NULL
        LIMIT 1`,
        [projectId, bindBool(DATABASE_DIALECT, true)]
      )
    : db.get(
        `SELECT id FROM project_resources
        WHERE project_id = ?
          AND deleted_at IS NULL
          AND is_primary = ?
          AND execution_target_id = ?
        LIMIT 1`,
        [projectId, bindBool(DATABASE_DIALECT, true), executionTargetId]
      ))) as { id: string } | undefined;
  if (primary) return;

  const fallback = (await (executionTargetId === null
    ? db.get(
        `SELECT id FROM project_resources
        WHERE project_id = ?
          AND deleted_at IS NULL
          AND execution_target_id IS NULL
        ORDER BY created_at ASC
        LIMIT 1`,
        [projectId]
      )
    : db.get(
        `SELECT id FROM project_resources
        WHERE project_id = ?
          AND deleted_at IS NULL
          AND execution_target_id = ?
        ORDER BY created_at ASC
        LIMIT 1`,
        [projectId, executionTargetId]
      ))) as { id: string } | undefined;
  if (!fallback) return;

  await db.run(
    `UPDATE project_resources
        SET is_primary = ?, updated_at = ?, revision = revision + 1
      WHERE id = ?`,
    [bindBool(DATABASE_DIALECT, true), now, fallback.id]
  );
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
// from a freshly-cut branch — see CONTRACT.md branch status derivation).
async function deriveBranchStatus(_input: {
  projectId: string;
  branchName: string;
  baseBranch: string | null;
  executionTargetId?: string | null;
}): Promise<'created' | 'published' | 'merged_unpushed' | 'merged'> {
  // Live git status is observed on the client via the desktop bridge (WS-F2/F3).
  return 'created';
}

async function getProjectSlug(projectId: string): Promise<string> {
  const row = (await requireDatabaseClient().get(
    `SELECT slug FROM projects WHERE id = ? AND workspace_id = ?`,
    [projectId, WORKSPACE.id]
  )) as { slug: string } | undefined;
  return row?.slug ?? 'project';
}

// The fallback base/parent branch when neither project configuration nor an
// inspectable primary checkout can provide one.
const FALLBACK_BASE_BRANCH = 'main';

async function primaryCheckoutBranch(
  _projectId: string,
  _executionTargetId?: string | null
): Promise<string | null> {
  return null;
}

// Resolves the base/parent branch for new mission branches: the project-
// configured default branch (Resources settings) when set, otherwise the branch
// checked out in the project's primary/main worktree, otherwise `main`.
async function resolveProjectBaseBranch(
  projectId: string,
  executionTargetId?: string | null
): Promise<string> {
  const row = (await requireDatabaseClient().get(
    `SELECT settings_json FROM projects WHERE id = ? AND workspace_id = ?`,
    [projectId, WORKSPACE.id]
  )) as { settings_json: string } | undefined;
  return (
    (row && readProjectDefaultBranch(row.settings_json)) ||
    (await primaryCheckoutBranch(projectId, executionTargetId)) ||
    FALLBACK_BASE_BRANCH
  );
}

async function preparedBaseBranch(missionId: string, branchName: string): Promise<string | null> {
  const rows = (await requireDatabaseClient().all(
    `SELECT payload_json FROM mission_events
        WHERE workspace_id = ? AND mission_id = ?
          AND payload_json IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 50`,
    [WORKSPACE.id, missionId]
  )) as { payload_json: string | null }[];

  for (const row of rows) {
    if (!row.payload_json) continue;
    try {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      let payloadBranch = '';
      if (typeof payload.branchName === 'string') {
        payloadBranch = payload.branchName.trim();
      } else if (typeof payload.branch === 'string') {
        payloadBranch = payload.branch.trim();
      }
      const baseBranch = typeof payload.baseBranch === 'string' ? payload.baseBranch.trim() : '';
      if (payloadBranch === branchName && baseBranch) return baseBranch;
    } catch {
      // Ignore unrelated or legacy event payloads.
    }
  }
  return null;
}

async function resolveMissionBaseBranch({
  projectId,
  missionId,
  branchName,
  executionTargetId
}: {
  projectId: string;
  missionId: string;
  branchName: string;
  executionTargetId?: string | null;
}): Promise<string> {
  return (
    (await preparedBaseBranch(missionId, branchName)) ||
    (await resolveProjectBaseBranch(projectId, executionTargetId))
  );
}

// Normalizes the raw `missions.worktree_preference` column to the contract type.
// Unknown values (forward-compat with future modes) read as "inherit" (null).
function parseWorktreePreference(value: string | null): MissionWorktreePreference | null {
  return value === 'worktree' || value === 'branch' ? value : null;
}

// Resolves a mission's effective branch behavior by combining its per-mission
// preference with the workspace automation setting (coo:9). When the preference
// is null the mission inherits the workspace setting (the original behavior);
// `'worktree'`/`'branch'` opt an individual mission in regardless of the setting.
async function resolveBranchAutomation(preference: MissionWorktreePreference | null): Promise<{
  automationEnabled: boolean;
  willPrepareBranch: boolean;
  willUseWorktree: boolean;
}> {
  const automationEnabled = await readWorktreeBranchAutomationEnabled();
  const willPrepareBranch =
    preference === 'worktree' ||
    preference === 'branch' ||
    (preference === null && automationEnabled);
  const willUseWorktree = preference === 'worktree' || (preference === null && automationEnabled);
  return { automationEnabled, willPrepareBranch, willUseWorktree };
}

// Where a prepared branch actually lives. Worktree-mode missions live in their
// dedicated worktree (the canonical path); branch-only missions are checked out
// in the project's primary repo. Prefer git's view of where the branch is
// checked out, falling back to the canonical worktree path.
async function resolvePreparedWorktreePath({
  fallback
}: {
  projectId: string;
  branchName: string;
  fallback: string;
  executionTargetId?: string | null;
}): Promise<string> {
  return fallback;
}

// Derives the mission-panel branch metadata from `missions.active_branch` (the
// source of truth the runner writes). When it is null no branch has been
// prepared yet, so we surface the planner's predicted name with a pending status.
async function missionBranchDto(row: MissionRow): Promise<MissionBranchDto> {
  const executionTargetId = await resolveProjectResourceScopeTargetId(row.project_id);
  const projectSlug = await getProjectSlug(row.project_id);
  const worktreeRoot = resolveWorktreeRoot();
  const overrideBranch = row.branch_override?.trim() || null;
  const worktreePreference = parseWorktreePreference(row.worktree_preference);
  const { automationEnabled, willPrepareBranch, willUseWorktree } =
    await resolveBranchAutomation(worktreePreference);
  const name = row.active_branch?.trim();
  if (name) {
    const baseBranch = await resolveMissionBaseBranch({
      projectId: row.project_id,
      missionId: row.id,
      branchName: name,
      executionTargetId
    });
    const canonical = missionWorktreePath({ worktreeRoot, projectSlug, branch: name });
    const worktreePath = await resolvePreparedWorktreePath({
      projectId: row.project_id,
      branchName: name,
      fallback: canonical,
      executionTargetId
    });
    const branch = {
      name,
      baseBranch,
      worktreePath,
      status: await deriveBranchStatus({
        projectId: row.project_id,
        branchName: name,
        baseBranch,
        executionTargetId
      }),
      dirty: false,
      overrideBranch,
      worktreeAutomationEnabled: automationEnabled,
      worktreePreference,
      willPrepareBranch,
      willUseWorktree
    };
    const observations = await loadMissionBranchObservationsForMissions({
      ctx: buildWebappServiceContext(),
      executionTargetId,
      missionIds: [row.id]
    });
    return mergeMissionBranchObservation({
      controlPlaneBranch: branch,
      observation: observations.get(row.id)
    });
  }

  // No branch prepared yet: preview the name the next launch will use. A pinned
  // override wins over the planner's canonical prediction so the panel reflects
  // exactly what the next launch will prepare.
  const baseBranch = await resolveProjectBaseBranch(row.project_id, executionTargetId);
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
    overrideBranch,
    worktreeAutomationEnabled: automationEnabled,
    worktreePreference,
    willPrepareBranch,
    willUseWorktree
  };
}

// ---- Branch actions (merge with parent / push / publish) -----------------
//
// Git mutations route through the local-target capability provider (WS-D 4).
// The REST layer resolves mission/project paths, then calls
// `performBranchAction` on an in-process provider when co-located.

export type BranchActionName = 'integrate' | 'commit' | 'push_parent' | 'publish';

interface BranchActionContext {
  missionId: string;
  projectId: string;
  branchName: string;
  baseBranch: string;
  worktreePath: string;
  primaryRepoPath: string;
}

async function resolveProjectResourceScopeTargetId(projectId: string): Promise<string | null> {
  return resolveProjectExecutionTargetForLaunch({
    ctx: buildWebappServiceContext(),
    projectId
  });
}

async function primaryResource(
  projectId: string,
  executionTargetId?: string | null
): Promise<{ id: string; path: string } | null> {
  const targetId =
    executionTargetId === undefined
      ? await resolveProjectResourceScopeTargetId(projectId)
      : executionTargetId;

  const row = (await (targetId === null
    ? requireDatabaseClient().get(
        `SELECT id, path FROM project_resources
            WHERE project_id = ? AND workspace_id = ?
              AND status = 'active' AND deleted_at IS NULL
            ORDER BY is_primary DESC, created_at ASC
            LIMIT 1`,
        [projectId, WORKSPACE.id]
      )
    : requireDatabaseClient().get(
        `SELECT id, path FROM project_resources
            WHERE project_id = ? AND workspace_id = ?
              AND (execution_target_id = ? OR execution_target_id IS NULL)
              AND status = 'active' AND deleted_at IS NULL
            ORDER BY
              CASE WHEN execution_target_id = ? THEN 0 ELSE 1 END,
              is_primary DESC,
              created_at ASC
            LIMIT 1`,
        [projectId, WORKSPACE.id, targetId, targetId]
      ))) as { id: string; path: string } | undefined;
  return row ?? null;
}

async function primaryResourcePath(
  projectId: string,
  executionTargetId?: string | null
): Promise<string | null> {
  return (await primaryResource(projectId, executionTargetId))?.path ?? null;
}

async function loadBranchActionContext(missionRef: string): Promise<BranchActionContext> {
  const row = await getMissionRow(missionRef);
  const branchName = row.active_branch?.trim();
  if (!branchName) {
    throw new ApiError(
      409,
      'No branch has been prepared for this mission yet.',
      undefined,
      'BRANCH_NOT_PREPARED'
    );
  }
  const executionTargetId = await resolveProjectResourceScopeTargetId(row.project_id);
  const primaryRepoPath = await primaryResourcePath(row.project_id, executionTargetId);
  if (!primaryRepoPath) {
    throw new ApiError(
      409,
      'This project has no connected primary working directory on this device.',
      undefined,
      'BRANCH_NO_PRIMARY'
    );
  }
  // A worktree-mode mission lives in its dedicated worktree (the canonical path);
  // a branch-only mission (coo:9) is checked out in the primary repo. Resolve the
  // location git actually has the branch checked out at so the action operates in
  // the right place, falling back to the canonical worktree path.
  const canonicalWorktree = missionWorktreePath({
    worktreeRoot: resolveWorktreeRoot(),
    projectSlug: await getProjectSlug(row.project_id),
    branch: branchName
  });
  return {
    missionId: row.id,
    projectId: row.project_id,
    branchName,
    baseBranch: await resolveMissionBaseBranch({
      projectId: row.project_id,
      missionId: row.id,
      branchName,
      executionTargetId
    }),
    worktreePath: await resolvePreparedWorktreePath({
      projectId: row.project_id,
      branchName,
      fallback: canonicalWorktree,
      executionTargetId
    }),
    primaryRepoPath
  };
}

async function missionHasActiveExecution(missionId: string): Promise<boolean> {
  return Boolean(
    await requireDatabaseClient().get(
      `SELECT 1 FROM execution_requests
          WHERE mission_id = ? AND workspace_id = ?
            AND status IN ('queued', 'claimed', 'launching')
          LIMIT 1`,
      [missionId, WORKSPACE.id]
    )
  );
}

async function recordBranchActionActivity(
  ctx: BranchActionContext,
  summary: string
): Promise<void> {
  await requireDatabaseClient().transaction(async tx => {
    const mission = (await tx.get(
      `SELECT revision FROM missions WHERE id = ? AND workspace_id = ?`,
      [ctx.missionId, WORKSPACE.id]
    )) as { revision: number } | undefined;
    const now = nowIso();
    if (mission) {
      const revision = mission.revision + 1;
      await tx.run(
        `UPDATE missions SET updated_at = ?, revision = ?
         WHERE id = ? AND workspace_id = ?`,
        [now, revision, ctx.missionId, WORKSPACE.id]
      );
      await recordChange(
        {
          entityType: 'mission',
          entityId: ctx.missionId,
          operation: 'update',
          entityRevision: revision,
          projectId: ctx.projectId,
          missionId: ctx.missionId,
          changedFields: ['active_branch']
        },
        tx
      );
    }
    await tx.run(
      `INSERT INTO mission_events
       (id, workspace_id, project_id, mission_id, objective_id, type, phase, summary,
        payload_json, source, actor_workspace_user_id, created_at)
     VALUES (?, ?, ?, ?, NULL, 'update', 'execute', ?, ?, 'webapp', ?, ?)`,
      [
        newId(),
        WORKSPACE.id,
        ctx.projectId,
        ctx.missionId,
        summary,
        JSON.stringify({ branch: ctx.branchName, baseBranch: ctx.baseBranch }),
        getActorWorkspaceUserId(),
        now
      ]
    );
  });
}

// Runs an on-demand branch mutation and returns the refreshed mission detail.
// Git side-effects happen first (and throw typed ApiErrors on failure); only on
// success do we record the activity + realtime change in a single transaction.
export async function performBranchAction(
  missionRef: string,
  body: {
    action?: unknown;
    message?: unknown;
    confirmBusy?: unknown;
    clientExecuted?: unknown;
    summary?: unknown;
  }
): Promise<MissionDetailDto> {
  const action = String(body.action ?? '') as BranchActionName;
  if (
    action !== 'integrate' &&
    action !== 'commit' &&
    action !== 'push_parent' &&
    action !== 'publish'
  ) {
    throw new ApiError(400, 'Invalid branch action.');
  }
  const ctx = await loadBranchActionContext(missionRef);
  if (body.confirmBusy !== true && (await missionHasActiveExecution(ctx.missionId))) {
    throw new ApiError(
      409,
      'An objective is currently executing on this branch. Continuing may conflict with in-progress work in its worktree.',
      'Re-run with confirmation to proceed anyway.',
      'BRANCH_BUSY_EXECUTING'
    );
  }

  if (body.clientExecuted === true) {
    const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
    if (!summary) {
      throw new ApiError(400, 'A branch-action summary is required when clientExecuted is true.');
    }
    await recordBranchActionActivity(ctx, summary);
    return getMissionDetail(ctx.missionId);
  }

  const remoteTarget = await resolveRemoteMutationTarget({
    ctx: buildWebappServiceContext(),
    projectId: ctx.projectId
  });
  if (remoteTarget.queue) {
    await queueLocalTargetMutation({
      projectId: ctx.projectId,
      missionId: ctx.missionId,
      executionTargetId: remoteTarget.executionTargetId,
      kind: 'branch_action',
      capability: 'performBranchAction',
      input: {
        action,
        branchName: ctx.branchName,
        baseBranch: ctx.baseBranch,
        worktreePath: ctx.worktreePath,
        primaryRepoPath: ctx.primaryRepoPath,
        ...(typeof body.message === 'string' ? { message: body.message } : {})
      },
      eventSummary: `Queued branch action "${action}" on remote execution target.`
    });
    return getMissionDetail(ctx.missionId);
  }

  throwCheckoutLocalRequired();
}

/**
 * Drafts a commit message for the uncommitted changes in a mission branch's
 * worktree via the Automations Layer (Gemini). Gathers the diff through the
 * local-target provider, then summarizes it on the backend. Does not persist
 * anything — the client drops the draft into the editable commit field. Throws
 * typed errors when no work exists or the summarizer is unavailable so the UI
 * can explain why no draft appeared.
 */
export async function generateCommitMessage(
  missionRef: string,
  body: { diff?: unknown } = {}
): Promise<GenerateCommitMessageResultDto> {
  await loadBranchActionContext(missionRef);
  const diff = typeof body.diff === 'string' ? body.diff.trim() : '';
  if (!diff) {
    throwCheckoutLocalRequired();
  }

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

// Returns the mission's current/pinned branch from metadata. Full ref lists come
// from the desktop local-target bridge (WS-F3).
export async function listMissionBranches(missionRef: string): Promise<MissionBranchListDto> {
  const row = await getMissionRow(missionRef);
  const current = row.active_branch?.trim() || row.branch_override?.trim() || null;
  return { branches: current ? [current] : [], current };
}

// ---- Worktree management (Settings → Worktrees) --------------------------
//
// Listing and git mutations run on the client via the desktop bridge (WS-F3).
// The control plane only acknowledges client-executed removals.

export async function listWorktrees(): Promise<WorktreeDto[]> {
  return [];
}

// Removes a single worktree by path. Refuses a dirty worktree unless `force`,
// returning a typed error so the UI can warn before destroying uncommitted work.
export async function removeWorktree(body: RemoveWorktreeBody): Promise<PurgeWorktreesResultDto> {
  const target = typeof body.path === 'string' ? path.resolve(body.path.trim()) : '';
  if (!target) throw new ApiError(400, 'A worktree path is required.');

  if (body.clientExecuted === true) {
    const primaryRepoPath =
      typeof body.primaryRepoPath === 'string' ? body.primaryRepoPath.trim() : '';
    if (!primaryRepoPath) {
      throw new ApiError(400, 'primaryRepoPath is required when clientExecuted is true.');
    }
    return {
      removed: [target],
      skipped: [],
      worktrees: []
    };
  }

  const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
  if (projectId) {
    const remoteTarget = await resolveRemoteMutationTarget({
      ctx: buildWebappServiceContext(),
      projectId,
      executionTargetId: body.executionTargetId ?? null
    });
    if (remoteTarget.queue) {
      const primaryRepoPath =
        typeof body.primaryRepoPath === 'string' ? body.primaryRepoPath.trim() : '';
      if (!primaryRepoPath) {
        throw new ApiError(
          400,
          'primaryRepoPath is required to queue worktree removal on a remote target.'
        );
      }
      const missionId = await resolveMutationAnchorMissionId(projectId);
      await queueLocalTargetMutation({
        projectId,
        missionId,
        executionTargetId: remoteTarget.executionTargetId,
        kind: 'worktree_purge',
        capability: 'removeWorktree',
        input: {
          path: target,
          primaryRepoPath,
          force: body.force === true
        },
        eventSummary: `Queued worktree removal on remote execution target.`
      });
      return { removed: [], skipped: [], worktrees: [] };
    }
  }

  throwCheckoutLocalRequired();
}

// Removes every clean, merged worktree in one pass ("Purge all merged"). Dirty
// worktrees are skipped (never force-removed) so in-progress work is preserved.
export async function purgeMergedWorktrees(
  body: {
    projectId?: unknown;
    executionTargetId?: unknown;
    primaryRepoPath?: unknown;
    worktreeRoot?: unknown;
  } = {}
): Promise<PurgeWorktreesResultDto> {
  const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
  if (projectId) {
    const remoteTarget = await resolveRemoteMutationTarget({
      ctx: buildWebappServiceContext(),
      projectId,
      executionTargetId:
        typeof body.executionTargetId === 'string' ? body.executionTargetId.trim() : null
    });
    if (remoteTarget.queue) {
      const primaryRepoPath =
        typeof body.primaryRepoPath === 'string' ? body.primaryRepoPath.trim() : '';
      if (!primaryRepoPath) {
        throw new ApiError(
          400,
          'primaryRepoPath is required to queue merged worktree purge on a remote target.'
        );
      }
      const missionId = await resolveMutationAnchorMissionId(projectId);
      await queueLocalTargetMutation({
        projectId,
        missionId,
        executionTargetId: remoteTarget.executionTargetId,
        kind: 'worktree_purge',
        capability: 'purgeMergedWorktrees',
        input: {
          discover: true,
          primaryRepoPath,
          ...(typeof body.worktreeRoot === 'string' ? { worktreeRoot: body.worktreeRoot } : {})
        },
        eventSummary: 'Queued merged worktree purge on remote execution target.'
      });
      return { removed: [], skipped: [], worktrees: [] };
    }
  }

  throwCheckoutLocalRequired();
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
async function getMissionTags(missionId: string): Promise<ProjectTagDto[]> {
  const rows = (await requireDatabaseClient().all(
    `SELECT pt.id, pt.workspace_id, pt.project_id, pt.label, pt.color, pt.active, pt.revision
         FROM mission_tags tt
         JOIN project_tags pt ON pt.id = tt.tag_id AND pt.deleted_at IS NULL
        WHERE tt.mission_id = ?
        ORDER BY ${orderByLabelAsc('pt.label')}`,
    [missionId]
  )) as ProjectTagRow[];
  return rows.map(toProjectTagDto);
}

/**
 * Batch-resolve tags for many missions in one query, returning a map keyed by
 * mission id so board/list reads avoid an N+1 of per-mission tag lookups.
 */
async function getTagsByMission(missionIds: string[]): Promise<Map<string, ProjectTagDto[]>> {
  const byMission = new Map<string, ProjectTagDto[]>();
  if (missionIds.length === 0) return byMission;
  const placeholders = missionIds.map(() => '?').join(', ');
  const rows = (await requireDatabaseClient().all(
    `SELECT tt.mission_id, pt.id, pt.workspace_id, pt.project_id, pt.label, pt.color, pt.active, pt.revision
         FROM mission_tags tt
         JOIN project_tags pt ON pt.id = tt.tag_id AND pt.deleted_at IS NULL
        WHERE tt.mission_id IN (${placeholders})
        ORDER BY ${orderByLabelAsc('pt.label')}`,
    missionIds
  )) as Array<ProjectTagRow & { mission_id: string }>;
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
  WHERE p.workspace_id = ? AND p.deleted_at IS NULL
`;

export async function listProjects(): Promise<ProjectDto[]> {
  const rows = (await requireDatabaseClient().all(
    `${selectProjectsSql} ORDER BY p.status ASC, p.created_at ASC`,
    [WORKSPACE.id]
  )) as ProjectRow[];
  return rows.map(toProjectDto);
}

export async function getProject(
  id: string,
  db: DatabaseClient = requireDatabaseClient()
): Promise<ProjectDto> {
  const row = (await db.get(`${selectProjectsSql} AND p.id = ?`, [WORKSPACE.id, id])) as
    | ProjectRow
    | undefined;
  if (!row) throw new ApiError(404, 'Project not found');
  return toProjectDto(row);
}

export async function listWorkspaceStatuses(
  db: DatabaseClient = requireDatabaseClient()
): Promise<WorkspaceStatusDto[]> {
  const rows = (await db.all(
    `SELECT id, workspace_id, key, name, type, position, is_default, is_terminal, revision
         FROM workspace_statuses
        WHERE workspace_id = ? AND deleted_at IS NULL
        ORDER BY position ASC`,
    [WORKSPACE.id]
  )) as WorkspaceStatusRow[];
  return rows.map(toStatusDto);
}

export async function createWorkspaceStatus(
  body: CreateWorkspaceStatusBody
): Promise<WorkspaceStatusDto> {
  return requireDatabaseClient().transaction(async tx => {
    const name = (body.name ?? '').trim();
    if (!name) throw new ApiError(400, 'Status name is required');
    await assertUniqueStatusName(tx, { name });

    const type = assertValidStatusType(body.type);
    if (type === 'execute' || type === 'review') {
      if ((await countActiveStatusesByType(tx, { type })) > 0) {
        throw new ApiError(409, `This workspace already has a ${type} status`);
      }
    }

    const isDefault = body.isDefault ?? false;
    if (isDefault && type !== 'draft') {
      throw new ApiError(400, 'Only draft-type statuses can be the default');
    }

    const now = nowIso();
    const id = newId();
    const key = await uniqueStatusKey(tx, { name });
    const maxPos = (await tx.get(
      `SELECT COALESCE(MAX(position), -1) AS max_pos FROM workspace_statuses
          WHERE workspace_id = ? AND deleted_at IS NULL`,
      [WORKSPACE.id]
    )) as { max_pos: number };
    const position = maxPos.max_pos + 1;

    if (isDefault) {
      await clearWorkspaceDefaultStatuses(tx, { now });
    }

    await tx.run(
      `INSERT INTO workspace_statuses
         (id, workspace_id, key, name, type, position, is_default, is_terminal,
          created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        id,
        WORKSPACE.id,
        key,
        name,
        type,
        position,
        bindBool(DATABASE_DIALECT, isDefault),
        bindBool(DATABASE_DIALECT, isTerminalStatusType(type)),
        now,
        now
      ]
    );

    await recordChange(
      {
        entityType: 'workspace_status',
        entityId: id,
        operation: 'insert',
        entityRevision: 1,
        changedFields: ['name', 'type', 'position', ...(isDefault ? ['is_default'] : [])]
      },
      tx
    );

    return toStatusDto(await getWorkspaceStatusRow(tx, id));
  });
}

export async function updateWorkspaceStatus(
  statusId: string,
  body: UpdateWorkspaceStatusBody
): Promise<WorkspaceStatusDto> {
  return requireDatabaseClient().transaction(async tx => {
    const existing = await getWorkspaceStatusRow(tx, statusId);
    const changed: string[] = [];
    const now = nowIso();
    const fields: string[] = [];
    const setParams: unknown[] = [];

    if (body.name !== undefined) {
      const name = body.name.trim();
      if (!name) throw new ApiError(400, 'Status name cannot be empty');
      await assertUniqueStatusName(tx, { name, excludeStatusId: statusId });
      fields.push('name = ?');
      setParams.push(name);
      changed.push('name');
    }

    if (body.isDefault !== undefined) {
      if (body.isDefault) {
        if (existing.type !== 'draft') {
          throw new ApiError(400, 'Only draft-type statuses can be the default');
        }
        await clearWorkspaceDefaultStatuses(tx, { now });
        fields.push('is_default = ?');
        setParams.push(bindBool(DATABASE_DIALECT, true));
        changed.push('is_default');
      } else if (existing.is_default === 1) {
        throw new ApiError(409, 'Choose another status as the default before clearing this one');
      }
    }

    if (fields.length === 0) {
      return toStatusDto(existing);
    }

    const revision = existing.revision + 1;
    await tx.run(
      `UPDATE workspace_statuses
          SET ${fields.join(', ')}, updated_at = ?, revision = ?
        WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      [...setParams, now, revision, statusId, WORKSPACE.id]
    );

    await recordChange(
      {
        entityType: 'workspace_status',
        entityId: statusId,
        operation: 'update',
        entityRevision: revision,
        changedFields: changed
      },
      tx
    );

    return toStatusDto(await getWorkspaceStatusRow(tx, statusId));
  });
}

export async function deleteWorkspaceStatus(statusId: string): Promise<void> {
  await requireDatabaseClient().transaction(async tx => {
    const existing = await getWorkspaceStatusRow(tx, statusId);

    if (existing.type === 'execute' || existing.type === 'review') {
      throw new ApiError(409, 'Cannot remove the required execute or review status');
    }
    if (existing.is_default === 1) {
      throw new ApiError(409, 'Set another status as the default before deleting this one');
    }

    const missionCount = await countMissionsOnStatus(tx, statusId);
    if (missionCount > 0) {
      throw new ApiError(
        409,
        `Cannot delete a status used by ${missionCount} mission(s). Move them first.`
      );
    }

    const now = nowIso();
    const revision = existing.revision + 1;
    await tx.run(
      `UPDATE workspace_statuses
        SET deleted_at = ?, updated_at = ?, revision = ?
      WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      [now, now, revision, statusId, WORKSPACE.id]
    );

    await recordChange(
      {
        entityType: 'workspace_status',
        entityId: statusId,
        operation: 'delete',
        entityRevision: revision,
        changedFields: ['deleted_at']
      },
      tx
    );
  });
}

export async function reorderWorkspaceStatuses(
  body: ReorderWorkspaceStatusesBody
): Promise<WorkspaceStatusDto[]> {
  return requireDatabaseClient().transaction(async tx => {
    const orderedIds = body.orderedStatusIds;
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      throw new ApiError(400, 'orderedStatusIds is required');
    }

    const current = await listWorkspaceStatuses(tx);
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
    for (const [position, id] of orderedIds.entries()) {
      await tx.run(
        `UPDATE workspace_statuses
          SET position = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
        [position, now, id, WORKSPACE.id]
      );
      await recordChange(
        {
          entityType: 'workspace_status',
          entityId: id,
          operation: 'update',
          changedFields: ['position']
        },
        tx
      );
    }

    return listWorkspaceStatuses(tx);
  });
}

// ---- Project tags --------------------------------------------------------

const selectProjectTagColumns = `id, workspace_id, project_id, label, color, active, revision`;

async function getProjectTagRow(
  db: DatabaseClient,
  projectId: string,
  tagId: string
): Promise<ProjectTagRow> {
  await getProject(projectId, db);
  const row = (await db.get(
    `SELECT ${selectProjectTagColumns} FROM project_tags
        WHERE id = ? AND project_id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [tagId, projectId, WORKSPACE.id]
  )) as ProjectTagRow | undefined;
  if (!row) throw new ApiError(404, 'Tag not found');
  return row;
}

export async function listProjectTags(projectId: string): Promise<ProjectTagDto[]> {
  await getProject(projectId);
  const rows = (await requireDatabaseClient().all(
    `SELECT ${selectProjectTagColumns} FROM project_tags
        WHERE project_id = ? AND workspace_id = ? AND deleted_at IS NULL
        ORDER BY ${orderByLabelAsc('label')}`,
    [projectId, WORKSPACE.id]
  )) as ProjectTagRow[];
  return rows.map(toProjectTagDto);
}

function normalizeTagColor(color: string | null | undefined): string | null {
  if (color === null || color === undefined) return null;
  const trimmed = color.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function createProjectTag(
  projectId: string,
  body: CreateProjectTagBody
): Promise<ProjectTagDto> {
  return requireDatabaseClient().transaction(async tx => {
    await getProject(projectId, tx);
    const label = (body.label ?? '').trim();
    if (!label) throw new ApiError(400, 'Tag label cannot be empty');

    const duplicate = await tx.get(
      `SELECT 1 FROM project_tags
          WHERE project_id = ? AND label = ? AND deleted_at IS NULL`,
      [projectId, label]
    );
    if (duplicate) throw new ApiError(409, 'A tag with this label already exists');

    const now = nowIso();
    const id = newId();
    await tx.run(
      `INSERT INTO project_tags
         (id, workspace_id, project_id, label, color, active, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, 1)`,
      [id, WORKSPACE.id, projectId, label, normalizeTagColor(body.color), now, now]
    );

    await recordChange(
      {
        entityType: 'project_tag',
        entityId: id,
        operation: 'insert',
        entityRevision: 1,
        projectId
      },
      tx
    );

    return toProjectTagDto(await getProjectTagRow(tx, projectId, id));
  });
}

export async function updateProjectTag(
  projectId: string,
  tagId: string,
  body: UpdateProjectTagBody
): Promise<ProjectTagDto> {
  return requireDatabaseClient().transaction(async tx => {
    const existing = await getProjectTagRow(tx, projectId, tagId);

    const fields: string[] = [];
    const setParams: unknown[] = [];

    if (body.label !== undefined) {
      const label = body.label.trim();
      if (!label) throw new ApiError(400, 'Tag label cannot be empty');
      const duplicate = await tx.get(
        `SELECT 1 FROM project_tags
            WHERE project_id = ? AND label = ? AND id != ? AND deleted_at IS NULL`,
        [projectId, label, tagId]
      );
      if (duplicate) throw new ApiError(409, 'A tag with this label already exists');
      fields.push('label = ?');
      setParams.push(label);
    }
    if (body.color !== undefined) {
      fields.push('color = ?');
      setParams.push(normalizeTagColor(body.color));
    }
    if (body.active !== undefined) {
      fields.push('active = ?');
      setParams.push(bindBool(DATABASE_DIALECT, body.active));
    }
    if (fields.length === 0) return toProjectTagDto(existing);

    const now = nowIso();
    const revision = existing.revision + 1;
    await tx.run(
      `UPDATE project_tags SET ${fields.join(', ')}, updated_at = ?, revision = ?
         WHERE id = ? AND project_id = ?`,
      [...setParams, now, revision, tagId, projectId]
    );

    await recordChange(
      {
        entityType: 'project_tag',
        entityId: tagId,
        operation: 'update',
        entityRevision: revision,
        projectId
      },
      tx
    );

    return toProjectTagDto(await getProjectTagRow(tx, projectId, tagId));
  });
}

export async function deleteProjectTag(projectId: string, tagId: string): Promise<void> {
  await requireDatabaseClient().transaction(async tx => {
    const existing = await getProjectTagRow(tx, projectId, tagId);
    const now = nowIso();
    const revision = existing.revision + 1;
    // Soft-delete the definition; `mission_tags` rows cascade away via the FK so the
    // tag disappears from any mission that carried it.
    await tx.run(`DELETE FROM mission_tags WHERE tag_id = ?`, [tagId]);
    await tx.run(
      `UPDATE project_tags SET deleted_at = ?, updated_at = ?, revision = ?
       WHERE id = ? AND project_id = ?`,
      [now, now, revision, tagId, projectId]
    );

    await recordChange(
      {
        entityType: 'project_tag',
        entityId: tagId,
        operation: 'delete',
        entityRevision: revision,
        projectId
      },
      tx
    );
  });
}

export async function listProjectResources(projectId: string): Promise<ProjectResourceDto[]> {
  await getProject(projectId);

  const rows = (await requireDatabaseClient().all(
    `SELECT id, workspace_id, project_id, execution_target_id, type, label, path,
              is_primary, status, created_at, updated_at, revision
         FROM project_resources
        WHERE project_id = ? AND deleted_at IS NULL
        ORDER BY status ASC, is_primary DESC, label ASC, path ASC`,
    [projectId]
  )) as ProjectResourceRow[];
  const observations = await loadTargetResourceObservations({
    ctx: buildWebappServiceContext(),
    resourceIds: rows.map(row => row.id)
  });
  return await Promise.all(rows.map(row => toProjectResourceDto(row, observations)));
}

async function insertProjectResource(
  db: DatabaseClient,
  project: Pick<ProjectDto, 'id' | 'workspaceId'>,
  body: CreateProjectResourceBody & { path?: string },
  pathRequiredMessage: string
): Promise<string> {
  const resourcePath = (body.directoryPath ?? body.path ?? '').trim();
  if (!resourcePath) throw new ApiError(400, pathRequiredMessage);
  const executionTargetId = await resolveResourceExecutionTargetId(db, body.executionTargetId);

  const now = nowIso();
  if (body.isPrimary !== false) {
    await clearPrimaryResourcesForTarget(db, { projectId: project.id, executionTargetId, now });
  }

  const resourceId = newId();
  await db.run(
    `INSERT INTO project_resources
       (id, workspace_id, project_id, execution_target_id, type, label, path,
        is_primary, status, metadata_json, created_at, updated_at, revision)
     VALUES (?, ?, ?, ?, 'local_directory', ?, ?, ?, 'active', '{}', ?, ?, 1)`,
    [
      resourceId,
      project.workspaceId,
      project.id,
      executionTargetId,
      body.label ?? null,
      resourcePath,
      body.isPrimary === false ? 0 : 1,
      now,
      now
    ]
  );

  // Client/desktop owns `.overlord/project.json` on linked paths (WS-F3).

  await recordChange(
    {
      entityType: 'project_resource',
      entityId: resourceId,
      operation: 'insert',
      entityRevision: 1,
      projectId: project.id,
      changedFields: ['path', 'is_primary']
    },
    db
  );

  return resourceId;
}

export async function createProjectResource(
  projectId: string,
  body: CreateProjectResourceBody & { path?: string }
): Promise<ProjectResourceDto> {
  return requireDatabaseClient().transaction(async tx => {
    const project = await getProject(projectId, tx);
    const id = await insertProjectResource(tx, project, body, 'directoryPath is required');

    const row = (await tx.get(
      `SELECT id, workspace_id, project_id, execution_target_id, type, label, path,
                is_primary, status, created_at, updated_at, revision
           FROM project_resources
          WHERE id = ?`,
      [id]
    )) as ProjectResourceRow;
    return await toProjectResourceDto(row);
  });
}

export async function updateProjectResource(
  projectId: string,
  resourceId: string,
  body: UpdateProjectResourceBody
): Promise<ProjectResourceDto> {
  return requireDatabaseClient().transaction(async tx => {
    const existing = await getProjectResourceRow(tx, projectId, resourceId);
    const now = nowIso();

    if (body.isPrimary === true && !isTruthyFlag(existing.is_primary)) {
      await clearPrimaryResourcesForTarget(tx, {
        projectId,
        executionTargetId: existing.execution_target_id,
        now
      });
      await tx.run(
        `UPDATE project_resources
            SET is_primary = ?, updated_at = ?, revision = revision + 1
          WHERE id = ?`,
        [bindBool(DATABASE_DIALECT, true), now, resourceId]
      );
      await recordChange(
        {
          entityType: 'project_resource',
          entityId: resourceId,
          operation: 'update',
          entityRevision: existing.revision + 1,
          projectId,
          changedFields: ['is_primary']
        },
        tx
      );
    }

    return await toProjectResourceDto(await getProjectResourceRow(tx, projectId, resourceId));
  });
}

export async function deleteProjectResource(projectId: string, resourceId: string): Promise<void> {
  await requireDatabaseClient().transaction(async tx => {
    const existing = await getProjectResourceRow(tx, projectId, resourceId);
    const now = nowIso();
    const revision = existing.revision + 1;

    await tx.run(
      `UPDATE project_resources
        SET deleted_at = ?, updated_at = ?, revision = ?
      WHERE id = ?`,
      [now, now, revision, resourceId]
    );

    const deleted = await tx.get<{ execution_target_id: string | null }>(
      `SELECT execution_target_id FROM project_resources WHERE id = ?`,
      [resourceId]
    );
    await promoteFallbackPrimary(tx, {
      projectId,
      executionTargetId: deleted?.execution_target_id ?? null,
      now
    });

    await recordChange(
      {
        entityType: 'project_resource',
        entityId: resourceId,
        operation: 'delete',
        entityRevision: revision,
        projectId
      },
      tx
    );
  });
}

async function getProjectRepositoryResource(
  projectId: string,
  executionTargetId: string | null
): Promise<ProjectResourceDto | null> {
  const row = (await (executionTargetId === null
    ? requireDatabaseClient().get(
        `SELECT id, workspace_id, project_id, execution_target_id, type, label, path,
              is_primary, status, created_at, updated_at, revision
         FROM project_resources
        WHERE project_id = ?
          AND status = 'active'
          AND deleted_at IS NULL
        ORDER BY is_primary DESC, created_at ASC
        LIMIT 1`,
        [projectId]
      )
    : requireDatabaseClient().get(
        `SELECT id, workspace_id, project_id, execution_target_id, type, label, path,
              is_primary, status, created_at, updated_at, revision
         FROM project_resources
        WHERE project_id = ?
          AND (execution_target_id = ? OR execution_target_id IS NULL)
          AND status = 'active'
          AND deleted_at IS NULL
        ORDER BY
          CASE WHEN execution_target_id = ? THEN 0 ELSE 1 END,
          is_primary DESC,
          created_at ASC
        LIMIT 1`,
        [projectId, executionTargetId, executionTargetId]
      ))) as ProjectResourceRow | undefined;
  return row ? await toProjectResourceDto(row) : null;
}

export async function getProjectRepository(
  projectId: string,
  executionTargetId: string | null
): Promise<ProjectRepositoryDto> {
  await getProject(projectId);

  const scannedAt = nowIso();
  const resource = await getProjectRepositoryResource(projectId, executionTargetId);
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

  const provider = checkoutControlPlaneProvider(backendTargetMetadata(executionTargetId));
  const tree = await provider.readRepositoryTree({
    resourceId: resource.id,
    repoPath: resource.path
  });
  if (tree.ok) {
    return {
      projectId,
      executionTargetId,
      resource,
      status: 'ready',
      rootPath: tree.value.rootPath,
      gitRoot: tree.value.gitRoot,
      branch: tree.value.branch,
      commit: tree.value.commit,
      entries: tree.value.entries,
      truncated: tree.value.truncated,
      scannedAt,
      message: null
    };
  }
  const status =
    tree.code === 'LOCAL_TARGET_REQUIRED' || tree.code === 'LOCAL_TARGET_UNREACHABLE'
      ? 'unsupported_resource'
      : tree.code === 'NOT_GIT_REPOSITORY'
        ? 'not_git_repository'
        : 'unreadable';
  const message =
    tree.code === 'LOCAL_TARGET_REQUIRED'
      ? 'Repository browsing for linked local directories must run on a local execution target.'
      : tree.message;
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
    message
  };
}

const hexColorPattern = /^#?[0-9a-fA-F]{6}$/;

function normalizeHexColor(value: string): string | null {
  const trimmed = value.trim();
  const withHash = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  return hexColorPattern.test(withHash) ? withHash.toLowerCase() : null;
}

export async function createProject(body: CreateProjectBody): Promise<ProjectDto> {
  return requireDatabaseClient().transaction(async tx => {
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

    await tx.run(
      `INSERT INTO projects
       (id, workspace_id, slug, name, description, status, settings_json,
        created_by_workspace_user_id, created_at, updated_at, revision)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, 1)`,
      [
        id,
        WORKSPACE.id,
        slug,
        name,
        body.description?.trim() || null,
        settingsJson,
        getActorWorkspaceUserId(),
        now,
        now
      ]
    );

    // Card statuses live at the workspace level (`workspace_statuses`) and are
    // seeded once per workspace, so creating a project no longer seeds statuses.

    await recordChange(
      {
        entityType: 'project',
        entityId: id,
        operation: 'insert',
        entityRevision: 1,
        projectId: id
      },
      tx
    );

    const primaryResourcePath = body.primaryResource?.directoryPath?.trim() ?? '';
    if (primaryResourcePath) {
      await insertProjectResource(
        tx,
        { id, workspaceId: WORKSPACE.id },
        {
          directoryPath: primaryResourcePath,
          executionTargetId: body.primaryResource?.executionTargetId,
          isPrimary: true
        },
        'primaryResource.directoryPath is required'
      );
    }

    return getProject(id, tx);
  });
}

export async function updateProject(id: string, body: UpdateProjectBody): Promise<ProjectDto> {
  return requireDatabaseClient().transaction(async tx => {
    const existing = (await tx.get(
      `SELECT * FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      [id, WORKSPACE.id]
    )) as ProjectRow | undefined;
    if (!existing) throw new ApiError(404, 'Project not found');

    const fields: string[] = [];
    const setParams: unknown[] = [];
    const changed: string[] = [];

    if (body.name !== undefined) {
      const name = body.name.trim();
      if (!name) throw new ApiError(400, 'Project name cannot be empty');
      fields.push('name = ?');
      setParams.push(name);
      changed.push('name');
    }
    if (body.description !== undefined) {
      fields.push('description = ?');
      setParams.push(body.description?.trim() || null);
      changed.push('description');
    }
    if (body.status !== undefined) {
      if (body.status !== 'active' && body.status !== 'archived') {
        throw new ApiError(400, 'Invalid project status');
      }
      fields.push('status = ?');
      setParams.push(body.status);
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
      fields.push('settings_json = ?');
      setParams.push(mergeProjectSettingsJson(existing.settings_json, settingsUpdates));
      changed.push('settings_json');
    }
    if (fields.length === 0) return getProject(id, tx);

    const now = nowIso();
    const revision = existing.revision + 1;
    await tx.run(
      `UPDATE projects SET ${fields.join(', ')}, updated_at = ?, revision = ?
         WHERE id = ? AND workspace_id = ?`,
      [...setParams, now, revision, id, WORKSPACE.id]
    );

    await recordChange(
      {
        entityType: 'project',
        entityId: id,
        operation: 'update',
        entityRevision: revision,
        projectId: id,
        changedFields: changed
      },
      tx
    );
    return getProject(id, tx);
  });
}

export async function deleteProject(id: string): Promise<void> {
  await requireDatabaseClient().transaction(async tx => {
    const existing = (await tx.get(
      `SELECT id, revision FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      [id, WORKSPACE.id]
    )) as { id: string; revision: number } | undefined;
    if (!existing) throw new ApiError(404, 'Project not found');

    const now = nowIso();
    const revision = existing.revision + 1;

    // Cascade soft-delete to missions and their objectives.
    const missionIds = (
      (await tx.all(
        `SELECT id FROM missions WHERE project_id = ? AND workspace_id = ? AND deleted_at IS NULL`,
        [id, WORKSPACE.id]
      )) as { id: string }[]
    ).map(r => r.id);

    for (const missionId of missionIds) {
      await tx.run(
        `UPDATE objectives SET deleted_at = ?, revision = revision + 1
         WHERE mission_id = ? AND deleted_at IS NULL`,
        [now, missionId]
      );
    }

    if (missionIds.length > 0) {
      await tx.run(
        `UPDATE missions SET deleted_at = ?, revision = revision + 1
         WHERE project_id = ? AND workspace_id = ? AND deleted_at IS NULL`,
        [now, id, WORKSPACE.id]
      );
    }

    await tx.run(
      `UPDATE projects SET deleted_at = ?, updated_at = ?, revision = ?
       WHERE id = ? AND workspace_id = ?`,
      [now, now, revision, id, WORKSPACE.id]
    );

    await recordChange(
      {
        entityType: 'project',
        entityId: id,
        operation: 'delete',
        entityRevision: revision,
        projectId: id
      },
      tx
    );
  });
}

// ---- Missions -------------------------------------------------------------

const selectMissionsSql = `
  SELECT t.id, t.workspace_id, t.project_id, t.display_id, t.sequence_number, t.title,
         t.status_id, t.status_type, t.board_position, t.priority,
         t.assigned_workspace_user_id,
         t.acceptance_criteria_text, t.available_tools_json,
         t.created_at, t.updated_at, t.revision, t.active_branch, t.branch_override,
         t.worktree_preference,
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
  WHERE t.workspace_id = ? AND t.deleted_at IS NULL
`;

export async function listMissions(projectId: string): Promise<MissionDto[]> {
  // Board order: ascending board_position within each column, with
  // sequence_number DESC as a stable tiebreaker (e.g. brand-new missions that
  // share a position before the column is first reordered).
  const rows = (await requireDatabaseClient().all(
    `${selectMissionsSql} AND t.project_id = ?
         ORDER BY t.board_position ASC, t.sequence_number DESC`,
    [WORKSPACE.id, projectId]
  )) as MissionRow[];
  const tagsByMission = await getTagsByMission(rows.map(row => row.id));
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
export async function searchMissions({
  query,
  projectId,
  limit = 25
}: {
  query?: string | null;
  projectId?: string | null;
  limit?: number;
}): Promise<MissionDto[]> {
  const match = query?.trim() ? buildMissionSearchMatch(query.trim()) : null;

  if (!match) {
    const sql = projectId
      ? `${selectMissionsSql} AND t.project_id = ? ORDER BY t.updated_at DESC LIMIT ?`
      : `${selectMissionsSql} ORDER BY t.updated_at DESC LIMIT ?`;
    const params = projectId ? [WORKSPACE.id, projectId, limit] : [WORKSPACE.id, limit];
    const rows = (await requireDatabaseClient().all(sql, params)) as MissionRow[];
    const tagsByMission = await getTagsByMission(rows.map(row => row.id));
    return rows.map(row => toMissionDto(row, tagsByMission.get(row.id) ?? []));
  }

  const projectFilter = projectId ? ' AND t.project_id = ?' : '';
  const rows = (await requireDatabaseClient().all(
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
           AND t.workspace_id = ? AND t.deleted_at IS NULL${projectFilter}
        WHERE search_documents_fts MATCH ?`,
    projectId ? [WORKSPACE.id, projectId, match] : [WORKSPACE.id, match]
  )) as Array<MissionRow & { doc_score: number }>;

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
  const tagsByMission = await getTagsByMission(ranked.map(entry => entry.row.id));
  return ranked.map(entry => toMissionDto(entry.row, tagsByMission.get(entry.row.id) ?? []));
}

// New cards drop in at the top of their column. Gap-based: one step (100) above
// the current minimum so no renumber is needed until the column is reordered.
async function topBoardPosition(
  db: DatabaseClient,
  projectId: string,
  statusId: string,
  excludeMissionId?: string
): Promise<number> {
  const row = excludeMissionId
    ? ((await db.get(
        `SELECT MIN(board_position) AS min_pos FROM missions
         WHERE project_id = ? AND status_id = ?
           AND deleted_at IS NULL AND id != ?`,
        [projectId, statusId, excludeMissionId]
      )) as { min_pos: number | null })
    : ((await db.get(
        `SELECT MIN(board_position) AS min_pos FROM missions
         WHERE project_id = ? AND status_id = ? AND deleted_at IS NULL`,
        [projectId, statusId]
      )) as { min_pos: number | null });
  return row.min_pos === null ? 100 : row.min_pos - 100;
}

async function getWorkspaceStatus(
  db: DatabaseClient,
  statusId: string
): Promise<WorkspaceStatusRow> {
  const statusRow = (await db.get(
    `SELECT * FROM workspace_statuses WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [statusId, WORKSPACE.id]
  )) as WorkspaceStatusRow | undefined;
  if (!statusRow) throw new ApiError(400, 'Unknown status for workspace');
  return statusRow;
}

/** Repoint denormalized project_id columns on mission-owned rows. */
async function cascadeMissionProjectId(
  db: DatabaseClient,
  {
    missionId,
    newProjectId,
    now
  }: {
    missionId: string;
    newProjectId: string;
    now: string;
  }
): Promise<void> {
  await db.run(
    `UPDATE objectives
       SET project_id = ?, updated_at = ?, revision = revision + 1
     WHERE mission_id = ? AND workspace_id = ?`,
    [newProjectId, now, missionId, WORKSPACE.id]
  );
  await db.run(
    `UPDATE agent_sessions
       SET project_id = ?, updated_at = ?, revision = revision + 1
     WHERE mission_id = ? AND workspace_id = ?`,
    [newProjectId, now, missionId, WORKSPACE.id]
  );
  await db.run(
    `UPDATE mission_events SET project_id = ?
     WHERE mission_id = ? AND workspace_id = ?`,
    [newProjectId, missionId, WORKSPACE.id]
  );
  await db.run(
    `UPDATE deliveries
       SET project_id = ?, updated_at = ?, revision = revision + 1
     WHERE mission_id = ? AND workspace_id = ?`,
    [newProjectId, now, missionId, WORKSPACE.id]
  );
  await db.run(
    `UPDATE artifacts
       SET project_id = ?, updated_at = ?, revision = revision + 1
     WHERE mission_id = ? AND workspace_id = ?`,
    [newProjectId, now, missionId, WORKSPACE.id]
  );
  await db.run(
    `UPDATE changed_files
       SET project_id = ?, updated_at = ?, revision = revision + 1
     WHERE mission_id = ? AND workspace_id = ?`,
    [newProjectId, now, missionId, WORKSPACE.id]
  );
  await db.run(
    `UPDATE change_rationales
       SET project_id = ?, updated_at = ?, revision = revision + 1
     WHERE mission_id = ? AND workspace_id = ?`,
    [newProjectId, now, missionId, WORKSPACE.id]
  );
  await db.run(
    `UPDATE execution_requests
       SET project_id = ?, updated_at = ?, revision = revision + 1
     WHERE mission_id = ? AND workspace_id = ?`,
    [newProjectId, now, missionId, WORKSPACE.id]
  );
}

async function getMissionRow(
  missionRef: string,
  db: DatabaseClient = requireDatabaseClient()
): Promise<MissionRow> {
  const byId = (await db.get(`${selectMissionsSql} AND t.id = ?`, [WORKSPACE.id, missionRef])) as
    | MissionRow
    | undefined;
  if (byId) return byId;

  const byDisplayId = (await db.get(`${selectMissionsSql} AND t.display_id = ?`, [
    WORKSPACE.id,
    missionRef
  ])) as MissionRow | undefined;
  if (byDisplayId) return byDisplayId;

  throw new ApiError(404, 'Mission not found');
}

export async function getMissionDetail(missionRef: string): Promise<MissionDetailDto> {
  const row = await getMissionRow(missionRef);
  const mission = toMissionDto(row, await getMissionTags(row.id));
  const objectives = await listObjectives(row.id);
  const statuses = await listWorkspaceStatuses();
  const executionRequests = await listMissionExecutionRequests(row.id);
  return {
    ...mission,
    objectives,
    statuses,
    executionRequests,
    branch: await missionBranchDto(row)
  };
}

interface MissionEventRow {
  id: string;
  mission_id: string;
  objective_id: string | null;
  type: string;
  phase: string | null;
  summary: string;
  source: string;
  actor_workspace_user_id: string | null;
  actor_display_name: string | null;
  actor_handle: string | null;
  actor_metadata_json: string | null;
  external_url: string | null;
  created_at: string;
}

/**
 * Returns a mission's workflow history newest-first for the live activity feed.
 * `mission_events` is append-only, so there is no soft-delete filter; the
 * workspace scope guards against cross-workspace reads.
 */
export async function listMissionEvents(
  missionRef: string,
  limit = 200
): Promise<MissionEventDto[]> {
  const mission = await getMissionRow(missionRef);
  const rows = (await requireDatabaseClient().all(
    `SELECT me.id, me.mission_id, me.objective_id, me.type, me.phase, me.summary,
              me.source, me.actor_workspace_user_id, me.external_url, me.created_at,
              p.display_name AS actor_display_name,
              p.handle AS actor_handle,
              p.metadata_json AS actor_metadata_json
         FROM mission_events me
         LEFT JOIN workspace_users wu
           ON wu.id = me.actor_workspace_user_id
          AND wu.workspace_id = me.workspace_id
          AND wu.deleted_at IS NULL
         LEFT JOIN profiles p
           ON p.id = wu.profile_id
          AND p.deleted_at IS NULL
        WHERE me.mission_id = ? AND me.workspace_id = ?
        ORDER BY me.created_at DESC, me.id DESC
        LIMIT ?`,
    [mission.id, WORKSPACE.id, limit]
  )) as MissionEventRow[];
  return rows.map(row => ({
    id: row.id,
    missionId: row.mission_id,
    objectiveId: row.objective_id,
    type: row.type,
    phase: row.phase,
    summary: row.summary,
    source: row.source,
    actorWorkspaceUserId: row.actor_workspace_user_id,
    actor:
      row.actor_workspace_user_id && row.actor_display_name
        ? {
            workspaceUserId: row.actor_workspace_user_id,
            displayName: row.actor_display_name,
            handle: row.actor_handle,
            avatarUrl: avatarUrlFromMetadata(row.actor_metadata_json ?? '{}')
          }
        : null,
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
export async function listMissionFileChanges(
  missionRef: string,
  limit = 200
): Promise<FileChangeDto[]> {
  const mission = await getMissionRow(missionRef);
  const rows = (await requireDatabaseClient().all(
    `SELECT cr.id, cr.mission_id, cr.objective_id, cr.file_path, cr.label, cr.summary,
              cr.why, cr.impact, cr.created_at,
              cf.current_diff_state AS diff_state, cf.vcs_status AS vcs_status
         FROM change_rationales cr
         LEFT JOIN changed_files cf
           ON cf.id = cr.changed_file_id AND cf.deleted_at IS NULL
        WHERE cr.mission_id = ? AND cr.workspace_id = ?
          AND cr.deleted_at IS NULL
        ORDER BY cr.created_at DESC, cr.id DESC
        LIMIT ?`,
    [mission.id, WORKSPACE.id, limit]
  )) as FileChangeRow[];
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

export async function listArtifacts(missionRef: string, limit = 200): Promise<ArtifactDto[]> {
  const mission = await getMissionRow(missionRef);
  const rows = (await requireDatabaseClient().all(
    `SELECT id, workspace_id, project_id, mission_id, objective_id, session_id, delivery_id,
              type, label, content_text, content_json, external_url, created_at, updated_at
         FROM artifacts
        WHERE mission_id = ? AND workspace_id = ? AND deleted_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    [mission.id, WORKSPACE.id, limit]
  )) as ArtifactRow[];
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

async function nextMissionSequence(db: DatabaseClient): Promise<number> {
  // Allocate the next workspace-scoped mission number, creating the counter row
  // if a fresh database somehow lacks it.
  const row = (await db.get(
    `SELECT id, next_value FROM mission_sequences
         WHERE workspace_id = ? AND scope_type = 'workspace'
           AND scope_id = ? AND counter_name = 'mission'`,
    [WORKSPACE.id, WORKSPACE.id]
  )) as { id: string; next_value: number } | undefined;

  if (!row) {
    const seq = 1;
    await db.run(
      `INSERT INTO mission_sequences (id, workspace_id, scope_type, scope_id, counter_name, next_value, updated_at)
       VALUES (?, ?, 'workspace', ?, 'mission', ?, ?)`,
      [newId(), WORKSPACE.id, WORKSPACE.id, seq + 1, nowIso()]
    );
    return seq;
  }

  const seq = row.next_value;
  await db.run(`UPDATE mission_sequences SET next_value = ?, updated_at = ? WHERE id = ?`, [
    seq + 1,
    nowIso(),
    row.id
  ]);
  return seq;
}

type CreateMissionResult = {
  missionId: string;
  objectiveIds: string[];
  instruction: string;
  shouldGenerateMissionTitle: boolean;
};

async function createMissionTx(body: CreateMissionBody): Promise<CreateMissionResult> {
  return requireDatabaseClient().transaction(async tx => {
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

    const explicitTitle = (body.title ?? '').trim();
    const title = explicitTitle || initialTitleFromInstruction(instruction);

    const project = (await tx.get(
      `SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      [body.projectId, WORKSPACE.id]
    )) as { id: string } | undefined;
    if (!project) throw new ApiError(404, 'Project not found');

    // Resolve the target status: explicit choice or the workspace's default.
    let statusRow: WorkspaceStatusRow | undefined;
    if (body.statusId) {
      statusRow = (await tx.get(
        `SELECT * FROM workspace_statuses WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
        [body.statusId, WORKSPACE.id]
      )) as WorkspaceStatusRow | undefined;
      if (!statusRow) throw new ApiError(400, 'Unknown status for workspace');
    } else {
      statusRow = (await tx.get(
        `SELECT * FROM workspace_statuses
           WHERE workspace_id = ? AND is_default = ? AND deleted_at IS NULL LIMIT 1`,
        [WORKSPACE.id, bindBool(DATABASE_DIALECT, true)]
      )) as WorkspaceStatusRow | undefined;
      if (!statusRow) throw new ApiError(409, 'Workspace has no default status');
    }

    const priority = body.priority ?? 'normal';
    if (!['low', 'normal', 'high', 'urgent'].includes(priority)) {
      throw new ApiError(400, 'Invalid priority');
    }

    const now = nowIso();
    const id = newId();
    const sequence = await nextMissionSequence(tx);
    const displayId = `${WORKSPACE.slug}:${sequence}`;
    const boardPosition = await topBoardPosition(tx, body.projectId, statusRow.id);
    const assignedWorkspaceUserId =
      body.assignedWorkspaceUserId === undefined
        ? getActorWorkspaceUserId()
        : await resolveAssignedWorkspaceUserId(tx, body.assignedWorkspaceUserId);

    await tx.run(
      `INSERT INTO missions
       (id, workspace_id, project_id, display_id, sequence_number, title,
        status_id, status_type, board_position, priority, available_tools_json, execution_target_intent_json,
        metadata_json, created_by_workspace_user_id, assigned_workspace_user_id, created_at, updated_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '{}', '{}', ?, ?, ?, ?, 1)`,
      [
        id,
        WORKSPACE.id,
        body.projectId,
        displayId,
        sequence,
        title,
        statusRow.id,
        statusRow.type,
        boardPosition,
        priority,
        getActorWorkspaceUserId(),
        assignedWorkspaceUserId,
        now,
        now
      ]
    );

    await recordChange(
      {
        entityType: 'mission',
        entityId: id,
        operation: 'insert',
        entityRevision: 1,
        projectId: body.projectId,
        missionId: id
      },
      tx
    );

    const objectiveIds: string[] = [];
    for (const item of objectiveInputs) {
      if (!item.objective.trim()) {
        throw new ApiError(400, 'Objective instruction is required');
      }
      const objective = await insertObjective(tx, {
        missionId: id,
        instructionText: item.objective,
        ...(item.title !== undefined ? { title: item.title ?? undefined } : {}),
        autoAdvance: item.autoAdvance ?? false
      });
      objectiveIds.push(objective.id);
    }

    await assignMissionTags(tx, {
      missionId: id,
      projectId: body.projectId,
      tagIds: body.tagIds,
      now
    });

    return { missionId: id, objectiveIds, instruction, shouldGenerateMissionTitle: !explicitTitle };
  });
}

/**
 * Assign tag definitions to a mission. De-duplicates the input and validates that
 * every tag belongs to the mission's project (and is not soft-deleted) so a mission
 * can never carry a foreign-project tag. Intended to run inside the create
 * transaction. Unknown or cross-project tag ids raise a 400.
 */
async function assignMissionTags(
  db: DatabaseClient,
  {
    missionId,
    projectId,
    tagIds,
    now
  }: {
    missionId: string;
    projectId: string;
    tagIds: string[] | undefined;
    now: string;
  }
): Promise<void> {
  if (!tagIds || tagIds.length === 0) return;
  const unique = [...new Set(tagIds.map(value => value.trim()).filter(Boolean))];
  if (unique.length === 0) return;

  for (const tagId of unique) {
    const tag = (await db.get(
      `SELECT id FROM project_tags
       WHERE id = ? AND project_id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      [tagId, projectId, WORKSPACE.id]
    )) as { id: string } | undefined;
    if (!tag) throw new ApiError(400, 'Tag does not belong to this project');
    // Portable upsert-ignore: works on both modern SQLite and PostgreSQL.
    await db.run(
      `INSERT INTO mission_tags (mission_id, tag_id, created_at) VALUES (?, ?, ?)
         ON CONFLICT DO NOTHING`,
      [missionId, tagId, now]
    );
  }
}

export async function createMission(body: CreateMissionBody): Promise<MissionDetailDto> {
  const { missionId, objectiveIds, instruction, shouldGenerateMissionTitle } =
    await createMissionTx(body);
  const detail = await getMissionDetail(missionId);

  if (shouldGenerateMissionTitle) {
    scheduleMissionTitleGeneration({
      missionId: detail.id,
      projectId: detail.projectId,
      instructionText: instruction
    });
  }

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
  const detail = await getMissionDetail(missionRef);
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
async function resolveAssignedWorkspaceUserId(
  db: DatabaseClient,
  value: string | null | undefined
): Promise<string | null> {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const member = (await db.get(
    `SELECT id FROM workspace_users
        WHERE id = ? AND workspace_id = ? AND status = 'active' AND deleted_at IS NULL`,
    [trimmed, WORKSPACE.id]
  )) as { id: string } | undefined;
  if (!member) throw new ApiError(400, 'Assignee is not a member of this workspace');
  return member.id;
}

async function patchMissionFieldsTx(id: string, body: UpdateMissionBody): Promise<void> {
  await requireDatabaseClient().transaction(async tx => {
    const existing = await getMissionRow(id, tx);

    const fields: string[] = [];
    const setParams: unknown[] = [];
    const changed: string[] = [];

    if (body.title !== undefined) {
      const title = body.title.trim();
      if (!title) throw new ApiError(400, 'Mission title cannot be empty');
      fields.push('title = ?');
      setParams.push(title);
      changed.push('title');
    }
    if (body.priority !== undefined) {
      if (body.priority !== null && !['low', 'normal', 'high', 'urgent'].includes(body.priority)) {
        throw new ApiError(400, 'Invalid priority');
      }
      fields.push('priority = ?');
      setParams.push(body.priority);
      changed.push('priority');
    }
    if (body.assignedWorkspaceUserId !== undefined) {
      fields.push('assigned_workspace_user_id = ?');
      setParams.push(await resolveAssignedWorkspaceUserId(tx, body.assignedWorkspaceUserId));
      changed.push('assigned_workspace_user_id');
    }
    if (body.statusId !== undefined) {
      const statusRow = await getWorkspaceStatus(tx, body.statusId);
      fields.push('status_id = ?', 'status_type = ?');
      setParams.push(statusRow.id, statusRow.type);
      changed.push('status_id', 'status_type');
      if (statusRow.id !== existing.status_id) {
        fields.push('board_position = ?');
        setParams.push(await topBoardPosition(tx, existing.project_id, statusRow.id, id));
        changed.push('board_position');
      }
    }
    if (body.acceptanceCriteria !== undefined) {
      fields.push('acceptance_criteria_text = ?');
      setParams.push(body.acceptanceCriteria?.trim() || null);
      changed.push('acceptance_criteria_text');
    }
    if (body.availableTools !== undefined) {
      if (!Array.isArray(body.availableTools))
        throw new ApiError(400, 'availableTools must be an array');
      const toolsJson = JSON.stringify(body.availableTools.map(name => ({ name })));
      fields.push('available_tools_json = ?');
      setParams.push(toolsJson);
      changed.push('available_tools_json');
    }
    if (body.branchOverride !== undefined) {
      const override = body.branchOverride?.trim() || null;
      fields.push('branch_override = ?');
      setParams.push(override);
      changed.push('branch_override');
    }
    if (body.worktreePreference !== undefined) {
      const preference = body.worktreePreference;
      if (preference !== null && preference !== 'worktree' && preference !== 'branch') {
        throw new ApiError(400, "worktreePreference must be 'worktree', 'branch', or null");
      }
      fields.push('worktree_preference = ?');
      setParams.push(preference);
      changed.push('worktree_preference');
    }
    if (fields.length === 0) return;

    const now = nowIso();
    const revision = existing.revision + 1;
    await tx.run(
      `UPDATE missions SET ${fields.join(', ')}, updated_at = ?, revision = ?
         WHERE id = ? AND workspace_id = ?`,
      [...setParams, now, revision, id, WORKSPACE.id]
    );

    await recordChange(
      {
        entityType: 'mission',
        entityId: id,
        operation: 'update',
        entityRevision: revision,
        projectId: existing.project_id,
        missionId: id,
        changedFields: changed
      },
      tx
    );
  });
}

async function moveMissionProjectTx({
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
}): Promise<void> {
  await requireDatabaseClient().transaction(async tx => {
    // On PostgreSQL the composite mission/objective FKs are deferred for the unit
    // of work instead of toggling a connection pragma (the SQLite path disables
    // `foreign_keys` around this transaction in `updateMission`).
    if (tx.dialect === 'postgres') {
      await tx.exec('SET CONSTRAINTS ALL DEFERRED');
    }

    const fields = ['project_id = ?', 'status_id = ?', 'status_type = ?', 'board_position = ?'];
    const setParams: unknown[] = [
      targetProjectId,
      statusRow.id,
      statusRow.type,
      await topBoardPosition(tx, targetProjectId, statusRow.id, id)
    ];
    const changed = ['project_id', 'status_id', 'status_type', 'board_position'];

    if (body.title !== undefined) {
      const title = body.title.trim();
      if (!title) throw new ApiError(400, 'Mission title cannot be empty');
      fields.push('title = ?');
      setParams.push(title);
      changed.push('title');
    }
    if (body.priority !== undefined) {
      if (body.priority !== null && !['low', 'normal', 'high', 'urgent'].includes(body.priority)) {
        throw new ApiError(400, 'Invalid priority');
      }
      fields.push('priority = ?');
      setParams.push(body.priority);
      changed.push('priority');
    }
    if (body.assignedWorkspaceUserId !== undefined) {
      fields.push('assigned_workspace_user_id = ?');
      setParams.push(await resolveAssignedWorkspaceUserId(tx, body.assignedWorkspaceUserId));
      changed.push('assigned_workspace_user_id');
    }
    if (body.acceptanceCriteria !== undefined) {
      fields.push('acceptance_criteria_text = ?');
      setParams.push(body.acceptanceCriteria?.trim() || null);
      changed.push('acceptance_criteria_text');
    }
    if (body.availableTools !== undefined) {
      if (!Array.isArray(body.availableTools))
        throw new ApiError(400, 'availableTools must be an array');
      fields.push('available_tools_json = ?');
      setParams.push(JSON.stringify(body.availableTools.map(name => ({ name }))));
      changed.push('available_tools_json');
    }

    const now = nowIso();
    const revision = existing.revision + 1;
    await cascadeMissionProjectId(tx, { missionId: id, newProjectId: targetProjectId, now });
    await tx.run(
      `UPDATE missions SET ${fields.join(', ')}, updated_at = ?, revision = ?
         WHERE id = ? AND workspace_id = ?`,
      [...setParams, now, revision, id, WORKSPACE.id]
    );

    await recordChange(
      {
        entityType: 'mission',
        entityId: id,
        operation: 'update',
        entityRevision: revision,
        projectId: targetProjectId,
        missionId: id,
        changedFields: changed
      },
      tx
    );
  });
}

/** PATCH /api/missions/:id — field updates and cross-project moves. */
export async function updateMission(
  id: string,
  body: UpdateMissionBody
): Promise<MissionDetailDto> {
  const client = requireDatabaseClient();
  const existing = await getMissionRow(id);
  if (body.projectId !== undefined && body.projectId !== existing.project_id) {
    const targetProject = (await client.get(
      `SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      [body.projectId, WORKSPACE.id]
    )) as { id: string } | undefined;
    if (!targetProject) throw new ApiError(404, 'Project not found');

    // Statuses are workspace-shared, so a cross-project move keeps the mission's
    // current status unless the caller explicitly chooses a different one.
    const statusRow = await getWorkspaceStatus(client, body.statusId ?? existing.status_id);

    // Composite mission/objective FKs require briefly disabling enforcement; SQLite
    // will not allow toggling the pragma inside an open transaction, so it is done
    // around the transaction here (Postgres defers the constraints inside the tx).
    if (client.dialect === 'sqlite') await client.exec('PRAGMA foreign_keys = OFF');
    try {
      await moveMissionProjectTx({
        id,
        body,
        existing,
        targetProjectId: body.projectId,
        statusRow
      });
    } finally {
      if (client.dialect === 'sqlite') await client.exec('PRAGMA foreign_keys = ON');
    }
    return getMissionDetail(id);
  }

  await patchMissionFieldsTx(id, body);
  return getMissionDetail(id);
}

export async function deleteMission(id: string): Promise<void> {
  await requireDatabaseClient().transaction(async tx => {
    const existing = await getMissionRow(id, tx);
    const now = nowIso();
    const revision = existing.revision + 1;
    // Soft-delete the mission and its objectives so referential integrity holds.
    await tx.run(
      `UPDATE objectives SET deleted_at = ?, revision = revision + 1
       WHERE mission_id = ? AND deleted_at IS NULL`,
      [now, id]
    );
    await tx.run(
      `UPDATE missions SET deleted_at = ?, revision = ?
       WHERE id = ? AND workspace_id = ?`,
      [now, revision, id, WORKSPACE.id]
    );

    await recordChange(
      {
        entityType: 'mission',
        entityId: id,
        operation: 'delete',
        entityRevision: revision,
        projectId: existing.project_id,
        missionId: id
      },
      tx
    );
  });
}

/**
 * Reorder one board column. `orderedMissionIds` is the full top-to-bottom order
 * the `statusId` column should have afterwards. Each mission is renumbered to a
 * dense gap-based position (100, 200, 300, …); any mission arriving from another
 * column also has its status changed to match. Missions whose status and
 * position are already correct are skipped so no redundant change feed rows are
 * written. Returns the destination column in its new order.
 */
export async function reorderBoardColumn(
  projectId: string,
  body: ReorderBoardColumnBody
): Promise<MissionDto[]> {
  const statusId = body.statusId;
  const orderedIds = body.orderedMissionIds;
  if (!statusId) throw new ApiError(400, 'statusId is required');
  if (!Array.isArray(orderedIds)) throw new ApiError(400, 'orderedMissionIds must be an array');

  await requireDatabaseClient().transaction(async tx => {
    const statusRow = (await tx.get(
      `SELECT * FROM workspace_statuses WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      [statusId, WORKSPACE.id]
    )) as WorkspaceStatusRow | undefined;
    if (!statusRow) throw new ApiError(400, 'Unknown status for workspace');

    if (new Set(orderedIds).size !== orderedIds.length) {
      throw new ApiError(400, 'orderedMissionIds contains duplicates');
    }

    const now = nowIso();
    for (const [index, missionId] of orderedIds.entries()) {
      const existing = (await tx.get(
        `SELECT * FROM missions
             WHERE id = ? AND workspace_id = ? AND project_id = ? AND deleted_at IS NULL`,
        [missionId, WORKSPACE.id, projectId]
      )) as MissionRow | undefined;
      if (!existing) throw new ApiError(404, `Mission ${missionId} not found in project`);

      const boardPosition = (index + 1) * 100;
      const statusChanged = existing.status_id !== statusId;
      const positionChanged = existing.board_position !== boardPosition;
      if (!statusChanged && !positionChanged) continue;

      const setClauses = ['board_position = ?'];
      const setParams: unknown[] = [boardPosition];
      const changed = ['board_position'];
      if (statusChanged) {
        setClauses.push('status_id = ?', 'status_type = ?');
        setParams.push(statusId, statusRow.type);
        changed.push('status_id', 'status_type');
      }

      const revision = existing.revision + 1;
      await tx.run(
        `UPDATE missions SET ${setClauses.join(', ')}, updated_at = ?, revision = ?
           WHERE id = ? AND workspace_id = ?`,
        [...setParams, now, revision, missionId, WORKSPACE.id]
      );

      await recordChange(
        {
          entityType: 'mission',
          entityId: missionId,
          operation: 'update',
          entityRevision: revision,
          projectId,
          missionId,
          changedFields: changed
        },
        tx
      );
    }
  });

  return (await listMissions(projectId)).filter(t => t.statusId === statusId);
}

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
        AND mtp.workspace_user_id = ? AND mtp.status_id = t.status_id
   WHERE t.workspace_id = ? AND t.deleted_at IS NULL
     AND t.assigned_workspace_user_id = ?
`;

/**
 * GET /api/workspace/my-missions — missions assigned to the active operator across
 * the active workspace. Read-time merge order: positioned missions first by their
 * personal position, then unpositioned missions by the approximate default
 * aggregate order (board_position, then recency, then a stable tiebreaker). The
 * client regroups by statusId, preserving this within-column order. If no actor
 * workspace-user resolves, returns an empty list rather than broadening.
 */
export async function listWorkspaceMyMissions(): Promise<MyMissionsResponse> {
  const actor = getActorWorkspaceUserId();
  if (!actor) return { missions: [] };
  const rows = (await requireDatabaseClient().all(
    `${selectMyMissionsSql}
         ORDER BY (mtp.position IS NULL) ASC, mtp.position ASC,
                  t.board_position ASC, t.updated_at DESC, t.sequence_number DESC, t.id ASC`,
    [actor, WORKSPACE.id, actor]
  )) as MyMissionRow[];
  const tagsByMission = await getTagsByMission(rows.map(row => row.id));
  return { missions: rows.map(row => toMyMissionDto(row, tagsByMission.get(row.id) ?? [])) };
}

/** Insert or update one operator's personal position for a mission in a column. */
async function upsertMyMissionPosition(
  db: DatabaseClient,
  {
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
  }
): Promise<void> {
  const existing = (await db.get(
    `SELECT id, revision FROM my_mission_positions
         WHERE workspace_id = ? AND workspace_user_id = ? AND mission_id = ?`,
    [WORKSPACE.id, actor, missionId]
  )) as { id: string; revision: number } | undefined;
  if (existing) {
    await db.run(
      `UPDATE my_mission_positions
          SET status_id = ?, position = ?, updated_at = ?, revision = ?
        WHERE id = ?`,
      [statusId, position, now, existing.revision + 1, existing.id]
    );
    return;
  }
  await db.run(
    `INSERT INTO my_mission_positions
       (id, workspace_id, workspace_user_id, mission_id, status_id, position, created_at, updated_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [newId(), WORKSPACE.id, actor, missionId, statusId, position, now, now]
  );
}

async function reorderWorkspaceMyMissionsTx(body: MyMissionReorderRequest): Promise<void> {
  const actor = getActorWorkspaceUserId();
  if (!actor) throw new ApiError(403, 'No active workspace operator to reorder for');

  const statusId = body.statusId;
  const orderedIds = body.orderedMissionIds;
  if (!statusId) throw new ApiError(400, 'statusId is required');
  if (!Array.isArray(orderedIds)) throw new ApiError(400, 'orderedMissionIds must be an array');
  if (new Set(orderedIds).size !== orderedIds.length) {
    throw new ApiError(400, 'orderedMissionIds contains duplicates');
  }

  await requireDatabaseClient().transaction(async tx => {
    // Resolve the target column against the active workspace. A status the
    // workspace doesn't own can never satisfy a mission's composite FK, so reject
    // early with a typed, workspace-specific code the client renders as an alert.
    const statusRow = (await tx.get(
      `SELECT * FROM workspace_statuses WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      [statusId, WORKSPACE.id]
    )) as WorkspaceStatusRow | undefined;
    if (!statusRow) {
      throw new ApiError(
        409,
        `That status is not available for missions in the ${WORKSPACE.name} workspace`,
        undefined,
        STATUS_UNAVAILABLE_FOR_WORKSPACE
      );
    }

    const now = nowIso();

    for (const [index, missionId] of orderedIds.entries()) {
      const existing = (await tx.get(
        `SELECT * FROM missions WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
        [missionId, WORKSPACE.id]
      )) as MissionRow | undefined;
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
        await tx.run(
          `UPDATE missions
              SET status_id = ?, status_type = ?,
                  board_position = ?, updated_at = ?, revision = ?
            WHERE id = ? AND workspace_id = ?`,
          [
            statusRow.id,
            statusRow.type,
            await topBoardPosition(tx, existing.project_id, statusRow.id, missionId),
            now,
            revision,
            missionId,
            WORKSPACE.id
          ]
        );
        await recordChange(
          {
            entityType: 'mission',
            entityId: missionId,
            operation: 'update',
            entityRevision: revision,
            projectId: existing.project_id,
            missionId,
            changedFields: ['status_id', 'status_type', 'board_position']
          },
          tx
        );
      }

      // Personal slot within the (operator, status) column. Writes only
      // my_mission_positions — never missions.board_position for a within-column move.
      await upsertMyMissionPosition(tx, {
        missionId,
        statusId: statusRow.id,
        position: (index + 1) * MY_POSITION_STEP,
        actor,
        now
      });
    }
  });
}

/**
 * PATCH /api/workspace/my-missions/order — persist a personal reorder of one My
 * Missions status column for the active operator. Translates a foreign-key
 * rejection (a status the mission's workspace lacks) into the typed
 * `STATUS_UNAVAILABLE_FOR_WORKSPACE` error so the client can alert and revert.
 */
export async function reorderWorkspaceMyMissions(
  body: MyMissionReorderRequest
): Promise<MyMissionsResponse> {
  try {
    await reorderWorkspaceMyMissionsTx(body);
    return listWorkspaceMyMissions();
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

export async function listObjectives(
  missionId: string,
  db: DatabaseClient = requireDatabaseClient()
): Promise<ObjectiveDto[]> {
  const rows = (await db.all(
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
        ORDER BY o.position ASC`,
    [missionId]
  )) as ObjectiveRow[];
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
export async function reorderFutureObjectives(
  missionId: string,
  body: ReorderFutureObjectivesBody
): Promise<ObjectiveDto[]> {
  const orderedIds = body.orderedObjectiveIds;
  if (!Array.isArray(orderedIds)) {
    throw new ApiError(400, 'orderedObjectiveIds must be an array');
  }
  if (new Set(orderedIds).size !== orderedIds.length) {
    throw new ApiError(400, 'orderedObjectiveIds contains duplicates');
  }

  await requireDatabaseClient().transaction(async tx => {
    const mission = (await tx.get(
      `SELECT id, project_id FROM missions WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      [missionId, WORKSPACE.id]
    )) as { id: string; project_id: string } | undefined;
    if (!mission) throw new ApiError(404, 'Mission not found');

    const rows = (await tx.all(
      `SELECT * FROM objectives
           WHERE mission_id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      [missionId, WORKSPACE.id]
    )) as ObjectiveRow[];
    const byId = new Map(rows.map(row => [row.id, row]));

    const targets = orderedIds.map(id => {
      const row = byId.get(id);
      if (!row) throw new ApiError(404, `Objective ${id} not found on mission`);
      if (row.state !== 'future') {
        throw new ApiError(400, `Objective ${id} is not a future objective`);
      }
      return row;
    });
    if (targets.length === 0) return;

    // Renumber starting at the lowest position the future group currently holds,
    // keeping the whole group after any non-future objectives.
    const basePosition = Math.min(...targets.map(row => row.position));

    const updates = targets
      .map((existing, index) => ({
        existing,
        position: basePosition + index,
        revision: existing.revision + 1
      }))
      .filter(({ existing, position }) => existing.position !== position);
    if (updates.length === 0) return;

    const now = nowIso();
    const maxPosition = Math.max(...rows.map(row => row.position), basePosition);
    const tempBase = maxPosition + updates.length + 1;

    // Move every changed row out of the constrained range first so swaps do not
    // trip the mission_id+position uniqueness constraint mid-transaction.
    for (const [index, { existing }] of updates.entries()) {
      await tx.run(
        `UPDATE objectives SET position = ?, updated_at = ?
           WHERE id = ? AND workspace_id = ?`,
        [tempBase + index, now, existing.id, WORKSPACE.id]
      );
    }

    for (const { existing, position, revision } of updates) {
      await tx.run(
        `UPDATE objectives SET position = ?, updated_at = ?, revision = ?
           WHERE id = ? AND workspace_id = ?`,
        [position, now, revision, existing.id, WORKSPACE.id]
      );

      await recordChange(
        {
          entityType: 'objective',
          entityId: existing.id,
          operation: 'update',
          entityRevision: revision,
          projectId: mission.project_id,
          missionId,
          objectiveId: existing.id,
          changedFields: ['position']
        },
        tx
      );
    }
  });

  return listObjectives(missionId);
}

type InternalCreateObjectiveBody = CreateObjectiveBody & { assignedAgent?: string | null };

// Internal insert used by both createObjective and createMission's first objective.
// Runs on the provided transaction-scoped client.
async function insertObjective(
  db: DatabaseClient,
  body: InternalCreateObjectiveBody
): Promise<ObjectiveDto> {
  const instruction = (body.instructionText ?? '').trim();

  const mission = (await db.get(
    `SELECT id, project_id FROM missions WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [body.missionId, WORKSPACE.id]
  )) as { id: string; project_id: string } | undefined;
  if (!mission) throw new ApiError(404, 'Mission not found');

  const requestedState = body.state ?? 'draft';
  if (!VALID_STATES.includes(requestedState)) throw new ApiError(400, 'Invalid objective state');

  const draftRow = (await db.get(
    `SELECT id FROM objectives
       WHERE mission_id = ? AND workspace_id = ? AND state = 'draft' AND deleted_at IS NULL
       LIMIT 1`,
    [body.missionId, WORKSPACE.id]
  )) as { id: string } | undefined;
  const state = requestedState === 'draft' && draftRow ? 'future' : requestedState;

  // Blank instructions are allowed only for editable slots that are authored
  // inline afterwards (`draft`/`future`) — the add-objective affordance creates
  // such a slot and renders it directly as a DraftObjective card. Submitted and
  // later states still require instruction text.
  const allowsBlankInstruction = state === 'draft' || state === 'future';
  if (!instruction && !allowsBlankInstruction) {
    throw new ApiError(400, 'Objective instruction is required');
  }

  const maxRow = (await db.get(
    `SELECT MAX(position) AS max_pos FROM objectives WHERE mission_id = ? AND deleted_at IS NULL`,
    [body.missionId]
  )) as { max_pos: number | null };
  const position = (maxRow.max_pos ?? -1) + 1;

  // Editable slots (draft/future) default to the project's last-used launch
  // selection so the agent is always recorded on the objective. The launch button
  // reads the stored agent, and auto-advance/execution use it, so what the user
  // sees and what runs stay in agreement instead of falling back to a hardcoded
  // runner default.
  const explicitAgent = body.assignedAgent?.trim() || null;
  const launchSelection =
    !explicitAgent && (state === 'draft' || state === 'future')
      ? await getLaunchPreference(mission.project_id, db)
      : { selectedAgent: null, selectedModel: null, selectedReasoningEffort: null };

  const now = nowIso();
  const id = newId();
  await db.run(
    `INSERT INTO objectives
       (id, workspace_id, project_id, mission_id, position, title, instruction_text, state,
        assigned_agent, model, reasoning_effort, agent_flags_json, auto_advance,
        execution_metadata_json, created_by_workspace_user_id, created_at, updated_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, '{}', ?, ?, ?, 1)`,
    [
      id,
      WORKSPACE.id,
      mission.project_id,
      body.missionId,
      position,
      body.title?.trim() ||
        (instruction ? initialTitleFromInstruction(instruction) : 'New objective'),
      instruction,
      state,
      explicitAgent ?? launchSelection.selectedAgent,
      explicitAgent ? null : launchSelection.selectedModel,
      explicitAgent ? null : launchSelection.selectedReasoningEffort,
      bindBool(DATABASE_DIALECT, body.autoAdvance ?? false),
      getActorWorkspaceUserId(),
      now,
      now
    ]
  );

  await recordChange(
    {
      entityType: 'objective',
      entityId: id,
      operation: 'insert',
      entityRevision: 1,
      projectId: mission.project_id,
      missionId: body.missionId,
      objectiveId: id
    },
    db
  );

  const row = (await db.get(`SELECT * FROM objectives WHERE id = ?`, [id])) as ObjectiveRow;
  return toObjectiveDto(row);
}

function createObjectiveTx(body: InternalCreateObjectiveBody): Promise<ObjectiveDto> {
  return requireDatabaseClient().transaction(tx => insertObjective(tx, body));
}

export async function createObjective(body: CreateObjectiveBody): Promise<ObjectiveDto> {
  const objective = await createObjectiveTx(body);

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

async function ensureDraftSlotAfterObjectiveLeavesQueue(
  db: DatabaseClient,
  {
    missionId,
    projectId,
    assignedAgent,
    now
  }: {
    missionId: string;
    projectId: string;
    assignedAgent: string | null;
    now: string;
  }
): Promise<void> {
  const drafts = (await db.all(
    `SELECT id, instruction_text, revision FROM objectives
       WHERE mission_id = ? AND workspace_id = ? AND state = 'draft' AND deleted_at IS NULL
       ORDER BY position ASC, created_at ASC`,
    [missionId, WORKSPACE.id]
  )) as Array<{
    id: string;
    instruction_text: string;
    revision: number;
  }>;

  if (drafts.some(draft => draft.instruction_text.trim())) return;

  const nextFuture = (await db.get(
    `SELECT id, revision FROM objectives
       WHERE mission_id = ? AND workspace_id = ? AND state = 'future' AND deleted_at IS NULL
       ORDER BY position ASC, created_at ASC LIMIT 1`,
    [missionId, WORKSPACE.id]
  )) as { id: string; revision: number } | undefined;

  if (nextFuture) {
    for (const draft of drafts) {
      const draftRevision = draft.revision + 1;
      await db.run(
        `UPDATE objectives
         SET deleted_at = ?, updated_at = ?, revision = ?
         WHERE id = ? AND workspace_id = ?`,
        [now, now, draftRevision, draft.id, WORKSPACE.id]
      );

      await recordChange(
        {
          entityType: 'objective',
          entityId: draft.id,
          operation: 'delete',
          entityRevision: draftRevision,
          projectId,
          missionId,
          objectiveId: draft.id
        },
        db
      );
    }

    const nextRevision = nextFuture.revision + 1;
    await db.run(
      `UPDATE objectives
       SET state = 'draft', completed_at = NULL, updated_at = ?, revision = ?
       WHERE id = ? AND workspace_id = ?`,
      [now, nextRevision, nextFuture.id, WORKSPACE.id]
    );

    await recordChange(
      {
        entityType: 'objective',
        entityId: nextFuture.id,
        operation: 'update',
        entityRevision: nextRevision,
        projectId,
        missionId,
        objectiveId: nextFuture.id,
        changedFields: ['state', 'completed_at']
      },
      db
    );
    return;
  }

  if (drafts.length === 0) {
    await insertObjective(db, {
      missionId,
      instructionText: '',
      state: 'draft',
      assignedAgent
    });
  }
}

async function updateObjectiveTx(
  id: string,
  body: UpdateObjectiveBody
): Promise<{ objective: ObjectiveDto; regenerateTitle: boolean }> {
  return requireDatabaseClient().transaction(async tx => {
    const existing = (await tx.get(
      `SELECT * FROM objectives WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      [id, WORKSPACE.id]
    )) as ObjectiveRow | undefined;
    if (!existing) throw new ApiError(404, 'Objective not found');

    const fields: string[] = [];
    const setParams: unknown[] = [];
    const changed: string[] = [];

    let instructionChanged = false;
    if (body.instructionText !== undefined) {
      const instruction = body.instructionText.trim();
      const resultingState = body.state ?? existing.state;
      const allowsBlankInstruction = resultingState === 'draft' || resultingState === 'future';
      if (!instruction && !allowsBlankInstruction) {
        throw new ApiError(400, 'Objective instruction is required');
      }
      fields.push('instruction_text = ?');
      setParams.push(instruction);
      changed.push('instruction_text');
      instructionChanged = true;
    }
    if (body.title !== undefined) {
      fields.push('title = ?');
      setParams.push(body.title?.trim() || null);
      changed.push('title');
    }
    if (body.state !== undefined) {
      if (!VALID_STATES.includes(body.state)) throw new ApiError(400, 'Invalid objective state');
      fields.push('state = ?');
      setParams.push(body.state);
      changed.push('state');
      if (body.state === 'complete') {
        fields.push('completed_at = ?');
        setParams.push(nowIso());
      }
    }
    if (body.autoAdvance !== undefined) {
      fields.push('auto_advance = ?');
      setParams.push(bindBool(DATABASE_DIALECT, body.autoAdvance));
      changed.push('auto_advance');
    }
    if (body.position !== undefined) {
      if (!Number.isInteger(body.position) || body.position < 0) {
        throw new ApiError(400, 'Invalid position');
      }
      fields.push('position = ?');
      setParams.push(body.position);
      changed.push('position');
    }
    if (body.assignedAgent !== undefined) {
      fields.push('assigned_agent = ?');
      setParams.push(body.assignedAgent?.trim() || null);
      changed.push('assigned_agent');
    }
    if (body.model !== undefined) {
      fields.push('model = ?');
      setParams.push(body.model?.trim() || null);
      changed.push('model');
    }
    if (body.reasoningEffort !== undefined) {
      fields.push('reasoning_effort = ?');
      setParams.push(body.reasoningEffort?.trim() || null);
      changed.push('reasoning_effort');
    }
    if (fields.length === 0) {
      return { objective: toObjectiveDto(existing), regenerateTitle: false };
    }

    const now = nowIso();
    const revision = existing.revision + 1;
    if (body.state === 'draft') {
      const otherDrafts = (await tx.all(
        `SELECT id, revision FROM objectives
           WHERE mission_id = ? AND workspace_id = ? AND state = 'draft'
             AND id <> ? AND deleted_at IS NULL`,
        [existing.mission_id, WORKSPACE.id, id]
      )) as Array<{ id: string; revision: number }>;

      for (const draft of otherDrafts) {
        const draftRevision = draft.revision + 1;
        await tx.run(
          `UPDATE objectives SET state = 'future', updated_at = ?, revision = ?
           WHERE id = ? AND workspace_id = ?`,
          [now, draftRevision, draft.id, WORKSPACE.id]
        );

        await recordChange(
          {
            entityType: 'objective',
            entityId: draft.id,
            operation: 'update',
            entityRevision: draftRevision,
            projectId: existing.project_id,
            missionId: existing.mission_id,
            objectiveId: draft.id,
            changedFields: ['state']
          },
          tx
        );
      }
    }

    await tx.run(
      `UPDATE objectives SET ${fields.join(', ')}, updated_at = ?, revision = ?
         WHERE id = ? AND workspace_id = ?`,
      [...setParams, now, revision, id, WORKSPACE.id]
    );

    await recordChange(
      {
        entityType: 'objective',
        entityId: id,
        operation: 'update',
        entityRevision: revision,
        projectId: existing.project_id,
        missionId: existing.mission_id,
        objectiveId: id,
        changedFields: changed
      },
      tx
    );

    if (
      body.state === 'executing' &&
      body.state !== existing.state &&
      (existing.state === 'draft' ||
        existing.state === 'future' ||
        existing.state === 'submitted' ||
        existing.state === 'launching')
    ) {
      await ensureDraftSlotAfterObjectiveLeavesQueue(tx, {
        missionId: existing.mission_id,
        projectId: existing.project_id,
        assignedAgent:
          body.assignedAgent !== undefined
            ? body.assignedAgent?.trim() || null
            : existing.assigned_agent,
        now
      });
    }

    // When a user manually moves an objective out of the launch pipeline
    // (completing it, or disconnecting it back to future/executing/pending),
    // the runner must stop seeing it: clear queued work and end open sessions.
    if (
      body.state !== undefined &&
      body.state !== existing.state &&
      !LAUNCHABLE_STATES.includes(body.state)
    ) {
      await dequeueObjective({
        objectiveId: id,
        projectId: existing.project_id,
        missionId: existing.mission_id,
        reason: body.state === 'complete' ? 'completed' : 'disconnected',
        newState: body.state,
        now,
        tx
      });
    }

    const row = (await tx.get(`SELECT * FROM objectives WHERE id = ?`, [id])) as ObjectiveRow;
    const objective = toObjectiveDto(row);

    return {
      objective,
      regenerateTitle: instructionChanged && body.title === undefined
    };
  });
}

export async function updateObjective(
  id: string,
  body: UpdateObjectiveBody
): Promise<ObjectiveDto> {
  const { objective, regenerateTitle } = await updateObjectiveTx(id, body);

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

export async function deleteObjective(id: string): Promise<void> {
  await requireDatabaseClient().transaction(async tx => {
    const existing = (await tx.get(
      `SELECT * FROM objectives WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      [id, WORKSPACE.id]
    )) as ObjectiveRow | undefined;
    if (!existing) throw new ApiError(404, 'Objective not found');

    const now = nowIso();
    const revision = existing.revision + 1;
    await tx.run(
      `UPDATE objectives SET deleted_at = ?, revision = ?
       WHERE id = ? AND workspace_id = ?`,
      [now, revision, id, WORKSPACE.id]
    );

    await recordChange(
      {
        entityType: 'objective',
        entityId: id,
        operation: 'delete',
        entityRevision: revision,
        projectId: existing.project_id,
        missionId: existing.mission_id,
        objectiveId: id
      },
      tx
    );

    // A deleted objective must also leave the runner queue: the runner's claim
    // query joins objectives without filtering soft-deletes, so stale queued
    // requests could otherwise still be claimed.
    await dequeueObjective({
      objectiveId: id,
      projectId: existing.project_id,
      missionId: existing.mission_id,
      reason: 'deleted',
      newState: null,
      now,
      tx
    });
  });
}

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
async function loadOperatorUserRow(db: DatabaseClient = requireDatabaseClient()): Promise<UserRow> {
  const actor = getActorWorkspaceUserId();
  if (actor) {
    const row = (await db.get(
      `SELECT p.id, p.kind, p.display_name, p.handle, p.email,
                p.metadata_json, p.created_at, p.revision
           FROM profiles p
           JOIN workspace_users wu ON wu.profile_id = p.id
          WHERE wu.id = ? AND p.deleted_at IS NULL`,
      [actor]
    )) as UserRow | undefined;
    if (row) return row;
  }
  const fallback = (await db.get(
    `SELECT id, kind, display_name, handle, email,
              metadata_json, created_at, revision
         FROM profiles
        WHERE kind = 'human' AND status = 'active' AND deleted_at IS NULL
        ORDER BY created_at ASC LIMIT 1`
  )) as UserRow | undefined;
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

async function toProfileDto(row: UserRow): Promise<ProfileDto> {
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
    roles: await loadActorRoles(),
    createdAt: row.created_at
  };
}

export async function getProfile(): Promise<ProfileDto> {
  return toProfileDto(await loadOperatorUserRow());
}

export async function updateProfile(body: UpdateProfileBody): Promise<ProfileDto> {
  await requireDatabaseClient().transaction(async tx => {
    const existing = await loadOperatorUserRow(tx);

    const fields: string[] = [];
    const setParams: unknown[] = [];
    const changed: string[] = [];
    // `metadata_json` may be updated by several body fields; track its value and a
    // single placeholder so repeated edits compose instead of clobbering.
    let metadataJson: string | undefined;
    const setMetadata = (value: string): void => {
      metadataJson = value;
      if (!changed.includes('metadata_json')) changed.push('metadata_json');
    };

    if (body.displayName !== undefined) {
      const displayName = body.displayName.trim();
      if (!displayName) throw new ApiError(400, 'Display name cannot be empty');
      fields.push('display_name = ?');
      setParams.push(displayName);
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
      fields.push('email = ?');
      setParams.push(email);
      changed.push('email');
    }
    if (body.avatarUrl !== undefined) {
      const avatarUrl = body.avatarUrl?.trim() || null;
      // Accept absolute http(s) URLs or a server-relative path (e.g. an image
      // uploaded through the core upload service: `/api/storage/user-images/…`).
      if (avatarUrl && !/^(https?:\/\/|\/)/i.test(avatarUrl)) {
        throw new ApiError(400, 'Avatar URL must be an http(s) URL or an uploaded image path');
      }
      setMetadata(
        mergeProfileMetadataJson({
          metadataJson: existing.metadata_json,
          avatarUrl
        })
      );
    }
    if (body.agentInstructions !== undefined) {
      setMetadata(
        mergeProfileMetadataJson({
          metadataJson: metadataJson ?? existing.metadata_json,
          agentInstructions: body.agentInstructions
        })
      );
    }
    if (body.editorScheme !== undefined) {
      setMetadata(
        mergeProfileMetadataJson({
          metadataJson: metadataJson ?? existing.metadata_json,
          editorScheme: body.editorScheme
        })
      );
    }
    if (metadataJson !== undefined) {
      fields.push('metadata_json = ?');
      setParams.push(metadataJson);
    }
    if (fields.length === 0) return;

    const now = nowIso();
    const revision = existing.revision + 1;
    await tx.run(
      `UPDATE profiles SET ${fields.join(', ')}, updated_at = ?, revision = ?
       WHERE id = ?`,
      [...setParams, now, revision, existing.id]
    );

    await recordChange(
      {
        entityType: 'profile',
        entityId: existing.id,
        operation: 'update',
        entityRevision: revision,
        changedFields: changed
      },
      tx
    );
  });

  return getProfile();
}

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
async function loadTokenScopeGrants(db: DatabaseClient, tokenId: string): Promise<string[]> {
  const rows = (await db.all(
    `SELECT permission FROM user_token_scopes
         WHERE token_id = ? AND workspace_id = ? AND deleted_at IS NULL
         ORDER BY permission ASC`,
    [tokenId, WORKSPACE.id]
  )) as Array<{ permission: string }>;
  return rows.map(r => r.permission);
}

async function toUserTokenDto(db: DatabaseClient, row: UserTokenRow): Promise<UserTokenDto> {
  const scopeGrants = await loadTokenScopeGrants(db, row.id);
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
async function loadOperatorIdentity(db: DatabaseClient): Promise<OperatorIdentity> {
  const user = await loadOperatorUserRow(db);
  const membership = (await db.get(
    `SELECT id FROM workspace_users
         WHERE workspace_id = ? AND profile_id = ? AND deleted_at IS NULL
         ORDER BY created_at ASC LIMIT 1`,
    [WORKSPACE.id, user.id]
  )) as { id: string } | undefined;
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

async function loadUserTokenForUpdate(
  db: DatabaseClient,
  id: string
): Promise<UserTokenMutableRow> {
  const row = (await db.get(
    `SELECT id, status, revision FROM user_tokens
         WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [id, WORKSPACE.id]
  )) as UserTokenMutableRow | undefined;
  if (!row) throw new ApiError(404, 'Token not found');
  return row;
}

async function reloadUserToken(db: DatabaseClient, id: string): Promise<UserTokenRow> {
  return (await db.get(`SELECT ${USER_TOKEN_COLUMNS} FROM user_tokens WHERE id = ?`, [
    id
  ])) as UserTokenRow;
}

export async function listUserTokens(): Promise<UserTokenDto[]> {
  const client = requireDatabaseClient();
  const rows = (await client.all(
    `SELECT ${USER_TOKEN_COLUMNS} FROM user_tokens
         WHERE workspace_id = ? AND deleted_at IS NULL
         ORDER BY created_at DESC`,
    [WORKSPACE.id]
  )) as UserTokenRow[];
  return Promise.all(rows.map(row => toUserTokenDto(client, row)));
}

export async function createUserToken(
  body: CreateUserTokenBody
): Promise<CreateUserTokenResultDto> {
  return requireDatabaseClient().transaction(async tx => {
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

    const { userId, workspaceUserId } = await loadOperatorIdentity(tx);

    // The (workspace_id, token_prefix) index is unique; retry on the rare clash.
    let generated: ReturnType<typeof generateUserTokenSecret> | null = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = generateUserTokenSecret();
      const clash = await tx.get(
        'SELECT 1 FROM user_tokens WHERE workspace_id = ? AND token_prefix = ?',
        [WORKSPACE.id, candidate.prefix]
      );
      if (!clash) {
        generated = candidate;
        break;
      }
    }
    if (!generated) throw new ApiError(409, 'Could not allocate a unique token prefix; try again');

    const id = newId();
    const now = nowIso();
    await tx.run(
      `INSERT INTO user_tokens (
         id, workspace_id, profile_id, workspace_user_id, label,
         token_prefix, token_hash, hash_algorithm, status, expires_at,
         last_used_context_json, metadata_json, created_at, updated_at, revision
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, '{}', '{}', ?, ?, 1)`,
      [
        id,
        WORKSPACE.id,
        userId,
        workspaceUserId,
        label,
        generated.prefix,
        generated.hash,
        USER_TOKEN_HASH_ALGORITHM,
        expiresAt,
        now,
        now
      ]
    );

    // A `full` token carries no scope rows (no token-level restriction). A scoped
    // token persists one grant pattern per row; auth-time enforcement intersects
    // these with the creating user's role grants.
    for (const permission of scopeGrants) {
      await tx.run(
        `INSERT INTO user_token_scopes (
         id, workspace_id, token_id, permission, resource_type, resource_id,
         created_at, updated_at, revision
       ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, 1)`,
        [newId(), WORKSPACE.id, id, permission, now, now]
      );
    }

    await recordChange(
      {
        entityType: 'user_token',
        entityId: id,
        operation: 'insert',
        entityRevision: 1
      },
      tx
    );

    return {
      token: await toUserTokenDto(tx, await reloadUserToken(tx, id)),
      secret: generated.secret
    };
  });
}

export async function renameUserToken(
  id: string,
  body: UpdateUserTokenBody
): Promise<UserTokenDto> {
  return requireDatabaseClient().transaction(async tx => {
    const existing = await loadUserTokenForUpdate(tx, id);
    const label = body.label?.trim();
    if (!label) throw new ApiError(400, 'Token label cannot be empty');

    const now = nowIso();
    const revision = existing.revision + 1;
    await tx.run(
      `UPDATE user_tokens SET label = ?, updated_at = ?, revision = ?
         WHERE id = ? AND workspace_id = ?`,
      [label, now, revision, id, WORKSPACE.id]
    );

    await recordChange(
      {
        entityType: 'user_token',
        entityId: id,
        operation: 'update',
        entityRevision: revision,
        changedFields: ['label']
      },
      tx
    );

    return toUserTokenDto(tx, await reloadUserToken(tx, id));
  });
}

export async function revokeUserToken(id: string): Promise<UserTokenDto> {
  return requireDatabaseClient().transaction(async tx => {
    const existing = await loadUserTokenForUpdate(tx, id);
    // Revocation is idempotent: revoking an already-revoked token is a no-op.
    if (existing.status === 'revoked') return toUserTokenDto(tx, await reloadUserToken(tx, id));

    const { workspaceUserId } = await loadOperatorIdentity(tx);
    const now = nowIso();
    const revision = existing.revision + 1;
    await tx.run(
      `UPDATE user_tokens
        SET status = 'revoked', revoked_at = ?,
            revoked_by_workspace_user_id = ?,
            updated_at = ?, revision = ?
      WHERE id = ? AND workspace_id = ?`,
      [now, workspaceUserId, now, revision, id, WORKSPACE.id]
    );

    await recordChange(
      {
        entityType: 'user_token',
        entityId: id,
        operation: 'update',
        entityRevision: revision,
        changedFields: ['status', 'revoked_at']
      },
      tx
    );

    return toUserTokenDto(tx, await reloadUserToken(tx, id));
  });
}
