-- Client-reported mission branch state per execution target (WS-F6).
--
-- Stores the latest `deriveBranchStatus` result from desktop, browser, or runner
-- clients so hosted control planes can surface target branch truth.
--
-- Contract: database/docs/09-database-schema-contract.md → mission_branch_observations

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
