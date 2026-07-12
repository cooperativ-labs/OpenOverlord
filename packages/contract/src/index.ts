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

// ---- Organization DTOs ----
//
// An organization is the grouping + identity layer above workspaces
// (organization → workspace → project). Workspaces remain the sole RBAC layer;
// an "organization admin" is a derived concept (ADMIN of every constituent
// workspace), not a new RBAC scope type.

export interface OrganizationDto {
  id: string;
  name: string;
  /** URL of the organization's logo image, or `null` when unset. */
  logoUrl: string | null;
  /** Count of non-deleted workspaces in the organization (read-side aggregate). */
  workspaceCount: number;
  /** Whether this is the caller's currently active organization. */
  isActive?: boolean;
  createdAt: string;
}

/**
 * Combined organization + first-workspace onboarding, submitted by an
 * authenticated user with zero workspace memberships. No logo field: the
 * organization's storage bucket doesn't exist until the organization does, so
 * the logo is uploaded after creation and patched on via `UpdateOrganizationBody`.
 * Shared verbatim by the web onboarding screen and `ovld org-setup`.
 */
export interface CreateOrganizationOnboardingBody {
  organizationName: string;
  /** Defaults to `"general"` when omitted. */
  workspaceName?: string;
  /** Optional; derived from `workspaceName` (and uniquified within the new organization) when omitted. */
  workspaceSlug?: string;
}

/** Partial update of an organization. Omitted fields are left unchanged. */
export interface UpdateOrganizationBody {
  name?: string;
  /**
   * Org-admin-only: set or clear (`null`) the organization logo. Must be an
   * uploaded image path from the `organization-images` bucket
   * (`/api/storage/organization-images/…`) or an absolute http(s) URL.
   */
  logoUrl?: string | null;
}

/** An organization admin: a member with an active `ADMIN` role assignment in every constituent workspace. */
export interface OrganizationAdminDto {
  /** `profiles.id`. */
  userId: string;
  displayName: string;
  handle: string | null;
  email: string | null;
  avatarUrl: string | null;
}

/** Grants `ADMIN` to `userId` in every constituent workspace of the organization. */
export interface AddOrganizationAdminBody {
  /** `profiles.id` of an existing member of at least one constituent workspace. */
  userId: string;
}

/** Demotes `userId` to `MEMBER` in every constituent workspace of the organization. */
export interface RemoveOrganizationAdminBody {
  userId: string;
}

// ---- Resource DTOs ----

export interface WorkspaceDto {
  id: string;
  /** FK to the containing organization. */
  organizationId: string;
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
  /** The containing organization. Creation is org-admin gated. */
  organizationId: string;
  name: string;
  /** Optional slug; derived from the name (and uniquified within the organization) when omitted. */
  slug?: string;
}

/** Partial update of a workspace. Omitted fields are left unchanged. */
export interface UpdateWorkspaceBody {
  name?: string;
  /** Admin-only: enable or disable SQL Studio for this workspace. */
  sqlStudioEnabled?: boolean;
}

/**
 * `GET /api/meta` response shape. Workspaces no longer have a single "active"
 * one from the UI's perspective — the sidebar renders every accessible
 * workspace of the active organization at once (Q6/Q9) — but the server still
 * tracks a default/preference-scoped workspace for protocol and CLI callers
 * that need one implicit scope.
 */
export interface MetaDto {
  /** The caller's active organization, or `null` before onboarding. */
  organization: OrganizationDto | null;
  /** Every organization the caller has at least one active workspace membership in. */
  organizations: OrganizationDto[];
  /** Every workspace of the active organization the caller can access, with project counts. */
  workspaces: WorkspaceDto[];
  /** The server's default-scope workspace (preference echo for protocol/CLI); `null` pre-onboarding. */
  workspace: WorkspaceDto | null;
}

/**
 * A workspace membership (`workspace_users` joined to `profiles`).
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
  /** Active workspace-level role keys assigned to this member (`ADMIN`, `MANAGER`, `MEMBER`, …). */
  roleKeys: string[];
  /** Whether one of the active role assignments is `ADMIN`. */
  isAdmin: boolean;
  /** Whether this membership belongs to the local operator. */
  isOperator: boolean;
  /** `workspace_users.created_at`. */
  joinedAt: string;
  /** Optional avatar image URL from `profiles.metadata_json.avatarUrl`. */
  avatarUrl: string | null;
}

