import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { computeMergedBranches, resolveTicketProjectSlug } from '../src/branch-preparation.ts';
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

test('resolveTicketProjectSlug uses embedded ticket project slug when present', async () => {
  const calls: string[] = [];
  const slug = await resolveTicketProjectSlug({
    runtime: runtimeWithProjects([{ id: 'p1', slug: 'from-api' }], calls),
    ticket: { projectId: 'p1', project: { slug: 'from-ticket' } }
  });

  assert.equal(slug, 'from-ticket');
  assert.deepEqual(calls, []);
});

test('resolveTicketProjectSlug reads existing project slug from project list', async () => {
  const slug = await resolveTicketProjectSlug({
    runtime: runtimeWithProjects([
      { id: 'p1', slug: 'alpha' },
      { id: 'p2', slug: 'overlord' }
    ]),
    ticket: { projectId: 'p2' }
  });

  assert.equal(slug, 'overlord');
});

test('resolveTicketProjectSlug falls back for unresolved legacy payloads', async () => {
  const slug = await resolveTicketProjectSlug({
    runtime: runtimeWithProjects([{ id: 'p1', slug: 'alpha' }]),
    ticket: { projectId: 'missing' }
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
