import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { performBranchActionGit } from './branch-actions-git.ts';
import {
  collectManagedWorktrees,
  removeManagedWorktree,
  resolveRealPath,
  worktreeIsDirty
} from './worktree-git.ts';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ovld-wt-git-'));
  git(dir, ['init']);
  git(dir, ['checkout', '-b', 'main']);
  writeFileSync(path.join(dir, 'README.md'), '# Test\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test User', 'commit', '-m', 'init']);
  return dir;
}

describe('worktree-git', () => {
  it('collects managed worktrees under the configured root', () => {
    const repo = makeRepo();
    const worktreeRoot = mkdtempSync(path.join(tmpdir(), 'ovld-wt-root-'));
    const branch = 'feature/demo';
    git(repo, ['branch', branch]);
    const worktreePath = path.join(worktreeRoot, 'demo');
    git(repo, ['worktree', 'add', worktreePath, branch]);

    const worktrees = collectManagedWorktrees({
      worktreeRoot,
      projects: [{ primaryRepoPath: repo }]
    });
    assert.equal(worktrees.length, 1);
    assert.equal(worktrees[0]?.path, resolveRealPath(worktreePath));
    assert.equal(worktrees[0]?.branch, branch);
    assert.equal(worktrees[0]?.dirty, false);

    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it('refuses to remove a dirty worktree without force', () => {
    const repo = makeRepo();
    const worktreeRoot = mkdtempSync(path.join(tmpdir(), 'ovld-wt-root-'));
    const branch = 'feature/dirty';
    git(repo, ['branch', branch]);
    const worktreePath = path.join(worktreeRoot, 'dirty');
    git(repo, ['worktree', 'add', worktreePath, branch]);
    writeFileSync(path.join(worktreePath, 'dirty.txt'), 'change');
    assert.equal(worktreeIsDirty(worktreePath), true);

    const result = removeManagedWorktree({
      path: worktreePath,
      primaryRepoPath: repo,
      force: false
    });
    assert.deepEqual(result.removed, []);
    assert.equal(result.skipped[0]?.reason, 'uncommitted changes');
    assert.equal(existsSync(worktreePath), true);

    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });
});

describe('branch-actions-git', () => {
  it('requires a commit message for the commit action', () => {
    const result = performBranchActionGit({
      action: 'commit',
      branchName: 'feat',
      baseBranch: 'main',
      worktreePath: '/missing',
      primaryRepoPath: '/repo',
      message: '   '
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'BRANCH_COMMIT_MESSAGE_REQUIRED');
  });
});
