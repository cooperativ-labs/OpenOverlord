-- Virtual execution targets (coo:258, contract 3)
--
-- Adopts the contract-v3 provider-neutral virtual execution target schema
-- (database/docs/09-database-schema-contract.md → "Virtual Execution Targets"):
--   * widens execution_targets.type to include the core 'virtual' value,
--   * creates the seven core virtual-target tables, and
--   * adds four additive execution_requests columns.
--
-- The decisive rule from the contract is preserved in the shape below:
-- desired launch state (the immutable execution_request_snapshots payload) is
-- kept separate from observed realization state (append-only
-- execution_request_observations). Paths and raw secrets never cross that
-- boundary: grants store only hashes/opaque IDs, source descriptors store
-- credential-reference IDs and opaque handles, and observations are bounded and
-- redacted. execution_requests.status stays the closed vocabulary it already is.

BEGIN;

-- 'virtual' is a core execution_targets.type. The column is an open vocabulary,
-- so this is an additive widening of the enumerated CHECK, not a closed-vocab
-- change. The separate (type <> 'local' OR device_id IS NOT NULL) guard is left
-- intact.
ALTER TABLE execution_targets
  DROP CONSTRAINT IF EXISTS execution_targets_type_check;
ALTER TABLE execution_targets
  ADD CONSTRAINT execution_targets_type_check CHECK (type IN ('local', 'ssh', 'virtual'));

-- ---------------------------------------------------------------------------
-- execution_target_registrations
-- Gateway-owned registration and health for one virtual execution target.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS execution_target_registrations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  execution_target_id text NOT NULL REFERENCES execution_targets (id) ON DELETE CASCADE,
  gateway_key text NOT NULL CHECK (char_length(btrim(gateway_key)) > 0),
  gateway_instance_id text NOT NULL CHECK (char_length(btrim(gateway_instance_id)) > 0),
  gateway_version text,
  capabilities_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  supported_agents_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  supported_queue_versions_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  connection_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  health text NOT NULL CHECK (char_length(btrim(health)) > 0),
  last_heartbeat_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_etr_active_target
  ON execution_target_registrations (execution_target_id)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_etr_active_gateway_instance
  ON execution_target_registrations (gateway_key, gateway_instance_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_etr_workspace_health_heartbeat
  ON execution_target_registrations (workspace_id, health, last_heartbeat_at);

-- ---------------------------------------------------------------------------
-- project_environment_definitions
-- Provider-neutral, immutable desired environment for a project.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_environment_definitions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version >= 1),
  definition_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  digest text NOT NULL CHECK (char_length(btrim(digest)) > 0),
  fingerprint text NOT NULL CHECK (char_length(btrim(fingerprint)) > 0),
  archived_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ped_active_project_fingerprint
  ON project_environment_definitions (project_id, fingerprint)
  WHERE archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ped_project_version
  ON project_environment_definitions (project_id, version);

-- ---------------------------------------------------------------------------
-- project_resource_sources
-- Typed source descriptor for a project resource. No remote paths or secrets.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_resource_sources (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  resource_id text NOT NULL REFERENCES project_resources (id) ON DELETE CASCADE,
  execution_target_id text REFERENCES execution_targets (id) ON DELETE CASCADE,
  source_kind text NOT NULL CHECK (char_length(btrim(source_kind)) > 0),
  descriptor_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_revision text,
  observed_content_digest text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE INDEX IF NOT EXISTS idx_prs_resource_target
  ON project_resource_sources (resource_id, execution_target_id);
CREATE INDEX IF NOT EXISTS idx_prs_project_source_kind
  ON project_resource_sources (project_id, source_kind);

-- ---------------------------------------------------------------------------
-- execution_request_snapshots
-- Immutable VirtualExecutionQueueItemV1 payload for one queued request.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS execution_request_snapshots (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  execution_request_id text NOT NULL REFERENCES execution_requests (id) ON DELETE CASCADE,
  schema_version text NOT NULL CHECK (char_length(btrim(schema_version)) > 0),
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_digest text NOT NULL CHECK (char_length(btrim(payload_digest)) > 0),
  created_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ers_execution_request
  ON execution_request_snapshots (execution_request_id);
CREATE INDEX IF NOT EXISTS idx_ers_workspace_created
  ON execution_request_snapshots (workspace_id, created_at);

-- ---------------------------------------------------------------------------
-- execution_request_grants
-- Opaque, request-scoped grant records. Never bearer values.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS execution_request_grants (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  execution_request_id text NOT NULL REFERENCES execution_requests (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (char_length(btrim(kind)) > 0),
  scope_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  grant_hash text NOT NULL CHECK (char_length(btrim(grant_hash)) > 0),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_erg_request_kind
  ON execution_request_grants (execution_request_id, kind);
CREATE INDEX IF NOT EXISTS idx_erg_workspace_expires
  ON execution_request_grants (workspace_id, expires_at);

-- ---------------------------------------------------------------------------
-- execution_request_observations
-- Append-only gateway observations; monotonic per-request sequence.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS execution_request_observations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  execution_request_id text NOT NULL REFERENCES execution_requests (id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence >= 0),
  kind text NOT NULL CHECK (char_length(btrim(kind)) > 0),
  observation_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ero_request_sequence
  ON execution_request_observations (execution_request_id, sequence);
CREATE INDEX IF NOT EXISTS idx_ero_workspace_created
  ON execution_request_observations (workspace_id, created_at);

-- ---------------------------------------------------------------------------
-- mission_target_resources
-- Durable, summarized external lifecycle-resource state for mission views.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mission_target_resources (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  mission_id text NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
  execution_target_id text NOT NULL REFERENCES execution_targets (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (char_length(btrim(kind)) > 0),
  external_id text NOT NULL CHECK (char_length(btrim(external_id)) > 0),
  state text NOT NULL CHECK (char_length(btrim(state)) > 0),
  latest_observation_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mtr_active_mission_target_kind_external
  ON mission_target_resources (mission_id, execution_target_id, kind, external_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mtr_workspace_target_kind
  ON mission_target_resources (workspace_id, execution_target_id, kind);

-- ---------------------------------------------------------------------------
-- Additive execution_requests columns for virtual launches.
-- launch_snapshot_id references the immutable snapshot built in the same
-- transaction as the queued request; never set for local targets.
-- ---------------------------------------------------------------------------
ALTER TABLE execution_requests
  ADD COLUMN IF NOT EXISTS launch_snapshot_id text
    REFERENCES execution_request_snapshots (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS failure_code text,
  ADD COLUMN IF NOT EXISTS failure_phase text,
  ADD COLUMN IF NOT EXISTS claimed_by_gateway_instance_id text;

COMMIT;
