import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { LocalTargetBridgeCall } from '../../../packages/core/service/local-target/desktop-bridge.ts';
import type {
  CapabilityResult,
  RepositoryTreeResult
} from '../../../packages/core/service/local-target/types.ts';

import { api } from './api.ts';

const bridgeCall: LocalTargetBridgeCall = {
  capability: 'readRepositoryTree',
  input: { resourceId: 'res-1', repoPath: '/tmp/demo-repo' }
};

const bridgeResult: CapabilityResult<RepositoryTreeResult> = {
  ok: true,
  value: {
    rootPath: '/tmp/demo-repo',
    gitRoot: '/tmp/demo-repo',
    branch: 'main',
    commit: 'abc123',
    entries: [{ name: 'README.md', path: 'README.md', type: 'file', parentPath: null, depth: 0 }],
    truncated: false
  },
  target: {
    executionTargetId: null,
    deviceLabel: 'test-host',
    transport: 'desktop_bridge'
  }
};

test('hasDesktopLocalTargetBridge is true when invokeLocalTarget is exposed', async () => {
  const original = globalThis.window;
  (globalThis as { window?: Window }).window = {
    overlord: {
      isDesktop: true,
      platform: 'darwin',
      version: 'test',
      chooseDirectory: async () => null,
      openExternal: async () => false,
      revealInFinder: async () => false,
      updates: {
        getStatus: async () => ({
          state: 'unsupported',
          currentVersion: '0',
          availableVersion: null,
          message: null,
          progressPercent: null
        }),
        check: async () => ({
          state: 'unsupported',
          currentVersion: '0',
          availableVersion: null,
          message: null,
          progressPercent: null
        }),
        install: async () => ({
          state: 'unsupported',
          currentVersion: '0',
          availableVersion: null,
          message: null,
          progressPercent: null
        }),
        onStatus: () => () => {}
      },
      invokeLocalTarget: async () => bridgeResult
    }
  } as unknown as Window;

  const { hasDesktopLocalTargetBridge, invokeLocalTarget } =
    await import('./local-target-client.ts');
  assert.equal(hasDesktopLocalTargetBridge(), true);

  const result = await invokeLocalTarget<RepositoryTreeResult>(bridgeCall);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.entries[0]?.path, 'README.md');
  }

  (globalThis as { window?: Window }).window = original;
});

test('invokeLocalTarget returns LOCAL_TARGET_REQUIRED without bridge or dev server', async () => {
  const original = globalThis.window;
  delete (globalThis as { window?: Window }).window;

  // Explicitly stub the server capability probe so the LOCAL_TARGET_REQUIRED path
  // is driven by a mocked api.meta() rejection, not by an incidental fetch error.
  const meta = mock.method(api, 'meta', async () => {
    throw new Error('meta unavailable in test');
  });

  try {
    const { invokeLocalTarget } = await import('./local-target-client.ts');
    const result = await invokeLocalTarget(bridgeCall);
    // The result must be driven by the stubbed capability probe, not an incidental
    // fetch error, so the probe must actually have been consulted.
    assert.equal(meta.mock.callCount(), 1, 'the server capability probe must be consulted');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'LOCAL_TARGET_REQUIRED');
    }
  } finally {
    mock.restoreAll();
    (globalThis as { window?: Window }).window = original;
  }
});
