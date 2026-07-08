ALTER TABLE mission_branch_observations
  ADD COLUMN IF NOT EXISTS resource_key text NOT NULL DEFAULT 'project';

DROP INDEX IF EXISTS idx_mission_branch_observations_target_mission;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_branch_observations_target_mission_resource
  ON mission_branch_observations (execution_target_id, mission_id, resource_key);
