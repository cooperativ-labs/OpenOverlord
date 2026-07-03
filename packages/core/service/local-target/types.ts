// The local-target capability contract (R2 of
// planning/feature-plans/local-execution-target-capabilities.md §4).
//
// All checkout-local work — Git, worktrees, file/metadata writes, resource
// observations, agent launch — flows through this single interface. Callers
// depend on the interface, never on ad-hoc `existsSync`/`git` calls. Several
// interchangeable *provider transports* implement it (in-process, desktop
// bridge, runner queue, and a fake for tests); the resolver in `registry.ts`
// picks the transport from the selected target.
//
// This module is intentionally dependency-free and lives in `@overlord/core` so
// the REST API, Runner/CLI, and Desktop layers can all share one contract.
// Payload types are defined natively here (not as REST DTOs from
// `webapp/shared/contract.ts`) to keep the boundary clean; the backend
// in-process provider adapts between these payloads and its DTOs.

/**
 * Stable, typed error codes a capability may return. These cross the REST
 * boundary (so the UI can branch on them) and must never leak raw
 * filesystem/Git error text. Extend deliberately and keep messages short.
 */
export type LocalTargetErrorCode =
  /** No selected/eligible target can serve this capability (the generalized
   *  successor to the host-side `LOCAL_FILESYSTEM_UNAVAILABLE` guard). */
  | 'LOCAL_TARGET_REQUIRED'
  /** A target is selected but not reachable right now (offline runner, etc.). */
  | 'LOCAL_TARGET_UNREACHABLE'
  /** The linked directory does not exist on the target. */
  | 'RESOURCE_MISSING'
  /** The path exists but is not a Git repository. */
  | 'NOT_GIT_REPOSITORY'
  /** The target cannot access the path (filesystem permissions). */
  | 'PERMISSION_DENIED'
  /** A git/worktree command failed on the target. */
  | 'GIT_COMMAND_FAILED'
  /** The resolved provider transport does not implement this capability yet. */
  | 'CAPABILITY_NOT_IMPLEMENTED'
  /** Generic capability failure with no more specific code. */
  | 'TARGET_OPERATION_FAILED'
  | 'UNKNOWN';

/**
 * Per-target resource availability (§5 "Target Observation"). This is
 * target-scoped and time-sensitive — distinct from the backend-owned resource
 * *lifecycle* (`active`/`archived`). The backend must not infer it from its own
 * filesystem unless it is itself acting as a local target through this interface.
 */
export type TargetObservationState =
  | 'available'
  | 'missing'
  | 'unreachable'
  | 'permission_denied'
  | 'not_git_repository'
  | 'unknown';

/** Which transport actually served a capability call. */
export type CapabilityTransport = 'in_process' | 'desktop_bridge' | 'runner_queue' | 'fake';

/**
 * Enough metadata to explain *where* an operation ran. Carried on every result
 * (success or failure) so the UI can show the originating target/device.
 */
export interface TargetMetadata {
  /** The `execution_targets.id` this provider acts for, or null when unresolved. */
  executionTargetId: string | null;
  /** Human-readable device/target label for the UI. */
  deviceLabel: string | null;
  /** The transport that produced the result. */
  transport: CapabilityTransport;
}

export interface CapabilitySuccess<T> {
  ok: true;
  value: T;
  target: TargetMetadata;
}

export interface CapabilityFailure {
  ok: false;
  code: LocalTargetErrorCode;
  message: string;
  details?: unknown;
  target: TargetMetadata;
}

/** Discriminated result for every capability — never throw raw errors across it. */
export type CapabilityResult<T> = CapabilitySuccess<T> | CapabilityFailure;

// ---- Per-capability payloads (§4 table) ---------------------------------

export interface WriteProjectMetadataInput {
  directoryPath: string;
  projectId: string;
  resourceId: string;
  executionTargetId?: string | null;
  isPrimary: boolean;
}
export interface WriteProjectMetadataResult {
  /** Absolute path of the written `.overlord/project.json`. */
  path: string;
  written: boolean;
}

export interface ObserveResourceInput {
  resourceId: string;
  /** The recorded checkout path to observe on this target. */
  path: string;
}
export interface ResourceObservation {
  state: TargetObservationState;
  gitRoot?: string | null;
  branch?: string | null;
  commit?: string | null;
  /** ISO-8601 timestamp of when the target made the observation. */
  observedAt: string;
}

export interface ReadRepositoryTreeInput {
  resourceId: string;
  /** Absolute checkout path resolved by the backend before crossing this boundary. */
  repoPath: string;
  /** Repo-relative subdirectory to list; null/empty lists the root. */
  subPath?: string | null;
}
export interface RepositoryTreeEntry {
  name: string;
  /** Repo-relative path. */
  path: string;
  type: 'file' | 'directory';
  parentPath: string | null;
  depth: number;
}
export interface RepositoryTreeResult {
  rootPath: string;
  gitRoot: string;
  branch: string | null;
  commit: string | null;
  entries: RepositoryTreeEntry[];
  truncated: boolean;
}

