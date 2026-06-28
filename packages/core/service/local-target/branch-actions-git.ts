import { existsSync } from 'node:fs';

import { runGitResult } from './git-run.ts';
import type { BranchActionKind, PerformBranchActionInput } from './types.ts';
import { removeGitWorktree, worktreeIsDirty, worktreePathForBranch } from './worktree-git.ts';

export type BranchActionErrorCode =
  | 'BRANCH_NO_WORKTREE'
  | 'BRANCH_WORKTREE_MISMATCH'
  | 'BRANCH_DIRTY'
  | 'BRANCH_MERGE_CONFLICT'
  | 'BRANCH_PARENT_NOT_CHECKED_OUT'
  | 'BRANCH_MERGE_FAILED'
  | 'BRANCH_COMMIT_MESSAGE_REQUIRED'
  | 'BRANCH_NOTHING_TO_COMMIT'
  | 'BRANCH_COMMIT_FAILED'
  | 'BRANCH_PUSH_FAILED';

export type BranchActionGitResult =
  | { ok: true; summary: string }
  | { ok: false; code: BranchActionErrorCode; message: string; detail?: string };

function integrateBranch(input: PerformBranchActionInput): BranchActionGitResult {
  const { branchName, baseBranch, worktreePath, primaryRepoPath } = input;
  if (!existsSync(worktreePath)) {
    return {
      ok: false,
      code: 'BRANCH_NO_WORKTREE',
      message: `The branch's worktree is not present at ${worktreePath}.`
    };
  }
  const wtBranch = runGitResult(worktreePath, ['branch', '--show-current']);
  if (!wtBranch.ok || wtBranch.stdout !== branchName) {
    return {
      ok: false,
      code: 'BRANCH_WORKTREE_MISMATCH',
      message: `The worktree at ${worktreePath} is not checked out on ${branchName}.`
    };
  }
  if (worktreeIsDirty(worktreePath)) {
    return {
      ok: false,
      code: 'BRANCH_DIRTY',
      message: `The branch worktree has uncommitted changes — resolve/commit them first: ${worktreePath}`,
      detail: worktreePath
    };
  }

  const merge = runGitResult(worktreePath, ['merge', '--no-edit', baseBranch]);
  if (!merge.ok) {
    const conflicted = runGitResult(worktreePath, ['diff', '--name-only', '--diff-filter=U']);
    const files = conflicted.ok && conflicted.stdout ? conflicted.stdout.split('\n') : [];
    const detail =
      `Worktree: ${worktreePath}.` +
      (files.length ? ` Conflicting files: ${files.join(', ')}.` : '');
    return {
      ok: false,
      code: 'BRANCH_MERGE_CONFLICT',
      message: `Merging ${baseBranch} into ${branchName} hit conflicts.`,
      detail
    };
  }

  const parentWorktree = worktreePathForBranch(primaryRepoPath, baseBranch);
  if (!parentWorktree) {
    return {
      ok: false,
      code: 'BRANCH_PARENT_NOT_CHECKED_OUT',
      message: `Cannot advance ${baseBranch}: it is not checked out in any worktree. Check out ${baseBranch} in the primary repository and re-run.`
    };
  }
  if (worktreeIsDirty(parentWorktree)) {
    return {
      ok: false,
      code: 'BRANCH_DIRTY',
      message: `The ${baseBranch} checkout has uncommitted changes — commit or stash them first: ${parentWorktree}`,
      detail: parentWorktree
    };
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
    return {
      ok: false,
      code: 'BRANCH_MERGE_FAILED',
      message: `Failed to advance ${baseBranch} to ${branchName}.`,
      detail: advance.stderr || advance.stdout
    };
  }
  return {
    ok: true,
    summary: `Merged ${baseBranch} into ${branchName} and advanced ${baseBranch} locally.`
  };
}

function commitBranch(input: PerformBranchActionInput): BranchActionGitResult {
  const { branchName, worktreePath } = input;
  const trimmed = (input.message ?? '').trim();
  if (!trimmed) {
    return {
      ok: false,
      code: 'BRANCH_COMMIT_MESSAGE_REQUIRED',
      message: 'A commit message is required.'
    };
  }
  if (!existsSync(worktreePath)) {
    return {
      ok: false,
      code: 'BRANCH_NO_WORKTREE',
      message: `The branch's worktree is not present at ${worktreePath}.`
    };
  }
  const wtBranch = runGitResult(worktreePath, ['branch', '--show-current']);
  if (!wtBranch.ok || wtBranch.stdout !== branchName) {
    return {
      ok: false,
      code: 'BRANCH_WORKTREE_MISMATCH',
      message: `The worktree at ${worktreePath} is not checked out on ${branchName}.`
    };
  }
  if (!worktreeIsDirty(worktreePath)) {
    return {
      ok: false,
      code: 'BRANCH_NOTHING_TO_COMMIT',
      message: 'There are no uncommitted changes in the branch worktree to commit.',
      detail: worktreePath
    };
  }
  const staged = runGitResult(worktreePath, ['add', '-A']);
  if (!staged.ok) {
    return {
      ok: false,
      code: 'BRANCH_COMMIT_FAILED',
      message: `Failed to stage changes in ${worktreePath}.`,
      detail: staged.stderr || staged.stdout
    };
  }
  const commit = runGitResult(worktreePath, ['commit', '-m', trimmed]);
  if (!commit.ok) {
    return {
      ok: false,
      code: 'BRANCH_COMMIT_FAILED',
      message: `Failed to commit changes on ${branchName}.`,
      detail: commit.stderr || commit.stdout
    };
  }
  return { ok: true, summary: `Committed changes on ${branchName}.` };
}

function pushParent(input: PerformBranchActionInput): BranchActionGitResult {
  const { branchName, baseBranch, worktreePath, primaryRepoPath } = input;
  const repo = worktreePathForBranch(primaryRepoPath, baseBranch) ?? primaryRepoPath;
  const push = runGitResult(repo, ['push', 'origin', baseBranch]);
  if (!push.ok) {
    return {
      ok: false,
      code: 'BRANCH_PUSH_FAILED',
      message: `Failed to push ${baseBranch} to origin.`,
      detail: push.stderr || push.stdout
    };
  }
  let summary = `Pushed ${baseBranch} to origin.`;
  if (existsSync(worktreePath) && !worktreeIsDirty(worktreePath)) {
    if (removeGitWorktree({ primaryRepoPath, worktreePath, force: false })) {
      summary += ` Removed the merged worktree for ${branchName}.`;
    }
  }
  return { ok: true, summary };
}

function publishBranch(input: PerformBranchActionInput): BranchActionGitResult {
  const { branchName, worktreePath, primaryRepoPath } = input;
  const repo = existsSync(worktreePath) ? worktreePath : primaryRepoPath;
  const push = runGitResult(repo, ['push', '-u', 'origin', branchName]);
  if (!push.ok) {
    return {
      ok: false,
      code: 'BRANCH_PUSH_FAILED',
      message: `Failed to publish ${branchName} to origin.`,
      detail: push.stderr || push.stdout
    };
  }
  return { ok: true, summary: `Published ${branchName} to origin.` };
}

export function performBranchActionGit(input: PerformBranchActionInput): BranchActionGitResult {
  switch (input.action) {
    case 'integrate':
      return integrateBranch(input);
    case 'commit':
      return commitBranch(input);
    case 'push_parent':
      return pushParent(input);
    case 'publish':
      return publishBranch(input);
    default:
      return {
        ok: false,
        code: 'BRANCH_COMMIT_FAILED',
        message: `Unsupported branch action: ${String(input.action)}`
      };
  }
}
