import { app } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Filesystem layout resolution for dev vs a packaged `.app`.
 *
 * - Dev (`electron .` from `desktop/`): assets live in the repo, one level up
 *   from the desktop workspace (`app.getAppPath()` is the desktop dir).
 * - Packaged: the esbuilt main/preload and the server bundle live inside
 *   `app.asar`; the static SPA and the staged CLI are emitted as `extraResources`
 *   under `process.resourcesPath` (unpacked) so the embedded server can stream
 *   them and the CLI can be executed.
 */
export const isPackaged = app.isPackaged;

/** Repo root in dev (the parent of the desktop workspace). */
function repoRoot(): string {
  return path.resolve(app.getAppPath(), '..');
}

/** The esbuilt server bundle the main process forks as a utilityProcess. */
export function serverBundlePath(): string {
  return isPackaged
    ? path.join(app.getAppPath(), 'server', 'index.cjs')
    : path.join(repoRoot(), 'backend', 'dist-server', 'index.cjs');
}

/** The built static SPA the embedded server serves (absolute, via OVERLORD_WEBAPP_DIST). */
export function webappDistPath(): string {
  return isPackaged
    ? path.join(process.resourcesPath, 'webapp-dist')
    : path.join(repoRoot(), 'webapp', 'dist');
}

/** The bundled `ovld` CLI entry, if present (used to supervise a runner). */
export function bundledCliEntry(): string | null {
  const candidate = isPackaged
    ? path.join(process.resourcesPath, 'cli', 'bin', 'ovld.mjs')
    : path.join(repoRoot(), 'cli', 'bin', 'ovld.mjs');
  return existsSync(candidate) ? candidate : null;
}
