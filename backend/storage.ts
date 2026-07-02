/**
 * Core upload service.
 *
 * A small, reusable storage layer that other components (avatars, workspace
 * images, attachments, …) can build on. It owns the mechanics shared by every
 * upload: resolving a workspace `storage_buckets` row, validating image bytes,
 * writing them to the bucket's backend, recording provider-neutral metadata in
 * the matching object table, and producing a server-relative URL the SPA can
 * load.
 *
 * Bytes live in the storage backend (`local_fs` on disk for local installs, or
 * `s3` / `railway_volume` against an S3-compatible endpoint for hosted
 * deployments); the database holds metadata and backend keys only — see
 * database/docs/09-database-schema-contract.md (`storage_buckets`, `user_images`).
 *
 * `user-images`, `workspace-images`, and `attachments` are each wired through
 * their own metadata writer; the bucket lookup, byte I/O, and serve path are
 * generic and shared across all three.
 */

import type { DatabaseClient } from '@overlord/database';
import type { Response } from 'express';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import type { ObjectiveAttachmentDto, StoredImageDto } from '../webapp/shared/contract.ts';

import {
  getActorWorkspaceUserId,
  newId,
  nowIso,
  recordChange,
  requireDatabaseClient,
  WORKSPACE
} from './db.ts';
import { ApiError } from './errors.ts';
import { createStorageBackend, readStorageReadSettings } from './storage-backends.ts';

// backend/storage.ts -> repo root is one level up from backend/.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Hard ceiling on a single uploaded image, mirrored by the route body limit. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Hard ceiling on a single objective attachment, mirrored by the route body
 * limit. Larger than images because attachments include documents and archives.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENT_LABEL = '25 MB';

/**
 * Raster image media types we accept. SVG is intentionally excluded: it can
 * carry script and would be served same-origin. Each maps to the file extension
 * used for the stored object's backend key.
 */
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp'
};

interface StorageBucketRow {
  id: string;
  bucket_key: string;
  storage_backend: string;
  base_url: string | null;
  local_path: string | null;
  settings_json: string;
}

/** Resolve the active workspace's bucket for `bucketKey`, or 404 if absent. */
async function resolveBucket(bucketKey: string): Promise<StorageBucketRow> {
  const row = await requireDatabaseClient().get<StorageBucketRow>(
    `SELECT id, bucket_key, storage_backend, base_url, local_path, settings_json
       FROM storage_buckets
      WHERE workspace_id = ? AND bucket_key = ? AND deleted_at IS NULL`,
    [WORKSPACE.id, bucketKey]
  );
  if (!row) throw new ApiError(404, `Unknown storage bucket '${bucketKey}'`);
  return row;
}

/** Pick a safe extension and normalise the content type, or reject the upload. */
function extensionForImage(contentType: string): string {
  const ext = IMAGE_EXTENSIONS[contentType.toLowerCase()];
  if (!ext) {
    throw new ApiError(415, 'Unsupported image type. Upload a PNG, JPEG, GIF, or WebP image.');
  }
  return ext;
}

/** Server-relative URL the SPA uses to fetch a stored object's bytes. */
function publicUrlFor(bucketKey: string, storageKey: string): string {
  return `/api/storage/${encodeURIComponent(bucketKey)}/${encodeURIComponent(storageKey)}`;
}

export interface UploadImageInput {
  bytes: Buffer;
  filename: string;
  contentType: string;
}

interface WrittenObject {
  id: string;
  storageKey: string;
  sizeBytes: number;
  contentType: string;
  checksum: string;
  publicUrl: string;
}

function userImageObjectKey(userId: string, imageId: string, ext: string): string {
  return `user-images/${userId}/${imageId}${ext}`;
}

function workspaceImageObjectKey(workspaceId: string, imageId: string, ext: string): string {
  return `workspace-files/${workspaceId}/images/${imageId}${ext}`;
}

function attachmentObjectKey(workspaceId: string, attachmentId: string, ext: string): string {
  return `workspace-files/${workspaceId}/attachments/${attachmentId}${ext}`;
}

