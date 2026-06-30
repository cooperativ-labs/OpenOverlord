-- Mission search indexing data (PostgreSQL).
-- Implements the logical `search_documents` table from the schema contract and
-- backs it with a `tsvector` + GIN full-text index. Every searchable document
-- maps to a mission (`mission_id`), so search always returns missions while ranking
-- pulls content from mission titles, objectives, and mission events.
--
-- Contract: database/docs/09-database-schema-contract.md → Search

BEGIN;

CREATE TABLE search_documents (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id text REFERENCES projects (id) ON DELETE SET NULL,
  mission_id text NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('mission', 'objective', 'event')),
  entity_id text NOT NULL,
  title text,
  body_text text NOT NULL,
  content_hash text,
  source_revision integer,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  indexed_at timestamptz NOT NULL DEFAULT now(),
  search_tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body_text, '')), 'B')
  ) STORED
);

CREATE UNIQUE INDEX idx_search_documents_entity ON search_documents (workspace_id, entity_type, entity_id);
CREATE INDEX idx_search_documents_workspace_project_type ON search_documents (workspace_id, project_id, entity_type);
CREATE INDEX idx_search_documents_mission ON search_documents (mission_id);
CREATE INDEX idx_search_documents_tsv ON search_documents USING gin (search_tsv);

-- Sync triggers remove stale derived rows when source rows move across workspace IDs
-- (e.g. initial setup re-key) so retries cannot collide with idx_search_documents_entity.

-- ---------------------------------------------------------------------------
-- Mission title documents.
-- ---------------------------------------------------------------------------
CREATE FUNCTION search_documents_sync_mission() RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    DELETE FROM search_documents WHERE workspace_id = OLD.workspace_id AND mission_id = OLD.id;
    RETURN OLD;
  END IF;

  IF (TG_OP = 'UPDATE' AND NEW.workspace_id IS DISTINCT FROM OLD.workspace_id) THEN
    DELETE FROM search_documents WHERE workspace_id = OLD.workspace_id AND mission_id = OLD.id;
  END IF;

  IF (NEW.deleted_at IS NOT NULL) THEN
    -- Soft delete: drop the mission and all of its objective/event documents.
    DELETE FROM search_documents WHERE workspace_id = NEW.workspace_id AND mission_id = NEW.id;
    RETURN NEW;
  END IF;

  INSERT INTO search_documents (
    id, workspace_id, project_id, mission_id, entity_type, entity_id,
    title, body_text, source_revision, indexed_at
  ) VALUES (
    gen_random_uuid()::text, NEW.workspace_id, NEW.project_id, NEW.id, 'mission', NEW.id,
    NEW.title, NEW.title || ' ' || NEW.display_id, NEW.revision, now()
  )
  ON CONFLICT (workspace_id, entity_type, entity_id) DO UPDATE SET
    project_id = excluded.project_id,
    mission_id = excluded.mission_id,
    title = excluded.title,
    body_text = excluded.body_text,
    source_revision = excluded.source_revision,
    indexed_at = excluded.indexed_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_search_missions
AFTER INSERT OR UPDATE OR DELETE ON missions
FOR EACH ROW EXECUTE FUNCTION search_documents_sync_mission();

