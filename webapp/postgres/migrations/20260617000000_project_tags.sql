-- Project-scoped mission tags (PostgreSQL).
-- Implements the logical `project_tags` (per-project tag definitions) and
-- `mission_tags` (mission↔tag assignment join) tables from the schema contract.
--
-- Contract: database/docs/09-database-schema-contract.md → project_tags / mission_tags

BEGIN;

CREATE TABLE project_tags (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  label text NOT NULL CHECK (char_length(btrim(label)) > 0),
  color text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_project_tags_project_label ON project_tags (project_id, label)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_project_tags_project_id ON project_tags (project_id, id);
CREATE INDEX idx_project_tags_project_active ON project_tags (project_id, active);

CREATE TABLE mission_tags (
  mission_id text NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
  tag_id text NOT NULL REFERENCES project_tags (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (mission_id, tag_id)
);

CREATE INDEX idx_mission_tags_tag ON mission_tags (tag_id);

COMMIT;
