/**
 * Typed API contract shared between the REST server (`server/`) and the React
 * SPA (`web/`). DTO field names are the camelCase form of the logical schema
 * columns (see database/docs/09-database-schema-contract.md). This file is
 * types only so it can be `import type`-d from either runtime without a runtime
 * dependency.
 *
 * Scope note: this build covers projects, missions, and objectives — the entities
 * the web interface lets users add and modify — plus the objective launch
 * surface: the workspace agent catalog, per-user launch configs, project launch
 * preferences, and execution-request queueing. Runner claiming/launching and
 * deliveries remain CLI-only and are intentionally absent here.
 */

// ---- Closed status vocabularies (from the schema CHECK constraints) ----

export type ProjectLifecycle = 'active' | 'archived';

export type StatusType = 'draft' | 'execute' | 'review' | 'complete' | 'blocked' | 'cancelled';

export type MissionPriority = 'low' | 'normal' | 'high' | 'urgent';

export type ObjectiveState =
  | 'future'
  | 'draft'
  | 'submitted'
  | 'launching'
  | 'executing'
  | 'pending_delivery'
  | 'complete';

export type EntityType = 'project' | 'mission' | 'objective';

export type ChangeOperation = 'insert' | 'update' | 'delete' | 'restore';

// ---- Resource DTOs ----

export interface WorkspaceDto {
  id: string;
  slug: string;
  name: string;
  /** Open vocabulary (`local`, `hosted`, …). Locally created workspaces are `local`. */
  kind: string;
  /** Whether this is the web server's currently active workspace. */
  isActive: boolean;
  /** Count of non-deleted projects in the workspace (read-side aggregate). */
  projectCount: number;
  /** Count of active members in the workspace (read-side aggregate). */
  memberCount: number;
  /** Whether SQL Studio is enabled for this workspace (admin-managed). */
  sqlStudioEnabled: boolean;
  createdAt: string;
}

export interface CreateWorkspaceBody {
  /** Optional stable workspace ID; derived from the full name when omitted. */
  id?: string;
  name: string;
  /** Optional slug; derived from the name (and uniquified) when omitted. */
  slug?: string;
}

/** Partial update of a workspace. Omitted fields are left unchanged. */
export interface UpdateWorkspaceBody {
  name?: string;
  /** Admin-only: enable or disable SQL Studio for this workspace. */
  sqlStudioEnabled?: boolean;
}

/**
 * Initial instance setup: names the seeded first workspace and picks its slug.
 * The slug prefixes mission identifiers (`<slug>:<sequence>`); when omitted it
 * is suggested from the first three letters of the name.
 */
export interface CompleteInitialSetupBody {
  /** Optional stable workspace ID; derived from the full name when omitted. */
  id?: string;
  name: string;
  slug?: string;
}

/**
 * A workspace membership (`workspace_users` joined to `profiles`). Read-only in
 * this single-trusted-user build — invitations and role management are hosted
 * features; the local web server only lists who belongs to a workspace.
 */
export interface WorkspaceMemberDto {
  /** `workspace_users.id` — the workspace-scoped identity. */
  workspaceUserId: string;
  /** `profiles.id` — the profile behind the membership. */
  userId: string;
  /** `profiles.display_name`. */
  displayName: string;
  handle: string | null;
  email: string | null;
  /** Open vocabulary (`human`, `service`). */
  kind: string;
  /** Whether this membership belongs to the local operator. */
  isOperator: boolean;
  /** `workspace_users.created_at`. */
  joinedAt: string;
  /** Optional avatar image URL from `profiles.metadata_json.avatarUrl`. */
  avatarUrl: string | null;
}

export interface ProjectDto {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string | null;
  /** Optional hex color stored in project settings for UI display. */
  color: string | null;
  /**
   * Project-configured base/parent branch for mission branches (stored in project
   * settings). `null` means not configured — callers fall back to `main`. This is
   * both the branch missions are cut from and the parent that "Merge with parent"
   * advances.
   */
  defaultBranch: string | null;
  status: ProjectLifecycle;
  createdAt: string;
  updatedAt: string;
  revision: number;
  /** Count of non-deleted missions (read-side aggregate). */
  missionCount: number;
}

export interface WorkspaceStatusDto {
  id: string;
  workspaceId: string;
  key: string;
  name: string;
  type: StatusType;
  position: number;
  isDefault: boolean;
  isTerminal: boolean;
}

export interface CreateWorkspaceStatusBody {
  name: string;
  type: StatusType;
  /** When true, clears the previous default. Only draft-type statuses may be default. */
  isDefault?: boolean;
}

