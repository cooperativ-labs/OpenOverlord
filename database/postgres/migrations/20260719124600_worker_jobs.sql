-- worker_jobs durable background queue (coo:364 phase 3)
--
-- Implements the schema-contracted worker_jobs table so delivery composition
-- and other non-agent side effects can be leased, retried, and recovered after
-- process restart. Core job type overlord.delivery.compose.v1 is enqueued by
-- protocol delivery and consumed by the backend composition worker.

BEGIN;

CREATE TABLE IF NOT EXISTS worker_jobs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  type text NOT NULL CHECK (char_length(btrim(type)) > 0),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  priority integer NOT NULL DEFAULT 100,
  run_after timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  locked_by text,
  locked_until timestamptz,
  payload_json jsonb NOT NULL,
  last_error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE INDEX IF NOT EXISTS idx_worker_jobs_workspace_status_run_after
  ON worker_jobs (workspace_id, status, run_after, priority)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_worker_jobs_locked_until
  ON worker_jobs (locked_until)
  WHERE deleted_at IS NULL AND status = 'running';
CREATE INDEX IF NOT EXISTS idx_worker_jobs_type_status
  ON worker_jobs (type, status, run_after)
  WHERE deleted_at IS NULL;

COMMIT;
