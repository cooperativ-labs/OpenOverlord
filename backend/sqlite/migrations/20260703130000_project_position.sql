-- Project reordering in the sidebar (coo:132): projects gain a 1-based
-- `position` for drag-and-drop ordering within a workspace.
-- Contract: database/docs/09-database-schema-contract.md -> projects.position

PRAGMA foreign_keys = ON;

BEGIN;

-- SQLite's ALTER TABLE ADD COLUMN cannot add a per-row unique/backfilled
-- value in one step (no table rebuild), matching this repo's precedent for
-- other columns added via ALTER TABLE, e.g. missions.schedule_id.
ALTER TABLE projects ADD COLUMN position INTEGER CHECK (position IS NULL OR position >= 1);

-- Backfill existing projects with a stable 1-based ordering per workspace,
-- oldest first.
UPDATE projects
SET position = (
  SELECT COUNT(*) + 1
    FROM projects AS earlier
   WHERE earlier.workspace_id = projects.workspace_id
     AND earlier.deleted_at IS NULL
     AND (
       earlier.created_at < projects.created_at
       OR (earlier.created_at = projects.created_at AND earlier.id < projects.id)
     )
)
WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX idx_projects_workspace_position ON projects (workspace_id, position)
  WHERE deleted_at IS NULL;

COMMIT;
