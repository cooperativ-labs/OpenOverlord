-- Ticket search indexing data (PostgreSQL).
-- Implements the logical `search_documents` table from the schema contract and
-- backs it with a `tsvector` + GIN full-text index. Every searchable document
-- maps to a ticket (`ticket_id`), so search always returns tickets while ranking
-- pulls content from ticket titles, objectives, and ticket events.
--
-- Contract: database/docs/09-database-schema-contract.md → Search

BEGIN;

CREATE TABLE search_documents (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id text REFERENCES projects (id) ON DELETE SET NULL,
  ticket_id text NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('ticket', 'objective', 'event')),
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
CREATE INDEX idx_search_documents_ticket ON search_documents (ticket_id);
CREATE INDEX idx_search_documents_tsv ON search_documents USING gin (search_tsv);

-- ---------------------------------------------------------------------------
-- Ticket title documents.
-- ---------------------------------------------------------------------------
CREATE FUNCTION search_documents_sync_ticket() RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    DELETE FROM search_documents WHERE workspace_id = OLD.workspace_id AND ticket_id = OLD.id;
    RETURN OLD;
  END IF;

  IF (NEW.deleted_at IS NOT NULL) THEN
    -- Soft delete: drop the ticket and all of its objective/event documents.
    DELETE FROM search_documents WHERE workspace_id = NEW.workspace_id AND ticket_id = NEW.id;
    RETURN NEW;
  END IF;

  INSERT INTO search_documents (
    id, workspace_id, project_id, ticket_id, entity_type, entity_id,
    title, body_text, source_revision, indexed_at
  ) VALUES (
    gen_random_uuid()::text, NEW.workspace_id, NEW.project_id, NEW.id, 'ticket', NEW.id,
    NEW.title, NEW.title || ' ' || NEW.display_id, NEW.revision, now()
  )
  ON CONFLICT (workspace_id, entity_type, entity_id) DO UPDATE SET
    project_id = excluded.project_id,
    ticket_id = excluded.ticket_id,
    title = excluded.title,
    body_text = excluded.body_text,
    source_revision = excluded.source_revision,
    indexed_at = excluded.indexed_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_search_tickets
AFTER INSERT OR UPDATE OR DELETE ON tickets
FOR EACH ROW EXECUTE FUNCTION search_documents_sync_ticket();

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

  IF (NEW.deleted_at IS NOT NULL) THEN
    DELETE FROM search_documents
    WHERE workspace_id = NEW.workspace_id AND entity_type = 'objective' AND entity_id = NEW.id;
    RETURN NEW;
  END IF;

  INSERT INTO search_documents (
    id, workspace_id, project_id, ticket_id, entity_type, entity_id,
    title, body_text, source_revision, indexed_at
  ) VALUES (
    gen_random_uuid()::text, NEW.workspace_id, NEW.project_id, NEW.ticket_id, 'objective', NEW.id,
    NEW.title, btrim(coalesce(NEW.title, '') || ' ' || NEW.instruction_text), NEW.revision, now()
  )
  ON CONFLICT (workspace_id, entity_type, entity_id) DO UPDATE SET
    project_id = excluded.project_id,
    ticket_id = excluded.ticket_id,
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
-- Ticket event documents (append-only summaries).
-- ---------------------------------------------------------------------------
CREATE FUNCTION search_documents_sync_event() RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    DELETE FROM search_documents
    WHERE workspace_id = OLD.workspace_id AND entity_type = 'event' AND entity_id = OLD.id;
    RETURN OLD;
  END IF;

  INSERT INTO search_documents (
    id, workspace_id, project_id, ticket_id, entity_type, entity_id,
    title, body_text, indexed_at
  ) VALUES (
    gen_random_uuid()::text, NEW.workspace_id, NEW.project_id, NEW.ticket_id, 'event', NEW.id,
    NULL, NEW.summary, now()
  )
  ON CONFLICT (workspace_id, entity_type, entity_id) DO UPDATE SET
    project_id = excluded.project_id,
    ticket_id = excluded.ticket_id,
    body_text = excluded.body_text,
    indexed_at = excluded.indexed_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_search_events
AFTER INSERT OR UPDATE OR DELETE ON ticket_events
FOR EACH ROW EXECUTE FUNCTION search_documents_sync_event();

-- ---------------------------------------------------------------------------
-- Backfill existing rows.
-- ---------------------------------------------------------------------------
INSERT INTO search_documents (
  id, workspace_id, project_id, ticket_id, entity_type, entity_id,
  title, body_text, source_revision
)
SELECT
  gen_random_uuid()::text, t.workspace_id, t.project_id, t.id, 'ticket', t.id,
  t.title, t.title || ' ' || t.display_id, t.revision
FROM tickets t
WHERE t.deleted_at IS NULL;

INSERT INTO search_documents (
  id, workspace_id, project_id, ticket_id, entity_type, entity_id,
  title, body_text, source_revision
)
SELECT
  gen_random_uuid()::text, o.workspace_id, o.project_id, o.ticket_id, 'objective', o.id,
  o.title, btrim(coalesce(o.title, '') || ' ' || o.instruction_text), o.revision
FROM objectives o
JOIN tickets t ON t.id = o.ticket_id AND t.deleted_at IS NULL
WHERE o.deleted_at IS NULL;

INSERT INTO search_documents (
  id, workspace_id, project_id, ticket_id, entity_type, entity_id,
  title, body_text
)
SELECT
  gen_random_uuid()::text, e.workspace_id, e.project_id, e.ticket_id, 'event', e.id,
  NULL, e.summary
FROM ticket_events e
JOIN tickets t ON t.id = e.ticket_id AND t.deleted_at IS NULL;

COMMIT;
