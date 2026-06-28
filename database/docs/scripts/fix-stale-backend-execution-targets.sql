-- Optional one-time admin cleanup for workspaces that stamped the hosted backend
-- host as an execution target before the client checkout bridge shipped.
--
-- Review the SELECT results before running UPDATE/DELETE statements.
-- Replace :workspace_id and :backend_host_fingerprint with your values.
-- Obtain :backend_host_fingerprint from GET /api/diagnostics/execution-target-migration
-- (field backendHostFingerprint) or from `ovld doctor` when stale targets are reported.

-- 1. List stale execution targets (backend/container host fingerprint)
SELECT et.id AS execution_target_id,
       et.label AS target_label,
       d.label AS device_label,
       d.fingerprint AS device_fingerprint
  FROM execution_targets et
  JOIN devices d
    ON d.id = et.device_id
   AND d.workspace_id = et.workspace_id
   AND d.deleted_at IS NULL
 WHERE et.workspace_id = :workspace_id
   AND et.deleted_at IS NULL
   AND d.fingerprint = :backend_host_fingerprint;

-- 2. List queued work still pinned to those targets
SELECT er.id,
       er.status,
       er.execution_target_id,
       er.project_id,
       er.mission_id,
       er.created_at
  FROM execution_requests er
 WHERE er.workspace_id = :workspace_id
   AND er.deleted_at IS NULL
   AND er.status IN ('queued', 'claimed', 'launching')
   AND er.execution_target_id IN (
     SELECT et.id
       FROM execution_targets et
       JOIN devices d ON d.id = et.device_id AND d.deleted_at IS NULL
      WHERE et.workspace_id = :workspace_id
        AND et.deleted_at IS NULL
        AND d.fingerprint = :backend_host_fingerprint
   );

-- 3. Clear stale queue rows so users can re-run from the correct client target
-- UPDATE execution_requests
--    SET status = 'cleared',
--        execution_target_id = NULL,
--        updated_at = NOW()
--  WHERE workspace_id = :workspace_id
--    AND deleted_at IS NULL
--    AND status IN ('queued', 'claimed', 'launching')
--    AND execution_target_id IN (
--      SELECT et.id
--        FROM execution_targets et
--        JOIN devices d ON d.id = et.device_id AND d.deleted_at IS NULL
--       WHERE et.workspace_id = :workspace_id
--         AND et.deleted_at IS NULL
--         AND d.fingerprint = :backend_host_fingerprint
--    );
