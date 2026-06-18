-- Overlord SQLite core schema.
-- Contract: planning/feature-plans/09-database-schema-contract.md

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

BEGIN;

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL CHECK (length(trim(slug)) > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('local', 'hosted')),
  settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX idx_workspaces_slug ON workspaces (slug);

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
    NULL,
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
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX idx_projects_workspace_slug ON projects (workspace_id, slug)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_projects_workspace_id ON projects (workspace_id, id);
CREATE INDEX idx_projects_workspace_status_updated ON projects (workspace_id, status, updated_at);

CREATE TABLE project_statuses (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  key TEXT NOT NULL CHECK (length(trim(key)) > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  type TEXT NOT NULL CHECK (type IN ('draft', 'execute', 'review', 'complete', 'blocked', 'cancelled')),
  position INTEGER NOT NULL CHECK (position >= 0),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  is_terminal INTEGER NOT NULL DEFAULT 0 CHECK (is_terminal IN (0, 1)),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_project_statuses_project_key ON project_statuses (project_id, key);
CREATE UNIQUE INDEX idx_project_statuses_project_id ON project_statuses (project_id, id);
CREATE UNIQUE INDEX idx_project_statuses_active_default ON project_statuses (project_id)
  WHERE is_default = 1 AND deleted_at IS NULL;
CREATE UNIQUE INDEX idx_project_statuses_active_execute ON project_statuses (project_id)
  WHERE type = 'execute' AND deleted_at IS NULL;
CREATE UNIQUE INDEX idx_project_statuses_active_review ON project_statuses (project_id)
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

CREATE TABLE ticket_sequences (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('workspace')),
  scope_id TEXT NOT NULL,
  counter_name TEXT NOT NULL CHECK (length(trim(counter_name)) > 0),
  next_value INTEGER NOT NULL CHECK (next_value >= 1),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z')
);

CREATE UNIQUE INDEX idx_ticket_sequences_scope ON ticket_sequences (workspace_id, scope_type, scope_id, counter_name);

CREATE TABLE tickets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  display_id TEXT NOT NULL CHECK (length(trim(display_id)) > 0),
  sequence_number INTEGER NOT NULL CHECK (sequence_number >= 1),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  status_id TEXT NOT NULL REFERENCES project_statuses (id) ON DELETE RESTRICT,
  status_type TEXT NOT NULL CHECK (status_type IN ('draft', 'execute', 'review', 'complete', 'blocked', 'cancelled')),
  board_position INTEGER NOT NULL DEFAULT 0,
  priority TEXT CHECK (priority IS NULL OR priority IN ('low', 'normal', 'high', 'urgent')),
  constraints_text TEXT,
  acceptance_criteria_text TEXT,
  available_tools_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(available_tools_json)),
  output_format_text TEXT,
  execution_target_intent_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(execution_target_intent_json)),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_by_workspace_user_id TEXT REFERENCES workspace_users (id) ON DELETE SET NULL,
  assigned_workspace_user_id TEXT REFERENCES workspace_users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_tickets_workspace_display_id ON tickets (workspace_id, display_id);
CREATE UNIQUE INDEX idx_tickets_workspace_sequence_number ON tickets (workspace_id, sequence_number);
CREATE UNIQUE INDEX idx_tickets_workspace_id ON tickets (workspace_id, id);
CREATE UNIQUE INDEX idx_tickets_project_id ON tickets (project_id, id);
CREATE INDEX idx_tickets_project_status_updated ON tickets (project_id, status_type, updated_at);
CREATE INDEX idx_tickets_project_status_board ON tickets (project_id, status_id, board_position);
CREATE INDEX idx_tickets_workspace_creator_updated ON tickets (workspace_id, created_by_workspace_user_id, updated_at);

