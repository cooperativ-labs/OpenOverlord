#!/usr/bin/env node
// Run a command with the repo's development `.env.local` applied (persistent
// OVLD_HOME, dev ports, backend URL). Used by `yarn ovld:dev` and any workflow
// that should share the same in-repo dev instance as `yarn dev`.
//
// Usage: node scripts/with-dev-env.mjs <command> [args...]

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRepoEnvForProfile } from './load-repo-env.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
loadRepoEnvForProfile({ repoRoot: path.resolve(scriptDir, '..'), profile: 'development' });

const [, , command, ...args] = process.argv;
if (!command) {
  console.error('usage: with-dev-env.mjs <command> [args...]');
  process.exit(2);
}

const child = spawn(command, args, {
  stdio: 'inherit',
  env: process.env
});

child.on('error', error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
