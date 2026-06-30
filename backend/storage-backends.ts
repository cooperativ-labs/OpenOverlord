import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';

import { ApiError } from './errors.ts';

export interface StorageBackend {
  put({
    key,
    bytes,
    contentType
  }: {
    key: string;
    bytes: Buffer;
    contentType: string;
  }): Promise<void>;
  getStream({ key }: { key: string }): Promise<Readable>;
  deleteObject?({ key }: { key: string }): Promise<void>;
  presignGet?({
    key,
    ttlSeconds,
    responseContentDisposition
  }: {
    key: string;
    ttlSeconds: number;
    responseContentDisposition?: string;
  }): Promise<string>;
}

interface StorageBucketConfig {
  id: string;
  bucket_key: string;
  storage_backend: string;
  local_path: string | null;
  settings_json: unknown;
}

interface S3BucketSettings {
  bucketName?: string;
  region?: string;
  endpoint?: string;
  pathPrefix?: string;
}

/** Per-bucket read-path settings from `storage_buckets.settings_json`. */
export interface StorageReadSettings {
  /** When true, authorized reads 302 to a short-lived presigned GET URL (S3 only). */
  presignReads: boolean;
  /** Presigned URL lifetime in seconds, clamped to 60–300. */
  presignTtlSeconds: number;
}

const DEFAULT_PRESIGN_TTL_SECONDS = 300;
const MIN_PRESIGN_TTL_SECONDS = 60;
const MAX_PRESIGN_TTL_SECONDS = 300;

function parseSettingsJson(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== 'string' || raw.trim() === '' || raw === '{}') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readS3BucketSettings(settingsJson: unknown): S3BucketSettings {
  const settings = parseSettingsJson(settingsJson);
  return {
    bucketName: typeof settings.bucketName === 'string' ? settings.bucketName : undefined,
    region: typeof settings.region === 'string' ? settings.region : undefined,
    endpoint: typeof settings.endpoint === 'string' ? settings.endpoint : undefined,
    pathPrefix: typeof settings.pathPrefix === 'string' ? settings.pathPrefix : undefined
  };
}

export function readStorageReadSettings(settingsJson: unknown): StorageReadSettings {
  const settings = parseSettingsJson(settingsJson);
  const presignReads = settings.presignReads === true;
  let presignTtlSeconds = DEFAULT_PRESIGN_TTL_SECONDS;
  if (
    typeof settings.presignTtlSeconds === 'number' &&
    Number.isFinite(settings.presignTtlSeconds)
  ) {
    presignTtlSeconds = Math.min(
      MAX_PRESIGN_TTL_SECONDS,
      Math.max(MIN_PRESIGN_TTL_SECONDS, Math.floor(settings.presignTtlSeconds))
    );
  }
  return { presignReads, presignTtlSeconds };
}

function objectKeyFor({
  storageKey,
  pathPrefix
}: {
  storageKey: string;
  pathPrefix?: string;
}): string {
  if (!pathPrefix || pathPrefix.trim() === '') return storageKey;
  const normalizedPrefix = pathPrefix.replace(/^\/+|\/+$/g, '');
  return normalizedPrefix ? `${normalizedPrefix}/${storageKey}` : storageKey;
}

function isS3CompatibleBackend(storageBackend: string): boolean {
  return storageBackend === 's3' || storageBackend === 'railway_volume';
}

function createLocalFsBackend({
  bucket,
  repoRoot
}: {
  bucket: StorageBucketConfig;
  repoRoot: string;
}): StorageBackend {
  if (!bucket.local_path) {
    throw new ApiError(500, `Bucket '${bucket.bucket_key}' is missing a local_path`);
  }
  const root = path.isAbsolute(bucket.local_path)
    ? bucket.local_path
    : path.resolve(repoRoot, bucket.local_path);

  return {
    async put({ key, bytes }) {
      if (!existsSync(root)) mkdirSync(root, { recursive: true });
      writeFileSync(path.join(root, key), bytes);
    },
    async getStream({ key }) {
      const absolutePath = path.join(root, key);
      if (!existsSync(absolutePath)) throw new ApiError(404, 'File not found');
      return createReadStream(absolutePath);
    }
  };
}

function createS3Backend({
  bucket,
  settings
}: {
  bucket: StorageBucketConfig;
  settings: S3BucketSettings;
}): StorageBackend {
  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim();
  const endpoint = settings.endpoint?.trim() || process.env.S3_ENDPOINT?.trim();
  const region = settings.region?.trim() || process.env.S3_REGION?.trim() || 'us-east-1';
  const bucketName = settings.bucketName?.trim();

  if (!accessKeyId || !secretAccessKey) {
    throw new ApiError(
      503,
      `Storage backend '${bucket.storage_backend}' requires S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY`
    );
  }
  if (!bucketName) {
    throw new ApiError(
      503,
      `Storage backend '${bucket.storage_backend}' requires settings_json.bucketName`
    );
  }

  const client = new S3Client({
    region,
    ...(endpoint ? { endpoint } : {}),
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true
  });

  const resolveKey = (key: string) =>
    objectKeyFor({ storageKey: key, pathPrefix: settings.pathPrefix });

  return {
    async put({ key, bytes, contentType }) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: resolveKey(key),
          Body: bytes,
          ContentType: contentType
        })
      );
    },
    async getStream({ key }) {
      try {
        const response = await client.send(
          new GetObjectCommand({
            Bucket: bucketName,
            Key: resolveKey(key)
          })
        );
        if (!response.Body) throw new ApiError(404, 'File not found');
        return response.Body as Readable;
      } catch (error) {
        const statusCode =
          error && typeof error === 'object' && 'name' in error
            ? (error as { name?: string }).name
            : undefined;
        if (statusCode === 'NoSuchKey' || statusCode === 'NotFound') {
          throw new ApiError(404, 'File not found');
        }
        throw error;
      }
    },
    async deleteObject({ key }) {
      await client.send(
        new DeleteObjectCommand({
          Bucket: bucketName,
          Key: resolveKey(key)
        })
      );
    },
    async presignGet({ key, ttlSeconds, responseContentDisposition }) {
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucketName,
          Key: resolveKey(key),
          ...(responseContentDisposition
            ? { ResponseContentDisposition: responseContentDisposition }
            : {})
        }),
        { expiresIn: ttlSeconds }
      );
    }
  };
}

export function createStorageBackend({
  bucket,
  repoRoot
}: {
  bucket: StorageBucketConfig;
  repoRoot: string;
}): StorageBackend {
  if (bucket.storage_backend === 'local_fs') {
    return createLocalFsBackend({ bucket, repoRoot });
  }
  if (isS3CompatibleBackend(bucket.storage_backend)) {
    return createS3Backend({ bucket, settings: readS3BucketSettings(bucket.settings_json) });
  }
  throw new ApiError(
    501,
    `Storage backend '${bucket.storage_backend}' is not supported by this build`
  );
}
