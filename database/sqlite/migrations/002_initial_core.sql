-- Overlord SQLite core schema.
-- Contract: planning/feature-plans/09-database-schema-contract.md

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

BEGIN;

-- Organization -> workspace -> project hierarchy (coo:135). Workspaces remain
-- the sole RBAC layer; an organization is a grouping + identity shell above them.
-- See planning/feature-plans/organization-workspace-hierarchy.md.
CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  slug TEXT NOT NULL CHECK (length(trim(slug)) > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('local', 'hosted')),
  settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX idx_workspaces_organization_slug ON workspaces (organization_id, slug)
  WHERE deleted_at IS NULL;

CREATE TABLE profiles (
  id TEXT PRIMARY KEY REFERENCES "user" ("id") ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'service')),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  handle TEXT,
  email TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE INDEX idx_profiles_status ON profiles (status);
CREATE UNIQUE INDEX idx_profiles_handle_lower ON profiles (lower(handle)) WHERE handle IS NOT NULL;
CREATE UNIQUE INDEX idx_profiles_email_lower ON profiles (lower(email)) WHERE email IS NOT NULL;

-- The account username is stored as Better Auth `user.name` (set at sign-up
-- and updated when the user changes their username). profiles.handle
-- mirrors it and is not separately editable.
CREATE TRIGGER trg_better_auth_user_create_profile
AFTER INSERT ON "user"
FOR EACH ROW
BEGIN
  INSERT INTO profiles (
    id, kind, display_name, handle, email, status, metadata_json,
    created_at, updated_at, revision
  ) VALUES (
    NEW."id",
    'human',
    COALESCE(NULLIF(trim(NEW."name"), ''), NEW."email", 'User'),
    NULLIF(trim(NEW."name"), ''),
    NEW."email",
    'active',
    '{}',
    CASE
      WHEN NEW."createdAt" GLOB '????-??-??T??:??:??.???Z' THEN NEW."createdAt"
      ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    END,
    CASE
      WHEN NEW."updatedAt" GLOB '????-??-??T??:??:??.???Z' THEN NEW."updatedAt"
      ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    END,
    1
  );
END;

-- Keep the handle mirrored whenever the account username changes.
CREATE TRIGGER trg_better_auth_user_sync_profile_handle
AFTER UPDATE OF "name" ON "user"
FOR EACH ROW
WHEN NEW."name" IS NOT OLD."name"
BEGIN
  UPDATE profiles
     SET handle = NULLIF(trim(NEW."name"), ''),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         revision = revision + 1
   WHERE id = NEW."id"
     AND handle IS NOT NULLIF(trim(NEW."name"), '');
END;

-- Keep profiles.email mirrored from the authoritative Better Auth account email,
-- the same way profiles.handle mirrors the account name.
CREATE TRIGGER trg_better_auth_user_sync_profile_email
AFTER UPDATE OF "email" ON "user"
FOR EACH ROW
WHEN NEW."email" IS NOT OLD."email"
BEGIN
  UPDATE profiles
     SET email = NEW."email",
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         revision = revision + 1
   WHERE id = NEW."id"
     AND email IS NOT NEW."email";
END;

CREATE TABLE workspace_users (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  profile_id TEXT NOT NULL REFERENCES profiles (id) ON DELETE RESTRICT,
  member_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX idx_workspace_users_active_profile ON workspace_users (workspace_id, profile_id)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_workspace_users_active_member_key ON workspace_users (workspace_id, member_key)
  WHERE member_key IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_workspace_users_workspace_status ON workspace_users (workspace_id, status);
CREATE INDEX idx_workspace_users_profile_status ON workspace_users (profile_id, status);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  slug TEXT NOT NULL CHECK (length(trim(slug)) > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  description TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json)),
  created_by_workspace_user_id TEXT REFERENCES workspace_users (id) ON DELETE SET NULL,
  -- 1-based drag-and-drop ordering within a workspace (coo:132).
  position INTEGER CHECK (position IS NULL OR position >= 1),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX idx_projects_workspace_slug ON projects (workspace_id, slug)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_projects_workspace_id ON projects (workspace_id, id);
CREATE INDEX idx_projects_workspace_status_updated ON projects (workspace_id, status, updated_at);
CREATE UNIQUE INDEX idx_projects_workspace_position ON projects (workspace_id, position)
  WHERE deleted_at IS NULL;

CREATE TABLE workspace_statuses (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  key TEXT NOT NULL CHECK (length(trim(key)) > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0 AND name = trim(name)),
  type TEXT NOT NULL CHECK (type IN ('draft', 'execute', 'review', 'complete', 'blocked', 'cancelled')),
  position INTEGER NOT NULL CHECK (position >= 0),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  is_terminal INTEGER NOT NULL DEFAULT 0 CHECK (is_terminal IN (0, 1)),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX idx_workspace_statuses_workspace_key ON workspace_statuses (workspace_id, key);
CREATE UNIQUE INDEX idx_workspace_statuses_workspace_id ON workspace_statuses (workspace_id, id);
CREATE UNIQUE INDEX idx_workspace_statuses_active_name ON workspace_statuses (workspace_id, lower(name))
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_workspace_statuses_active_default ON workspace_statuses (workspace_id)
  WHERE is_default = 1 AND deleted_at IS NULL;
CREATE UNIQUE INDEX idx_workspace_statuses_active_execute ON workspace_statuses (workspace_id)
  WHERE type = 'execute' AND deleted_at IS NULL;
CREATE UNIQUE INDEX idx_workspace_statuses_active_review ON workspace_statuses (workspace_id)
  WHERE type = 'review' AND deleted_at IS NULL;

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  fingerprint TEXT NOT NULL CHECK (length(trim(fingerprint)) > 0),
  label TEXT NOT NULL CHECK (length(trim(label)) > 0),
  platform TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'missing')),
  last_seen_at TEXT CHECK (last_seen_at IS NULL OR last_seen_at GLOB '????-??-??T??:??:??.???Z'),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX idx_devices_workspace_fingerprint ON devices (workspace_id, fingerprint);

