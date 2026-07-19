import {
  type ComposeDeliveryDraft,
  type ComposeDeliveryInput,
  composeDeliveryWithGemini,
  isGeminiConfigured,
  readGeminiConfigFromEnv
} from '@overlord/automations';
import type { DeliveryReportPayloadV1 } from '@overlord/contract';
import type { DatabaseClient } from '@overlord/database';

import {
  applyDeliveryPresentation,
  type ChangeRationaleEvidence,
  deriveDeterministicActionCandidates,
  reconcileDeliveryComposeDraft
} from '../packages/core/service/delivery-compose.ts';
import { newId, nowIso } from '../packages/core/service/util.ts';
import { DELIVERY_COMPOSE_JOB_TYPE } from '../packages/core/service/worker-jobs.ts';

import { recordChange, requireDatabaseClient } from './db.ts';

const POLL_INTERVAL_MS = 1500;
const CLAIM_BATCH_SIZE = 5;
const LOCK_TTL_MS = 60_000;
const RETRY_BACKOFF_MS = [15_000, 60_000, 300_000, 900_000, 3_600_000];
const MAX_COMPOSE_SUMMARY_CHARS = 6_000;
const MAX_COMPOSE_AUXILIARY_CHARS = 2_000;
const MAX_COMPOSE_RATIONALE_CHARS = 800;
const MAX_COMPOSE_EVENT_CHARS = 1_000;

type WorkerJobRow = {
  id: string;
  workspace_id: string;
  payload_json: string;
  attempt_count: number;
  max_attempts: number;
  revision: number;
};

type DeliveryRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  mission_id: string;
  objective_id: string;
  summary: string;
  verification_summary: string | null;
  follow_up_notes: string | null;
  payload_json: string;
  revision: number;
};

type ComposeGenerator = (args: {
  prompt: string;
  systemInstruction: string;
}) => Promise<string | null>;

type ComposeResult =
  | { kind: 'missing' }
  | {
      kind: 'updated';
      presentationStatus: 'composed' | 'fallback';
      model: string | null;
      inputBytes: number;
      estimatedInputTokens: number;
    };

/** Emits bounded operational metrics without delivery summaries or prompt content. */
function logComposeMetric(
  event: string,
  fields: Record<string, string | number | boolean | null | undefined>
): void {
  console.info('[delivery-compose-worker]', JSON.stringify({ event, ...fields }));
}

/**
 * In-process, database-backed delivery composition worker. Modeled on
 * webhook-dispatcher: singleton poll loop, leased claims, bounded retries.
 */
class DeliveryComposeWorker {
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private readonly workerId = `delivery-compose:${process.pid}:${newId().slice(0, 8)}`;
  private generateOverride: ComposeGenerator | null = null;

