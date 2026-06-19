#!/usr/bin/env node
// Run a command against an isolated, throwaway Overlord home so the test suite
// never reads or writes the installed Desktop instance (`~/.ovld`) or the
// persistent in-repo dev instance (`database/.local/dev-home` from `.env.local`).
//
// Loads dev port/backend defaults from `.env.local` but always uses a fresh
// temp OVLD_HOME unless the shell already exported OVLD_HOME before this script
// started.
//
// Usage: node scripts/with-ovld-home.mjs <command> [args...]

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRepoEnvForProfile } from './load-repo-env.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const shellHome = process.env.OVLD_HOME?.trim();

loadRepoEnvForProfile({
  repoRoot: path.resolve(scriptDir, '..'),
  profile: 'development',
  skipKeys: ['OVLD_HOME']
});

const [, , command, ...args] = process.argv;
if (!command) {
  console.error('usage: with-ovld-home.mjs <command> [args...]');
  process.exit(2);
}

const ephemeral = !shellHome;
const home = shellHome ?? mkdtempSync(path.join(tmpdir(), 'ovld-test-home-'));

const webPort = process.env.OVERLORD_WEB_PORT ?? '4320';
const backendUrl = process.env.OVERLORD_BACKEND_URL ?? `http://127.0.0.1:${webPort}`;

let cleaned = false;
function cleanup() {
  if (cleaned || !ephemeral) return;
  cleaned = true;
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // best-effort: a leftover temp dir is harmless.
  }
}

const child = spawn(command, args, {
  stdio: 'inherit',
  env: {
    ...process.env,
    OVLD_HOME: home,
    OVERLORD_WEB_PORT: webPort,
    OVERLORD_BACKEND_URL: backendUrl
  }
});

child.on('error', error => {
  cleanup();
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  cleanup();
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
