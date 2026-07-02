-- Give each workspace its own `workspace-images` storage folder, keyed by
-- workspace ID with an `images` subfolder inside, so a workspace logo upload
-- lands in a folder scoped to that workspace (see backend/workspaces.ts
-- `seedWorkspaceStorageBucket`, which provisions this row for new workspaces
-- going forward).

PRAGMA foreign_keys = ON;

BEGIN;

UPDATE storage_buckets
   SET local_path = 'database/.local/storage/workspace-images/' || workspace_id || '/images',
       updated_at = '2026-07-02T00:00:00.000Z'
 WHERE bucket_key = 'workspace-images'
   AND storage_backend = 'local_fs'
   AND deleted_at IS NULL;

-- Backfill a `workspace-images` bucket for any workspace that doesn't have one
-- yet (only the first, seeded workspace was provisioned by `004_storage.sql`).
INSERT INTO storage_buckets (
  id, workspace_id, bucket_key, storage_backend, base_url, local_path, settings_json,
  created_by_workspace_user_id, created_at, updated_at, revision
)
SELECT
  lower(hex(randomblob(16))), w.id, 'workspace-images', 'local_fs',
  NULL, 'database/.local/storage/workspace-images/' || w.id || '/images', '{}',
  NULL, '2026-07-02T00:00:00.000Z', '2026-07-02T00:00:00.000Z', 1
  FROM workspaces w
 WHERE w.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM storage_buckets b
      WHERE b.workspace_id = w.id AND b.bucket_key = 'workspace-images' AND b.deleted_at IS NULL
   );

COMMIT;
