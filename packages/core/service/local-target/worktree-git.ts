import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { runGitResult } from './git-run.ts';
import type { ManagedWorktreeEntry, PurgeWorktreesResult } from './types.ts';

export function resolveRealPath(targetPath: string): string {
  try {
    return realpathSync.native(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

export function worktreeIsDirty(worktreePath: string): boolean {
  const status = runGitResult(worktreePath, ['status', '--porcelain']);
  return status.ok && status.stdout.length > 0;
}

export function worktreePathForBranch(repoPath: string, branch: string): string | null {
  const out = runGitResult(repoPath, ['worktree', 'list', '--porcelain']);
  if (!out.ok) return null;
  let currentPath: string | null = null;
  for (const line of out.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      currentPath = line.slice('worktree '.length).trim();
    } else if (line.startsWith('branch ')) {
      const ref = line
        .slice('branch '.length)
        .trim()
        .replace(/^refs\/heads\//, '');
      if (ref === branch && currentPath) return currentPath;
    }
  }
  return null;
}

export function removeGitWorktree({
  primaryRepoPath,
  worktreePath,
  force
}: {
  primaryRepoPath: string;
  worktreePath: string;
  force: boolean;
}): boolean {
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(worktreePath);
  runGitResult(primaryRepoPath, args);
  runGitResult(primaryRepoPath, ['worktree', 'prune']);
  return !existsSync(worktreePath);
}

export function collectManagedWorktrees({
  worktreeRoot,
  projects
}: {
  worktreeRoot: string;
  projects: Array<{ primaryRepoPath: string }>;
}): ManagedWorktreeEntry[] {
  const resolvedRoot = resolveRealPath(worktreeRoot);
  const entries: ManagedWorktreeEntry[] = [];
  const seen = new Set<string>();

  for (const project of projects) {
    const repoPath = project.primaryRepoPath;
    if (!repoPath || !existsSync(repoPath)) continue;
    const out = runGitResult(repoPath, ['worktree', 'list', '--porcelain']);
    if (!out.ok) continue;

    let currentPath: string | null = null;
    let currentBranch: string | null = null;
    const flush = (): void => {
      if (!currentPath) return;
      const resolved = resolveRealPath(currentPath);
      const underRoot = resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
      if (underRoot && !seen.has(resolved)) {
        seen.add(resolved);
        entries.push({
          path: resolved,
          branch: currentBranch,
          primaryRepoPath: repoPath,
          dirty: worktreeIsDirty(resolved)
        });
      }
      currentPath = null;
      currentBranch = null;
    };

    for (const line of out.stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        flush();
        currentPath = line.slice('worktree '.length).trim();
      } else if (line.startsWith('branch ')) {
        currentBranch = line
          .slice('branch '.length)
          .trim()
          .replace(/^refs\/heads\//, '');
      } else if (line.trim() === '') {
        flush();
      }
    }
    flush();
  }

  return entries;
}

export function removeManagedWorktree({
  path: worktreePath,
  primaryRepoPath,
  force
}: {
  path: string;
  primaryRepoPath: string;
  force: boolean;
}): PurgeWorktreesResult {
  const target = path.resolve(worktreePath);
  if (!force && worktreeIsDirty(target)) {
    return {
      removed: [],
      skipped: [{ path: target, reason: 'uncommitted changes' }]
    };
  }
  const removed = removeGitWorktree({ primaryRepoPath, worktreePath: target, force });
  return removed
    ? { removed: [target], skipped: [] }
    : { removed: [], skipped: [{ path: target, reason: 'git refused to remove the worktree' }] };
}

export function purgeManagedWorktrees({
  entries
}: {
  entries: Array<{ path: string; primaryRepoPath: string }>;
}): PurgeWorktreesResult {
  const removed: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  for (const entry of entries) {
    const target = path.resolve(entry.path);
    if (worktreeIsDirty(target)) {
      skipped.push({ path: target, reason: 'uncommitted changes' });
      continue;
    }
    if (removeGitWorktree({ primaryRepoPath: entry.primaryRepoPath, worktreePath: target, force: false })) {
      removed.push(target);
    } else {
      skipped.push({ path: target, reason: 'git refused to remove the worktree' });
    }
  }
  return { removed, skipped };
}
