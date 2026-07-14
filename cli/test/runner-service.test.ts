import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyPollJitter,
  buildRunnerServiceEnv,
  describeServicePublisher,
  DESKTOP_FOCUS_WINDOW_MS,
  emptyRunnerServiceState,
  FAST_POLL_INTERVAL_MS,
  IDLE_BACKOFF_MS,
  LAUNCHD_LABEL,
  nextRunnerLastError,
  patchRunnerServiceState,
  readDesktopFocusState,
  readRunnerServiceState,
  renderLaunchdPlist,
  renderSystemdUnit,
  resolveOverlordAppInvocation,
  resolveOvldInvocation,
  resolveServiceManager,
  selectBasePollIntervalMs,
  SLOW_POLL_INTERVAL_MS,
  writeDesktopFocusState,
  writeRunnerServiceState
} from '../src/runner-service.ts';

test('selectBasePollIntervalMs is fast within the job window and slow afterwards', () => {
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

test('selectBasePollIntervalMs goes fast when the desktop app was focused recently', () => {
  const now = Date.parse('2026-07-09T12:00:00.000Z');
  // Recent focus alone (no recent job) is enough to poll fast.
  assert.equal(
    selectBasePollIntervalMs({
      lastLaunchedAt: null,
      lastDesktopFocusAt: new Date(now - 1000).toISOString(),
      now
    }),
    FAST_POLL_INTERVAL_MS
  );
  assert.equal(
    selectBasePollIntervalMs({
      lastLaunchedAt: null,
      lastDesktopFocusAt: new Date(now - (DESKTOP_FOCUS_WINDOW_MS - 1000)).toISOString(),
      now
    }),
    FAST_POLL_INTERVAL_MS
  );
  // Focus older than the 30m window no longer keeps it fast.
  assert.equal(
    selectBasePollIntervalMs({
      lastLaunchedAt: null,
      lastDesktopFocusAt: new Date(now - (DESKTOP_FOCUS_WINDOW_MS + 1000)).toISOString(),
      now
    }),
    SLOW_POLL_INTERVAL_MS
  );
  // A malformed focus timestamp is ignored (treated as no signal).
  assert.equal(
    selectBasePollIntervalMs({ lastLaunchedAt: null, lastDesktopFocusAt: 'nope', now }),
    SLOW_POLL_INTERVAL_MS
  );
});

test('desktop focus state round-trips through disk and defaults cleanly', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ovld-focus-'));
  try {
    // A missing file reads as "no signal" rather than throwing.
    assert.deepEqual(readDesktopFocusState(dir), { lastFocusedAt: null });
    const stamp = '2026-07-09T12:00:00.000Z';
    writeDesktopFocusState({ lastFocusedAt: stamp }, dir);
    assert.deepEqual(readDesktopFocusState(dir), { lastFocusedAt: stamp });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nextRunnerLastError reflects the latest poll, clearing a resolved error', () => {
  // A failing poll records its error...
  assert.equal(nextRunnerLastError('authentication required'), 'authentication required');
  // ...and a subsequent successful poll clears it instead of leaving it sticky,
  // so the runner status box stops reading a stale auth error after login.
  assert.equal(nextRunnerLastError(null), null);
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

test('resolveOverlordAppInvocation finds the installed app binary + CLI on macOS', () => {
  const home = '/Users/tester';
  const appDir = `${home}/Applications/Overlord.app`;
  const program = `${appDir}/Contents/MacOS/Overlord`;
  const script = `${appDir}/Contents/Resources/cli/bin/ovld.mjs`;
  const present = new Set([program, script]);
  const resolved = resolveOverlordAppInvocation({
    platform: 'darwin',
    homedir: home,
    exists: (candidate: string) => present.has(candidate)
  });
  assert.deepEqual(resolved, {
    program,
    args: [script, 'runner', 'supervise'],
    runAsElectronNode: true
  });
});

test('resolveOverlordAppInvocation returns null off macOS or when the app is absent', () => {
  assert.equal(resolveOverlordAppInvocation({ platform: 'linux', exists: () => true }), null);
  assert.equal(resolveOverlordAppInvocation({ platform: 'darwin', exists: () => false }), null);
});

test('resolveOvldInvocation keeps the Electron binary when the installer runs as Node', () => {
  const priorExec = process.env.OVLD_RUNNER_EXEC;
  const priorElectron = process.env.ELECTRON_RUN_AS_NODE;
  try {
    delete process.env.OVLD_RUNNER_EXEC;
    process.env.ELECTRON_RUN_AS_NODE = '1';
    const resolved = resolveOvldInvocation(
      ['/App/Contents/MacOS/Overlord', '/App/Contents/Resources/cli/bin/ovld.mjs'],
      '/App/Contents/MacOS/Overlord'
    );
    assert.equal(resolved.program, '/App/Contents/MacOS/Overlord');
    assert.equal(resolved.runAsElectronNode, true);
  } finally {
    if (priorExec === undefined) delete process.env.OVLD_RUNNER_EXEC;
    else process.env.OVLD_RUNNER_EXEC = priorExec;
    if (priorElectron === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = priorElectron;
  }
});

test('describeServicePublisher flags node-attributed macOS services for reinstall', () => {
  assert.deepEqual(
    describeServicePublisher({ execProgram: '/usr/local/bin/node', platform: 'darwin' }),
    { publisher: 'node', needsReinstallForOverlord: true }
  );
  assert.deepEqual(
    describeServicePublisher({
      execProgram: '/Applications/Overlord.app/Contents/MacOS/Overlord',
      platform: 'darwin'
    }),
    { publisher: 'overlord', needsReinstallForOverlord: false }
  );
  assert.deepEqual(describeServicePublisher({ execProgram: null, platform: 'darwin' }), {
    publisher: 'unknown',
    needsReinstallForOverlord: false
  });
  assert.deepEqual(describeServicePublisher({ execProgram: '/usr/bin/node', platform: 'linux' }), {
    publisher: 'unknown',
    needsReinstallForOverlord: false
  });
});

test('buildRunnerServiceEnv forwards ELECTRON_RUN_AS_NODE for app-binary invocations', () => {
  const prior = process.env.ELECTRON_RUN_AS_NODE;
  try {
    delete process.env.ELECTRON_RUN_AS_NODE;
    assert.equal(
      buildRunnerServiceEnv({ backendUrl: 'https://api.example.test', runAsElectronNode: true })
        .ELECTRON_RUN_AS_NODE,
      '1'
    );
  } finally {
    if (prior === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = prior;
  }
});

test('buildRunnerServiceEnv captures the backend URL and a non-empty PATH', () => {
  const env = buildRunnerServiceEnv({ backendUrl: 'https://api.example.test' });
  assert.equal(env.OVERLORD_BACKEND_URL, 'https://api.example.test');
  assert.ok(env.PATH && env.PATH.length > 0);
});

test('buildRunnerServiceEnv forwards ELECTRON_RUN_AS_NODE only when the installer runs under it', () => {
  const prior = process.env.ELECTRON_RUN_AS_NODE;
  try {
    delete process.env.ELECTRON_RUN_AS_NODE;
    assert.equal(
      buildRunnerServiceEnv({ backendUrl: 'https://api.example.test' }).ELECTRON_RUN_AS_NODE,
      undefined
    );
    process.env.ELECTRON_RUN_AS_NODE = '1';
    assert.equal(
      buildRunnerServiceEnv({ backendUrl: 'https://api.example.test' }).ELECTRON_RUN_AS_NODE,
      '1'
    );
  } finally {
    if (prior === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = prior;
  }
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
