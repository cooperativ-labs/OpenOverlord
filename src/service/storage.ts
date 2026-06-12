import { type AuthorizationProvider, defaultAuthorizer, makeActor } from '../rbac/authorizer.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { Role } from '../rbac/types.js';

import { recordChange } from './change-feed.js';
import type { ServiceContext } from './context.js';
import { assertFound, ServiceError } from './errors.js';
import { newId, nowIso } from './util.js';

type StorageRow = {
  id: string;
  workspace_id: string;
  storage_bucket_id: string;
  storage_key: string;
  filename: string;
  content_type: string | null;
  size_bytes: number | null;
  checksum_sha256: string | null;
  public_url?: string | null;
  alt_text?: string | null;
  upload_status?: string | null;
  profile_id?: string;
  project_id?: string | null;
  ticket_id?: string | null;
  objective_id?: string | null;
  revision: number;
};

export type StorageBucketSummary = {
  id: string;
  key: string;
  backend: string;
  baseUrl: string | null;
  localPath: string | null;
};

export type ImageSummary = {
  id: string;
  storageKey: string;
  filename: string;
  contentType: string;
  sizeBytes: number | null;
  checksumSha256: string | null;
  publicUrl: string | null;
  altText: string | null;
  revision: number;
};

export type AttachmentSummary = {
  id: string;
  storageKey: string;
  filename: string;
  contentType: string | null;
  sizeBytes: number | null;
  checksumSha256: string | null;
  uploadStatus: string;
  revision: number;
};

type ImageCreateInput = {
  storageKey: string;
  filename: string;
  contentType: string;
  sizeBytes?: number | null;
  checksumSha256?: string | null;
  widthPx?: number | null;
  heightPx?: number | null;
  altText?: string | null;
  publicUrl?: string | null;
  metadata?: unknown;
};

type AuthorizationOptions = {
  authorization?: AuthorizationProvider | undefined;
};

const PUBLIC_ACTOR = makeActor('public', [Role.PUBLIC]);

function loadRoles(ctx: ServiceContext): Role[] {
  if (!ctx.actorWorkspaceUserId) return [Role.PUBLIC];
  const rows = ctx.db
    .prepare(
      `SELECT role_key FROM role_assignments
       WHERE workspace_id = ? AND workspace_user_id = ? AND deleted_at IS NULL`
    )
    .all(ctx.workspace.id, ctx.actorWorkspaceUserId) as Array<{ role_key: string }>;
  return rows.map(row => row.role_key as Role);
}

function loadActor(ctx: ServiceContext) {
  return makeActor(ctx.actorWorkspaceUserId ?? 'public', loadRoles(ctx));
}

function loadActorUserId(ctx: ServiceContext): string | null {
  if (!ctx.actorWorkspaceUserId) return null;
  const row = ctx.db
    .prepare(`SELECT profile_id FROM workspace_users WHERE id = ? AND workspace_id = ?`)
    .get(ctx.actorWorkspaceUserId, ctx.workspace.id) as { profile_id: string } | undefined;
  return row?.profile_id ?? null;
}

function requirePermission(
  ctx: ServiceContext,
  permission: string,
  {
    authorization = defaultAuthorizer,
    allowPublic = false
  }: AuthorizationOptions & { allowPublic?: boolean } = {}
): void {
  const actor = loadActor(ctx);
  const result = authorization.can(actor, permission);
  if (result.allowed) return;

  if (allowPublic && authorization.can(PUBLIC_ACTOR, permission).allowed) return;

  throw new ServiceError(result.reason, 'forbidden', 403);
}

function requireUserImagePermission(
  ctx: ServiceContext,
  userId: string,
  generalPermission: string,
  selfPermission: string,
  { authorization = defaultAuthorizer }: AuthorizationOptions = {}
): void {
  const actor = loadActor(ctx);
  const general = authorization.can(actor, generalPermission);
  if (general.allowed) return;

  const actorUserId = loadActorUserId(ctx);
  const self = authorization.can(actor, selfPermission);
  if (actorUserId === userId && self.allowed) return;

  throw new ServiceError(self.reason, 'forbidden', 403);
}

function imageSummary(row: StorageRow): ImageSummary {
  return {
    id: row.id,
    storageKey: row.storage_key,
    filename: row.filename,
    contentType: assertFound(row.content_type, 'Image content type missing'),
    sizeBytes: row.size_bytes,
    checksumSha256: row.checksum_sha256,
    publicUrl: row.public_url ?? null,
    altText: row.alt_text ?? null,
    revision: row.revision
  };
}

