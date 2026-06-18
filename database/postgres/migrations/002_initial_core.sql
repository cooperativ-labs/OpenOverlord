-- Overlord PostgreSQL core schema.
-- Contract: database/docs/09-database-schema-contract.md

BEGIN;

CREATE TABLE workspaces (
  id text PRIMARY KEY,
  slug text NOT NULL CHECK (char_length(btrim(slug)) > 0),
  name text NOT NULL CHECK (char_length(btrim(name)) > 0),
  kind text NOT NULL CHECK (kind IN ('local', 'hosted')),
  settings_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX idx_workspaces_slug ON workspaces (slug);

CREATE TABLE profiles (
  id text PRIMARY KEY REFERENCES "user" ("id") ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('human', 'service')),
  display_name text NOT NULL CHECK (char_length(btrim(display_name)) > 0),
  handle text,
  email text,
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE INDEX idx_profiles_status ON profiles (status);
CREATE UNIQUE INDEX idx_profiles_handle_lower ON profiles (lower(handle)) WHERE handle IS NOT NULL;
CREATE UNIQUE INDEX idx_profiles_email_lower ON profiles (lower(email)) WHERE email IS NOT NULL;

-- The account username is stored as Better Auth `user.name` (set at sign-up
-- and updated when the user changes their username). profiles.handle
-- mirrors it and is not separately editable.
CREATE FUNCTION create_profile_for_better_auth_user()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO profiles (
    id, kind, display_name, handle, email, status, metadata_json,
    created_at, updated_at, revision
  ) VALUES (
    NEW."id",
    'human',
    COALESCE(NULLIF(btrim(NEW."name"), ''), NEW."email", 'User'),
    NULLIF(btrim(NEW."name"), ''),
    NEW."email",
    'active',
    '{}'::jsonb,
    NEW."createdAt",
    NEW."updatedAt",
    1
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_better_auth_user_create_profile
AFTER INSERT ON "user"
FOR EACH ROW
EXECUTE FUNCTION create_profile_for_better_auth_user();

-- Keep the handle mirrored whenever the account username changes.
CREATE FUNCTION sync_profile_handle_from_better_auth_user()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE profiles
     SET handle = NULLIF(btrim(NEW."name"), ''),
         updated_at = now(),
         revision = revision + 1
   WHERE id = NEW."id"
     AND handle IS DISTINCT FROM NULLIF(btrim(NEW."name"), '');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_better_auth_user_sync_profile_handle
AFTER UPDATE OF "name" ON "user"
FOR EACH ROW
WHEN (NEW."name" IS DISTINCT FROM OLD."name")
EXECUTE FUNCTION sync_profile_handle_from_better_auth_user();

CREATE TABLE workspace_users (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  profile_id text NOT NULL REFERENCES profiles (id) ON DELETE RESTRICT,
  member_key text,
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX idx_workspace_users_active_profile ON workspace_users (workspace_id, profile_id)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_workspace_users_active_member_key ON workspace_users (workspace_id, member_key)
  WHERE member_key IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_workspace_users_workspace_status ON workspace_users (workspace_id, status);
CREATE INDEX idx_workspace_users_profile_status ON workspace_users (profile_id, status);

CREATE TABLE projects (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  slug text NOT NULL CHECK (char_length(btrim(slug)) > 0),
  name text NOT NULL CHECK (char_length(btrim(name)) > 0),
  description text,
  status text NOT NULL CHECK (status IN ('active', 'archived')),
  settings_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_workspace_user_id text REFERENCES workspace_users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX idx_projects_workspace_slug ON projects (workspace_id, slug)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_projects_workspace_id ON projects (workspace_id, id);
CREATE INDEX idx_projects_workspace_status_updated ON projects (workspace_id, status, updated_at);

CREATE TABLE project_statuses (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  key text NOT NULL CHECK (char_length(btrim(key)) > 0),
  name text NOT NULL CHECK (char_length(btrim(name)) > 0),
  type text NOT NULL CHECK (type IN ('draft', 'execute', 'review', 'complete', 'blocked', 'cancelled')),
  position integer NOT NULL CHECK (position >= 0),
  is_default boolean NOT NULL DEFAULT false,
  is_terminal boolean NOT NULL DEFAULT false,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_project_statuses_project_key ON project_statuses (project_id, key);
CREATE UNIQUE INDEX idx_project_statuses_project_id ON project_statuses (project_id, id);
CREATE UNIQUE INDEX idx_project_statuses_active_default ON project_statuses (project_id)
  WHERE is_default = true AND deleted_at IS NULL;
CREATE UNIQUE INDEX idx_project_statuses_active_execute ON project_statuses (project_id)
  WHERE type = 'execute' AND deleted_at IS NULL;
CREATE UNIQUE INDEX idx_project_statuses_active_review ON project_statuses (project_id)
  WHERE type = 'review' AND deleted_at IS NULL;

CREATE TABLE devices (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  fingerprint text NOT NULL CHECK (char_length(btrim(fingerprint)) > 0),
  label text NOT NULL CHECK (char_length(btrim(label)) > 0),
  platform text,
  status text NOT NULL CHECK (status IN ('active', 'disabled', 'missing')),
  last_seen_at timestamptz,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX idx_devices_workspace_fingerprint ON devices (workspace_id, fingerprint);

CREATE TABLE execution_targets (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  device_id text REFERENCES devices (id) ON DELETE SET NULL,
  owner_workspace_user_id text REFERENCES workspace_users (id) ON DELETE SET NULL,
  type text NOT NULL CHECK (type IN ('local', 'ssh')),
  label text NOT NULL CHECK (char_length(btrim(label)) > 0),
  status text NOT NULL CHECK (status IN ('active', 'disabled', 'unavailable')),
  connection_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CHECK (type <> 'local' OR device_id IS NOT NULL)
);

CREATE INDEX idx_execution_targets_workspace_type_status ON execution_targets (workspace_id, type, status);
CREATE INDEX idx_execution_targets_workspace_device ON execution_targets (workspace_id, device_id);

CREATE TABLE workspace_user_execution_targets (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  workspace_user_id text NOT NULL REFERENCES workspace_users (id) ON DELETE RESTRICT,
  execution_target_id text NOT NULL REFERENCES execution_targets (id) ON DELETE RESTRICT,
  default_username text,
  access_status text NOT NULL CHECK (access_status IN ('active', 'pending', 'disabled', 'error')),
  last_connected_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX idx_wuet_active_user_target ON workspace_user_execution_targets (workspace_user_id, execution_target_id)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_wuet_workspace_target_status ON workspace_user_execution_targets (workspace_id, execution_target_id, access_status);

CREATE TABLE user_execution_target_preferences (
  id text PRIMARY KEY,
  profile_id text NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (char_length(btrim(target_type)) > 0),
  target_fingerprint text NOT NULL CHECK (char_length(btrim(target_fingerprint)) > 0),
  agent_configs_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  terminal_profile_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX idx_uetp_active_profile_target ON user_execution_target_preferences (profile_id, target_type, target_fingerprint)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_uetp_profile_type_updated ON user_execution_target_preferences (profile_id, target_type, updated_at);

CREATE TABLE project_resources (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  execution_target_id text REFERENCES execution_targets (id) ON DELETE SET NULL,
  type text NOT NULL CHECK (type IN ('local_directory', 'remote_directory')),
  label text,
  path text NOT NULL CHECK (char_length(btrim(path)) > 0),
  is_primary boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('active', 'missing', 'archived')),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_project_resources_project_target_primary ON project_resources (project_id, execution_target_id, is_primary);
CREATE UNIQUE INDEX idx_project_resources_active_project_target_path ON project_resources (project_id, execution_target_id, path)
  WHERE deleted_at IS NULL;

CREATE TABLE project_user_preferences (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  workspace_user_id text NOT NULL REFERENCES workspace_users (id) ON DELETE RESTRICT,
  preferences_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_project_user_preferences_active_project_user ON project_user_preferences (project_id, workspace_user_id)
  WHERE deleted_at IS NULL;

CREATE TABLE ticket_sequences (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  scope_type text NOT NULL CHECK (scope_type IN ('workspace')),
  scope_id text NOT NULL,
  counter_name text NOT NULL CHECK (char_length(btrim(counter_name)) > 0),
  next_value bigint NOT NULL CHECK (next_value >= 1),
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX idx_ticket_sequences_scope ON ticket_sequences (workspace_id, scope_type, scope_id, counter_name);

CREATE TABLE tickets (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  display_id text NOT NULL CHECK (char_length(btrim(display_id)) > 0),
  sequence_number bigint NOT NULL CHECK (sequence_number >= 1),
  title text NOT NULL CHECK (char_length(btrim(title)) > 0),
  status_id text NOT NULL REFERENCES project_statuses (id) ON DELETE RESTRICT,
  status_type text NOT NULL CHECK (status_type IN ('draft', 'execute', 'review', 'complete', 'blocked', 'cancelled')),
  board_position integer NOT NULL DEFAULT 0,
  priority text CHECK (priority IS NULL OR priority IN ('low', 'normal', 'high', 'urgent')),
  constraints_text text,
  acceptance_criteria_text text,
  available_tools_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  output_format_text text,
  execution_target_intent_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_workspace_user_id text REFERENCES workspace_users (id) ON DELETE SET NULL,
  assigned_workspace_user_id text REFERENCES workspace_users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
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
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  ticket_id text NOT NULL REFERENCES tickets (id) ON DELETE RESTRICT,
  position integer NOT NULL CHECK (position >= 0),
  title text,
  instruction_text text NOT NULL,
  state text NOT NULL CHECK (state IN ('future', 'draft', 'submitted', 'launching', 'executing', 'pending_delivery', 'complete')),
  assigned_agent text,
  model text,
  reasoning_effort text,
  agent_flags_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  launch_config_json jsonb,
  auto_advance boolean NOT NULL DEFAULT false,
  approval_reason text,
  auto_advanced_at timestamptz,
  completed_at timestamptz,
  execution_metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_workspace_user_id text REFERENCES workspace_users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
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
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  ticket_id text NOT NULL REFERENCES tickets (id) ON DELETE RESTRICT,
  objective_id text NOT NULL REFERENCES objectives (id) ON DELETE RESTRICT,
  session_key_prefix text NOT NULL CHECK (char_length(btrim(session_key_prefix)) > 0),
  session_key_hash text NOT NULL CHECK (char_length(btrim(session_key_hash)) > 0),
  agent_identifier text NOT NULL CHECK (char_length(btrim(agent_identifier)) > 0),
  model_identifier text,
  connection_method text NOT NULL CHECK (char_length(btrim(connection_method)) > 0),
  external_session_id text,
  phase text NOT NULL CHECK (phase IN ('attach', 'execute', 'review', 'complete', 'blocked')),
  delivery_state text NOT NULL CHECK (delivery_state IN ('not_delivered', 'delivered', 'pending_redelivery')),
  started_at timestamptz NOT NULL,
  last_heartbeat_at timestamptz,
  ended_at timestamptz,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_workspace_user_id text REFERENCES workspace_users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
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
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  ticket_id text NOT NULL REFERENCES tickets (id) ON DELETE RESTRICT,
  objective_id text REFERENCES objectives (id) ON DELETE SET NULL,
  session_id text REFERENCES agent_sessions (id) ON DELETE SET NULL,
  type text NOT NULL CHECK (type IN ('update', 'user_follow_up', 'alert', 'discussion_summary', 'decision', 'ask', 'permission_request', 'delivery', 'execution_requested', 'awaiting_approval', 'status_change')),
  phase text,
  summary text NOT NULL CHECK (char_length(btrim(summary)) > 0),
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  external_url text,
  source text NOT NULL CHECK (char_length(btrim(source)) > 0),
  actor_workspace_user_id text REFERENCES workspace_users (id) ON DELETE SET NULL,
  actor_token_id text,
  idempotency_key text,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, ticket_id) REFERENCES tickets (workspace_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_ticket_events_ticket_created ON ticket_events (ticket_id, created_at);
CREATE INDEX idx_ticket_events_objective_created ON ticket_events (objective_id, created_at);
CREATE UNIQUE INDEX idx_ticket_events_idempotency ON ticket_events (workspace_id, source, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE shared_context_entries (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  ticket_id text NOT NULL REFERENCES tickets (id) ON DELETE RESTRICT,
  objective_id text REFERENCES objectives (id) ON DELETE SET NULL,
  key text NOT NULL CHECK (char_length(btrim(key)) > 0),
  value_kind text NOT NULL CHECK (value_kind IN ('string', 'json')),
  value_text text,
  value_json jsonb,
  created_by_session_id text REFERENCES agent_sessions (id) ON DELETE SET NULL,
  created_by_workspace_user_id text REFERENCES workspace_users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
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
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  ticket_id text NOT NULL REFERENCES tickets (id) ON DELETE RESTRICT,
  objective_id text NOT NULL REFERENCES objectives (id) ON DELETE RESTRICT,
  storage_backend text NOT NULL CHECK (char_length(btrim(storage_backend)) > 0),
  storage_key text NOT NULL CHECK (char_length(btrim(storage_key)) > 0),
  filename text NOT NULL CHECK (char_length(btrim(filename)) > 0),
  content_type text,
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  checksum_sha256 text,
  upload_status text NOT NULL CHECK (upload_status IN ('prepared', 'uploaded', 'available', 'failed', 'deleted')),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_workspace_user_id text REFERENCES workspace_users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE INDEX idx_objective_attachments_objective_created ON objective_attachments (objective_id, created_at);
CREATE INDEX idx_objective_attachments_ticket_created ON objective_attachments (ticket_id, created_at);

CREATE TABLE deliveries (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  ticket_id text NOT NULL REFERENCES tickets (id) ON DELETE RESTRICT,
  objective_id text NOT NULL REFERENCES objectives (id) ON DELETE RESTRICT,
  session_id text REFERENCES agent_sessions (id) ON DELETE SET NULL,
  summary text NOT NULL CHECK (char_length(btrim(summary)) > 0),
  verification_summary text,
  follow_up_notes text,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  delivered_by_workspace_user_id text REFERENCES workspace_users (id) ON DELETE SET NULL,
  delivered_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX idx_deliveries_workspace_id ON deliveries (workspace_id, id);
CREATE INDEX idx_deliveries_ticket_delivered ON deliveries (ticket_id, delivered_at);
CREATE INDEX idx_deliveries_objective_delivered ON deliveries (objective_id, delivered_at);
CREATE INDEX idx_deliveries_session ON deliveries (session_id);

CREATE TABLE artifacts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  ticket_id text NOT NULL REFERENCES tickets (id) ON DELETE RESTRICT,
  objective_id text REFERENCES objectives (id) ON DELETE SET NULL,
  session_id text REFERENCES agent_sessions (id) ON DELETE SET NULL,
  delivery_id text REFERENCES deliveries (id) ON DELETE SET NULL,
  type text NOT NULL CHECK (type IN ('test_results', 'next_steps', 'note', 'url', 'decision', 'migration')),
  label text NOT NULL CHECK (char_length(btrim(label)) > 0),
  content_text text,
  content_json jsonb,
  external_url text,
  created_by_workspace_user_id text REFERENCES workspace_users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CHECK (content_text IS NOT NULL OR content_json IS NOT NULL OR external_url IS NOT NULL)
);

CREATE INDEX idx_artifacts_ticket_created ON artifacts (ticket_id, created_at);
CREATE INDEX idx_artifacts_delivery_type ON artifacts (delivery_id, type);

CREATE TABLE changed_files (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  ticket_id text NOT NULL REFERENCES tickets (id) ON DELETE RESTRICT,
  objective_id text NOT NULL REFERENCES objectives (id) ON DELETE RESTRICT,
  session_id text REFERENCES agent_sessions (id) ON DELETE SET NULL,
  resource_id text REFERENCES project_resources (id) ON DELETE SET NULL,
  file_path text NOT NULL CHECK (char_length(btrim(file_path)) > 0),
  vcs_status text,
  current_diff_state text NOT NULL CHECK (current_diff_state IN ('present', 'resolved', 'unknown', 'unavailable')),
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  last_observed_event_id text REFERENCES ticket_events (id) ON DELETE SET NULL,
  observed_metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX idx_changed_files_active_session_objective_path ON changed_files (session_id, objective_id, file_path)
  WHERE session_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_changed_files_ticket_objective_path ON changed_files (ticket_id, objective_id, file_path);
CREATE INDEX idx_changed_files_project_updated ON changed_files (project_id, updated_at);

CREATE TABLE change_rationales (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  ticket_id text NOT NULL REFERENCES tickets (id) ON DELETE RESTRICT,
  objective_id text NOT NULL REFERENCES objectives (id) ON DELETE RESTRICT,
  session_id text REFERENCES agent_sessions (id) ON DELETE SET NULL,
  delivery_id text REFERENCES deliveries (id) ON DELETE SET NULL,
  changed_file_id text REFERENCES changed_files (id) ON DELETE SET NULL,
  file_path text NOT NULL CHECK (char_length(btrim(file_path)) > 0),
  label text NOT NULL CHECK (char_length(btrim(label)) > 0),
  summary text NOT NULL CHECK (char_length(btrim(summary)) > 0),
  why text NOT NULL CHECK (char_length(btrim(why)) > 0),
  impact text NOT NULL CHECK (char_length(btrim(impact)) > 0),
  hunks_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_event_id text REFERENCES ticket_events (id) ON DELETE SET NULL,
  is_final boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE INDEX idx_change_rationales_ticket_objective_path ON change_rationales (ticket_id, objective_id, file_path);
CREATE INDEX idx_change_rationales_delivery_path ON change_rationales (delivery_id, file_path);
CREATE UNIQUE INDEX idx_change_rationales_active_final_delivery_path ON change_rationales (delivery_id, file_path)
  WHERE is_final = true AND delivery_id IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE execution_requests (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  ticket_id text NOT NULL REFERENCES tickets (id) ON DELETE RESTRICT,
  objective_id text NOT NULL REFERENCES objectives (id) ON DELETE RESTRICT,
  execution_target_id text REFERENCES execution_targets (id) ON DELETE SET NULL,
  requested_agent text,
  requested_model text,
  requested_reasoning_effort text,
  launch_mode text NOT NULL CHECK (launch_mode IN ('run', 'ask')),
  launch_flags_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  target_kind text NOT NULL CHECK (target_kind IN ('any', 'local', 'ssh')),
  requested_source text NOT NULL CHECK (char_length(btrim(requested_source)) > 0),
  idempotency_key text,
  status text NOT NULL CHECK (status IN ('queued', 'claimed', 'launching', 'launched', 'failed', 'cleared', 'cancelled', 'expired')),
  requested_by_workspace_user_id text REFERENCES workspace_users (id) ON DELETE SET NULL,
  claimed_by_device_id text REFERENCES devices (id) ON DELETE SET NULL,
  claimed_by_execution_target_id text REFERENCES execution_targets (id) ON DELETE SET NULL,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  launch_started_at timestamptz,
  launch_completed_at timestamptz,
  launched_session_id text REFERENCES agent_sessions (id) ON DELETE SET NULL,
  resolved_resource_id text REFERENCES project_resources (id) ON DELETE SET NULL,
  resolved_working_directory text,
  last_error text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CHECK (requested_source <> 'auto_advance' OR idempotency_key IS NOT NULL)
);

CREATE INDEX idx_execution_requests_workspace_status_created ON execution_requests (workspace_id, status, created_at);
CREATE INDEX idx_execution_requests_project_status_created ON execution_requests (project_id, status, created_at);
CREATE INDEX idx_execution_requests_objective_status ON execution_requests (objective_id, status);
CREATE INDEX idx_execution_requests_claimable ON execution_requests (workspace_id, created_at)
  WHERE status = 'queued' AND deleted_at IS NULL;
CREATE UNIQUE INDEX idx_execution_requests_workspace_idempotency ON execution_requests (workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE idempotency_keys (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  scope text NOT NULL CHECK (char_length(btrim(scope)) > 0),
  key text NOT NULL CHECK (char_length(btrim(key)) > 0),
  request_hash text NOT NULL CHECK (char_length(btrim(request_hash)) > 0),
  response_json jsonb,
  status text NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed')),
  actor_workspace_user_id text REFERENCES workspace_users (id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX idx_idempotency_keys_workspace_scope_key ON idempotency_keys (workspace_id, scope, key);
CREATE INDEX idx_idempotency_keys_expires_at ON idempotency_keys (expires_at);

CREATE TABLE entity_changes (
  seq bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  id text NOT NULL UNIQUE,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id text REFERENCES projects (id) ON DELETE SET NULL,
  ticket_id text REFERENCES tickets (id) ON DELETE SET NULL,
  objective_id text REFERENCES objectives (id) ON DELETE SET NULL,
  entity_type text NOT NULL CHECK (char_length(btrim(entity_type)) > 0),
  entity_id text NOT NULL CHECK (char_length(btrim(entity_id)) > 0),
  operation text NOT NULL CHECK (operation IN ('insert', 'update', 'delete', 'restore')),
  entity_revision integer CHECK (entity_revision IS NULL OR entity_revision >= 1),
  changed_fields_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  actor_workspace_user_id text REFERENCES workspace_users (id) ON DELETE SET NULL,
  actor_token_id text,
  source text NOT NULL CHECK (char_length(btrim(source)) > 0),
  occurred_at timestamptz NOT NULL
);

CREATE INDEX idx_entity_changes_workspace_seq ON entity_changes (workspace_id, seq);
CREATE INDEX idx_entity_changes_project_seq ON entity_changes (project_id, seq);
CREATE INDEX idx_entity_changes_ticket_seq ON entity_changes (ticket_id, seq);
CREATE INDEX idx_entity_changes_entity_seq ON entity_changes (entity_type, entity_id, seq);

CREATE TABLE schema_migrations (
  version text NOT NULL,
  adapter text NOT NULL CHECK (adapter IN ('postgres')),
  component text NOT NULL CHECK (char_length(btrim(component)) > 0),
  contract_version text NOT NULL CHECK (char_length(btrim(contract_version)) > 0),
  checksum text NOT NULL CHECK (char_length(btrim(checksum)) > 0),
  applied_at timestamptz NOT NULL,
  PRIMARY KEY (adapter, component, version)
);

INSERT INTO workspaces (
  id, slug, name, kind, settings_json, created_at, updated_at, revision
) VALUES (
  'local-workspace', 'local', 'Local Workspace', 'local', '{}'::jsonb,
  '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1
);

INSERT INTO profiles (
  id, kind, display_name, handle, status, metadata_json, created_at, updated_at, revision
) VALUES (
  'local-user', 'human', 'Local User', 'local', 'active', '{}'::jsonb,
  '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1
);

INSERT INTO workspace_users (
  id, workspace_id, profile_id, member_key, status, metadata_json,
  created_at, updated_at, revision
) VALUES (
  'local-workspace-user', 'local-workspace', 'local-user', 'local:local',
  'active', '{}'::jsonb,
  '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1
);

INSERT INTO ticket_sequences (
  id, workspace_id, scope_type, scope_id, counter_name, next_value, updated_at
) VALUES (
  'local-workspace-ticket-sequence', 'local-workspace', 'workspace',
  'local-workspace', 'ticket', 1, '2026-01-01T00:00:00.000Z'
);

COMMIT;
