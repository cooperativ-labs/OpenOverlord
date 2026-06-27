import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

// Exercises the AI commit-message draft endpoint
// (POST /api/missions/:id/generate-commit-message) against a real worktree. The
// Gemini call itself is not exercised (no key in CI); these cover the
// deterministic, host-side gating: a clean worktree has nothing to draft, and an
// unconfigured summarizer surfaces a typed failure rather than an empty draft.
describe('generate commit message', () => {
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

  function initPrimary(): string {
    const primary = mkdtempSync(path.join('/tmp', 'ovld-gcm-primary-'));
    git(primary, ['init', '-q', '-b', 'main']);
    writeFileSync(path.join(primary, 'a.txt'), 'a\n');
    git(primary, ['add', '.']);
    git(primary, ['commit', '-q', '-m', 'base']);
    return primary;
  }

  async function setup(): Promise<{
    worktreeRoot: string;
    api: typeof import('./repository.ts');
    runner: typeof import('./runner.ts');
    primary: string;
  }> {
    const dir = mkdtempSync(path.join('/tmp', 'ovld-gcm-db-'));
    const worktreeRoot = mkdtempSync(path.join('/tmp', 'ovld-gcm-wt-'));
    process.env.OVERLORD_WORKTREE_ROOT = worktreeRoot;
    // Ensure the summarizer reads as unconfigured for the failure-path test.
    delete process.env.GEMINI_API_KEY;
    const { bootstrapIntegrationTestDb } = await import('./test-helpers.ts');
    await bootstrapIntegrationTestDb({ sqlitePath: path.join(dir, 'Overlord.sqlite') });
    const api = await import('./repository.ts');
    const runner = await import('./runner.ts');
    return { worktreeRoot, api, runner, primary: initPrimary() };
  }

  it('rejects a clean worktree with nothing to draft from', async () => {
    const { worktreeRoot, api, runner, primary } = await setup();
    const project = await api.createProject({ name: 'Draft Clean Test' });
    await api.createProjectResource(project.id, { directoryPath: primary, isPrimary: true });
    const mission = await api.createMission({ projectId: project.id, firstObjective: 'Work' });

    const branchName = 'feat-draft-clean';
    const worktreePath = path.join(worktreeRoot, project.slug, branchLeaf(branchName));
    git(primary, ['worktree', 'add', '-q', '-b', branchName, worktreePath, 'main']);
    await runner.recordBranchPrepared({
      missionId: mission.displayId,
      payload: { branchName, baseBranch: 'main', worktreePath, action: 'create', cycle: 1 }
    });

    await assert.rejects(
      api.generateCommitMessage(mission.id),
      (err: unknown) => (err as { code?: string }).code === 'BRANCH_NOTHING_TO_COMMIT'
    );
  });

  it('surfaces a typed failure when the summarizer is unconfigured', async () => {
    const { worktreeRoot, api, runner, primary } = await setup();
    const project = await api.createProject({ name: 'Draft Unconfigured Test' });
    await api.createProjectResource(project.id, { directoryPath: primary, isPrimary: true });
    const mission = await api.createMission({ projectId: project.id, firstObjective: 'Work' });

    const branchName = 'feat-draft-dirty';
    const worktreePath = path.join(worktreeRoot, project.slug, branchLeaf(branchName));
    git(primary, ['worktree', 'add', '-q', '-b', branchName, worktreePath, 'main']);
    // Uncommitted work so the diff gather succeeds and the Gemini call is attempted.
    writeFileSync(path.join(worktreePath, 'b.txt'), 'b\n');
    await runner.recordBranchPrepared({
      missionId: mission.displayId,
      payload: { branchName, baseBranch: 'main', worktreePath, action: 'create', cycle: 1 }
    });
    assert.equal((await api.getMissionDetail(mission.id)).branch?.dirty, true);

    await assert.rejects(
      api.generateCommitMessage(mission.id),
      (err: unknown) => (err as { code?: string }).code === 'COMMIT_MESSAGE_GENERATION_FAILED'
    );
  });
});
