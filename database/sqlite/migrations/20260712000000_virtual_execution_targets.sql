-- Virtual execution targets (coo:258, contract 3)
--
-- Adopts the contract-v3 provider-neutral virtual execution target schema
-- (database/docs/09-database-schema-contract.md → "Virtual Execution Targets"):
--   * widens execution_targets.type to include the core 'virtual' value,
--   * creates the seven core virtual-target tables, and
--   * adds four additive execution_requests columns.
--
-- Desired launch state (the immutable execution_request_snapshots payload) is
-- kept separate from observed realization state (append-only
-- execution_request_observations). Grants store only hashes/opaque IDs, source
-- descriptors store credential-reference IDs and opaque handles, and
-- observations are bounded and redacted. execution_requests.status is unchanged.

-- SQLite cannot ALTER a CHECK constraint in place, so execution_targets is
-- rebuilt to widen its type CHECK. Foreign keys are disabled for the rebuild so
-- the drop/rename does not trip the many child tables that reference it; the
-- renamed table re-satisfies those references by name.
PRAGMA foreign_keys = OFF;

CREATE TABLE execution_targets_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  device_id TEXT REFERENCES devices (id) ON DELETE SET NULL,
  owner_workspace_user_id TEXT REFERENCES workspace_users (id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('local', 'ssh', 'virtual')),
  label TEXT NOT NULL CHECK (length(trim(label)) > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'unavailable')),
  connection_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(connection_json)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CHECK (type <> 'local' OR device_id IS NOT NULL)
);

INSERT INTO execution_targets_new (
  id, workspace_id, device_id, owner_workspace_user_id, type, label, status,
  connection_json, created_at, updated_at, deleted_at, revision
)
SELECT
  id, workspace_id, device_id, owner_workspace_user_id, type, label, status,
  connection_json, created_at, updated_at, deleted_at, revision
FROM execution_targets;

DROP TABLE execution_targets;
ALTER TABLE execution_targets_new RENAME TO execution_targets;

CREATE INDEX idx_execution_targets_workspace_type_status ON execution_targets (workspace_id, type, status);
CREATE INDEX idx_execution_targets_workspace_device ON execution_targets (workspace_id, device_id);

-- ---------------------------------------------------------------------------
-- execution_target_registrations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS execution_target_registrations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  execution_target_id TEXT NOT NULL REFERENCES execution_targets (id) ON DELETE CASCADE,
  gateway_key TEXT NOT NULL CHECK (length(trim(gateway_key)) > 0),
  gateway_instance_id TEXT NOT NULL CHECK (length(trim(gateway_instance_id)) > 0),
  gateway_version TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(capabilities_json)),
  supported_agents_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(supported_agents_json)),
  supported_queue_versions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(supported_queue_versions_json)),
  connection_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(connection_json)),
  health TEXT NOT NULL CHECK (length(trim(health)) > 0),
  last_heartbeat_at TEXT CHECK (last_heartbeat_at IS NULL OR last_heartbeat_at GLOB '????-??-??T??:??:??.???Z'),
  last_error_code TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX idx_etr_active_target
  ON execution_target_registrations (execution_target_id)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_etr_active_gateway_instance
  ON execution_target_registrations (gateway_key, gateway_instance_id)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_etr_workspace_health_heartbeat
  ON execution_target_registrations (workspace_id, health, last_heartbeat_at);

-- ---------------------------------------------------------------------------
-- project_environment_definitions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_environment_definitions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  definition_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(definition_json)),
  digest TEXT NOT NULL CHECK (length(trim(digest)) > 0),
  fingerprint TEXT NOT NULL CHECK (length(trim(fingerprint)) > 0),
  archived_at TEXT CHECK (archived_at IS NULL OR archived_at GLOB '????-??-??T??:??:??.???Z'),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_ped_active_project_fingerprint
  ON project_environment_definitions (project_id, fingerprint)
  WHERE archived_at IS NULL;
CREATE UNIQUE INDEX idx_ped_project_version
  ON project_environment_definitions (project_id, version);

