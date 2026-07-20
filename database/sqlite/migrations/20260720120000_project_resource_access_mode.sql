-- project_resources.access_mode (coo:368)
--
-- Read vs read & write permission per logical project resource.
--   'read_write' — full functionality (the historical behavior): pickable in the
--     resource picker, writes `.overlord/project.json`, included in resource paths.
--   'read' — reference resource: NOT offered in the resource picker and does NOT
--     write `.overlord/project.json`, but IS still included in the resource paths
--     env (file-path sources only; URL/git sources contribute no path).
--
-- Existing rows default to 'read_write' so current resources keep working exactly
-- as before. Primary resources must always be 'read_write' (enforced in service
-- and REST write paths).

ALTER TABLE project_resources
  ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'read_write'
    CHECK (access_mode IN ('read', 'read_write'));
