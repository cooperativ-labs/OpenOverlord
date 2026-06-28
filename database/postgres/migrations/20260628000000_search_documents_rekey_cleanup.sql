-- Keep derived search documents clean when source rows move across workspace IDs.
--
-- The initial setup flow can re-key the seeded workspace. Source-table updates
-- fire these triggers and recreate search rows under the new workspace; the old
-- derived rows must be removed so a retry cannot collide with
-- idx_search_documents_entity.

BEGIN;

CREATE OR REPLACE FUNCTION search_documents_sync_mission() RETURNS trigger AS $$
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

CREATE OR REPLACE FUNCTION search_documents_sync_objective() RETURNS trigger AS $$
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

CREATE OR REPLACE FUNCTION search_documents_sync_event() RETURNS trigger AS $$
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

COMMIT;