function attachmentSummary(row: StorageRow): AttachmentSummary {
  return {
    id: row.id,
    storageKey: row.storage_key,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    checksumSha256: row.checksum_sha256,
    uploadStatus: assertFound(row.upload_status, 'Attachment upload status missing'),
    revision: row.revision
  };
}

function metadataJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function getBucketId(ctx: ServiceContext, bucketKey: string): string {
  const row = ctx.db
    .prepare(
      `SELECT id FROM storage_buckets
       WHERE workspace_id = ? AND bucket_key = ? AND deleted_at IS NULL`
    )
    .get(ctx.workspace.id, bucketKey) as { id: string } | undefined;
  return assertFound(row, `Storage bucket not configured: ${bucketKey}`).id;
}

export function listStorageBuckets({ ctx }: { ctx: ServiceContext }): StorageBucketSummary[] {
  const rows = ctx.db
    .prepare(
      `SELECT id, bucket_key, storage_backend, base_url, local_path
       FROM storage_buckets
       WHERE workspace_id = ? AND deleted_at IS NULL
       ORDER BY bucket_key ASC`
    )
    .all(ctx.workspace.id) as Array<{
    id: string;
    bucket_key: string;
    storage_backend: string;
    base_url: string | null;
    local_path: string | null;
  }>;

  return rows.map(row => ({
    id: row.id,
    key: row.bucket_key,
    backend: row.storage_backend,
    baseUrl: row.base_url,
    localPath: row.local_path
  }));
}

