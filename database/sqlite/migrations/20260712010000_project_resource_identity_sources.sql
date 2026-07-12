-- Resource identity/source split (coo:263, contract 3).
--
-- Existing linked paths are intentionally discarded. Resources must be re-added
-- as logical identities plus source descriptors; keeping old target/path rows
-- would retain the ambiguous identity model this migration removes.

PRAGMA foreign_keys = OFF;

DELETE FROM target_resource_observations;
UPDATE execution_requests SET resolved_resource_id = NULL;
UPDATE changed_files SET resource_id = NULL;
DROP TABLE IF EXISTS project_resource_sources;
DROP TABLE project_resources;

CREATE TABLE project_resources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  resource_key TEXT NOT NULL CHECK (length(trim(resource_key)) > 0),
  label TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_project_resources_project_primary
  ON project_resources (project_id, is_primary);
CREATE UNIQUE INDEX idx_project_resources_active_project_key
  ON project_resources (project_id, resource_key) WHERE deleted_at IS NULL;

CREATE TABLE project_resource_sources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  resource_id TEXT NOT NULL REFERENCES project_resources (id) ON DELETE CASCADE,
  execution_target_id TEXT REFERENCES execution_targets (id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (length(trim(source_kind)) > 0),
  descriptor_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(descriptor_json)),
  observed_revision TEXT,
  observed_content_digest TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_prs_active_target_kind
  ON project_resource_sources (resource_id, execution_target_id, source_kind)
  WHERE deleted_at IS NULL AND execution_target_id IS NOT NULL;
CREATE UNIQUE INDEX idx_prs_active_global_kind
  ON project_resource_sources (resource_id, source_kind)
  WHERE deleted_at IS NULL AND execution_target_id IS NULL;
CREATE INDEX idx_prs_resource_target ON project_resource_sources (resource_id, execution_target_id);
CREATE INDEX idx_prs_project_source_kind ON project_resource_sources (project_id, source_kind);

PRAGMA foreign_keys = ON;
