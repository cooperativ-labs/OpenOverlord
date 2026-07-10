import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { getActiveBackendProfileId } from './backend-profiles.js';
import {
  getPublicActiveBackend,
  readBearerTokenForProfile,
  readSessionTokenForProfile
} from './backend-runtime.js';
import { bundledCliEntry } from './paths.js';

const execFileAsync = promisify(execFile);

/**
 * Desktop → CLI process-supervision surface for the persistent runner service.
 *
 * The renderer never spawns processes; it asks the shell to run the CLI-owned
 * `ovld runner service <action>` operations (the same commands a user could run
 * manually) and reports the JSON result back. This keeps the CLI as the single
 * owner of local service lifecycle — the shell only starts/stops/monitors it.
 */

export type RunnerServiceAction =
  | 'status'
  | 'install'
  | 'start'
  | 'stop'
  | 'restart'
  | 'uninstall';

export interface RunnerServiceControlResult {
  ok: boolean;
  /** Parsed `--json` payload from the CLI, when the command produced one. */
  status: Record<string, unknown> | null;
  /** Populated when the command failed or its output could not be parsed. */
  error: string | null;
}

/**
 * Build the environment passed to the spawned CLI so an install captures the
 * active backend URL and a token, matching how the desktop already authenticates
 * spawned CLI work (loopback Local mode needs neither).
 */
function resolveControlEnv({ shellOrigin }: { shellOrigin: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  try {
    const active = getPublicActiveBackend({ shellOrigin });
    env.OVERLORD_BACKEND_URL = active.backendUrl;
    if (active.mode === 'remote') {
      const profileId = getActiveBackendProfileId();
      const token =
        readBearerTokenForProfile(profileId) ?? readSessionTokenForProfile(profileId) ?? null;
      if (token) env.OVERLORD_USER_TOKEN = token;
    }
  } catch {
    // If backend resolution fails, fall back to the inherited environment; the
    // CLI still resolves its own config from disk.
  }
  return env;
}

/**
 * Run one `ovld runner service <action>` command through the bundled CLI and
 * return its parsed JSON status. Never throws across the IPC boundary — failures
 * come back as `{ ok: false, error }`.
 */
export async function runRunnerServiceControl({
  action,
  shellOrigin,
  extraArgs = []
}: {
  action: RunnerServiceAction;
  shellOrigin: string;
  extraArgs?: string[];
}): Promise<RunnerServiceControlResult> {
  const cliEntry = bundledCliEntry();
  const program = cliEntry ? process.execPath : 'ovld';
  const args = cliEntry
    ? [cliEntry, 'runner', 'service', action, ...extraArgs, '--json']
    : ['runner', 'service', action, ...extraArgs, '--json'];

  try {
    const { stdout } = await execFileAsync(program, args, {
      env: resolveControlEnv({ shellOrigin }),
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024
    });
    const text = stdout.toString().trim();
    if (!text) return { ok: true, status: null, error: null };
    try {
      return { ok: true, status: JSON.parse(text) as Record<string, unknown>, error: null };
    } catch {
      return { ok: false, status: null, error: `Unexpected CLI output: ${text.slice(0, 500)}` };
    }
  } catch (error) {
    // execFile rejects with stderr attached on non-zero exit; surface it.
    const err = error as { stderr?: Buffer | string; message?: string };
    const stderr = err.stderr ? err.stderr.toString().trim() : '';
    return { ok: false, status: null, error: stderr || err.message || 'Runner service command failed.' };
  }
}