CREATE TABLE execution_targets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  device_id TEXT REFERENCES devices (id) ON DELETE SET NULL,
  owner_workspace_user_id TEXT REFERENCES workspace_users (id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('local', 'ssh')),
  label TEXT NOT NULL CHECK (length(trim(label)) > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'unavailable')),
  connection_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(connection_json)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CHECK (type <> 'local' OR device_id IS NOT NULL)
);

CREATE INDEX idx_execution_targets_workspace_type_status ON execution_targets (workspace_id, type, status);
CREATE INDEX idx_execution_targets_workspace_device ON execution_targets (workspace_id, device_id);

CREATE TABLE workspace_user_execution_targets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  workspace_user_id TEXT NOT NULL REFERENCES workspace_users (id) ON DELETE RESTRICT,
  execution_target_id TEXT NOT NULL REFERENCES execution_targets (id) ON DELETE RESTRICT,
  default_username TEXT,
  access_status TEXT NOT NULL CHECK (access_status IN ('active', 'pending', 'disabled', 'error')),
  last_connected_at TEXT CHECK (last_connected_at IS NULL OR last_connected_at GLOB '????-??-??T??:??:??.???Z'),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX idx_wuet_active_user_target ON workspace_user_execution_targets (workspace_user_id, execution_target_id)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_wuet_workspace_target_status ON workspace_user_execution_targets (workspace_id, execution_target_id, access_status);

CREATE TABLE user_execution_target_preferences (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (length(trim(target_type)) > 0),
  target_fingerprint TEXT NOT NULL CHECK (length(trim(target_fingerprint)) > 0),
  agent_configs_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(agent_configs_json)),
  terminal_profile_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(terminal_profile_json)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX idx_uetp_active_profile_target ON user_execution_target_preferences (profile_id, target_type, target_fingerprint)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_uetp_profile_type_updated ON user_execution_target_preferences (profile_id, target_type, updated_at);

CREATE TABLE project_resources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  execution_target_id TEXT REFERENCES execution_targets (id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('local_directory', 'remote_directory')),
  label TEXT,
  path TEXT NOT NULL CHECK (length(trim(path)) > 0),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('active', 'missing', 'archived')),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_project_resources_project_target_primary ON project_resources (project_id, execution_target_id, is_primary);
CREATE UNIQUE INDEX idx_project_resources_active_project_target_path ON project_resources (project_id, execution_target_id, path)
  WHERE deleted_at IS NULL;

CREATE TABLE project_user_preferences (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  workspace_user_id TEXT NOT NULL REFERENCES workspace_users (id) ON DELETE RESTRICT,
  preferences_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(preferences_json)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_project_user_preferences_active_project_user ON project_user_preferences (project_id, workspace_user_id)
  WHERE deleted_at IS NULL;

CREATE TABLE mission_sequences (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('workspace')),
  scope_id TEXT NOT NULL,
  counter_name TEXT NOT NULL CHECK (length(trim(counter_name)) > 0),
  next_value INTEGER NOT NULL CHECK (next_value >= 1),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z')
);

CREATE UNIQUE INDEX idx_mission_sequences_scope ON mission_sequences (workspace_id, scope_type, scope_id, counter_name);

