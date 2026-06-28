-- Client-reported mission branch state per execution target (WS-F6).
--
-- Contract: database/docs/09-database-schema-contract.md → mission_branch_observations

BEGIN;

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

COMMIT;
