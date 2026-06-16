import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readRepositoryTree, RepositoryReadError } from './git-tree.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

test('readRepositoryTree returns tracked and untracked file structure', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'overlord-git-tree-'));
  try {
    git(dir, ['init']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test User']);

    mkdirSync(path.join(dir, 'src', 'nested'), { recursive: true });
    writeFileSync(path.join(dir, 'README.md'), '# Test\n');
    writeFileSync(path.join(dir, 'src', 'nested', 'tracked.ts'), 'export const x = 1;\n');
    git(dir, ['add', 'README.md', 'src/nested/tracked.ts']);
    git(dir, ['commit', '-m', 'initial']);

    writeFileSync(path.join(dir, 'src', 'untracked.ts'), 'export const y = 2;\n');

    const tree = readRepositoryTree(dir);
    const entriesByPath = new Map(tree.entries.map(entry => [entry.path, entry]));

    assert.equal(tree.gitRoot, realpathSync(dir));
    assert.ok(tree.branch);
    assert.match(tree.commit ?? '', /^[a-f0-9]+$/);
    assert.equal(entriesByPath.get('README.md')?.type, 'file');
    assert.equal(entriesByPath.get('src')?.type, 'directory');
    assert.equal(entriesByPath.get('src/nested')?.type, 'directory');
    assert.equal(entriesByPath.get('src/nested/tracked.ts')?.type, 'file');
    assert.equal(entriesByPath.get('src/untracked.ts')?.type, 'file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readRepositoryTree reports non-git directories', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'overlord-not-git-'));
  try {
    assert.throws(
      () => readRepositoryTree(dir),
      error => error instanceof RepositoryReadError && error.code === 'not_git_repository'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
