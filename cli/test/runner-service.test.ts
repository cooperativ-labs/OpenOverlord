import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyPollJitter,
  buildRunnerServiceEnv,
  emptyRunnerServiceState,
  FAST_POLL_INTERVAL_MS,
  IDLE_BACKOFF_MS,
  LAUNCHD_LABEL,
  patchRunnerServiceState,
  readRunnerServiceState,
  renderLaunchdPlist,
  renderSystemdUnit,
  resolveOvldInvocation,
  resolveServiceManager,
  selectBasePollIntervalMs,
  SLOW_POLL_INTERVAL_MS,
  writeRunnerServiceState
} from '../src/runner-service.ts';

test('selectBasePollIntervalMs is fast within the idle window and slow afterwards', () => {
  const now = Date.parse('2026-07-09T12:00:00.000Z');
  assert.equal(selectBasePollIntervalMs({ lastLaunchedAt: null, now }), SLOW_POLL_INTERVAL_MS);
  assert.equal(
    selectBasePollIntervalMs({ lastLaunchedAt: new Date(now - 1000).toISOString(), now }),
    FAST_POLL_INTERVAL_MS
  );
  assert.equal(
    selectBasePollIntervalMs({
      lastLaunchedAt: new Date(now - (IDLE_BACKOFF_MS - 1000)).toISOString(),
      now
    }),
    FAST_POLL_INTERVAL_MS
  );
  assert.equal(
    selectBasePollIntervalMs({
      lastLaunchedAt: new Date(now - (IDLE_BACKOFF_MS + 1000)).toISOString(),
      now
    }),
    SLOW_POLL_INTERVAL_MS
  );
  assert.equal(
    selectBasePollIntervalMs({ lastLaunchedAt: 'not-a-date', now }),
    SLOW_POLL_INTERVAL_MS
  );
});

test('applyPollJitter stays within +/-10 percent of the base interval', () => {
  for (const random of [() => 0, () => 1, () => 0.5, () => 0.25]) {
    const jittered = applyPollJitter(3000, random);
    assert.ok(jittered >= 2700 && jittered <= 3300, `jittered=${jittered} out of range`);
  }
});

test('resolveOvldInvocation prefers an explicit override, otherwise re-runs the entry', () => {
  const prior = process.env.OVLD_RUNNER_EXEC;
  try {
    process.env.OVLD_RUNNER_EXEC = '/usr/local/bin/ovld';
    assert.deepEqual(resolveOvldInvocation(['node', 'cli.js'], '/node'), {
      program: '/usr/local/bin/ovld',
      args: ['runner', 'supervise']
    });
    delete process.env.OVLD_RUNNER_EXEC;
    const resolved = resolveOvldInvocation(['/node', '/opt/app/cli/dist/index.js'], '/node');
    assert.equal(resolved.program, '/node');
    assert.deepEqual(resolved.args, ['/opt/app/cli/dist/index.js', 'runner', 'supervise']);
  } finally {
    if (prior === undefined) delete process.env.OVLD_RUNNER_EXEC;
    else process.env.OVLD_RUNNER_EXEC = prior;
  }
});

test('buildRunnerServiceEnv captures the backend URL and a non-empty PATH', () => {
  const env = buildRunnerServiceEnv({ backendUrl: 'https://api.example.test' });
  assert.equal(env.OVERLORD_BACKEND_URL, 'https://api.example.test');
  assert.ok(env.PATH && env.PATH.length > 0);
});

test('renderLaunchdPlist embeds the label, program args, and env, and escapes XML', () => {
  const plist = renderLaunchdPlist({
    label: LAUNCHD_LABEL,
    invocation: { program: '/node', args: ['/cli.js', 'runner', 'supervise'] },
    env: { OVERLORD_BACKEND_URL: 'https://api.example.test?a=1&b=2' },
    logDir: '/home/user/.ovld/logs'
  });
  assert.match(plist, /<key>Label<\/key>\s*<string>io\.overlord\.runner<\/string>/);
  assert.match(plist, /<string>runner<\/string>/);
  assert.match(plist, /<string>supervise<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  // The `&` in the URL must be XML-escaped.
  assert.ok(plist.includes('a=1&amp;b=2'));
  assert.ok(!plist.includes('a=1&b=2'));
});

test('renderSystemdUnit emits an absolute ExecStart with Restart and env lines', () => {
  const unit = renderSystemdUnit({
    invocation: { program: '/usr/bin/node', args: ['/cli.js', 'runner', 'supervise'] },
    env: { OVERLORD_BACKEND_URL: 'https://api.example.test', PATH: '/usr/bin' }
  });
  assert.match(unit, /ExecStart=\/usr\/bin\/node \/cli\.js runner supervise/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /Environment=OVERLORD_BACKEND_URL=https:\/\/api\.example\.test/);
  assert.match(unit, /WantedBy=default\.target/);
});

test('resolveServiceManager maps platforms and returns null for unsupported ones', () => {
  assert.equal(resolveServiceManager('darwin')?.kind, 'launchd');
  assert.equal(resolveServiceManager('linux')?.kind, 'systemd');
  assert.equal(resolveServiceManager('win32'), null);
});

test('runner service state round-trips and merges via patch', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ovld-runner-state-'));
  try {
    assert.deepEqual(readRunnerServiceState(dir), emptyRunnerServiceState());
    writeRunnerServiceState(
      { ...emptyRunnerServiceState(), backendUrl: 'https://api.example.test' },
      dir
    );
    assert.equal(readRunnerServiceState(dir).backendUrl, 'https://api.example.test');
    const merged = patchRunnerServiceState({ lastLaunchedAt: '2026-07-09T00:00:00.000Z' }, dir);
    assert.equal(merged.backendUrl, 'https://api.example.test');
    assert.equal(merged.lastLaunchedAt, '2026-07-09T00:00:00.000Z');
    assert.equal(readRunnerServiceState(dir).lastLaunchedAt, '2026-07-09T00:00:00.000Z');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
