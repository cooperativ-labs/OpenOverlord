/**
 * Self-service account deletion cascade.
 *
 * Invoked from Better Auth's `user.deleteUser` `beforeDelete` hook (see
 * `auth/src/auth/config.ts` and `backend/auth.ts`) before the auth `"user"`
 * row — and everything that hard-cascades from it (`session`, `account`,
 * `profiles`, `user_execution_target_preferences`) — is removed.
 *
 * `profiles` has three `ON DELETE RESTRICT` children (`workspace_users`,
 * `user_tokens`, `user_images`), and `workspace_users` itself has four more
 * (`role_assignments`, `user_tokens`, `workspace_user_execution_targets`,
 * `project_user_preferences`). `RESTRICT` blocks on row *existence*, not on
 * `deleted_at` — a tombstoned row still blocks the parent delete — so a soft
 * cascade can never unblock the profile's hard delete. Every row here is
 * exclusively owned by this profile (or by a `workspace_users` row that is
 * itself being removed), so once the identity is gone none of them have
 * standalone meaning; this hard-deletes them, which is the "service-managed
 * soft cascade for owned mutable children" default
 * (database/docs/09-database-schema-contract.md) applied to a case where the
 * parent's own removal is already a hard purge, not a tombstone. Each removal
 * still emits an `entity_changes` row so realtime/sync clients observe it, per
 * that doc's "a purge... must emit a purge outbox/change notification" rule.
 *
 * Unlike most service functions this intentionally spans every workspace the
 * profile belongs to, not just the active `WORKSPACE.id`: deleting an
 * identity removes it everywhere, not just from the current workspace.
 *
 * Every `recordChange` call here pins `actorWorkspaceUserId: null` instead of
 * letting it default to the ambient active workspace user: the caller (the
 * `beforeDelete` hook runs outside any request context) can easily resolve to
 * one of this very profile's own memberships, which would violate
 * `entity_changes`' FK the instant that row is purged below.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { recordChange, requireDatabaseClient } from './db.ts';
import { createStorageBackend } from './storage-backends.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface ImageCleanup {
  key: string;
  bucket: {
    id: string;
    bucket_key: string;
    storage_backend: string;
    local_path: string | null;
    settings_json: string;
  };
}

export async function cascadeDeleteAccount(profileId: string): Promise<void> {
  const cleanupImages = await requireDatabaseClient().transaction(async tx => {
    const profile = await tx.get<{ id: string }>(`SELECT id FROM profiles WHERE id = ?`, [
      profileId
    ]);
    if (!profile) return [];

    const memberships = await tx.all<{ id: string; workspace_id: string }>(
      `SELECT id, workspace_id FROM workspace_users WHERE profile_id = ?`,
      [profileId]
    );
    for (const membership of memberships) {
      await tx.run(`DELETE FROM role_assignments WHERE workspace_user_id = ?`, [membership.id]);
      await tx.run(`DELETE FROM workspace_user_execution_targets WHERE workspace_user_id = ?`, [
        membership.id
      ]);
      await tx.run(`DELETE FROM project_user_preferences WHERE workspace_user_id = ?`, [
        membership.id
      ]);
    }

    const tokens = await tx.all<{ id: string; workspace_id: string }>(
      `SELECT id, workspace_id FROM user_tokens WHERE profile_id = ?`,
      [profileId]
    );
    for (const token of tokens) {
      await tx.run(`DELETE FROM user_tokens WHERE id = ?`, [token.id]);
      await recordChange(
        {
          entityType: 'user_token',
          entityId: token.id,
          operation: 'delete',
          workspaceId: token.workspace_id,
          // Never default to the ambient active workspace user: it can be one
          // of this very profile's own memberships (about to be purged below),
          // which would violate entity_changes' FK the instant that row is gone.
          actorWorkspaceUserId: null
        },
        tx
      );
    }

    const images = await tx.all<{
      id: string;
      workspace_id: string;
      storage_key: string;
      bucket_id: string;
      bucket_key: string;
      storage_backend: string;
      local_path: string | null;
      settings_json: string;
    }>(
      `SELECT i.id, i.workspace_id, i.storage_key,
              b.id AS bucket_id, b.bucket_key, b.storage_backend, b.local_path, b.settings_json
         FROM user_images i
         JOIN storage_buckets b ON b.id = i.storage_bucket_id
        WHERE i.profile_id = ?`,
      [profileId]
    );
    const cleanup: ImageCleanup[] = [];
    for (const image of images) {
      await tx.run(`DELETE FROM user_images WHERE id = ?`, [image.id]);
      await recordChange(
        {
          entityType: 'user_image',
          entityId: image.id,
          operation: 'delete',
          workspaceId: image.workspace_id,
          actorWorkspaceUserId: null
        },
        tx
      );
      cleanup.push({
        key: image.storage_key,
        bucket: {
          id: image.bucket_id,
          bucket_key: image.bucket_key,
          storage_backend: image.storage_backend,
          local_path: image.local_path,
          settings_json: image.settings_json
        }
      });
    }

    for (const membership of memberships) {
      await tx.run(`DELETE FROM workspace_users WHERE id = ?`, [membership.id]);
      await recordChange(
        {
          entityType: 'workspace_user',
          entityId: membership.id,
          operation: 'delete',
          workspaceId: membership.workspace_id,
          actorWorkspaceUserId: null
        },
        tx
      );
    }

    return cleanup;
  });

  // Remote-backed image bytes live outside the database; local_fs bytes are
  // left on disk, mirroring backend/storage.ts's deleteObjectiveAttachment.
  for (const image of cleanupImages) {
    if (
      image.bucket.storage_backend === 's3' ||
      image.bucket.storage_backend === 'railway_volume'
    ) {
      const backend = createStorageBackend({ bucket: image.bucket, repoRoot });
      await backend.deleteObject?.({ key: image.key });
    }
  }
}
