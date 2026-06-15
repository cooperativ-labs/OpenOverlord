#!/usr/bin/env node
/**
 * Updates the "minor" (datetime) segment of the version string.
 * Version format: [major].[yymmddhhmm].[patch]
 * Rewrites all package.json files that participate in this versioning scheme.
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function getDatetime() {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(2);
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `${yy}${mo}${dd}${hh}${mm}`;
}

function bumpDatetime(version) {
  const parts = version.split('.');
  if (parts.length !== 3) {
    throw new Error(`Unexpected version format: "${version}" — expected [major].[datetime].[patch]`);
  }
  return `${parts[0]}.${getDatetime()}.${parts[2]}`;
}

function updatePackage(relPath) {
  const absPath = resolve(root, relPath);
  const pkg = JSON.parse(readFileSync(absPath, 'utf8'));
  const oldVersion = pkg.version;
  pkg.version = bumpDatetime(oldVersion);
  writeFileSync(absPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`${relPath}: ${oldVersion} → ${pkg.version}`);
}

const targets = [
  'package.json',
  'cli/package.json',
  'desktop/package.json',
];

const datetime = getDatetime();
console.log(`Updating versions — datetime segment: ${datetime}`);
for (const target of targets) {
  updatePackage(target);
}
