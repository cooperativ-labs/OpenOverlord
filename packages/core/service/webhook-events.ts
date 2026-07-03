import { bindBool } from '@overlord/database';

import type { ServiceContext } from './context.js';
import { newId, nowIso } from './util.js';

/**
 * Namespaced, versioned webhook event vocabulary. Deliberately separate from
 * the closed `mission_events.type` enum (see database schema contract ->
 * Controlled Vocabularies -> "Webhook event catalog") so new event types never
 * require a contract version bump.
 */
export const WEBHOOK_EVENT_TYPES = [
  'mission.delivered',
  'mission.status_changed',
  'objective.completed',
  'mission.blocked'
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export function isWebhookEventType(value: string): value is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

/** `outbox_messages.topic` value declared for this feature (open vocabulary). */
export const WEBHOOK_OUTBOX_TOPIC = 'webhook.deliver.v1';

/** Envelope schema version carried on every delivered payload (see docs/webhooks.md). */
export const WEBHOOK_API_VERSION = '2026-07-01';

export type WebhookPayloadMode = 'thin' | 'full';

/** The entity references a webhook event fires with. Every event carries a mission; the rest are optional depending on event type. */
export interface WebhookEntityRefs {
  missionId: string;
  objectiveId?: string | null;
  sessionId?: string | null;
  deliveryId?: string | null;
}

interface OutboxWebhookPayload {
  subscriptionId: string;
  eventType: WebhookEventType;
  entity: WebhookEntityRefs;
  occurredAt: string;
}

/**
 * Match active `webhook_subscriptions` against a firing event and insert one
 * `outbox_messages` row per match, inside the caller's transaction. This is a
 * second shared-single-writer rule alongside `insertEntityChange`
 * (`change-feed.ts`): both data layers (the protocol service core and the REST
 * data layer) call this at the same domain choke points so no origin path
 * silently skips webhook delivery.
 *
 * Only cheap lookups happen here (match subscriptions, insert rows). Heavy
 * envelope hydration for `full` payloads is deferred to the dispatcher (see
 * `buildWebhookEnvelope`), so this never adds latency or failure risk to the
 * delivery transaction it runs inside.
 */
export async function enqueueWebhookEvent(
  ctx: ServiceContext,
  {
    type,
    projectId,
    entity
  }: { type: WebhookEventType; projectId: string | null; entity: WebhookEntityRefs }
): Promise<void> {
  const enabledParam = bindBool(ctx.db.dialect, true);
  const subscriptions = (await ctx.db.all(
    `SELECT id, event_types_json, created_by_workspace_user_id
       FROM webhook_subscriptions
       WHERE workspace_id = ? AND enabled = ? AND deleted_at IS NULL
         AND (project_id IS NULL OR project_id = ?)`,
    [ctx.workspace.id, enabledParam, projectId]
  )) as Array<{
    id: string;
    event_types_json: string;
    created_by_workspace_user_id: string;
  }>;

  if (subscriptions.length === 0) return;

  const now = nowIso();
  for (const subscription of subscriptions) {
    let eventTypes: string[];
    try {
      eventTypes = JSON.parse(subscription.event_types_json) as string[];
    } catch {
      continue;
    }
    if (!eventTypes.includes(type)) continue;

    // A departed owner's subscriptions stop firing rather than silently
    // reading with stale authority once the dispatcher hydrates a payload.
    const owner = await ctx.db.get(
      `SELECT id FROM workspace_users
         WHERE id = ? AND workspace_id = ? AND status = 'active' AND deleted_at IS NULL`,
      [subscription.created_by_workspace_user_id, ctx.workspace.id]
    );
    if (!owner) continue;

    const payload: OutboxWebhookPayload = {
      subscriptionId: subscription.id,
      eventType: type,
      entity,
      occurredAt: now
    };

    await ctx.db.run(
      `INSERT INTO outbox_messages
           (id, workspace_id, topic, payload_json, status, available_at, attempt_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, 0, ?, ?)`,
      [newId(), ctx.workspace.id, WEBHOOK_OUTBOX_TOPIC, JSON.stringify(payload), now, now, now]
    );
  }
}

/** Cap on array-shaped envelope sections in `full` mode, per the contracted `truncated` marker. */
const FULL_ENVELOPE_ARRAY_LIMIT = 50;

export interface WebhookEnvelope {
  id: string;
  apiVersion: string;
  type: WebhookEventType;
  occurredAt: string;
  workspace: { id: string; name?: string };
  project: { id: string; name?: string } | null;
  mission: {
    id: string;
    displayId: string;
    title?: string;
    status?: { id: string; type: string; label: string };
    priority?: string | null;
    createdAt?: string;
  };
  objective?: { id: string; position?: number; title?: string | null; state?: string };
  session?: { id: string; agentIdentifier?: string; modelIdentifier?: string | null };
  delivery?: {
    id: string;
    summary?: string;
    verificationSummary?: string | null;
    followUpNotes?: string | null;
    artifacts?: Array<{
      type: string;
      label: string;
      content?: string | null;
      url?: string | null;
    }>;
  };
  changedFiles?: Array<{ filePath: string; vcsStatus: string | null }> & { truncated?: boolean };
  changeRationales?: Array<{
    filePath: string;
    label: string;
    summary: string;
    why: string;
    impact: string;
  }> & { truncated?: boolean };
  missionEvents?: Array<{ id: string; type: string; summary: string; createdAt: string }> & {
    truncated?: boolean;
  };
  links: {
    mission: string;
    events: string;
    fileChanges: string;
    artifacts: string;
  };
}

/**
 * Build the envelope for one webhook delivery. `mode: 'thin'` returns only
 * identifying references and hydration `links`; `mode: 'full'` hydrates the
 * rest of the snapshot (the upstream feed-post generator's data needs) via
 * `ctx`, which must be actor-bound to the subscription owner (`ctx.workspace`
 * + `ctx.actorWorkspaceUserId` = `webhook_subscriptions.created_by_workspace_user_id`)
 * so a subscription can never out-read its creator. Callers are responsible
 * for checking the owner still holds `mission:read` before requesting `full`.
 */
export async function buildWebhookEnvelope(
  ctx: ServiceContext,
  {
    outboxMessageId,
    type,
    entity,
    occurredAt,
    mode
  }: {
    outboxMessageId: string;
    type: WebhookEventType;
    entity: WebhookEntityRefs;
    occurredAt: string;
    mode: WebhookPayloadMode;
  }
): Promise<WebhookEnvelope> {
  const mission = (await ctx.db.get(
    `SELECT m.id, m.display_id, m.project_id, m.title, m.priority, m.created_at,
            s.id AS status_id, s.type AS status_type, s.name AS status_name
       FROM missions m
       JOIN workspace_statuses s ON s.id = m.status_id
       WHERE m.id = ? AND m.workspace_id = ?`,
    [entity.missionId, ctx.workspace.id]
  )) as
    | {
        id: string;
        display_id: string;
        project_id: string;
        title: string;
        priority: string | null;
        created_at: string;
        status_id: string;
        status_type: string;
        status_name: string;
      }
    | undefined;

  if (!mission) {
    throw new Error(`Mission not found for webhook envelope: ${entity.missionId}`);
  }

  const project =
    mode === 'full'
      ? ((await ctx.db.get(`SELECT id, name FROM projects WHERE id = ?`, [mission.project_id])) as
          | { id: string; name: string }
          | undefined)
      : null;

  const links = {
    mission: `/api/missions/${mission.id}`,
    events: `/api/missions/${mission.id}/events`,
    fileChanges: `/api/missions/${mission.id}/file-changes`,
    artifacts: `/api/missions/${mission.id}/artifacts`
  };

  const envelope: WebhookEnvelope = {
    id: outboxMessageId,
    apiVersion: WEBHOOK_API_VERSION,
    type,
    occurredAt,
    workspace: { id: ctx.workspace.id },
    project: mission.project_id ? { id: mission.project_id } : null,
    mission: { id: mission.id, displayId: mission.display_id },
    links
  };

  if (entity.objectiveId) envelope.objective = { id: entity.objectiveId };
  if (entity.sessionId) envelope.session = { id: entity.sessionId };
  if (entity.deliveryId) envelope.delivery = { id: entity.deliveryId };

  if (mode === 'thin') {
    return envelope;
  }

  envelope.workspace.name = ctx.workspace.name;
  if (project) envelope.project = { id: project.id, name: project.name };
  envelope.mission = {
    ...envelope.mission,
    title: mission.title,
    status: { id: mission.status_id, type: mission.status_type, label: mission.status_name },
    priority: mission.priority,
    createdAt: mission.created_at
  };

  if (entity.objectiveId) {
    const objective = (await ctx.db.get(
      `SELECT id, position, title, state FROM objectives WHERE id = ? AND workspace_id = ?`,
      [entity.objectiveId, ctx.workspace.id]
    )) as { id: string; position: number; title: string | null; state: string } | undefined;
    if (objective) {
      envelope.objective = {
        id: objective.id,
        position: objective.position,
        title: objective.title,
        state: objective.state
      };
    }
  }

  if (entity.sessionId) {
    const session = (await ctx.db.get(
      `SELECT id, agent_identifier, model_identifier FROM agent_sessions WHERE id = ? AND workspace_id = ?`,
      [entity.sessionId, ctx.workspace.id]
    )) as { id: string; agent_identifier: string; model_identifier: string | null } | undefined;
    if (session) {
      envelope.session = {
        id: session.id,
        agentIdentifier: session.agent_identifier,
        modelIdentifier: session.model_identifier
      };
    }
  }

  if (entity.deliveryId) {
    const delivery = (await ctx.db.get(
      `SELECT id, summary, verification_summary, follow_up_notes FROM deliveries WHERE id = ? AND workspace_id = ?`,
      [entity.deliveryId, ctx.workspace.id]
    )) as
      | {
          id: string;
          summary: string;
          verification_summary: string | null;
          follow_up_notes: string | null;
        }
      | undefined;
    if (delivery) {
      const artifactRows = (await ctx.db.all(
        `SELECT type, label, content_text, external_url FROM artifacts WHERE delivery_id = ? ORDER BY created_at ASC`,
        [delivery.id]
      )) as Array<{
        type: string;
        label: string;
        content_text: string | null;
        external_url: string | null;
      }>;

      envelope.delivery = {
        id: delivery.id,
        summary: delivery.summary,
        verificationSummary: delivery.verification_summary,
        followUpNotes: delivery.follow_up_notes,
        artifacts: artifactRows.map(row => ({
          type: row.type,
          label: row.label,
          content: row.content_text,
          url: row.external_url
        }))
      };

      const changedFileRows = (await ctx.db.all(
        `SELECT file_path, vcs_status FROM changed_files
           WHERE objective_id = ? AND deleted_at IS NULL
           ORDER BY last_observed_at DESC LIMIT ?`,
        [entity.objectiveId, FULL_ENVELOPE_ARRAY_LIMIT + 1]
      )) as Array<{ file_path: string; vcs_status: string | null }>;
      envelope.changedFiles = truncateArray(
        changedFileRows.map(row => ({ filePath: row.file_path, vcsStatus: row.vcs_status }))
      );

      const rationaleRows = (await ctx.db.all(
        `SELECT file_path, label, summary, why, impact FROM change_rationales
           WHERE delivery_id = ? AND deleted_at IS NULL
           ORDER BY created_at ASC LIMIT ?`,
        [delivery.id, FULL_ENVELOPE_ARRAY_LIMIT + 1]
      )) as Array<{
        file_path: string;
        label: string;
        summary: string;
        why: string;
        impact: string;
      }>;
      envelope.changeRationales = truncateArray(
        rationaleRows.map(row => ({
          filePath: row.file_path,
          label: row.label,
          summary: row.summary,
          why: row.why,
          impact: row.impact
        }))
      );
    }
  }

  const eventRows = (await ctx.db.all(
    `SELECT id, type, summary, created_at FROM mission_events
       WHERE mission_id = ? AND workspace_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    [mission.id, ctx.workspace.id, FULL_ENVELOPE_ARRAY_LIMIT + 1]
  )) as Array<{ id: string; type: string; summary: string; created_at: string }>;
  envelope.missionEvents = truncateArray(
    eventRows.map(row => ({
      id: row.id,
      type: row.type,
      summary: row.summary,
      createdAt: row.created_at
    }))
  );

  return envelope;
}

function truncateArray<T>(rows: T[]): T[] & { truncated?: boolean } {
  if (rows.length <= FULL_ENVELOPE_ARRAY_LIMIT) return rows;
  const truncated = rows.slice(0, FULL_ENVELOPE_ARRAY_LIMIT) as T[] & { truncated?: boolean };
  truncated.truncated = true;
  return truncated;
}
