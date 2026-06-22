import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

// Guards the git-derived `TicketBranchDto.status` vocabulary. The reported bug was
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

  it('reports created / published / merged from real git state', async () => {
    const dir = mkdtempSync(path.join('/tmp', 'ovld-branch-status-'));
    process.env.OVERLORD_SQLITE_PATH = path.join(dir, 'Overlord.sqlite');

    const { createProject, createTicket, getTicketDetail, createProjectResource } = await import(
      './repository.ts'
    );
    const { recordBranchPrepared } = await import('./runner.ts');

    const repo = initRepo();
    const project = createProject({ name: 'Branch Status Test' });
    createProjectResource(project.id, { directoryPath: repo, isPrimary: true });

    const prepare = (ticketDisplayId: string, branchName: string): void => {
      recordBranchPrepared({
        ticketId: ticketDisplayId,
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
    const createdTicket = createTicket({ projectId: project.id, firstObjective: 'Fresh branch' });
    const createdBranch = 'overlord/fresh-1';
    git(repo, ['branch', createdBranch, 'main']);
    prepare(createdTicket.displayId, createdBranch);
    assert.equal(getTicketDetail(createdTicket.id).branch?.status, 'created');

    // 2. Branch with its own commit, pushed to origin (remote ref present) → published.
    const publishedTicket = createTicket({
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
    prepare(publishedTicket.displayId, publishedBranch);
    assert.equal(getTicketDetail(publishedTicket.id).branch?.status, 'published');

    // 3. Branch whose commits have landed in main via a (non-ff) merge → merged.
    const mergedTicket = createTicket({ projectId: project.id, firstObjective: 'Merged branch' });
    const mergedBranch = 'overlord/merged-1';
    git(repo, ['branch', mergedBranch, 'main']);
    git(repo, ['checkout', '-q', mergedBranch]);
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'work on merged']);
    git(repo, ['checkout', '-q', 'main']);
    git(repo, ['merge', '-q', '--no-ff', '-m', 'merge', mergedBranch]);
    prepare(mergedTicket.displayId, mergedBranch);
    assert.equal(getTicketDetail(mergedTicket.id).branch?.status, 'merged');
  });
});
