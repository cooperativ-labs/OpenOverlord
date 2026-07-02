-- Move application storage to canonical object keys under the shared local
-- storage root. Existing stored metadata is destructively tombstoned; byte
-- migration is intentionally skipped for this layout change.

BEGIN;

UPDATE storage_buckets
   SET local_path = 'database/.local/storage',
       updated_at = '2026-07-02T11:15:00.000Z',
       revision = revision + 1
 WHERE bucket_key IN ('workspace-images', 'user-images', 'attachments')
   AND storage_backend = 'local_fs'
   AND deleted_at IS NULL
   AND local_path <> 'database/.local/storage';

INSERT INTO storage_buckets (
  id, workspace_id, bucket_key, storage_backend, base_url, local_path, settings_json,
  created_by_workspace_user_id, created_at, updated_at, revision
)
SELECT
  gen_random_uuid()::text, w.id, bucket_keys.bucket_key, 'local_fs',
  NULL, 'database/.local/storage', '{}'::jsonb,
  NULL, '2026-07-02T11:15:00.000Z', '2026-07-02T11:15:00.000Z', 1
  FROM workspaces w
 CROSS JOIN (
   VALUES ('workspace-images'), ('user-images'), ('attachments')
 ) AS bucket_keys(bucket_key)
 WHERE w.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM storage_buckets b
      WHERE b.workspace_id = w.id
        AND b.bucket_key = bucket_keys.bucket_key
        AND b.deleted_at IS NULL
   );

UPDATE user_images
   SET deleted_at = '2026-07-02T11:15:00.000Z',
       updated_at = '2026-07-02T11:15:00.000Z',
       revision = revision + 1
 WHERE deleted_at IS NULL;

UPDATE workspace_images
   SET deleted_at = '2026-07-02T11:15:00.000Z',
       updated_at = '2026-07-02T11:15:00.000Z',
       revision = revision + 1
 WHERE deleted_at IS NULL;

UPDATE attachments
   SET deleted_at = '2026-07-02T11:15:00.000Z',
       upload_status = 'deleted',
       updated_at = '2026-07-02T11:15:00.000Z',
       revision = revision + 1
 WHERE deleted_at IS NULL;

COMMIT;
