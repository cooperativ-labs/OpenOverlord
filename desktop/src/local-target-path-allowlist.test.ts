import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { LocalTargetBridgeCall } from '../../packages/core/service/local-target/desktop-bridge.ts';

import {
  PathAllowlistError,
  resetAllowedPathsForTests,
  validateLocalTargetCallPaths
} from './local-target-path-allowlist.ts';

const repoRoot = path.join(tmpdir(), 'overlord-allowlist-repo');

test('validateLocalTargetCallPaths registers checkout roots from the call', () => {
  resetAllowedPathsForTests();

  const call: LocalTargetBridgeCall = {
    capability: 'readRepositoryTree',
    input: { resourceId: 'res-1', repoPath: repoRoot }
  };

  assert.doesNotThrow(() => validateLocalTargetCallPaths(call));
});

test('validateLocalTargetCallPaths rejects subpaths outside the repo root', () => {
  resetAllowedPathsForTests();

  assert.throws(
    () =>
      validateLocalTargetCallPaths({
        capability: 'readRepositoryTree',
        input: {
          resourceId: 'res-1',
          repoPath: repoRoot,
          subPath: '../../../etc/passwd'
        }
      }),
    PathAllowlistError
  );
});

test('validateLocalTargetCallPaths rejects relative paths', () => {
  resetAllowedPathsForTests();

  assert.throws(
    () =>
      validateLocalTargetCallPaths({
        capability: 'listBranches',
        input: { resourceId: 'res-1', repoPath: 'relative/path' }
      }),
    PathAllowlistError
  );
});

test('roots registered by an earlier call authorize a later out-of-own-root path', () => {
  resetAllowedPathsForTests();

  const parent = path.join(tmpdir(), 'overlord-allowlist-accumulate');
  const child = path.join(parent, 'child');

  // Before the parent is registered, a call rooted at `child` may not reach a
  // sibling directory under `parent` — it is outside `child`'s own root.
  assert.throws(
    () =>
      validateLocalTargetCallPaths({
        capability: 'readRepositoryTree',
        input: { resourceId: 'res-1', repoPath: child, subPath: '../sibling' }
      }),
    PathAllowlistError
  );

  // An earlier call rooted at `parent` registers it for the rest of the session.
  validateLocalTargetCallPaths({
    capability: 'readRepositoryTree',
    input: { resourceId: 'res-1', repoPath: parent }
  });

  // Now the same child+sibling call succeeds purely because the accumulated
  // `parent` root from the earlier call still applies.
  assert.doesNotThrow(() =>
    validateLocalTargetCallPaths({
      capability: 'readRepositoryTree',
      input: { resourceId: 'res-1', repoPath: child, subPath: '../sibling' }
    })
  );
});
