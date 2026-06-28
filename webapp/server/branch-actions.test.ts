import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

// Control-plane branch actions (WS-F3): git runs on the client; the server records
// activity when `clientExecuted` is true and rejects direct git mutations otherwise.
describe('branch actions', () => {
  async function setup(): Promise<{
    api: typeof import('./repository.ts');
    runner: typeof import('./runner.ts');
  }> {
    const dir = mkdtempSync(path.join('/tmp', 'ovld-ba-db-'));
    const { bootstrapIntegrationTestDb } = await import('./test-helpers.ts');
    await bootstrapIntegrationTestDb({ sqlitePath: path.join(dir, 'Overlord.sqlite') });
    const api = await import('./repository.ts');
    const runner = await import('./runner.ts');
    return { api, runner };
  }

  it('rejects server-side git mutations without clientExecuted', async () => {
    const { api, runner } = await setup();
    const project = await api.createProject({ name: 'Branch Actions Test' });
    await api.createProjectResource(project.id, {
      directoryPath: '/tmp/primary-repo',
      isPrimary: true
    });
    const mission = await api.createMission({ projectId: project.id, firstObjective: 'Work' });

    await runner.recordBranchPrepared({
      missionId: mission.displayId,
      payload: {
        branchName: 'feat-1',
        baseBranch: 'main',
        worktreePath: '/tmp/wt',
        action: 'create',
        cycle: 1
      }
    });

    await assert.rejects(
      api.performBranchAction(mission.id, { action: 'integrate' }),
      (err: unknown) => (err as { code?: string }).code === 'LOCAL_FILESYSTEM_UNAVAILABLE'
    );
  });

  it('records activity when the client reports a successful branch action', async () => {
    const { api, runner } = await setup();
    const project = await api.createProject({ name: 'Client Branch Action Test' });
    await api.createProjectResource(project.id, {
      directoryPath: '/tmp/primary-repo',
      isPrimary: true
    });
    const mission = await api.createMission({ projectId: project.id, firstObjective: 'Work' });

    await runner.recordBranchPrepared({
      missionId: mission.displayId,
      payload: {
        branchName: 'feat-1',
        baseBranch: 'main',
        worktreePath: '/tmp/wt',
        action: 'create',
        cycle: 1
      }
    });

    const detail = await api.performBranchAction(mission.id, {
      action: 'integrate',
      clientExecuted: true,
      summary: 'Merged main into feat-1'
    });
    assert.equal(detail.branch?.name, 'feat-1');
  });
});
