import { runGit } from './git-run.ts';

export type BranchPublicationStatus = 'created' | 'published' | 'merged_unpushed' | 'merged';

/** Resolves the absolute SHA a ref points at, or null when the ref does not exist. */
export function resolveRef(repoPath: string, ref: string): string | null {
  const sha = runGit(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return sha || null;
}

/** True when `sha` sits on the base's first-parent trunk (merge-with-parent semantics). */
export function isOnFirstParentTrunk(repoPath: string, base: string, sha: string): boolean {
  const trunk = runGit(repoPath, ['rev-list', '--first-parent', base]);
  if (!trunk) return false;
  return trunk.split('\n').some(line => line.trim() === sha);
}

/** True when the branch tip is contained in the base via a non-ff merge (not merely reachable). */
export function branchMergedIntoBase(repoPath: string, branchSha: string, base: string): boolean {
  const baseSha = resolveRef(repoPath, base);
  if (!baseSha) return false;
  if (baseSha === branchSha) return false;
  const ahead = runGit(repoPath, ['rev-list', '--count', `${baseSha}..${branchSha}`]).trim();
  if (ahead !== '0') return false;
  return !isOnFirstParentTrunk(repoPath, base, branchSha);
}

/**
 * Derive mission-branch publication status from live git refs in a repo checkout.
 * Callers supply `repoPath` after resolving id → path (DB-free provider input).
 */
export function deriveBranchPublicationStatus({
  repoPath,
  branchName,
  baseBranch
}: {
  repoPath: string;
  branchName: string;
  baseBranch: string | null;
}): BranchPublicationStatus {
  const branchSha =
    resolveRef(repoPath, `refs/heads/${branchName}`) ??
    resolveRef(repoPath, `refs/remotes/origin/${branchName}`);
  const remoteExists = resolveRef(repoPath, `refs/remotes/origin/${branchName}`) !== null;
  if (!branchSha) return 'created';

  if (baseBranch) {
    if (branchMergedIntoBase(repoPath, branchSha, `origin/${baseBranch}`)) return 'merged';
    if (branchMergedIntoBase(repoPath, branchSha, baseBranch)) return 'merged_unpushed';
  }

  return remoteExists ? 'published' : 'created';
}

/** True when the local branch tip is ahead of `origin/<branchName>`. */
export function branchHasUnpushedCommits({
  repoPath,
  branchName
}: {
  repoPath: string;
  branchName: string;
}): boolean {
  const localSha = resolveRef(repoPath, `refs/heads/${branchName}`);
  const remoteSha = resolveRef(repoPath, `refs/remotes/origin/${branchName}`);
  if (!localSha || !remoteSha || localSha === remoteSha) return false;
  const ahead = runGit(repoPath, ['rev-list', '--count', `${remoteSha}..${localSha}`]).trim();
  return ahead !== '0' && ahead !== '';
}

export function normalizeBranchRef(ref: string): string {
  return ref
    .replace(/^origin\//, '')
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\/origin\//, '')
    .trim();
}

/** Current branch in the primary worktree, or null when not on a branch. */
export function readPrimaryCheckoutBranch(repoPath: string): string | null {
  const worktrees = runGit(repoPath, ['worktree', 'list', '--porcelain']);
  let inMainWorktree = false;
  for (const line of worktrees.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (inMainWorktree) break;
      inMainWorktree = true;
      continue;
    }
    if (!inMainWorktree || !line.startsWith('branch ')) continue;
    const branch = normalizeBranchRef(line.slice('branch '.length));
    return branch || null;
  }

  const current = runGit(repoPath, ['branch', '--show-current']);
  return current || null;
}
