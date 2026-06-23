import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

// Exercises objective-3 features end to end against real git repos:
//  - branch override: stored on the ticket, surfaced on TicketBranchDto, cleared
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

  function branchLeaf(branch: string): string {
    return branch.replace(/[\\/]+/g, '-').replace(/^-+|-+$/g, '');
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
    process.env.OVERLORD_SQLITE_PATH = path.join(dir, 'Overlord.sqlite');
    const worktreeRoot = mkdtempSync(path.join('/tmp', 'ovld-bsw-wt-'));
    process.env.OVERLORD_WORKTREE_ROOT = worktreeRoot;
    const api = await import('./repository.ts');
    const launch = await import('./launch.ts');
    const runner = await import('./runner.ts');
    const primary = initPrimaryWithRemote();
    return { worktreeRoot, api, launch, runner, primary };
  }

  // Creates a branch in its own worktree with one commit on top of main.
  function makeBranchWorktree(
    git_: typeof git,
    primary: string,
    worktreeRoot: string,
    projectSlug: string,
    branchName: string
  ): string {
    const worktreePath = path.join(worktreeRoot, projectSlug, branchLeaf(branchName));
    git_(primary, ['worktree', 'add', '-q', '-b', branchName, worktreePath, 'main']);
    // A file unique to the branch so the commit always introduces a change even
    // when main already contains earlier branches' files (e.g. after a merge).
    const file = `${branchLeaf(branchName)}.txt`;
    writeFileSync(path.join(worktreePath, file), `${file}\n`);
    git_(worktreePath, ['add', '.']);
    git_(worktreePath, ['commit', '-q', '-m', `work ${branchName}`]);
    return worktreePath;
  }

  it('stores a branch override, surfaces it, and clears it on prepare', async () => {
    const { api, runner, primary } = await setup();
    const project = api.createProject({ name: 'Override Test' });
    api.createProjectResource(project.id, { directoryPath: primary, isPrimary: true });
    const ticket = api.createTicket({ projectId: project.id, firstObjective: 'Work' });

    // Pinning an override is reflected on the (still-pending) branch DTO and in
    // the predicted branch name the next launch will use.
    let detail = api.updateTicket(ticket.id, { branchOverride: 'overlord/custom-pick' });
    assert.equal(detail.branch?.overrideBranch, 'overlord/custom-pick');
    assert.equal(detail.branch?.name, 'overlord/custom-pick');
    assert.equal(detail.branch?.status, 'pending');

    // Once a branch is prepared, the override is consumed (active_branch wins).
    runner.recordBranchPrepared({
      ticketId: ticket.displayId,
      payload: {
        branchName: 'overlord/custom-pick',
        baseBranch: 'main',
        worktreePath: '/tmp/none',
        action: 'create',
        cycle: 1
      }
    });
    detail = api.getTicketDetail(ticket.id);
    assert.equal(detail.branch?.overrideBranch, null);
    assert.equal(detail.branch?.name, 'overlord/custom-pick');

    // Clearing via null is accepted.
    const cleared = api.updateTicket(ticket.id, { branchOverride: null });
    assert.equal(cleared.branch?.overrideBranch, null);
  });

  it('lists available branches from the project primary repo', async () => {
    const { api, primary } = await setup();
    const project = api.createProject({ name: 'List Branches Test' });
    api.createProjectResource(project.id, { directoryPath: primary, isPrimary: true });
    const ticket = api.createTicket({ projectId: project.id, firstObjective: 'Work' });

    git(primary, ['branch', 'feature/x']);
    git(primary, ['branch', 'release/1.0']);

    const result = api.listTicketBranches(ticket.id);
    assert.ok(result.branches.includes('main'));
    assert.ok(result.branches.includes('feature/x'));
    assert.ok(result.branches.includes('release/1.0'));
    // Sorted, and free of the symbolic origin/HEAD pointer.
    assert.ok(!result.branches.some(b => b.includes('->') || b === 'HEAD'));
  });

  it('records the per-objective branch when prepared via an execution request', async () => {
    const { api, launch, runner, primary } = await setup();
    const project = api.createProject({ name: 'Per-Objective Test' });
    api.createProjectResource(project.id, { directoryPath: primary, isPrimary: true });
    const ticket = api.createTicket({ projectId: project.id, firstObjective: 'Work' });
    const objectiveId = api.getTicketDetail(ticket.id).objectives[0]!.id;

    const request = launch.launchObjective(objectiveId, { agent: 'claude' });
    runner.recordBranchPrepared({
      ticketId: ticket.displayId,
      requestId: request.id,
      payload: {
        branchName: 'overlord/per-objective-1',
        baseBranch: 'main',
        worktreePath: '/tmp/none',
        action: 'create',
        cycle: 1
      }
    });

    const objective = api.getTicketDetail(ticket.id).objectives.find(o => o.id === objectiveId);
    assert.equal(objective?.branch, 'overlord/per-objective-1');
  });

  it('lists worktrees and removes a single one', async () => {
    const { worktreeRoot, api, primary } = await setup();
    const project = api.createProject({ name: 'Worktree List Test' });
    api.createProjectResource(project.id, { directoryPath: primary, isPrimary: true });

    const wtA = makeBranchWorktree(git, primary, worktreeRoot, project.slug, 'overlord/wt-a');
    makeBranchWorktree(git, primary, worktreeRoot, project.slug, 'overlord/wt-b');

    const list = api.listWorktrees();
    const paths = list.map(w => w.path);
    assert.ok(paths.includes(path.resolve(wtA)));
    assert.equal(list.length, 2);
    // The primary repo itself is never listed as a managed worktree.
    assert.ok(!paths.includes(path.resolve(primary)));

    const result = api.removeWorktree({ path: wtA });
    assert.deepEqual(result.removed, [path.resolve(wtA)]);
    assert.equal(existsSync(wtA), false);
    assert.equal(result.worktrees.length, 1);
  });

  it('refuses to remove a dirty worktree without force', async () => {
    const { worktreeRoot, api, primary } = await setup();
    const project = api.createProject({ name: 'Dirty Worktree Test' });
    api.createProjectResource(project.id, { directoryPath: primary, isPrimary: true });
    const wt = makeBranchWorktree(git, primary, worktreeRoot, project.slug, 'overlord/dirty');
    writeFileSync(path.join(wt, 'uncommitted.txt'), 'dirty\n');

    assert.throws(
      () => api.removeWorktree({ path: wt }),
      (err: unknown) => (err as { code?: string }).code === 'WORKTREE_DIRTY'
    );
    assert.equal(existsSync(wt), true);
    // Force removes it.
    const forced = api.removeWorktree({ path: wt, force: true });
    assert.deepEqual(forced.removed, [path.resolve(wt)]);
  });

  it('purge-merged removes only merged, clean worktrees', async () => {
    const { worktreeRoot, api, runner, primary } = await setup();
    const project = api.createProject({ name: 'Purge Merged Test' });
    api.createProjectResource(project.id, { directoryPath: primary, isPrimary: true });

    // Merged branch: integrate + push so it reads merged, then push_parent auto-
    // removes its worktree — so use a separate branch we merge manually instead.
    const merged = makeBranchWorktree(git, primary, worktreeRoot, project.slug, 'overlord/merged');
    git(primary, ['merge', '--no-ff', '--no-edit', '-m', 'merge', 'overlord/merged']);
    git(primary, ['push', '-q', 'origin', 'main']);

    // Active branch: a commit not in main.
    const active = makeBranchWorktree(git, primary, worktreeRoot, project.slug, 'overlord/active');

    // A ticket maps the merged branch so status derivation marks it merged.
    const ticket = api.createTicket({ projectId: project.id, firstObjective: 'Work' });
    runner.recordBranchPrepared({
      ticketId: ticket.displayId,
      payload: {
        branchName: 'overlord/merged',
        baseBranch: 'main',
        worktreePath: merged,
        action: 'create',
        cycle: 1
      }
    });

    const result = api.purgeMergedWorktrees();
    assert.deepEqual(result.removed, [path.resolve(merged)]);
    assert.equal(existsSync(merged), false);
    assert.equal(existsSync(active), true);
  });

  it('push_parent auto-removes the merged branch worktree', async () => {
    const { worktreeRoot, api, runner, primary } = await setup();
    const project = api.createProject({ name: 'Auto Remove Test' });
    api.createProjectResource(project.id, { directoryPath: primary, isPrimary: true });
    const ticket = api.createTicket({ projectId: project.id, firstObjective: 'Work' });

    const branchName = 'overlord/auto-remove';
    const worktreePath = makeBranchWorktree(git, primary, worktreeRoot, project.slug, branchName);

    runner.recordBranchPrepared({
      ticketId: ticket.displayId,
      payload: { branchName, baseBranch: 'main', worktreePath, action: 'create', cycle: 1 }
    });

    api.performBranchAction(ticket.id, { action: 'integrate' });
    assert.equal(existsSync(worktreePath), true);
    const afterPush = api.performBranchAction(ticket.id, { action: 'push_parent' });
    assert.equal(afterPush.branch?.status, 'merged');
    // The merged worktree is cleaned up automatically.
    assert.equal(existsSync(worktreePath), false);
  });
});