export interface UpdateWorkspaceStatusBody {
  name?: string;
  /** When true, clears the previous default. Only draft-type statuses may be default. */
  isDefault?: boolean;
}

/**
 * Reorders every status in the workspace. `orderedStatusIds` lists status ids
 * top-to-bottom after the move and must include every active status exactly once.
 */
export interface ReorderWorkspaceStatusesBody {
  orderedStatusIds: string[];
}

export type ProjectResourceType = 'local_directory' | 'remote_directory';
export type ProjectResourceStatus = 'active' | 'missing' | 'archived';

export interface CreateProjectResourceBody {
  directoryPath: string;
  label?: string | null;
  isPrimary?: boolean;
  executionTargetId?: string | null;
}

export interface UpdateProjectResourceBody {
  isPrimary?: boolean;
}

export interface ProjectResourceDto {
  id: string;
  workspaceId: string;
  projectId: string;
  executionTargetId: string | null;
  type: ProjectResourceType;
  label: string | null;
  path: string;
  isPrimary: boolean;
  status: ProjectResourceStatus;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export type RepositoryEntryType = 'file' | 'directory';

export interface RepositoryEntryDto {
  path: string;
  name: string;
  type: RepositoryEntryType;
  parentPath: string | null;
  depth: number;
}

export type ProjectRepositoryStatus =
  | 'ready'
  | 'no_resource'
  | 'not_git_repository'
  | 'unsupported_resource'
  | 'unreadable';

export interface ProjectRepositoryDto {
  projectId: string;
  executionTargetId: string | null;
  resource: ProjectResourceDto | null;
  status: ProjectRepositoryStatus;
  rootPath: string | null;
  gitRoot: string | null;
  branch: string | null;
  commit: string | null;
  entries: RepositoryEntryDto[];
  truncated: boolean;
  scannedAt: string;
  message: string | null;
}

export interface MissionDto {
  id: string;
  workspaceId: string;
  projectId: string;
  displayId: string;
  sequenceNumber: number;
  title: string;
  statusId: string;
  statusType: StatusType;
  /**
   * Gap-based ordering of the mission within its board column (its
   * `(projectId, statusId)` group). Lower sorts first. Renumbered densely
   * (100, 200, 300, …) whenever a column is reordered.
   */
  boardPosition: number;
  priority: MissionPriority | null;
  /**
   * `workspace_users.id` of the member this mission is assigned to, or `null`
   * when unassigned. Matches a `WorkspaceMemberDto.workspaceUserId`.
   */
  assignedWorkspaceUserId: string | null;
  /** Human-readable acceptance criteria for the mission. */
  acceptanceCriteria: string | null;
  /** Tool names available to the agent working on this mission. */
  availableTools: string[];
  createdAt: string;
  updatedAt: string;
  revision: number;
  /** Count of non-deleted objectives (read-side aggregate). */
  objectiveCount: number;
  /** Count of non-deleted objectives in the `complete` state (read-side aggregate). */
  completedObjectiveCount: number;
  /** True when at least one non-deleted objective on this mission is `executing`. */
  hasExecutingObjective: boolean;
  /** True when at least one non-deleted objective on this mission is `complete`. */
  hasCompletedObjective: boolean;
  /**
   * True when at least one non-deleted `draft` or `future` objective on this
   * mission has non-empty instruction text (i.e. work still queued behind a
   * completed objective).
   */
  hasPendingObjectiveWithInstructions: boolean;
  /** Tags assigned to this mission, resolved from its project's `project_tags`. */
  tags: ProjectTagDto[];
}

export interface ObjectiveDto {
  id: string;
  workspaceId: string;
  projectId: string;
  missionId: string;
  position: number;
  title: string | null;
  instructionText: string;
  state: ObjectiveState;
  autoAdvance: boolean;
  assignedAgent: string | null;
  model: string | null;
  reasoningEffort: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
  /** Native harness session/resume ID from the objective's latest agent session, when captured. */
  externalSessionId: string | null;
  /**
   * The branch this objective actually ran on, recorded by the runner at
   * branch-prepared time. `null` until the objective has been launched with a
   * prepared branch (or when worktree/branch automation is disabled).
   */
  branch: string | null;
}

export type ArtifactType =
  | 'test_results'
  | 'next_steps'
  | 'note'
  | 'url'
  | 'decision'
  | 'migration';

export interface ArtifactDto {
  id: string;
  workspaceId: string;
  projectId: string;
  missionId: string;
  objectiveId: string | null;
  sessionId: string | null;
  deliveryId: string | null;
  /** Open vocabulary: `test_results`, `next_steps`, `note`, `url`, `decision`, `migration`. */
  type: ArtifactType | string;
  label: string;
  contentText: string | null;
  contentJson: unknown | null;
  externalUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MissionDetailDto extends MissionDto {
  objectives: ObjectiveDto[];
  statuses: WorkspaceStatusDto[];
  /** Active (queued/claimed/launching) execution requests for this mission's objectives. */
  executionRequests: ExecutionRequestDto[];
  /** Read-only branch/worktree metadata derived from `missions.active_branch`. */
  branch: MissionBranchDto | null;
}

// `pending`         — no branch prepared yet (planner-predicted name shown).
// `created`         — branch cut from base for use, but not yet pushed to a remote.
// `published`       — branch pushed to `origin` (a matching remote ref exists), not merged.
// `merged_unpushed` — branch merged into the *local* base, but that base has not
//                     been pushed to `origin` yet (the gap between merge Action A
//                     and the push Action B).
// `merged`          — branch's commits are contained in the *remote* base (`origin/<base>`).
export type MissionBranchStatus =
  | 'pending'
  | 'created'
  | 'published'
  | 'merged_unpushed'
  | 'merged';

// Per-mission override of the workspace worktree-automation setting.
// `'worktree'` — prepare a branch + worktree for this mission (full automation
//   behavior) even when the workspace setting is off.
// `'branch'`   — prepare a branch for this mission without a dedicated worktree
//   (the branch is checked out in the project's primary repo).
// `null` (the absence of an override) means "inherit the workspace setting".
export type MissionWorktreePreference = 'worktree' | 'branch';

export interface MissionBranchDto {
  name: string;
  baseBranch: string | null;
  worktreePath: string | null;
  status: MissionBranchStatus;
  /**
   * Whether the branch's worktree has uncommitted changes (`git status
   * --porcelain` is non-empty in the worktree). `false` when no worktree exists
   * or the branch is still `pending`. The mission panel uses this to require a
   * commit before the "Update from parent & merge" action is offered.
   */
  dirty: boolean;
  /**
   * A user-pinned branch chosen in the mission panel to override the planner's
   * default selection. When set, the next launch prepares/uses this branch
   * instead of `name`. `null` means the system chooses automatically. The
   * Runner Layer reads this to honor the override at branch-preparation time.
   */
  overrideBranch: string | null;
  /**
   * Whether the workspace-wide worktree/branch automation setting
   * (`worktreeBranchAutomationEnabled`) is on. Surfaced here so the mission panel
   * and the Runner Layer can resolve the mission's effective branch behavior
   * without a separate launch-settings read.
   */
  worktreeAutomationEnabled: boolean;
  /**
   * The mission's per-mission override of the workspace setting, or `null` to
   * inherit it. See `MissionWorktreePreference`. Lets a user opt an individual
   * mission into a branch/worktree while automation is globally off (and vice
   * versa). The Runner Layer reads this to decide branch preparation.
   */
  worktreePreference: MissionWorktreePreference | null;
  /**
   * Whether the mission's next launch will prepare a branch at all, resolving
   * `worktreePreference` against `worktreeAutomationEnabled`. `false` means the
   * mission works directly off `baseBranch`.
   */
  willPrepareBranch: boolean;
  /**
   * Whether that branch preparation will create a dedicated worktree (vs. a
   * branch checked out in the primary repo). Only meaningful when
   * `willPrepareBranch` is true.
   */
  willUseWorktree: boolean;
}

/**
 * Available branches in a mission project's primary repository, for the mission
 * panel's branch selector. `current` is the branch the mission is (or will be)
 * operating on. Returned by `GET /api/missions/:id/branches`.
 */
export interface MissionBranchListDto {
  branches: string[];
  current: string | null;
}

// ---- Mission activity feed ----

/**
 * Closed vocabulary for `mission_events.type` (see the schema contract). These
 * are the workflow events surfaced in the mission panel's live activity feed.
 */
export type MissionEventType =
  | 'update'
  | 'user_follow_up'
  | 'alert'
  | 'discussion_summary'
  | 'decision'
  | 'ask'
  | 'permission_request'
  | 'delivery'
  | 'execution_requested'
  | 'awaiting_approval'
  | 'status_change';

/**
 * A single entry in a mission's workflow history (`mission_events`). Append-only;
 * ordered oldest-first by `createdAt`. The SPA renders these as a realtime feed
 * inside the mission panel, refetching whenever the change feed reports activity.
 */
export interface MissionEventDto {
  id: string;
  missionId: string;
  objectiveId: string | null;
  /** Closed vocabulary; unknown future values render with a neutral fallback. */
  type: MissionEventType | string;
  /** Optional workflow phase recorded with the event (`attach`, `execute`, …). */
  phase: string | null;
  summary: string;
  /** Open vocabulary describing what produced the event (`agent`, `cli`, …). */
  source: string;
  /** Optional external link associated with the event. */
  externalUrl: string | null;
  createdAt: string;
}

// ---- Mission file changes ----

/**
 * Diff availability for a changed file, mirroring `changed_files.current_diff_state`.
 * `null` when no `changed_files` row is linked to the rationale.
 */
export type FileChangeDiffState = 'present' | 'resolved' | 'unknown' | 'unavailable' | null;

/**
 * A structured per-file change record (`change_rationales`) surfaced in the
 * mission panel's File Changes section. Each row records what changed in one file
 * along with why the agent made the change and its expected impact. Optionally
 * joined to the `changed_files` row that tracks the file's diff state.
 */
export interface FileChangeDto {
  id: string;
  missionId: string;
  objectiveId: string | null;
  /** Repository-relative path of the changed file. */
  filePath: string;
  /** Basename of `filePath`, for compact display in the card header. */
  fileName: string;
  /** Short headline describing the change. */
  label: string;
  /** Longer description of what changed. */
  summary: string;
  /** Why the change was made. */
  why: string;
  /** Expected impact of the change. */
  impact: string;
  /** Diff availability from the linked `changed_files` row, when present. */
  diffState: FileChangeDiffState;
  /** Version-control status of the file (e.g. `modified`, `added`), when known. */
  vcsStatus: string | null;
  createdAt: string;
}

// ---- Agent catalog and launch configuration ----
//
// Shapes follow connectors/docs/agent-harness-configuration-architecture.md:
// the workspace catalog (workspaces.settings_json.agentCatalog) answers "what
// agents and models are offered"; per-user launch mechanics live on the user's
// user_execution_target_preferences row; project_user_preferences remember the
// last selection; objectives.launch_config_json holds explicit per-objective
// overrides keyed by execution target and agent.

export interface AgentCatalogModelDto {
  id: string;
  displayName: string;
  /** Reasoning/thinking levels selectable for this model (empty = none). */
  reasoningOptions: string[];
}

export interface AgentCatalogAgentDto {
  /** Stable connector key (`claude`, `codex`, `cursor`, …). */
  key: string;
  label: string;
  availableByDefault: boolean;
  models: AgentCatalogModelDto[];
  defaultModel: string | null;
  defaultReasoningEffort: string | null;
  /** Column heading for the reasoning options ("Thinking" vs "Effort"). */
  reasoningLabel: string;
}

export interface AgentCatalogDto {
  agents: AgentCatalogAgentDto[];
  /** Instance defaults from overlord.toml, used when no preference is stored. */
  defaultAgent: string;
  defaultModel: string | null;
}

/** Per-agent launch mechanics: shell pre-command and extra CLI flags. */
export interface AgentLaunchConfigDto {
  preCommand: string;
  flags: string[];
}

export interface TerminalProfileDto {
  /** Built-in launcher (`iTerm2`, `Terminal`) or prefix command; null runs inline. */
  launcher: string | null;
  placement: 'window' | 'tab' | 'chord';
  /** Typed shortcut such as `cmd+d` when placement is `chord`. */
  chord: string | null;
}

export interface LaunchSettingsDto {
  /** The local execution target launches queue against (provisioned on demand). */
  executionTargetId: string;
  deviceLabel: string;
  /** Per-user launch configs keyed by agent key. */
  agentConfigs: Record<string, AgentLaunchConfigDto>;
  /** Per-user terminal profile for this machine's execution target. */
  terminalProfile: TerminalProfileDto;
  /** When true, runner/direct launches prepare a per-mission branch and worktree before spawn. */
  worktreeBranchAutomationEnabled: boolean;
}

export type UpdateTerminalProfileBody = TerminalProfileDto;

export interface UpdateWorktreeBranchAutomationBody {
  enabled: boolean;
}

/** Last agent/model/reasoning the user selected within a project. */
export interface LaunchPreferenceDto {
  selectedAgent: string | null;
  selectedModel: string | null;
  selectedReasoningEffort: string | null;
}

export type ExecutionRequestStatus =
  | 'queued'
  | 'claimed'
  | 'launching'
  | 'launched'
  | 'failed'
  | 'cleared'
  | 'cancelled'
  | 'expired';

export interface ExecutionRequestDto {
  id: string;
  workspaceId: string;
  projectId: string;
  missionId: string;
  objectiveId: string;
  executionTargetId: string | null;
  requestedAgent: string | null;
  requestedModel: string | null;
  requestedReasoningEffort: string | null;
  /** Resolved launch-config snapshot written at queue time. */
  launchConfig: AgentLaunchConfigDto;
  status: ExecutionRequestStatus;
  requestedSource: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Copyable prompt for running an objective through an agent manually. */
export interface ObjectivePromptDto {
  objectiveId: string;
  missionId: string;
  prompt: string;
}

// ---- Realtime feed ----

/**
 * A compact projection of an `entity_changes` row, ordered by the monotonic
 * `seq`. The SPA uses these to invalidate its query cache so the UI reflects
 * database changes — including writes made by the CLI — in real time.
 */
export interface EntityChangeDto {
  seq: number;
  entityType: string;
  entityId: string;
  operation: ChangeOperation;
  projectId: string | null;
  missionId: string | null;
  objectiveId: string | null;
  occurredAt: string;
}

/** Named SSE events emitted by `GET /api/stream`. */
export type RealtimeEvent =
  | { type: 'hello'; cursor: number }
  | { type: 'change'; changes: EntityChangeDto[]; cursor: number }
  | { type: 'refresh' };

// ---- Request bodies ----

export interface CreateProjectBody {
  name: string;
  slug?: string;
  description?: string | null;
  /** Optional 6-digit hex color (e.g. `#fecdd3`). */
  color?: string;
  /** Optional initial primary resource to create with the project. */
  primaryResource?: {
    directoryPath: string;
    executionTargetId?: string | null;
  } | null;
}

/** A per-project tag definition. Authored in project settings, assigned to missions. */
export interface ProjectTagDto {
  id: string;
  projectId: string;
  label: string;
  /** Optional display color (e.g. `#fecdd3`), or `null`. */
  color: string | null;
  /** Inactive tags are hidden from the create-mission picker but kept for history. */
  active: boolean;
}

export interface CreateProjectTagBody {
  label: string;
  color?: string | null;
}

export interface UpdateProjectTagBody {
  label?: string;
  color?: string | null;
  active?: boolean;
}

export interface UpdateProjectBody {
  name?: string;
  description?: string | null;
  status?: ProjectLifecycle;
  /** Optional 6-digit hex color (e.g. `#fecdd3`). */
  color?: string;
  /**
   * Project base/parent branch for mission branches. A non-empty value sets it;
   * `null` or an empty string clears it (falling back to `main`).
   */
  defaultBranch?: string | null;
}

/**
 * Body for `POST /api/missions/:id/branch/action` — on-demand branch mutations
 * the mission panel triggers (returns the refreshed `MissionDetailDto`).
 *
 * - `integrate`   — Action A: merge the parent into the branch inside its worktree
 *                   (conflicts left there for IDE resolution), then advance the
 *                   parent to the branch via a `--no-ff` merge commit.
 * - `commit`      — stage and commit all changes in the branch's worktree
 *                   (`git add -A` then `git commit -m <message>`). Requires a
 *                   non-empty `message`.
 * - `push_parent` — Action B: push the merged parent to `origin`.
 * - `publish`     — push the branch itself to `origin` (created → published).
 *
 * On failure the response carries a typed `code` (e.g. `BRANCH_MERGE_CONFLICT`,
 * `BRANCH_BUSY_EXECUTING`, `BRANCH_DIRTY`, `BRANCH_PUSH_FAILED`,
 * `BRANCH_COMMIT_MESSAGE_REQUIRED`, `BRANCH_NOTHING_TO_COMMIT`,
 * `BRANCH_COMMIT_FAILED`).
 */
export interface BranchActionBody {
  action: 'integrate' | 'commit' | 'push_parent' | 'publish';
  /** Commit message for `action: 'commit'` (required and non-empty). */
  message?: string;
  /** Proceed even if an objective is executing on the branch (re-checked server-side). */
  confirmBusy?: boolean;
}

/**
 * Result of `POST /api/missions/:id/generate-commit-message`: an AI-drafted
 * commit message for the uncommitted changes in the mission branch's worktree.
 * Drafted via the Automations Layer (Gemini) from the worktree diff; the client
 * drops it into the commit-message field for the user to edit before committing.
 *
 * On failure the response carries a typed `code` (e.g. `BRANCH_NOTHING_TO_COMMIT`
 * when the worktree is clean, `COMMIT_MESSAGE_GENERATION_FAILED` when the
 * summarizer is unavailable or returns nothing, plus the shared
 * `BRANCH_NOT_PREPARED` / `BRANCH_NO_PRIMARY` / `BRANCH_NO_WORKTREE` codes).
 */
export interface GenerateCommitMessageResultDto {
  /** The drafted commit message (subject line, optionally followed by a body). */
  message: string;
}

// ---- Worktrees ----

/**
 * A git worktree managed by Overlord under the worktree root (`~/.ovld/worktrees`).
 * Enumerated from each project's primary repository (`git worktree list`) and
 * filtered to those under the root. Returned by `GET /api/worktrees`.
 */
export interface WorktreeDto {
  /** Absolute worktree path (the stable identifier for purge requests). */
  path: string;
  /** Branch checked out in the worktree, or `null` for a detached HEAD. */
  branch: string | null;
  projectId: string;
  projectName: string;
  /** The mission whose `active_branch` matches this worktree's branch, when known. */
  missionId: string | null;
  missionDisplayId: string | null;
  /** Derived branch status (same vocabulary as `MissionBranchDto.status`), when the branch maps to a mission. */
  status: MissionBranchStatus | null;
  /** Whether the branch has landed in the project's base branch (locally or remotely). */
  merged: boolean;
  /** Whether the worktree has uncommitted changes (purging it would lose work). */
  dirty: boolean;
  /** Total size of the worktree directory in bytes (best-effort; `null` if not computed). */
  sizeBytes: number | null;
  /** Last filesystem modification time of the worktree directory (ISO), or `null`. */
  lastModifiedAt: string | null;
}

/** Body for `POST /api/worktrees/remove` — purge a single worktree by path. */
export interface RemoveWorktreeBody {
  path: string;
  /** Remove even if the worktree has uncommitted changes (re-checked server-side). */
  force?: boolean;
}

/**
 * Result of a worktree purge. `removed` lists the paths actually removed;
 * `skipped` lists paths that were left in place with a reason (e.g. dirty).
 */
export interface PurgeWorktreesResultDto {
  removed: string[];
  skipped: Array<{ path: string; reason: string }>;
  worktrees: WorktreeDto[];
}

export interface CreateMissionBody {
  projectId: string;
  /** Optional when `firstObjective` or `objectives` is provided; otherwise required. */
  title?: string;
  priority?: MissionPriority;
  statusId?: string;
  /** Assign the mission to a workspace member (`workspace_users.id`), or `null` to create unassigned. Defaults to the creator when omitted. */
  assignedWorkspaceUserId?: string | null;
  /** Optional first objective instruction; creates objective #1 when present. */
  firstObjective?: string;
  /** Optional ordered objective instructions; creates objective #1 as draft and the rest as future. */
  objectives?: Array<{ objective: string; title?: string | null; autoAdvance?: boolean }>;
  /** Optional `project_tags.id` values to assign to the new mission. Must belong to `projectId`. */
  tagIds?: string[];
}

export interface UpdateMissionBody {
  title?: string;
  priority?: MissionPriority | null;
  /** Move the mission to another workspace project. Status maps by type in the target project. */
  projectId?: string;
  statusId?: string;
  /** Assign the mission to a workspace member (`workspace_users.id`), or `null` to unassign. */
  assignedWorkspaceUserId?: string | null;
  acceptanceCriteria?: string | null;
  availableTools?: string[];
  /**
   * Pin the branch the mission's next launch should use (overriding the planner's
   * default), or `null` to clear the override and return to automatic selection.
   */
  branchOverride?: string | null;
  /**
   * Set this mission's per-mission worktree/branch mode, overriding the workspace
   * automation setting (`'worktree'` or `'branch'`), or `null` to clear it and
   * inherit the workspace setting. See `MissionWorktreePreference`.
   */
  worktreePreference?: MissionWorktreePreference | null;
}

/**
 * Reorders a single board column. `orderedMissionIds` lists every mission that
 * should occupy the `statusId` column, top-to-bottom, after the move. Any
 * mission whose current status differs is moved into this column (its status
 * changes to match). This one call covers both within-column reordering and the
 * destination side of a cross-column drag.
 */
export interface ReorderBoardColumnBody {
  statusId: string;
  orderedMissionIds: string[];
}

/**
 * A mission on the **My Missions** selected-workspace board. Extends `MissionDto`
 * with the cross-project context the aggregate board needs and the operator's
 * personal ordering slot.
 */
export interface MyMissionDto extends MissionDto {
  /** Name of the mission's project (My Missions aggregates across projects). */
  projectName: string;
  /** Optional hex color of the mission's project, for the card accent. */
  projectColor: string | null;
  /**
   * Personal order within this mission's My Missions status column for the active
   * operator. `null` when the operator has not dragged this mission; it then
   * sorts after positioned missions by the default fallback order.
   */
  myPosition: number | null;
}

export interface MyMissionsResponse {
  missions: MyMissionDto[];
}

/**
 * Persist a personal reorder of one My Missions status column. `orderedMissionIds`
 * lists every mission assigned to the operator that should occupy `statusId`,
 * top-to-bottom, after the move — mirroring `ReorderBoardColumnBody`. A
 * within-column reorder writes only `my_mission_positions` and never touches
 * `missions.board_position`. Any listed mission whose current status differs is a
 * real cross-column status change that also updates the mission's `status_id`,
 * `status_type`, and project-board `board_position`, subject to the
 * `(workspace_id, status_id)` composite FK. When that FK (or status resolution)
 * rejects a status the mission's workspace lacks, the endpoint returns a typed
 * `STATUS_UNAVAILABLE_FOR_WORKSPACE` error.
 */
export interface MyMissionReorderRequest {
  statusId: string;
  orderedMissionIds: string[];
}

export interface CreateObjectiveBody {
  missionId: string;
  instructionText: string;
  title?: string | null;
  state?: ObjectiveState;
  autoAdvance?: boolean;
}

/**
 * Reorders the `future` objectives of a single mission. `orderedObjectiveIds`
 * lists every future objective on the mission, top-to-bottom, after the move.
 * Only objectives currently in the `future` state may be reordered; their
 * `position` is renumbered relative to one another while remaining after any
 * non-future objectives. Returns the mission's full objective list in its new
 * order.
 */
export interface ReorderFutureObjectivesBody {
  orderedObjectiveIds: string[];
}

export interface UpdateObjectiveBody {
  instructionText?: string;
  title?: string | null;
  state?: ObjectiveState;
  autoAdvance?: boolean;
  position?: number;
  assignedAgent?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
}

/**
 * Queue an execution request for an objective. The server persists the
 * selection onto the objective, resolves the launch config (objective override
 * → user target config → workspace default → empty), snapshots it into the
 * request, and moves a draft objective to `launching`.
 */
export interface LaunchObjectiveBody {
  agent: string;
  model?: string | null;
  reasoningEffort?: string | null;
  /**
   * Explicit per-objective override stored in `objectives.launch_config_json`
   * keyed by execution target + agent. Omit to inherit per the resolution order.
   */
  launchConfigOverride?: AgentLaunchConfigDto | null;
}

export interface UpdateAgentLaunchConfigBody {
  preCommand?: string;
  flags?: string[];
}

export type UpdateLaunchPreferenceBody = Partial<LaunchPreferenceDto>;

/**
 * The local operator's user-account profile. In this single-trusted-user build
 * the profile maps directly to the operator's `profiles` row. Avatar URL and
 * custom agent instructions are persisted in `profiles.metadata_json`.
 */
export interface ProfileDto {
  userId: string;
  /** `profiles.display_name` — required, non-empty. */
  displayName: string;
  /** `profiles.handle` — the username, mirrored from the Better Auth account (read-only here). */
  handle: string | null;
  email: string | null;
  /** Optional avatar image URL stored in `profiles.metadata_json.avatarUrl`. */
  avatarUrl: string | null;
  /**
   * Optional custom agent instructions appended to every protocol `promptContext`
   * for this user (`profiles.metadata_json.agentInstructions`).
   */
  agentInstructions: string | null;
  /**
   * The operator's preferred IDE/editor, used to open files Overlord links to
   * (`profiles.metadata_json.editorScheme`). One of `EDITOR_SCHEME_OPTIONS`
   * (`webapp/web/lib/helpers/editor-scheme.ts`); `null` defaults to VS Code.
   */
  editorScheme: string | null;
  /** Open vocabulary (`human`, `service`). The local operator is `human`. */
  kind: string;
  /** Identity provider, when the account is externally federated. */
  authProvider: string | null;
  /** RBAC role keys assigned in the active workspace (`ADMIN`, `MEMBER`, …). */
  roles: string[];
  createdAt: string;
}

/** Partial update of the local operator's profile. Omitted fields are left unchanged. */
export interface UpdateProfileBody {
  displayName?: string;
  // `handle` is intentionally omitted: the profile username mirrors the Better
  // Auth account username and is changed through the Auth surface, not here.
  email?: string | null;
  avatarUrl?: string | null;
  /** Replaces the user's saved custom agent instructions; pass null or "" to clear. */
  agentInstructions?: string | null;
  /** Replaces the user's preferred IDE/editor scheme; pass null or "" to clear (defaults to VS Code). */
  editorScheme?: string | null;
}

// ---- Uploads (core upload service) ----

/**
 * A stored image returned by the core upload service. Bytes live in the storage
 * backend behind the bucket; this descriptor carries the metadata plus the
 * server-relative `url` the SPA loads. Used today by the avatar uploader against
 * the `user-images` bucket and reusable by other image components.
 */
export interface StoredImageDto {
  /** `user_images.id` of the recorded object. */
  id: string;
  /** Logical bucket the image was stored in (e.g. `user-images`). */
  bucketKey: string;
  /** Backend key/path within the bucket. */
  storageKey: string;
  /** Original/display filename. */
  filename: string;
  /** Image media type (e.g. `image/png`). */
  contentType: string;
  sizeBytes: number;
  /** Server-relative URL that serves the bytes (`/api/storage/<bucket>/<key>`). */
  url: string;
  createdAt: string;
}

/**
 * Lifecycle of a stored object's bytes (`attachments.upload_status` /
 * `objective_attachments.upload_status`). Local uploads land as `available`.
 */
export type AttachmentUploadStatus = 'prepared' | 'uploaded' | 'available' | 'failed' | 'deleted';

/**
 * A file attached to an objective, stored in the `attachments` bucket. Bytes
 * live behind the bucket; this descriptor carries metadata plus the
 * server-relative `url` the SPA loads (which serves the bytes as a download).
 * Derived from the `attachments` table, scoped to a single objective.
 */
export interface ObjectiveAttachmentDto {
  /** `attachments.id` of the recorded object. */
  id: string;
  workspaceId: string;
  projectId: string | null;
  missionId: string | null;
  objectiveId: string | null;
  /** Logical bucket the file was stored in (e.g. `attachments`). */
  bucketKey: string;
  /** Backend key/path within the bucket. */
  storageKey: string;
  /** Original/display filename. */
  filename: string;
  /** Media type when known (e.g. `application/pdf`); `null` if undetermined. */
  contentType: string | null;
  sizeBytes: number | null;
  uploadStatus: AttachmentUploadStatus;
  /** Server-relative URL that serves the bytes (`/api/storage/<bucket>/<key>`). */
  url: string;
  createdAt: string;
}

/** Lifecycle state of a `USER_TOKEN` (`user_tokens.status`). */
export type UserTokenStatus = 'active' | 'revoked' | 'expired' | 'rotated';

/**
 * Permission scope preset a `USER_TOKEN` is minted with.
 *  - `full`: no token-level restriction — inherits the creating user's role grants.
 *  - `mission_lifecycle`: mission/objective/session/runner work only (see `scopeGrants`).
 *
 * A token's effective permissions are always its creating user's role grants
 * intersected with its scope grants, so a scope can only restrict, never widen.
 */
export type TokenScope = 'full' | 'mission_lifecycle';

/**
 * A `USER_TOKEN` as surfaced to the settings UI. Derived from the `user_tokens`
 * row owned by the local operator; the raw secret and its hash are never
 * included — only the non-secret display prefix.
 */
export interface UserTokenDto {
  id: string;
  /** User-supplied label, e.g. "macbook runner". */
  label: string;
  /** Non-secret lookup/display prefix, e.g. `out_ab12cd34`. */
  tokenPrefix: string;
  status: UserTokenStatus;
  /** Permission scope preset; `full` unless the token was minted scoped. */
  scope: TokenScope;
  /** Resolved scope grant patterns; empty for a `full` token. */
  scopeGrants: string[];
  /** Optional expiry; `null` means the token never expires. */
  expiresAt: string | null;
  /** Last time the token successfully authenticated, when recorded. */
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** Create a new `USER_TOKEN` for the local operator. */
export interface CreateUserTokenBody {
  label: string;
  /**
   * Optional ISO-8601 expiry. Omitting the field defaults to a 90-day expiry;
   * an explicit `null` opts out and mints a non-expiring token.
   */
  expiresAt?: string | null;
  /** Permission scope preset; defaults to `full` when omitted. */
  scope?: TokenScope;
}

/**
 * The result of creating a token. The raw `secret` is returned exactly once and
 * is never persisted (only its hash is stored) or retrievable again afterwards.
 */
export interface CreateUserTokenResultDto {
  token: UserTokenDto;
  secret: string;
}

/** Rename a token without rotating its secret. */
export interface UpdateUserTokenBody {
  label: string;
}

export interface ApiError {
  error: string;
  detail?: string;
}