-- Mission scheduling (coo:124): repeating schedules that compute a mission's due
-- date and, on completion, spawn a duplicate mission for the next occurrence.
-- See planning/feature-plans/mission-scheduling-engine.md.
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  name TEXT,
  period_type TEXT NOT NULL DEFAULT 'd' CHECK (period_type IN ('d', 'w', 'm')),
  period_interval INTEGER NOT NULL DEFAULT 1 CHECK (period_interval >= 1),
  weeks_of_month_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(weeks_of_month_json)),
  days_of_month_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(days_of_month_json)),
  days_of_week_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(days_of_week_json)),
  start_date TEXT CHECK (start_date IS NULL OR start_date GLOB '????-??-??T??:??:??.???Z'),
  timezone TEXT NOT NULL CHECK (length(trim(timezone)) > 0),
  -- Configurable duplicate target status. NULL falls back to the workspace
  -- default/next-up status at duplication time.
  next_status_id TEXT REFERENCES workspace_statuses (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (workspace_id, next_status_id) REFERENCES workspace_statuses (workspace_id, id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX idx_schedules_workspace_id ON schedules (workspace_id, id);
CREATE INDEX idx_schedules_workspace_next_status ON schedules (workspace_id, next_status_id);

CREATE TABLE missions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  display_id TEXT NOT NULL CHECK (length(trim(display_id)) > 0),
  sequence_number INTEGER NOT NULL CHECK (sequence_number >= 1),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  status_id TEXT NOT NULL REFERENCES workspace_statuses (id) ON DELETE RESTRICT,
  status_type TEXT NOT NULL CHECK (status_type IN ('draft', 'execute', 'review', 'complete', 'blocked', 'cancelled')),
  board_position INTEGER NOT NULL DEFAULT 0,
  priority TEXT CHECK (priority IS NULL OR priority IN ('low', 'normal', 'high', 'urgent')),
  constraints_text TEXT,
  acceptance_criteria_text TEXT,
  available_tools_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(available_tools_json)),
  output_format_text TEXT,
  execution_target_intent_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(execution_target_intent_json)),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  -- Branch automation (coo:16/coo:30/coo:9): active_branch is the branch the
  -- mission is currently operating on; branch_override is a one-shot user-pinned
  -- branch consumed at branch-preparation; worktree_preference is a persistent
  -- per-mission worktree/branch opt-in overriding the workspace setting.
  active_branch TEXT,
  branch_override TEXT,
  worktree_preference TEXT,
  -- Scheduling (coo:124): scoped by workspace_id in application code (SQLite
  -- ALTER TABLE precedent kept a plain FK here rather than a composite one).
  schedule_id TEXT REFERENCES schedules (id) ON DELETE SET NULL,
  due_datetime TEXT CHECK (due_datetime IS NULL OR due_datetime GLOB '????-??-??T??:??:??.???Z'),
  created_by_workspace_user_id TEXT REFERENCES workspace_users (id) ON DELETE SET NULL,
  assigned_workspace_user_id TEXT REFERENCES workspace_users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, status_id) REFERENCES workspace_statuses (workspace_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_missions_workspace_display_id ON missions (workspace_id, display_id);
CREATE UNIQUE INDEX idx_missions_workspace_sequence_number ON missions (workspace_id, sequence_number);
CREATE UNIQUE INDEX idx_missions_workspace_id ON missions (workspace_id, id);
CREATE UNIQUE INDEX idx_missions_project_id ON missions (project_id, id);
CREATE INDEX idx_missions_project_status_updated ON missions (project_id, status_type, updated_at);
CREATE INDEX idx_missions_project_status_board ON missions (project_id, status_id, board_position);
CREATE INDEX idx_missions_workspace_creator_updated ON missions (workspace_id, created_by_workspace_user_id, updated_at);
CREATE INDEX idx_missions_schedule_id ON missions (schedule_id) WHERE schedule_id IS NOT NULL;
CREATE INDEX idx_missions_project_due_datetime ON missions (project_id, due_datetime)
  WHERE due_datetime IS NOT NULL AND deleted_at IS NULL;

-- Personal My Missions ordering: per-operator, per-status-column drag order for
-- the My Missions selected-workspace view. Kept separate from
-- missions.board_position (the shared project board order) so a personal reorder
-- never reorders another user's view or a source project board. Sparse: one row
-- per mission the operator has dragged.
CREATE TABLE my_mission_positions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  workspace_user_id TEXT NOT NULL REFERENCES workspace_users (id) ON DELETE CASCADE,
  mission_id TEXT NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
  status_id TEXT NOT NULL REFERENCES workspace_statuses (id) ON DELETE CASCADE,
  position REAL NOT NULL,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  UNIQUE (workspace_id, workspace_user_id, mission_id),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES missions (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, status_id) REFERENCES workspace_statuses (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_my_mission_positions_user_status
  ON my_mission_positions (workspace_id, workspace_user_id, status_id, position);

CREATE TABLE objectives (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  mission_id TEXT NOT NULL REFERENCES missions (id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 0),
  title TEXT,
  instruction_text TEXT,
  state TEXT NOT NULL CHECK (state IN ('future', 'draft', 'submitted', 'launching', 'executing', 'pending_delivery', 'complete')),
  assigned_agent TEXT,
  model TEXT,
  reasoning_effort TEXT,
  agent_flags_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(agent_flags_json)),
  launch_config_json TEXT CHECK (launch_config_json IS NULL OR json_valid(launch_config_json)),
  -- The branch an objective actually ran on, written by the runner at
  -- branch-prepared time (coo:30).
  branch TEXT,
  auto_advance INTEGER NOT NULL DEFAULT 0 CHECK (auto_advance IN (0, 1)),
  approval_reason TEXT,
  auto_advanced_at TEXT CHECK (auto_advanced_at IS NULL OR auto_advanced_at GLOB '????-??-??T??:??:??.???Z'),
  completed_at TEXT CHECK (completed_at IS NULL OR completed_at GLOB '????-??-??T??:??:??.???Z'),
  execution_metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(execution_metadata_json)),
  created_by_workspace_user_id TEXT REFERENCES workspace_users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, mission_id) REFERENCES missions (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, mission_id) REFERENCES missions (project_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_objectives_active_mission_position ON objectives (mission_id, position)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_objectives_workspace_id ON objectives (workspace_id, id);
CREATE UNIQUE INDEX idx_objectives_project_id ON objectives (project_id, id);
CREATE UNIQUE INDEX idx_objectives_mission_id ON objectives (mission_id, id);
CREATE INDEX idx_objectives_project_state_updated ON objectives (project_id, state, updated_at);
CREATE INDEX idx_objectives_mission_state_position ON objectives (mission_id, state, position);

CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  mission_id TEXT NOT NULL REFERENCES missions (id) ON DELETE RESTRICT,
  objective_id TEXT NOT NULL REFERENCES objectives (id) ON DELETE RESTRICT,
  session_key_prefix TEXT NOT NULL CHECK (length(trim(session_key_prefix)) > 0),
  session_key_hash TEXT NOT NULL CHECK (length(trim(session_key_hash)) > 0),
  agent_identifier TEXT NOT NULL CHECK (length(trim(agent_identifier)) > 0),
  model_identifier TEXT,
  connection_method TEXT NOT NULL CHECK (length(trim(connection_method)) > 0),
  external_session_id TEXT,
  phase TEXT NOT NULL CHECK (phase IN ('attach', 'execute', 'review', 'complete', 'blocked')),
  delivery_state TEXT NOT NULL CHECK (delivery_state IN ('not_delivered', 'delivered', 'pending_redelivery')),
  started_at TEXT NOT NULL CHECK (started_at GLOB '????-??-??T??:??:??.???Z'),
  last_heartbeat_at TEXT CHECK (last_heartbeat_at IS NULL OR last_heartbeat_at GLOB '????-??-??T??:??:??.???Z'),
  ended_at TEXT CHECK (ended_at IS NULL OR ended_at GLOB '????-??-??T??:??:??.???Z'),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_by_workspace_user_id TEXT REFERENCES workspace_users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, mission_id) REFERENCES missions (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, objective_id) REFERENCES objectives (workspace_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_agent_sessions_workspace_session_key_prefix ON agent_sessions (workspace_id, session_key_prefix);
CREATE UNIQUE INDEX idx_agent_sessions_workspace_id ON agent_sessions (workspace_id, id);
CREATE INDEX idx_agent_sessions_objective_started ON agent_sessions (objective_id, started_at);
CREATE INDEX idx_agent_sessions_mission_started ON agent_sessions (mission_id, started_at);
CREATE INDEX idx_agent_sessions_external_session_id ON agent_sessions (external_session_id)
  WHERE external_session_id IS NOT NULL;

CREATE TABLE mission_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  mission_id TEXT NOT NULL REFERENCES missions (id) ON DELETE RESTRICT,
  objective_id TEXT REFERENCES objectives (id) ON DELETE SET NULL,
  session_id TEXT REFERENCES agent_sessions (id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('update', 'user_follow_up', 'alert', 'discussion_summary', 'decision', 'ask', 'permission_request', 'delivery', 'execution_requested', 'awaiting_approval', 'status_change')),
  phase TEXT,
  summary TEXT NOT NULL CHECK (length(trim(summary)) > 0),
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  external_url TEXT,
  source TEXT NOT NULL CHECK (length(trim(source)) > 0),
  actor_workspace_user_id TEXT REFERENCES workspace_users (id) ON DELETE SET NULL,
  actor_token_id TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, mission_id) REFERENCES missions (workspace_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_mission_events_mission_created ON mission_events (mission_id, created_at);
CREATE INDEX idx_mission_events_objective_created ON mission_events (objective_id, created_at);
CREATE UNIQUE INDEX idx_mission_events_idempotency ON mission_events (workspace_id, source, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE shared_context_entries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  mission_id TEXT NOT NULL REFERENCES missions (id) ON DELETE RESTRICT,
  objective_id TEXT REFERENCES objectives (id) ON DELETE SET NULL,
  key TEXT NOT NULL CHECK (length(trim(key)) > 0),
  value_kind TEXT NOT NULL CHECK (value_kind IN ('string', 'json')),
  value_text TEXT,
  value_json TEXT CHECK (value_json IS NULL OR json_valid(value_json)),
  created_by_session_id TEXT REFERENCES agent_sessions (id) ON DELETE SET NULL,
  created_by_workspace_user_id TEXT REFERENCES workspace_users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CHECK (
    (value_kind = 'string' AND value_text IS NOT NULL AND value_json IS NULL) OR
    (value_kind = 'json' AND value_text IS NULL AND value_json IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_shared_context_entries_active_mission_key ON shared_context_entries (mission_id, key)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_shared_context_entries_objective_updated ON shared_context_entries (objective_id, updated_at)
  WHERE objective_id IS NOT NULL;
CREATE INDEX idx_shared_context_entries_mission_updated ON shared_context_entries (mission_id, updated_at);

CREATE TABLE objective_attachments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  mission_id TEXT NOT NULL REFERENCES missions (id) ON DELETE RESTRICT,
  objective_id TEXT NOT NULL REFERENCES objectives (id) ON DELETE RESTRICT,
  storage_backend TEXT NOT NULL CHECK (length(trim(storage_backend)) > 0),
  storage_key TEXT NOT NULL CHECK (length(trim(storage_key)) > 0),
  filename TEXT NOT NULL CHECK (length(trim(filename)) > 0),
  content_type TEXT,
  size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
  checksum_sha256 TEXT,
  upload_status TEXT NOT NULL CHECK (upload_status IN ('prepared', 'uploaded', 'available', 'failed', 'deleted')),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_by_workspace_user_id TEXT REFERENCES workspace_users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE INDEX idx_objective_attachments_objective_created ON objective_attachments (objective_id, created_at);
CREATE INDEX idx_objective_attachments_mission_created ON objective_attachments (mission_id, created_at);

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  mission_id TEXT NOT NULL REFERENCES missions (id) ON DELETE RESTRICT,
  objective_id TEXT NOT NULL REFERENCES objectives (id) ON DELETE RESTRICT,
  session_id TEXT REFERENCES agent_sessions (id) ON DELETE SET NULL,
  summary TEXT NOT NULL CHECK (length(trim(summary)) > 0),
  verification_summary TEXT,
  follow_up_notes TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  delivered_by_workspace_user_id TEXT REFERENCES workspace_users (id) ON DELETE SET NULL,
  delivered_at TEXT NOT NULL CHECK (delivered_at GLOB '????-??-??T??:??:??.???Z'),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX idx_deliveries_workspace_id ON deliveries (workspace_id, id);
CREATE INDEX idx_deliveries_mission_delivered ON deliveries (mission_id, delivered_at);
CREATE INDEX idx_deliveries_objective_delivered ON deliveries (objective_id, delivered_at);
CREATE INDEX idx_deliveries_session ON deliveries (session_id);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  mission_id TEXT NOT NULL REFERENCES missions (id) ON DELETE RESTRICT,
  objective_id TEXT REFERENCES objectives (id) ON DELETE SET NULL,
  session_id TEXT REFERENCES agent_sessions (id) ON DELETE SET NULL,
  delivery_id TEXT REFERENCES deliveries (id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('test_results', 'next_steps', 'note', 'url', 'decision', 'migration')),
  label TEXT NOT NULL CHECK (length(trim(label)) > 0),
  content_text TEXT,
  content_json TEXT CHECK (content_json IS NULL OR json_valid(content_json)),
  external_url TEXT,
  created_by_workspace_user_id TEXT REFERENCES workspace_users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CHECK (content_text IS NOT NULL OR content_json IS NOT NULL OR external_url IS NOT NULL)
);

CREATE INDEX idx_artifacts_mission_created ON artifacts (mission_id, created_at);
CREATE INDEX idx_artifacts_delivery_type ON artifacts (delivery_id, type);

CREATE TABLE changed_files (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  mission_id TEXT NOT NULL REFERENCES missions (id) ON DELETE RESTRICT,
  objective_id TEXT NOT NULL REFERENCES objectives (id) ON DELETE RESTRICT,
  session_id TEXT REFERENCES agent_sessions (id) ON DELETE SET NULL,
  resource_id TEXT REFERENCES project_resources (id) ON DELETE SET NULL,
  file_path TEXT NOT NULL CHECK (length(trim(file_path)) > 0),
  vcs_status TEXT,
  current_diff_state TEXT NOT NULL CHECK (current_diff_state IN ('present', 'resolved', 'unknown', 'unavailable')),
  first_observed_at TEXT NOT NULL CHECK (first_observed_at GLOB '????-??-??T??:??:??.???Z'),
  last_observed_at TEXT NOT NULL CHECK (last_observed_at GLOB '????-??-??T??:??:??.???Z'),
  last_observed_event_id TEXT REFERENCES mission_events (id) ON DELETE SET NULL,
  observed_metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(observed_metadata_json)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX idx_changed_files_active_session_objective_path ON changed_files (session_id, objective_id, file_path)
  WHERE session_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_changed_files_mission_objective_path ON changed_files (mission_id, objective_id, file_path);
CREATE INDEX idx_changed_files_project_updated ON changed_files (project_id, updated_at);

CREATE TABLE change_rationales (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  mission_id TEXT NOT NULL REFERENCES missions (id) ON DELETE RESTRICT,
  objective_id TEXT NOT NULL REFERENCES objectives (id) ON DELETE RESTRICT,
  session_id TEXT REFERENCES agent_sessions (id) ON DELETE SET NULL,
  delivery_id TEXT REFERENCES deliveries (id) ON DELETE SET NULL,
  changed_file_id TEXT REFERENCES changed_files (id) ON DELETE SET NULL,
  file_path TEXT NOT NULL CHECK (length(trim(file_path)) > 0),
  label TEXT NOT NULL CHECK (length(trim(label)) > 0),
  summary TEXT NOT NULL CHECK (length(trim(summary)) > 0),
  why TEXT NOT NULL CHECK (length(trim(why)) > 0),
  impact TEXT NOT NULL CHECK (length(trim(impact)) > 0),
  hunks_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(hunks_json)),
  source_event_id TEXT REFERENCES mission_events (id) ON DELETE SET NULL,
  is_final INTEGER NOT NULL DEFAULT 0 CHECK (is_final IN (0, 1)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE INDEX idx_change_rationales_mission_objective_path ON change_rationales (mission_id, objective_id, file_path);
CREATE INDEX idx_change_rationales_delivery_path ON change_rationales (delivery_id, file_path);
CREATE UNIQUE INDEX idx_change_rationales_active_final_delivery_path ON change_rationales (delivery_id, file_path)
  WHERE is_final = 1 AND delivery_id IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE execution_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  mission_id TEXT NOT NULL REFERENCES missions (id) ON DELETE RESTRICT,
  objective_id TEXT NOT NULL REFERENCES objectives (id) ON DELETE RESTRICT,
  execution_target_id TEXT REFERENCES execution_targets (id) ON DELETE SET NULL,
  requested_agent TEXT,
  requested_model TEXT,
  requested_reasoning_effort TEXT,
  launch_mode TEXT NOT NULL CHECK (launch_mode IN ('run', 'ask')),
  launch_flags_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(launch_flags_json)),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('any', 'local', 'ssh')),
  requested_source TEXT NOT NULL CHECK (length(trim(requested_source)) > 0),
  idempotency_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'launching', 'launched', 'failed', 'cleared', 'cancelled', 'expired')),
  requested_by_workspace_user_id TEXT REFERENCES workspace_users (id) ON DELETE SET NULL,
  claimed_by_device_id TEXT REFERENCES devices (id) ON DELETE SET NULL,
  claimed_by_execution_target_id TEXT REFERENCES execution_targets (id) ON DELETE SET NULL,
  claimed_at TEXT CHECK (claimed_at IS NULL OR claimed_at GLOB '????-??-??T??:??:??.???Z'),
  claim_expires_at TEXT CHECK (claim_expires_at IS NULL OR claim_expires_at GLOB '????-??-??T??:??:??.???Z'),
  launch_started_at TEXT CHECK (launch_started_at IS NULL OR launch_started_at GLOB '????-??-??T??:??:??.???Z'),
  launch_completed_at TEXT CHECK (launch_completed_at IS NULL OR launch_completed_at GLOB '????-??-??T??:??:??.???Z'),
  launched_session_id TEXT REFERENCES agent_sessions (id) ON DELETE SET NULL,
  resolved_resource_id TEXT REFERENCES project_resources (id) ON DELETE SET NULL,
  resolved_working_directory TEXT,
  last_error TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CHECK (requested_source <> 'auto_advance' OR idempotency_key IS NOT NULL)
);

