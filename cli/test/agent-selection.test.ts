import assert from 'node:assert/strict';
import test from 'node:test';

import { runManagementCommand } from '../src/commands.ts';
import { CliError } from '../src/errors.ts';
import type { CliRuntime } from '../src/runtime.ts';

type Post = { path: string; body: unknown };

function silenceLog<T>(fn: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  console.log = () => {};
  return fn().finally(() => {
    console.log = originalLog;
  });
}

test('runner fails an execution request that has no agent instead of defaulting', async () => {
  const posts: Post[] = [];
  const runtime = {
    backend: {
      baseUrl: 'http://example.test',
      health: async () => ({ ok: true }),
      get: async () => ({}),
      post: async ({ path, body }: { path: string; body?: unknown }) => {
        posts.push({ path, body });
        if (path === '/api/runner/claim') {
          // An execution request that slipped through without an agent. The runner
          // must surface this rather than silently launching a hardcoded default.
          return {
            request: {
              id: 'req-1',
              missionId: 'local:1',
              requestedAgent: null,
              workingDirectory: process.cwd()
            }
          };
        }
        return {};
      },
      patch: async () => ({}),
      delete: async () => ({})
    },
    close: () => {}
  } satisfies CliRuntime;

  await assert.rejects(
    () => silenceLog(() => runManagementCommand({ runtime, command: 'runner', rest: ['once'] })),
    (error: unknown) => error instanceof CliError && /no agent/i.test(error.message)
  );

  const failurePosts = posts.filter(post => post.path === '/api/runner/requests/req-1/failed');
  assert.equal(failurePosts.length, 1);
  const failed = failurePosts[0];
  assert.ok(failed, 'the request should be marked failed');
  assert.match(String((failed.body as { error: string }).error), /no agent/i);
  // It must never reach the launched state with a substituted agent.
  assert.ok(!posts.some(post => post.path === '/api/runner/requests/req-1/launched'));
});

test('runner claim includes the local device fingerprint for hosted backends', async () => {
  const posts: Post[] = [];
  const runtime = {
    backend: {
      baseUrl: 'http://example.test',
      health: async () => ({ ok: true }),
      get: async () => ({}),
      post: async ({ path, body }: { path: string; body?: unknown }) => {
        posts.push({ path, body });
        if (path === '/api/runner/claim') return { request: null };
        return {};
      },
      patch: async () => ({}),
      delete: async () => ({})
    },
    close: () => {}
  } satisfies CliRuntime;

  await silenceLog(() => runManagementCommand({ runtime, command: 'runner', rest: ['once'] }));

  const claim = posts.find(post => post.path === '/api/runner/claim');
  assert.ok(claim, 'runner once should call /api/runner/claim');
  const body = claim!.body as {
    deviceFingerprint?: string;
    deviceLabel?: string;
    devicePlatform?: string;
  };
  assert.equal(typeof body.deviceFingerprint, 'string');
  assert.ok(body.deviceFingerprint && body.deviceFingerprint.length > 0);
  assert.equal(typeof body.deviceLabel, 'string');
  assert.equal(typeof body.devicePlatform, 'string');
});

test('attach reuses the agent already stored on the objective', async () => {
  const posts: Post[] = [];
  const runtime = {
    backend: {
      baseUrl: 'http://example.test',
      health: async () => ({ ok: true }),
      get: async () => ({
        id: 'mission-1',
        displayId: 'local:1',
        objectives: [{ id: 'obj-1', assignedAgent: 'claude' }]
      }),
      post: async ({ path, body }: { path: string; body?: unknown }) => {
        posts.push({ path, body });
        return { id: 'req-1' };
      },
      patch: async () => ({}),
      delete: async () => ({})
    },
    close: () => {}
  } satisfies CliRuntime;

  await silenceLog(() => runManagementCommand({ runtime, command: 'attach', rest: ['local:1'] }));

  const launch = posts.find(post => post.path === '/api/objectives/obj-1/launch');
  assert.ok(launch, 'attach should queue a launch');
  // No agent was passed, so the objective's stored agent is used — never codex.
  assert.equal((launch!.body as { agent: string }).agent, 'claude');
});

test('attach honors an explicit agent over the stored one', async () => {
  const posts: Post[] = [];
  const runtime = {
    backend: {
      baseUrl: 'http://example.test',
      health: async () => ({ ok: true }),
      get: async () => ({
        id: 'mission-1',
        displayId: 'local:1',
        objectives: [{ id: 'obj-1', assignedAgent: 'claude' }]
      }),
      post: async ({ path, body }: { path: string; body?: unknown }) => {
        posts.push({ path, body });
        return { id: 'req-1' };
      },
      patch: async () => ({}),
      delete: async () => ({})
    },
    close: () => {}
  } satisfies CliRuntime;

  await silenceLog(() =>
    runManagementCommand({ runtime, command: 'attach', rest: ['local:1', '--agent', 'codex'] })
  );

  const launch = posts.find(post => post.path === '/api/objectives/obj-1/launch');
  assert.equal((launch!.body as { agent: string }).agent, 'codex');
});
