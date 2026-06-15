import os from 'node:os';
import path from 'node:path';

/** Git-ignored local runtime data (object storage buckets). See root `.gitignore`. */
export const LOCAL_DATA_DIR = 'database/.local';

export const LOCAL_STORAGE_DIR = `${LOCAL_DATA_DIR}/storage`;

export const LOCAL_STORAGE_BUCKET_PATHS = {
  attachments: `${LOCAL_STORAGE_DIR}/attachments`,
  'user-images': `${LOCAL_STORAGE_DIR}/user-images`,
  'workspace-images': `${LOCAL_STORAGE_DIR}/workspace-images`
} as const;

/** Directory name of the per-user global Overlord data directory (`~/.ovld`). */
export const GLOBAL_DATA_DIR_NAME = '.ovld';

/** File name of the SQLite database stored inside the global data directory. */
export const GLOBAL_DATABASE_FILENAME = 'Overlord.sqlite';

/**
 * The per-user global Overlord data directory. By default this is `~/.ovld`
 * (macOS and Linux alike, matching the home-directory convention requested for
 * a single global install). Set `OVLD_HOME` to relocate it — useful for tests,
 * sandboxes, and machines where the home directory is not writable.
 */
export function resolveGlobalDataDir(): string {
  const override = process.env.OVLD_HOME?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), GLOBAL_DATA_DIR_NAME);
}

/**
 * The default SQLite database path when neither `OVERLORD_SQLITE_PATH` nor an
 * `overlord.toml` `database_path` is set: `<global data dir>/Overlord.sqlite`.
 * This replaces the old repo-relative `database/.local/Overlord.sqlite` so a
 * single global install can be used from any working directory.
 */
export function resolveGlobalDatabasePath(): string {
  return path.join(resolveGlobalDataDir(), GLOBAL_DATABASE_FILENAME);
}
