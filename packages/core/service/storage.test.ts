import {
  createSqliteClient,
  LOCAL_STORAGE_BUCKET_PATHS,
  openInMemoryDatabase
} from '@overlord/database';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createServiceContext, type ServiceContext } from './context.js';
import { ServiceError } from './errors.js';
import {
  createAttachment,
  createUserImage,
  createWorkspaceImage,
  deleteAttachment,
  listAttachments,
  listStorageBuckets,
  listUserImages,
  listWorkspaceImages,
  updateAttachment
} from './storage.js';
import { seedServiceOperator } from './test-helpers.js';

async function createMemberContext(adminCtx: ServiceContext): Promise<ServiceContext> {
  const now = '2026-01-01T00:00:01.000Z';
  await adminCtx.db.run(
    `INSERT INTO "user" (
         "id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt"
       ) VALUES (?, ?, ?, 1, NULL, ?, ?)`,
    ['member-user', 'Member User', 'member@example.test', now, now]
  );
  await adminCtx.db.run(
    `UPDATE profiles
          SET handle = ?, updated_at = ?, revision = revision + 1
        WHERE id = ?`,
    ['member', now, 'member-user']
  );
  await adminCtx.db.run(
    `INSERT INTO workspace_users (
         id, workspace_id, profile_id, member_key, status, metadata_json,
         created_at, updated_at, revision
       ) VALUES (?, ?, ?, ?, 'active', '{}', ?, ?, 1)`,
    ['member-workspace-user', adminCtx.workspace.id, 'member-user', 'local:member', now, now]
  );
  await adminCtx.db.run(
    `INSERT INTO role_assignments (
         id, workspace_id, workspace_user_id, role_key, resource_type, resource_id,
         assigned_by_workspace_user_id, created_at, updated_at, revision
       ) VALUES (?, ?, ?, 'MEMBER', '', '', ?, ?, ?, 1)`,
    [
      'member-role',
      adminCtx.workspace.id,
      'member-workspace-user',
      adminCtx.actorWorkspaceUserId,
      now,
      now
    ]
  );

  return { ...adminCtx, actorWorkspaceUserId: 'member-workspace-user' };
}

describe('storage service', () => {
  it('seeds local storage buckets', async () => {
    const db = createSqliteClient(openInMemoryDatabase());
    try {
      await seedServiceOperator({ db });
      const ctx = await createServiceContext({ db, source: 'cli' });
      const buckets = await listStorageBuckets({ ctx });
      assert.deepEqual(
        buckets.map(bucket => [bucket.key, bucket.backend, bucket.localPath]),
        [
          ['attachments', 'local_fs', LOCAL_STORAGE_BUCKET_PATHS.attachments],
          ['user-images', 'local_fs', LOCAL_STORAGE_BUCKET_PATHS['user-images']],
          ['workspace-images', 'local_fs', LOCAL_STORAGE_BUCKET_PATHS['workspace-images']]
        ]
      );
    } finally {
      await db.close();
    }
  });

  it('allows public image reads but not workspace image writes', async () => {
    const db = createSqliteClient(openInMemoryDatabase());
    try {
      await seedServiceOperator({ db });
      const adminCtx = await createServiceContext({ db, source: 'cli' });
      const image = await createWorkspaceImage({
        ctx: adminCtx,
        input: {
          storageKey: 'hero.png',
          filename: 'hero.png',
          contentType: 'image/png',
          publicUrl: 'https://cdn.example.test/hero.png'
        }
      });
      const publicCtx = { ...adminCtx, actorWorkspaceUserId: null };

      assert.equal((await listWorkspaceImages({ ctx: publicCtx }))[0]?.id, image.id);
      await assert.rejects(
        async () =>
          await createWorkspaceImage({
            ctx: publicCtx,
            input: { storageKey: 'nope.png', filename: 'nope.png', contentType: 'image/png' }
          }),
        ServiceError
      );
    } finally {
      await db.close();
    }
  });

  it('allows members to manage attachments', async () => {
    const db = createSqliteClient(openInMemoryDatabase());
    try {
      await seedServiceOperator({ db });
      const adminCtx = await createServiceContext({ db, source: 'cli' });
      const memberCtx = await createMemberContext(adminCtx);
      const attachment = await createAttachment({
        ctx: memberCtx,
        input: {
          storageKey: 'notes.txt',
          filename: 'notes.txt',
          contentType: 'text/plain',
          uploadStatus: 'uploaded'
        }
      });

      const updated = await updateAttachment({
        ctx: memberCtx,
        attachmentId: attachment.id,
        revision: attachment.revision,
        filename: 'notes-renamed.txt',
        uploadStatus: 'available'
      });
      assert.equal(updated.filename, 'notes-renamed.txt');
      assert.equal((await listAttachments({ ctx: memberCtx })).length, 1);

      await deleteAttachment({
        ctx: memberCtx,
        attachmentId: updated.id,
        revision: updated.revision
      });
      assert.equal((await listAttachments({ ctx: memberCtx })).length, 0);
    } finally {
      await db.close();
    }
  });

  it('allows members to manage their own user images only', async () => {
    const db = createSqliteClient(openInMemoryDatabase());
    try {
      await seedServiceOperator({ db });
      const adminCtx = await createServiceContext({ db, source: 'cli' });
      const memberCtx = await createMemberContext(adminCtx);

      const ownImage = await createUserImage({
        ctx: memberCtx,
        userId: 'member-user',
        input: { storageKey: 'avatar.png', filename: 'avatar.png', contentType: 'image/png' }
      });
      assert.equal(
        (await listUserImages({ ctx: { ...memberCtx, actorWorkspaceUserId: null } }))[0]?.id,
        ownImage.id
      );

      await assert.rejects(
        async () =>
          await createUserImage({
            ctx: memberCtx,
            userId: 'local-user',
            input: { storageKey: 'other.png', filename: 'other.png', contentType: 'image/png' }
          }),
        ServiceError
      );
    } finally {
      await db.close();
    }
  });
});
