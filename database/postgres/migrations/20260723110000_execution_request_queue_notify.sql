-- Postgres-only wake hints for runner claim long-polls (coo:414).
-- Claim authorization and compare-and-set remain in the service layer.
BEGIN;

CREATE OR REPLACE FUNCTION notify_execution_request_queued()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.deleted_at IS NULL
     AND NEW.status = 'queued'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'queued') THEN
    PERFORM pg_notify(
      'overlord_execution_request_queue',
      json_build_object('workspaceId', NEW.workspace_id, 'projectId', NEW.project_id)::text
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS execution_requests_queue_notify ON execution_requests;
CREATE TRIGGER execution_requests_queue_notify
  AFTER INSERT OR UPDATE OF status ON execution_requests
  FOR EACH ROW EXECUTE FUNCTION notify_execution_request_queued();

COMMIT;
