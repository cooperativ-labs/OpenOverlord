import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveMissionProjectSlug } from '../src/branch-preparation.ts';
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
