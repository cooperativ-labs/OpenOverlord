import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  readMyMissionsWorkspaceFilter,
  writeMyMissionsWorkspaceFilter
} from './org-preferences.ts';

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

test('persists My Missions workspace filters per backend and organization', () => {
  const storage = installStorage({ 'overlord:active-backend-key': 'backend-a' });

  writeMyMissionsWorkspaceFilter('org-a', ['workspace-a', 'workspace-b', 'workspace-a']);

  assert.deepEqual(readMyMissionsWorkspaceFilter('org-a'), ['workspace-a', 'workspace-b']);
  assert.deepEqual(readMyMissionsWorkspaceFilter('org-b'), []);
  assert.equal(
    storage.get('overlord:my-missions-workspace-filter:backend-a:org-a'),
    '["workspace-a","workspace-b"]'
  );
});

test('ignores malformed stored workspace filters', () => {
  installStorage({
    'overlord:active-backend-key': 'backend-a',
    'overlord:my-missions-workspace-filter:backend-a:org-a': '{not-json'
  });

  assert.deepEqual(readMyMissionsWorkspaceFilter('org-a'), []);
});