export function createWorkspaceImage({
  ctx,
  input,
  authorization
}: {
  ctx: ServiceContext;
  input: ImageCreateInput;
} & AuthorizationOptions): ImageSummary {
  requirePermission(ctx, PERMISSIONS.WORKSPACE_IMAGE_CREATE, { authorization });
  const now = nowIso();
  const id = newId();
  const bucketId = getBucketId(ctx, 'workspace-images');

  ctx.db
    .prepare(
      `INSERT INTO workspace_images (
         id, workspace_id, storage_bucket_id, storage_key, filename, content_type,
         size_bytes, checksum_sha256, width_px, height_px, alt_text, public_url,
         metadata_json, created_by_workspace_user_id, created_at, updated_at, revision
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    )
    .run(
      id,
      ctx.workspace.id,
      bucketId,
      input.storageKey,
      input.filename,
      input.contentType,
      input.sizeBytes ?? null,
      input.checksumSha256 ?? null,
      input.widthPx ?? null,
      input.heightPx ?? null,
      input.altText ?? null,
      input.publicUrl ?? null,
      metadataJson(input.metadata),
      ctx.actorWorkspaceUserId,
      now,
      now
    );
  recordChange({
    ctx,
    entityType: 'workspace_image',
    entityId: id,
    operation: 'insert',
    entityRevision: 1
  });
  return assertFound(
    listWorkspaceImages({ ctx }).find(image => image.id === id),
    'Workspace image missing'
  );
}

export function listWorkspaceImages({
  ctx,
  authorization
}: { ctx: ServiceContext } & AuthorizationOptions): ImageSummary[] {
  requirePermission(ctx, PERMISSIONS.WORKSPACE_IMAGE_READ, { authorization, allowPublic: true });
  const rows = ctx.db
    .prepare(
      `SELECT id, workspace_id, storage_bucket_id, storage_key, filename, content_type,
              size_bytes, checksum_sha256, public_url, alt_text, revision
       FROM workspace_images
       WHERE workspace_id = ? AND deleted_at IS NULL
       ORDER BY created_at ASC`
    )
    .all(ctx.workspace.id) as StorageRow[];
  return rows.map(imageSummary);
}

export function updateWorkspaceImage({
  ctx,
  imageId,
  revision,
  altText,
  publicUrl,
  metadata,
  authorization
}: {
  ctx: ServiceContext;
  imageId: string;
  revision: number;
  altText?: string | null;
  publicUrl?: string | null;
  metadata?: unknown;
} & AuthorizationOptions): ImageSummary {
  requirePermission(ctx, PERMISSIONS.WORKSPACE_IMAGE_UPDATE, { authorization });
  const now = nowIso();
  const result = ctx.db
    .prepare(
      `UPDATE workspace_images
       SET alt_text = ?, public_url = ?, metadata_json = ?, updated_at = ?, revision = revision + 1
       WHERE id = ? AND workspace_id = ? AND revision = ? AND deleted_at IS NULL`
    )
    .run(
      altText ?? null,
      publicUrl ?? null,
      metadataJson(metadata),
      now,
      imageId,
      ctx.workspace.id,
      revision
    );
  if (result.changes === 0)
    throw new ServiceError('Workspace image update conflict', 'conflict', 409);
  recordChange({
    ctx,
    entityType: 'workspace_image',
    entityId: imageId,
    operation: 'update',
    entityRevision: revision + 1,
    changedFields: ['alt_text', 'public_url', 'metadata_json']
  });
  return assertFound(
    listWorkspaceImages({ ctx }).find(image => image.id === imageId),
    'Workspace image missing'
  );
}

export function deleteWorkspaceImage({
  ctx,
  imageId,
  revision,
  authorization
}: {
  ctx: ServiceContext;
  imageId: string;
  revision: number;
} & AuthorizationOptions): void {
  requirePermission(ctx, PERMISSIONS.WORKSPACE_IMAGE_DELETE, { authorization });
  const now = nowIso();
  const result = ctx.db
    .prepare(
      `UPDATE workspace_images
       SET deleted_at = ?, updated_at = ?, revision = revision + 1
       WHERE id = ? AND workspace_id = ? AND revision = ? AND deleted_at IS NULL`
    )
    .run(now, now, imageId, ctx.workspace.id, revision);
  if (result.changes === 0)
    throw new ServiceError('Workspace image delete conflict', 'conflict', 409);
  recordChange({
    ctx,
    entityType: 'workspace_image',
    entityId: imageId,
    operation: 'delete',
    entityRevision: revision + 1
  });
}

export function createUserImage({
  ctx,
  userId,
  input,
  authorization
}: {
  ctx: ServiceContext;
  userId: string;
  input: ImageCreateInput;
} & AuthorizationOptions): ImageSummary {
  requireUserImagePermission(
    ctx,
    userId,
    PERMISSIONS.USER_IMAGE_CREATE,
    PERMISSIONS.USER_IMAGE_SELF_CREATE,
    { authorization }
  );
  const now = nowIso();
  const id = newId();
  const bucketId = getBucketId(ctx, 'user-images');

  ctx.db
    .prepare(
      `INSERT INTO user_images (
         id, workspace_id, profile_id, storage_bucket_id, storage_key,
         filename, content_type, size_bytes, checksum_sha256, width_px, height_px,
         alt_text, public_url, metadata_json, created_by_workspace_user_id,
         created_at, updated_at, revision
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    )
    .run(
      id,
      ctx.workspace.id,
      userId,
      bucketId,
      input.storageKey,
      input.filename,
      input.contentType,
      input.sizeBytes ?? null,
      input.checksumSha256 ?? null,
      input.widthPx ?? null,
      input.heightPx ?? null,
      input.altText ?? null,
      input.publicUrl ?? null,
      metadataJson(input.metadata),
      ctx.actorWorkspaceUserId,
      now,
      now
    );
  recordChange({
    ctx,
    entityType: 'user_image',
    entityId: id,
    operation: 'insert',
    entityRevision: 1
  });
  return assertFound(
    listUserImages({ ctx, userId }).find(image => image.id === id),
    'User image missing'
  );
}

export function listUserImages({
  ctx,
  userId,
  authorization
}: {
  ctx: ServiceContext;
  userId?: string | null;
} & AuthorizationOptions): ImageSummary[] {
  requirePermission(ctx, PERMISSIONS.USER_IMAGE_READ, { authorization, allowPublic: true });
  const params: string[] = [ctx.workspace.id];
  let sql = `SELECT id, workspace_id, profile_id, storage_bucket_id, storage_key,
                    filename, content_type, size_bytes, checksum_sha256, public_url, alt_text, revision
             FROM user_images
             WHERE workspace_id = ? AND deleted_at IS NULL`;
  if (userId) {
    sql += ' AND profile_id = ?';
    params.push(userId);
  }
  sql += ' ORDER BY created_at ASC';
  return (ctx.db.prepare(sql).all(...params) as StorageRow[]).map(imageSummary);
}

export function updateUserImage({
  ctx,
  imageId,
  revision,
  altText,
  publicUrl,
  metadata,
  authorization
}: {
  ctx: ServiceContext;
  imageId: string;
  revision: number;
  altText?: string | null;
  publicUrl?: string | null;
  metadata?: unknown;
} & AuthorizationOptions): ImageSummary {
  const existing = assertFound(
    ctx.db
      .prepare(
        `SELECT profile_id FROM user_images WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
      )
      .get(imageId, ctx.workspace.id) as { profile_id: string } | undefined,
    'User image not found'
  );
  requireUserImagePermission(
    ctx,
    existing.profile_id,
    PERMISSIONS.USER_IMAGE_UPDATE,
    PERMISSIONS.USER_IMAGE_SELF_UPDATE,
    { authorization }
  );
  const now = nowIso();
  const result = ctx.db
    .prepare(
      `UPDATE user_images
       SET alt_text = ?, public_url = ?, metadata_json = ?, updated_at = ?, revision = revision + 1
       WHERE id = ? AND workspace_id = ? AND revision = ? AND deleted_at IS NULL`
    )
    .run(
      altText ?? null,
      publicUrl ?? null,
      metadataJson(metadata),
      now,
      imageId,
      ctx.workspace.id,
      revision
    );
  if (result.changes === 0) throw new ServiceError('User image update conflict', 'conflict', 409);
  recordChange({
    ctx,
    entityType: 'user_image',
    entityId: imageId,
    operation: 'update',
    entityRevision: revision + 1,
    changedFields: ['alt_text', 'public_url', 'metadata_json']
  });
  return assertFound(
    listUserImages({ ctx, userId: existing.profile_id }).find(image => image.id === imageId),
    'User image missing'
  );
}

export function deleteUserImage({
  ctx,
  imageId,
  revision,
  authorization
}: {
  ctx: ServiceContext;
  imageId: string;
  revision: number;
} & AuthorizationOptions): void {
  const existing = assertFound(
    ctx.db
      .prepare(
        `SELECT profile_id FROM user_images WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
      )
      .get(imageId, ctx.workspace.id) as { profile_id: string } | undefined,
    'User image not found'
  );
  requireUserImagePermission(
    ctx,
    existing.profile_id,
    PERMISSIONS.USER_IMAGE_DELETE,
    PERMISSIONS.USER_IMAGE_SELF_DELETE,
    { authorization }
  );
  const now = nowIso();
  const result = ctx.db
    .prepare(
      `UPDATE user_images
       SET deleted_at = ?, updated_at = ?, revision = revision + 1
       WHERE id = ? AND workspace_id = ? AND revision = ? AND deleted_at IS NULL`
    )
    .run(now, now, imageId, ctx.workspace.id, revision);
  if (result.changes === 0) throw new ServiceError('User image delete conflict', 'conflict', 409);
  recordChange({
    ctx,
    entityType: 'user_image',
    entityId: imageId,
    operation: 'delete',
    entityRevision: revision + 1
  });
}

export function createAttachment({
  ctx,
  input,
  authorization
}: {
  ctx: ServiceContext;
  input: {
    storageKey: string;
    filename: string;
    contentType?: string | null;
    sizeBytes?: number | null;
    checksumSha256?: string | null;
    uploadStatus?: 'prepared' | 'uploaded' | 'available' | 'failed' | 'deleted';
    projectId?: string | null;
    ticketId?: string | null;
    objectiveId?: string | null;
    metadata?: unknown;
  };
} & AuthorizationOptions): AttachmentSummary {
  requirePermission(ctx, PERMISSIONS.ATTACHMENT_CREATE, { authorization });
  const now = nowIso();
  const id = newId();
  const bucketId = getBucketId(ctx, 'attachments');

  ctx.db
    .prepare(
      `INSERT INTO attachments (
         id, workspace_id, project_id, ticket_id, objective_id, storage_bucket_id,
         storage_key, filename, content_type, size_bytes, checksum_sha256,
         upload_status, metadata_json, created_by_workspace_user_id, created_at,
         updated_at, revision
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    )
    .run(
      id,
      ctx.workspace.id,
      input.projectId ?? null,
      input.ticketId ?? null,
      input.objectiveId ?? null,
      bucketId,
      input.storageKey,
      input.filename,
      input.contentType ?? null,
      input.sizeBytes ?? null,
      input.checksumSha256 ?? null,
      input.uploadStatus ?? 'prepared',
      metadataJson(input.metadata),
      ctx.actorWorkspaceUserId,
      now,
      now
    );
  recordChange({
    ctx,
    entityType: 'attachment',
    entityId: id,
    operation: 'insert',
    entityRevision: 1,
    projectId: input.projectId ?? null,
    ticketId: input.ticketId ?? null,
    objectiveId: input.objectiveId ?? null
  });
  return assertFound(
    listAttachments({ ctx }).find(attachment => attachment.id === id),
    'Attachment missing'
  );
}

export function listAttachments({
  ctx,
  projectId,
  ticketId,
  objectiveId,
  authorization
}: {
  ctx: ServiceContext;
  projectId?: string | null;
  ticketId?: string | null;
  objectiveId?: string | null;
} & AuthorizationOptions): AttachmentSummary[] {
  requirePermission(ctx, PERMISSIONS.ATTACHMENT_READ, { authorization });
  const params: Array<string> = [ctx.workspace.id];
  let sql = `SELECT id, workspace_id, storage_bucket_id, storage_key, filename, content_type,
                    size_bytes, checksum_sha256, upload_status, revision
             FROM attachments
             WHERE workspace_id = ? AND deleted_at IS NULL`;
  if (projectId) {
    sql += ' AND project_id = ?';
    params.push(projectId);
  }
  if (ticketId) {
    sql += ' AND ticket_id = ?';
    params.push(ticketId);
  }
  if (objectiveId) {
    sql += ' AND objective_id = ?';
    params.push(objectiveId);
  }
  sql += ' ORDER BY created_at ASC';
  return (ctx.db.prepare(sql).all(...params) as StorageRow[]).map(attachmentSummary);
}

export function updateAttachment({
  ctx,
  attachmentId,
  revision,
  filename,
  uploadStatus,
  metadata,
  authorization
}: {
  ctx: ServiceContext;
  attachmentId: string;
  revision: number;
  filename: string;
  uploadStatus: 'prepared' | 'uploaded' | 'available' | 'failed' | 'deleted';
  metadata?: unknown;
} & AuthorizationOptions): AttachmentSummary {
  requirePermission(ctx, PERMISSIONS.ATTACHMENT_UPDATE, { authorization });
  const existing = assertFound(
    ctx.db
      .prepare(
        `SELECT project_id, ticket_id, objective_id
         FROM attachments WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
      )
      .get(attachmentId, ctx.workspace.id) as StorageRow | undefined,
    'Attachment not found'
  );
  const now = nowIso();
  const result = ctx.db
    .prepare(
      `UPDATE attachments
       SET filename = ?, upload_status = ?, metadata_json = ?, updated_at = ?, revision = revision + 1
       WHERE id = ? AND workspace_id = ? AND revision = ? AND deleted_at IS NULL`
    )
    .run(
      filename,
      uploadStatus,
      metadataJson(metadata),
      now,
      attachmentId,
      ctx.workspace.id,
      revision
    );
  if (result.changes === 0) throw new ServiceError('Attachment update conflict', 'conflict', 409);
  recordChange({
    ctx,
    entityType: 'attachment',
    entityId: attachmentId,
    operation: 'update',
    entityRevision: revision + 1,
    projectId: existing.project_id ?? null,
    ticketId: existing.ticket_id ?? null,
    objectiveId: existing.objective_id ?? null,
    changedFields: ['filename', 'upload_status', 'metadata_json']
  });
  return assertFound(
    listAttachments({ ctx }).find(attachment => attachment.id === attachmentId),
    'Attachment missing'
  );
}

