-- Overlord PostgreSQL core schema.
-- Contract: database/docs/09-database-schema-contract.md

BEGIN;

-- Organization -> workspace -> project hierarchy (coo:135). Workspaces remain
-- the sole RBAC layer; an organization is a grouping + identity shell above them.
-- See planning/feature-plans/organization-workspace-hierarchy.md.
CREATE TABLE organizations (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (char_length(btrim(name)) > 0),
  settings_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE TABLE workspaces (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  slug text NOT NULL CHECK (char_length(btrim(slug)) > 0),
  name text NOT NULL CHECK (char_length(btrim(name)) > 0),
  kind text NOT NULL CHECK (kind IN ('local', 'hosted')),
  settings_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX idx_workspaces_organization_slug ON workspaces (organization_id, slug)
  WHERE deleted_at IS NULL;

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

-- Keep profiles.email mirrored from the authoritative Better Auth account email,
-- the same way profiles.handle mirrors the account name.
CREATE FUNCTION sync_profile_email_from_better_auth_user()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE profiles
     SET email = NEW."email",
         updated_at = now(),
         revision = revision + 1
   WHERE id = NEW."id"
     AND email IS DISTINCT FROM NEW."email";
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_better_auth_user_sync_profile_email
AFTER UPDATE OF "email" ON "user"
FOR EACH ROW
WHEN (NEW."email" IS DISTINCT FROM OLD."email")
EXECUTE FUNCTION sync_profile_email_from_better_auth_user();

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
  -- 1-based drag-and-drop ordering within a workspace (coo:132).
  position integer CHECK (position IS NULL OR position >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX idx_projects_workspace_slug ON projects (workspace_id, slug)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_projects_workspace_id ON projects (workspace_id, id);
CREATE INDEX idx_projects_workspace_status_updated ON projects (workspace_id, status, updated_at);
CREATE UNIQUE INDEX idx_projects_workspace_position ON projects (workspace_id, position)
  WHERE deleted_at IS NULL;

CREATE TABLE workspace_statuses (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  key text NOT NULL CHECK (char_length(btrim(key)) > 0),
  name text NOT NULL CHECK (char_length(btrim(name)) > 0 AND name = btrim(name)),
  type text NOT NULL CHECK (type IN ('draft', 'execute', 'review', 'complete', 'blocked', 'cancelled')),
  position integer NOT NULL CHECK (position >= 0),
  is_default boolean NOT NULL DEFAULT false,
  is_terminal boolean NOT NULL DEFAULT false,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  UNIQUE (workspace_id, id)
);

CREATE UNIQUE INDEX idx_workspace_statuses_workspace_key ON workspace_statuses (workspace_id, key);
CREATE UNIQUE INDEX idx_workspace_statuses_active_name ON workspace_statuses (workspace_id, lower(name))
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_workspace_statuses_active_default ON workspace_statuses (workspace_id)
  WHERE is_default = true AND deleted_at IS NULL;
CREATE UNIQUE INDEX idx_workspace_statuses_active_execute ON workspace_statuses (workspace_id)
  WHERE type = 'execute' AND deleted_at IS NULL;
CREATE UNIQUE INDEX idx_workspace_statuses_active_review ON workspace_statuses (workspace_id)
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

CREATE TABLE mission_sequences (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  scope_type text NOT NULL CHECK (scope_type IN ('workspace')),
  scope_id text NOT NULL,
  counter_name text NOT NULL CHECK (char_length(btrim(counter_name)) > 0),
  next_value bigint NOT NULL CHECK (next_value >= 1),
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX idx_mission_sequences_scope ON mission_sequences (workspace_id, scope_type, scope_id, counter_name);

-- Mission scheduling (coo:124): repeating schedules that compute a mission's due
-- date and, on completion, spawn a duplicate mission for the next occurrence.
-- See planning/feature-plans/mission-scheduling-engine.md.
CREATE TABLE schedules (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  name text,
  period_type text NOT NULL DEFAULT 'd' CHECK (period_type IN ('d', 'w', 'm')),
  period_interval integer NOT NULL DEFAULT 1 CHECK (period_interval >= 1),
  weeks_of_month_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  days_of_month_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  days_of_week_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  start_date timestamptz,
  timezone text NOT NULL CHECK (char_length(btrim(timezone)) > 0),
  -- Configurable duplicate target status. NULL falls back to the workspace
  -- default/next-up status at duplication time.
  next_status_id text REFERENCES workspace_statuses (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (workspace_id, next_status_id) REFERENCES workspace_statuses (workspace_id, id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX idx_schedules_workspace_id ON schedules (workspace_id, id);
CREATE INDEX idx_schedules_workspace_next_status ON schedules (workspace_id, next_status_id);

CREATE TABLE missions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  display_id text NOT NULL CHECK (char_length(btrim(display_id)) > 0),
  sequence_number bigint NOT NULL CHECK (sequence_number >= 1),
  title text NOT NULL CHECK (char_length(btrim(title)) > 0),
  status_id text NOT NULL REFERENCES workspace_statuses (id) ON DELETE RESTRICT,
  status_type text NOT NULL CHECK (status_type IN ('draft', 'execute', 'review', 'complete', 'blocked', 'cancelled')),
  board_position integer NOT NULL DEFAULT 0,
  priority text CHECK (priority IS NULL OR priority IN ('low', 'normal', 'high', 'urgent')),
  constraints_text text,
  acceptance_criteria_text text,
  available_tools_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  output_format_text text,
  execution_target_intent_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Branch automation (coo:16/coo:30/coo:9): active_branch is the branch the
  -- mission is currently operating on; branch_override is a one-shot user-pinned
  -- branch consumed at branch-preparation; worktree_preference is a persistent
  -- per-mission worktree/branch opt-in overriding the workspace setting.
  active_branch text,
  branch_override text,
  worktree_preference text,
  -- Scheduling (coo:124). A NULL schedule_id is not FK-checked (MATCH SIMPLE).
  schedule_id text,
  due_datetime timestamptz,
  created_by_workspace_user_id text REFERENCES workspace_users (id) ON DELETE SET NULL,
  assigned_workspace_user_id text REFERENCES workspace_users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, status_id) REFERENCES workspace_statuses (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT missions_schedule_id_fkey
    FOREIGN KEY (workspace_id, schedule_id) REFERENCES schedules (workspace_id, id) ON DELETE SET NULL
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
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  workspace_user_id text NOT NULL REFERENCES workspace_users (id) ON DELETE CASCADE,
  mission_id text NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
  status_id text NOT NULL REFERENCES workspace_statuses (id) ON DELETE CASCADE,
  position double precision NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  UNIQUE (workspace_id, workspace_user_id, mission_id),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES missions (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, status_id) REFERENCES workspace_statuses (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_my_mission_positions_user_status
  ON my_mission_positions (workspace_id, workspace_user_id, status_id, position);

CREATE TABLE objectives (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  mission_id text NOT NULL REFERENCES missions (id) ON DELETE RESTRICT,
  position integer NOT NULL CHECK (position >= 0),
  title text,
  instruction_text text,
  state text NOT NULL CHECK (state IN ('future', 'draft', 'submitted', 'launching', 'executing', 'pending_delivery', 'complete')),
  assigned_agent text,
  model text,
  reasoning_effort text,
  agent_flags_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  launch_config_json jsonb,
  -- The branch an objective actually ran on, written by the runner at
  -- branch-prepared time (coo:30).
  branch text,
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
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  mission_id text NOT NULL REFERENCES missions (id) ON DELETE RESTRICT,
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
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  mission_id text NOT NULL REFERENCES missions (id) ON DELETE RESTRICT,
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
  FOREIGN KEY (workspace_id, mission_id) REFERENCES missions (workspace_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_mission_events_mission_created ON mission_events (mission_id, created_at);
CREATE INDEX idx_mission_events_objective_created ON mission_events (objective_id, created_at);
CREATE UNIQUE INDEX idx_mission_events_idempotency ON mission_events (workspace_id, source, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE shared_context_entries (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  mission_id text NOT NULL REFERENCES missions (id) ON DELETE RESTRICT,
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

CREATE UNIQUE INDEX idx_shared_context_entries_active_mission_key ON shared_context_entries (mission_id, key)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_shared_context_entries_objective_updated ON shared_context_entries (objective_id, updated_at)
  WHERE objective_id IS NOT NULL;
CREATE INDEX idx_shared_context_entries_mission_updated ON shared_context_entries (mission_id, updated_at);

CREATE TABLE objective_attachments (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  mission_id text NOT NULL REFERENCES missions (id) ON DELETE RESTRICT,
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
CREATE INDEX idx_objective_attachments_mission_created ON objective_attachments (mission_id, created_at);

CREATE TABLE deliveries (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  mission_id text NOT NULL REFERENCES missions (id) ON DELETE RESTRICT,
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
CREATE INDEX idx_deliveries_mission_delivered ON deliveries (mission_id, delivered_at);
CREATE INDEX idx_deliveries_objective_delivered ON deliveries (objective_id, delivered_at);
CREATE INDEX idx_deliveries_session ON deliveries (session_id);

CREATE TABLE artifacts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  mission_id text NOT NULL REFERENCES missions (id) ON DELETE RESTRICT,
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

CREATE INDEX idx_artifacts_mission_created ON artifacts (mission_id, created_at);
CREATE INDEX idx_artifacts_delivery_type ON artifacts (delivery_id, type);

CREATE TABLE changed_files (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  mission_id text NOT NULL REFERENCES missions (id) ON DELETE RESTRICT,
  objective_id text NOT NULL REFERENCES objectives (id) ON DELETE RESTRICT,
  session_id text REFERENCES agent_sessions (id) ON DELETE SET NULL,
  resource_id text REFERENCES project_resources (id) ON DELETE SET NULL,
  file_path text NOT NULL CHECK (char_length(btrim(file_path)) > 0),
  vcs_status text,
  current_diff_state text NOT NULL CHECK (current_diff_state IN ('present', 'resolved', 'unknown', 'unavailable')),
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  last_observed_event_id text REFERENCES mission_events (id) ON DELETE SET NULL,
  observed_metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX idx_changed_files_active_session_objective_path ON changed_files (session_id, objective_id, file_path)
  WHERE session_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_changed_files_mission_objective_path ON changed_files (mission_id, objective_id, file_path);
CREATE INDEX idx_changed_files_project_updated ON changed_files (project_id, updated_at);

CREATE TABLE change_rationales (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  mission_id text NOT NULL REFERENCES missions (id) ON DELETE RESTRICT,
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
  source_event_id text REFERENCES mission_events (id) ON DELETE SET NULL,
  is_final boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE INDEX idx_change_rationales_mission_objective_path ON change_rationales (mission_id, objective_id, file_path);
CREATE INDEX idx_change_rationales_delivery_path ON change_rationales (delivery_id, file_path);
CREATE UNIQUE INDEX idx_change_rationales_active_final_delivery_path ON change_rationales (delivery_id, file_path)
  WHERE is_final = true AND delivery_id IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE execution_requests (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  mission_id text NOT NULL REFERENCES missions (id) ON DELETE RESTRICT,
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
  mission_id text REFERENCES missions (id) ON DELETE SET NULL,
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
CREATE INDEX idx_entity_changes_mission_seq ON entity_changes (mission_id, seq);
CREATE INDEX idx_entity_changes_entity_seq ON entity_changes (entity_type, entity_id, seq);

-- ---------------------------------------------------------------------------
-- Project-scoped mission tags (project_tags definitions + mission_tags join).
-- ---------------------------------------------------------------------------
CREATE TABLE project_tags (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  label text NOT NULL CHECK (char_length(btrim(label)) > 0),
  color text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_project_tags_project_label ON project_tags (project_id, label)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_project_tags_project_id ON project_tags (project_id, id);
CREATE INDEX idx_project_tags_project_active ON project_tags (project_id, active);

CREATE TABLE mission_tags (
  mission_id text NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
  tag_id text NOT NULL REFERENCES project_tags (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (mission_id, tag_id)
);

CREATE INDEX idx_mission_tags_tag ON mission_tags (tag_id);

-- ---------------------------------------------------------------------------
-- Client-reported observations per execution target (WS-F4 / WS-F6).
-- ---------------------------------------------------------------------------
CREATE TABLE target_resource_observations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  execution_target_id text NOT NULL REFERENCES execution_targets (id) ON DELETE CASCADE,
  resource_id text NOT NULL REFERENCES project_resources (id) ON DELETE CASCADE,
  state text NOT NULL,
  git_root text,
  branch text,
  git_commit text,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE RESTRICT,
  FOREIGN KEY (execution_target_id) REFERENCES execution_targets (id) ON DELETE CASCADE,
  FOREIGN KEY (resource_id) REFERENCES project_resources (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_target_resource_observations_target_resource
  ON target_resource_observations (execution_target_id, resource_id);
CREATE INDEX idx_target_resource_observations_resource
  ON target_resource_observations (resource_id);

CREATE TABLE mission_branch_observations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  execution_target_id text NOT NULL REFERENCES execution_targets (id) ON DELETE CASCADE,
  mission_id text NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('created', 'published', 'merged_unpushed', 'merged')),
  dirty boolean NOT NULL,
  worktree_path text,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
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
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  email text NOT NULL CHECK (char_length(btrim(email)) > 0),
  role_key text NOT NULL DEFAULT 'MEMBER' CHECK (char_length(btrim(role_key)) > 0),
  token_prefix text NOT NULL CHECK (char_length(btrim(token_prefix)) > 0),
  token_hash text NOT NULL CHECK (char_length(btrim(token_hash)) > 0),
  hash_algorithm text NOT NULL CHECK (char_length(btrim(hash_algorithm)) > 0),
  status text NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  invited_by_workspace_user_id text NOT NULL REFERENCES workspace_users (id) ON DELETE RESTRICT,
  accepted_by_workspace_user_id text REFERENCES workspace_users (id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
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
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  topic text NOT NULL CHECK (char_length(btrim(topic)) > 0),
  payload_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'cancelled')),
  available_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX idx_outbox_messages_workspace_status_available ON outbox_messages
  (workspace_id, status, available_at);
CREATE INDEX idx_outbox_messages_topic_created ON outbox_messages (topic, created_at);

CREATE TABLE webhook_subscriptions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id text REFERENCES projects (id) ON DELETE SET NULL,
  name text NOT NULL CHECK (char_length(btrim(name)) > 0),
  endpoint_url text NOT NULL CHECK (char_length(btrim(endpoint_url)) > 0),
  secret text NOT NULL CHECK (char_length(btrim(secret)) > 0),
  event_types_json jsonb NOT NULL,
  payload_mode text NOT NULL DEFAULT 'thin' CHECK (payload_mode IN ('thin', 'full')),
  created_by_workspace_user_id text NOT NULL REFERENCES workspace_users (id) ON DELETE RESTRICT,
  enabled boolean NOT NULL DEFAULT true,
  disabled_reason text CHECK (disabled_reason IS NULL OR disabled_reason IN ('manual', 'failures', 'owner_revoked')),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id) ON DELETE SET NULL
);

CREATE INDEX idx_webhook_subscriptions_workspace_enabled ON webhook_subscriptions (workspace_id, enabled)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_webhook_subscriptions_workspace_project ON webhook_subscriptions (workspace_id, project_id)
  WHERE deleted_at IS NULL;

CREATE TABLE webhook_delivery_attempts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  subscription_id text NOT NULL REFERENCES webhook_subscriptions (id) ON DELETE RESTRICT,
  outbox_message_id text NOT NULL REFERENCES outbox_messages (id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (char_length(btrim(event_type)) > 0),
  attempt_number integer NOT NULL CHECK (attempt_number >= 1),
  response_status integer,
  response_snippet text,
  error text,
  duration_ms integer,
  attempted_at timestamptz NOT NULL
);

CREATE INDEX idx_webhook_delivery_attempts_subscription_attempted ON webhook_delivery_attempts
  (subscription_id, attempted_at);
CREATE INDEX idx_webhook_delivery_attempts_outbox_message ON webhook_delivery_attempts (outbox_message_id);

-- ---------------------------------------------------------------------------
-- Mission search: indexing table + tsvector GIN full-text index + sync triggers.
-- ---------------------------------------------------------------------------
CREATE TABLE search_documents (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id text REFERENCES projects (id) ON DELETE SET NULL,
  mission_id text NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('mission', 'objective', 'event')),
  entity_id text NOT NULL,
  title text,
  body_text text NOT NULL,
  content_hash text,
  source_revision integer,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  indexed_at timestamptz NOT NULL DEFAULT now(),
  search_tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body_text, '')), 'B')
  ) STORED
);

CREATE UNIQUE INDEX idx_search_documents_entity ON search_documents (workspace_id, entity_type, entity_id);
CREATE INDEX idx_search_documents_workspace_project_type ON search_documents (workspace_id, project_id, entity_type);
CREATE INDEX idx_search_documents_mission ON search_documents (mission_id);
CREATE INDEX idx_search_documents_tsv ON search_documents USING gin (search_tsv);

CREATE FUNCTION search_documents_sync_mission() RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    DELETE FROM search_documents WHERE workspace_id = OLD.workspace_id AND mission_id = OLD.id;
    RETURN OLD;
  END IF;

  IF (TG_OP = 'UPDATE' AND NEW.workspace_id IS DISTINCT FROM OLD.workspace_id) THEN
    DELETE FROM search_documents WHERE workspace_id = OLD.workspace_id AND mission_id = OLD.id;
  END IF;

  IF (NEW.deleted_at IS NOT NULL) THEN
    -- Soft delete: drop the mission and all of its objective/event documents.
    DELETE FROM search_documents WHERE workspace_id = NEW.workspace_id AND mission_id = NEW.id;
    RETURN NEW;
  END IF;

  INSERT INTO search_documents (
    id, workspace_id, project_id, mission_id, entity_type, entity_id,
    title, body_text, source_revision, indexed_at
  ) VALUES (
    gen_random_uuid()::text, NEW.workspace_id, NEW.project_id, NEW.id, 'mission', NEW.id,
    NEW.title, NEW.title || ' ' || NEW.display_id, NEW.revision, now()
  )
  ON CONFLICT (workspace_id, entity_type, entity_id) DO UPDATE SET
    project_id = excluded.project_id,
    mission_id = excluded.mission_id,
    title = excluded.title,
    body_text = excluded.body_text,
    source_revision = excluded.source_revision,
    indexed_at = excluded.indexed_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_search_missions
AFTER INSERT OR UPDATE OR DELETE ON missions
FOR EACH ROW EXECUTE FUNCTION search_documents_sync_mission();

CREATE FUNCTION search_documents_sync_objective() RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    DELETE FROM search_documents
    WHERE workspace_id = OLD.workspace_id AND entity_type = 'objective' AND entity_id = OLD.id;
    RETURN OLD;
  END IF;

  IF (TG_OP = 'UPDATE' AND NEW.workspace_id IS DISTINCT FROM OLD.workspace_id) THEN
    DELETE FROM search_documents
    WHERE workspace_id = OLD.workspace_id AND entity_type = 'objective' AND entity_id = OLD.id;
  END IF;

  IF (NEW.deleted_at IS NOT NULL) THEN
    DELETE FROM search_documents
    WHERE workspace_id = NEW.workspace_id AND entity_type = 'objective' AND entity_id = NEW.id;
    RETURN NEW;
  END IF;

  INSERT INTO search_documents (
    id, workspace_id, project_id, mission_id, entity_type, entity_id,
    title, body_text, source_revision, indexed_at
  ) VALUES (
    gen_random_uuid()::text, NEW.workspace_id, NEW.project_id, NEW.mission_id, 'objective', NEW.id,
    NEW.title, btrim(coalesce(NEW.title, '') || ' ' || coalesce(NEW.instruction_text, '')), NEW.revision, now()
  )
  ON CONFLICT (workspace_id, entity_type, entity_id) DO UPDATE SET
    project_id = excluded.project_id,
    mission_id = excluded.mission_id,
    title = excluded.title,
    body_text = excluded.body_text,
    source_revision = excluded.source_revision,
    indexed_at = excluded.indexed_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_search_objectives
AFTER INSERT OR UPDATE OR DELETE ON objectives
FOR EACH ROW EXECUTE FUNCTION search_documents_sync_objective();

CREATE FUNCTION search_documents_sync_event() RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    DELETE FROM search_documents
    WHERE workspace_id = OLD.workspace_id AND entity_type = 'event' AND entity_id = OLD.id;
    RETURN OLD;
  END IF;

  IF (TG_OP = 'UPDATE' AND NEW.workspace_id IS DISTINCT FROM OLD.workspace_id) THEN
    DELETE FROM search_documents
    WHERE workspace_id = OLD.workspace_id AND entity_type = 'event' AND entity_id = OLD.id;
  END IF;

  INSERT INTO search_documents (
    id, workspace_id, project_id, mission_id, entity_type, entity_id,
    title, body_text, indexed_at
  ) VALUES (
    gen_random_uuid()::text, NEW.workspace_id, NEW.project_id, NEW.mission_id, 'event', NEW.id,
    NULL, NEW.summary, now()
  )
  ON CONFLICT (workspace_id, entity_type, entity_id) DO UPDATE SET
    project_id = excluded.project_id,
    mission_id = excluded.mission_id,
    body_text = excluded.body_text,
    indexed_at = excluded.indexed_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_search_events
AFTER INSERT OR UPDATE OR DELETE ON mission_events
FOR EACH ROW EXECUTE FUNCTION search_documents_sync_event();

CREATE TABLE schema_migrations (
  version text NOT NULL,
  adapter text NOT NULL CHECK (adapter IN ('postgres')),
  component text NOT NULL CHECK (char_length(btrim(component)) > 0),
  contract_version text NOT NULL CHECK (char_length(btrim(contract_version)) > 0),
  checksum text NOT NULL CHECK (char_length(btrim(checksum)) > 0),
  applied_at timestamptz NOT NULL,
  PRIMARY KEY (adapter, component, version)
);

COMMIT;
