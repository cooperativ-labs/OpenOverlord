import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  computeMergedBranches,
  prepareMissionBranch,
  resolveMissionProjectSlug
} from '../src/branch-preparation.ts';
import type { CliRuntime } from '../src/runtime.ts';

function runtimeWithProjects(projects: unknown[], calls: string[] = []): CliRuntime {
  return {
    backend: {
      baseUrl: 'http://localhost.test',
      health: async () => ({ ok: true }),
      get: async path => {
        calls.push(path);
        if (path === '/api/projects') return projects as never;
        throw new Error(`unexpected GET ${path}`);
      },
      post: async () => null as never,
      patch: async () => null as never,
      delete: async () => null as never
    },
    close: () => {}
  };
}

test('resolveMissionProjectSlug uses embedded mission project slug when present', async () => {
  const calls: string[] = [];
  const slug = await resolveMissionProjectSlug({
    runtime: runtimeWithProjects([{ id: 'p1', slug: 'from-api' }], calls),
    mission: { projectId: 'p1', project: { slug: 'from-mission' } }
  });

  assert.equal(slug, 'from-mission');
  assert.deepEqual(calls, []);
});

test('resolveMissionProjectSlug reads existing project slug from project list', async () => {
  const slug = await resolveMissionProjectSlug({
    runtime: runtimeWithProjects([
      { id: 'p1', slug: 'alpha' },
      { id: 'p2', slug: 'overlord' }
    ]),
    mission: { projectId: 'p2' }
  });

  assert.equal(slug, 'overlord');
});

test('resolveMissionProjectSlug falls back for unresolved legacy payloads', async () => {
  const slug = await resolveMissionProjectSlug({
    runtime: runtimeWithProjects([{ id: 'p1', slug: 'alpha' }]),
    mission: { projectId: 'missing' }
  });

  assert.equal(slug, 'project');
});

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

function runtimeForMission(mission: Record<string, unknown>): CliRuntime {
  return {
    backend: {
      baseUrl: 'http://localhost.test',
      health: async () => ({ ok: true }),
      get: async (p: string) => {
        if (p === '/api/projects') return [{ id: 'p1', slug: 'demo' }] as never;
        if (p.startsWith('/api/missions/')) return mission as never;
        throw new Error(`unexpected GET ${p}`);
      },
      post: async () => null as never,
      patch: async () => null as never,
      delete: async () => null as never
    },
    close: () => {}
  };
}

function initRepo(prefix: string): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), prefix));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'base']);
  return repo;
}

function canonicalPath(value: string): string {
  return realpathSync(value);
}

test('prepareMissionBranch creates a worktree when the mission resolves to worktree mode', async () => {
  const repo = initRepo('ovld-prep-worktree-');
  const worktreeRoot = mkdtempSync(path.join(os.tmpdir(), 'ovld-prep-wt-root-'));
  process.env.OVERLORD_WORKTREE_ROOT = worktreeRoot;
  try {
    const result = await prepareMissionBranch({
      runtime: runtimeForMission({
        title: 'Add feature',
        sequence: 7,
        projectId: 'p1',
        project: { slug: 'demo' },
        branch: { baseBranch: 'main', willPrepareBranch: true, willUseWorktree: true }
      }),
      options: {
        missionId: 'coo:7',
        workingDirectory: repo,
        workspaceAutomationEnabled: false
      }
    });
    assert.ok(result.branchAutomation, 'expected a branch automation payload');
    assert.equal(result.workingDirectory, result.branchAutomation?.worktreePath);
    assert.ok(result.workingDirectory.startsWith(worktreeRoot), 'worktree under the worktree root');
    // The branch is checked out in a *separate* worktree, not the primary repo.
    const list = git(repo, ['worktree', 'list', '--porcelain']);
    assert.ok(list.includes(result.workingDirectory), 'a dedicated worktree was registered');
  } finally {
    delete process.env.OVERLORD_WORKTREE_ROOT;
  }
});

test('prepareMissionBranch falls back to the primary checkout branch as base', async () => {
  const repo = initRepo('ovld-prep-current-base-');
  const worktreeRoot = mkdtempSync(path.join(os.tmpdir(), 'ovld-prep-current-base-wt-'));
  process.env.OVERLORD_WORKTREE_ROOT = worktreeRoot;
  git(repo, ['checkout', '-q', '-b', 'release/current']);
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'release base']);

  try {
    const result = await prepareMissionBranch({
      runtime: runtimeForMission({
        title: 'Use checked out base',
        sequence: 12,
        projectId: 'p1',
        project: { slug: 'demo' },
        branch: { willPrepareBranch: true, willUseWorktree: true }
      }),
      options: {
        missionId: 'coo:12',
        workingDirectory: repo,
        workspaceAutomationEnabled: false
      }
    });

    assert.equal(result.branchAutomation?.baseBranch, 'release/current');
    assert.equal(
      git(repo, ['rev-parse', result.branchAutomation!.branchName]),
      git(repo, ['rev-parse', 'release/current'])
    );
  } finally {
    delete process.env.OVERLORD_WORKTREE_ROOT;
  }
});

