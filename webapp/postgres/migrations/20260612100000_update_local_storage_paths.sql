-- Point seeded local_fs buckets at database/.local/storage after the runtime data move.
BEGIN;

UPDATE storage_buckets
SET
  local_path = replace(local_path, '.overlord/storage/', 'database/.local/storage/'),
  updated_at = now() AT TIME ZONE 'utc'
WHERE storage_backend = 'local_fs'
  AND local_path LIKE '.overlord/storage/%'
  AND deleted_at IS NULL;

COMMIT;
