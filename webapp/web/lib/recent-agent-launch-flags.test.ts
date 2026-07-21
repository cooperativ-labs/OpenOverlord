import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  filterRecentAgentLaunchFlags,
  readRecentAgentLaunchFlags,
  recordRecentAgentLaunchFlag
} from './recent-agent-launch-flags.ts';

const originalWindow = globalThis.window;

function installStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  (globalThis as { window?: Window }).window = {
    localStorage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value)
    }
  } as unknown as Window;
  return data;
}

afterEach(() => {
  (globalThis as { window?: Window }).window = originalWindow;
});

test('records up to three unique recent flags per agent', () => {
  const storage = installStorage({ 'overlord:active-backend-key': 'backend-a' });

  recordRecentAgentLaunchFlag({
    agentKey: 'claude',
    flag: { name: '--permission-mode', value: 'auto' }
  });
  recordRecentAgentLaunchFlag({
    agentKey: 'claude',
    flag: { name: '--verbose' }
  });
  recordRecentAgentLaunchFlag({
    agentKey: 'claude',
    flag: { name: '--model', value: 'opus' }
  });
  recordRecentAgentLaunchFlag({
    agentKey: 'claude',
    flag: { name: '--extra', value: 'one' }
  });

  assert.deepEqual(readRecentAgentLaunchFlags('claude'), [
    { name: '--extra', value: 'one' },
    { name: '--model', value: 'opus' },
    { name: '--verbose', value: null }
  ]);
  assert.equal(
    storage.get('overlord:recent-agent-launch-flags:backend-a'),
    JSON.stringify({
      claude: [
        { name: '--extra', value: 'one' },
        { name: '--model', value: 'opus' },
        { name: '--verbose', value: null }
      ]
    })
  );
});

test('moves duplicate recent flags to the front', () => {
  installStorage({ 'overlord:active-backend-key': 'backend-a' });

  recordRecentAgentLaunchFlag({
    agentKey: 'codex',
    flag: { name: '--permission-mode', value: 'auto' }
  });
  recordRecentAgentLaunchFlag({
    agentKey: 'codex',
    flag: { name: '--verbose' }
  });
  recordRecentAgentLaunchFlag({
    agentKey: 'codex',
    flag: { name: '--permission-mode', value: 'auto' }
  });

  assert.deepEqual(readRecentAgentLaunchFlags('codex'), [
    { name: '--permission-mode', value: 'auto' },
    { name: '--verbose', value: null }
  ]);
});

test('filters recent flags by display text', () => {
  const flags = [
    { name: '--permission-mode', value: 'auto' },
    { name: '--verbose' },
    { name: '--model', value: 'opus' }
  ];

  assert.deepEqual(
    filterRecentAgentLaunchFlags({ flags, query: 'permission' }),
    [{ name: '--permission-mode', value: 'auto' }]
  );
  assert.deepEqual(filterRecentAgentLaunchFlags({ flags, query: '' }), flags);
});
