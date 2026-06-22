import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  computeRunDelta,
  readChangedFiles,
  recordTouchedFiles,
  resetTouchedFiles,
  writeBaseline
} from '../src/vcs.ts';

const TICKET_ID = 'coo:9';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
}

/** A throwaway git repo with one committed file, plus an isolated OVLD_HOME. */
function makeRepo(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), 'ovld-vcs-home-'));
  process.env.OVLD_HOME = home;
  const repo = mkdtempSync(path.join(os.tmpdir(), 'ovld-vcs-repo-'));
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  writeFileSync(path.join(repo, 'committed.txt'), 'base\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'init']);
  return repo;
}

function paths(repo: string): string[] {
  return computeRunDelta({ workingDirectory: repo, ticketId: TICKET_ID })
    .map(entry => entry.filePath)
    .sort();
}

test('computeRunDelta reports only files this agent touched, excluding concurrent edits', () => {
  const repo = makeRepo();
  writeBaseline({ workingDirectory: repo, ticketId: TICKET_ID, files: readChangedFiles(repo) });
  resetTouchedFiles({ workingDirectory: repo, ticketId: TICKET_ID });

  const mine = path.join(repo, 'mine.ts');
  writeFileSync(mine, 'export const mine = 1;\n');
  recordTouchedFiles({ workingDirectory: repo, ticketId: TICKET_ID, files: [mine] });

  // Concurrent ticket dirties another file; NOT recorded as touched here.
  writeFileSync(path.join(repo, 'concurrent.ts'), 'export const other = 2;\n');

  assert.deepEqual(paths(repo), ['mine.ts']);
});

test('a touched file already dirty (committed) earlier is still reported', () => {
  const repo = makeRepo();
  writeBaseline({ workingDirectory: repo, ticketId: TICKET_ID, files: readChangedFiles(repo) });
  resetTouchedFiles({ workingDirectory: repo, ticketId: TICKET_ID });

  const committed = path.join(repo, 'committed.txt');
  writeFileSync(committed, 'base\nmore\n');
  recordTouchedFiles({ workingDirectory: repo, ticketId: TICKET_ID, files: [committed] });

  assert.deepEqual(paths(repo), ['committed.txt']);
});

test('without a touched log, deliver falls back to baseline-delta (hookless connectors)', () => {
  const repo = makeRepo();
  writeBaseline({ workingDirectory: repo, ticketId: TICKET_ID, files: readChangedFiles(repo) });
  resetTouchedFiles({ workingDirectory: repo, ticketId: TICKET_ID });

  writeFileSync(path.join(repo, 'a.ts'), 'a\n');
  writeFileSync(path.join(repo, 'b.ts'), 'b\n');

  assert.deepEqual(paths(repo), ['a.ts', 'b.ts']);
});

test('files dirty before the session began are excluded from the run delta', () => {
  const repo = makeRepo();
  const preexisting = path.join(repo, 'preexisting.ts');
  writeFileSync(preexisting, 'pre\n');
  writeBaseline({ workingDirectory: repo, ticketId: TICKET_ID, files: readChangedFiles(repo) });
  resetTouchedFiles({ workingDirectory: repo, ticketId: TICKET_ID });

  const mine = path.join(repo, 'mine.ts');
  writeFileSync(mine, 'mine\n');
  recordTouchedFiles({ workingDirectory: repo, ticketId: TICKET_ID, files: [mine] });

  assert.deepEqual(paths(repo), ['mine.ts']);
});

test('.overlordignore excludes matching files from the run delta', () => {
  const repo = makeRepo();
  // Commit the paths first so `git status --porcelain` lists each modified file
  // individually (it collapses a fully-untracked directory to a single entry).
  execFileSync('mkdir', ['-p', path.join(repo, 'build')]);
  for (const rel of ['install-state.gz', 'debug.log', 'build/out.js', 'src.ts']) {
    const abs = path.join(repo, rel);
    execFileSync('mkdir', ['-p', path.dirname(abs)]);
    writeFileSync(abs, 'base\n');
  }
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'tracked']);

  writeFileSync(
    path.join(repo, '.overlordignore'),
    '# generated artifacts\ninstall-state.gz\n*.log\nbuild/\n'
  );
  writeBaseline({ workingDirectory: repo, ticketId: TICKET_ID, files: readChangedFiles(repo) });
  resetTouchedFiles({ workingDirectory: repo, ticketId: TICKET_ID });

  for (const rel of ['install-state.gz', 'debug.log', 'build/out.js', 'src.ts']) {
    const abs = path.join(repo, rel);
    writeFileSync(abs, 'changed\n');
    recordTouchedFiles({ workingDirectory: repo, ticketId: TICKET_ID, files: [abs] });
  }

  assert.deepEqual(paths(repo), ['src.ts']);
});

test('.overlordignore negation (!) re-includes a previously ignored file', () => {
  const repo = makeRepo();
  writeFileSync(path.join(repo, '.overlordignore'), '*.gz\n!keep.gz\n');
  writeBaseline({ workingDirectory: repo, ticketId: TICKET_ID, files: readChangedFiles(repo) });
  resetTouchedFiles({ workingDirectory: repo, ticketId: TICKET_ID });

  for (const rel of ['drop.gz', 'keep.gz']) {
    const abs = path.join(repo, rel);
    writeFileSync(abs, 'x\n');
    recordTouchedFiles({ workingDirectory: repo, ticketId: TICKET_ID, files: [abs] });
  }

  assert.deepEqual(paths(repo), ['keep.gz']);
});

test('resetTouchedFiles clears a prior session log so its edits are not re-attributed to the next session', () => {
  const repo = makeRepo();
  writeBaseline({ workingDirectory: repo, ticketId: TICKET_ID, files: readChangedFiles(repo) });

  // Session A edits stale.ts.
  const stale = path.join(repo, 'stale.ts');
  writeFileSync(stale, 'stale\n');
  recordTouchedFiles({ workingDirectory: repo, ticketId: TICKET_ID, files: [stale] });
  assert.deepEqual(paths(repo), ['stale.ts']);

  // Session B (re)attaches — reset clears A's log — then edits only mine.ts.
  resetTouchedFiles({ workingDirectory: repo, ticketId: TICKET_ID });
  const mine = path.join(repo, 'mine.ts');
  writeFileSync(mine, 'mine\n');
  recordTouchedFiles({ workingDirectory: repo, ticketId: TICKET_ID, files: [mine] });

  // stale.ts is still dirty but belongs to the prior session, so it is excluded.
  assert.deepEqual(paths(repo), ['mine.ts']);
});
