-- Mission search indexing data.
-- Implements the logical `search_documents` table from the schema contract and
-- backs it with a SQLite FTS5 full-text index. Every searchable document maps to
-- a mission (`mission_id`), so search always returns missions while ranking pulls
-- content from mission titles, objectives, and mission events.
--
-- Contract: database/docs/09-database-schema-contract.md → Search

PRAGMA foreign_keys = ON;

BEGIN;

-- Portable indexing table. One row per searchable source entity (mission title,
-- objective, or mission event), all keyed back to the owning mission.
CREATE TABLE search_documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects (id) ON DELETE SET NULL,
  mission_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('mission', 'objective', 'event')),
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
CREATE INDEX idx_search_documents_mission ON search_documents (mission_id);

-- FTS5 full-text index over the indexed title/body. External-content mode keeps
-- the tokenized index in sync with `search_documents` without duplicating the
-- source text; `rowid` is the implicit rowid of `search_documents`. `mission_id`
-- and `entity_type` ride along as UNINDEXED columns so a single full-text query
-- can return the owning mission and source weight without joining back to the
-- base table (which would break FTS5's `bm25()` ranking context).
CREATE VIRTUAL TABLE search_documents_fts USING fts5(
  title,
  body_text,
  mission_id UNINDEXED,
  entity_type UNINDEXED,
  content = 'search_documents',
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Standard external-content sync triggers: mirror every search_documents write
-- into the FTS index.
CREATE TRIGGER trg_search_documents_fts_ai AFTER INSERT ON search_documents BEGIN
  INSERT INTO search_documents_fts (rowid, title, body_text, mission_id, entity_type)
  VALUES (new.rowid, new.title, new.body_text, new.mission_id, new.entity_type);
END;

CREATE TRIGGER trg_search_documents_fts_ad AFTER DELETE ON search_documents BEGIN
  INSERT INTO search_documents_fts (search_documents_fts, rowid, title, body_text, mission_id, entity_type)
  VALUES ('delete', old.rowid, old.title, old.body_text, old.mission_id, old.entity_type);
END;

CREATE TRIGGER trg_search_documents_fts_au AFTER UPDATE ON search_documents BEGIN
  INSERT INTO search_documents_fts (search_documents_fts, rowid, title, body_text, mission_id, entity_type)
  VALUES ('delete', old.rowid, old.title, old.body_text, old.mission_id, old.entity_type);
  INSERT INTO search_documents_fts (rowid, title, body_text, mission_id, entity_type)
  VALUES (new.rowid, new.title, new.body_text, new.mission_id, new.entity_type);
END;

-- ---------------------------------------------------------------------------
-- Mission title documents.
-- ---------------------------------------------------------------------------
CREATE TRIGGER trg_search_missions_ai AFTER INSERT ON missions
WHEN new.deleted_at IS NULL
BEGIN
  INSERT INTO search_documents (
    id, workspace_id, project_id, mission_id, entity_type, entity_id,
    title, body_text, source_revision, indexed_at
  ) VALUES (
    lower(hex(randomblob(16))), new.workspace_id, new.project_id, new.id, 'mission', new.id,
    new.title, new.title || ' ' || new.display_id, new.revision,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  ON CONFLICT (workspace_id, entity_type, entity_id) DO UPDATE SET
    project_id = excluded.project_id,
    mission_id = excluded.mission_id,
    title = excluded.title,
    body_text = excluded.body_text,
    source_revision = excluded.source_revision,
    indexed_at = excluded.indexed_at;
END;

CREATE TRIGGER trg_search_missions_au AFTER UPDATE ON missions
WHEN new.deleted_at IS NULL
BEGIN
  INSERT INTO search_documents (
    id, workspace_id, project_id, mission_id, entity_type, entity_id,
    title, body_text, source_revision, indexed_at
  ) VALUES (
    lower(hex(randomblob(16))), new.workspace_id, new.project_id, new.id, 'mission', new.id,
    new.title, new.title || ' ' || new.display_id, new.revision,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  ON CONFLICT (workspace_id, entity_type, entity_id) DO UPDATE SET
    project_id = excluded.project_id,
    mission_id = excluded.mission_id,
    title = excluded.title,
    body_text = excluded.body_text,
    source_revision = excluded.source_revision,
    indexed_at = excluded.indexed_at;
END;

-- A soft-deleted mission removes every document for that mission (its title plus
-- its objectives and events), so deleted missions never surface in search.
CREATE TRIGGER trg_search_missions_soft_delete AFTER UPDATE ON missions
WHEN new.deleted_at IS NOT NULL AND old.deleted_at IS NULL
BEGIN
  DELETE FROM search_documents WHERE workspace_id = new.workspace_id AND mission_id = new.id;
END;

CREATE TRIGGER trg_search_missions_ad AFTER DELETE ON missions BEGIN
  DELETE FROM search_documents WHERE workspace_id = old.workspace_id AND mission_id = old.id;
END;

-- ---------------------------------------------------------------------------
-- Objective documents (title + instruction text).
-- ---------------------------------------------------------------------------
CREATE TRIGGER trg_search_objectives_ai AFTER INSERT ON objectives
WHEN new.deleted_at IS NULL
BEGIN
  INSERT INTO search_documents (
    id, workspace_id, project_id, mission_id, entity_type, entity_id,
    title, body_text, source_revision, indexed_at
  ) VALUES (
    lower(hex(randomblob(16))), new.workspace_id, new.project_id, new.mission_id, 'objective', new.id,
    new.title, trim(coalesce(new.title, '') || ' ' || coalesce(new.instruction_text, '')), new.revision,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  ON CONFLICT (workspace_id, entity_type, entity_id) DO UPDATE SET
    project_id = excluded.project_id,
    mission_id = excluded.mission_id,
    title = excluded.title,
    body_text = excluded.body_text,
    source_revision = excluded.source_revision,
    indexed_at = excluded.indexed_at;
END;

CREATE TRIGGER trg_search_objectives_au AFTER UPDATE ON objectives
WHEN new.deleted_at IS NULL
BEGIN
  INSERT INTO search_documents (
    id, workspace_id, project_id, mission_id, entity_type, entity_id,
    title, body_text, source_revision, indexed_at
  ) VALUES (
    lower(hex(randomblob(16))), new.workspace_id, new.project_id, new.mission_id, 'objective', new.id,
    new.title, trim(coalesce(new.title, '') || ' ' || coalesce(new.instruction_text, '')), new.revision,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  ON CONFLICT (workspace_id, entity_type, entity_id) DO UPDATE SET
    project_id = excluded.project_id,
    mission_id = excluded.mission_id,
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
-- Mission event documents (append-only summaries).
-- ---------------------------------------------------------------------------
CREATE TRIGGER trg_search_events_ai AFTER INSERT ON mission_events BEGIN
  INSERT INTO search_documents (
    id, workspace_id, project_id, mission_id, entity_type, entity_id,
    title, body_text, indexed_at
  ) VALUES (
    lower(hex(randomblob(16))), new.workspace_id, new.project_id, new.mission_id, 'event', new.id,
    NULL, new.summary,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  ON CONFLICT (workspace_id, entity_type, entity_id) DO UPDATE SET
    project_id = excluded.project_id,
    mission_id = excluded.mission_id,
    body_text = excluded.body_text,
    indexed_at = excluded.indexed_at;
END;

CREATE TRIGGER trg_search_events_ad AFTER DELETE ON mission_events BEGIN
  DELETE FROM search_documents
  WHERE workspace_id = old.workspace_id AND entity_type = 'event' AND entity_id = old.id;
END;

-- ---------------------------------------------------------------------------
-- Backfill existing rows. These inserts fire the FTS sync triggers above, so the
-- full-text index is populated as part of the backfill.
-- ---------------------------------------------------------------------------
INSERT INTO search_documents (
  id, workspace_id, project_id, mission_id, entity_type, entity_id,
  title, body_text, source_revision, indexed_at
)
SELECT
  lower(hex(randomblob(16))), t.workspace_id, t.project_id, t.id, 'mission', t.id,
  t.title, t.title || ' ' || t.display_id, t.revision,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM missions t
WHERE t.deleted_at IS NULL;

INSERT INTO search_documents (
  id, workspace_id, project_id, mission_id, entity_type, entity_id,
  title, body_text, source_revision, indexed_at
)
SELECT
  lower(hex(randomblob(16))), o.workspace_id, o.project_id, o.mission_id, 'objective', o.id,
  o.title, trim(coalesce(o.title, '') || ' ' || coalesce(o.instruction_text, '')), o.revision,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM objectives o
JOIN missions t ON t.id = o.mission_id AND t.deleted_at IS NULL
WHERE o.deleted_at IS NULL;

INSERT INTO search_documents (
  id, workspace_id, project_id, mission_id, entity_type, entity_id,
  title, body_text, indexed_at
)
SELECT
  lower(hex(randomblob(16))), e.workspace_id, e.project_id, e.mission_id, 'event', e.id,
  NULL, e.summary,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM mission_events e
JOIN missions t ON t.id = e.mission_id AND t.deleted_at IS NULL;

COMMIT;
