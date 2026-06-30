-- Client-reported resource availability per execution target (WS-F4).
--
-- Stores the latest `observeResource` result from desktop, browser, or runner
-- clients so hosted control planes can merge lifecycle status with target truth.
--
-- Contract: database/docs/09-database-schema-contract.md → target_resource_observations

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
