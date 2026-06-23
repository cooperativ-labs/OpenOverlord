import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  clearCachedSessionKey,
  readCachedSessionKey,
  writeCachedSessionKey
} from '../src/session-key.ts';

function withTempHome(run: () => void): void {
  const previous = process.env.OVLD_HOME;
  process.env.OVLD_HOME = mkdtempSync(path.join(tmpdir(), 'ovld-session-key-'));
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.OVLD_HOME;
    else process.env.OVLD_HOME = previous;
  }
}

test('session key cache round-trips for a (workingDir, mission) pair', () => {
  withTempHome(() => {
    const args = { missionId: 'coo:42', workingDirectory: '/repo/one' };
    assert.equal(readCachedSessionKey(args), undefined);

    writeCachedSessionKey({ ...args, sessionKey: 'sess_abc123' });
    assert.equal(readCachedSessionKey(args), 'sess_abc123');

    clearCachedSessionKey(args);
    assert.equal(readCachedSessionKey(args), undefined);
  });
});

test('session key cache is scoped per mission and per working directory', () => {
  withTempHome(() => {
    writeCachedSessionKey({
      missionId: 'coo:1',
      workingDirectory: '/repo/one',
      sessionKey: 'sess_one'
    });

    // Same directory, different mission → no leak.
    assert.equal(
      readCachedSessionKey({ missionId: 'coo:2', workingDirectory: '/repo/one' }),
      undefined
    );
    // Same mission, different directory → no leak.
    assert.equal(
      readCachedSessionKey({ missionId: 'coo:1', workingDirectory: '/repo/two' }),
      undefined
    );
    // Exact pair still resolves.
    assert.equal(
      readCachedSessionKey({ missionId: 'coo:1', workingDirectory: '/repo/one' }),
      'sess_one'
    );
  });
});

test('cache keys on the resolved working directory', () => {
  withTempHome(() => {
    writeCachedSessionKey({
      missionId: 'coo:7',
      workingDirectory: '/repo/app',
      sessionKey: 'sess_resolved'
    });
    // A non-normalized path that resolves to the same absolute directory hits the
    // same cache entry, matching the auto-inject behavior in runProtocolCommand.
    assert.equal(
      readCachedSessionKey({ missionId: 'coo:7', workingDirectory: '/repo/sub/../app' }),
      'sess_resolved'
    );
  });
});

test('blank session keys are never persisted', () => {
  withTempHome(() => {
    const args = { missionId: 'coo:9', workingDirectory: '/repo/blank' };
    writeCachedSessionKey({ ...args, sessionKey: '   ' });
    assert.equal(readCachedSessionKey(args), undefined);
  });
});
