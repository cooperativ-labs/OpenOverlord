// Pack-time vendoring of the `@overlord/database` workspace package.
//
// The CLI is published/global-installed as a self-contained tarball, but its
// dependency on `@overlord/database` is a `workspace:*` edge that npm cannot
// resolve from the registry (the package is private and unpublished). Yarn
// hoists the package to the repo-root `node_modules`, so `bundleDependencies`
// finds nothing under `cli/node_modules` at pack time.
//
// This script materializes the *built* database package (its `dist/` plus the
// shipped SQLite/Postgres migrations) into `cli/node_modules/@overlord/database`
// as a real directory, so `npm pack` physically bundles it. `restore` puts the
// Yarn workspace symlink back afterwards. Run `build:db` before `vendor`.

import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(cliRoot, '..');
const source = path.join(repoRoot, 'database');
const destParent = path.join(cliRoot, 'node_modules', '@overlord');
const dest = path.join(destParent, 'database');

const mode = process.argv[2] ?? 'vendor';

function vendor() {
  if (!existsSync(path.join(source, 'dist', 'index.js'))) {
    throw new Error('Build @overlord/database before vendoring (run `yarn build:db`).');
  }

  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });

  // Mirror the package's published `files`: package.json, dist/, migrations.
  cpSync(path.join(source, 'package.json'), path.join(dest, 'package.json'));
  cpSync(path.join(source, 'dist'), path.join(dest, 'dist'), { recursive: true });
  for (const rel of ['sqlite/migrations', 'postgres/migrations']) {
    const from = path.join(source, rel);
    if (existsSync(from)) {
      cpSync(from, path.join(dest, rel), { recursive: true });
    }
  }
}

function restore() {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(destParent, { recursive: true });
  // Recreate the Yarn workspace symlink so the dev tree is unchanged.
  symlinkSync(path.relative(destParent, source), dest, 'dir');
}

if (mode === 'restore') {
  restore();
} else {
  vendor();
}
