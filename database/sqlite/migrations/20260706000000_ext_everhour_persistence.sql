-- Everhour extension persistence (coo:29).
--
-- Introduces `ext_everhour_*` tables and backfills workspace/project links from
-- legacy JSON settings. Mission-link backfill from the retired core
-- `missions.everhour_task_id` column runs in migration runtime when that column
-- still exists, then drops it.
--
-- Contract: database/docs/09-database-schema-contract.md → ext_everhour_*

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS ext_everhour_workspace_connections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  api_key_secret TEXT NOT NULL CHECK (length(trim(api_key_secret)) > 0),
  account_id TEXT,
  account_name TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ext_everhour_workspace_connections_active
  ON ext_everhour_workspace_connections (workspace_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ext_everhour_workspace_connections_workspace_deleted
  ON ext_everhour_workspace_connections (workspace_id, deleted_at);

CREATE TABLE IF NOT EXISTS ext_everhour_project_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  everhour_project_id TEXT NOT NULL CHECK (length(trim(everhour_project_id)) > 0),
  everhour_project_name TEXT NOT NULL CHECK (length(trim(everhour_project_name)) > 0),
  everhour_section_id TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ext_everhour_project_links_active
  ON ext_everhour_project_links (workspace_id, project_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ext_everhour_project_links_workspace_project
  ON ext_everhour_project_links (workspace_id, everhour_project_id);

CREATE INDEX IF NOT EXISTS idx_ext_everhour_project_links_project_deleted
  ON ext_everhour_project_links (project_id, deleted_at);

CREATE TABLE IF NOT EXISTS ext_everhour_mission_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  everhour_task_id TEXT NOT NULL CHECK (length(trim(everhour_task_id)) > 0),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ext_everhour_mission_links_active
  ON ext_everhour_mission_links (workspace_id, mission_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ext_everhour_mission_links_workspace_task
  ON ext_everhour_mission_links (workspace_id, everhour_task_id);

CREATE INDEX IF NOT EXISTS idx_ext_everhour_mission_links_project_deleted
  ON ext_everhour_mission_links (project_id, deleted_at);

CREATE INDEX IF NOT EXISTS idx_ext_everhour_mission_links_mission_deleted
  ON ext_everhour_mission_links (mission_id, deleted_at);

INSERT OR IGNORE INTO ext_everhour_workspace_connections (
  id, workspace_id, api_key_secret, account_id, account_name, created_at, updated_at, revision
)
SELECT
  lower(hex(randomblob(16))),
  w.id,
  json_extract(w.settings_json, '$.everhourApiKey'),
  NULL,
  NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  1
FROM workspaces w
WHERE w.deleted_at IS NULL
  AND json_type(w.settings_json, '$.everhourApiKey') = 'text'
  AND length(trim(json_extract(w.settings_json, '$.everhourApiKey'))) > 0;

INSERT OR IGNORE INTO ext_everhour_project_links (
  id, workspace_id, project_id, everhour_project_id, everhour_project_name,
  everhour_section_id, created_at, updated_at, revision
)
SELECT
  lower(hex(randomblob(16))),
  p.workspace_id,
  p.id,
  json_extract(p.settings_json, '$."overlord.everhourProjectId"'),
  json_extract(p.settings_json, '$."overlord.everhourProjectName"'),
  json_extract(p.settings_json, '$."overlord.everhourSectionId"'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  1
FROM projects p
WHERE p.deleted_at IS NULL
  AND json_type(p.settings_json, '$."overlord.everhourProjectId"') = 'text'
  AND json_type(p.settings_json, '$."overlord.everhourProjectName"') = 'text'
  AND length(trim(json_extract(p.settings_json, '$."overlord.everhourProjectId"'))) > 0
  AND length(trim(json_extract(p.settings_json, '$."overlord.everhourProjectName"'))) > 0;

