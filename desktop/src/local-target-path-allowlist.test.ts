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
