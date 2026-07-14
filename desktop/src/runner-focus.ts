import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Desktop → persistent-runner focus signal.
 *
 * The CLI supervisor (`ovld runner supervise`) polls at a fast cadence while the
 * Overlord desktop app has been focused recently, so a job the user is about to
 * queue is picked up quickly. The supervisor is a separate process and cannot
 * observe Electron window focus directly, so the desktop shell records the
 * last-focus timestamp to a small file in the shared global data dir that the
 * supervisor reads each poll.
 *
 * This mirrors `cli/src/runner-service.ts` (RUNNER_FOCUS_STATE_FILENAME and the
 * `{ lastFocusedAt }` shape). Keep the filename and shape in sync with that
 * module — the two processes only agree by convention on this file.
 */

const RUNNER_FOCUS_STATE_FILENAME = 'runner-focus.json';

/**
 * Focus events fire on every window activation; the supervisor only cares about
 * a 30-minute recency window, so a stale-by-a-minute timestamp is harmless.
 * Throttle disk writes to at most once per interval to avoid churning the file.
 */
const WRITE_THROTTLE_MS = 60_000;

let lastWrittenAtMs = 0;

function resolveGlobalDataDir(): string {
  return process.env.OVLD_HOME?.trim() || path.join(os.homedir(), '.ovld');
}

function runnerFocusStatePath(): string {
  return path.join(resolveGlobalDataDir(), RUNNER_FOCUS_STATE_FILENAME);
}

/**
 * Record that the desktop app is focused now. Best-effort and throttled: a
 * failed or skipped write must never disrupt the UI, so all errors are
 * swallowed. Pass `force` to bypass the throttle (e.g. on initial app focus).
 */
export function markDesktopFocused({ force = false }: { force?: boolean } = {}): void {
  const nowMs = Date.now();
  if (!force && nowMs - lastWrittenAtMs < WRITE_THROTTLE_MS) return;
  try {
    const dir = resolveGlobalDataDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      runnerFocusStatePath(),
      `${JSON.stringify({ lastFocusedAt: new Date(nowMs).toISOString() }, null, 2)}\n`,
      'utf8'
    );
    lastWrittenAtMs = nowMs;
  } catch {
    // The focus signal is a polling optimization only; never surface a failure.
  }
}
