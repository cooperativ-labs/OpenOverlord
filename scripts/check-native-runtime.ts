/**
 * Verifies the root `better-sqlite3` native addon loads under the current host's
 * platform/arch/Node ABI, and optionally rebuilds it when it doesn't.
 *
 * The repo root `node_modules` is meant to stay host-owned (see
 * planning/feature-plans/native-node-modules-isolation.md), but it gets clobbered
 * whenever a Linux agent-pod container or a different Node version runs `yarn
 * install`/`yarn rebuild` against the same checkout. This catches that early with
 * an actionable message instead of 20 unrelated-looking test failures.
 *
 * Usage: tsx scripts/check-native-runtime.ts [--fix]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const addonPath = path.join(
  repoRoot,
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
  'better_sqlite3.node'
);

const MACHO_MAGICS = ['cffaedfe', 'cefaedfe', 'feedface', 'feedfacf'];

function describeFormat(buffer: Buffer): string {
  const hex4 = buffer.subarray(0, 4).toString('hex');
  if (MACHO_MAGICS.includes(hex4)) return 'Mach-O (macOS)';
  if (hex4 === '7f454c46') return 'ELF (Linux)';
  if (buffer.subarray(0, 2).toString('ascii') === 'MZ') return 'PE (Windows)';
  return `unknown (${hex4 || 'empty'})`;
}

function expectedFormat(): string {
  if (process.platform === 'darwin') return 'Mach-O (macOS)';
  if (process.platform === 'linux') return 'ELF (Linux)';
  if (process.platform === 'win32') return 'PE (Windows)';
  return process.platform;
}

function tryLoad(): { ok: true } | { ok: false; error: string } {
  try {
    const require = createRequire(import.meta.url);
    const resolved = require.resolve('better-sqlite3', { paths: [repoRoot] });
    delete require.cache[resolved];
    const Database = require(resolved);
    const db = new Database(':memory:');
    db.prepare('select 1 ok').get();
    db.close();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function rebuild(): boolean {
  console.log('check-native-runtime: rebuilding better-sqlite3 for this host...');
  const result = spawnSync('yarn', ['rebuild', 'better-sqlite3'], { cwd: repoRoot, stdio: 'inherit' });
  return result.status === 0;
}

function report(reason: string): void {
  const actual = existsSync(addonPath) ? describeFormat(readFileSync(addonPath)) : 'missing';
  console.error(`check-native-runtime: ${reason}`);
  console.error(
    `  host: ${process.platform}/${process.arch}, Node ABI ${process.versions.modules}; ` +
      `addon: ${actual}, host expects ${expectedFormat()}`
  );
}

const shouldFix = process.argv.includes('--fix');
let result = tryLoad();

if (!result.ok) {
  report(`better-sqlite3 failed to load (${result.error.split('\n')[0]}).`);
  if (!shouldFix) {
    console.error('  Fix: yarn rebuild better-sqlite3');
    console.error(
      '  If this keeps recurring, the root node_modules is likely shared with a Linux ' +
        'agent-pod container or a different Node version — see ' +
        'planning/feature-plans/native-node-modules-isolation.md.'
    );
    process.exit(1);
  }
  if (!rebuild() || !(result = tryLoad()).ok) {
    report('still failing after rebuild.');
    process.exit(1);
  }
  console.log('check-native-runtime: rebuild fixed it.');
}

console.log(
  `check-native-runtime: better-sqlite3 OK (${process.platform}/${process.arch}, ` +
    `Node ABI ${process.versions.modules}).`
);
