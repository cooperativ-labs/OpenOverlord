-- Project-scoped ticket tags.
-- Implements the logical `project_tags` (per-project tag definitions) and
-- `ticket_tags` (ticket↔tag assignment join) tables from the schema contract.
--
-- Contract: database/docs/09-database-schema-contract.md → project_tags / ticket_tags

CREATE TABLE project_tags (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  label TEXT NOT NULL CHECK (length(trim(label)) > 0),
  color TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_project_tags_project_label ON project_tags (project_id, label)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_project_tags_project_id ON project_tags (project_id, id);
CREATE INDEX idx_project_tags_project_active ON project_tags (project_id, active);

CREATE TABLE ticket_tags (
  ticket_id TEXT NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES project_tags (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  PRIMARY KEY (ticket_id, tag_id)
);

CREATE INDEX idx_ticket_tags_tag ON ticket_tags (tag_id);
