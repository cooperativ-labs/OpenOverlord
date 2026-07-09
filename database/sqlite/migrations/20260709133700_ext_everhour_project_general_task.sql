-- Everhour project-level "general" task id (coo:216).
--
-- Stores the Everhour task used for per-project time tracking (task name
-- "general") on the existing project link row.
--
-- Contract: database/docs/09-database-schema-contract.md → ext_everhour_project_links

PRAGMA foreign_keys = ON;

ALTER TABLE ext_everhour_project_links
  ADD COLUMN everhour_general_task_id TEXT;
