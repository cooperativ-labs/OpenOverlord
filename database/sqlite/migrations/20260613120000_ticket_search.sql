-- Ticket search indexing data.
-- Implements the logical `search_documents` table from the schema contract and
-- backs it with a SQLite FTS5 full-text index. Every searchable document maps to
-- a ticket (`ticket_id`), so search always returns tickets while ranking pulls
-- content from ticket titles, objectives, and ticket events.
--
-- Contract: database/docs/09-database-schema-contract.md → Search

PRAGMA foreign_keys = ON;

BEGIN;

-- Portable indexing table. One row per searchable source entity (ticket title,
-- objective, or ticket event), all keyed back to the owning ticket.
CREATE TABLE search_documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects (id) ON DELETE SET NULL,
  ticket_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('ticket', 'objective', 'event')),
  entity_id TEXT NOT NULL,
  title TEXT,
  body_text TEXT NOT NULL,
  content_hash TEXT,
  source_revision INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  indexed_at TEXT NOT NULL CHECK (indexed_at GLOB '????-??-??T??:??:??.???Z')
);

CREATE UNIQUE INDEX idx_search_documents_entity ON search_documents (workspace_id, entity_type, entity_id);
CREATE INDEX idx_search_documents_workspace_project_type ON search_documents (workspace_id, project_id, entity_type);
CREATE INDEX idx_search_documents_ticket ON search_documents (ticket_id);

