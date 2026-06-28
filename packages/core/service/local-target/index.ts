// Barrel for the local-target capability contract (R2). Import from here:
//   import { LocalTargetProviderRegistry, ok, fail } from '.../local-target/index.ts';
export type { BranchActionErrorCode, BranchActionGitResult } from './branch-actions-git.ts';
export { performBranchActionGit } from './branch-actions-git.ts';
export {
  branchMergedIntoBase,
  type BranchPublicationStatus,
  deriveBranchPublicationStatus,
  normalizeBranchRef,
  readPrimaryCheckoutBranch,
  resolveRef
} from './branch-status-git.ts';
export {
  observeMissionBranchGit,
  type BranchObservationInput,
  type BranchObservationResult
} from './branch-observe-git.ts';
export type {
  CommitMessageGatherErrorCode,
  CommitMessageGatherResult
} from './commit-message-diff-git.ts';
export { collectWorktreeChanges, gatherCommitMessageDiff } from './commit-message-diff-git.ts';
export {
  createDefaultLocalTargetRegistry,
  type DefaultLocalTargetRegistryOptions,
  resolveDefaultLocalTargetProvider
} from './default-registry.ts';
export {
  type BranchStatusInput,
  invokeLocalTargetCapability,
  type LocalTargetBridgeCall,
  type LocalTargetBridgeCapability
} from './desktop-bridge.ts';
export { runLocalTargetDoctorChecks } from './doctor-checks.ts';
export type { FakeHandlers, FakeProviderOptions } from './fake-provider.ts';
export { FakeLocalTargetProvider } from './fake-provider.ts';
export { runGit, runGitResult } from './git-run.ts';
export { readGitStatusPorcelain } from './git-status.ts';
export { InProcessProvider } from './in-process-provider.ts';
export { PROJECT_JSON_VERSION, writeProjectJson } from './project-metadata.ts';
export * from './registry.ts';
export {
  deriveResourceStatus,
  isCoLocatedBackend,
  resolveBackendResourceProvider
} from './resource-status.ts';
export * from './result.ts';
export { RunnerQueueProvider } from './runner-queue-provider.ts';
export * from './types.ts';
export {
  collectManagedWorktrees,
  purgeManagedWorktrees,
  removeManagedWorktree,
  resolveRealPath,
  worktreeIsDirty,
  worktreePathForBranch
} from './worktree-git.ts';
