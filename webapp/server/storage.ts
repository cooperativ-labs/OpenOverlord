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
 * Bytes live in the storage backend (a `local_fs` directory for local installs);
 * the database holds metadata and backend keys only — see
 * database/docs/09-database-schema-contract.md (`storage_buckets`, `user_images`).
 *
 * Only the seeded `user-images` bucket is wired through a metadata writer today;
 * the bucket lookup, byte I/O, and serve path are generic so `workspace-images`
 * and `attachments` can reuse them with their own writers later.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ObjectiveAttachmentDto, StoredImageDto } from '../shared/contract.ts';

import { ACTOR_WORKSPACE_USER_ID, db, newId, nowIso, recordChange, WORKSPACE } from './db.ts';
import { ApiError } from './errors.ts';

// webapp/server/storage.ts -> repo root is two levels up from server/.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Hard ceiling on a single uploaded image, mirrored by the route body limit. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Hard ceiling on a single objective attachment, mirrored by the route body
 * limit. Larger than images because attachments include documents and archives.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

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
}

/** Resolve the active workspace's bucket for `bucketKey`, or 404 if absent. */
function resolveBucket(bucketKey: string): StorageBucketRow {
  const row = db
    .prepare(
      `SELECT id, bucket_key, storage_backend, base_url, local_path
         FROM storage_buckets
        WHERE workspace_id = ? AND bucket_key = ? AND deleted_at IS NULL`
    )
    .get(WORKSPACE.id, bucketKey) as StorageBucketRow | undefined;
  if (!row) throw new ApiError(404, `Unknown storage bucket '${bucketKey}'`);
  return row;
}

/** Absolute filesystem root for a `local_fs` bucket; rejects other backends. */
function localRootFor(bucket: StorageBucketRow): string {
  if (bucket.storage_backend !== 'local_fs' || !bucket.local_path) {
    throw new ApiError(
      501,
      `Storage backend '${bucket.storage_backend}' is not supported by this build`
    );
  }
  return path.isAbsolute(bucket.local_path)
    ? bucket.local_path
    : path.resolve(repoRoot, bucket.local_path);
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

/** Validate image bytes, write them to the bucket backend, return metadata. */
function writeImageObject(bucket: StorageBucketRow, input: UploadImageInput): WrittenObject {
  if (!input.bytes || input.bytes.length === 0) {
    throw new ApiError(400, 'No image data received');
  }
  if (input.bytes.length > MAX_IMAGE_BYTES) {
    throw new ApiError(413, 'Image is too large. The maximum size is 8 MB.');
  }
  const contentType = input.contentType.split(';')[0].trim().toLowerCase();
  const ext = extensionForImage(contentType);

  const id = newId();
  const storageKey = `${id}${ext}`;
  const root = localRootFor(bucket);
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, storageKey), input.bytes);

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
function operatorUserId(): string {
  if (ACTOR_WORKSPACE_USER_ID) {
    const row = db
      .prepare(`SELECT profile_id FROM workspace_users WHERE id = ?`)
      .get(ACTOR_WORKSPACE_USER_ID) as { profile_id: string } | undefined;
    if (row) return row.profile_id;
  }
  const fallback = db
    .prepare(
      `SELECT id FROM profiles
        WHERE kind = 'human' AND status = 'active' AND deleted_at IS NULL
        ORDER BY created_at ASC LIMIT 1`
    )
    .get() as { id: string } | undefined;
  if (!fallback) throw new ApiError(409, 'No local user profile exists');
  return fallback.id;
}

/**
 * Upload an image to the `user-images` bucket and record it against the local
 * operator. Returns the stored-image descriptor including the URL to serve it.
 */
