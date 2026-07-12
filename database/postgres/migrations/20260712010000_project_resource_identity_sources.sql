-- Resource identity/source split (coo:263, contract 3).
-- Existing resource rows and availability observations are intentionally
-- discarded; users re-add logical resources and source descriptors.

BEGIN;

DELETE FROM target_resource_observations;
UPDATE execution_requests SET resolved_resource_id = NULL;
UPDATE changed_files SET resource_id = NULL;
DROP TABLE IF EXISTS project_resource_sources;
DROP TABLE project_resources CASCADE;

CREATE TABLE project_resources (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  resource_key text NOT NULL CHECK (char_length(btrim(resource_key)) > 0),
  label text,
  is_primary boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('active', 'archived')),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id) ON DELETE RESTRICT
);

ALTER TABLE changed_files ADD CONSTRAINT changed_files_resource_id_fkey
  FOREIGN KEY (resource_id) REFERENCES project_resources (id) ON DELETE SET NULL;
ALTER TABLE execution_requests ADD CONSTRAINT execution_requests_resolved_resource_id_fkey
  FOREIGN KEY (resolved_resource_id) REFERENCES project_resources (id) ON DELETE SET NULL;
ALTER TABLE target_resource_observations ADD CONSTRAINT target_resource_observations_resource_id_fkey
  FOREIGN KEY (resource_id) REFERENCES project_resources (id) ON DELETE CASCADE;

CREATE INDEX idx_project_resources_project_primary ON project_resources (project_id, is_primary);
CREATE UNIQUE INDEX idx_project_resources_active_project_key
  ON project_resources (project_id, resource_key) WHERE deleted_at IS NULL;

CREATE TABLE project_resource_sources (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  resource_id text NOT NULL REFERENCES project_resources (id) ON DELETE CASCADE,
  execution_target_id text REFERENCES execution_targets (id) ON DELETE CASCADE,
  source_kind text NOT NULL CHECK (char_length(btrim(source_kind)) > 0),
  descriptor_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_revision text,
  observed_content_digest text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
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

COMMIT;
