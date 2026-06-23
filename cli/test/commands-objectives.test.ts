import assert from 'node:assert/strict';
import test from 'node:test';

import { runManagementCommand } from '../src/commands.ts';
import type { CliRuntime } from '../src/runtime.ts';

test('ovld create sends objectives-json as one REST array payload', async () => {
  const posts: Array<{ path: string; body: unknown }> = [];
  const runtime = {
    backend: {
      baseUrl: 'http://example.test',
      health: async () => ({ ok: true }),
      get: async () => {
        throw new Error('unexpected GET');
      },
      post: async ({ path, body }: { path: string; body?: unknown }) => {
        posts.push({ path, body });
        return {
          id: 'mission-1',
          displayId: 'local:1',
          objectives: [
            { id: 'objective-1', objective: 'First objective' },
            { id: 'objective-2', objective: 'Second objective' }
          ]
        };
      },
      patch: async () => {
        throw new Error('unexpected PATCH');
      },
      delete: async () => {
        throw new Error('unexpected DELETE');
      }
    },
    close: () => {}
  } satisfies CliRuntime;

  const originalLog = console.log;
  console.log = () => {};
  try {
    await runManagementCommand({
      runtime,
      command: 'create',
      rest: [
        '--project-id',
        'project-1',
        '--objectives-json',
        '[{"objective":"First objective"},{"objective":"Second objective","title":"Follow-up"}]'
      ]
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.path, '/api/missions');
  assert.deepEqual(posts[0]?.body, {
    projectId: 'project-1',
    title: 'First objective',
    objectives: [
      { objective: 'First objective' },
      { objective: 'Second objective', title: 'Follow-up' }
    ]
  });
});