export type WorkspaceInvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

/** A pending or resolved invitation for someone to join a workspace. */
export interface WorkspaceInvitationDto {
  id: string;
  workspaceId: string;
  email: string;
  /** Role the invitee is granted on acceptance (default `MEMBER`). */
  roleKey: string;
  status: WorkspaceInvitationStatus;
  /** Display prefix of the invitation token (never the raw secret). */
  tokenPrefix: string;
  expiresAt: string;
  createdAt: string;
}

export interface InviteWorkspaceMemberBody {
  email: string;
  /**
   * Defaults to `MEMBER` when omitted. Free-form wire type, but a `MANAGER`
   * actor is server-capped to inviting at most `MANAGER` — it may never grant
   * `ADMIN`.
   */
  roleKey?: string;
}

/**
 * Result of a successful invite. `acceptUrl` is only present when no email
 * provider is configured (`RESEND_API_KEY` unset — the local/self-hosted
 * default): the admin must share the link manually since no invite email was
 * sent. When an email was sent, `acceptUrl` is omitted — the raw token never
 * otherwise leaves the server.
 */
export interface InviteWorkspaceMemberResultDto {
  invitation: WorkspaceInvitationDto;
  acceptUrl?: string;
}

export interface AcceptWorkspaceInvitationBody {
  /** The raw invitation token from the emailed accept link. */
  token: string;
}

/**
 * A `MANAGER` actor is server-capped to targets/roles at or below `MANAGER`: it
 * may neither grant `ADMIN` nor demote/remove an existing `ADMIN`.
 */
export interface UpdateWorkspaceMemberRoleBody {
  roleKey: 'ADMIN' | 'MANAGER' | 'MEMBER';
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
  /**
   * 1-based sidebar ordering, unique within the workspace. Renumbered
   * densely (1, 2, 3, …) whenever the workspace's projects are reordered.
   */
  position: number;
}

/**
 * Reorders every non-deleted project in the workspace (active and archived
 * alike, so archived projects keep a stable position if reactivated).
 * `orderedProjectIds` lists project ids top-to-bottom after the move and
 * must include every non-deleted project exactly once.
 */
