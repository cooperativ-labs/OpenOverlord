import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { recordTouchedFromPayload } from '../src/record-touched.ts';
import { computeRunDelta, readChangedFiles, writeBaseline } from '../src/vcs.ts';
import { writeActiveSession } from '../src/vcs-sessions.ts';

const MISSION_ID = 'coo:127';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
}

function makeRepo(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), 'ovld-record-touched-home-'));
  process.env.OVLD_HOME = home;
  const repo = mkdtempSync(path.join(os.tmpdir(), 'ovld-record-touched-repo-'));
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  writeFileSync(path.join(repo, 'committed.txt'), 'base\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'init']);
  return repo;
}

function classified(repo: string): { filePath: string; attribution?: string }[] {
  return computeRunDelta({ workingDirectory: repo, missionId: MISSION_ID })
    .map(entry => ({ filePath: entry.filePath, attribution: entry.attribution }))
    .sort((left, right) => left.filePath.localeCompare(right.filePath));
}

test('recordTouchedFromPayload resolves the mission from the active-session manifest (no MISSION_ID env needed)', () => {
  const repo = makeRepo();
  writeBaseline({ workingDirectory: repo, missionId: MISSION_ID, files: readChangedFiles(repo) });
  writeActiveSession({ workingDirectory: repo, missionId: MISSION_ID, sessionKey: 'sess_1' });

  const edited = path.join(repo, 'edited.ts');
  writeFileSync(edited, 'export const edited = 1;\n');

  const result = recordTouchedFromPayload({
    rawPayload: JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: edited },
      cwd: repo
    }),
    fallbackCwd: repo
  });

  assert.deepEqual(result, { recorded: true, missionId: MISSION_ID, ambiguous: false, files: 1 });
  assert.deepEqual(classified(repo), [{ filePath: 'edited.ts', attribution: 'mine' }]);
});

test('recordTouchedFromPayload folds Bash-mediated changes into the touched log via git-status diff', () => {
  const repo = makeRepo();
  writeBaseline({ workingDirectory: repo, missionId: MISSION_ID, files: readChangedFiles(repo) });
  writeActiveSession({ workingDirectory: repo, missionId: MISSION_ID, sessionKey: 'sess_2' });

  // Simulate a codegen script run via Bash: no file_path in tool_input at all.
  writeFileSync(path.join(repo, 'generated.ts'), 'export const generated = 1;\n');

  const result = recordTouchedFromPayload({
    rawPayload: JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'node scripts/codegen.js' },
      cwd: repo
    }),
    fallbackCwd: repo
  });

  assert.deepEqual(result, { recorded: true, missionId: MISSION_ID, ambiguous: false, files: 1 });
  assert.deepEqual(classified(repo), [{ filePath: 'generated.ts', attribution: 'mine' }]);
});

test('recordTouchedFromPayload treats Cursor Shell tools as Bash-mediated changes', () => {
  const repo = makeRepo();
  writeBaseline({ workingDirectory: repo, missionId: MISSION_ID, files: readChangedFiles(repo) });
  writeActiveSession({ workingDirectory: repo, missionId: MISSION_ID, sessionKey: 'sess_cursor' });

  writeFileSync(path.join(repo, 'cursor-generated.ts'), 'export const generated = 1;\n');

  const result = recordTouchedFromPayload({
    rawPayload: JSON.stringify({
      tool_name: 'Shell',
      tool_input: { command: 'node scripts/codegen.js' },
      cwd: repo
    }),
    fallbackCwd: repo
  });

  assert.deepEqual(result, { recorded: true, missionId: MISSION_ID, ambiguous: false, files: 1 });
  assert.deepEqual(classified(repo), [{ filePath: 'cursor-generated.ts', attribution: 'mine' }]);
});

test('recordTouchedFromPayload is a no-op when no active session manifest entry exists for the cwd', () => {
  const repo = makeRepo();

  const result = recordTouchedFromPayload({
    rawPayload: JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
      cwd: repo
    }),
    fallbackCwd: repo
  });

  assert.deepEqual(result, {
    recorded: false,
    reason: 'no active session manifest entry for this cwd'
  });
});
