import assert from 'node:assert/strict';
import test from 'node:test';

import { createRunnerQueueListener } from './runner-queue-notify.ts';

function fakeClient() {
  const listeners = new Map<string, (value: unknown) => void>();
  const queries: string[] = [];
  let ended = false;
  return {
    client: {
      connect: async () => undefined,
      query: async (sql: string) => {
        queries.push(sql);
      },
      end: async () => {
        ended = true;
      },
      on: (event: 'notification' | 'error', listener: (value: unknown) => void) => {
        listeners.set(event, listener);
      }
    },
    queries,
    emit: (event: 'notification' | 'error') => listeners.get(event)?.({}),
    get ended() {
      return ended;
    }
  };
}

test('runner queue listener wakes promptly on a Postgres notification', async () => {
  const fake = fakeClient();
  const listener = await createRunnerQueueListener({
    connectionString: 'postgres://example.invalid/overlord',
    createClient: async () => fake.client,
    timeoutMs: 1000
  });
  assert.ok(listener);
  assert.deepEqual(fake.queries, ['LISTEN overlord_execution_request_queue']);

  const waiting = listener.wait();
  fake.emit('notification');
  await waiting;
  await listener.close();
  assert.equal(fake.ended, true);
});

test('runner queue listener wakes on timeout so the runner can reconnect', async () => {
  const fake = fakeClient();
  const listener = await createRunnerQueueListener({
    connectionString: 'postgres://example.invalid/overlord',
    createClient: async () => fake.client,
    timeoutMs: 1
  });
  assert.ok(listener);
  await listener.wait();
  await listener.close();
  assert.equal(fake.ended, true);
});
