import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runProtocolCommand } from '../src/commands.ts';
import type { CliRuntime } from '../src/runtime.ts';
import {
  readChangedFiles,
  recordTouchedFiles,
  resetTouchedFiles,
  writeBaseline
} from '../src/vcs.ts';
import { writeActiveSession } from '../src/vcs-sessions.ts';

const MISSION_ID = 'coo:127';
const OTHER_MISSION_ID = 'coo:128';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
}

function makeRepo(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), 'ovld-commands-home-'));
  process.env.OVLD_HOME = home;
  const repo = mkdtempSync(path.join(os.tmpdir(), 'ovld-commands-repo-'));
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  writeFileSync(path.join(repo, 'committed.txt'), 'base\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'init']);
  return repo;
}

test('deliver excludes concurrent claimed files and auto-attaches skip payloads for them', async () => {
  const repo = makeRepo();
  writeBaseline({ workingDirectory: repo, missionId: MISSION_ID, files: readChangedFiles(repo) });
  resetTouchedFiles({ workingDirectory: repo, missionId: MISSION_ID });
  writeActiveSession({ workingDirectory: repo, missionId: MISSION_ID, sessionKey: 'sess_me' });
  writeActiveSession({
    workingDirectory: repo,
    missionId: OTHER_MISSION_ID,
    sessionKey: 'sess_other'
  });

  const mine = path.join(repo, 'mine.ts');
  const claimed = path.join(repo, 'claimed.ts');
  const unclaimed = path.join(repo, 'unclaimed.ts');
  writeFileSync(mine, 'mine\n');
  writeFileSync(claimed, 'claimed\n');
  writeFileSync(unclaimed, 'unclaimed\n');
  recordTouchedFiles({ workingDirectory: repo, missionId: MISSION_ID, files: [mine] });
  recordTouchedFiles({ workingDirectory: repo, missionId: OTHER_MISSION_ID, files: [claimed] });

  let postedBody: unknown;
  const runtime = {
    backend: {
      baseUrl: 'http://example.test',
      health: async () => ({ ok: true }),
      get: async () => {
        throw new Error('unexpected GET');
      },
      post: async ({ body }: { body: unknown }) => {
        postedBody = body;
        return {};
      },
      patch: async () => {
        throw new Error('unexpected PATCH');
      },
      delete: async () => {
        throw new Error('unexpected DELETE');
      }
    },
    close: () => {}
  } satisfies CliRuntime;

  const originalCwd = process.cwd();
  process.chdir(repo);
  try {
    await runProtocolCommand({
      runtime,
      subcommand: 'deliver',
      args: ['--session-key', 'sess_me', '--mission-id', MISSION_ID, '--summary', 'Done.']
    });
  } finally {
    process.chdir(originalCwd);
  }

  const payload = postedBody as {
    flags?: Record<string, string | true>;
  };
  const changedFiles = JSON.parse(
    String(payload.flags?.['--changed-files-json'] ?? '[]')
  ) as Array<{
    filePath: string;
    attribution?: string;
  }>;
  const skipEntries = JSON.parse(
    String(payload.flags?.['--skip-rationale-for-json'] ?? '[]')
  ) as Array<{ file_path?: string; reason?: string }>;
  const observedDirtyPaths = JSON.parse(
    String(payload.flags?.['--observed-dirty-paths-json'] ?? '[]')
  ) as string[];

  assert.deepEqual(changedFiles.map(entry => entry.filePath).sort(), ['mine.ts', 'unclaimed.ts']);
  assert.deepEqual(skipEntries, [
    {
      file_path: 'claimed.ts',
      reason: `Changed by concurrent mission ${OTHER_MISSION_ID}; excluded from this delivery report.`
    }
  ]);

  // Layer 4: attribution rides along (never persisted) so a residual
  // missing_rationale error can classify without re-deriving touched-log state.
  const byPath = new Map(changedFiles.map(entry => [entry.filePath, entry]));
  assert.equal(byPath.get('mine.ts')?.attribution, 'mine');
  assert.equal(byPath.get('unclaimed.ts')?.attribution, 'unclaimed');

  // Layer 4: the full current dirty tree is sent so the server can reconcile
  // stale changed_files rows to 'resolved', independent of run-attributable
  // filtering.
  assert.deepEqual(observedDirtyPaths.sort(), ['claimed.ts', 'mine.ts', 'unclaimed.ts']);
});

test('ovld protocol changes prints classified paths without calling the backend', async () => {
  const repo = makeRepo();
  writeBaseline({ workingDirectory: repo, missionId: MISSION_ID, files: readChangedFiles(repo) });
  resetTouchedFiles({ workingDirectory: repo, missionId: MISSION_ID });
  writeActiveSession({ workingDirectory: repo, missionId: MISSION_ID, sessionKey: 'sess_me' });
  writeActiveSession({
    workingDirectory: repo,
    missionId: OTHER_MISSION_ID,
    sessionKey: 'sess_other'
  });

  const mine = path.join(repo, 'mine.ts');
  const claimed = path.join(repo, 'claimed.ts');
  const unclaimed = path.join(repo, 'unclaimed.ts');
  writeFileSync(mine, 'mine\n');
  writeFileSync(claimed, 'claimed\n');
  writeFileSync(unclaimed, 'unclaimed\n');
  recordTouchedFiles({ workingDirectory: repo, missionId: MISSION_ID, files: [mine] });
  recordTouchedFiles({ workingDirectory: repo, missionId: OTHER_MISSION_ID, files: [claimed] });

  const runtime = {
    backend: {
      baseUrl: 'http://example.test',
      health: async () => ({ ok: true }),
      get: async () => {
        throw new Error('unexpected GET — changes preflight must be local-only');
      },
      post: async () => {
        throw new Error('unexpected POST — changes preflight must be local-only');
      },
      patch: async () => {
        throw new Error('unexpected PATCH');
      },
      delete: async () => {
        throw new Error('unexpected DELETE');
      }
    },
    close: () => {}
  } satisfies CliRuntime;

  let written = '';
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    written += String(chunk);
    return true;
  }) as typeof process.stdout.write;

  const originalCwd = process.cwd();
  process.chdir(repo);
  try {
    await runProtocolCommand({
      runtime,
      subcommand: 'changes',
      args: ['--mission-id', MISSION_ID]
    });
  } finally {
    process.chdir(originalCwd);
    process.stdout.write = originalWrite;
  }

  const result = JSON.parse(written) as {
    mine: Array<{ filePath: string }>;
    claimed: Array<{ filePath: string; claimedByMissionIds?: string[] }>;
    unclaimed: Array<{ filePath: string }>;
    suggestedSkipRationaleFor: Array<{ file_path: string; reason: string }>;
  };

  assert.deepEqual(
    result.mine.map(entry => entry.filePath),
    ['mine.ts']
  );
  assert.deepEqual(
    result.claimed.map(entry => entry.filePath),
    ['claimed.ts']
  );
  assert.deepEqual(result.claimed[0]?.claimedByMissionIds, [OTHER_MISSION_ID]);
  assert.deepEqual(
    result.unclaimed.map(entry => entry.filePath),
    ['unclaimed.ts']
  );
  assert.deepEqual(result.suggestedSkipRationaleFor, [
    {
      file_path: 'claimed.ts',
      reason: `Changed by concurrent mission ${OTHER_MISSION_ID}; excluded from this delivery report.`
    }
  ]);
});
