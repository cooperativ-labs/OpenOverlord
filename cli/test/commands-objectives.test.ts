import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

test('ovld add-cwd writes local project metadata after resource creation', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ovld-add-cwd-'));
  const posts: Array<{ path: string; body: unknown }> = [];
  const runtime = {
    backend: {
      baseUrl: 'https://overlord.example.test',
      health: async () => ({ ok: true }),
      get: async () => [{ id: 'project-1', name: 'Project One', slug: 'project-one' }],
      post: async ({ path, body }: { path: string; body?: unknown }) => {
        posts.push({ path, body });
        return {
          id: 'resource-1',
          projectId: 'project-1',
          path: directory,
          isPrimary: true
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
      command: 'add-cwd',
      rest: ['--directory', directory, '--project-id', 'project-1']
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.path, '/api/projects/project-1/resources');
  assert.deepEqual(posts[0]?.body, {
    directoryPath: directory,
    isPrimary: true
  });

  const projectJsonPath = path.join(directory, '.overlord', 'project.json');
  assert.equal(existsSync(projectJsonPath), true);
  const projectJson = JSON.parse(readFileSync(projectJsonPath, 'utf8')) as {
    _warning: string;
    version: number;
    projectId: string;
    resourceId: string;
    isPrimary: boolean;
  };
  assert.match(projectJson._warning, /managed by Overlord/i);
  assert.equal(projectJson.version, 1);
  assert.equal(projectJson.projectId, 'project-1');
  assert.equal(projectJson.resourceId, 'resource-1');
  assert.equal(projectJson.isPrimary, true);
});
