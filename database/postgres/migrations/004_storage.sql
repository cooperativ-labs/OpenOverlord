-- Overlord PostgreSQL storage metadata schema.
-- Stores provider-neutral object metadata only; bytes live in local_fs or managed storage backends.

BEGIN;

CREATE TABLE storage_buckets (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  bucket_key text NOT NULL CHECK (char_length(btrim(bucket_key)) > 0),
  storage_backend text NOT NULL CHECK (char_length(btrim(storage_backend)) > 0),
  base_url text,
  local_path text,
  settings_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_workspace_user_id text REFERENCES workspace_users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX idx_storage_buckets_active_workspace_key ON storage_buckets
  (workspace_id, bucket_key)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_storage_buckets_workspace_backend ON storage_buckets (workspace_id, storage_backend);

CREATE TABLE workspace_images (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  storage_bucket_id text NOT NULL REFERENCES storage_buckets (id) ON DELETE RESTRICT,
  storage_key text NOT NULL CHECK (char_length(btrim(storage_key)) > 0),
  filename text NOT NULL CHECK (char_length(btrim(filename)) > 0),
  content_type text NOT NULL CHECK (lower(content_type) LIKE 'image/%'),
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  checksum_sha256 text,
  width_px integer CHECK (width_px IS NULL OR width_px > 0),
  height_px integer CHECK (height_px IS NULL OR height_px > 0),
  alt_text text,
  public_url text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_workspace_user_id text REFERENCES workspace_users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX idx_workspace_images_active_bucket_key ON workspace_images
  (storage_bucket_id, storage_key)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_workspace_images_workspace_created ON workspace_images (workspace_id, created_at);

CREATE TABLE user_images (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  profile_id text NOT NULL REFERENCES profiles (id) ON DELETE RESTRICT,
  storage_bucket_id text NOT NULL REFERENCES storage_buckets (id) ON DELETE RESTRICT,
  storage_key text NOT NULL CHECK (char_length(btrim(storage_key)) > 0),
  filename text NOT NULL CHECK (char_length(btrim(filename)) > 0),
  content_type text NOT NULL CHECK (lower(content_type) LIKE 'image/%'),
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  checksum_sha256 text,
  width_px integer CHECK (width_px IS NULL OR width_px > 0),
  height_px integer CHECK (height_px IS NULL OR height_px > 0),
  alt_text text,
  public_url text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_workspace_user_id text REFERENCES workspace_users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX idx_user_images_active_bucket_key ON user_images
  (storage_bucket_id, storage_key)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_user_images_workspace_profile_created ON user_images (workspace_id, profile_id, created_at);

CREATE TABLE attachments (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id text REFERENCES projects (id) ON DELETE RESTRICT,
  ticket_id text REFERENCES tickets (id) ON DELETE RESTRICT,
  objective_id text REFERENCES objectives (id) ON DELETE RESTRICT,
  storage_bucket_id text NOT NULL REFERENCES storage_buckets (id) ON DELETE RESTRICT,
  storage_key text NOT NULL CHECK (char_length(btrim(storage_key)) > 0),
  filename text NOT NULL CHECK (char_length(btrim(filename)) > 0),
  content_type text,
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  checksum_sha256 text,
  upload_status text NOT NULL CHECK (upload_status IN ('prepared', 'uploaded', 'available', 'failed', 'deleted')),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_workspace_user_id text REFERENCES workspace_users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX idx_attachments_active_bucket_key ON attachments
  (storage_bucket_id, storage_key)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_attachments_workspace_created ON attachments (workspace_id, created_at);
CREATE INDEX idx_attachments_project_created ON attachments (project_id, created_at)
  WHERE project_id IS NOT NULL;
CREATE INDEX idx_attachments_ticket_created ON attachments (ticket_id, created_at)
  WHERE ticket_id IS NOT NULL;
CREATE INDEX idx_attachments_objective_created ON attachments (objective_id, created_at)
  WHERE objective_id IS NOT NULL;

INSERT INTO storage_buckets (
  id, workspace_id, bucket_key, storage_backend, base_url, local_path, settings_json,
  created_by_workspace_user_id, created_at, updated_at, revision
) VALUES
  (
    'local-storage-workspace-images', 'local-workspace', 'workspace-images', 'local_fs',
    NULL, 'database/.local/storage/workspace-images', '{}'::jsonb, 'local-workspace-user',
    '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1
  ),
  (
    'local-storage-user-images', 'local-workspace', 'user-images', 'local_fs',
    NULL, 'database/.local/storage/user-images', '{}'::jsonb, 'local-workspace-user',
    '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1
  ),
  (
    'local-storage-attachments', 'local-workspace', 'attachments', 'local_fs',
    NULL, 'database/.local/storage/attachments', '{}'::jsonb, 'local-workspace-user',
    '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1
  );

COMMIT;