export const uploadUserImage = db.transaction((input: UploadImageInput): StoredImageDto => {
  const bucket = resolveBucket('user-images');
  const written = writeImageObject(bucket, input);
  const userId = operatorUserId();
  const now = nowIso();
  const filename = input.filename.trim() || `image${path.extname(written.storageKey)}`;

  db.prepare(
    `INSERT INTO user_images (
       id, workspace_id, profile_id, storage_bucket_id, storage_key,
       filename, content_type, size_bytes, checksum_sha256, public_url, metadata_json,
       created_by_workspace_user_id, created_at, updated_at, revision
     ) VALUES (
       @id, @workspace_id, @user_id, @storage_bucket_id, @storage_key,
       @filename, @content_type, @size_bytes, @checksum_sha256, @public_url, '{}',
       @created_by, @created_at, @created_at, 1
     )`
  ).run({
    id: written.id,
    workspace_id: WORKSPACE.id,
    user_id: userId,
    storage_bucket_id: bucket.id,
    storage_key: written.storageKey,
    filename,
    content_type: written.contentType,
    size_bytes: written.sizeBytes,
    checksum_sha256: written.checksum,
    public_url: written.publicUrl,
    created_by: ACTOR_WORKSPACE_USER_ID,
    created_at: now
  });

  recordChange({
    entityType: 'user_image',
    entityId: written.id,
    operation: 'insert',
    entityRevision: 1
  });

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

/** Resolve the objective's workspace/project/mission scope, or 404 if absent. */
function resolveObjectiveScope(objectiveId: string): ObjectiveScopeRow {
  const row = db
    .prepare(
      `SELECT workspace_id, project_id, mission_id FROM objectives
        WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
    )
    .get(objectiveId, WORKSPACE.id) as ObjectiveScopeRow | undefined;
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
export const uploadObjectiveAttachment = db.transaction(
  (input: UploadAttachmentInput): ObjectiveAttachmentDto => {
    if (!input.bytes || input.bytes.length === 0) {
      throw new ApiError(400, 'No file data received');
    }
    if (input.bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new ApiError(413, 'File is too large. The maximum size is 25 MB.');
    }

    const scope = resolveObjectiveScope(input.objectiveId);
    const bucket = resolveBucket(ATTACHMENTS_BUCKET_KEY);

    const id = newId();
    const storageKey = `${id}${attachmentExtension(input.filename)}`;
    const root = localRootFor(bucket);
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, storageKey), input.bytes);

    const now = nowIso();
    const contentType = input.contentType.split(';')[0].trim().toLowerCase() || null;
    const filename = input.filename.trim() || `attachment${path.extname(storageKey)}`;
    const checksum = createHash('sha256').update(input.bytes).digest('hex');

    db.prepare(
      `INSERT INTO attachments (
         id, workspace_id, project_id, mission_id, objective_id, storage_bucket_id,
         storage_key, filename, content_type, size_bytes, checksum_sha256, upload_status,
         metadata_json, created_by_workspace_user_id, created_at, updated_at, revision
       ) VALUES (
         @id, @workspace_id, @project_id, @mission_id, @objective_id, @storage_bucket_id,
         @storage_key, @filename, @content_type, @size_bytes, @checksum_sha256, 'available',
         '{}', @created_by, @created_at, @created_at, 1
       )`
    ).run({
      id,
      workspace_id: scope.workspace_id,
      project_id: scope.project_id,
      mission_id: scope.mission_id,
      objective_id: input.objectiveId,
      storage_bucket_id: bucket.id,
      storage_key: storageKey,
      filename,
      content_type: contentType,
      size_bytes: input.bytes.length,
      checksum_sha256: checksum,
      created_by: ACTOR_WORKSPACE_USER_ID,
      created_at: now
    });

    recordChange({
      entityType: 'attachment',
      entityId: id,
      operation: 'insert',
      entityRevision: 1,
      projectId: scope.project_id,
      missionId: scope.mission_id,
      objectiveId: input.objectiveId
    });

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
  }
);

/** List an objective's active attachments, oldest first. */
export function listObjectiveAttachments(objectiveId: string): ObjectiveAttachmentDto[] {
  resolveObjectiveScope(objectiveId);
  const rows = db
    .prepare(
      `SELECT ${ATTACHMENT_COLUMNS} FROM attachments
        WHERE objective_id = ? AND workspace_id = ? AND deleted_at IS NULL
        ORDER BY created_at ASC`
    )
    .all(objectiveId, WORKSPACE.id) as AttachmentRow[];
  return rows.map(toObjectiveAttachmentDto);
}

/**
 * Soft-delete an objective attachment (tombstone + revision bump). The bytes are
 * left on disk for now; provider cleanup is a separate concern per the schema
 * contract. Returns the objective's remaining attachments.
 */
export const deleteObjectiveAttachment = db.transaction(
  (objectiveId: string, attachmentId: string): ObjectiveAttachmentDto[] => {
    const scope = resolveObjectiveScope(objectiveId);
    const row = db
      .prepare(
        `SELECT id, revision FROM attachments
          WHERE id = ? AND objective_id = ? AND workspace_id = ? AND deleted_at IS NULL`
      )
      .get(attachmentId, objectiveId, WORKSPACE.id) as { id: string; revision: number } | undefined;
    if (!row) throw new ApiError(404, 'Attachment not found');

    const now = nowIso();
    db.prepare(
      `UPDATE attachments
          SET deleted_at = @now, upload_status = 'deleted', updated_at = @now,
              revision = revision + 1
        WHERE id = @id`
    ).run({ id: attachmentId, now });

    recordChange({
      entityType: 'attachment',
      entityId: attachmentId,
      operation: 'delete',
      entityRevision: row.revision + 1,
      projectId: scope.project_id,
      missionId: scope.mission_id,
      objectiveId
    });

    return listObjectiveAttachments(objectiveId);
  }
);

export interface ResolvedStoredObject {
  absolutePath: string;
  contentType: string;
  filename: string;
  /** Whether the bytes should be served as a download rather than rendered inline. */
  forceDownload: boolean;
}

/** Bucket → metadata table for buckets whose objects can be served back. */
const SERVABLE_OBJECT_TABLES: Record<string, string> = {
  'user-images': 'user_images',
  attachments: 'attachments'
};

/**
 * Resolve a stored object's bytes for serving. Looks the object up by its exact
 * backend key so only recorded, non-deleted objects are served and path
 * traversal via `storageKey` is impossible. Attachments (arbitrary types) are
 * flagged for download so untrusted bytes are never rendered inline.
 */
export function resolveStoredObject(bucketKey: string, storageKey: string): ResolvedStoredObject {
  const bucket = resolveBucket(bucketKey);
  const table = SERVABLE_OBJECT_TABLES[bucketKey];
  if (!table) throw new ApiError(404, `Serving is not configured for bucket '${bucketKey}'`);

  const row = db
    .prepare(
      `SELECT content_type, filename FROM ${table}
        WHERE storage_bucket_id = ? AND storage_key = ? AND deleted_at IS NULL`
    )
    .get(bucket.id, storageKey) as { content_type: string | null; filename: string } | undefined;
  if (!row) throw new ApiError(404, 'File not found');

  const absolutePath = path.join(localRootFor(bucket), storageKey);
  if (!existsSync(absolutePath)) throw new ApiError(404, 'File not found');
  return {
    absolutePath,
    contentType: row.content_type ?? 'application/octet-stream',
    filename: row.filename,
    forceDownload: bucketKey === ATTACHMENTS_BUCKET_KEY
  };
}