/** Validate image bytes, write them to the bucket backend, return metadata. */
async function writeImageObject(
  bucket: StorageBucketRow,
  input: UploadImageInput,
  storageKeyFor: (id: string, ext: string) => string
): Promise<WrittenObject> {
  if (!input.bytes || input.bytes.length === 0) {
    throw new ApiError(400, 'No image data received');
  }
  if (input.bytes.length > MAX_IMAGE_BYTES) {
    throw new ApiError(413, 'Image is too large. The maximum size is 8 MB.');
  }
  const contentType = input.contentType.split(';')[0].trim().toLowerCase();
  const ext = extensionForImage(contentType);

  const id = newId();
  const storageKey = storageKeyFor(id, ext);
  const backend = createStorageBackend({ bucket, repoRoot });
  await backend.put({ key: storageKey, bytes: input.bytes, contentType });

  return {
    id,
    storageKey,
    sizeBytes: input.bytes.length,
    contentType,
    checksum: createHash('sha256').update(input.bytes).digest('hex'),
    publicUrl: publicUrlFor(bucket.bucket_key, storageKey)
  };
}

/** Resolve the operator's `profiles.id` for the active workspace actor. */
async function operatorUserId(): Promise<string> {
  const client = requireDatabaseClient();
  if (getActorWorkspaceUserId()) {
    const row = await client.get<{ profile_id: string }>(
      `SELECT profile_id FROM workspace_users WHERE id = ?`,
      [getActorWorkspaceUserId()]
    );
    if (row) return row.profile_id;
  }
  const fallback = await client.get<{ id: string }>(
    `SELECT id FROM profiles
      WHERE kind = 'human' AND status = 'active' AND deleted_at IS NULL
      ORDER BY created_at ASC LIMIT 1`
  );
  if (!fallback) throw new ApiError(409, 'No local user profile exists');
  return fallback.id;
}

/**
 * Upload an image to the `user-images` bucket and record it against the local
 * operator. Returns the stored-image descriptor including the URL to serve it.
 */
export async function uploadUserImage(input: UploadImageInput): Promise<StoredImageDto> {
  const bucket = await resolveBucket('user-images');
  const userId = await operatorUserId();
  const written = await writeImageObject(bucket, input, (id, ext) =>
    userImageObjectKey(userId, id, ext)
  );
  const now = nowIso();
  const filename = input.filename.trim() || `image${path.extname(written.storageKey)}`;

  return requireDatabaseClient().transaction(async tx => {
    await tx.run(
      `INSERT INTO user_images (
         id, workspace_id, profile_id, storage_bucket_id, storage_key,
         filename, content_type, size_bytes, checksum_sha256, public_url, metadata_json,
         created_by_workspace_user_id, created_at, updated_at, revision
       ) VALUES (
         ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, '{}',
         ?, ?, ?, 1
       )`,
      [
        written.id,
        WORKSPACE.id,
        userId,
        bucket.id,
        written.storageKey,
        filename,
        written.contentType,
        written.sizeBytes,
        written.checksum,
        written.publicUrl,
        getActorWorkspaceUserId(),
        now,
        now
      ]
    );

    await recordChange(
      {
        entityType: 'user_image',
        entityId: written.id,
        operation: 'insert',
        entityRevision: 1
      },
      tx
    );

    return {
      id: written.id,
      bucketKey: bucket.bucket_key,
      storageKey: written.storageKey,
      filename,
      contentType: written.contentType,
      sizeBytes: written.sizeBytes,
      url: written.publicUrl,
      createdAt: now
    };
  });
}

/**
 * Upload an image to the workspace's `workspace-images` bucket and record it
 * as a workspace-owned image (e.g. a workspace logo). The bucket is resolved
 * per active workspace (`resolveBucket` scopes by `WORKSPACE.id`), so each
 * workspace's bytes live under their own `storage_buckets` row/folder —
 * callers gate this to workspace admins (`PERMISSIONS.WORKSPACE_IMAGE_CREATE`).
 */
export async function uploadWorkspaceImage(input: UploadImageInput): Promise<StoredImageDto> {
  const bucket = await resolveBucket('workspace-images');
  const written = await writeImageObject(bucket, input, (id, ext) =>
    workspaceImageObjectKey(WORKSPACE.id, id, ext)
  );
  const now = nowIso();
  const filename = input.filename.trim() || `image${path.extname(written.storageKey)}`;

  return requireDatabaseClient().transaction(async tx => {
    await tx.run(
      `INSERT INTO workspace_images (
         id, workspace_id, storage_bucket_id, storage_key,
         filename, content_type, size_bytes, checksum_sha256, public_url, metadata_json,
         created_by_workspace_user_id, created_at, updated_at, revision
       ) VALUES (
         ?, ?, ?, ?,
         ?, ?, ?, ?, ?, '{}',
         ?, ?, ?, 1
       )`,
      [
        written.id,
        WORKSPACE.id,
        bucket.id,
        written.storageKey,
        filename,
        written.contentType,
        written.sizeBytes,
        written.checksum,
        written.publicUrl,
        getActorWorkspaceUserId(),
        now,
        now
      ]
    );

    await recordChange(
      {
        entityType: 'workspace_image',
        entityId: written.id,
        operation: 'insert',
        entityRevision: 1
      },
      tx
    );

    return {
      id: written.id,
      bucketKey: bucket.bucket_key,
      storageKey: written.storageKey,
      filename,
      contentType: written.contentType,
      sizeBytes: written.sizeBytes,
      url: written.publicUrl,
      createdAt: now
    };
  });
}

