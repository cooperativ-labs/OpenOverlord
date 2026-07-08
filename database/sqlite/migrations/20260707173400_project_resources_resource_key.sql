-- project_resources.resource_key (coo:169)
--
-- Stable slug for target-portable resource identity within a project.
-- Backfill and the active unique index are finalized in migration runtime.

PRAGMA foreign_keys = ON;

ALTER TABLE project_resources ADD COLUMN resource_key TEXT;
