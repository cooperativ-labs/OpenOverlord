import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

// Control-plane commit-message drafting (WS-F3): diff gathering is client-owned;
// the server summarizes an uploaded diff only.
describe('generate commit message', () => {
  async function setup(): Promise<{
    api: typeof import('./repository.ts');
    runner: typeof import('./runner.ts');
  }> {
    const dir = mkdtempSync(path.join('/tmp', 'ovld-gcm-db-'));
    delete process.env.GEMINI_API_KEY;
    const { bootstrapIntegrationTestDb } = await import('./test-helpers.ts');
    await bootstrapIntegrationTestDb({ sqlitePath: path.join(dir, 'Overlord.sqlite') });
    const api = await import('./repository.ts');
    const runner = await import('./runner.ts');
    return { api, runner };
  }

  it('rejects when no client diff is supplied', async () => {
    const { api, runner } = await setup();
    const project = await api.createProject({ name: 'Draft Clean Test' });
    await api.createProjectResource(project.id, {
      directoryPath: '/tmp/primary-repo',
      isPrimary: true
    });
    const mission = await api.createMission({ projectId: project.id, firstObjective: 'Work' });

    await runner.recordBranchPrepared({
      missionId: mission.displayId,
      payload: {
        branchName: 'feat-draft',
        baseBranch: 'main',
        worktreePath: '/tmp/wt',
        action: 'create',
        cycle: 1
      }
    });

    await assert.rejects(
      api.generateCommitMessage(mission.id),
      (err: unknown) => (err as { code?: string }).code === 'LOCAL_FILESYSTEM_UNAVAILABLE'
    );
  });

  it('surfaces a typed failure when the summarizer is unconfigured', async () => {
    const { api, runner } = await setup();
    const project = await api.createProject({ name: 'Draft Unconfigured Test' });
    await api.createProjectResource(project.id, {
      directoryPath: '/tmp/primary-repo',
      isPrimary: true
    });
    const mission = await api.createMission({ projectId: project.id, firstObjective: 'Work' });

    await runner.recordBranchPrepared({
      missionId: mission.displayId,
      payload: {
        branchName: 'feat-draft-dirty',
        baseBranch: 'main',
        worktreePath: '/tmp/wt',
        action: 'create',
        cycle: 1
      }
    });

    await assert.rejects(
      api.generateCommitMessage(mission.id, { diff: 'diff --git a/b.txt b/b.txt\n' }),
      (err: unknown) => (err as { code?: string }).code === 'COMMIT_MESSAGE_GENERATION_FAILED'
    );
  });
});
