import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  computeRunDelta,
  filterRunAttributableChanges,
  readChangedFiles,
  writeBaseline
} from '../src/vcs.ts';

function initGitRepo(dir: string): void {
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  writeFileSync(path.join(dir, 'README.md'), '# test\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
}

test('readChangedFiles returns normalized paths from git status', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'overlord-vcs-'));
  initGitRepo(dir);
  writeFileSync(path.join(dir, 'tracked.ts'), 'export const x = 1;\n');
  execFileSync('git', ['add', 'tracked.ts'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'add tracked'], { cwd: dir });
  writeFileSync(path.join(dir, 'tracked.ts'), 'export const x = 2;\n');
  writeFileSync(path.join(dir, 'new-file.ts'), 'export const y = 1;\n');

  const files = readChangedFiles(dir);
  assert.deepEqual(files.map(entry => entry.filePath).sort(), ['new-file.ts', 'tracked.ts']);
});

test('computeRunDelta excludes unchanged dirty paths from the session baseline', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'overlord-vcs-home-'));
  const dir = mkdtempSync(path.join(tmpdir(), 'overlord-vcs-repo-'));
  const previousHome = process.env.OVLD_HOME;
  process.env.OVLD_HOME = home;
  try {
    initGitRepo(dir);
    writeFileSync(path.join(dir, 'pre-existing.ts'), 'pre\n');
    writeFileSync(path.join(dir, 'agent-made.ts'), 'agent\n');
    writeBaseline({
      workingDirectory: dir,
      ticketId: 'coo:15',
      files: readChangedFiles(dir)
    });

    const delta = computeRunDelta({ workingDirectory: dir, ticketId: 'coo:15' });
    assert.deepEqual(
      delta.map(entry => entry.filePath),
      []
    );
  } finally {
    if (previousHome === undefined) delete process.env.OVLD_HOME;
    else process.env.OVLD_HOME = previousHome;
  }
});

test('computeRunDelta includes edits to files that were already dirty at attach', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'overlord-vcs-home-'));
  const dir = mkdtempSync(path.join(tmpdir(), 'overlord-vcs-repo-'));
  const previousHome = process.env.OVLD_HOME;
  process.env.OVLD_HOME = home;
  try {
    initGitRepo(dir);
    writeFileSync(path.join(dir, 'already-dirty.ts'), 'before attach\n');
    writeBaseline({
      workingDirectory: dir,
      ticketId: 'coo:15',
      files: readChangedFiles(dir)
    });
    writeFileSync(path.join(dir, 'already-dirty.ts'), 'after attach\n');
    writeFileSync(path.join(dir, 'agent-made.ts'), 'new file\n');

    const delta = computeRunDelta({ workingDirectory: dir, ticketId: 'coo:15' });
    assert.deepEqual(delta.map(entry => entry.filePath).sort(), [
      'agent-made.ts',
      'already-dirty.ts'
    ]);
  } finally {
    if (previousHome === undefined) delete process.env.OVLD_HOME;
    else process.env.OVLD_HOME = previousHome;
  }
});

test('filterRunAttributableChanges drops unchanged baseline paths from explicit payloads', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'overlord-vcs-home-'));
  const dir = mkdtempSync(path.join(tmpdir(), 'overlord-vcs-repo-'));
  const previousHome = process.env.OVLD_HOME;
  process.env.OVLD_HOME = home;
  try {
    initGitRepo(dir);
    writeFileSync(path.join(dir, 'already-dirty.ts'), 'unchanged\n');
    writeBaseline({
      workingDirectory: dir,
      ticketId: 'coo:15',
      files: readChangedFiles(dir)
    });
    writeFileSync(path.join(dir, 'agent-made.ts'), 'new\n');

    const filtered = filterRunAttributableChanges({
      workingDirectory: dir,
      ticketId: 'coo:15',
      files: [
        { filePath: 'already-dirty.ts', vcsStatus: 'M' },
        { filePath: 'agent-made.ts', vcsStatus: 'M' },
        { filePath: 'concurrent-edit.ts', vcsStatus: 'M' }
      ]
    });

    assert.deepEqual(filtered.map(entry => entry.filePath).sort(), [
      'agent-made.ts',
      'concurrent-edit.ts'
    ]);
  } finally {
    if (previousHome === undefined) delete process.env.OVLD_HOME;
    else process.env.OVLD_HOME = previousHome;
  }
});
