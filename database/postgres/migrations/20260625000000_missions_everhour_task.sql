-- Everhour time-tracking integration (coo:29).
--
-- missions.everhour_task_id: the Everhour task this mission is linked to, written
-- when a user first starts a timer or links the mission from the mission panel.
-- Everhour task IDs are platform-prefixed strings (e.g. `ev:3000010034`), so this
-- is text, not an integer. Null until the mission is linked to an Everhour task.
--
-- The Everhour API key (per workspace) lives in `workspaces.settings_json` and the
-- linked Everhour project id/name/section live in `projects.settings_json`; both
-- are open JSON blobs and need no schema change. Only the mission→task association
-- needs a dedicated, queryable column.
--
-- Nullable + default null, so existing rows are unaffected.
--
-- Contract: database/docs/09-database-schema-contract.md → missions.everhour_task_id

ALTER TABLE missions ADD COLUMN everhour_task_id text;