-- FTS5 full-text index over the indexed title/body. External-content mode keeps
-- the tokenized index in sync with `search_documents` without duplicating the
-- source text; `rowid` is the implicit rowid of `search_documents`. `ticket_id`
-- and `entity_type` ride along as UNINDEXED columns so a single full-text query
-- can return the owning ticket and source weight without joining back to the
-- base table (which would break FTS5's `bm25()` ranking context).
CREATE VIRTUAL TABLE search_documents_fts USING fts5(
  title,
  body_text,
  ticket_id UNINDEXED,
  entity_type UNINDEXED,
  content = 'search_documents',
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Standard external-content sync triggers: mirror every search_documents write
-- into the FTS index.
CREATE TRIGGER trg_search_documents_fts_ai AFTER INSERT ON search_documents BEGIN
  INSERT INTO search_documents_fts (rowid, title, body_text, ticket_id, entity_type)
  VALUES (new.rowid, new.title, new.body_text, new.ticket_id, new.entity_type);
END;

CREATE TRIGGER trg_search_documents_fts_ad AFTER DELETE ON search_documents BEGIN
  INSERT INTO search_documents_fts (search_documents_fts, rowid, title, body_text, ticket_id, entity_type)
  VALUES ('delete', old.rowid, old.title, old.body_text, old.ticket_id, old.entity_type);
END;

CREATE TRIGGER trg_search_documents_fts_au AFTER UPDATE ON search_documents BEGIN
  INSERT INTO search_documents_fts (search_documents_fts, rowid, title, body_text, ticket_id, entity_type)
  VALUES ('delete', old.rowid, old.title, old.body_text, old.ticket_id, old.entity_type);
  INSERT INTO search_documents_fts (rowid, title, body_text, ticket_id, entity_type)
  VALUES (new.rowid, new.title, new.body_text, new.ticket_id, new.entity_type);
END;

-- ---------------------------------------------------------------------------
-- Ticket title documents.
-- ---------------------------------------------------------------------------
CREATE TRIGGER trg_search_tickets_ai AFTER INSERT ON tickets
WHEN new.deleted_at IS NULL
BEGIN
  INSERT INTO search_documents (
    id, workspace_id, project_id, ticket_id, entity_type, entity_id,
    title, body_text, source_revision, indexed_at
  ) VALUES (
    lower(hex(randomblob(16))), new.workspace_id, new.project_id, new.id, 'ticket', new.id,
    new.title, new.title || ' ' || new.display_id, new.revision,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  ON CONFLICT (workspace_id, entity_type, entity_id) DO UPDATE SET
    project_id = excluded.project_id,
    ticket_id = excluded.ticket_id,
    title = excluded.title,
    body_text = excluded.body_text,
    source_revision = excluded.source_revision,
    indexed_at = excluded.indexed_at;
END;

CREATE TRIGGER trg_search_tickets_au AFTER UPDATE ON tickets
WHEN new.deleted_at IS NULL
BEGIN
  INSERT INTO search_documents (
    id, workspace_id, project_id, ticket_id, entity_type, entity_id,
    title, body_text, source_revision, indexed_at
  ) VALUES (
    lower(hex(randomblob(16))), new.workspace_id, new.project_id, new.id, 'ticket', new.id,
    new.title, new.title || ' ' || new.display_id, new.revision,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  ON CONFLICT (workspace_id, entity_type, entity_id) DO UPDATE SET
    project_id = excluded.project_id,
    ticket_id = excluded.ticket_id,
    title = excluded.title,
    body_text = excluded.body_text,
    source_revision = excluded.source_revision,
    indexed_at = excluded.indexed_at;
END;

-- A soft-deleted ticket removes every document for that ticket (its title plus
-- its objectives and events), so deleted tickets never surface in search.
CREATE TRIGGER trg_search_tickets_soft_delete AFTER UPDATE ON tickets
WHEN new.deleted_at IS NOT NULL AND old.deleted_at IS NULL
BEGIN
  DELETE FROM search_documents WHERE workspace_id = new.workspace_id AND ticket_id = new.id;
END;

CREATE TRIGGER trg_search_tickets_ad AFTER DELETE ON tickets BEGIN
  DELETE FROM search_documents WHERE workspace_id = old.workspace_id AND ticket_id = old.id;
END;

-- ---------------------------------------------------------------------------
-- Objective documents (title + instruction text).
-- ---------------------------------------------------------------------------
CREATE TRIGGER trg_search_objectives_ai AFTER INSERT ON objectives
WHEN new.deleted_at IS NULL
BEGIN
  INSERT INTO search_documents (
    id, workspace_id, project_id, ticket_id, entity_type, entity_id,
    title, body_text, source_revision, indexed_at
  ) VALUES (
    lower(hex(randomblob(16))), new.workspace_id, new.project_id, new.ticket_id, 'objective', new.id,
    new.title, trim(coalesce(new.title, '') || ' ' || new.instruction_text), new.revision,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  ON CONFLICT (workspace_id, entity_type, entity_id) DO UPDATE SET
    project_id = excluded.project_id,
    ticket_id = excluded.ticket_id,
    title = excluded.title,
    body_text = excluded.body_text,
    source_revision = excluded.source_revision,
    indexed_at = excluded.indexed_at;
END;

CREATE TRIGGER trg_search_objectives_au AFTER UPDATE ON objectives
WHEN new.deleted_at IS NULL
BEGIN
  INSERT INTO search_documents (
    id, workspace_id, project_id, ticket_id, entity_type, entity_id,
    title, body_text, source_revision, indexed_at
  ) VALUES (
    lower(hex(randomblob(16))), new.workspace_id, new.project_id, new.ticket_id, 'objective', new.id,
    new.title, trim(coalesce(new.title, '') || ' ' || new.instruction_text), new.revision,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  ON CONFLICT (workspace_id, entity_type, entity_id) DO UPDATE SET
    project_id = excluded.project_id,
    ticket_id = excluded.ticket_id,
    title = excluded.title,
    body_text = excluded.body_text,
    source_revision = excluded.source_revision,
    indexed_at = excluded.indexed_at;
END;

CREATE TRIGGER trg_search_objectives_soft_delete AFTER UPDATE ON objectives
WHEN new.deleted_at IS NOT NULL AND old.deleted_at IS NULL
BEGIN
  DELETE FROM search_documents
  WHERE workspace_id = new.workspace_id AND entity_type = 'objective' AND entity_id = new.id;
END;

CREATE TRIGGER trg_search_objectives_ad AFTER DELETE ON objectives BEGIN
  DELETE FROM search_documents
  WHERE workspace_id = old.workspace_id AND entity_type = 'objective' AND entity_id = old.id;
END;

-- ---------------------------------------------------------------------------
-- Ticket event documents (append-only summaries).
-- ---------------------------------------------------------------------------
CREATE TRIGGER trg_search_events_ai AFTER INSERT ON ticket_events BEGIN
  INSERT INTO search_documents (
    id, workspace_id, project_id, ticket_id, entity_type, entity_id,
    title, body_text, indexed_at
  ) VALUES (
    lower(hex(randomblob(16))), new.workspace_id, new.project_id, new.ticket_id, 'event', new.id,
    NULL, new.summary,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  ON CONFLICT (workspace_id, entity_type, entity_id) DO UPDATE SET
    project_id = excluded.project_id,
    ticket_id = excluded.ticket_id,
    body_text = excluded.body_text,
    indexed_at = excluded.indexed_at;
END;

CREATE TRIGGER trg_search_events_ad AFTER DELETE ON ticket_events BEGIN
  DELETE FROM search_documents
  WHERE workspace_id = old.workspace_id AND entity_type = 'event' AND entity_id = old.id;
END;

-- ---------------------------------------------------------------------------
-- Backfill existing rows. These inserts fire the FTS sync triggers above, so the
-- full-text index is populated as part of the backfill.
-- ---------------------------------------------------------------------------
INSERT INTO search_documents (
  id, workspace_id, project_id, ticket_id, entity_type, entity_id,
  title, body_text, source_revision, indexed_at
)
SELECT
  lower(hex(randomblob(16))), t.workspace_id, t.project_id, t.id, 'ticket', t.id,
  t.title, t.title || ' ' || t.display_id, t.revision,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM tickets t
WHERE t.deleted_at IS NULL;

INSERT INTO search_documents (
  id, workspace_id, project_id, ticket_id, entity_type, entity_id,
  title, body_text, source_revision, indexed_at
)
SELECT
  lower(hex(randomblob(16))), o.workspace_id, o.project_id, o.ticket_id, 'objective', o.id,
  o.title, trim(coalesce(o.title, '') || ' ' || o.instruction_text), o.revision,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM objectives o
JOIN tickets t ON t.id = o.ticket_id AND t.deleted_at IS NULL
WHERE o.deleted_at IS NULL;

INSERT INTO search_documents (
  id, workspace_id, project_id, ticket_id, entity_type, entity_id,
  title, body_text, indexed_at
)
SELECT
  lower(hex(randomblob(16))), e.workspace_id, e.project_id, e.ticket_id, 'event', e.id,
  NULL, e.summary,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM ticket_events e
JOIN tickets t ON t.id = e.ticket_id AND t.deleted_at IS NULL;

COMMIT;
