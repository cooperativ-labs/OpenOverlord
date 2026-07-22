import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { readMyMissionsProjectFilter, writeMyMissionsProjectFilter } from './org-preferences.ts';

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

test('persists My Missions project filters per backend and organization', () => {
  const storage = installStorage({ 'overlord:active-backend-key': 'backend-a' });

  writeMyMissionsProjectFilter('org-a', ['project-a', 'project-b', 'project-a']);

  assert.deepEqual(readMyMissionsProjectFilter('org-a'), ['project-a', 'project-b']);
  assert.deepEqual(readMyMissionsProjectFilter('org-b'), []);
  assert.equal(
    storage.get('overlord:my-missions-project-filter:backend-a:org-a'),
    '["project-a","project-b"]'
  );
});

test('ignores malformed stored project filters', () => {
  installStorage({
    'overlord:active-backend-key': 'backend-a',
    'overlord:my-missions-project-filter:backend-a:org-a': '{not-json'
  });

  assert.deepEqual(readMyMissionsProjectFilter('org-a'), []);
});
