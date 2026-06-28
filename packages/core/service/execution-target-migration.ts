import { backendHostFingerprint, isBackendHostFingerprint } from './execution-targets.js';
import type { ServiceContext } from './context.js';
import { isCoLocatedBackend } from './local-target/index.js';

export type StaleBackendHostExecutionTarget = {
  executionTargetId: string;
  label: string;
  deviceLabel: string | null;
  deviceFingerprint: string;
};

export type ExecutionTargetMigrationDiagnostics = {
  /** True when the service runs on a hosted backend (not loopback SQLite). */
  hostedBackend: boolean;
  backendHostFingerprint: string;
  staleBackendHostTargets: StaleBackendHostExecutionTarget[];
  staleQueuedExecutionRequestCount: number;
};

const STALE_QUEUE_STATUSES = ['queued', 'claimed', 'launching'] as const;

async function listBackendHostExecutionTargets({
  ctx
}: {
  ctx: ServiceContext;
}): Promise<StaleBackendHostExecutionTarget[]> {
  const fingerprint = backendHostFingerprint();
  const rows = (await ctx.db.all(
    `SELECT et.id AS execution_target_id,
            et.label AS target_label,
            d.label AS device_label,
            d.fingerprint AS device_fingerprint
       FROM execution_targets et
       JOIN devices d
         ON d.id = et.device_id
        AND d.workspace_id = et.workspace_id
        AND d.deleted_at IS NULL
      WHERE et.workspace_id = ?
        AND et.deleted_at IS NULL
        AND d.fingerprint = ?`,
    [ctx.workspace.id, fingerprint]
  )) as Array<{
    execution_target_id: string;
    target_label: string;
    device_label: string | null;
    device_fingerprint: string;
  }>;

  return rows.map(row => ({
    executionTargetId: row.execution_target_id,
    label: row.target_label,
    deviceLabel: row.device_label,
    deviceFingerprint: row.device_fingerprint
  }));
}

async function countQueuedRequestsForTargets({
  ctx,
  executionTargetIds
}: {
  ctx: ServiceContext;
  executionTargetIds: string[];
}): Promise<number> {
  if (executionTargetIds.length === 0) return 0;
  const placeholders = executionTargetIds.map(() => '?').join(', ');
  const row = (await ctx.db.get(
    `SELECT COUNT(*) AS count
       FROM execution_requests
      WHERE workspace_id = ?
        AND deleted_at IS NULL
        AND execution_target_id IN (${placeholders})
        AND status IN (${STALE_QUEUE_STATUSES.map(() => '?').join(', ')})`,
    [ctx.workspace.id, ...executionTargetIds, ...STALE_QUEUE_STATUSES]
  )) as { count: number | string } | undefined;
  return Number(row?.count ?? 0);
}

/**
 * Detect execution targets stamped with the hosted backend/container host fingerprint.
 * Only meaningful on hosted backends; loopback SQLite treats the backend host as the client.
 */
export async function loadExecutionTargetMigrationDiagnostics({
  ctx
}: {
  ctx: ServiceContext;
}): Promise<ExecutionTargetMigrationDiagnostics> {
  const fingerprint = backendHostFingerprint();
  const hostedBackend = !isCoLocatedBackend(ctx.db);

  if (!hostedBackend) {
    return {
      hostedBackend: false,
      backendHostFingerprint: fingerprint,
      staleBackendHostTargets: [],
      staleQueuedExecutionRequestCount: 0
    };
  }

  const staleBackendHostTargets = await listBackendHostExecutionTargets({ ctx });
  const staleQueuedExecutionRequestCount = await countQueuedRequestsForTargets({
    ctx,
    executionTargetIds: staleBackendHostTargets.map(target => target.executionTargetId)
  });

  return {
    hostedBackend: true,
    backendHostFingerprint: fingerprint,
    staleBackendHostTargets,
    staleQueuedExecutionRequestCount
  };
}

/** True when a device fingerprint matches the hosted backend process host. */
export function isStaleBackendHostDeviceFingerprint(fingerprint: string): boolean {
  return isBackendHostFingerprint(fingerprint);
}
