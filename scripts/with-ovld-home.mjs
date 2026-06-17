#!/usr/bin/env node
// Run a command against an isolated, throwaway Overlord home so in-repo builds
// (the test suite and manual `yarn ovld:dev` runs) never read or write the
// installed Desktop instance's data at `~/.ovld` / `:4310`.
//
// Isolation knobs (all honour an already-set value so a persistent dev instance
// can be pinned across processes):
//   - OVLD_HOME            relocates the global `~/.ovld` data dir (DB, storage,
//                          vcs-baselines, native-sessions). Defaults to a fresh
//                          temp dir that is deleted when the command exits.
//   - OVERLORD_WEB_PORT    port any backend started under this home binds to
//                          (default 4320, never the installed `:4310`).
//   - OVERLORD_BACKEND_URL backend the in-repo CLI targets (default the same
//                          loopback dev port), so `ovld:dev` talks to the
//                          isolated instance instead of the repo `overlord.toml`.
//
// Usage: node scripts/with-ovld-home.mjs <command> [args...]

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [, , command, ...args] = process.argv;
if (!command) {
  console.error('usage: with-ovld-home.mjs <command> [args...]');
  process.exit(2);
}

const reusedHome = process.env.OVLD_HOME?.trim();
const ephemeral = !reusedHome;
const home = reusedHome ?? mkdtempSync(path.join(tmpdir(), 'ovld-dev-home-'));

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