test('prepareMissionBranch ignores a linked worktree checkout when resolving the base', async () => {
  const repo = initRepo('ovld-prep-primary-base-');
  const worktreeRoot = mkdtempSync(path.join(os.tmpdir(), 'ovld-prep-primary-base-wt-'));
  process.env.OVERLORD_WORKTREE_ROOT = worktreeRoot;
  git(repo, ['checkout', '-q', '-b', 'release/primary']);
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'primary base']);
  const linked = mkdtempSync(path.join(os.tmpdir(), 'ovld-prep-linked-'));
  git(repo, ['worktree', 'add', '-q', '-b', 'scratch/worktree', linked, 'main']);

  try {
    const result = await prepareMissionBranch({
      runtime: runtimeForMission({
        title: 'Use primary checkout',
        sequence: 13,
        projectId: 'p1',
        project: { slug: 'demo' },
        branch: { willPrepareBranch: true, willUseWorktree: true }
      }),
      options: {
        missionId: 'coo:13',
        workingDirectory: linked,
        workspaceAutomationEnabled: false
      }
    });

    assert.equal(result.branchAutomation?.baseBranch, 'release/primary');
    assert.equal(
      git(repo, ['rev-parse', result.branchAutomation!.branchName]),
      git(repo, ['rev-parse', 'release/primary'])
    );
  } finally {
    delete process.env.OVERLORD_WORKTREE_ROOT;
  }
});

test('prepareMissionBranch checks the branch out in the primary repo for branch-only mode', async () => {
  const repo = initRepo('ovld-prep-branch-only-');
  const result = await prepareMissionBranch({
    runtime: runtimeForMission({
      title: 'Quick fix',
      sequence: 3,
      projectId: 'p1',
      project: { slug: 'demo' },
      branch: {
        baseBranch: 'main',
        willPrepareBranch: true,
        willUseWorktree: false,
        worktreePreference: 'branch'
      }
    }),
    options: {
      missionId: 'coo:3',
      workingDirectory: repo,
      workspaceAutomationEnabled: false
    }
  });
  assert.ok(result.branchAutomation, 'expected a branch automation payload');
  // Branch-only: the working directory IS the primary repo (no separate worktree).
  assert.equal(canonicalPath(result.workingDirectory), canonicalPath(repo));
  assert.equal(canonicalPath(result.branchAutomation!.worktreePath), canonicalPath(repo));
  // The branch is now checked out in the primary repo.
  assert.equal(git(repo, ['branch', '--show-current']), result.branchAutomation?.branchName);
  // No extra worktree directory was added.
  const worktrees = git(repo, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter(line => line.startsWith('worktree '));
  assert.equal(worktrees.length, 1, 'only the primary repo worktree exists');
});

test('prepareMissionBranch prepares nothing when the mission runs off its base branch', async () => {
  const repo = initRepo('ovld-prep-off-');
  const result = await prepareMissionBranch({
    runtime: runtimeForMission({
      title: 'No branch',
      sequence: 1,
      projectId: 'p1',
      project: { slug: 'demo' },
      branch: { baseBranch: 'main', willPrepareBranch: false, willUseWorktree: false }
    }),
    options: {
      missionId: 'coo:1',
      workingDirectory: repo,
      workspaceAutomationEnabled: false
    }
  });
  assert.equal(result.branchAutomation, null);
  assert.equal(result.workingDirectory, repo);
  assert.equal(git(repo, ['branch', '--show-current']), 'main');
});

test('prepareMissionBranch never touches git on a dry run', async () => {
  const repo = initRepo('ovld-prep-dryrun-');
  const result = await prepareMissionBranch({
    runtime: runtimeForMission({
      branch: { baseBranch: 'main', willPrepareBranch: true, willUseWorktree: true }
    }),
    options: {
      missionId: 'coo:9',
      workingDirectory: repo,
      workspaceAutomationEnabled: true,
      dryRun: true
    }
  });
  assert.equal(result.branchAutomation, null);
  assert.equal(result.workingDirectory, repo);
  assert.equal(git(repo, ['branch', '--show-current']), 'main');
});

test('computeMergedBranches reports only branches that genuinely landed via merge', () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'ovld-merged-branches-'));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'base']);
  const root = git(repo, ['rev-list', '--max-parents=0', 'main']);

  // An empty established branch cut from the base — no commits of its own.
  git(repo, ['branch', 'empty-1', 'main']);

  // A branch with real work that we merge into main with a --no-ff merge commit
  // (the shape Overlord's merge-with-parent flow produces).
  git(repo, ['branch', 'merged-1', 'main']);
  git(repo, ['checkout', '-q', 'merged-1']);
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'work']);
  git(repo, ['checkout', '-q', 'main']);
  git(repo, ['merge', '-q', '--no-ff', '-m', 'merge merged-1', 'merged-1']);

  // main has now advanced past empty-1's tip (the root commit), so the base
  // *contains* empty-1 even though it never landed via a merge.
  git(repo, ['merge-base', '--is-ancestor', root, 'main']);

  const merged = computeMergedBranches(repo, 'main');
  // The genuinely-merged branch is reported...
  assert.ok(merged.includes('merged-1'), `expected merged-1 in ${JSON.stringify(merged)}`);
  // ...but the empty branch the base merely advanced past is NOT (so the planner
  // keeps reusing it instead of cutting a new cycle branch per objective).
  assert.ok(!merged.includes('empty-1'), `empty-1 should not be merged: ${JSON.stringify(merged)}`);
});