CREATE TABLE objectives (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  ticket_id TEXT NOT NULL REFERENCES tickets (id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 0),
  title TEXT,
  instruction_text TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('future', 'draft', 'submitted', 'launching', 'executing', 'pending_delivery', 'complete')),
  assigned_agent TEXT,
  model TEXT,
  reasoning_effort TEXT,
  agent_flags_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(agent_flags_json)),
  launch_config_json TEXT CHECK (launch_config_json IS NULL OR json_valid(launch_config_json)),
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
  FOREIGN KEY (workspace_id, ticket_id) REFERENCES tickets (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, ticket_id) REFERENCES tickets (project_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_objectives_active_ticket_position ON objectives (ticket_id, position)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_objectives_workspace_id ON objectives (workspace_id, id);
CREATE UNIQUE INDEX idx_objectives_project_id ON objectives (project_id, id);
CREATE UNIQUE INDEX idx_objectives_ticket_id ON objectives (ticket_id, id);
CREATE INDEX idx_objectives_project_state_updated ON objectives (project_id, state, updated_at);
CREATE INDEX idx_objectives_ticket_state_position ON objectives (ticket_id, state, position);

CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  ticket_id TEXT NOT NULL REFERENCES tickets (id) ON DELETE RESTRICT,
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
  FOREIGN KEY (workspace_id, ticket_id) REFERENCES tickets (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, objective_id) REFERENCES objectives (workspace_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_agent_sessions_workspace_session_key_prefix ON agent_sessions (workspace_id, session_key_prefix);
CREATE UNIQUE INDEX idx_agent_sessions_workspace_id ON agent_sessions (workspace_id, id);
CREATE INDEX idx_agent_sessions_objective_started ON agent_sessions (objective_id, started_at);
CREATE INDEX idx_agent_sessions_ticket_started ON agent_sessions (ticket_id, started_at);
CREATE INDEX idx_agent_sessions_external_session_id ON agent_sessions (external_session_id)
  WHERE external_session_id IS NOT NULL;

CREATE TABLE ticket_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  ticket_id TEXT NOT NULL REFERENCES tickets (id) ON DELETE RESTRICT,
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
  FOREIGN KEY (workspace_id, ticket_id) REFERENCES tickets (workspace_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_ticket_events_ticket_created ON ticket_events (ticket_id, created_at);
CREATE INDEX idx_ticket_events_objective_created ON ticket_events (objective_id, created_at);
CREATE UNIQUE INDEX idx_ticket_events_idempotency ON ticket_events (workspace_id, source, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE shared_context_entries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  ticket_id TEXT NOT NULL REFERENCES tickets (id) ON DELETE RESTRICT,
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

CREATE UNIQUE INDEX idx_shared_context_entries_active_ticket_key ON shared_context_entries (ticket_id, key)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_shared_context_entries_objective_updated ON shared_context_entries (objective_id, updated_at)
  WHERE objective_id IS NOT NULL;
CREATE INDEX idx_shared_context_entries_ticket_updated ON shared_context_entries (ticket_id, updated_at);

CREATE TABLE objective_attachments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  ticket_id TEXT NOT NULL REFERENCES tickets (id) ON DELETE RESTRICT,
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
CREATE INDEX idx_objective_attachments_ticket_created ON objective_attachments (ticket_id, created_at);

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  ticket_id TEXT NOT NULL REFERENCES tickets (id) ON DELETE RESTRICT,
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
CREATE INDEX idx_deliveries_ticket_delivered ON deliveries (ticket_id, delivered_at);
CREATE INDEX idx_deliveries_objective_delivered ON deliveries (objective_id, delivered_at);
CREATE INDEX idx_deliveries_session ON deliveries (session_id);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  ticket_id TEXT NOT NULL REFERENCES tickets (id) ON DELETE RESTRICT,
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

CREATE INDEX idx_artifacts_ticket_created ON artifacts (ticket_id, created_at);
CREATE INDEX idx_artifacts_delivery_type ON artifacts (delivery_id, type);

CREATE TABLE changed_files (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  ticket_id TEXT NOT NULL REFERENCES tickets (id) ON DELETE RESTRICT,
  objective_id TEXT NOT NULL REFERENCES objectives (id) ON DELETE RESTRICT,
  session_id TEXT REFERENCES agent_sessions (id) ON DELETE SET NULL,
  resource_id TEXT REFERENCES project_resources (id) ON DELETE SET NULL,
  file_path TEXT NOT NULL CHECK (length(trim(file_path)) > 0),
  vcs_status TEXT,
  current_diff_state TEXT NOT NULL CHECK (current_diff_state IN ('present', 'resolved', 'unknown', 'unavailable')),
  first_observed_at TEXT NOT NULL CHECK (first_observed_at GLOB '????-??-??T??:??:??.???Z'),
  last_observed_at TEXT NOT NULL CHECK (last_observed_at GLOB '????-??-??T??:??:??.???Z'),
  last_observed_event_id TEXT REFERENCES ticket_events (id) ON DELETE SET NULL,
  observed_metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(observed_metadata_json)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX idx_changed_files_active_session_objective_path ON changed_files (session_id, objective_id, file_path)
  WHERE session_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_changed_files_ticket_objective_path ON changed_files (ticket_id, objective_id, file_path);
CREATE INDEX idx_changed_files_project_updated ON changed_files (project_id, updated_at);

CREATE TABLE change_rationales (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  ticket_id TEXT NOT NULL REFERENCES tickets (id) ON DELETE RESTRICT,
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
  source_event_id TEXT REFERENCES ticket_events (id) ON DELETE SET NULL,
  is_final INTEGER NOT NULL DEFAULT 0 CHECK (is_final IN (0, 1)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE INDEX idx_change_rationales_ticket_objective_path ON change_rationales (ticket_id, objective_id, file_path);
CREATE INDEX idx_change_rationales_delivery_path ON change_rationales (delivery_id, file_path);
CREATE UNIQUE INDEX idx_change_rationales_active_final_delivery_path ON change_rationales (delivery_id, file_path)
  WHERE is_final = 1 AND delivery_id IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE execution_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  ticket_id TEXT NOT NULL REFERENCES tickets (id) ON DELETE RESTRICT,
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
  ticket_id TEXT REFERENCES tickets (id) ON DELETE SET NULL,
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
CREATE INDEX idx_entity_changes_ticket_seq ON entity_changes (ticket_id, seq);
CREATE INDEX idx_entity_changes_entity_seq ON entity_changes (entity_type, entity_id, seq);

CREATE TABLE schema_migrations (
  version TEXT NOT NULL,
  adapter TEXT NOT NULL CHECK (adapter IN ('sqlite')),
  component TEXT NOT NULL CHECK (length(trim(component)) > 0),
  contract_version TEXT NOT NULL CHECK (length(trim(contract_version)) > 0),
  checksum TEXT NOT NULL CHECK (length(trim(checksum)) > 0),
  applied_at TEXT NOT NULL CHECK (applied_at GLOB '????-??-??T??:??:??.???Z'),
  PRIMARY KEY (adapter, component, version)
);

INSERT INTO workspaces (
  id, slug, name, kind, settings_json, created_at, updated_at, revision
) VALUES (
  'local-workspace', 'local', 'Local Workspace', 'local', '{}',
  '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1
);

INSERT INTO profiles (
  id, kind, display_name, handle, status, metadata_json, created_at, updated_at, revision
) VALUES (
  'local-user', 'human', 'Local User', 'local', 'active', '{}',
  '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1
);

INSERT INTO workspace_users (
  id, workspace_id, profile_id, member_key, status, metadata_json,
  created_at, updated_at, revision
) VALUES (
  'local-workspace-user', 'local-workspace', 'local-user', 'local:local',
  'active', '{}',
  '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1
);

INSERT INTO ticket_sequences (
  id, workspace_id, scope_type, scope_id, counter_name, next_value, updated_at
) VALUES (
  'local-workspace-ticket-sequence', 'local-workspace', 'workspace',
  'local-workspace', 'ticket', 1, '2026-01-01T00:00:00.000Z'
);

COMMIT;
