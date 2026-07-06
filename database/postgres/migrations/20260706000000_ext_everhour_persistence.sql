CREATE TABLE IF NOT EXISTS ext_everhour_workspace_connections (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  api_key_secret text NOT NULL CHECK (char_length(btrim(api_key_secret)) > 0),
  account_id text,
  account_name text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ext_everhour_workspace_connections_active
  ON ext_everhour_workspace_connections (workspace_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ext_everhour_workspace_connections_workspace_deleted
  ON ext_everhour_workspace_connections (workspace_id, deleted_at);

CREATE TABLE IF NOT EXISTS ext_everhour_project_links (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  everhour_project_id text NOT NULL CHECK (char_length(btrim(everhour_project_id)) > 0),
  everhour_project_name text NOT NULL CHECK (char_length(btrim(everhour_project_name)) > 0),
  everhour_section_id text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
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
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  mission_id text NOT NULL,
  everhour_task_id text NOT NULL CHECK (char_length(btrim(everhour_task_id)) > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
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

INSERT INTO ext_everhour_workspace_connections (
  id, workspace_id, api_key_secret, account_id, account_name, created_at, updated_at, revision
)
SELECT
  gen_random_uuid()::text,
  w.id,
  w.settings_json ->> 'everhourApiKey',
  NULL,
  NULL,
  now(),
  now(),
  1
FROM workspaces w
WHERE w.deleted_at IS NULL
  AND jsonb_typeof(w.settings_json -> 'everhourApiKey') = 'string'
  AND char_length(btrim(w.settings_json ->> 'everhourApiKey')) > 0
ON CONFLICT DO NOTHING;

INSERT INTO ext_everhour_project_links (
  id, workspace_id, project_id, everhour_project_id, everhour_project_name,
  everhour_section_id, created_at, updated_at, revision
)
SELECT
  gen_random_uuid()::text,
  p.workspace_id,
  p.id,
  p.settings_json ->> 'overlord.everhourProjectId',
  p.settings_json ->> 'overlord.everhourProjectName',
  p.settings_json ->> 'overlord.everhourSectionId',
  now(),
  now(),
  1
FROM projects p
WHERE p.deleted_at IS NULL
  AND jsonb_typeof(p.settings_json -> 'overlord.everhourProjectId') = 'string'
  AND jsonb_typeof(p.settings_json -> 'overlord.everhourProjectName') = 'string'
  AND char_length(btrim(p.settings_json ->> 'overlord.everhourProjectId')) > 0
  AND char_length(btrim(p.settings_json ->> 'overlord.everhourProjectName')) > 0
ON CONFLICT DO NOTHING;

INSERT INTO ext_everhour_mission_links (
  id, workspace_id, project_id, mission_id, everhour_task_id, created_at, updated_at, revision
)
SELECT
  gen_random_uuid()::text,
  m.workspace_id,
  m.project_id,
  m.id,
  m.everhour_task_id,
  now(),
  now(),
  1
FROM missions m
WHERE m.deleted_at IS NULL
  AND m.everhour_task_id IS NOT NULL
  AND char_length(btrim(m.everhour_task_id)) > 0
ON CONFLICT DO NOTHING;

ALTER TABLE missions DROP COLUMN IF EXISTS everhour_task_id;