  start(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  /** Test seam: inject a fake Gemini generator. */
  setGenerateOverride(generate: ComposeGenerator | null): void {
    this.generateOverride = generate;
  }

  pollNow(): void {
    void this.poll();
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    if (process.env.OVERLORD_DELIVERY_COMPOSE_DISABLED === '1') return;
    this.polling = true;
    try {
      const client = requireDatabaseClient();
      for (let i = 0; i < CLAIM_BATCH_SIZE; i++) {
        const row = await claimNextComposeJob(client, this.workerId);
        if (!row) break;
        await this.processJob(client, row);
      }
    } catch (err) {
      console.error('[delivery-compose-worker] poll failed', err);
    } finally {
      this.polling = false;
    }
  }

  private async processJob(client: DatabaseClient, job: WorkerJobRow): Promise<void> {
    const startedAt = Date.now();
    let deliveryId: string;
    try {
      const payload = JSON.parse(job.payload_json) as { deliveryId?: unknown };
      if (typeof payload.deliveryId !== 'string' || !payload.deliveryId.trim()) {
        throw new Error('Missing deliveryId in worker payload');
      }
      deliveryId = payload.deliveryId.trim();
    } catch (err) {
      await markJobTerminal(client, job.id, 'failed', `Malformed payload: ${String(err)}`);
      return;
    }

    const attemptNumber = job.attempt_count;
    try {
      const result = await this.composeAndPersist(client, deliveryId);
      if (result.kind === 'missing') {
        await markJobTerminal(client, job.id, 'cancelled', 'Delivery not found');
        logComposeMetric('delivery_compose_failed', {
          jobId: job.id,
          deliveryId,
          attempt: job.attempt_count,
          outcome: 'cancelled',
          durationMs: Date.now() - startedAt
        });
        return;
      }
      await markJobTerminal(client, job.id, 'succeeded', null);
      logComposeMetric(
        result.presentationStatus === 'composed'
          ? 'delivery_compose_composed'
          : 'delivery_compose_fallback',
        {
          jobId: job.id,
          deliveryId,
          attempt: job.attempt_count,
          durationMs: Date.now() - startedAt,
          model: result.model,
          inputBytes: result.inputBytes,
          estimatedInputTokens: result.estimatedInputTokens
        }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[delivery-compose-worker] job ${job.id} failed:`, message);
      if (attemptNumber >= job.max_attempts) {
        await markJobTerminal(client, job.id, 'failed', message);
        await persistFallbackPresentation(client, deliveryId, message).catch(persistErr => {
          console.warn('[delivery-compose-worker] fallback persist failed', persistErr);
        });
        logComposeMetric('delivery_compose_failed', {
          jobId: job.id,
          deliveryId,
          attempt: attemptNumber,
          durationMs: Date.now() - startedAt
        });
        return;
      }
      const delay = RETRY_BACKOFF_MS[Math.min(attemptNumber - 1, RETRY_BACKOFF_MS.length - 1)]!;
      await rescheduleJob(client, job.id, attemptNumber, delay, message);
      logComposeMetric('delivery_compose_failed', {
        jobId: job.id,
        deliveryId,
        attempt: attemptNumber,
        retrying: true,
        durationMs: Date.now() - startedAt
      });
    }
  }

  private async composeAndPersist(
    client: DatabaseClient,
    deliveryId: string
  ): Promise<ComposeResult> {
    const context = await loadComposeContext(client, deliveryId);
    if (!context) return { kind: 'missing' };

    const { delivery, report, rationales, filePaths, objective, recentEvents } = context;
    const candidates = deriveDeterministicActionCandidates({ filePaths });
    const model = readGeminiConfigFromEnv()?.model ?? null;

    let draft: ComposeDeliveryDraft | null = null;
    let inputBytes = 0;
    if (isGeminiConfigured() || this.generateOverride) {
      const input = toComposeInput({
        delivery,
        report,
        rationales,
        candidates,
        objective,
        recentEvents
      });
      inputBytes = Buffer.byteLength(JSON.stringify(input), 'utf8');
      draft = await composeDeliveryWithGemini({
        input,
        ...(this.generateOverride
          ? {
              generate: async ({ prompt, systemInstruction }) =>
                this.generateOverride!({ prompt, systemInstruction })
            }
          : {})
      });
    }

    const presentation = reconcileDeliveryComposeDraft({
      report,
      draft,
      candidates,
      rationales,
      model
    });

    // No provider and no draft → leave deterministic content as fallback.
    if (!draft && !isGeminiConfigured() && !this.generateOverride) {
      presentation.status = 'fallback';
      presentation.generatedBy = 'deterministic';
    }

    const nextReport = applyDeliveryPresentation({ report, presentation });
    await persistDeliveryReport({
      client,
      delivery,
      nextReport,
      changedFields: ['payload_json', 'presentation']
    });
    return {
      kind: 'updated',
      presentationStatus: presentation.status === 'composed' ? 'composed' : 'fallback',
      model,
      inputBytes,
      estimatedInputTokens: Math.ceil(inputBytes / 4)
    };
  }
}

async function persistFallbackPresentation(
  client: DatabaseClient,
  deliveryId: string,
  lastError: string
): Promise<void> {
  const context = await loadComposeContext(client, deliveryId);
  if (!context) return;
  const presentation = reconcileDeliveryComposeDraft({
    report: context.report,
    draft: null,
    model: readGeminiConfigFromEnv()?.model ?? null
  });
  presentation.status = 'fallback';
  const nextReport = applyDeliveryPresentation({
    report: context.report,
    presentation
  });
  await persistDeliveryReport({
    client,
    delivery: context.delivery,
    nextReport,
    changedFields: ['payload_json', 'presentation']
  });
}

async function persistDeliveryReport({
  client,
  delivery,
  nextReport,
  changedFields
}: {
  client: DatabaseClient;
  delivery: DeliveryRow;
  nextReport: DeliveryReportPayloadV1;
  changedFields: string[];
}): Promise<void> {
  const now = nowIso();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(delivery.payload_json) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  payload.deliveryReport = nextReport;

  const updated = await client.run(
    `UPDATE deliveries
         SET payload_json = ?, updated_at = ?, revision = revision + 1
       WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
    [JSON.stringify(payload), now, delivery.id, delivery.revision]
  );
  if (updated.changes === 0) {
    // Another writer won the CAS; treat as success for idempotent workers.
    return;
  }

  await recordChange(
    {
      entityType: 'delivery',
      entityId: delivery.id,
      operation: 'update',
      entityRevision: delivery.revision + 1,
      projectId: delivery.project_id,
      missionId: delivery.mission_id,
      objectiveId: delivery.objective_id,
      changedFields,
      workspaceId: delivery.workspace_id
    },
    client
  );
}

async function loadComposeContext(
  client: DatabaseClient,
  deliveryId: string
): Promise<{
  delivery: DeliveryRow;
  report: DeliveryReportPayloadV1;
  rationales: ChangeRationaleEvidence[];
  filePaths: string[];
  objective: { title: string | null; instruction: string | null };
  recentEvents: Array<{ type: string; summary: string }>;
} | null> {
  const delivery = (await client.get(
    `SELECT id, workspace_id, project_id, mission_id, objective_id, summary,
            verification_summary, follow_up_notes, payload_json, revision
       FROM deliveries
      WHERE id = ? AND deleted_at IS NULL`,
    [deliveryId]
  )) as DeliveryRow | undefined;
  if (!delivery) return null;

  let report: DeliveryReportPayloadV1 | null = null;
  try {
    const payload = JSON.parse(delivery.payload_json) as {
      deliveryReport?: DeliveryReportPayloadV1;
    };
    if (payload.deliveryReport?.schemaVersion === 1 && payload.deliveryReport.agentReport) {
      report = payload.deliveryReport;
    }
  } catch {
    report = null;
  }
  if (!report) return null;

  const rationaleRows = (await client.all(
    `SELECT id, file_path, label, summary, why, impact
       FROM change_rationales
      WHERE delivery_id = ? AND deleted_at IS NULL
      ORDER BY created_at ASC
      LIMIT 40`,
    [deliveryId]
  )) as Array<{
    id: string;
    file_path: string;
    label: string;
    summary: string;
    why: string;
    impact: string;
  }>;

  const rationales: ChangeRationaleEvidence[] = rationaleRows.map(row => ({
    id: row.id,
    filePath: row.file_path,
    label: row.label,
    summary: row.summary,
    why: row.why,
    impact: row.impact
  }));

  const filePaths = rationaleRows.map(row => row.file_path);

  const objective = (await client.get(
    `SELECT title, instruction_text FROM objectives WHERE id = ?`,
    [delivery.objective_id]
  )) as { title: string | null; instruction_text: string | null } | undefined;

  const recentEvents = (await client.all(
    `SELECT type, summary FROM mission_events
      WHERE objective_id = ?
      ORDER BY created_at DESC
      LIMIT 12`,
    [delivery.objective_id]
  )) as Array<{ type: string; summary: string }>;

  return {
    delivery,
    report,
    rationales,
    filePaths,
    objective: {
      title: objective?.title ?? null,
      instruction: objective?.instruction_text ?? null
    },
    recentEvents: recentEvents.map(event => ({
      type: event.type,
      summary: event.summary
    }))
  };
}

function toComposeInput({
  delivery,
  report,
  rationales,
  candidates,
  objective,
  recentEvents
}: {
  delivery: DeliveryRow;
  report: DeliveryReportPayloadV1;
  rationales: ChangeRationaleEvidence[];
  candidates: ReturnType<typeof deriveDeterministicActionCandidates>;
  objective: { title: string | null; instruction: string | null };
  recentEvents: Array<{ type: string; summary: string }>;
}): ComposeDeliveryInput {
  return {
    summary: boundComposeText(delivery.summary, MAX_COMPOSE_SUMMARY_CHARS),
    objectiveTitle: objective.title,
    objectiveInstruction: objective.instruction,
    verificationSummary: delivery.verification_summary
      ? boundComposeText(delivery.verification_summary, MAX_COMPOSE_AUXILIARY_CHARS)
      : null,
    followUpNotes: delivery.follow_up_notes
      ? boundComposeText(delivery.follow_up_notes, MAX_COMPOSE_AUXILIARY_CHARS)
      : null,
    humanActions: report.agentReport.humanActions.map(action => ({
      id: action.id,
      action: action.action,
      ...(action.reason ? { reason: action.reason } : {}),
      category: action.category,
      source: action.source,
      ...(action.sourceRef ? { sourceRef: action.sourceRef } : {})
    })),
    tradeoffsMade: report.agentReport.tradeoffsMade.map(tradeoff => ({
      id: tradeoff.id,
      decision: tradeoff.decision,
      rationale: tradeoff.rationale,
      alternativesConsidered: tradeoff.alternativesConsidered,
      ...(tradeoff.impact ? { impact: tradeoff.impact } : {}),
      source: tradeoff.source,
      ...(tradeoff.sourceRef ? { sourceRef: tradeoff.sourceRef } : {})
    })),
    knownRisks: report.agentReport.knownRisks,
    deferredWork: report.agentReport.deferredWork,
    assumptions: report.agentReport.assumptions,
    candidateActions: candidates.map(action => ({
      id: action.id,
      action: action.action,
      ...(action.reason ? { reason: action.reason } : {}),
      category: action.category,
      source: action.source
    })),
    changeRationales: rationales.slice(0, 20).map(rationale => ({
      id: rationale.id,
      filePath: boundComposeText(rationale.filePath, MAX_COMPOSE_RATIONALE_CHARS),
      label: boundComposeText(rationale.label, MAX_COMPOSE_RATIONALE_CHARS),
      summary: boundComposeText(rationale.summary, MAX_COMPOSE_RATIONALE_CHARS),
      why: boundComposeText(rationale.why, MAX_COMPOSE_RATIONALE_CHARS),
      impact: boundComposeText(rationale.impact, MAX_COMPOSE_RATIONALE_CHARS)
    })),
    recentEvents: recentEvents.slice(0, 12).map(event => ({
      type: event.type,
      summary: boundComposeText(event.summary, MAX_COMPOSE_EVENT_CHARS)
    }))
  };
}

function boundComposeText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

async function claimNextComposeJob(
  client: DatabaseClient,
  workerId: string
): Promise<WorkerJobRow | null> {
  return client.transaction(async tx => {
    const now = nowIso();
    const lockClause = tx.dialect === 'postgres' ? 'FOR UPDATE SKIP LOCKED' : '';

    // Reclaim stale locks into the selectable set by resetting them first.
    await tx.run(
      `UPDATE worker_jobs
          SET status = 'queued', locked_by = NULL, locked_until = NULL, updated_at = ?,
              revision = revision + 1
        WHERE type = ?
          AND status = 'running'
          AND deleted_at IS NULL
          AND locked_until IS NOT NULL
          AND locked_until < ?`,
      [now, DELIVERY_COMPOSE_JOB_TYPE, now]
    );

    const candidate = (await tx.get(
      `SELECT id, workspace_id, payload_json, attempt_count, max_attempts, revision
         FROM worker_jobs
        WHERE type = ?
          AND status = 'queued'
          AND deleted_at IS NULL
          AND run_after <= ?
        ORDER BY priority ASC, run_after ASC
        LIMIT 1 ${lockClause}`,
      [DELIVERY_COMPOSE_JOB_TYPE, now]
    )) as WorkerJobRow | undefined;
    if (!candidate) return null;

    const lockedUntil = new Date(Date.parse(now) + LOCK_TTL_MS).toISOString();
    const updated = await tx.run(
      `UPDATE worker_jobs
          SET status = 'running',
              attempt_count = attempt_count + 1,
              locked_by = ?,
              locked_until = ?,
              updated_at = ?,
              revision = revision + 1
        WHERE id = ? AND status = 'queued' AND revision = ?`,
      [workerId, lockedUntil, now, candidate.id, candidate.revision]
    );
    if (updated.changes === 0) return null;

    return {
      ...candidate,
      attempt_count: candidate.attempt_count + 1,
      revision: candidate.revision + 1
    };
  });
}

async function markJobTerminal(
  client: DatabaseClient,
  id: string,
  status: 'succeeded' | 'failed' | 'cancelled',
  lastError: string | null
): Promise<void> {
  await client.run(
    `UPDATE worker_jobs
         SET status = ?, last_error = ?, locked_by = NULL, locked_until = NULL,
             updated_at = ?, revision = revision + 1
       WHERE id = ?`,
    [status, lastError, nowIso(), id]
  );
}

async function rescheduleJob(
  client: DatabaseClient,
  id: string,
  attemptCount: number,
  delayMs: number,
  lastError: string | null
): Promise<void> {
  const runAfter = new Date(Date.now() + delayMs).toISOString();
  await client.run(
    `UPDATE worker_jobs
         SET status = 'queued',
             run_after = ?,
             last_error = ?,
             locked_by = NULL,
             locked_until = NULL,
             updated_at = ?,
             revision = revision + 1
       WHERE id = ?`,
    [runAfter, lastError, nowIso(), id]
  );
  void attemptCount;
}

export const deliveryComposeWorker = new DeliveryComposeWorker();