CREATE INDEX idx_execution_requests_workspace_status_created ON execution_requests (workspace_id, status, created_at);
CREATE INDEX idx_execution_requests_project_status_created ON execution_requests (project_id, status, created_at);
CREATE INDEX idx_execution_requests_objective_status ON execution_requests (objective_id, status);
CREATE UNIQUE INDEX idx_execution_requests_workspace_idempotency ON execution_requests (workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE idempotency_keys (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  scope TEXT NOT NULL CHECK (length(trim(scope)) > 0),
  key TEXT NOT NULL CHECK (length(trim(key)) > 0),
  request_hash TEXT NOT NULL CHECK (length(trim(request_hash)) > 0),
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed')),
  actor_workspace_user_id TEXT REFERENCES workspace_users (id) ON DELETE SET NULL,
  expires_at TEXT NOT NULL CHECK (expires_at GLOB '????-??-??T??:??:??.???Z'),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z')
);

CREATE UNIQUE INDEX idx_idempotency_keys_workspace_scope_key ON idempotency_keys (workspace_id, scope, key);
CREATE INDEX idx_idempotency_keys_expires_at ON idempotency_keys (expires_at);

CREATE TABLE entity_changes (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects (id) ON DELETE SET NULL,
  mission_id TEXT REFERENCES missions (id) ON DELETE SET NULL,
  objective_id TEXT REFERENCES objectives (id) ON DELETE SET NULL,
  entity_type TEXT NOT NULL CHECK (length(trim(entity_type)) > 0),
  entity_id TEXT NOT NULL CHECK (length(trim(entity_id)) > 0),
  operation TEXT NOT NULL CHECK (operation IN ('insert', 'update', 'delete', 'restore')),
  entity_revision INTEGER CHECK (entity_revision IS NULL OR entity_revision >= 1),
  changed_fields_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(changed_fields_json)),
  actor_workspace_user_id TEXT REFERENCES workspace_users (id) ON DELETE SET NULL,
  actor_token_id TEXT,
  source TEXT NOT NULL CHECK (length(trim(source)) > 0),
  occurred_at TEXT NOT NULL CHECK (occurred_at GLOB '????-??-??T??:??:??.???Z')
);