export function deleteAttachment({
  ctx,
  attachmentId,
  revision,
  authorization
}: {
  ctx: ServiceContext;
  attachmentId: string;
  revision: number;
} & AuthorizationOptions): void {
  requirePermission(ctx, PERMISSIONS.ATTACHMENT_DELETE, { authorization });
  const existing = assertFound(
    ctx.db
      .prepare(
        `SELECT project_id, ticket_id, objective_id
         FROM attachments WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
      )
      .get(attachmentId, ctx.workspace.id) as StorageRow | undefined,
    'Attachment not found'
  );
  const now = nowIso();
  const result = ctx.db
    .prepare(
      `UPDATE attachments
       SET deleted_at = ?, updated_at = ?, revision = revision + 1
       WHERE id = ? AND workspace_id = ? AND revision = ? AND deleted_at IS NULL`
    )
    .run(now, now, attachmentId, ctx.workspace.id, revision);
  if (result.changes === 0) throw new ServiceError('Attachment delete conflict', 'conflict', 409);
  recordChange({
    ctx,
    entityType: 'attachment',
    entityId: attachmentId,
    operation: 'delete',
    entityRevision: revision + 1,
    projectId: existing.project_id ?? null,
    ticketId: existing.ticket_id ?? null,
    objectiveId: existing.objective_id ?? null
  });
}
