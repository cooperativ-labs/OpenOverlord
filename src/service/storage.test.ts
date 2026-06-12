import { LOCAL_STORAGE_BUCKET_PATHS, openInMemoryDatabase } from '@overlord/database';
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

function createMemberContext(adminCtx: ServiceContext): ServiceContext {
  const now = '2026-01-01T00:00:01.000Z';
  adminCtx.db
    .prepare(
      `INSERT INTO "user" (
         "id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt"
       ) VALUES (?, ?, ?, 1, NULL, ?, ?)`
    )
    .run('member-user', 'Member User', 'member@example.test', now, now);
  adminCtx.db
    .prepare(
      `UPDATE profiles
          SET handle = ?, updated_at = ?, revision = revision + 1
        WHERE id = ?`
    )
    .run('member', now, 'member-user');
  adminCtx.db
    .prepare(
      `INSERT INTO workspace_users (
         id, workspace_id, profile_id, member_key, status, metadata_json,
         created_at, updated_at, revision
       ) VALUES (?, ?, ?, ?, 'active', '{}', ?, ?, 1)`
    )
    .run('member-workspace-user', adminCtx.workspace.id, 'member-user', 'local:member', now, now);
  adminCtx.db
    .prepare(
      `INSERT INTO role_assignments (
         id, workspace_id, workspace_user_id, role_key, resource_type, resource_id,
         assigned_by_workspace_user_id, created_at, updated_at, revision
       ) VALUES (?, ?, ?, 'MEMBER', '', '', ?, ?, ?, 1)`
    )
    .run(
      'member-role',
      adminCtx.workspace.id,
      'member-workspace-user',
      adminCtx.actorWorkspaceUserId,
      now,
      now
    );

  return { ...adminCtx, actorWorkspaceUserId: 'member-workspace-user' };
}

describe('storage service', () => {
  it('seeds local storage buckets', () => {
    const db = openInMemoryDatabase();
    try {
      const ctx = createServiceContext({ db, source: 'cli' });
      const buckets = listStorageBuckets({ ctx });
      assert.deepEqual(
        buckets.map(bucket => [bucket.key, bucket.backend, bucket.localPath]),
        [
          ['attachments', 'local_fs', LOCAL_STORAGE_BUCKET_PATHS.attachments],
          ['user-images', 'local_fs', LOCAL_STORAGE_BUCKET_PATHS['user-images']],
          ['workspace-images', 'local_fs', LOCAL_STORAGE_BUCKET_PATHS['workspace-images']]
        ]
      );
    } finally {
      db.close();
    }
  });

  it('allows public image reads but not workspace image writes', () => {
    const db = openInMemoryDatabase();
    try {
      const adminCtx = createServiceContext({ db, source: 'cli' });
      const image = createWorkspaceImage({
        ctx: adminCtx,
        input: {
          storageKey: 'hero.png',
          filename: 'hero.png',
          contentType: 'image/png',
          publicUrl: 'https://cdn.example.test/hero.png'
        }
      });
      const publicCtx = { ...adminCtx, actorWorkspaceUserId: null };

      assert.equal(listWorkspaceImages({ ctx: publicCtx })[0]?.id, image.id);
      assert.throws(
        () =>
          createWorkspaceImage({
            ctx: publicCtx,
            input: { storageKey: 'nope.png', filename: 'nope.png', contentType: 'image/png' }
          }),
        ServiceError
      );
    } finally {
      db.close();
    }
  });

  it('allows members to manage attachments', () => {
    const db = openInMemoryDatabase();
    try {
      const adminCtx = createServiceContext({ db, source: 'cli' });
      const memberCtx = createMemberContext(adminCtx);
      const attachment = createAttachment({
        ctx: memberCtx,
        input: {
          storageKey: 'notes.txt',
          filename: 'notes.txt',
          contentType: 'text/plain',
          uploadStatus: 'uploaded'
        }
      });

      const updated = updateAttachment({
        ctx: memberCtx,
        attachmentId: attachment.id,
        revision: attachment.revision,
        filename: 'notes-renamed.txt',
        uploadStatus: 'available'
      });
      assert.equal(updated.filename, 'notes-renamed.txt');
      assert.equal(listAttachments({ ctx: memberCtx }).length, 1);

      deleteAttachment({ ctx: memberCtx, attachmentId: updated.id, revision: updated.revision });
      assert.equal(listAttachments({ ctx: memberCtx }).length, 0);
    } finally {
      db.close();
    }
  });

  it('allows members to manage their own user images only', () => {
    const db = openInMemoryDatabase();
    try {
      const adminCtx = createServiceContext({ db, source: 'cli' });
      const memberCtx = createMemberContext(adminCtx);

      const ownImage = createUserImage({
        ctx: memberCtx,
        userId: 'member-user',
        input: { storageKey: 'avatar.png', filename: 'avatar.png', contentType: 'image/png' }
      });
      assert.equal(
        listUserImages({ ctx: { ...memberCtx, actorWorkspaceUserId: null } })[0]?.id,
        ownImage.id
      );

      assert.throws(
        () =>
          createUserImage({
            ctx: memberCtx,
            userId: 'local-user',
            input: { storageKey: 'other.png', filename: 'other.png', contentType: 'image/png' }
          }),
        ServiceError
      );
    } finally {
      db.close();
    }
  });
});
