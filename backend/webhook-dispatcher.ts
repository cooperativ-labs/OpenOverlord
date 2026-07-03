import { PERMISSIONS } from '@overlord/auth';
import { bindBool, type DatabaseClient } from '@overlord/database';

import type { ServiceContext } from '../packages/core/service/context.ts';
import { newId, nowIso } from '../packages/core/service/util.ts';
import {
  buildWebhookEnvelope,
  isWebhookEventType,
  WEBHOOK_OUTBOX_TOPIC,
  type WebhookEntityRefs,
  type WebhookEventType,
  type WebhookPayloadMode
} from '../packages/core/service/webhook-events.ts';

import { requireDatabaseClient } from './db.ts';
import { actorCan } from './rbac.ts';
import {
  assertPublicWebhookTarget,
  redactSecretLikeTokens,
  signWebhookPayload
} from './webhook-security.ts';

const POLL_INTERVAL_MS = 1000;
const CLAIM_BATCH_SIZE = 10;
const REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_SNIPPET_LIMIT = 1000;
/** Backoff schedule (ms) indexed by attempt number; the last entry repeats once exhausted, then the row terminates as `failed`. */
const RETRY_BACKOFF_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000, 86_400_000];
const AUTO_DISABLE_FAILURE_THRESHOLD = 20;

interface OutboxWebhookPayload {
  subscriptionId: string;
  eventType: WebhookEventType;
  entity: WebhookEntityRefs;
  occurredAt: string;
}

interface OutboxRow {
  id: string;
  workspace_id: string;
  payload_json: string;
  attempt_count: number;
}

interface SubscriptionRow {
  id: string;
  workspace_id: string;
  project_id: string | null;
  endpoint_url: string;
  secret: string;
  payload_mode: WebhookPayloadMode;
  created_by_workspace_user_id: string;
  enabled: number | boolean;
  consecutive_failures: number;
}

/**
 * In-process, database-backed webhook delivery worker. Modeled directly on
 * `RealtimeHub`: a singleton polling loop with an idempotent `start()` and a
 * `pollNow()` nudge for snappy delivery right after a mutation, instead of a
 * separate broker (Cloud and Local both work off the same `outbox_messages`
 * table — see database schema contract -> `outbox_messages`).
 */
class WebhookDispatcher {
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;

