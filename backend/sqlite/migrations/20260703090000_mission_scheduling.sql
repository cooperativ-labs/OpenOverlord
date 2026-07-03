-- Mission scheduling (coo:124): repeating schedules that compute a mission's
-- due date and, on completion, spawn a duplicate mission for the next occurrence.
-- Ported from automations/src/scheduling-engine (see schedulingEngine.md) onto
-- the mission model; see planning/feature-plans/mission-scheduling-engine.md §5.
--
-- Contract: database/docs/09-database-schema-contract.md → schedules / missions.schedule_id

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  name TEXT,
  period_type TEXT NOT NULL DEFAULT 'd' CHECK (period_type IN ('d', 'w', 'm')),
  period_interval INTEGER NOT NULL DEFAULT 1 CHECK (period_interval >= 1),
  weeks_of_month_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(weeks_of_month_json)),
  days_of_month_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(days_of_month_json)),
  days_of_week_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(days_of_week_json)),
  start_date TEXT CHECK (start_date IS NULL OR start_date GLOB '????-??-??T??:??:??.???Z'),
  timezone TEXT NOT NULL CHECK (length(trim(timezone)) > 0),
  -- Configurable duplicate target status. NULL falls back to the workspace
  -- default/next-up status at duplication time (see backend/repository.ts
  -- createScheduledDuplicateIfNeeded).
  next_status_id TEXT REFERENCES workspace_statuses (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (workspace_id, next_status_id) REFERENCES workspace_statuses (workspace_id, id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX idx_schedules_workspace_id ON schedules (workspace_id, id);
CREATE INDEX idx_schedules_workspace_next_status ON schedules (workspace_id, next_status_id);

-- missions.schedule_id: not composite/workspace-scoped at the DB layer (SQLite's
-- ALTER TABLE ADD COLUMN cannot add a table-level composite FOREIGN KEY without a
-- full table rebuild, matching this repo's precedent for other columns added via
-- ALTER TABLE, e.g. missions.active_branch); every read/write path scopes by
-- workspace_id in application code the same way it already does for every query.
ALTER TABLE missions ADD COLUMN schedule_id TEXT REFERENCES schedules (id) ON DELETE SET NULL;
ALTER TABLE missions ADD COLUMN due_datetime TEXT
  CHECK (due_datetime IS NULL OR due_datetime GLOB '????-??-??T??:??:??.???Z');

CREATE INDEX idx_missions_schedule_id ON missions (schedule_id) WHERE schedule_id IS NOT NULL;
CREATE INDEX idx_missions_project_due_datetime ON missions (project_id, due_datetime)
  WHERE due_datetime IS NOT NULL AND deleted_at IS NULL;
