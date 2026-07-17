-- mission_status_seen + returned_to_execute_at (coo:341)
--
-- Adds missions.blocking_question_seen_at for backward compatibility, then
-- introduces mission_status_seen(mission_id, status_id, seen_at) as the
-- generalized store for per-status seen timestamps. Aggregates read from
-- mission_status_seen; existing blocking_question_seen_at values are migrated in.
--
-- Also adds missions.returned_to_execute_at, stamped whenever a mission
-- transitions into an execute-type status from review/complete/blocked, to drive
-- the returned_to_execute card indicator and native notification.

BEGIN;

ALTER TABLE missions
  ADD COLUMN IF NOT EXISTS blocking_question_seen_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS mission_status_seen (
  mission_id TEXT        NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  status_id  TEXT        NOT NULL,
  seen_at    TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (mission_id, status_id)
);

INSERT INTO mission_status_seen (mission_id, status_id, seen_at)
SELECT id, 'blocking_question', blocking_question_seen_at
FROM missions
WHERE blocking_question_seen_at IS NOT NULL
ON CONFLICT DO NOTHING;

ALTER TABLE missions
  ADD COLUMN IF NOT EXISTS returned_to_execute_at TIMESTAMPTZ;

COMMIT;