// ---- Objective attachments (attachments bucket) --------------------------
//
// Attachments reuse the generic bucket plumbing above but, unlike images,
// accept any content type and are recorded in the `attachments` table scoped to
// an objective (with its mission and project). Bytes are served as downloads via
// the same `/api/storage/<bucket>/<key>` route as images.

const ATTACHMENTS_BUCKET_KEY = 'attachments';

interface ObjectiveScopeRow {
  workspace_id: string;
  project_id: string;
  mission_id: string;
}

/**
 * Resolve the objective's workspace/project/mission scope, or 404 if absent.
 * Accepts an explicit client so callers inside a transaction can pass the
 * transaction-scoped client instead of `requireDatabaseClient()`'s top-level
 * one — reusing the top-level client here would re-enter the same mutex the
 * enclosing `transaction()` call already holds and deadlock.
 */
async function resolveObjectiveScope(
  objectiveId: string,
  client: DatabaseClient = requireDatabaseClient()
): Promise<ObjectiveScopeRow> {
  const row = await client.get<ObjectiveScopeRow>(
    `SELECT workspace_id, project_id, mission_id FROM objectives
      WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [objectiveId, WORKSPACE.id]
  );
  if (!row) throw new ApiError(404, 'Objective not found');
  return row;
}

/** Preserve the uploaded file's extension for the stored object's backend key. */
function attachmentExtension(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  // Guard against pathological extensions; keep only a short alnum suffix.
  return /^\.[a-z0-9]{1,12}$/.test(ext) ? ext : '';
}

interface AttachmentRow {
  id: string;
  workspace_id: string;
  project_id: string | null;
  mission_id: string | null;
  objective_id: string | null;
  storage_key: string;
  filename: string;
  content_type: string | null;
  size_bytes: number | null;
  upload_status: string;
  created_at: string;
}

function toObjectiveAttachmentDto(row: AttachmentRow): ObjectiveAttachmentDto {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    missionId: row.mission_id,
    objectiveId: row.objective_id,
    bucketKey: ATTACHMENTS_BUCKET_KEY,
    storageKey: row.storage_key,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    uploadStatus: row.upload_status as ObjectiveAttachmentDto['uploadStatus'],
    url: publicUrlFor(ATTACHMENTS_BUCKET_KEY, row.storage_key),
    createdAt: row.created_at
  };
}

const ATTACHMENT_COLUMNS = `id, workspace_id, project_id, mission_id, objective_id,
  storage_key, filename, content_type, size_bytes, upload_status, created_at`;

export interface UploadAttachmentInput {
  objectiveId: string;
  bytes: Buffer;
  filename: string;
  contentType: string;
}

/**
 * Store an uploaded file in the `attachments` bucket and record it against an
 * objective (carrying its mission and project). Returns the attachment
 * descriptor including the URL that serves the bytes back.
 */
export async function uploadObjectiveAttachment(
  input: UploadAttachmentInput
): Promise<ObjectiveAttachmentDto> {
  if (!input.bytes || input.bytes.length === 0) {
    throw new ApiError(400, 'No file data received');
  }
  if (input.bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new ApiError(
      413,
      `File too large. Attachments can be no longer than ${MAX_ATTACHMENT_LABEL}.`
    );
  }

  const scope = await resolveObjectiveScope(input.objectiveId);
  const bucket = await resolveBucket(ATTACHMENTS_BUCKET_KEY);

  const id = newId();
  const storageKey = attachmentObjectKey(
    scope.workspace_id,
    id,
    attachmentExtension(input.filename)
  );
  const now = nowIso();
  const contentType = input.contentType.split(';')[0].trim().toLowerCase() || null;
  const backend = createStorageBackend({ bucket, repoRoot });
  await backend.put({
    key: storageKey,
    bytes: input.bytes,
    contentType: contentType ?? 'application/octet-stream'
  });
  const filename = input.filename.trim() || `attachment${path.extname(storageKey)}`;
  const checksum = createHash('sha256').update(input.bytes).digest('hex');

  return requireDatabaseClient().transaction(async tx => {
    await tx.run(
      `INSERT INTO attachments (
         id, workspace_id, project_id, mission_id, objective_id, storage_bucket_id,
         storage_key, filename, content_type, size_bytes, checksum_sha256, upload_status,
         metadata_json, created_by_workspace_user_id, created_at, updated_at, revision
       ) VALUES (
         ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, 'available',
         '{}', ?, ?, ?, 1
       )`,
      [
        id,
        scope.workspace_id,
        scope.project_id,
        scope.mission_id,
        input.objectiveId,
        bucket.id,
        storageKey,
        filename,
        contentType,
        input.bytes.length,
        checksum,
        getActorWorkspaceUserId(),
        now,
        now
      ]
    );

    await recordChange(
      {
        entityType: 'attachment',
        entityId: id,
        operation: 'insert',
        entityRevision: 1,
        projectId: scope.project_id,
        missionId: scope.mission_id,
        objectiveId: input.objectiveId
      },
      tx
    );

    return toObjectiveAttachmentDto({
      id,
      workspace_id: scope.workspace_id,
      project_id: scope.project_id,
      mission_id: scope.mission_id,
      objective_id: input.objectiveId,
      storage_key: storageKey,
      filename,
      content_type: contentType,
      size_bytes: input.bytes.length,
      upload_status: 'available',
      created_at: now
    });
  });
}

/** List an objective's active attachments, oldest first. */
export async function listObjectiveAttachments(
  objectiveId: string
): Promise<ObjectiveAttachmentDto[]> {
  await resolveObjectiveScope(objectiveId);
  const rows = await requireDatabaseClient().all<AttachmentRow>(
    `SELECT ${ATTACHMENT_COLUMNS} FROM attachments
      WHERE objective_id = ? AND workspace_id = ? AND deleted_at IS NULL
      ORDER BY created_at ASC`,
    [objectiveId, WORKSPACE.id]
  );
  return rows.map(toObjectiveAttachmentDto);
}

/**
 * Soft-delete an objective attachment (tombstone + revision bump). Remote
 * backends delete their object after the metadata transaction commits; local
 * buckets keep historical on-disk behavior. Returns the objective's remaining
 * attachments.
 */
export async function deleteObjectiveAttachment(
  objectiveId: string,
  attachmentId: string
): Promise<ObjectiveAttachmentDto[]> {
  const { remaining, cleanup } = await requireDatabaseClient().transaction(async tx => {
    const scope = await resolveObjectiveScope(objectiveId, tx);
    const row = await tx.get<{
      id: string;
      revision: number;
      storage_key: string;
      bucket_id: string;
      bucket_key: string;
      storage_backend: string;
      local_path: string | null;
      settings_json: string;
    }>(
      `SELECT a.id, a.revision, a.storage_key,
              b.id AS bucket_id, b.bucket_key, b.storage_backend, b.local_path, b.settings_json
         FROM attachments a
         JOIN storage_buckets b ON b.id = a.storage_bucket_id
        WHERE a.id = ? AND a.objective_id = ? AND a.workspace_id = ?
          AND a.deleted_at IS NULL AND b.deleted_at IS NULL`,
      [attachmentId, objectiveId, WORKSPACE.id]
    );
    if (!row) throw new ApiError(404, 'Attachment not found');

    const now = nowIso();
    await tx.run(
      `UPDATE attachments
          SET deleted_at = ?, upload_status = 'deleted', updated_at = ?,
              revision = revision + 1
        WHERE id = ?`,
      [now, now, attachmentId]
    );

    await recordChange(
      {
        entityType: 'attachment',
        entityId: attachmentId,
        operation: 'delete',
        entityRevision: row.revision + 1,
        projectId: scope.project_id,
        missionId: scope.mission_id,
        objectiveId
      },
      tx
    );

    const rows = await tx.all<AttachmentRow>(
      `SELECT ${ATTACHMENT_COLUMNS} FROM attachments
        WHERE objective_id = ? AND workspace_id = ? AND deleted_at IS NULL
        ORDER BY created_at ASC`,
      [objectiveId, WORKSPACE.id]
    );
    return {
      remaining: rows.map(toObjectiveAttachmentDto),
      cleanup: {
        key: row.storage_key,
        bucket: {
          id: row.bucket_id,
          bucket_key: row.bucket_key,
          storage_backend: row.storage_backend,
          local_path: row.local_path,
          settings_json: row.settings_json
        }
      }
    };
  });

  if (
    cleanup.bucket.storage_backend === 's3' ||
    cleanup.bucket.storage_backend === 'railway_volume'
  ) {
    const backend = createStorageBackend({ bucket: cleanup.bucket, repoRoot });
    await backend.deleteObject?.({ key: cleanup.key });
  }
  return remaining;
}

export interface ResolvedStoredObject {
  contentType: string;
  filename: string;
  /** Whether the bytes should be served as a download rather than rendered inline. */
  forceDownload: boolean;
  /** Populated for `local_fs` buckets; the serve route streams from disk. */
  absolutePath?: string;
  /** Populated for remote backends such as `s3`; the serve route proxies the stream. */
  bodyStream?: Readable;
  /**
   * Populated when the bucket opts into presigned reads (`settings_json.presignReads`);
   * the serve route 302-redirects after RBAC and metadata resolution.
   */
  presignedRedirectUrl?: string;
}

/** Bucket → metadata table for buckets whose objects can be served back. */
const SERVABLE_OBJECT_TABLES: Record<string, string> = {
  'user-images': 'user_images',
  'workspace-images': 'workspace_images',
  attachments: 'attachments'
};

/**
 * Resolve a stored object's bytes for serving. Looks the object up by its exact
 * backend key so only recorded, non-deleted objects are served and path
 * traversal via `storageKey` is impossible. Attachments (arbitrary types) are
 * flagged for download so untrusted bytes are never rendered inline.
 */
export async function resolveStoredObject(
  bucketKey: string,
  storageKey: string
): Promise<ResolvedStoredObject> {
  const bucket = await resolveBucket(bucketKey);
  const table = SERVABLE_OBJECT_TABLES[bucketKey];
  if (!table) throw new ApiError(404, `Serving is not configured for bucket '${bucketKey}'`);

  const row = await requireDatabaseClient().get<{
    content_type: string | null;
    filename: string;
  }>(
    `SELECT content_type, filename FROM ${table}
      WHERE storage_bucket_id = ? AND storage_key = ? AND deleted_at IS NULL`,
    [bucket.id, storageKey]
  );
  if (!row) throw new ApiError(404, 'File not found');

  const backend = createStorageBackend({ bucket, repoRoot });
  const contentType = row.content_type ?? 'application/octet-stream';
  const forceDownload = bucketKey === ATTACHMENTS_BUCKET_KEY;
  const readSettings = readStorageReadSettings(bucket.settings_json);

  if (readSettings.presignReads && backend.presignGet) {
    const responseContentDisposition = forceDownload
      ? `attachment; filename="${row.filename.replace(/"/g, '\\"')}"`
      : undefined;
    return {
      contentType,
      filename: row.filename,
      forceDownload,
      presignedRedirectUrl: await backend.presignGet({
        key: storageKey,
        ttlSeconds: readSettings.presignTtlSeconds,
        responseContentDisposition
      })
    };
  }

  if (bucket.storage_backend === 'local_fs') {
    if (!bucket.local_path) {
      throw new ApiError(500, `Bucket '${bucket.bucket_key}' is missing a local_path`);
    }
    const root = path.isAbsolute(bucket.local_path)
      ? bucket.local_path
      : path.resolve(repoRoot, bucket.local_path);
    const absolutePath = path.join(root, storageKey);
    if (!existsSync(absolutePath)) throw new ApiError(404, 'File not found');
    return {
      absolutePath,
      contentType,
      filename: row.filename,
      forceDownload
    };
  }

  return {
    bodyStream: await backend.getStream({ key: storageKey }),
    contentType,
    filename: row.filename,
    forceDownload
  };
}

/** Stream, send, or redirect a resolved stored object through an Express response. */
export function serveStoredObject(res: Response, resolved: ResolvedStoredObject): void {
  if (resolved.presignedRedirectUrl) {
    res.redirect(302, resolved.presignedRedirectUrl);
    return;
  }
  if (resolved.absolutePath) {
    res.sendFile(resolved.absolutePath);
    return;
  }
  if (resolved.bodyStream) {
    resolved.bodyStream.pipe(res);
    return;
  }
  throw new ApiError(500, 'Stored object has no byte source');
}
