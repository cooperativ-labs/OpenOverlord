import type {
  CreateWebhookSubscriptionBody,
  CreateWebhookSubscriptionResultDto,
  RotateWebhookSecretResultDto,
  UpdateWebhookSubscriptionBody,
  WebhookDeliveryAttemptDto,
  WebhookDeliveryAttemptsPageDto,
  WebhookEventType,
  WebhookSubscriptionDto
} from '@overlord/contract';
import { bindBool, type DatabaseClient } from '@overlord/database';
import { randomBytes } from 'node:crypto';

import {
  isWebhookEventType,
  WEBHOOK_EVENT_TYPES
} from '../packages/core/service/webhook-events.ts';

import {
  DATABASE_DIALECT,
  getActiveWorkspaceId,
  getActorWorkspaceUserId,
  newId,
  nowIso,
  recordChange,
  requireDatabaseClient
} from './db.ts';
import { ApiError } from './errors.ts';
import {
  isInternalWebhookHost,
  parseWebhookEndpointUrl,
  signWebhookPayload
} from './webhook-security.ts';

const WEBHOOK_SECRET_SCHEME = 'whsec';

interface WebhookSubscriptionRow {
  id: string;
  project_id: string | null;
  name: string;
  endpoint_url: string;
  secret: string;
  event_types_json: string;
  payload_mode: 'thin' | 'full';
  created_by_workspace_user_id: string;
  enabled: number | boolean;
  disabled_reason: string | null;
  consecutive_failures: number;
  last_success_at: string | null;
  last_failure_at: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
}

// Includes `secret` (needed to sign test deliveries); `toSubscriptionDto` never
// reads or forwards it, so it never reaches a DTO response.
const SUBSCRIPTION_COLUMNS =
  'id, project_id, name, endpoint_url, secret, event_types_json, payload_mode, created_by_workspace_user_id, ' +
  'enabled, disabled_reason, consecutive_failures, last_success_at, last_failure_at, created_at, updated_at, revision';

function parseEventTypes(json: string): WebhookEventType[] {
  try {
    return (JSON.parse(json) as string[]).filter(isWebhookEventType);
  } catch {
    return [];
  }
}

function toSubscriptionDto(row: WebhookSubscriptionRow): WebhookSubscriptionDto {
  const eventTypes = parseEventTypes(row.event_types_json);
  const url = new URL(row.endpoint_url);
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    endpointUrl: row.endpoint_url,
    isInternal: isInternalWebhookHost(url.hostname),
    eventTypes,
    payloadMode: row.payload_mode,
    enabled: Boolean(row.enabled),
    disabledReason: row.disabled_reason as WebhookSubscriptionDto['disabledReason'],
    consecutiveFailures: row.consecutive_failures,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    createdByWorkspaceUserId: row.created_by_workspace_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision
  };
}

/**
 * Unlike `USER_TOKEN`s (looked up by hash), a webhook secret is looked up by
 * its owning subscription id and used directly as an HMAC key, so only the
 * raw secret is stored -- there is nothing to hash it against.
 */
function generateWebhookSecret(): { secret: string } {
  return { secret: `${WEBHOOK_SECRET_SCHEME}_${randomBytes(24).toString('hex')}` };
}

function normalizeEventTypes(input: unknown): WebhookEventType[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ApiError(400, 'eventTypes must be a non-empty array');
  }
  const unique = Array.from(new Set(input));
  for (const value of unique) {
    if (typeof value !== 'string' || !isWebhookEventType(value)) {
      throw new ApiError(
        400,
        `Unknown webhook event type: ${String(value)}. Known types: ${WEBHOOK_EVENT_TYPES.join(', ')}`
      );
    }
  }
  return unique as WebhookEventType[];
}

