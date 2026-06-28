// Barrel for the local-target capability contract (R2). Import from here:
//   import { LocalTargetProviderRegistry, ok, fail } from '.../local-target/index.ts';
export * from './types.ts';
export * from './result.ts';
export * from './registry.ts';
export { InProcessProvider } from './in-process-provider.ts';
export { deriveResourceStatus, resolveBackendResourceProvider } from './resource-status.ts';
export { performBranchActionGit } from './branch-actions-git.ts';
export type { BranchActionErrorCode, BranchActionGitResult } from './branch-actions-git.ts';
export { runGit, runGitResult } from './git-run.ts';
export {
  collectManagedWorktrees,
  purgeManagedWorktrees,
  removeManagedWorktree,
  worktreeIsDirty,
  worktreePathForBranch,
  resolveRealPath
} from './worktree-git.ts';
export {
  collectWorktreeChanges,
  gatherCommitMessageDiff
} from './commit-message-diff-git.ts';
export type {
  CommitMessageGatherErrorCode,
  CommitMessageGatherResult
} from './commit-message-diff-git.ts';
export { PROJECT_JSON_VERSION, writeProjectJson } from './project-metadata.ts';
export { FakeLocalTargetProvider } from './fake-provider.ts';
export type { FakeHandlers, FakeProviderOptions } from './fake-provider.ts';
export { RunnerQueueProvider } from './runner-queue-provider.ts';
export {
  createDefaultLocalTargetRegistry,
  resolveDefaultLocalTargetProvider,
  type DefaultLocalTargetRegistryOptions
} from './default-registry.ts';
