import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

// Guards the git-derived `MissionBranchDto.status` vocabulary. The reported bug was
// that a branch freshly cut from `main` (no commits of its own) showed as "merged",
// because `git branch --merged main` lists every branch whose tip is reachable from
// main. Merge detection now requires the branch to have diverged from the base, so a
// just-created branch reads "created", a pushed branch reads "published", and only a
// branch whose own commits have landed in the base reads "merged".
describe('branch status derivation', () => {
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

  function initRepo(): string {
    const repo = mkdtempSync(path.join('/tmp', 'ovld-branch-status-repo-'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'base']);
    return repo;
  }

  it('reports created / published / merged_unpushed / merged from real git state', async () => {
    const dir = mkdtempSync(path.join('/tmp', 'ovld-branch-status-'));
    process.env.OVERLORD_SQLITE_PATH = path.join(dir, 'Overlord.sqlite');

    const { createProject, createMission, getMissionDetail, createProjectResource } =
      await import('./repository.ts');
    const { recordBranchPrepared } = await import('./runner.ts');

    const repo = initRepo();
    const project = createProject({ name: 'Branch Status Test' });
    createProjectResource(project.id, { directoryPath: repo, isPrimary: true });

    const prepare = (missionDisplayId: string, branchName: string): void => {
      recordBranchPrepared({
        missionId: missionDisplayId,
        payload: {
          branchName,
          baseBranch: 'main',
          worktreePath: path.join(dir, branchName.replace(/\//g, '-')),
          action: 'create',
          cycle: 1
        }
      });
    };

    // 1. Freshly created branch (tip identical to main, zero unique commits) → created.
    const createdMission = createMission({ projectId: project.id, firstObjective: 'Fresh branch' });
    const createdBranch = 'overlord/fresh-1';
    git(repo, ['branch', createdBranch, 'main']);
    prepare(createdMission.displayId, createdBranch);
    assert.equal(getMissionDetail(createdMission.id).branch?.status, 'created');

    // 2. Branch with its own commit, pushed to origin (remote ref present) → published.
    const publishedMission = createMission({
      projectId: project.id,
      firstObjective: 'Published branch'
    });
    const publishedBranch = 'overlord/published-1';
    git(repo, ['branch', publishedBranch, 'main']);
    git(repo, ['checkout', '-q', publishedBranch]);
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'work on published']);
    const publishedSha = git(repo, ['rev-parse', publishedBranch]);
    git(repo, ['checkout', '-q', 'main']);
    git(repo, ['update-ref', `refs/remotes/origin/${publishedBranch}`, publishedSha]);
    prepare(publishedMission.displayId, publishedBranch);
    assert.equal(getMissionDetail(publishedMission.id).branch?.status, 'published');

    // 3. Branch merged into LOCAL main via a (non-ff) merge, but origin/main not
    //    updated → merged_unpushed (the gap between merge Action A and push B).
    const mergedMission = createMission({ projectId: project.id, firstObjective: 'Merged branch' });
    const mergedBranch = 'overlord/merged-1';
    git(repo, ['branch', mergedBranch, 'main']);
    git(repo, ['checkout', '-q', mergedBranch]);
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'work on merged']);
    git(repo, ['checkout', '-q', 'main']);
    git(repo, ['merge', '-q', '--no-ff', '-m', 'merge', mergedBranch]);
    prepare(mergedMission.displayId, mergedBranch);
    assert.equal(getMissionDetail(mergedMission.id).branch?.status, 'merged_unpushed');

    // 4. After the merged parent is pushed (origin/main now contains the branch),
    //    the same branch reads merged.
    git(repo, ['update-ref', 'refs/remotes/origin/main', git(repo, ['rev-parse', 'main'])]);
    assert.equal(getMissionDetail(mergedMission.id).branch?.status, 'merged');

    // 5. An EMPTY branch the base merely advanced PAST is NOT merged. `empty-1`
    //    is cut from the ORIGINAL base commit with no commits of its own; main has
    //    since moved forward (via the unrelated merge above + push), so origin/main
    //    now *contains* empty-1's tip. Containment alone used to misreport this as
    //    "merged" — but the branch never landed via a merge, so its tip stays on
    //    main's first-parent trunk and it must read "created".
    const emptyMission = createMission({ projectId: project.id, firstObjective: 'Empty branch' });
    const emptyBranch = 'overlord/empty-1';
    const rootCommit = git(repo, ['rev-list', '--max-parents=0', 'main']);
    git(repo, ['branch', emptyBranch, rootCommit]);
    prepare(emptyMission.displayId, emptyBranch);
    assert.equal(getMissionDetail(emptyMission.id).branch?.status, 'created');
  });

  it('uses the project-configured default branch as the mission base/parent', async () => {
    const dir = mkdtempSync(path.join('/tmp', 'ovld-default-branch-'));
    process.env.OVERLORD_SQLITE_PATH = path.join(dir, 'Overlord.sqlite');

    const { createProject, createMission, getMissionDetail, getProject, updateProject } =
      await import('./repository.ts');

    const project = createProject({ name: 'Default Branch Test' });
    // Unconfigured: falls back to main.
    assert.equal(getProject(project.id).defaultBranch, null);
    const beforeMission = createMission({ projectId: project.id, firstObjective: 'Before config' });
    assert.equal(getMissionDetail(beforeMission.id).branch?.baseBranch, 'main');

    // Configure a project default branch; it surfaces on the DTO and as the base.
    const updated = updateProject(project.id, { defaultBranch: 'develop' });
    assert.equal(updated.defaultBranch, 'develop');
    const afterMission = createMission({ projectId: project.id, firstObjective: 'After config' });
    assert.equal(getMissionDetail(afterMission.id).branch?.baseBranch, 'develop');

    // Invalid branch names are rejected at the REST boundary.
    assert.throws(() => updateProject(project.id, { defaultBranch: 'bad branch name' }));

    // Clearing falls back to main again.
    assert.equal(updateProject(project.id, { defaultBranch: null }).defaultBranch, null);
    const clearedMission = createMission({ projectId: project.id, firstObjective: 'Cleared' });
    assert.equal(getMissionDetail(clearedMission.id).branch?.baseBranch, 'main');
  });
});
