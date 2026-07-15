import assert from 'node:assert/strict';
import test from 'node:test';

import type { BackendClient } from '../src/backend-client.ts';
import { discoverProjectOnClient, listAccessibleProjects } from '../src/discover-project-local.ts';

function backendWithGet(get: BackendClient['get']): BackendClient {
  return {
    baseUrl: 'https://backend.ovld.ai',
    forWorkspace: () => backendWithGet(get),
    health: async () => ({ ok: true }),
    get,
    post: async () => {
      throw new Error('unexpected post');
    },
    patch: async () => {
      throw new Error('unexpected patch');
    },
    delete: async () => {
      throw new Error('unexpected delete');
    },
    postRaw: async () => {
      throw new Error('unexpected postRaw');
    }
  };
}

test('listAccessibleProjects combines projects from every workspace', async () => {
  const backend = backendWithGet(async path => {
    if (path === '/api/workspaces') return [{ id: 'workspace-a' }, { id: 'workspace-b' }] as never;
    if (path === '/api/workspaces/workspace-a/projects') {
      return [{ id: 'project-a', name: 'A', slug: 'a' }] as never;
    }
    if (path === '/api/workspaces/workspace-b/projects') {
      return [{ id: 'project-b', name: 'B', slug: 'b' }] as never;
    }
    throw new Error(`unexpected get: ${path}`);
  });

  const projects = await listAccessibleProjects({ backend });
  assert.deepEqual(
    projects.map(project => project.id),
    ['project-a', 'project-b']
  );
});

test('explicit remote project discovery uses the cross-workspace project route', async () => {
  const calls: string[] = [];
  const backend = backendWithGet(async path => {
    calls.push(path);
    if (path === '/api/projects/project-b') {
      return { id: 'project-b', name: 'B', slug: 'b' } as never;
    }
    throw new Error(`unexpected get: ${path}`);
  });

  const discovery = await discoverProjectOnClient({
    backend,
    workingDirectory: '/tmp/unlinked',
    projectId: 'project-b'
  });
  assert.equal(discovery.projectId, 'project-b');
  assert.deepEqual(calls, ['/api/projects/project-b']);
});