export interface ListBranchesInput {
  resourceId: string;
  /** Absolute checkout path resolved by the backend before crossing this boundary. */
  repoPath: string;
}
export interface BranchListResult {
  local: string[];
  remote: string[];
  current: string | null;
}

export interface PrepareBranchInput {
  missionId: string;
  /** Force a specific branch name (the `--branch` escape hatch). */
  branch?: string | null;
  /** Prepare a dedicated worktree (vs. a branch-only checkout). */
  useWorktree?: boolean;
}
export interface PrepareBranchResult {
  branch: string;
  baseBranch: string;
  /** Worktree path when a worktree was prepared, else null (branch-only). */
  worktreePath: string | null;
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  dirty: boolean;
  merged: boolean;
}

/** Raw worktree row returned by the local target before REST enrichment. */
export interface ManagedWorktreeEntry {
  path: string;
  branch: string | null;
  primaryRepoPath: string;
  dirty: boolean;
}

export interface ListWorktreesInput {
  worktreeRoot: string;
  projects: Array<{ primaryRepoPath: string }>;
}

export interface ListWorktreesResult {
  worktrees: ManagedWorktreeEntry[];
}

export interface RemoveWorktreeInput {
  path: string;
  primaryRepoPath: string;
  /** Remove even when the worktree is dirty (dirty-protection override). */
  force?: boolean;
}

export interface PurgeMergedWorktreesInput {
  entries: Array<{ path: string; primaryRepoPath: string }>;
}

export interface PurgeWorktreesResult {
  removed: string[];
  skipped: Array<{ path: string; reason: string }>;
}

export type BranchActionKind = 'integrate' | 'commit' | 'push_parent' | 'publish';

export interface PerformBranchActionInput {
  action: BranchActionKind;
  branchName: string;
  baseBranch: string;
  worktreePath: string;
  primaryRepoPath: string;
  message?: string;
}

export interface PerformBranchActionResult {
  summary: string;
}

export interface ReadCurrentDiffInput {
  missionId: string;
  filePath?: string | null;
}
export interface CurrentDiffResult {
  workingDirectory: string | null;
  diff: string;
}

export interface GenerateCommitMessageInput {
  /** Absolute worktree path resolved by the backend before crossing this boundary. */
  worktreePath: string;
}
export interface GenerateCommitMessageResult {
  /** Local diff text for the backend summarizer (Automations Layer). */
  diff: string;
}

export interface LaunchAgentInput {
  executionRequestId: string;
}
export interface LaunchAgentResult {
  launched: boolean;
  sessionId?: string | null;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail?: string;
}
export interface DoctorResult {
  checks: DoctorCheck[];
}

/**
 * The local-target capability interface. One per resolved target; the `target`
 * metadata describes which device/transport this instance acts for. Every
 * method returns a {@link CapabilityResult} rather than throwing.
 */
export interface LocalTargetCapabilities {
  readonly target: TargetMetadata;

  writeProjectMetadata(
    input: WriteProjectMetadataInput
  ): Promise<CapabilityResult<WriteProjectMetadataResult>>;
  observeResource(input: ObserveResourceInput): Promise<CapabilityResult<ResourceObservation>>;
  readRepositoryTree(
    input: ReadRepositoryTreeInput
  ): Promise<CapabilityResult<RepositoryTreeResult>>;
  listBranches(input: ListBranchesInput): Promise<CapabilityResult<BranchListResult>>;
  prepareBranch(input: PrepareBranchInput): Promise<CapabilityResult<PrepareBranchResult>>;
  listWorktrees(input: ListWorktreesInput): Promise<CapabilityResult<ListWorktreesResult>>;
  removeWorktree(input: RemoveWorktreeInput): Promise<CapabilityResult<PurgeWorktreesResult>>;
  purgeMergedWorktrees(
    input: PurgeMergedWorktreesInput
  ): Promise<CapabilityResult<PurgeWorktreesResult>>;
  performBranchAction(
    input: PerformBranchActionInput
  ): Promise<CapabilityResult<PerformBranchActionResult>>;
  readCurrentDiff(input: ReadCurrentDiffInput): Promise<CapabilityResult<CurrentDiffResult>>;
  generateCommitMessageFromLocalDiff(
    input: GenerateCommitMessageInput
  ): Promise<CapabilityResult<GenerateCommitMessageResult>>;
  launchAgent(input: LaunchAgentInput): Promise<CapabilityResult<LaunchAgentResult>>;
  doctor(): Promise<CapabilityResult<DoctorResult>>;
}

/** The capability method names, useful for generic dispatch/registries. */
export type CapabilityName = keyof Omit<LocalTargetCapabilities, 'target'>;