async function assertProjectInWorkspace(db: DatabaseClient, projectId: string): Promise<void> {
  const row = await db.get(
    `SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [projectId, getActiveWorkspaceId()]
  );
  if (!row) throw new ApiError(400, `Project not found: ${projectId}`);
}

async function loadSubscriptionForUpdate(
  db: DatabaseClient,
  id: string
): Promise<WebhookSubscriptionRow> {
  const row = (await db.get(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM webhook_subscriptions
       WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [id, getActiveWorkspaceId()]
  )) as WebhookSubscriptionRow | undefined;
  if (!row) throw new ApiError(404, 'Webhook subscription not found');
  return row;
}

export async function listWebhookSubscriptions(): Promise<WebhookSubscriptionDto[]> {
  const client = requireDatabaseClient();
  const rows = (await client.all(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM webhook_subscriptions
       WHERE workspace_id = ? AND deleted_at IS NULL
       ORDER BY created_at DESC`,
    [getActiveWorkspaceId()]
  )) as WebhookSubscriptionRow[];
  return rows.map(toSubscriptionDto);
}

export async function createWebhookSubscription(
  body: CreateWebhookSubscriptionBody
): Promise<CreateWebhookSubscriptionResultDto> {
  const name = body.name?.trim();
  if (!name) throw new ApiError(400, 'name is required');
  const url = parseWebhookEndpointUrl(body.endpointUrl);
  const eventTypes = normalizeEventTypes(body.eventTypes);
  const isInternal = isInternalWebhookHost(url.hostname);
  const payloadMode = body.payloadMode ?? (isInternal ? 'full' : 'thin');
  if (payloadMode !== 'thin' && payloadMode !== 'full') {
    throw new ApiError(400, 'payloadMode must be "thin" or "full"');
  }

  return requireDatabaseClient().transaction(async tx => {
    if (body.projectId) await assertProjectInWorkspace(tx, body.projectId);

    const actorWorkspaceUserId = getActorWorkspaceUserId();
    if (!actorWorkspaceUserId) {
      throw new ApiError(409, 'No active workspace membership for the authenticated user');
    }

    const { secret } = generateWebhookSecret();
    const id = newId();
    const now = nowIso();

    await tx.run(
      `INSERT INTO webhook_subscriptions (
           id, workspace_id, project_id, name, endpoint_url, secret, event_types_json,
           payload_mode, created_by_workspace_user_id, enabled, consecutive_failures,
           created_at, updated_at, revision
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1)`,
      [
        id,
        getActiveWorkspaceId(),
        body.projectId ?? null,
        name,
        url.toString(),
        secret,
        JSON.stringify(eventTypes),
        payloadMode,
        actorWorkspaceUserId,
        bindBool(DATABASE_DIALECT, true),
        now,
        now
      ]
    );

    await recordChange(
      {
        entityType: 'webhook_subscription',
        entityId: id,
        operation: 'insert',
        entityRevision: 1,
        projectId: body.projectId ?? null
      },
      tx
    );

    const row = (await tx.get(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM webhook_subscriptions WHERE id = ?`,
      [id]
    )) as WebhookSubscriptionRow;

    return { subscription: toSubscriptionDto(row), secret };
  });
}

export async function updateWebhookSubscription(
  id: string,
  body: UpdateWebhookSubscriptionBody
): Promise<WebhookSubscriptionDto> {
  return requireDatabaseClient().transaction(async tx => {
    const existing = await loadSubscriptionForUpdate(tx, id);

    const setClauses: string[] = [];
    const params: unknown[] = [];
    const changed: string[] = [];

    if (body.name !== undefined) {
      const name = body.name.trim();
      if (!name) throw new ApiError(400, 'name cannot be empty');
      setClauses.push('name = ?');
      params.push(name);
      changed.push('name');
    }
    if (body.endpointUrl !== undefined) {
      const url = parseWebhookEndpointUrl(body.endpointUrl);
      setClauses.push('endpoint_url = ?');
      params.push(url.toString());
      changed.push('endpoint_url');
    }
    if (body.projectId !== undefined) {
      if (body.projectId) await assertProjectInWorkspace(tx, body.projectId);
      setClauses.push('project_id = ?');
      params.push(body.projectId);
      changed.push('project_id');
    }
    if (body.eventTypes !== undefined) {
      setClauses.push('event_types_json = ?');
      params.push(JSON.stringify(normalizeEventTypes(body.eventTypes)));
      changed.push('event_types_json');
    }
    if (body.payloadMode !== undefined) {
      if (body.payloadMode !== 'thin' && body.payloadMode !== 'full') {
        throw new ApiError(400, 'payloadMode must be "thin" or "full"');
      }
      setClauses.push('payload_mode = ?');
      params.push(body.payloadMode);
      changed.push('payload_mode');
    }
    if (body.enabled !== undefined) {
      setClauses.push('enabled = ?', 'disabled_reason = ?', 'consecutive_failures = ?');
      params.push(
        bindBool(DATABASE_DIALECT, body.enabled),
        body.enabled ? null : 'manual',
        body.enabled ? 0 : existing.consecutive_failures
      );
      changed.push('enabled', 'disabled_reason');
    }

    if (setClauses.length === 0) return toSubscriptionDto(existing);

    const now = nowIso();
    const revision = existing.revision + 1;
    const updated = await tx.run(
      `UPDATE webhook_subscriptions SET ${setClauses.join(', ')}, updated_at = ?, revision = ?
         WHERE id = ? AND revision = ?`,
      [...params, now, revision, id, existing.revision]
    );
    if (updated.changes === 0)
      throw new ApiError(409, 'Webhook subscription was modified concurrently');

    await recordChange(
      {
        entityType: 'webhook_subscription',
        entityId: id,
        operation: 'update',
        entityRevision: revision,
        changedFields: changed
      },
      tx
    );

    return toSubscriptionDto(await loadSubscriptionForUpdate(tx, id));
  });
}

export async function deleteWebhookSubscription(id: string): Promise<void> {
  await requireDatabaseClient().transaction(async tx => {
    const existing = await loadSubscriptionForUpdate(tx, id);
    const now = nowIso();
    await tx.run(
      `UPDATE webhook_subscriptions SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?`,
      [now, now, id]
    );
    await recordChange(
      {
        entityType: 'webhook_subscription',
        entityId: id,
        operation: 'delete',
        entityRevision: existing.revision + 1
      },
      tx
    );
  });
}

export async function rotateWebhookSecret(id: string): Promise<RotateWebhookSecretResultDto> {
  return requireDatabaseClient().transaction(async tx => {
    const existing = await loadSubscriptionForUpdate(tx, id);
    const { secret } = generateWebhookSecret();
    const now = nowIso();
    const revision = existing.revision + 1;
    await tx.run(
      `UPDATE webhook_subscriptions SET secret = ?, updated_at = ?, revision = ? WHERE id = ?`,
      [secret, now, revision, id]
    );
    await recordChange(
      {
        entityType: 'webhook_subscription',
        entityId: id,
        operation: 'update',
        entityRevision: revision,
        changedFields: ['secret']
      },
      tx
    );
    return { subscription: toSubscriptionDto(await loadSubscriptionForUpdate(tx, id)), secret };
  });
}

/**
 * Send a synthetic `webhook.ping` delivery synchronously (outside the
 * outbox/dispatcher pipeline, which hydrates real domain events) so the
 * create dialog's "Send test delivery" button gets an immediate result and
 * the delivery log shows the attempt.
 */
export async function testWebhookSubscription(
  id: string
): Promise<{ ok: true; responseStatus: number | null }> {
  const client = requireDatabaseClient();
  const subscription = await loadSubscriptionForUpdate(client, id);
  const url = new URL(subscription.endpoint_url);

  const envelope = {
    id: newId(),
    apiVersion: '2026-07-01',
    type: 'webhook.ping',
    occurredAt: nowIso(),
    message: 'This is a test delivery from Overlord. No mission data is included.'
  };
  const rawBody = JSON.stringify(envelope);
  const { header: signatureHeader } = signWebhookPayload(subscription.secret, rawBody);

  const startedAt = Date.now();
  let responseStatus: number | null = null;
  let error: string | null = null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Overlord-Signature': signatureHeader,
          'X-Overlord-Event': 'webhook.ping',
          'X-Overlord-Delivery': envelope.id,
          'X-Overlord-Workspace': getActiveWorkspaceId()
        },
        body: rawBody
      });
    } finally {
      clearTimeout(timeout);
    }
    responseStatus = response.status;
    if (response.status < 200 || response.status >= 300) {
      error = `Endpoint responded ${response.status}`;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  await client.run(
    `INSERT INTO webhook_delivery_attempts
         (id, workspace_id, subscription_id, outbox_message_id, event_type, attempt_number,
          response_status, response_snippet, error, duration_ms, attempted_at)
       VALUES (?, ?, ?, ?, 'webhook.ping', 1, ?, NULL, ?, ?, ?)`,
    [
      newId(),
      getActiveWorkspaceId(),
      id,
      // Ping attempts are not backed by a real outbox row; the FK requires one,
      // so a lightweight cancelled placeholder row is inserted for the log join.
      await ensurePingOutboxRow(client, id),
      responseStatus,
      error,
      Date.now() - startedAt,
      nowIso()
    ]
  );

  if (error) throw new ApiError(502, `Test delivery failed: ${error}`);
  return { ok: true, responseStatus };
}

/** One throwaway `cancelled` outbox row per ping so `webhook_delivery_attempts.outbox_message_id`'s FK is satisfiable without repurposing real event rows. */
async function ensurePingOutboxRow(
  client: DatabaseClient,
  subscriptionId: string
): Promise<string> {
  const id = newId();
  const now = nowIso();
  await client.run(
    `INSERT INTO outbox_messages (id, workspace_id, topic, payload_json, status, available_at, attempt_count, created_at, updated_at)
       VALUES (?, ?, 'webhook.ping', ?, 'cancelled', ?, 0, ?, ?)`,
    [id, getActiveWorkspaceId(), JSON.stringify({ subscriptionId, ping: true }), now, now, now]
  );
  return id;
}

export async function listWebhookDeliveries(
  id: string,
  { before, limit = 25 }: { before?: string | null; limit?: number } = {}
): Promise<WebhookDeliveryAttemptsPageDto> {
  const client = requireDatabaseClient();
  await loadSubscriptionForUpdate(client, id);
  const normalizedLimit = Math.max(1, Math.min(limit, 100));

  const params: unknown[] = [id];
  let sql = `SELECT id, outbox_message_id, event_type, attempt_number, response_status, response_snippet,
                    error, duration_ms, attempted_at
               FROM webhook_delivery_attempts WHERE subscription_id = ?`;
  if (before) {
    sql += ' AND attempted_at < ?';
    params.push(before);
  }
  sql += ' ORDER BY attempted_at DESC LIMIT ?';
  params.push(normalizedLimit + 1);

  const rows = (await client.all(sql, params)) as Array<{
    id: string;
    outbox_message_id: string;
    event_type: string;
    attempt_number: number;
    response_status: number | null;
    response_snippet: string | null;
    error: string | null;
    duration_ms: number | null;
    attempted_at: string;
  }>;

  const hasMore = rows.length > normalizedLimit;
  const page = hasMore ? rows.slice(0, normalizedLimit) : rows;
  const attempts: WebhookDeliveryAttemptDto[] = page.map(row => ({
    id: row.id,
    outboxMessageId: row.outbox_message_id,
    eventType: row.event_type,
    attemptNumber: row.attempt_number,
    responseStatus: row.response_status,
    responseSnippet: row.response_snippet,
    error: row.error,
    durationMs: row.duration_ms,
    attemptedAt: row.attempted_at
  }));
  return { attempts, hasMore };
}

export async function redeliverWebhookDelivery(
  subscriptionId: string,
  outboxMessageId: string
): Promise<void> {
  const client = requireDatabaseClient();
  await loadSubscriptionForUpdate(client, subscriptionId);

  const outboxRow = (await client.get(
    `SELECT id, payload_json, workspace_id FROM outbox_messages WHERE id = ?`,
    [outboxMessageId]
  )) as { id: string; payload_json: string; workspace_id: string } | undefined;
  if (!outboxRow || outboxRow.workspace_id !== getActiveWorkspaceId()) {
    throw new ApiError(404, 'Delivery not found');
  }
  let payloadSubscriptionId: string | undefined;
  try {
    payloadSubscriptionId = (JSON.parse(outboxRow.payload_json) as { subscriptionId?: string })
      .subscriptionId;
  } catch {
    throw new ApiError(400, 'Malformed delivery payload');
  }
  if (payloadSubscriptionId !== subscriptionId) {
    throw new ApiError(404, 'Delivery does not belong to this subscription');
  }

  const now = nowIso();
  await client.run(
    `UPDATE outbox_messages SET status = 'pending', available_at = ?, attempt_count = 0, last_error = NULL, updated_at = ?
       WHERE id = ?`,
    [now, now, outboxMessageId]
  );
}
