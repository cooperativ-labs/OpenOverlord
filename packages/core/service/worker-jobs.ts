import type { ServiceContext } from './context.js';
import { newId, nowIso } from './util.js';

/** Core-documented worker job type for asynchronous delivery presentation composition. */
export const DELIVERY_COMPOSE_JOB_TYPE = 'overlord.delivery.compose.v1';

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_PRIORITY = 50;

function deliveryIdPredicate(dialect: ServiceContext['db']['dialect']): string {
  return dialect === 'postgres'
    ? "payload_json->>'deliveryId' = ?"
    : "json_extract(payload_json, '$.deliveryId') = ?";
}

/**
 * Enqueues a durable compose job for one delivery. Safe to call inside the
 * delivery transaction; duplicate active jobs for the same delivery are skipped.
 */
export async function enqueueDeliveryComposeJob({
  ctx,
  deliveryId,
  now = nowIso(),
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  priority = DEFAULT_PRIORITY
}: {
  ctx: ServiceContext;
  deliveryId: string;
  now?: string;
  maxAttempts?: number;
  priority?: number;
}): Promise<{ jobId: string | null; enqueued: boolean }> {
  const existing = (await ctx.db.get(
    `SELECT id FROM worker_jobs
       WHERE workspace_id = ?
         AND type = ?
         AND status IN ('queued', 'running')
         AND deleted_at IS NULL
         AND ${deliveryIdPredicate(ctx.db.dialect)}
       ORDER BY created_at ASC
       LIMIT 1`,
    [ctx.workspace.id, DELIVERY_COMPOSE_JOB_TYPE, deliveryId]
  )) as { id: string } | undefined;
  if (existing) {
    return { jobId: existing.id, enqueued: false };
  }

  const jobId = newId();
  await ctx.db.run(
    `INSERT INTO worker_jobs
         (id, workspace_id, type, status, priority, run_after, attempt_count, max_attempts,
          payload_json, created_at, updated_at, revision)
       VALUES (?, ?, ?, 'queued', ?, ?, 0, ?, ?, ?, ?, 1)`,
    [
      jobId,
      ctx.workspace.id,
      DELIVERY_COMPOSE_JOB_TYPE,
      priority,
      now,
      maxAttempts,
      JSON.stringify({ deliveryId }),
      now,
      now
    ]
  );
  // Structured operational metric only: delivery content and prompt inputs are
  // intentionally never logged.
  console.info(
    '[delivery-compose-worker]',
    JSON.stringify({ event: 'delivery_compose_queued', deliveryId, jobId, maxAttempts, priority })
  );
  return { jobId, enqueued: true };
}
