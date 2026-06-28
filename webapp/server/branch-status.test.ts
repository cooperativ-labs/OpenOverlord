import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

// Control-plane mission branch metadata (WS-F3): live git status is client-observed;
// the server surfaces DB/planner fields and conservative defaults.
describe('branch status derivation', () => {
  it('reports a conservative created status for prepared branches', async () => {
    const dir = mkdtempSync(path.join('/tmp', 'ovld-branch-status-'));
    const { bootstrapIntegrationTestDb } = await import('./test-helpers.ts');
    await bootstrapIntegrationTestDb({ sqlitePath: path.join(dir, 'Overlord.sqlite') });

    const { createProject, createMission, getMissionDetail, createProjectResource } =
      await import('./repository.ts');
    const { recordBranchPrepared } = await import('./runner.ts');

    const project = await createProject({ name: 'Branch Status Test' });
    await createProjectResource(project.id, {
      directoryPath: '/tmp/repo',
      isPrimary: true
    });
    const mission = await createMission({
      projectId: project.id,
      firstObjective: 'Prepared branch'
    });

    await recordBranchPrepared({
      missionId: mission.displayId,
      payload: {
        branchName: 'feat-1',
        baseBranch: 'main',
        worktreePath: path.join(dir, 'wt'),
        action: 'create',
        cycle: 1
      }
    });

    const detail = await getMissionDetail(mission.id);
    assert.equal(detail.branch?.status, 'created');
    assert.equal(detail.branch?.dirty, false);
  });

  it('uses project defaultBranch and falls back to main without git inspection', async () => {
    const dir = mkdtempSync(path.join('/tmp', 'ovld-default-branch-'));
    const { bootstrapIntegrationTestDb } = await import('./test-helpers.ts');
    await bootstrapIntegrationTestDb({ sqlitePath: path.join(dir, 'Overlord.sqlite') });

    const {
      createProject,
      createMission,
      createProjectResource,
      getMissionDetail,
      getProject,
      updateProject
    } = await import('./repository.ts');

    const project = await createProject({ name: 'Default Branch Test' });
    await createProjectResource(project.id, {
      directoryPath: '/tmp/repo',
      isPrimary: true
    });

    assert.equal((await getProject(project.id)).defaultBranch, null);
    const beforeMission = await createMission({
      projectId: project.id,
      firstObjective: 'Before config'
    });
    assert.equal((await getMissionDetail(beforeMission.id)).branch?.baseBranch, 'main');

    const updated = await updateProject(project.id, { defaultBranch: 'develop' });
    assert.equal(updated.defaultBranch, 'develop');
    const afterMission = await createMission({
      projectId: project.id,
      firstObjective: 'After config'
    });
    assert.equal((await getMissionDetail(afterMission.id)).branch?.baseBranch, 'develop');

    await assert.rejects(updateProject(project.id, { defaultBranch: 'bad branch name' }));

    assert.equal((await updateProject(project.id, { defaultBranch: null })).defaultBranch, null);
    const clearedMission = await createMission({
      projectId: project.id,
      firstObjective: 'Cleared'
    });
    assert.equal((await getMissionDetail(clearedMission.id)).branch?.baseBranch, 'main');
  });

  it('keeps a prepared mission tied to the base branch recorded by the runner', async () => {
    const dir = mkdtempSync(path.join('/tmp', 'ovld-prepared-base-'));
    const { bootstrapIntegrationTestDb } = await import('./test-helpers.ts');
    await bootstrapIntegrationTestDb({ sqlitePath: path.join(dir, 'Overlord.sqlite') });

    const { createProject, createMission, createProjectResource, getMissionDetail } =
      await import('./repository.ts');
    const { recordBranchPrepared } = await import('./runner.ts');

    const project = await createProject({ name: 'Prepared Base Test' });
    await createProjectResource(project.id, {
      directoryPath: '/tmp/repo',
      isPrimary: true
    });
    const mission = await createMission({ projectId: project.id, firstObjective: 'Prepared work' });

    await recordBranchPrepared({
      missionId: mission.displayId,
      payload: {
        branchName: 'feat-prepared',
        baseBranch: 'release/prepared',
        worktreePath: path.join(dir, 'wt'),
        action: 'create',
        cycle: 1
      }
    });

    const detail = await getMissionDetail(mission.id);
    assert.equal(detail.branch?.baseBranch, 'release/prepared');
    assert.equal(detail.branch?.status, 'created');
  });
});
