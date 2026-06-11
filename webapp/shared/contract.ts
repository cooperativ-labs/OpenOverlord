/**
 * Typed API contract shared between the REST server (`server/`) and the React
 * SPA (`web/`). DTO field names are the camelCase form of the logical schema
 * columns (see database/docs/09-database-schema-contract.md). This file is
 * types only so it can be `import type`-d from either runtime without a runtime
 * dependency.
 *
 * Scope note: this build covers projects, tickets, and objectives — the entities
 * the web interface lets users add and modify — plus the objective launch
 * surface: the workspace agent catalog, per-user launch configs, project launch
 * preferences, and execution-request queueing. Runner claiming/launching and
 * deliveries remain CLI-only and are intentionally absent here.
 */

// ---- Closed status vocabularies (from the schema CHECK constraints) ----

export type ProjectLifecycle = 'active' | 'archived';

export type StatusType = 'draft' | 'execute' | 'review' | 'complete' | 'blocked' | 'cancelled';

export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';

export type ObjectiveState =
  | 'future'
  | 'draft'
  | 'submitted'
  | 'launching'
  | 'executing'
  | 'pending_delivery'
  | 'complete';

export type EntityType = 'project' | 'ticket' | 'objective';

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
  createdAt: string;
}

export interface CreateWorkspaceBody {
  name: string;
  /** Optional slug; derived from the name (and uniquified) when omitted. */
  slug?: string;
}

export interface ProjectDto {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string | null;
  /** Optional hex color stored in project settings for UI display. */
  color: string | null;
  status: ProjectLifecycle;
  createdAt: string;
  updatedAt: string;
  revision: number;
  /** Count of non-deleted tickets (read-side aggregate). */
  ticketCount: number;
}

export interface ProjectStatusDto {
  id: string;
  projectId: string;
  key: string;
  name: string;
  type: StatusType;
  position: number;
  isDefault: boolean;
  isTerminal: boolean;
}

export type ProjectResourceType = 'local_directory' | 'remote_directory';
export type ProjectResourceStatus = 'active' | 'missing' | 'archived';

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

export interface SqliteBrowserColumnDto {
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string | null;
  primaryKeyPosition: number;
}

export interface SqliteBrowserTableDto {
  name: string;
  type: 'table' | 'view';
  columns: SqliteBrowserColumnDto[];
  rowCount: number | null;
  sql: string | null;
}

export interface SqliteBrowserTablesDto {
  databasePath: string;
  workspaceRoot: string;
  tables: SqliteBrowserTableDto[];
}

export interface SqliteBrowserTableDataDto {
  table: SqliteBrowserTableDto;
  columns: string[];
  rows: Array<Record<string, string | number | boolean | null>>;
  limit: number;
  offset: number;
  totalRows: number | null;
}

export interface SqliteBrowserQueryResultDto {
  sql: string;
  columns: string[];
  rows: Array<Record<string, string | number | boolean | null>>;
  rowCount: number;
  truncated: boolean;
  durationMs: number;
}

export interface TicketDto {
  id: string;
  workspaceId: string;
  projectId: string;
  displayId: string;
  sequenceNumber: number;
  title: string;
  statusId: string;
  statusType: StatusType;
  /**
   * Gap-based ordering of the ticket within its board column (its
   * `(projectId, statusId)` group). Lower sorts first. Renumbered densely
   * (100, 200, 300, …) whenever a column is reordered.
   */
  boardPosition: number;
  priority: TicketPriority | null;
  /** Human-readable acceptance criteria for the ticket. */
  acceptanceCriteria: string | null;
  /** Tool names available to the agent working on this ticket. */
  availableTools: string[];
  createdAt: string;
  updatedAt: string;
  revision: number;
  /** Count of non-deleted objectives (read-side aggregate). */
  objectiveCount: number;
}

export interface ObjectiveDto {
  id: string;
  workspaceId: string;
  projectId: string;
  ticketId: string;
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
}

export interface TicketDetailDto extends TicketDto {
  objectives: ObjectiveDto[];
  statuses: ProjectStatusDto[];
  /** Active (queued/claimed/launching) execution requests for this ticket's objectives. */
  executionRequests: ExecutionRequestDto[];
}

// ---- Ticket activity feed ----

/**
 * Closed vocabulary for `ticket_events.type` (see the schema contract). These
 * are the workflow events surfaced in the ticket panel's live activity feed.
 */
export type TicketEventType =
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
 * A single entry in a ticket's workflow history (`ticket_events`). Append-only;
 * ordered oldest-first by `createdAt`. The SPA renders these as a realtime feed
 * inside the ticket panel, refetching whenever the change feed reports activity.
 */
export interface TicketEventDto {
  id: string;
  ticketId: string;
  objectiveId: string | null;
  /** Closed vocabulary; unknown future values render with a neutral fallback. */
  type: TicketEventType | string;
  /** Optional workflow phase recorded with the event (`attach`, `execute`, …). */
  phase: string | null;
  summary: string;
  /** Open vocabulary describing what produced the event (`agent`, `cli`, …). */
  source: string;
  /** Optional external link associated with the event. */
  externalUrl: string | null;
  createdAt: string;
}

// ---- Agent catalog and launch configuration ----
//
// Shapes follow connectors/docs/agent-harness-configuration-architecture.md:
// the workspace catalog (workspaces.settings_json.agentCatalog) answers "what
// agents and models are offered"; per-user launch mechanics live on the user's
// workspace_user_execution_targets row; project_user_preferences remember the
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

export interface LaunchSettingsDto {
  /** The local execution target launches queue against (provisioned on demand). */
  executionTargetId: string;
  deviceLabel: string;
  /** Per-user launch configs keyed by agent key. */
  agentConfigs: Record<string, AgentLaunchConfigDto>;
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
  ticketId: string;
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
  ticketId: string;
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
  ticketId: string | null;
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
}

export interface UpdateProjectBody {
  name?: string;
  description?: string | null;
  status?: ProjectLifecycle;
  /** Optional 6-digit hex color (e.g. `#fecdd3`). */
  color?: string;
}

export interface CreateTicketBody {
  projectId: string;
  /** Optional when `firstObjective` is provided; otherwise required. */
  title?: string;
  priority?: TicketPriority;
  statusId?: string;
  /** Optional first objective instruction; creates objective #1 when present. */
  firstObjective?: string;
}

export interface UpdateTicketBody {
  title?: string;
  priority?: TicketPriority | null;
  statusId?: string;
  acceptanceCriteria?: string | null;
  availableTools?: string[];
}

/**
 * Reorders a single board column. `orderedTicketIds` lists every ticket that
 * should occupy the `statusId` column, top-to-bottom, after the move. Any
 * ticket whose current status differs is moved into this column (its status
 * changes to match). This one call covers both within-column reordering and the
 * destination side of a cross-column drag.
 */
export interface ReorderBoardColumnBody {
  statusId: string;
  orderedTicketIds: string[];
}

export interface CreateObjectiveBody {
  ticketId: string;
  instructionText: string;
  title?: string | null;
  state?: ObjectiveState;
  autoAdvance?: boolean;
}

/**
 * Reorders the `future` objectives of a single ticket. `orderedObjectiveIds`
 * lists every future objective on the ticket, top-to-bottom, after the move.
 * Only objectives currently in the `future` state may be reordered; their
 * `position` is renumbered relative to one another while remaining after any
 * non-future objectives. Returns the ticket's full objective list in its new
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
 * request, and moves a draft objective to `submitted`.
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

export interface ApiError {
  error: string;
  detail?: string;
}
