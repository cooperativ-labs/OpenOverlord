import { existsSync } from 'node:fs';

import {
  type BranchPublicationStatus,
  deriveBranchPublicationStatus
} from './branch-status-git.ts';
import { worktreeIsDirty, worktreePathForBranch } from './worktree-git.ts';

export interface BranchObservationInput {
  repoPath: string;
  branchName: string;
  baseBranch: string | null;
  /** Canonical or predicted worktree path when git cannot resolve one yet. */
  worktreePathHint?: string | null;
}

export interface BranchObservationResult {
  status: BranchPublicationStatus;
  dirty: boolean;
  worktreePath: string | null;
}

/** Observe live branch publication status, worktree location, and dirty state. */
export function observeMissionBranchGit(input: BranchObservationInput): BranchObservationResult {
  const status = deriveBranchPublicationStatus(input);
  const resolved =
    (input.worktreePathHint && existsSync(input.worktreePathHint)
      ? input.worktreePathHint
      : null) ?? worktreePathForBranch(input.repoPath, input.branchName);
  return {
    status,
    dirty: resolved ? worktreeIsDirty(resolved) : false,
    worktreePath: resolved
  };
}
