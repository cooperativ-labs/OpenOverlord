-- Overlord PostgreSQL storage metadata schema.
-- Stores provider-neutral object metadata only; bytes live in local_fs or managed storage backends.

BEGIN;

-- A bucket belongs to exactly one of a workspace or an organization
-- (organization buckets were added in coo:135). The named cross-column CHECK
-- enforces that exactly one owner is set.
CREATE TABLE storage_buckets (
  id text PRIMARY KEY,
  workspace_id text REFERENCES workspaces (id) ON DELETE RESTRICT,
  organization_id text REFERENCES organizations (id) ON DELETE RESTRICT,
  bucket_key text NOT NULL CHECK (char_length(btrim(bucket_key)) > 0),
  storage_backend text NOT NULL CHECK (char_length(btrim(storage_backend)) > 0),
  base_url text,
  local_path text,
  settings_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_workspace_user_id text REFERENCES workspace_users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CONSTRAINT storage_buckets_workspace_xor_organization
    CHECK ((workspace_id IS NOT NULL) <> (organization_id IS NOT NULL))
);

CREATE UNIQUE INDEX idx_storage_buckets_active_workspace_key ON storage_buckets
  (workspace_id, bucket_key)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_storage_buckets_active_organization_key ON storage_buckets
  (organization_id, bucket_key)
  WHERE organization_id IS NOT NULL AND deleted_at IS NULL;
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
  mission_id text REFERENCES missions (id) ON DELETE RESTRICT,
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
CREATE INDEX idx_attachments_mission_created ON attachments (mission_id, created_at)
  WHERE mission_id IS NOT NULL;
CREATE INDEX idx_attachments_objective_created ON attachments (objective_id, created_at)
  WHERE objective_id IS NOT NULL;

COMMIT;
