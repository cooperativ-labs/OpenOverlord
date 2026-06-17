import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ensureProjectTmpDir,
  PROJECT_TMP_RETENTION_MS,
  projectTmpDir,
  pruneStaleProjectTmp
} from '../src/project-tmp.ts';

function makeProjectDir(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ovld-project-tmp-'));
  mkdirSync(path.join(directory, '.overlord'), { recursive: true });
  return directory;
}

test('ensureProjectTmpDir creates the shared project tmp directory', () => {
  const workingDirectory = makeProjectDir();
  const tmpDir = ensureProjectTmpDir(workingDirectory);
  assert.equal(tmpDir, projectTmpDir(workingDirectory));
  assert.equal(statSync(tmpDir).isDirectory(), true);
});

test('pruneStaleProjectTmp removes only entries older than the retention window', () => {
  const workingDirectory = makeProjectDir();
  const tmpDir = ensureProjectTmpDir(workingDirectory);
  const staleFile = path.join(tmpDir, 'stale.md');
  const freshFile = path.join(tmpDir, 'fresh.md');

  writeFileSync(staleFile, 'stale\n');
  writeFileSync(freshFile, 'fresh\n');

  const staleTime = new Date(Date.now() - PROJECT_TMP_RETENTION_MS - 60_000);
  utimesSync(staleFile, staleTime, staleTime);

  pruneStaleProjectTmp({ workingDirectory });

  assert.deepEqual(readdirSync(tmpDir).sort(), ['fresh.md']);
});

test('pruneStaleProjectTmp removes stale empty subdirectories and keeps fresh ones', () => {
  const workingDirectory = makeProjectDir();
  const tmpDir = ensureProjectTmpDir(workingDirectory);
  const staleDir = path.join(tmpDir, 'stale-dir');
  const freshDir = path.join(tmpDir, 'fresh-dir');

  mkdirSync(staleDir, { recursive: true });
  mkdirSync(freshDir, { recursive: true });

  const staleTime = new Date(Date.now() - PROJECT_TMP_RETENTION_MS - 60_000);
  utimesSync(staleDir, staleTime, staleTime);

  pruneStaleProjectTmp({ workingDirectory });

  assert.deepEqual(readdirSync(tmpDir).sort(), ['fresh-dir']);
});

test('pruneStaleProjectTmp does not create .overlord/tmp unless asked to', () => {
  const workingDirectory = mkdtempSync(path.join(os.tmpdir(), 'ovld-project-no-tmp-'));
  pruneStaleProjectTmp({ workingDirectory });
  assert.equal(readdirSync(workingDirectory).length, 0);
});
