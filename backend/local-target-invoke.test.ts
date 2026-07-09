import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import type {
  BranchListResult,
  CapabilityResult,
  ListWorktreesResult
} from '../packages/core/service/local-target/types.ts';
import { resolveRealPath } from '../packages/core/service/local-target/worktree-git.ts';

// Git/checkout-local capabilities through the opt-in dev invoke proxy (WS-F3).
describe('local-target invoke dev proxy', () => {
  const previousDevFlag = process.env.OVERLORD_DEV_IN_PROCESS_LOCAL_TARGET;

  after(() => {
    if (previousDevFlag === undefined) {
      delete process.env.OVERLORD_DEV_IN_PROCESS_LOCAL_TARGET;
    } else {
      process.env.OVERLORD_DEV_IN_PROCESS_LOCAL_TARGET = previousDevFlag;
    }
  });

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

  function branchLeaf(branch: string): string {
    return branch.replace(/[\\/]+/g, '-').replace(/^-+|-+$/g, '');
  }

  function initPrimaryWithRemote(): string {
    const bare = mkdtempSync(path.join('/tmp', 'ovld-invoke-bare-')) + '.git';
    git('/tmp', ['init', '-q', '--bare', '-b', 'main', bare]);
    const primary = mkdtempSync(path.join('/tmp', 'ovld-invoke-primary-'));
    git(primary, ['init', '-q', '-b', 'main']);
    writeFileSync(path.join(primary, 'a.txt'), 'a\n');
    writeFileSync(path.join(primary, '.gitignore'), '.overlord/\n');
    git(primary, ['add', '.']);
    git(primary, ['commit', '-q', '-m', 'base']);
    git(primary, ['remote', 'add', 'origin', bare]);
    git(primary, ['push', '-q', '-u', 'origin', 'main']);
    return primary;
  }

  function makeBranchWorktree(
    primary: string,
    worktreeRoot: string,
    projectSlug: string,
    branchName: string
  ): string {
    const worktreePath = path.join(worktreeRoot, projectSlug, branchLeaf(branchName));
    git(primary, ['worktree', 'add', '-q', '-b', branchName, worktreePath, 'main']);
    const file = `${branchLeaf(branchName)}.txt`;
    writeFileSync(path.join(worktreePath, file), `${file}\n`);
    git(worktreePath, ['add', '.']);
    git(worktreePath, ['commit', '-q', '-m', `work ${branchName}`]);
    return worktreePath;
  }

  it('rejects invoke when dev proxy is disabled', async () => {
    delete process.env.OVERLORD_DEV_IN_PROCESS_LOCAL_TARGET;
    const { invokeLocalTargetOnServer } = await import('./execution/local-target-invoke.ts');
    const result = await invokeLocalTargetOnServer({
      dialect: 'sqlite',
      call: {
        capability: 'listBranches',
        input: { resourceId: 'res', repoPath: '/tmp' }
      }
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'LOCAL_TARGET_REQUIRED');
  });

  it('lists branches and worktrees when dev proxy is enabled', async () => {
    process.env.OVERLORD_DEV_IN_PROCESS_LOCAL_TARGET = 'true';
    const worktreeRoot = mkdtempSync(path.join('/tmp', 'ovld-invoke-wt-'));
    process.env.OVERLORD_WORKTREE_ROOT = worktreeRoot;
    const primary = initPrimaryWithRemote();
    git(primary, ['branch', 'feature/x']);

    const { invokeLocalTargetOnServer } = await import('./execution/local-target-invoke.ts');

    const branches = (await invokeLocalTargetOnServer({
      dialect: 'sqlite',
      call: {
        capability: 'listBranches',
        input: { resourceId: 'res-1', repoPath: primary }
      }
    })) as CapabilityResult<BranchListResult>;
    assert.equal(branches.ok, true);
    if (branches.ok) {
      assert.ok(branches.value.local.includes('main'));
      assert.ok(branches.value.local.includes('feature/x'));
    }

    makeBranchWorktree(primary, worktreeRoot, 'demo', 'overlord/wt-a');

    const worktrees = (await invokeLocalTargetOnServer({
      dialect: 'sqlite',
      call: {
        capability: 'listWorktrees',
        input: {
          worktreeRoot,
          projects: [{ primaryRepoPath: primary }]
        }
      }
    })) as CapabilityResult<ListWorktreesResult>;
    assert.equal(worktrees.ok, true);
    if (worktrees.ok) {
      assert.equal(worktrees.value.worktrees.length, 1);
      assert.ok(
        worktrees.value.worktrees.some(
          w => w.path === resolveRealPath(path.join(worktreeRoot, 'demo', 'overlord-wt-a'))
        )
      );
    }
  });

  it('removes a worktree through performBranchAction integrate + push_parent flow', async () => {
    process.env.OVERLORD_DEV_IN_PROCESS_LOCAL_TARGET = 'true';
    const worktreeRoot = mkdtempSync(path.join('/tmp', 'ovld-invoke-flow-'));
    process.env.OVERLORD_WORKTREE_ROOT = worktreeRoot;
    const primary = initPrimaryWithRemote();
    const branchName = 'overlord/auto-remove';
    const worktreePath = makeBranchWorktree(primary, worktreeRoot, 'auto', branchName);

    const { invokeLocalTargetOnServer } = await import('./execution/local-target-invoke.ts');

    const integrate = await invokeLocalTargetOnServer({
      dialect: 'sqlite',
      call: {
        capability: 'performBranchAction',
        input: {
          action: 'integrate',
          branchName,
          baseBranch: 'main',
          worktreePath,
          primaryRepoPath: primary
        }
      }
    });
    assert.equal(integrate.ok, true);
    assert.equal(existsSync(worktreePath), true);

    const pushParent = await invokeLocalTargetOnServer({
      dialect: 'sqlite',
      call: {
        capability: 'performBranchAction',
        input: {
          action: 'push_parent',
          branchName,
          baseBranch: 'main',
          worktreePath,
          primaryRepoPath: primary
        }
      }
    });
    assert.equal(pushParent.ok, true);
    assert.equal(existsSync(worktreePath), false);
  });
});