  start(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  /** Nudge an immediate poll — mirrors `realtime.pollNow()`, called from the same `handle()` mutation hook. */
  pollNow(): void {
    void this.poll();
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    if (process.env.OVERLORD_WEBHOOKS_DISABLED === '1') return;
    this.polling = true;
    try {
      const client = requireDatabaseClient();
      for (let i = 0; i < CLAIM_BATCH_SIZE; i++) {
        const row = await claimNextOutboxMessage(client);
        if (!row) break;
        await this.deliver(client, row);
      }
    } catch (err) {
      // The poller must never throw — a bad row or a transient DB error should
      // not take down the interval; the row stays claimable/retryable.
      console.error('[webhook-dispatcher] poll failed', err);
    } finally {
      this.polling = false;
    }
  }

  private async deliver(client: DatabaseClient, row: OutboxRow): Promise<void> {
    let payload: OutboxWebhookPayload;
    try {
      payload = JSON.parse(row.payload_json) as OutboxWebhookPayload;
      if (!isWebhookEventType(payload.eventType)) throw new Error('unknown event type');
    } catch (err) {
      await markOutboxTerminal(
        client,
        row.id,
        'failed',
        `Malformed outbox payload: ${String(err)}`
      );
      return;
    }

    const subscription = (await client.get(
      `SELECT id, workspace_id, project_id, endpoint_url, secret, payload_mode,
              created_by_workspace_user_id, enabled, consecutive_failures
         FROM webhook_subscriptions WHERE id = ? AND deleted_at IS NULL`,
      [payload.subscriptionId]
    )) as SubscriptionRow | undefined;

    if (!subscription || !subscription.enabled) {
      await markOutboxTerminal(client, row.id, 'cancelled', 'Subscription disabled or deleted');
      return;
    }

    const attemptNumber = row.attempt_count + 1;
    const startedAt = Date.now();
    let responseStatus: number | null = null;
    let responseSnippet: string | null = null;
    let errorMessage: string | null = null;

    try {
      const ctx: ServiceContext = {
        db: client,
        workspace: { id: subscription.workspace_id, slug: '', name: '' },
        actorWorkspaceUserId: subscription.created_by_workspace_user_id,
        source: 'webapp'
      };

      if (subscription.payload_mode === 'full') {
        await assertOwnerCanRead(subscription);
        ctx.workspace.name = await loadWorkspaceName(client, subscription.workspace_id);
      }

      const envelope = await buildWebhookEnvelope(ctx, {
        outboxMessageId: row.id,
        type: payload.eventType,
        entity: payload.entity,
        occurredAt: payload.occurredAt,
        mode: subscription.payload_mode
      });

      const url = new URL(subscription.endpoint_url);
      await assertPublicWebhookTarget(url);

      const rawBody = JSON.stringify(envelope);
      const { header: signatureHeader } = signWebhookPayload(subscription.secret, rawBody);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'X-Overlord-Signature': signatureHeader,
            'X-Overlord-Event': payload.eventType,
            'X-Overlord-Delivery': row.id,
            'X-Overlord-Workspace': subscription.workspace_id
          },
          body: rawBody
        });
      } finally {
        clearTimeout(timeout);
      }

      responseStatus = response.status;
      const bodyText = await response.text().catch(() => '');
      responseSnippet = redactSecretLikeTokens(bodyText).slice(0, RESPONSE_SNIPPET_LIMIT);

      if (response.status < 200 || response.status >= 300) {
        errorMessage = `Endpoint responded ${response.status}`;
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    const durationMs = Date.now() - startedAt;
    const succeeded = errorMessage === null;

    await recordDeliveryAttempt(client, {
      workspaceId: subscription.workspace_id,
      subscriptionId: subscription.id,
      outboxMessageId: row.id,
      eventType: payload.eventType,
      attemptNumber,
      responseStatus,
      responseSnippet,
      error: errorMessage,
      durationMs
    });

    if (succeeded) {
      await markOutboxTerminal(client, row.id, 'sent', null);
      await recordSubscriptionSuccess(client, subscription.id);
      return;
    }

    if (attemptNumber >= RETRY_BACKOFF_MS.length) {
      await markOutboxTerminal(client, row.id, 'failed', errorMessage);
    } else {
      const delayMs = RETRY_BACKOFF_MS[Math.min(attemptNumber - 1, RETRY_BACKOFF_MS.length - 1)]!;
      await rescheduleOutbox(client, row.id, attemptNumber, delayMs, errorMessage);
    }
    await recordSubscriptionFailure(client, subscription.id, subscription.consecutive_failures);
  }
}

async function assertOwnerCanRead(subscription: SubscriptionRow): Promise<void> {
  const canRead = await actorCan(PERMISSIONS.MISSION_READ, {
    workspaceId: subscription.workspace_id,
    workspaceUserId: subscription.created_by_workspace_user_id,
    tokenScopes: null
  });
  if (!canRead) {
    throw new Error('Subscription owner can no longer read missions in this workspace');
  }
}

async function loadWorkspaceName(client: DatabaseClient, workspaceId: string): Promise<string> {
  const row = (await client.get(`SELECT name FROM workspaces WHERE id = ?`, [workspaceId])) as
    | { name: string }
    | undefined;
  return row?.name ?? '';
}

/**
 * Atomically claim the oldest due pending outbox row. Mirrors
 * `claimNextQueuedRequest` in `packages/core/service/queue-runtime.ts`:
 * `FOR UPDATE SKIP LOCKED` on Postgres for multi-instance safety, a
 * status-guarded `UPDATE` as the final compare-and-set on both dialects.
 */
