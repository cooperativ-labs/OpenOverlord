import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runOvld } from '../../../test/support/cli.ts';

test('ovld version prints the packaged CLI version', async () => {
  const result = await runOvld({ args: ['version'] });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^Overlord CLI \d+\.\d+\.\d+\n$/);
});

test('ovld help exits zero without requiring a database', async () => {
  const result = await runOvld({ args: ['help'] });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Overlord CLI/);
  assert.match(result.stdout, /ovld version/);
  assert.match(result.stdout, /ovld update/);
  assert.match(result.stdout, /ovld setup/);
  assert.match(result.stdout, /ovld agent-setup/);
  assert.match(result.stdout, /Agents:/);
  assert.match(result.stdout, /ovld protocol help/);
});

test('ovld protocol help prints agent lifecycle reference without a backend', async () => {
  const result = await runOvld({ args: ['protocol', 'help'] });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /ovld protocol attach --ticket-id/);
  assert.match(result.stdout, /Agent workflow \(required\)/);
  assert.match(result.stdout, /resume-follow-up/);
  assert.match(result.stdout, /auth-status/);
  assert.doesNotMatch(result.stdout, /pending-tickets/);
  assert.doesNotMatch(result.stdout, /claim-execution/);
});

test('ovld rejects unknown commands with a non-zero exit', async () => {
  const result = await runOvld({ args: ['not-a-command'] });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /Unknown command: not-a-command/);
});

test('ovld agent-setup lists installable connectors', async () => {
  const result = await runOvld({ args: ['agent-setup', '--json'] });

  assert.equal(result.exitCode, 0, result.stderr);
  const payload = JSON.parse(result.stdout) as { available: string[]; usage: string };
  assert.ok(payload.available.includes('claude'));
  assert.match(payload.usage, /ovld agent-setup/);
});

test('ovld setup no longer accepts a connector argument', async () => {
  const result = await runOvld({ args: ['setup', 'claude'] });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /Connector setup moved to `ovld agent-setup`/);
});

test('ovld update --check reports the published version without installing', async () => {
  const result = await runOvld({
    args: ['update', '--check', '--json'],
    env: {
      OVLD_UPDATE_BIN: process.execPath,
      OVLD_UPDATE_VIEW_ARGS_JSON: JSON.stringify([
        path.join(process.cwd(), 'cli', 'test', 'fixtures', 'mock-update-runner.mjs'),
        'view',
        '999.0.0'
      ])
    }
  });

  assert.equal(result.exitCode, 0);
  const payload = JSON.parse(result.stdout) as {
    latestVersion: string;
    updateAvailable: boolean;
    installed: boolean;
  };
  assert.equal(payload.latestVersion, '999.0.0');
  assert.equal(payload.updateAvailable, true);
  assert.equal(payload.installed, false);
});

test('ovld update installs through the configured package manager command', async () => {
  const sentinelDir = mkdtempSync(path.join(tmpdir(), 'ovld-update-'));
  const sentinelPath = path.join(sentinelDir, 'install.txt');
  const fixturePath = path.join(process.cwd(), 'cli', 'test', 'fixtures', 'mock-update-runner.mjs');

  const result = await runOvld({
    args: ['update'],
    env: {
      OVLD_UPDATE_BIN: process.execPath,
      OVLD_UPDATE_VIEW_ARGS_JSON: JSON.stringify([fixturePath, 'view', '999.0.0']),
      OVLD_UPDATE_INSTALL_ARGS_JSON: JSON.stringify([fixturePath, 'install']),
      OVLD_UPDATE_SENTINEL: sentinelPath
    }
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Updated Overlord CLI from .* to 999\.0\.0\./);
  assert.equal(readFileSync(sentinelPath, 'utf8'), 'installed\n');
});
