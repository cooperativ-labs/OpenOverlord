-- Project reordering in the sidebar (coo:132): projects gain a 1-based
-- `position` for drag-and-drop ordering within a workspace.
-- Contract: database/docs/09-database-schema-contract.md -> projects.position

BEGIN;

ALTER TABLE projects ADD COLUMN position integer CHECK (position IS NULL OR position >= 1);

WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY created_at, id) AS rn
    FROM projects
   WHERE deleted_at IS NULL
)
UPDATE projects
   SET position = ranked.rn
  FROM ranked
 WHERE projects.id = ranked.id;

CREATE UNIQUE INDEX idx_projects_workspace_position ON projects (workspace_id, position)
  WHERE deleted_at IS NULL;

COMMIT;
