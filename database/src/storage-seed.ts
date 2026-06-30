import { type DatabaseClient } from './client.js';

/**
 * Hosted S3 storage seed.
 *
 * Migration `004_storage.sql` seeds three `local_fs` storage buckets
 * (`workspace-images`, `user-images`, `attachments`) on both SQLite and
 * Postgres. For hosted deployments that run an S3-compatible object store
 * (MinIO on Railway, AWS S3, R2, …) we want those same logical buckets to use
 * the `s3` backend instead — without a code change and without ever putting
 * credentials in the database.
 *
 * This module flips the bucket rows to `storage_backend = 's3'` and records the
 * **non-secret** provider metadata in `settings_json` (`bucketName`, `region`,
 * `endpoint`, `pathPrefix`). Secrets (`S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`)
 * stay in deployment environment variables and are only read at byte-I/O time by
 * `backend/storage-backends.ts`. The schema contract requires credentials
 * never live in `storage_buckets`, so they are deliberately not persisted here.
 *
 * The flip is **idempotent** and **opt-in by data**: it only runs when the S3
 * env vars are present and only updates rows whose backend/settings differ from
 * the desired hosted config. Local/SQLite installs never have these env vars and
 * are never touched — `initDatabase()` only calls this on the Postgres path.
 */

/** Logical buckets that move to the hosted S3 backend together. */
const HOSTED_S3_BUCKET_KEYS = ['workspace-images', 'user-images', 'attachments'] as const;

/** Non-secret per-bucket provider metadata persisted to `settings_json`. */
export interface S3BucketSettings {
  bucketName: string;
  region: string;
  endpoint: string;
  pathPrefix: string;
}

export interface HostedS3SeedResult {
  /** Number of bucket rows updated to the hosted S3 config. */
  updated: number;
  /** Why the seed made no changes, when it didn't. */
  skipped: 'no-s3-env' | null;
}

/**
 * Resolve the hosted S3 configuration from environment variables. Returns
 * `null` (the seed becomes a no-op) unless the **required** vars are all
 * present: `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT`, and a
 * bucket name (`S3_BUCKET` or `S3_BUCKET_NAME`). `S3_REGION` defaults to
 * `us-east-1` (MinIO ignores region but the SDK requires one). `S3_PATH_PREFIX`
 * is an optional base prefix applied under each logical bucket.
 *
 * The access key / secret are checked for presence only — they gate the flip
 * but are never written to the database.
 */
export function resolveHostedS3SettingsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): { settingsFor: (bucketKey: string) => S3BucketSettings } | null {
  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim();
  const endpoint = env.S3_ENDPOINT?.trim();
  const bucketName = (env.S3_BUCKET ?? env.S3_BUCKET_NAME)?.trim();
  const region = env.S3_REGION?.trim() || 'us-east-1';
  const basePrefix = env.S3_PATH_PREFIX?.trim().replace(/^\/+|\/+$/g, '') ?? '';

  if (!accessKeyId || !secretAccessKey || !endpoint || !bucketName) return null;

  return {
    settingsFor(bucketKey: string): S3BucketSettings {
      const pathPrefix = basePrefix ? `${basePrefix}/${bucketKey}` : bucketKey;
      return { bucketName, region, endpoint, pathPrefix };
    }
  };
}

/**
 * `settings_json` arrives as a string on SQLite (TEXT) and as an already-parsed
 * object on Postgres (jsonb). Normalize both to a plain object for comparison.
 */
function parseSettings(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function settingsMatch(current: Record<string, unknown>, desired: S3BucketSettings): boolean {
  return (
    current.bucketName === desired.bucketName &&
    current.region === desired.region &&
    current.endpoint === desired.endpoint &&
    current.pathPrefix === desired.pathPrefix
  );
}

/**
 * Idempotently point the hosted storage buckets at the S3 backend when the S3
 * env vars are present. No-op (returns `skipped: 'no-s3-env'`) otherwise, so
 * local/SQLite installs keep `local_fs`. Safe to run on every boot.
 */
export async function applyHostedS3StorageBackend(
  client: DatabaseClient,
  env: NodeJS.ProcessEnv = process.env
): Promise<HostedS3SeedResult> {
  const resolved = resolveHostedS3SettingsFromEnv(env);
  if (!resolved) return { updated: 0, skipped: 'no-s3-env' };

  const now = new Date().toISOString();
  let updated = 0;

  for (const bucketKey of HOSTED_S3_BUCKET_KEYS) {
    const desired = resolved.settingsFor(bucketKey);
    const rows = await client.all<{
      id: string;
      storage_backend: string;
      settings_json: unknown;
    }>(
      `SELECT id, storage_backend, settings_json FROM storage_buckets
         WHERE bucket_key = ? AND deleted_at IS NULL`,
      [bucketKey]
    );

    for (const row of rows) {
      const alreadyS3 = row.storage_backend === 's3';
      if (alreadyS3 && settingsMatch(parseSettings(row.settings_json), desired)) continue;
      await client.run(
        `UPDATE storage_buckets
           SET storage_backend = 's3', settings_json = ?, updated_at = ?
           WHERE id = ?`,
        [JSON.stringify(desired), now, row.id]
      );
      updated += 1;
    }
  }

  return { updated, skipped: null };
}