-- ---------------------------------------------------------------------------
-- Objective documents (title + instruction text).
-- ---------------------------------------------------------------------------
CREATE FUNCTION search_documents_sync_objective() RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    DELETE FROM search_documents
    WHERE workspace_id = OLD.workspace_id AND entity_type = 'objective' AND entity_id = OLD.id;
    RETURN OLD;
  END IF;

  IF (TG_OP = 'UPDATE' AND NEW.workspace_id IS DISTINCT FROM OLD.workspace_id) THEN
    DELETE FROM search_documents
    WHERE workspace_id = OLD.workspace_id AND entity_type = 'objective' AND entity_id = OLD.id;
  END IF;

  IF (NEW.deleted_at IS NOT NULL) THEN
    DELETE FROM search_documents
    WHERE workspace_id = NEW.workspace_id AND entity_type = 'objective' AND entity_id = NEW.id;
    RETURN NEW;
  END IF;

  INSERT INTO search_documents (
    id, workspace_id, project_id, mission_id, entity_type, entity_id,
    title, body_text, source_revision, indexed_at
  ) VALUES (
    gen_random_uuid()::text, NEW.workspace_id, NEW.project_id, NEW.mission_id, 'objective', NEW.id,
    NEW.title, btrim(coalesce(NEW.title, '') || ' ' || coalesce(NEW.instruction_text, '')), NEW.revision, now()
  )
  ON CONFLICT (workspace_id, entity_type, entity_id) DO UPDATE SET
    project_id = excluded.project_id,
    mission_id = excluded.mission_id,
    title = excluded.title,
    body_text = excluded.body_text,
    source_revision = excluded.source_revision,
    indexed_at = excluded.indexed_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_search_objectives
AFTER INSERT OR UPDATE OR DELETE ON objectives
FOR EACH ROW EXECUTE FUNCTION search_documents_sync_objective();

-- ---------------------------------------------------------------------------
-- Mission event documents (append-only summaries).
-- ---------------------------------------------------------------------------
CREATE FUNCTION search_documents_sync_event() RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    DELETE FROM search_documents
    WHERE workspace_id = OLD.workspace_id AND entity_type = 'event' AND entity_id = OLD.id;
    RETURN OLD;
  END IF;

  IF (TG_OP = 'UPDATE' AND NEW.workspace_id IS DISTINCT FROM OLD.workspace_id) THEN
    DELETE FROM search_documents
    WHERE workspace_id = OLD.workspace_id AND entity_type = 'event' AND entity_id = OLD.id;
  END IF;

  INSERT INTO search_documents (
    id, workspace_id, project_id, mission_id, entity_type, entity_id,
    title, body_text, indexed_at
  ) VALUES (
    gen_random_uuid()::text, NEW.workspace_id, NEW.project_id, NEW.mission_id, 'event', NEW.id,
    NULL, NEW.summary, now()
  )
  ON CONFLICT (workspace_id, entity_type, entity_id) DO UPDATE SET
    project_id = excluded.project_id,
    mission_id = excluded.mission_id,
    body_text = excluded.body_text,
    indexed_at = excluded.indexed_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_search_events
AFTER INSERT OR UPDATE OR DELETE ON mission_events
FOR EACH ROW EXECUTE FUNCTION search_documents_sync_event();

-- ---------------------------------------------------------------------------
-- Backfill existing rows.
-- ---------------------------------------------------------------------------
INSERT INTO search_documents (
  id, workspace_id, project_id, mission_id, entity_type, entity_id,
  title, body_text, source_revision
)
SELECT
  gen_random_uuid()::text, t.workspace_id, t.project_id, t.id, 'mission', t.id,
  t.title, t.title || ' ' || t.display_id, t.revision
FROM missions t
WHERE t.deleted_at IS NULL;

INSERT INTO search_documents (
  id, workspace_id, project_id, mission_id, entity_type, entity_id,
  title, body_text, source_revision
)
SELECT
  gen_random_uuid()::text, o.workspace_id, o.project_id, o.mission_id, 'objective', o.id,
  o.title, btrim(coalesce(o.title, '') || ' ' || coalesce(o.instruction_text, '')), o.revision
FROM objectives o
JOIN missions t ON t.id = o.mission_id AND t.deleted_at IS NULL
WHERE o.deleted_at IS NULL;

INSERT INTO search_documents (
  id, workspace_id, project_id, mission_id, entity_type, entity_id,
  title, body_text
)
SELECT
  gen_random_uuid()::text, e.workspace_id, e.project_id, e.mission_id, 'event', e.id,
  NULL, e.summary
FROM mission_events e
JOIN missions t ON t.id = e.mission_id AND t.deleted_at IS NULL;

COMMIT;