export interface ReorderProjectsBody {
  orderedProjectIds: string[];
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

export type ProjectResourceType = 'local_directory' | 'remote_directory' | 'git' | 'source_bundle';
export type ProjectResourceStatus = 'active' | 'missing' | 'archived';

/** A target-specific (or global) way to materialize a logical project resource. */
export interface ProjectResourceSourceDto {
  id: string;
  executionTargetId: string | null;
  sourceKind: string;
  descriptor: Record<string, unknown>;
  observedRevision: string | null;
  observedContentDigest: string | null;
}

export interface CreateProjectResourceBody {
  directoryPath: string;
  resourceKey?: string | null;
  label?: string | null;
  isPrimary?: boolean;
  executionTargetId?: string | null;
}

export interface UpdateProjectResourceBody {
  resourceKey?: string | null;
  isPrimary?: boolean;
}

export interface ProjectResourceDto {
  id: string;
  workspaceId: string;
  projectId: string;
  executionTargetId: string | null;
  resourceKey: string;
  type: ProjectResourceType;
  label: string | null;
  path: string;
  isPrimary: boolean;
  status: ProjectResourceStatus;
  /** When the linked target last reported availability for this resource. */
  observedAt?: string | null;
  /** Present when `observedAt` came from a client writeback. */
  observationSource?: 'client' | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
  /** All materialization descriptors for this logical resource. */
  sources: ProjectResourceSourceDto[];
}

export type TargetObservationState =
  | 'available'
  | 'missing'
  | 'unreachable'
  | 'permission_denied'
  | 'not_git_repository'
  | 'unknown';

export interface TargetResourceObservationInput {
  resourceId: string;
  state: TargetObservationState;
  gitRoot?: string | null;
  branch?: string | null;
  commit?: string | null;
  observedAt: string;
}

export interface RecordTargetResourceObservationsBody {
  observations: TargetResourceObservationInput[];
}

export interface RecordTargetResourceObservationsResult {
  recorded: number;
}

export interface MissionBranchObservationInput {
  missionId: string;
  resourceKey: string;
  status: Exclude<MissionBranchStatus, 'pending'>;
  dirty: boolean;
  worktreePath?: string | null;
  observedAt: string;
}

export interface RecordMissionBranchObservationsBody {
  observations: MissionBranchObservationInput[];
}

export type RecordMissionBranchObservationsResult = RecordTargetResourceObservationsResult;

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
  /** `schedules.id` this mission repeats on, or `null` when unscheduled. */
  scheduleId: string | null;
  /** Computed next due date/time (ISO-8601), or `null` when unscheduled. */
  dueDatetime: string | null;
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
  /**
   * `objectives.resource_key` on the mission's current `draft` objective, or
   * `null` when the draft inherits the project primary resource.
   */
  draftObjectiveResourceKey: string | null;
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
  /** Logical project resource this objective runs in; null inherits the primary. */
  resourceKey: string | null;
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

// ---- Mission scheduling ----------------------------------------------------
//
// A `schedules` row is a repeating recurrence rule computed by the
// SchedulingEngine (`@overlord/automations`). A mission with a `scheduleId`
// carries a computed `dueDatetime`; when the mission reaches a `complete`-type
// status, the server spawns a duplicate mission with the next occurrence (see
// `planning/feature-plans/mission-scheduling-engine.md`).

export type SchedulePeriodType = 'd' | 'w' | 'm';

export interface ScheduleWeekDayDto {
  /** 0 (Sunday) through 6 (Saturday). */
  dayNum: number;
  /** `HH:mm` or `HH:mm:ss`, local to `timezone`. */
  times: string[];
}

export interface ScheduleDto {
  id: string;
  workspaceId: string;
  name: string | null;
  periodType: SchedulePeriodType;
  /** Recur every N periods (days/weeks/months), N >= 1. */
  periodInterval: number;
  /** Monthly-by-week rule: 1-5 (used with `daysOfWeek`). */
  weeksOfMonth: number[];
  /** Monthly-by-day rule: 1-31, or 32 meaning "last day of month". */
  daysOfMonth: number[];
  daysOfWeek: ScheduleWeekDayDto[];
  /** IANA timezone (e.g. `America/Los_Angeles`); defaults from the browser at creation. */
  timezone: string;
  /** Optional recurrence anchor (ISO-8601); becomes the primary anchor when set. */
  startDate: string | null;
  /**
   * Workspace status the duplicate mission lands in on regeneration. `null`
   * falls back to the workspace default/next-up status.
   */
  nextStatusId: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** Request body for creating/updating a mission's schedule; mirrors `ScheduleDto` minus server-assigned fields. */
export interface ScheduleInput {
  name?: string | null;
  periodType: SchedulePeriodType;
  periodInterval: number;
  weeksOfMonth?: number[];
  daysOfMonth?: number[];
  daysOfWeek?: ScheduleWeekDayDto[];
  timezone: string;
  startDate?: string | null;
  nextStatusId?: string | null;
}

/** `GET /api/missions/:id/schedule` and the `upsert`/`preview` response shape. */
export interface MissionScheduleDto {
  dueDatetime: string | null;
  schedule: ScheduleDto | null;
}

/** `POST /api/missions/schedule/preview` request body. */
export interface PreviewScheduleBody {
  schedule: ScheduleInput;
  /** Current due date to use as the recurrence anchor, when previewing a re-schedule. */
  itemDueDatetime?: string | null;
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
   * Whether the local branch tip is ahead of `origin/<name>`. Populated when git
   * state is observed through the desktop bridge; used to offer re-publish after
   * further commits land on an already-published branch.
   */
  hasUnpushedCommits?: boolean;
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
  /**
   * When the branch metadata was last observed from a local execution target.
   * Populated by the web client when git state is read through the desktop bridge.
   */
  observedAt?: string | null;
  /** Whether `observedAt` came from the desktop bridge (`client`) or the REST server (`server`). */
  observationSource?: 'client' | 'server' | null;
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

export interface MissionEventActorDto {
  workspaceUserId: string;
  displayName: string;
  handle: string | null;
  avatarUrl: string | null;
}

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
  actorWorkspaceUserId: string | null;
  actor: MissionEventActorDto | null;
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

/** Replace the workspace agent catalog stored in `workspaces.settings_json.agentCatalog`. */
export interface UpdateAgentCatalogBody {
  agents: AgentCatalogAgentDto[];
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

/** A project execution target the acting user may select for queue-here/run-there (WS-C). */
export interface EligibleExecutionTargetDto {
  executionTargetId: string;
  type: string;
  label: string;
  deviceLabel: string | null;
  reachable: boolean;
  primaryResourceConnected: boolean;
}

/** Per-project execution target selection for the acting workspace user. */
export interface ProjectExecutionTargetDto {
  selectedExecutionTargetId: string | null;
  eligibleTargets: EligibleExecutionTargetDto[];
}

export interface UpdateProjectExecutionTargetBody {
  executionTargetId: string | null;
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

export type LocalTargetMutationKindDto = 'branch_action' | 'worktree_purge';

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
  /** Present when `requestedSource` is `local_target_mutation`. */
  localTargetMutationKind?: LocalTargetMutationKindDto | null;
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
 * `changedFields` comes from `entity_changes.changed_fields_json`; malformed
 * stored values project as an empty array.
 */
export interface EntityChangeDto {
  seq: number;
  entityType: string;
  entityId: string;
  operation: ChangeOperation;
  projectId: string | null;
  missionId: string | null;
  objectiveId: string | null;
  changedFields: string[];
  occurredAt: string;
}

/** Response from `GET /sync/changes?after=<seq>` for reconnect catch-up. */
export interface SyncChangesDto {
  changes: EntityChangeDto[];
  cursor: number;
  hasMore: boolean;
}

/** Named SSE events emitted by `GET /realtime` and compatibility `GET /api/stream`. */
export type RealtimeEvent =
  | { type: 'hello'; cursor: number }
  | { type: 'change'; changes: EntityChangeDto[]; cursor: number }
  | { type: 'refresh' };

// ---- Request bodies ----

export interface CreateProjectBody {
  name: string;
  /** Optional target workspace. Defaults to the caller's active workspace. */
  workspaceId?: string;
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
 * - `publish`     — push the branch itself to `origin` (created → published, or
 *                   re-push when further commits are ahead of the remote).
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
  /** Logical project resource key to target; defaults to the project primary. */
  resourceKey?: string;
  /** Proceed even if an objective is executing on the branch (re-checked server-side). */
  confirmBusy?: boolean;
  /** When true, git already ran on the client; the server records `summary` only. */
  clientExecuted?: boolean;
  /** Activity summary to record when `clientExecuted` is true. */
  summary?: string;
}

/** Optional body for `POST /api/missions/:id/generate-commit-message`. */
export interface GenerateCommitMessageBody {
  /** Pre-gathered diff text from the client local-target bridge. */
  diff?: string;
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
  /** Absolute primary repository path — required when `clientExecuted` is true on hosted backends. */
  primaryRepoPath?: string;
  /** When true, git removal already ran on the client; the server refreshes its response only. */
  clientExecuted?: boolean;
  /** Project that owns the worktree — required to queue removal on a remote execution target. */
  projectId?: string;
  /** Optional explicit execution target when queueing on a remote device. */
  executionTargetId?: string | null;
}

/** Optional body for `POST /api/worktrees/purge` when queueing on a remote target. */
export interface PurgeMergedWorktreesBody {
  projectId?: string;
  executionTargetId?: string | null;
  primaryRepoPath?: string;
  worktreeRoot?: string;
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
  objectives?: Array<{
    objective: string;
    title?: string | null;
    autoAdvance?: boolean;
    resourceKey?: string | null;
  }>;
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
  /**
   * Clear `missions.active_branch` so the mission panel returns to a pending
   * branch preview. Used when switching to a different branch after the
   * previous one has merged. Clears stored branch observations for the mission.
   */
  resetActiveBranch?: boolean;
  /**
   * Replace the mission's assigned tags with this set of `project_tags.id` values.
   * Every id must belong to the mission's project. Pass `[]` to clear all tags.
   */
  tagIds?: string[];
  /**
   * Override the computed next due date (ISO-8601) without changing the linked
   * schedule, or `null` to clear the due date.
   */
  dueDatetime?: string | null;
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
  resourceKey?: string | null;
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
  resourceKey?: string | null;
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
  /** `profiles.handle` — an optional display handle, mirrored from the Better Auth account name (read-only here). */
  handle: string | null;
  /**
   * `profiles.email` — the account's primary identifier, mirrored from the
   * Better Auth account email (read-only here; changed through the Auth
   * surface).
   */
  email: string | null;
  /** Optional avatar image URL stored in `profiles.metadata_json.avatarUrl`. */
  avatarUrl: string | null;
  /**
   * Optional custom agent instructions appended to every protocol `agentInstructions`
   * field for this user (`profiles.metadata_json.agentInstructions`).
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
  // `handle` and `email` are intentionally omitted: both mirror the Better
  // Auth account (name and email respectively) and are changed through the
  // Auth surface, not here. `email` is the account's primary identifier.
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

// ---- Webhooks (coo:115) ----------------------------------------------------

export type WebhookPayloadMode = 'thin' | 'full';
export type WebhookDisabledReason = 'manual' | 'failures' | 'owner_revoked';

/**
 * Namespaced, versioned webhook event vocabulary (open, distinct from the
 * closed `mission_events.type` enum) -- see database schema contract ->
 * Controlled Vocabularies -> "Webhook event catalog".
 */
export type WebhookEventType =
  | 'mission.delivered'
  | 'mission.status_changed'
  | 'objective.completed'
  | 'mission.blocked';

export interface WebhookSubscriptionDto {
  id: string;
  projectId: string | null;
  name: string;
  endpointUrl: string;
  /** Whether `endpointUrl`'s host matches the operator's `OVERLORD_WEBHOOK_INTERNAL_HOSTS` allowlist (or is implicit localhost in Local edition). */
  isInternal: boolean;
  eventTypes: WebhookEventType[];
  payloadMode: WebhookPayloadMode;
  enabled: boolean;
  disabledReason: WebhookDisabledReason | null;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  createdByWorkspaceUserId: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface CreateWebhookSubscriptionBody {
  name: string;
  endpointUrl: string;
  projectId?: string | null;
  eventTypes: WebhookEventType[];
  /** Defaults to `full` for internal endpoints, `thin` for external ones, when omitted. */
  payloadMode?: WebhookPayloadMode;
}

export interface UpdateWebhookSubscriptionBody {
  name?: string;
  endpointUrl?: string;
  projectId?: string | null;
  eventTypes?: WebhookEventType[];
  payloadMode?: WebhookPayloadMode;
  enabled?: boolean;
}

/** The raw secret (`whsec_...`) is returned exactly once, on creation, and is never retrievable again afterwards. */
export interface CreateWebhookSubscriptionResultDto {
  subscription: WebhookSubscriptionDto;
  secret: string;
}

/** Returned by rotate-secret; the previous secret stops verifying immediately. */
export interface RotateWebhookSecretResultDto {
  subscription: WebhookSubscriptionDto;
  secret: string;
}

export interface WebhookDeliveryAttemptDto {
  id: string;
  outboxMessageId: string;
  eventType: string;
  attemptNumber: number;
  responseStatus: number | null;
  responseSnippet: string | null;
  error: string | null;
  durationMs: number | null;
  attemptedAt: string;
}

export interface WebhookDeliveryAttemptsPageDto {
  attempts: WebhookDeliveryAttemptDto[];
  hasMore: boolean;
}

// ---- Virtual execution targets (coo:258, contract v3) ----------------------
//
// Provider-neutral virtual execution targets: a selectable Overlord target that
// a gateway (Racecar first) realizes only after it claims an existing execution
// request over the documented `/api/virtual-targets/v1/*` REST surface. These
// DTOs are the stable, versioned contract shared by the REST server, the SPA,
// and — vendored as a public subset — an external `rest-consumer` gateway. See
// the Virtual Target Queue Surface in CONTRACT.md and the Virtual Execution
// Targets section of the schema contract.
//
// Invariants encoded here: the queue payload is immutable and returned only to
// the authenticated claiming gateway; it carries opaque handles and grant
// *references*, never filesystem paths or raw secrets; preparation is
// append-only observation data, never a new `execution_requests.status`.

/**
 * Documented core `execution_targets.type` values. Open vocabulary — adapters
 * may add namespaced values, so a `string` is always accepted on the wire.
 */
export type ExecutionTargetType = 'local' | 'ssh' | 'virtual' | (string & {});

/** Gateway health as reported through registration/heartbeat. */
export type VirtualTargetHealth = 'healthy' | 'degraded' | 'unreachable' | 'unknown';

/** Source input kinds a gateway can materialize. Open (namespaced) beyond these. */
export type VirtualSourceKind = 'git' | 'local_checkout' | 'source_bundle' | (string & {});

/** Append-only observation kinds recorded under a request. */
export type VirtualObservationKind =
  | 'progress'
  | 'launch'
  | 'failure'
  | 'lifecycle_resource'
  | (string & {});

/** Opaque grant kinds. Values are references/scopes only — never bearer secrets. */
export type VirtualGrantKind =
  | 'launch'
  | 'attachment'
  | 'download'
  | 'credential_reference'
  | (string & {});

/** Per-resource source-compatibility result surfaced to UI/agent context. */
export type VirtualSourceCompatibility = 'compatible' | 'degraded' | 'incompatible';

/** Phase a typed failure occurred in. */
export type VirtualFailurePhase = 'claim' | 'source' | 'environment' | 'launch' | (string & {});

/** Delegated lifecycle actions a UI may request against a virtual target. */
export type VirtualTargetActionKind =
  | 'start'
  | 'stop'
  | 'archive'
  | 'delete'
  | 'enqueue'
  | 'retry'
  | 'dequeue';

/** Advertised gateway/target capabilities (non-secret). */
export interface VirtualTargetCapabilitiesDto {
  /** Whether the target can consume an opaque `local_checkout` source. */
  localCheckoutSource: boolean;
  /** Whether the target can fetch an uploaded `source_bundle`. */
  sourceBundleSource: boolean;
  /** Whether the target can proxy a browser terminal (later, separately authorized). */
  browserTerminal: boolean;
  /** Additional namespaced capability hints. */
  [capability: string]: boolean | undefined;
}

/**
 * Body for `PUT /api/virtual-targets/v1/registration`. Registers or refreshes
 * exactly one selected virtual target and serves as its heartbeat. Secrets are
 * never included; gateway credentials are configured out of band.
 */
export interface VirtualTargetRegistrationBody {
  executionTargetId: string;
  /** Namespaced adapter key (e.g. `racecar`); identifies the gateway, not a target type. */
  gatewayKey: string;
  /** Stable per-installation gateway identity; a match replaces (not duplicates) the registration. */
  gatewayInstanceId: string;
  gatewayVersion?: string | null;
  capabilities: VirtualTargetCapabilitiesDto;
  /** Agent identifiers this gateway can launch. */
  supportedAgents: string[];
  /** Queue schema versions the gateway understands (e.g. `["v1"]`). */
  supportedQueueVersions: string[];
  /** Non-secret gateway configuration echoed back to operators. */
  connection?: Record<string, unknown>;
}

/** Read model of a registered virtual target (no secrets). */
export interface VirtualTargetRegistrationDto {
  executionTargetId: string;
  gatewayKey: string;
  gatewayInstanceId: string;
  gatewayVersion: string | null;
  capabilities: VirtualTargetCapabilitiesDto;
  supportedAgents: string[];
  supportedQueueVersions: string[];
  health: VirtualTargetHealth;
  lastHeartbeatAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A typed source descriptor inside a queue item. Carries a credential-reference
 * ID and/or opaque target-relative handle — never a raw token or a
 * server-readable filesystem path.
 */
export interface VirtualSourceDescriptorV1 {
  kind: VirtualSourceKind;
  /** `git`: repository URL the gateway clones (credential resolved via `credentialRef`). */
  url?: string;
  /** `git`: branch/ref to materialize. */
  ref?: string;
  /** `git`: exact commit to check out, when pinned. */
  commit?: string;
  /** Reference ID for a credential the gateway exchanges via a grant; never the secret itself. */
  credentialRef?: string | null;
  /** `local_checkout`: opaque, target-relative handle. Never a readable path. */
  targetRelativeRef?: string | null;
  /** `source_bundle`: opaque download handle exchanged via a grant. */
  bundleRef?: string | null;
  /** Observed content digest for drift detection, when known. */
  observedContentDigest?: string | null;
}

/** A project resource as carried in the immutable queue item. */
export interface VirtualProjectResourceV1 {
  resourceId: string;
  resourceKey: string;
  label: string | null;
  source: VirtualSourceDescriptorV1;
  /** True only for the single active resource that seeds the initial working directory. */
  active: boolean;
}

/** A required source input that must be satisfiable or launch is blocked. */
export interface VirtualSourceRequirementV1 {
  resourceKey: string;
  kind: VirtualSourceKind;
  /** Human-safe description of why this source is required. */
  reason: string;
}

/** A non-blocking informational reference preserved for agent context. */
export interface VirtualInformationalReferenceV1 {
  resourceKey: string;
  compatibility: VirtualSourceCompatibility;
  /** Bounded, redacted excerpt preserved for agent context. */
  excerpt: string | null;
}

/** The immutable desired environment referenced by a queue item. */
export interface VirtualEnvironmentV1 {
  definitionId: string;
  version: number;
  /** Stable fingerprint across lockfiles/resources. */
  fingerprint: string;
  /** SHA-256 over the canonical environment definition. */
  digest: string;
}

/** An opaque, request-scoped grant reference handed to the claiming gateway. */
export interface VirtualGrantReferenceV1 {
  grantId: string;
  kind: VirtualGrantKind;
  expiresAt: string;
}

/**
 * `VirtualExecutionQueueItemV1` — the exact versioned, immutable payload returned
 * only to the authenticated claiming gateway. Its canonical JSON and SHA-256
 * digest are persisted when the request is queued and never rebuilt from mutable
 * rows at retry time.
 */
export interface VirtualExecutionQueueItemV1 {
  schemaVersion: 'v1';
  executionRequestId: string;
  executionTargetId: string;
  workspaceId: string;
  projectId: string;
  missionId: string;
  objectiveId: string;
  /** Immutable desired environment for this request. */
  environment: VirtualEnvironmentV1;
  /** Every project resource; exactly one is `active`. */
  resources: VirtualProjectResourceV1[];
  /** Resource key of the single active resource (initial directory). */
  activeResourceKey: string;
  /** Required source inputs that block launch when unsatisfiable. */
  sourceRequirements: VirtualSourceRequirementV1[];
  /** Non-blocking informational references preserved for agent context. */
  informationalReferences: VirtualInformationalReferenceV1[];
  /** Agent + model + reasoning to launch. */
  agent: string;
  model: string | null;
  reasoningEffort: string | null;
  /** Resolved launch-config snapshot (flags/pre-command). */
  launchConfig: AgentLaunchConfigDto;
  /** Only request-scoped grant *references*; no bearer values. */
  grants: VirtualGrantReferenceV1[];
  /** SHA-256 of this payload's canonical JSON; echoed at `launched` for verification. */
  payloadDigest: string;
}

/** Body for `POST /api/virtual-targets/v1/claim`. */
export interface VirtualTargetClaimBody {
  executionTargetId: string;
  gatewayInstanceId: string;
}

/**
 * Response to a successful claim. Replaying the same gateway+request returns the
 * same `claimId` and `queueItem`.
 */
export interface VirtualTargetClaimResponseDto {
  claimId: string;
  expiresAt: string;
  queueItem: VirtualExecutionQueueItemV1;
}

/**
 * Body for `POST /api/virtual-targets/v1/requests/:id/progress`. Bounded and
 * monotonic; does not transition status. `sequence` makes it idempotent.
 */
export interface VirtualTargetProgressObservationBody {
  claimId: string;
  sequence: number;
  /** Short preparation stage identifier (e.g. `cloning`, `building`). */
  stage: string;
  /** Bounded, redacted human-safe message. */
  message?: string | null;
  /** Optional 0–100 progress hint. */
  percent?: number | null;
  observedAt: string;
}

/**
 * Body for `POST /api/virtual-targets/v1/requests/:id/launched`. Records the
 * launch observation and drives the `launching → launched` transition exactly
 * once. `payloadDigest` must match the claimed snapshot.
 */
export interface VirtualTargetLaunchObservationV1 {
  claimId: string;
  sequence: number;
  /** Must equal the claimed `VirtualExecutionQueueItemV1.payloadDigest`. */
  payloadDigest: string;
  /** Opaque external run/environment identifiers the gateway realized. */
  externalRunId?: string | null;
  externalEnvironmentId?: string | null;
  observedAt: string;
}

/**
 * Body for `POST /api/virtual-targets/v1/requests/:id/failed`. Typed and
 * redacted; `retryable` informs retry policy but does not itself requeue.
 */
export interface VirtualTargetFailureV1 {
  claimId: string;
  sequence: number;
  /** Typed failure code (open vocabulary, e.g. `source_incompatible`). */
  failureCode: string;
  failurePhase: VirtualFailurePhase;
  retryable: boolean;
  /** Bounded, redacted human-safe summary. */
  message?: string | null;
  observedAt: string;
}

/** Body for `POST /api/virtual-targets/v1/grants/:id/exchange`. */
export interface VirtualGrantExchangeBody {
  claimId: string;
  gatewayInstanceId: string;
}

/**
 * Result of a grant exchange. Returns narrowly scoped, short-lived material
 * bound to the request/target/gateway — never the user's Overlord token.
 */
export interface VirtualGrantExchangeResultDto {
  grantId: string;
  kind: VirtualGrantKind;
  expiresAt: string;
  /** For `download`/`attachment` grants: a scoped, expiring URL. */
  downloadUrl?: string | null;
  /** For `credential_reference` grants: scoped, short-lived credential material. */
  credential?: Record<string, unknown> | null;
}

/**
 * Summarized external lifecycle resource (`mission_target_resources`) surfaced to
 * mission views. References opaque external IDs only.
 */
export interface MissionTargetResourceDto {
  id: string;
  missionId: string;
  executionTargetId: string;
  /** Adapter resource kind (`car`, `environment`, `run`, …). */
  kind: string;
  /** Opaque external identifier; never a path or secret. */
  externalId: string;
  /** Summarized, bounded adapter state. */
  state: string;
  /** Latest summarized observation for the mission view. */
  latestObservation: unknown | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * `GET /api/virtual-targets/v1/missions/:id/resources` response: reusable
 * car/environment/run summaries plus per-resource source-compatibility.
 */
export interface VirtualTargetMissionResourcesDto {
  resources: MissionTargetResourceDto[];
  sourceCompatibility: VirtualInformationalReferenceV1[];
}

/**
 * Body for `POST /api/virtual-targets/v1/missions/:id/actions`. Authorizes a
 * single delegated lifecycle action; destructive kinds require `confirm`.
 */
export interface VirtualTargetActionBody {
  executionTargetId: string;
  action: VirtualTargetActionKind;
  /** Target the action at a specific external resource, when applicable. */
  externalResourceId?: string | null;
  /** Required acknowledgement for destructive actions (`delete`, `archive`). */
  confirm?: boolean;
}

/**
 * Result of a delegated action. The action's outcome is recorded as an
 * observation; it can never change mission completion.
 */
export interface VirtualTargetActionResultDto {
  action: VirtualTargetActionKind;
  /** Whether the target accepted the delegated action. */
  accepted: boolean;
  /** `synchronous` when applied immediately, `queued` when deferred to async work. */
  disposition: 'synchronous' | 'queued';
  /** The observation recorded for this action, when produced synchronously. */
  observation?: MissionTargetResourceDto | null;
}
