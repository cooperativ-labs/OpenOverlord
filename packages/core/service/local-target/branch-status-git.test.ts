import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { observeMissionBranchGit } from './branch-observe-git.ts';
import { branchHasUnpushedCommits, deriveBranchPublicationStatus } from './branch-status-git.ts';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commitAll(cwd: string, message: string): void {
  git(cwd, ['add', '-A']);
  git(cwd, [
    '-c',
    'user.email=test@example.com',
    '-c',
    'user.name=Test User',
    'commit',
    '-m',
    message
  ]);
}

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ovld-branch-status-'));
  git(dir, ['init']);
  git(dir, ['checkout', '-b', 'main']);
  writeFileSync(path.join(dir, 'README.md'), '# Test\n');
  commitAll(dir, 'init');
  return dir;
}

describe('branch-status-git', () => {
  it('reports no unpushed commits when local and origin tips match', () => {
    const repo = makeRepo();
    git(repo, ['checkout', '-b', 'feature/demo']);
    writeFileSync(path.join(repo, 'feature.txt'), 'one\n');
    commitAll(repo, 'feature work');
    const tip = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['update-ref', 'refs/remotes/origin/feature/demo', tip]);

    assert.equal(branchHasUnpushedCommits({ repoPath: repo, branchName: 'feature/demo' }), false);
    assert.equal(
      deriveBranchPublicationStatus({
        repoPath: repo,
        branchName: 'feature/demo',
        baseBranch: 'main'
      }),
      'published'
    );

    const observed = observeMissionBranchGit({
      repoPath: repo,
      branchName: 'feature/demo',
      baseBranch: 'main'
    });
    assert.equal(observed.status, 'published');
    assert.equal(observed.hasUnpushedCommits, false);

    rmSync(repo, { recursive: true, force: true });
  });

  it('reports unpushed commits when local branch is ahead of origin', () => {
    const repo = makeRepo();
    git(repo, ['checkout', '-b', 'feature/demo']);
    writeFileSync(path.join(repo, 'feature.txt'), 'one\n');
    commitAll(repo, 'feature work');
    const firstTip = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['update-ref', 'refs/remotes/origin/feature/demo', firstTip]);

    writeFileSync(path.join(repo, 'feature.txt'), 'two\n');
    commitAll(repo, 'more work');

    assert.equal(branchHasUnpushedCommits({ repoPath: repo, branchName: 'feature/demo' }), true);

    const observed = observeMissionBranchGit({
      repoPath: repo,
      branchName: 'feature/demo',
      baseBranch: 'main'
    });
    assert.equal(observed.status, 'published');
    assert.equal(observed.hasUnpushedCommits, true);

    rmSync(repo, { recursive: true, force: true });
  });
});
