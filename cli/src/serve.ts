import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { flagBoolean, flagValue, parseArgs } from './args.js';
import { CliError } from './errors.js';
import { printJson } from './output.js';

/**
 * `ovld serve` — boot a fully-initialized local Overlord instance.
 *
 * This is the single "start the web/REST server" entrypoint shared by the repo,
 * hosted (Railway/Postgres) deployments, and the desktop bundle. It does not
 * reimplement the server: it resolves where the server entry lives, sets the
 * host/port/database environment the server reads on boot, and spawns it. The
 * server itself creates + migrates the SQLite database on first run (see
 * `webapp/server/db.ts`), so a fresh machine comes up with no extra steps.
 *
 * Entry resolution (first match wins):
 *   1. `OVERLORD_SERVER_ENTRY` env — an explicit path (run with the matching
 *      runtime by extension: `.ts` via tsx, otherwise `node`).
 *   2. `<project>/webapp/dist-server/index.cjs` — the esbuild server bundle
 *      (`yarn build:server:prod`), run with `node`. Preferred when present.
 *   3. `<project>/webapp/server/index.ts` — the TypeScript source, run with
 *      tsx. The repo dev path.
 *
 * The desktop app does not use this command: it forks the server bundle inside
 * an Electron `utilityProcess` directly. `ovld serve` is the CLI/repo path.
 */
export async function runServeCommand({ rest }: { rest: string[] }): Promise<void> {
  const parsed = parseArgs(rest);
  const json = flagBoolean(parsed.flags, '--json');

  const { loadConfig, resolveProjectRoot } = await import('./config.js');
  const config = loadConfig();
  const projectRoot = resolveProjectRoot();

  const host = flagValue(parsed.flags, '--host') ?? process.env.OVERLORD_WEB_HOST ?? config.webHost;
  const port =
    flagValue(parsed.flags, '--port') ?? process.env.OVERLORD_WEB_PORT ?? String(config.webPort);
  const dbPath = flagValue(parsed.flags, '--db') ?? process.env.OVERLORD_SQLITE_PATH;

  const resolved = resolveServerEntry(projectRoot);
  if (!resolved) {
    throw new CliError({
      message:
        'Could not find the Overlord web server to serve.\n' +
        `Looked for ${path.join(projectRoot, 'webapp', 'dist-server', 'index.cjs')} (built bundle) ` +
        `and ${path.join(projectRoot, 'webapp', 'server', 'index.ts')} (source).\n` +
        'Run `ovld serve` from an OpenOverlord checkout, build the server bundle with ' +
        '`yarn build:server:prod`, or set OVERLORD_SERVER_ENTRY to the server entry file.'
    });
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OVERLORD_WEB_HOST: host,
    OVERLORD_WEB_PORT: String(port)
  };
  if (dbPath) env.OVERLORD_SQLITE_PATH = dbPath;

  if (json) {
    printJson({
      ok: true,
      entry: resolved.entry,
      runtime: resolved.runtime,
      host,
      port: Number(port),
      databasePath: dbPath ?? null
    });
  } else {
    console.log(`Starting Overlord server (${resolved.runtime}) → http://${host}:${port}`);
  }

  await spawnServer({ ...resolved, env, cwd: projectRoot });
}

type ResolvedEntry = { entry: string; runtime: 'node' | 'tsx' };

function resolveServerEntry(projectRoot: string): ResolvedEntry | null {
  const override = process.env.OVERLORD_SERVER_ENTRY?.trim();
  if (override) {
    const entry = path.isAbsolute(override) ? override : path.resolve(projectRoot, override);
    return { entry, runtime: override.endsWith('.ts') ? 'tsx' : 'node' };
  }

  const bundle = path.join(projectRoot, 'webapp', 'dist-server', 'index.cjs');
  if (existsSync(bundle)) return { entry: bundle, runtime: 'node' };

  const source = path.join(projectRoot, 'webapp', 'server', 'index.ts');
  if (existsSync(source)) return { entry: source, runtime: 'tsx' };

  return null;
}

/**
 * Spawn the resolved server entry, inheriting stdio so its logs stream through,
 * forwarding termination signals so Ctrl-C / `kill` stop the child cleanly, and
 * resolving (exiting) with the child's exit code.
 */
function spawnServer({
  entry,
  runtime,
  env,
  cwd
}: ResolvedEntry & { env: NodeJS.ProcessEnv; cwd: string }): Promise<void> {
  // `node` runs the bundled .mjs directly; `tsx` is loaded via Node's --import
  // hook so the TypeScript source runs without a separate build step.
  const args = runtime === 'tsx' ? ['--import', 'tsx', entry] : [entry];

  const child = spawn(process.execPath, args, { cwd, env, stdio: 'inherit' });

  const forward = (signal: NodeJS.Signals) => {
    if (!child.killed) child.kill(signal);
  };
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);

  return new Promise<void>((resolve, reject) => {
    child.on('error', error => {
      reject(
        new CliError({
          message: `Failed to start the Overlord server: ${
            error instanceof Error ? error.message : String(error)
          }`
        })
      );
    });
    child.on('close', (code, signal) => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
      if (signal) {
        // The child was terminated by a signal (e.g. Ctrl-C) — exit cleanly.
        resolve();
        return;
      }
      if (code && code !== 0) {
        reject(new CliError({ message: `Overlord server exited with code ${code}.` }));
        return;
      }
      resolve();
    });
  });
}
