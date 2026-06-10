/**
 * Typed API contract shared between the REST server (`server/`) and the React
 * SPA (`web/`). DTO field names are the camelCase form of the logical schema
 * columns (see database/docs/09-database-schema-contract.md). This file is
 * types only so it can be `import type`-d from either runtime without a runtime
 * dependency.
 *
 * Scope note: this build covers projects, tickets, and objectives — the entities
 * the web interface lets users add and modify. Execution targets, runner launch,
 * deliveries, etc. remain CLI-only for now and are intentionally absent here.
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
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface TicketDetailDto extends TicketDto {
  objectives: ObjectiveDto[];
  statuses: ProjectStatusDto[];
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

export interface UpdateObjectiveBody {
  instructionText?: string;
  title?: string | null;
  state?: ObjectiveState;
  autoAdvance?: boolean;
  position?: number;
}

export interface ApiError {
  error: string;
  detail?: string;
}