async function claimNextOutboxMessage(client: DatabaseClient): Promise<OutboxRow | null> {
  return client.transaction(async tx => {
    const lockClause = tx.dialect === 'postgres' ? 'FOR UPDATE SKIP LOCKED' : '';
    const candidate = (await tx.get(
      `SELECT id, workspace_id, payload_json, attempt_count FROM outbox_messages
         WHERE topic = ? AND status = 'pending' AND available_at <= ?
         ORDER BY available_at ASC LIMIT 1 ${lockClause}`,
      [WEBHOOK_OUTBOX_TOPIC, nowIso()]
    )) as OutboxRow | undefined;
    if (!candidate) return null;

    const now = nowIso();
    const updated = await tx.run(
      `UPDATE outbox_messages SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'pending'`,
      [now, candidate.id]
    );
    if (updated.changes === 0) return null;
    return candidate;
  });
}

async function markOutboxTerminal(
  client: DatabaseClient,
  id: string,
  status: 'sent' | 'failed' | 'cancelled',
  lastError: string | null
): Promise<void> {
  await client.run(
    `UPDATE outbox_messages SET status = ?, last_error = ?, updated_at = ? WHERE id = ?`,
    [status, lastError, nowIso(), id]
  );
}

async function rescheduleOutbox(
  client: DatabaseClient,
  id: string,
  attemptCount: number,
  delayMs: number,
  lastError: string | null
): Promise<void> {
  const availableAt = new Date(Date.now() + delayMs).toISOString();
  await client.run(
    `UPDATE outbox_messages
       SET status = 'pending', attempt_count = ?, available_at = ?, last_error = ?, updated_at = ?
       WHERE id = ?`,
    [attemptCount, availableAt, lastError, nowIso(), id]
  );
}

async function recordDeliveryAttempt(
  client: DatabaseClient,
  attempt: {
    workspaceId: string;
    subscriptionId: string;
    outboxMessageId: string;
    eventType: string;
    attemptNumber: number;
    responseStatus: number | null;
    responseSnippet: string | null;
    error: string | null;
    durationMs: number;
  }
): Promise<void> {
  await client.run(
    `INSERT INTO webhook_delivery_attempts
         (id, workspace_id, subscription_id, outbox_message_id, event_type, attempt_number,
          response_status, response_snippet, error, duration_ms, attempted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId(),
      attempt.workspaceId,
      attempt.subscriptionId,
      attempt.outboxMessageId,
      attempt.eventType,
      attempt.attemptNumber,
      attempt.responseStatus,
      attempt.responseSnippet,
      attempt.error,
      attempt.durationMs,
      nowIso()
    ]
  );
}

async function recordSubscriptionSuccess(
  client: DatabaseClient,
  subscriptionId: string
): Promise<void> {
  await client.run(
    `UPDATE webhook_subscriptions
       SET consecutive_failures = 0, last_success_at = ?, updated_at = ?, revision = revision + 1
       WHERE id = ?`,
    [nowIso(), nowIso(), subscriptionId]
  );
}

async function recordSubscriptionFailure(
  client: DatabaseClient,
  subscriptionId: string,
  currentConsecutiveFailures: number
): Promise<void> {
  const now = nowIso();
  const nextFailures = currentConsecutiveFailures + 1;
  if (nextFailures >= AUTO_DISABLE_FAILURE_THRESHOLD) {
    await client.run(
      `UPDATE webhook_subscriptions
         SET consecutive_failures = ?, last_failure_at = ?, enabled = ?, disabled_reason = 'failures',
             updated_at = ?, revision = revision + 1
         WHERE id = ?`,
      [nextFailures, now, bindBool(client.dialect, false), now, subscriptionId]
    );
  } else {
    await client.run(
      `UPDATE webhook_subscriptions
         SET consecutive_failures = ?, last_failure_at = ?, updated_at = ?, revision = revision + 1
         WHERE id = ?`,
      [nextFailures, now, now, subscriptionId]
    );
  }
}

export const webhookDispatcher = new WebhookDispatcher();
