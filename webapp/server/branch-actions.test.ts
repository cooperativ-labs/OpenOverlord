import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

// Exercises the on-demand branch actions (POST /api/missions/:id/branch/action) end
// to end against real git repos with a bare "origin": integrate (Action A) advances
// the local parent (→ merged_unpushed), push_parent (Action B) publishes it (→
// merged), conflicts are surfaced and left in the worktree, and publish pushes the
// branch itself (→ published).
describe('branch actions', () => {
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

  // A primary repo wired to a bare "origin" remote, with origin/main present.
  function initPrimaryWithRemote(): string {
    const bare = mkdtempSync(path.join('/tmp', 'ovld-ba-bare-')) + '.git';
    git('/tmp', ['init', '-q', '--bare', '-b', 'main', bare]);
    const primary = mkdtempSync(path.join('/tmp', 'ovld-ba-primary-'));
    git(primary, ['init', '-q', '-b', 'main']);
    writeFileSync(path.join(primary, 'a.txt'), 'a\n');
    git(primary, ['add', '.']);
    git(primary, ['commit', '-q', '-m', 'base']);
    git(primary, ['remote', 'add', 'origin', bare]);
    git(primary, ['push', '-q', '-u', 'origin', 'main']);
    return primary;
  }

  async function setup(): Promise<{
    worktreeRoot: string;
    api: typeof import('./repository.ts');
    runner: typeof import('./runner.ts');
    primary: string;
  }> {
    const dir = mkdtempSync(path.join('/tmp', 'ovld-ba-db-'));
    process.env.OVERLORD_SQLITE_PATH = path.join(dir, 'Overlord.sqlite');
    const worktreeRoot = mkdtempSync(path.join('/tmp', 'ovld-ba-wt-'));
    process.env.OVERLORD_WORKTREE_ROOT = worktreeRoot;
    const api = await import('./repository.ts');
    const runner = await import('./runner.ts');
    const primary = initPrimaryWithRemote();
    return { worktreeRoot, api, runner, primary };
  }

  it('integrate advances the parent locally then push publishes it (merged_unpushed → merged)', async () => {
    const { worktreeRoot, api, runner, primary } = await setup();
    const project = api.createProject({ name: 'Branch Actions Test' });
    api.createProjectResource(project.id, { directoryPath: primary, isPrimary: true });
    const mission = api.createMission({ projectId: project.id, firstObjective: 'Work' });

    // Branch cut from main with its own commit, in its own worktree.
    const branchName = 'overlord/feat-1';
    const worktreePath = path.join(worktreeRoot, project.slug, branchLeaf(branchName));
    git(primary, ['worktree', 'add', '-q', '-b', branchName, worktreePath, 'main']);
    writeFileSync(path.join(worktreePath, 'b.txt'), 'b\n');
    git(worktreePath, ['add', '.']);
    git(worktreePath, ['commit', '-q', '-m', 'work on branch']);

    // Parent moves forward independently (a non-conflicting file).
    writeFileSync(path.join(primary, 'c.txt'), 'c\n');
    git(primary, ['add', '.']);
    git(primary, ['commit', '-q', '-m', 'parent advances']);

    runner.recordBranchPrepared({
      missionId: mission.displayId,
      payload: { branchName, baseBranch: 'main', worktreePath, action: 'create', cycle: 1 }
    });
    assert.equal(api.getMissionDetail(mission.id).branch?.status, 'created');

    // Action A: integrate → local main contains the branch, not pushed.
    const afterIntegrate = api.performBranchAction(mission.id, { action: 'integrate' });
    assert.equal(afterIntegrate.branch?.status, 'merged_unpushed');
    // Local main now contains the branch's file, via a merge commit (parent diverged).
    assert.equal(git(primary, ['rev-list', '--count', `origin/main..main`]) !== '0', true);

    // Action B: push parent → origin/main contains the branch ⇒ merged.
    const afterPush = api.performBranchAction(mission.id, { action: 'push_parent' });
    assert.equal(afterPush.branch?.status, 'merged');
    assert.equal(git(primary, ['rev-list', '--count', `origin/main..main`]), '0');
  });

  it('surfaces a merge conflict and leaves it in the branch worktree', async () => {
    const { worktreeRoot, api, runner, primary } = await setup();
    const project = api.createProject({ name: 'Conflict Test' });
    api.createProjectResource(project.id, { directoryPath: primary, isPrimary: true });
    const mission = api.createMission({ projectId: project.id, firstObjective: 'Work' });

    const branchName = 'overlord/conflict-1';
    const worktreePath = path.join(worktreeRoot, project.slug, branchLeaf(branchName));
    git(primary, ['worktree', 'add', '-q', '-b', branchName, worktreePath, 'main']);
    // Both edit a.txt differently → conflict on merge.
    writeFileSync(path.join(worktreePath, 'a.txt'), 'a-branch\n');
    git(worktreePath, ['add', '.']);
    git(worktreePath, ['commit', '-q', '-m', 'branch edit']);
    writeFileSync(path.join(primary, 'a.txt'), 'a-parent\n');
    git(primary, ['add', '.']);
    git(primary, ['commit', '-q', '-m', 'parent edit']);

    runner.recordBranchPrepared({
      missionId: mission.displayId,
      payload: { branchName, baseBranch: 'main', worktreePath, action: 'create', cycle: 1 }
    });

    assert.throws(
      () => api.performBranchAction(mission.id, { action: 'integrate' }),
      (err: unknown) => (err as { code?: string }).code === 'BRANCH_MERGE_CONFLICT'
    );
    // The conflicted merge is left in place for IDE resolution.
    const status = git(worktreePath, ['status', '--porcelain']);
    assert.equal(status.includes('a.txt'), true);
  });

  it('commit stages and commits a dirty worktree, clearing the dirty flag', async () => {
    const { worktreeRoot, api, runner, primary } = await setup();
    const project = api.createProject({ name: 'Commit Test' });
    api.createProjectResource(project.id, { directoryPath: primary, isPrimary: true });
    const mission = api.createMission({ projectId: project.id, firstObjective: 'Work' });

    const branchName = 'feat-commit-1';
    const worktreePath = path.join(worktreeRoot, project.slug, branchLeaf(branchName));
    git(primary, ['worktree', 'add', '-q', '-b', branchName, worktreePath, 'main']);
    // Uncommitted work in the branch worktree.
    writeFileSync(path.join(worktreePath, 'b.txt'), 'b\n');

    runner.recordBranchPrepared({
      missionId: mission.displayId,
      payload: { branchName, baseBranch: 'main', worktreePath, action: 'create', cycle: 1 }
    });
    assert.equal(api.getMissionDetail(mission.id).branch?.dirty, true);

    const after = api.performBranchAction(mission.id, {
      action: 'commit',
      message: 'Add b.txt'
    });
    assert.equal(after.branch?.dirty, false);
    // The change landed as a commit on the branch.
    assert.equal(git(worktreePath, ['log', '-1', '--pretty=%s']), 'Add b.txt');
    assert.equal(git(worktreePath, ['status', '--porcelain']), '');
  });

  it('commit rejects an empty message and a clean worktree', async () => {
    const { worktreeRoot, api, runner, primary } = await setup();
    const project = api.createProject({ name: 'Commit Guard Test' });
    api.createProjectResource(project.id, { directoryPath: primary, isPrimary: true });
    const mission = api.createMission({ projectId: project.id, firstObjective: 'Work' });

    const branchName = 'feat-commit-2';
    const worktreePath = path.join(worktreeRoot, project.slug, branchLeaf(branchName));
    git(primary, ['worktree', 'add', '-q', '-b', branchName, worktreePath, 'main']);
    writeFileSync(path.join(worktreePath, 'b.txt'), 'b\n');
    runner.recordBranchPrepared({
      missionId: mission.displayId,
      payload: { branchName, baseBranch: 'main', worktreePath, action: 'create', cycle: 1 }
    });

    assert.throws(
      () => api.performBranchAction(mission.id, { action: 'commit', message: '   ' }),
      (err: unknown) => (err as { code?: string }).code === 'BRANCH_COMMIT_MESSAGE_REQUIRED'
    );

    // Commit it, then a second commit attempt finds nothing to commit.
    api.performBranchAction(mission.id, { action: 'commit', message: 'Add b.txt' });
    assert.throws(
      () => api.performBranchAction(mission.id, { action: 'commit', message: 'again' }),
      (err: unknown) => (err as { code?: string }).code === 'BRANCH_NOTHING_TO_COMMIT'
    );
  });

  it('publish pushes the branch itself (created → published)', async () => {
    const { worktreeRoot, api, runner, primary } = await setup();
    const project = api.createProject({ name: 'Publish Test' });
    api.createProjectResource(project.id, { directoryPath: primary, isPrimary: true });
    const mission = api.createMission({ projectId: project.id, firstObjective: 'Work' });

    const branchName = 'overlord/publish-1';
    const worktreePath = path.join(worktreeRoot, project.slug, branchLeaf(branchName));
    git(primary, ['worktree', 'add', '-q', '-b', branchName, worktreePath, 'main']);
    writeFileSync(path.join(worktreePath, 'b.txt'), 'b\n');
    git(worktreePath, ['add', '.']);
    git(worktreePath, ['commit', '-q', '-m', 'work']);

    runner.recordBranchPrepared({
      missionId: mission.displayId,
      payload: { branchName, baseBranch: 'main', worktreePath, action: 'create', cycle: 1 }
    });
    assert.equal(api.getMissionDetail(mission.id).branch?.status, 'created');

    const afterPublish = api.performBranchAction(mission.id, { action: 'publish' });
    assert.equal(afterPublish.branch?.status, 'published');
  });
});
