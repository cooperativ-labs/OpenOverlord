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

PRAGMA foreign_keys = ON;

ALTER TABLE missions ADD COLUMN blocking_question_seen_at TEXT
  CHECK (blocking_question_seen_at IS NULL OR blocking_question_seen_at GLOB '????-??-??T??:??:??.???Z');

CREATE TABLE mission_status_seen (
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  status_id  TEXT NOT NULL,
  seen_at    TEXT NOT NULL
    CHECK (seen_at GLOB '????-??-??T??:??:??.???Z'),
  PRIMARY KEY (mission_id, status_id)
);

INSERT INTO mission_status_seen (mission_id, status_id, seen_at)
SELECT id, 'blocking_question', blocking_question_seen_at
FROM missions
WHERE blocking_question_seen_at IS NOT NULL;

ALTER TABLE missions ADD COLUMN returned_to_execute_at TEXT
  CHECK (returned_to_execute_at IS NULL OR
         returned_to_execute_at GLOB '????-??-??T??:??:??.???Z');
