-- Client-reported resource availability per execution target (WS-F4).
--
-- Contract: database/docs/09-database-schema-contract.md → target_resource_observations

BEGIN;

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

COMMIT;
