import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  collectWorktreeChanges,
  gatherCommitMessageDiff
} from './commit-message-diff-git.ts';

describe('commit-message-diff-git', () => {
  function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com'
      }
    }).trim();
  }

  it('collects porcelain status and diff for dirty worktrees', () => {
    const repo = mkdtempSync(path.join('/tmp', 'ovld-cmdg-'));
    git(repo, ['init', '-q', '-b', 'main']);
    writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'base']);
    writeFileSync(path.join(repo, 'b.txt'), 'b\n');

    const diff = collectWorktreeChanges(repo);
    assert.match(diff, /git status --porcelain/);
    assert.match(diff, /b\.txt/);
  });

  it('rejects a clean worktree', () => {
    const repo = mkdtempSync(path.join('/tmp', 'ovld-cmdg-clean-'));
    git(repo, ['init', '-q', '-b', 'main']);
    writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'base']);

    const result = gatherCommitMessageDiff(repo);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'BRANCH_NOTHING_TO_COMMIT');
  });

  it('rejects a missing worktree path', () => {
    const result = gatherCommitMessageDiff('/tmp/ovld-cmdg-missing-worktree');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'BRANCH_NO_WORKTREE');
  });
});
