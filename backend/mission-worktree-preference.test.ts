import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

// Per-mission worktree/branch opt-in (coo:9). When the workspace
// `worktreeBranchAutomationEnabled` setting is off, a mission runs off its base
// branch (`willPrepareBranch` false) unless it carries a per-mission
// `worktreePreference`. Setting `'worktree'`/`'branch'` opts the single mission
// in; clearing it (null) reverts to inheriting the workspace setting.
describe('per-mission worktree preference', () => {
  it('resolves willPrepareBranch / willUseWorktree from the setting and per-mission preference', async () => {
    const dir = mkdtempSync(path.join('/tmp', 'ovld-wt-pref-'));
    const { bootstrapIntegrationTestDb } = await import('./test-helpers.ts');
    await bootstrapIntegrationTestDb({ sqlitePath: path.join(dir, 'Overlord.sqlite') });

    const { createProject, createMission, getMissionDetail, updateMission } =
      await import('./repository.ts');
    const { updateWorktreeBranchAutomation } = await import('./launch.ts');

    const project = await createProject({ name: 'Worktree Preference Test' });

    // Workspace automation OFF (the default) and no per-mission preference: the
    // mission works off its base branch — the header shows "main".
    updateWorktreeBranchAutomation({ enabled: false });
    const mission = await createMission({ projectId: project.id, firstObjective: 'Default off' });
    let branch = (await getMissionDetail(mission.id)).branch;
    assert.equal(branch?.worktreeAutomationEnabled, false);
    assert.equal(branch?.worktreePreference, null);
    assert.equal(branch?.willPrepareBranch, false);
    assert.equal(branch?.willUseWorktree, false);

    // Opt this mission into a branch + worktree while automation stays off.
    branch = (await updateMission(mission.id, { worktreePreference: 'worktree' })).branch;
    assert.equal(branch?.worktreePreference, 'worktree');
    assert.equal(branch?.willPrepareBranch, true);
    assert.equal(branch?.willUseWorktree, true);

    // Opt into a branch WITHOUT a worktree (the checkbox unchecked).
    branch = (await updateMission(mission.id, { worktreePreference: 'branch' })).branch;
    assert.equal(branch?.worktreePreference, 'branch');
    assert.equal(branch?.willPrepareBranch, true);
    assert.equal(branch?.willUseWorktree, false);

    // Clearing the preference reverts to the base branch.
    branch = (await updateMission(mission.id, { worktreePreference: null })).branch;
    assert.equal(branch?.worktreePreference, null);
    assert.equal(branch?.willPrepareBranch, false);
    assert.equal(branch?.willUseWorktree, false);

    // With automation ON, a mission with no preference inherits worktree behavior.
    updateWorktreeBranchAutomation({ enabled: true });
    branch = (await getMissionDetail(mission.id)).branch;
    assert.equal(branch?.worktreeAutomationEnabled, true);
    assert.equal(branch?.willPrepareBranch, true);
    assert.equal(branch?.willUseWorktree, true);

    // A per-mission 'branch' preference still wins (branch without a worktree)
    // even while automation is globally on.
    branch = (await updateMission(mission.id, { worktreePreference: 'branch' })).branch;
    assert.equal(branch?.willPrepareBranch, true);
    assert.equal(branch?.willUseWorktree, false);
  });

  it('rejects an invalid worktreePreference value', async () => {
    const dir = mkdtempSync(path.join('/tmp', 'ovld-wt-pref-invalid-'));
    const { bootstrapIntegrationTestDb } = await import('./test-helpers.ts');
    await bootstrapIntegrationTestDb({ sqlitePath: path.join(dir, 'Overlord.sqlite') });

    const { createProject, createMission, updateMission } = await import('./repository.ts');
    const project = await createProject({ name: 'Worktree Preference Invalid' });
    const mission = await createMission({ projectId: project.id, firstObjective: 'Bad value' });

    await assert.rejects(
      updateMission(mission.id, { worktreePreference: 'nope' as never }),
      /worktreePreference/
    );
  });

  it('clears active_branch when resetActiveBranch is true', async () => {
    const dir = mkdtempSync(path.join('/tmp', 'ovld-wt-pref-reset-'));
    const { bootstrapIntegrationTestDb } = await import('./test-helpers.ts');
    await bootstrapIntegrationTestDb({ sqlitePath: path.join(dir, 'Overlord.sqlite') });

    const { createProject, createMission, updateMission } = await import('./repository.ts');
    const { recordBranchPrepared } = await import('./runner.ts');

    const project = await createProject({ name: 'Reset Active Branch' });
    const mission = await createMission({ projectId: project.id, firstObjective: 'Switch later' });
    await updateMission(mission.id, { worktreePreference: 'worktree' });
    await recordBranchPrepared({
      missionId: mission.displayId,
      payload: {
        branchName: 'overlord/switch-later-1',
        baseBranch: 'main',
        worktreePath: '/tmp/none',
        resourceKey: 'primary-repo',
        action: 'create',
        cycle: 1
      }
    });

    const reset = await updateMission(mission.id, {
      branchOverride: 'feature/other',
      resetActiveBranch: true
    });
    assert.equal(reset.branch?.name, 'feature/other');
    assert.equal(reset.branch?.status, 'pending');
    assert.equal(reset.branch?.overrideBranch, 'feature/other');

    await assert.rejects(
      updateMission(mission.id, { resetActiveBranch: true }),
      /no prepared branch/i
    );
  });
});
