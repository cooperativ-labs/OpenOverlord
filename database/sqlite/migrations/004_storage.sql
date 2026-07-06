-- Overlord SQLite storage metadata schema.
-- Stores provider-neutral object metadata only; bytes live in local_fs or managed storage backends.

PRAGMA foreign_keys = ON;

BEGIN;

-- A bucket belongs to exactly one of a workspace or an organization
-- (organization buckets were added in coo:135). The cross-column CHECK enforces
-- that exactly one owner is set.
CREATE TABLE storage_buckets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces (id) ON DELETE RESTRICT,
  organization_id TEXT REFERENCES organizations (id) ON DELETE RESTRICT,
  bucket_key TEXT NOT NULL CHECK (length(trim(bucket_key)) > 0),
  storage_backend TEXT NOT NULL CHECK (length(trim(storage_backend)) > 0),
  base_url TEXT,
  local_path TEXT,
  settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json)),
  created_by_workspace_user_id TEXT REFERENCES workspace_users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CHECK ((workspace_id IS NOT NULL) <> (organization_id IS NOT NULL))
);

CREATE UNIQUE INDEX idx_storage_buckets_active_workspace_key ON storage_buckets
  (workspace_id, bucket_key)
  WHERE workspace_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX idx_storage_buckets_active_organization_key ON storage_buckets
  (organization_id, bucket_key)
  WHERE organization_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_storage_buckets_workspace_backend ON storage_buckets (workspace_id, storage_backend);

CREATE TABLE workspace_images (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  storage_bucket_id TEXT NOT NULL REFERENCES storage_buckets (id) ON DELETE RESTRICT,
  storage_key TEXT NOT NULL CHECK (length(trim(storage_key)) > 0),
  filename TEXT NOT NULL CHECK (length(trim(filename)) > 0),
  content_type TEXT NOT NULL CHECK (lower(content_type) LIKE 'image/%'),
  size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
  checksum_sha256 TEXT,
  width_px INTEGER CHECK (width_px IS NULL OR width_px > 0),
  height_px INTEGER CHECK (height_px IS NULL OR height_px > 0),
  alt_text TEXT,
  public_url TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_by_workspace_user_id TEXT REFERENCES workspace_users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX idx_workspace_images_active_bucket_key ON workspace_images
  (storage_bucket_id, storage_key)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_workspace_images_workspace_created ON workspace_images (workspace_id, created_at);

CREATE TABLE user_images (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  profile_id TEXT NOT NULL REFERENCES profiles (id) ON DELETE RESTRICT,
  storage_bucket_id TEXT NOT NULL REFERENCES storage_buckets (id) ON DELETE RESTRICT,
  storage_key TEXT NOT NULL CHECK (length(trim(storage_key)) > 0),
  filename TEXT NOT NULL CHECK (length(trim(filename)) > 0),
  content_type TEXT NOT NULL CHECK (lower(content_type) LIKE 'image/%'),
  size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
  checksum_sha256 TEXT,
  width_px INTEGER CHECK (width_px IS NULL OR width_px > 0),
  height_px INTEGER CHECK (height_px IS NULL OR height_px > 0),
  alt_text TEXT,
  public_url TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_by_workspace_user_id TEXT REFERENCES workspace_users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX idx_user_images_active_bucket_key ON user_images
  (storage_bucket_id, storage_key)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_user_images_workspace_profile_created ON user_images (workspace_id, profile_id, created_at);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects (id) ON DELETE RESTRICT,
  mission_id TEXT REFERENCES missions (id) ON DELETE RESTRICT,
  objective_id TEXT REFERENCES objectives (id) ON DELETE RESTRICT,
  storage_bucket_id TEXT NOT NULL REFERENCES storage_buckets (id) ON DELETE RESTRICT,
  storage_key TEXT NOT NULL CHECK (length(trim(storage_key)) > 0),
  filename TEXT NOT NULL CHECK (length(trim(filename)) > 0),
  content_type TEXT,
  size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
  checksum_sha256 TEXT,
  upload_status TEXT NOT NULL CHECK (upload_status IN ('prepared', 'uploaded', 'available', 'failed', 'deleted')),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_by_workspace_user_id TEXT REFERENCES workspace_users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
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