-- ---------------------------------------------------------------------------
-- project_resource_sources
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_resource_sources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  resource_id TEXT NOT NULL REFERENCES project_resources (id) ON DELETE CASCADE,
  execution_target_id TEXT REFERENCES execution_targets (id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (length(trim(source_kind)) > 0),
  descriptor_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(descriptor_json)),
  observed_revision TEXT,
  observed_content_digest TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE INDEX idx_prs_resource_target
  ON project_resource_sources (resource_id, execution_target_id);
CREATE INDEX idx_prs_project_source_kind
  ON project_resource_sources (project_id, source_kind);

-- ---------------------------------------------------------------------------
-- execution_request_snapshots
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS execution_request_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  execution_request_id TEXT NOT NULL REFERENCES execution_requests (id) ON DELETE CASCADE,
  schema_version TEXT NOT NULL CHECK (length(trim(schema_version)) > 0),
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  payload_digest TEXT NOT NULL CHECK (length(trim(payload_digest)) > 0),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z')
);

CREATE UNIQUE INDEX idx_ers_execution_request
  ON execution_request_snapshots (execution_request_id);
CREATE INDEX idx_ers_workspace_created
  ON execution_request_snapshots (workspace_id, created_at);

-- ---------------------------------------------------------------------------
-- execution_request_grants
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS execution_request_grants (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  execution_request_id TEXT NOT NULL REFERENCES execution_requests (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (length(trim(kind)) > 0),
  scope_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(scope_json)),
  grant_hash TEXT NOT NULL CHECK (length(trim(grant_hash)) > 0),
  expires_at TEXT NOT NULL CHECK (expires_at GLOB '????-??-??T??:??:??.???Z'),
  consumed_at TEXT CHECK (consumed_at IS NULL OR consumed_at GLOB '????-??-??T??:??:??.???Z'),
  revoked_at TEXT CHECK (revoked_at IS NULL OR revoked_at GLOB '????-??-??T??:??:??.???Z'),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z')
);

CREATE INDEX idx_erg_request_kind
  ON execution_request_grants (execution_request_id, kind);
CREATE INDEX idx_erg_workspace_expires
  ON execution_request_grants (workspace_id, expires_at);

-- ---------------------------------------------------------------------------
-- execution_request_observations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS execution_request_observations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  execution_request_id TEXT NOT NULL REFERENCES execution_requests (id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  kind TEXT NOT NULL CHECK (length(trim(kind)) > 0),
  observation_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(observation_json)),
  observed_at TEXT NOT NULL CHECK (observed_at GLOB '????-??-??T??:??:??.???Z'),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z')
);

CREATE UNIQUE INDEX idx_ero_request_sequence
  ON execution_request_observations (execution_request_id, sequence);
CREATE INDEX idx_ero_workspace_created
  ON execution_request_observations (workspace_id, created_at);

-- ---------------------------------------------------------------------------
-- mission_target_resources
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mission_target_resources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  mission_id TEXT NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
  execution_target_id TEXT NOT NULL REFERENCES execution_targets (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (length(trim(kind)) > 0),
  external_id TEXT NOT NULL CHECK (length(trim(external_id)) > 0),
  state TEXT NOT NULL CHECK (length(trim(state)) > 0),
  latest_observation_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(latest_observation_json)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE UNIQUE INDEX idx_mtr_active_mission_target_kind_external
  ON mission_target_resources (mission_id, execution_target_id, kind, external_id)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_mtr_workspace_target_kind
  ON mission_target_resources (workspace_id, execution_target_id, kind);

-- ---------------------------------------------------------------------------
-- Additive execution_requests columns for virtual launches. SQLite requires one
-- ADD COLUMN per statement; launch_snapshot_id is nullable with a NULL default
-- so the REFERENCES clause is permitted by ALTER TABLE ADD COLUMN.
-- ---------------------------------------------------------------------------
ALTER TABLE execution_requests ADD COLUMN launch_snapshot_id TEXT
  REFERENCES execution_request_snapshots (id) ON DELETE SET NULL;
ALTER TABLE execution_requests ADD COLUMN failure_code TEXT;
ALTER TABLE execution_requests ADD COLUMN failure_phase TEXT;
ALTER TABLE execution_requests ADD COLUMN claimed_by_gateway_instance_id TEXT;

PRAGMA foreign_keys = ON;
