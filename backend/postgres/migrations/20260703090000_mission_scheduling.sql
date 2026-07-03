-- Mission scheduling (coo:124): repeating schedules that compute a mission's
-- due date and, on completion, spawn a duplicate mission for the next occurrence.
-- Ported from automations/src/scheduling-engine (see schedulingEngine.md) onto
-- the mission model; see planning/feature-plans/mission-scheduling-engine.md §5.
--
-- Contract: database/docs/09-database-schema-contract.md → schedules / missions.schedule_id

BEGIN;

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
  -- default/next-up status at duplication time (see backend/repository.ts
  -- createScheduledDuplicateIfNeeded).
  next_status_id text REFERENCES workspace_statuses (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (workspace_id, next_status_id) REFERENCES workspace_statuses (workspace_id, id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX idx_schedules_workspace_id ON schedules (workspace_id, id);
CREATE INDEX idx_schedules_workspace_next_status ON schedules (workspace_id, next_status_id);

ALTER TABLE missions ADD COLUMN schedule_id text;
ALTER TABLE missions ADD COLUMN due_datetime timestamptz;

-- Postgres can add the org-scoped composite FK cheaply (no table rebuild, unlike
-- SQLite); a NULL schedule_id is not checked (MATCH SIMPLE), so unscheduled
-- missions are unaffected.
ALTER TABLE missions
  ADD CONSTRAINT missions_schedule_id_fkey
  FOREIGN KEY (workspace_id, schedule_id) REFERENCES schedules (workspace_id, id) ON DELETE SET NULL;

CREATE INDEX idx_missions_schedule_id ON missions (schedule_id) WHERE schedule_id IS NOT NULL;
CREATE INDEX idx_missions_project_due_datetime ON missions (project_id, due_datetime)
  WHERE due_datetime IS NOT NULL AND deleted_at IS NULL;

COMMIT;
