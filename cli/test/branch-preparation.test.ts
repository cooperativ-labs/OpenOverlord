import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveTicketProjectSlug } from '../src/branch-preparation.ts';
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
