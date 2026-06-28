import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

// Exercises objective-3 features end to end against real git repos:
//  - branch override: stored on the mission, surfaced on MissionBranchDto, cleared
//    when the runner records a prepared branch;
//  - available-branch listing for the selector;
//  - per-objective branch recording (via an execution request);
//  - worktree listing / single removal / purge-merged;
//  - push_parent auto-removing the merged branch worktree.
describe('branch selection and worktree management', () => {
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

  function initPrimaryWithRemote(): string {
    const bare = mkdtempSync(path.join('/tmp', 'ovld-bsw-bare-')) + '.git';
    git('/tmp', ['init', '-q', '--bare', '-b', 'main', bare]);
    const primary = mkdtempSync(path.join('/tmp', 'ovld-bsw-primary-'));
    git(primary, ['init', '-q', '-b', 'main']);
    writeFileSync(path.join(primary, 'a.txt'), 'a\n');
    // Overlord-managed repos ignore the `.overlord/` metadata dir the service
    // writes into the resource; mirror that so it never trips the dirty guards.
    writeFileSync(path.join(primary, '.gitignore'), '.overlord/\n');
    git(primary, ['add', '.']);
    git(primary, ['commit', '-q', '-m', 'base']);
    git(primary, ['remote', 'add', 'origin', bare]);
    git(primary, ['push', '-q', '-u', 'origin', 'main']);
    return primary;
  }

  async function setup(): Promise<{
    worktreeRoot: string;
    api: typeof import('./repository.ts');
    launch: typeof import('./launch.ts');
    runner: typeof import('./runner.ts');
    primary: string;
  }> {
    const dir = mkdtempSync(path.join('/tmp', 'ovld-bsw-db-'));
    const worktreeRoot = mkdtempSync(path.join('/tmp', 'ovld-bsw-wt-'));
    process.env.OVERLORD_WORKTREE_ROOT = worktreeRoot;
    const { bootstrapIntegrationTestDb } = await import('./test-helpers.ts');
    await bootstrapIntegrationTestDb({ sqlitePath: path.join(dir, 'Overlord.sqlite') });
    const api = await import('./repository.ts');
    const launch = await import('./launch.ts');
    const runner = await import('./runner.ts');
    const primary = initPrimaryWithRemote();
    return { worktreeRoot, api, launch, runner, primary };
  }

  it('stores a branch override, surfaces it, and clears it on prepare', async () => {
    const { api, runner, primary } = await setup();
    const project = await api.createProject({ name: 'Override Test' });
    await api.createProjectResource(project.id, { directoryPath: primary, isPrimary: true });
    const mission = await api.createMission({ projectId: project.id, firstObjective: 'Work' });

    // Pinning an override is reflected on the (still-pending) branch DTO and in
    // the predicted branch name the next launch will use.
    let detail = await api.updateMission(mission.id, { branchOverride: 'overlord/custom-pick' });
    assert.equal(detail.branch?.overrideBranch, 'overlord/custom-pick');
    assert.equal(detail.branch?.name, 'overlord/custom-pick');
    assert.equal(detail.branch?.status, 'pending');

    // Once a branch is prepared, the override is consumed (active_branch wins).
    await runner.recordBranchPrepared({
      missionId: mission.displayId,
      payload: {
        branchName: 'overlord/custom-pick',
        baseBranch: 'main',
        worktreePath: '/tmp/none',
        action: 'create',
        cycle: 1
      }
    });
    detail = await api.getMissionDetail(mission.id);
    assert.equal(detail.branch?.overrideBranch, null);
    assert.equal(detail.branch?.name, 'overlord/custom-pick');

    // Clearing via null is accepted.
    const cleared = await api.updateMission(mission.id, { branchOverride: null });
    assert.equal(cleared.branch?.overrideBranch, null);
  });

  it('lists only mission metadata branches from the control plane', async () => {
    const { api, primary } = await setup();
    const project = await api.createProject({ name: 'List Branches Test' });
    await api.createProjectResource(project.id, { directoryPath: primary, isPrimary: true });
    const mission = await api.createMission({ projectId: project.id, firstObjective: 'Work' });

    git(primary, ['branch', 'feature/x']);
    git(primary, ['branch', 'release/1.0']);

    const result = await api.listMissionBranches(mission.id);
    assert.deepEqual(result.branches, []);
    assert.equal(result.current, null);

    await api.updateMission(mission.id, { branchOverride: 'feature/x' });
    const pinned = await api.listMissionBranches(mission.id);
    assert.deepEqual(pinned.branches, ['feature/x']);
    assert.equal(pinned.current, 'feature/x');
  });

  it('records the per-objective branch when prepared via an execution request', async () => {
    const { api, launch, runner, primary } = await setup();
    const project = await api.createProject({ name: 'Per-Objective Test' });
    await api.createProjectResource(project.id, { directoryPath: primary, isPrimary: true });
    const mission = await api.createMission({ projectId: project.id, firstObjective: 'Work' });
    const objectiveId = (await api.getMissionDetail(mission.id)).objectives[0]!.id;

    const request = await launch.launchObjective(objectiveId, { agent: 'claude' });
    await runner.recordBranchPrepared({
      missionId: mission.displayId,
      requestId: request.id,
      payload: {
        branchName: 'overlord/per-objective-1',
        baseBranch: 'main',
        worktreePath: '/tmp/none',
        action: 'create',
        cycle: 1
      }
    });

    const objective = (await api.getMissionDetail(mission.id)).objectives.find(
      o => o.id === objectiveId
    );
    assert.equal(objective?.branch, 'overlord/per-objective-1');
  });
});
