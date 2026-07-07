-- project_resources.resource_key (coo:169)
--
-- Stable slug for target-portable resource identity within a project.

BEGIN;

ALTER TABLE project_resources
  ADD COLUMN IF NOT EXISTS resource_key text;

UPDATE project_resources
SET resource_key = left(
  coalesce(
    nullif(
      regexp_replace(
        regexp_replace(
          lower(
            btrim(
              coalesce(
                nullif(btrim(label), ''),
                regexp_replace(path, '^.+[/\\]', '')
              )
            )
          ),
          '[^a-z0-9]+',
          '-',
          'g'
        ),
        '(^-+|-+$)',
        '',
        'g'
      ),
      ''
    ),
    'project'
  ),
  48
)
WHERE resource_key IS NULL OR char_length(btrim(resource_key)) = 0;

WITH duplicates AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY project_id, execution_target_id, resource_key
           ORDER BY created_at, id
         ) AS key_rank
    FROM project_resources
   WHERE deleted_at IS NULL
)
UPDATE project_resources pr
   SET resource_key = left(pr.resource_key, 40) || '-' || substr(replace(pr.id, '-', ''), 1, 7)
  FROM duplicates d
 WHERE pr.id = d.id
   AND d.key_rank > 1;

ALTER TABLE project_resources
  ALTER COLUMN resource_key SET NOT NULL;

ALTER TABLE project_resources
  DROP CONSTRAINT IF EXISTS project_resources_resource_key_nonempty;

ALTER TABLE project_resources
  ADD CONSTRAINT project_resources_resource_key_nonempty
  CHECK (char_length(btrim(resource_key)) > 0);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_resources_active_project_target_key
  ON project_resources (project_id, execution_target_id, resource_key)
  WHERE deleted_at IS NULL;

COMMIT;