CREATE INDEX idx_entity_changes_workspace_seq ON entity_changes (workspace_id, seq);
CREATE INDEX idx_entity_changes_project_seq ON entity_changes (project_id, seq);
CREATE INDEX idx_entity_changes_mission_seq ON entity_changes (mission_id, seq);
CREATE INDEX idx_entity_changes_entity_seq ON entity_changes (entity_type, entity_id, seq);

-- ---------------------------------------------------------------------------
-- Project-scoped mission tags (project_tags definitions + mission_tags join).
-- ---------------------------------------------------------------------------
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

CREATE TABLE mission_tags (
  mission_id TEXT NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES project_tags (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  PRIMARY KEY (mission_id, tag_id)
);

CREATE INDEX idx_mission_tags_tag ON mission_tags (tag_id);

-- ---------------------------------------------------------------------------
-- Client-reported observations per execution target (WS-F4 / WS-F6).
-- ---------------------------------------------------------------------------
CREATE TABLE target_resource_observations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  execution_target_id TEXT NOT NULL REFERENCES execution_targets (id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES project_resources (id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  git_root TEXT,
  branch TEXT,
  git_commit TEXT,
  observed_at TEXT NOT NULL CHECK (observed_at GLOB '????-??-??T??:??:??.???Z'),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE RESTRICT,
  FOREIGN KEY (execution_target_id) REFERENCES execution_targets (id) ON DELETE CASCADE,
  FOREIGN KEY (resource_id) REFERENCES project_resources (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_target_resource_observations_target_resource
  ON target_resource_observations (execution_target_id, resource_id);
CREATE INDEX idx_target_resource_observations_resource
  ON target_resource_observations (resource_id);

CREATE TABLE mission_branch_observations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  execution_target_id TEXT NOT NULL REFERENCES execution_targets (id) ON DELETE CASCADE,
  mission_id TEXT NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('created', 'published', 'merged_unpushed', 'merged')),
  dirty INTEGER NOT NULL CHECK (dirty IN (0, 1)),
  worktree_path TEXT,
  observed_at TEXT NOT NULL CHECK (observed_at GLOB '????-??-??T??:??:??.???Z'),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE RESTRICT,
  FOREIGN KEY (execution_target_id) REFERENCES execution_targets (id) ON DELETE CASCADE,
  FOREIGN KEY (mission_id) REFERENCES missions (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_mission_branch_observations_target_mission
  ON mission_branch_observations (execution_target_id, mission_id);
CREATE INDEX idx_mission_branch_observations_mission
  ON mission_branch_observations (mission_id);

-- ---------------------------------------------------------------------------
-- Workspace member invitations (single-use hashed tokens, mirroring user_tokens).
-- ---------------------------------------------------------------------------
CREATE TABLE workspace_invitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  email TEXT NOT NULL CHECK (length(trim(email)) > 0),
  role_key TEXT NOT NULL DEFAULT 'MEMBER' CHECK (length(trim(role_key)) > 0),
  token_prefix TEXT NOT NULL CHECK (length(trim(token_prefix)) > 0),
  token_hash TEXT NOT NULL CHECK (length(trim(token_hash)) > 0),
  hash_algorithm TEXT NOT NULL CHECK (length(trim(hash_algorithm)) > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  invited_by_workspace_user_id TEXT NOT NULL REFERENCES workspace_users (id) ON DELETE RESTRICT,
  accepted_by_workspace_user_id TEXT REFERENCES workspace_users (id) ON DELETE SET NULL,
  expires_at TEXT NOT NULL CHECK (expires_at GLOB '????-??-??T??:??:??.???Z'),
  accepted_at TEXT CHECK (accepted_at IS NULL OR accepted_at GLOB '????-??-??T??:??:??.???Z'),
  revoked_at TEXT CHECK (revoked_at IS NULL OR revoked_at GLOB '????-??-??T??:??:??.???Z'),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX idx_workspace_invitations_workspace_email_pending
  ON workspace_invitations (workspace_id, email)
  WHERE status = 'pending' AND deleted_at IS NULL;
CREATE UNIQUE INDEX idx_workspace_invitations_workspace_prefix
  ON workspace_invitations (workspace_id, token_prefix);
CREATE INDEX idx_workspace_invitations_workspace_status
  ON workspace_invitations (workspace_id, status);

-- ---------------------------------------------------------------------------
-- Mission-data webhooks/API (coo:115): outbox_messages durable effect queue and
-- its first consumer, a workspace-scoped webhook subscription system.
-- ---------------------------------------------------------------------------
CREATE TABLE outbox_messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  topic TEXT NOT NULL CHECK (length(trim(topic)) > 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'cancelled')),
  available_at TEXT NOT NULL CHECK (available_at GLOB '????-??-??T??:??:??.???Z'),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z')
);

CREATE INDEX idx_outbox_messages_workspace_status_available ON outbox_messages
  (workspace_id, status, available_at);
CREATE INDEX idx_outbox_messages_topic_created ON outbox_messages (topic, created_at);

CREATE TABLE webhook_subscriptions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects (id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  endpoint_url TEXT NOT NULL CHECK (length(trim(endpoint_url)) > 0),
  secret TEXT NOT NULL CHECK (length(trim(secret)) > 0),
  event_types_json TEXT NOT NULL CHECK (json_valid(event_types_json)),
  payload_mode TEXT NOT NULL DEFAULT 'thin' CHECK (payload_mode IN ('thin', 'full')),
  created_by_workspace_user_id TEXT NOT NULL REFERENCES workspace_users (id) ON DELETE RESTRICT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  disabled_reason TEXT CHECK (disabled_reason IS NULL OR disabled_reason IN ('manual', 'failures', 'owner_revoked')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_success_at TEXT CHECK (last_success_at IS NULL OR last_success_at GLOB '????-??-??T??:??:??.???Z'),
  last_failure_at TEXT CHECK (last_failure_at IS NULL OR last_failure_at GLOB '????-??-??T??:??:??.???Z'),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id) ON DELETE SET NULL
);

CREATE INDEX idx_webhook_subscriptions_workspace_enabled ON webhook_subscriptions (workspace_id, enabled)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_webhook_subscriptions_workspace_project ON webhook_subscriptions (workspace_id, project_id)
  WHERE deleted_at IS NULL;

CREATE TABLE webhook_delivery_attempts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  subscription_id TEXT NOT NULL REFERENCES webhook_subscriptions (id) ON DELETE RESTRICT,
  outbox_message_id TEXT NOT NULL REFERENCES outbox_messages (id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  response_status INTEGER,
  response_snippet TEXT,
  error TEXT,
  duration_ms INTEGER,
  attempted_at TEXT NOT NULL CHECK (attempted_at GLOB '????-??-??T??:??:??.???Z')
);

CREATE INDEX idx_webhook_delivery_attempts_subscription_attempted ON webhook_delivery_attempts
  (subscription_id, attempted_at);
CREATE INDEX idx_webhook_delivery_attempts_outbox_message ON webhook_delivery_attempts (outbox_message_id);

-- ---------------------------------------------------------------------------
-- Mission search: portable indexing table + FTS5 full-text index + sync triggers.
-- ---------------------------------------------------------------------------
CREATE TABLE search_documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects (id) ON DELETE SET NULL,
  mission_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('mission', 'objective', 'event')),
  entity_id TEXT NOT NULL,
  title TEXT,
  body_text TEXT NOT NULL,
  content_hash TEXT,
  source_revision INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  indexed_at TEXT NOT NULL CHECK (indexed_at GLOB '????-??-??T??:??:??.???Z')
);

CREATE UNIQUE INDEX idx_search_documents_entity ON search_documents (workspace_id, entity_type, entity_id);
CREATE INDEX idx_search_documents_workspace_project_type ON search_documents (workspace_id, project_id, entity_type);
CREATE INDEX idx_search_documents_mission ON search_documents (mission_id);

CREATE VIRTUAL TABLE search_documents_fts USING fts5(
  title,
  body_text,
  mission_id UNINDEXED,
  entity_type UNINDEXED,
  content = 'search_documents',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER trg_search_documents_fts_ai AFTER INSERT ON search_documents BEGIN
  INSERT INTO search_documents_fts (rowid, title, body_text, mission_id, entity_type)
  VALUES (new.rowid, new.title, new.body_text, new.mission_id, new.entity_type);
END;

CREATE TRIGGER trg_search_documents_fts_ad AFTER DELETE ON search_documents BEGIN
  INSERT INTO search_documents_fts (search_documents_fts, rowid, title, body_text, mission_id, entity_type)
  VALUES ('delete', old.rowid, old.title, old.body_text, old.mission_id, old.entity_type);
END;

CREATE TRIGGER trg_search_documents_fts_au AFTER UPDATE ON search_documents BEGIN
  INSERT INTO search_documents_fts (search_documents_fts, rowid, title, body_text, mission_id, entity_type)
  VALUES ('delete', old.rowid, old.title, old.body_text, old.mission_id, old.entity_type);
  INSERT INTO search_documents_fts (rowid, title, body_text, mission_id, entity_type)
  VALUES (new.rowid, new.title, new.body_text, new.mission_id, new.entity_type);
END;

CREATE TRIGGER trg_search_missions_ai AFTER INSERT ON missions
WHEN new.deleted_at IS NULL
BEGIN
  INSERT INTO search_documents (
    id, workspace_id, project_id, mission_id, entity_type, entity_id,
    title, body_text, source_revision, indexed_at
  ) VALUES (
    lower(hex(randomblob(16))), new.workspace_id, new.project_id, new.id, 'mission', new.id,
    new.title, new.title || ' ' || new.display_id, new.revision,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  ON CONFLICT (workspace_id, entity_type, entity_id) DO UPDATE SET
    project_id = excluded.project_id,
    mission_id = excluded.mission_id,
    title = excluded.title,
    body_text = excluded.body_text,
    source_revision = excluded.source_revision,
    indexed_at = excluded.indexed_at;
END;

CREATE TRIGGER trg_search_missions_au AFTER UPDATE ON missions
WHEN new.deleted_at IS NULL
BEGIN
  INSERT INTO search_documents (
    id, workspace_id, project_id, mission_id, entity_type, entity_id,
    title, body_text, source_revision, indexed_at
  ) VALUES (
    lower(hex(randomblob(16))), new.workspace_id, new.project_id, new.id, 'mission', new.id,
    new.title, new.title || ' ' || new.display_id, new.revision,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  ON CONFLICT (workspace_id, entity_type, entity_id) DO UPDATE SET
    project_id = excluded.project_id,
    mission_id = excluded.mission_id,
    title = excluded.title,
    body_text = excluded.body_text,
    source_revision = excluded.source_revision,
    indexed_at = excluded.indexed_at;
END;

CREATE TRIGGER trg_search_missions_soft_delete AFTER UPDATE ON missions
WHEN new.deleted_at IS NOT NULL AND old.deleted_at IS NULL
BEGIN
  DELETE FROM search_documents WHERE workspace_id = new.workspace_id AND mission_id = new.id;
END;

CREATE TRIGGER trg_search_missions_ad AFTER DELETE ON missions BEGIN
  DELETE FROM search_documents WHERE workspace_id = old.workspace_id AND mission_id = old.id;
END;

CREATE TRIGGER trg_search_objectives_ai AFTER INSERT ON objectives
WHEN new.deleted_at IS NULL
BEGIN
  INSERT INTO search_documents (
    id, workspace_id, project_id, mission_id, entity_type, entity_id,
    title, body_text, source_revision, indexed_at
  ) VALUES (
    lower(hex(randomblob(16))), new.workspace_id, new.project_id, new.mission_id, 'objective', new.id,
    new.title, trim(coalesce(new.title, '') || ' ' || coalesce(new.instruction_text, '')), new.revision,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  ON CONFLICT (workspace_id, entity_type, entity_id) DO UPDATE SET
    project_id = excluded.project_id,
    mission_id = excluded.mission_id,
    title = excluded.title,
    body_text = excluded.body_text,
    source_revision = excluded.source_revision,
    indexed_at = excluded.indexed_at;
END;

CREATE TRIGGER trg_search_objectives_au AFTER UPDATE ON objectives
WHEN new.deleted_at IS NULL
BEGIN
  INSERT INTO search_documents (
    id, workspace_id, project_id, mission_id, entity_type, entity_id,
    title, body_text, source_revision, indexed_at
  ) VALUES (
    lower(hex(randomblob(16))), new.workspace_id, new.project_id, new.mission_id, 'objective', new.id,
    new.title, trim(coalesce(new.title, '') || ' ' || coalesce(new.instruction_text, '')), new.revision,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  ON CONFLICT (workspace_id, entity_type, entity_id) DO UPDATE SET
    project_id = excluded.project_id,
    mission_id = excluded.mission_id,
    title = excluded.title,
    body_text = excluded.body_text,
    source_revision = excluded.source_revision,
    indexed_at = excluded.indexed_at;
END;

CREATE TRIGGER trg_search_objectives_soft_delete AFTER UPDATE ON objectives
WHEN new.deleted_at IS NOT NULL AND old.deleted_at IS NULL
BEGIN
  DELETE FROM search_documents
  WHERE workspace_id = new.workspace_id AND entity_type = 'objective' AND entity_id = new.id;
END;

CREATE TRIGGER trg_search_objectives_ad AFTER DELETE ON objectives BEGIN
  DELETE FROM search_documents
  WHERE workspace_id = old.workspace_id AND entity_type = 'objective' AND entity_id = old.id;
END;

CREATE TRIGGER trg_search_events_ai AFTER INSERT ON mission_events BEGIN
  INSERT INTO search_documents (
    id, workspace_id, project_id, mission_id, entity_type, entity_id,
    title, body_text, indexed_at
  ) VALUES (
    lower(hex(randomblob(16))), new.workspace_id, new.project_id, new.mission_id, 'event', new.id,
    NULL, new.summary,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  ON CONFLICT (workspace_id, entity_type, entity_id) DO UPDATE SET
    project_id = excluded.project_id,
    mission_id = excluded.mission_id,
    body_text = excluded.body_text,
    indexed_at = excluded.indexed_at;
END;

CREATE TRIGGER trg_search_events_ad AFTER DELETE ON mission_events BEGIN
  DELETE FROM search_documents
  WHERE workspace_id = old.workspace_id AND entity_type = 'event' AND entity_id = old.id;
END;

CREATE TABLE schema_migrations (
  version TEXT NOT NULL,
  adapter TEXT NOT NULL CHECK (adapter IN ('sqlite')),
  component TEXT NOT NULL CHECK (length(trim(component)) > 0),
  contract_version TEXT NOT NULL CHECK (length(trim(contract_version)) > 0),
  checksum TEXT NOT NULL CHECK (length(trim(checksum)) > 0),
  applied_at TEXT NOT NULL CHECK (applied_at GLOB '????-??-??T??:??:??.???Z'),
  PRIMARY KEY (adapter, component, version)
);

COMMIT;
