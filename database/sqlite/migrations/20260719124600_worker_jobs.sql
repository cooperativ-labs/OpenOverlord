-- worker_jobs durable background queue (coo:364 phase 3)
--
-- Implements the schema-contracted worker_jobs table so delivery composition
-- and other non-agent side effects can be leased, retried, and recovered after
-- process restart. Core job type overlord.delivery.compose.v1 is enqueued by
-- protocol delivery and consumed by the backend composition worker.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS worker_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  type TEXT NOT NULL CHECK (length(trim(type)) > 0),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  priority INTEGER NOT NULL DEFAULT 100,
  run_after TEXT NOT NULL CHECK (run_after GLOB '????-??-??T??:??:??.???Z'),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  locked_by TEXT,
  locked_until TEXT CHECK (locked_until IS NULL OR locked_until GLOB '????-??-??T??:??:??.???Z'),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  last_error TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
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
