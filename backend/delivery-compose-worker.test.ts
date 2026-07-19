import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const tempDir = mkdtempSync(path.join(tmpdir(), 'overlord-delivery-compose-'));
const { bootstrapIntegrationTestDb } = await import('./test-helpers.ts');
await bootstrapIntegrationTestDb({ sqlitePath: path.join(tempDir, 'webapp.sqlite') });

const { requireDatabaseClient } = await import('./db.ts');
const { deliveryComposeWorker } = await import('./delivery-compose-worker.ts');
const { createServiceContext } = await import('../packages/core/service/context.ts');
const { attachSession, deliverSession } = await import('../packages/core/service/protocol.ts');
const { createMissionWithObjectives } = await import('../packages/core/service/missions.ts');
const { createProject } = await import('../packages/core/service/projects.ts');
const { DELIVERY_COMPOSE_JOB_TYPE } = await import('../packages/core/service/worker-jobs.ts');
const { nowIso } = await import('../packages/core/service/util.ts');

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

async function serviceCtx() {
  const client = requireDatabaseClient();
  const now = nowIso();
  await client.run(
    `INSERT OR IGNORE INTO mission_sequences
       (id, workspace_id, scope_type, scope_id, counter_name, next_value, updated_at)
     VALUES (?, 'local-workspace', 'workspace', 'local-workspace', 'mission', 1, ?)`,
    ['local-workspace-mission-seq', now]
  );
  return createServiceContext({
    db: client,
    source: 'cli'
  });
}

async function waitForJobStatus(status: string, deliveryId: string): Promise<void> {
  const client = requireDatabaseClient();
  for (let attempt = 0; attempt < 40; attempt++) {
    deliveryComposeWorker.pollNow();
    const row = (await client.get(
      `SELECT status FROM worker_jobs
         WHERE type = ? AND payload_json LIKE ?
         ORDER BY created_at DESC LIMIT 1`,
      [DELIVERY_COMPOSE_JOB_TYPE, `%"deliveryId":"${deliveryId}"%`]
    )) as { status: string } | undefined;
    if (row?.status === status) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for worker job status=${status}`);
}

test('compose worker updates presentation from a fake provider and emits delivery changes', async () => {
  const ctx = await serviceCtx();
  const project = await createProject({ ctx, name: 'Compose Worker Project' });
  const { mission, objectives } = await createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Compose a delivery message asynchronously.' }]
  });
  await ctx.db.run(`UPDATE objectives SET state = 'submitted' WHERE id = ?`, [objectives[0]?.id]);

  const attached = await attachSession({
    ctx,
    missionId: mission.displayId,
    agentIdentifier: 'codex'
  });
  const delivered = await deliverSession({
    ctx,
    missionId: mission.displayId,
    sessionKey: attached.sessionKey,
    summary: 'Implemented the compose worker.',
    payloadJson: {
      deliveryReport: {
        schemaVersion: 1,
        agentReport: {
          humanActions: [
            {
              action: 'Set GEMINI_API_KEY before enabling composition.',
              category: 'environment'
            }
          ],
          tradeoffsMade: [
            {
              decision: 'Compose after delivery commits.',
              alternativesConsidered: ['Block on Gemini'],
              rationale: 'Delivery must stay non-blocking.'
            }
          ]
        }
      }
    },
    noFileChanges: true
  });

  deliveryComposeWorker.setGenerateOverride(async () =>
    JSON.stringify({
      markdown: 'Polished async delivery summary.',
      humanActions: [
        {
          sourceId: 'human-action-1',
          action: 'Set GEMINI_API_KEY before enabling composition.'
        },
        {
          sourceId: 'hallucinated',
          action: 'Purchase extra cloud GPUs.'
        }
      ],
      tradeoffsMade: [
        {
          sourceId: 'tradeoff-1',
          decision: 'Compose after delivery commits.',
          rationale: 'Keep delivery latency independent of Gemini.'
        }
      ],
      knownRisks: ['Model phrasing may drift.'],
      deferredWork: [],
      assumptions: []
    })
  );

  try {
    await waitForJobStatus('succeeded', delivered.deliveryId);

    const row = (await ctx.db.get(`SELECT payload_json, revision FROM deliveries WHERE id = ?`, [
      delivered.deliveryId
    ])) as { payload_json: string; revision: number };
    const payload = JSON.parse(row.payload_json) as {
      deliveryReport: {
        presentation: {
          status: string;
          markdown: string;
          humanActions: Array<{ id: string }>;
          tradeoffsMade: Array<{ id: string }>;
          generatedBy: string;
        };
      };
    };
    assert.equal(payload.deliveryReport.presentation.status, 'composed');
    assert.equal(payload.deliveryReport.presentation.generatedBy, 'gemini');
    assert.equal(payload.deliveryReport.presentation.markdown, 'Polished async delivery summary.');
    assert.equal(payload.deliveryReport.presentation.humanActions.length, 1);
    assert.equal(payload.deliveryReport.presentation.humanActions[0]?.id, 'human-action-1');
    assert.equal(payload.deliveryReport.presentation.tradeoffsMade[0]?.id, 'tradeoff-1');
    assert.ok(row.revision >= 2);

    const change = (await ctx.db.get(
      `SELECT entity_type, changed_fields_json FROM entity_changes
         WHERE entity_type = 'delivery' AND entity_id = ?
         ORDER BY seq DESC LIMIT 1`,
      [delivered.deliveryId]
    )) as { entity_type: string; changed_fields_json: string } | undefined;
    assert.ok(change);
    assert.deepEqual(JSON.parse(change.changed_fields_json), ['payload_json', 'presentation']);
  } finally {
    deliveryComposeWorker.setGenerateOverride(null);
  }
});

test('compose worker marks fallback when the fake provider returns invalid JSON', async () => {
  const ctx = await serviceCtx();
  const project = await createProject({ ctx, name: 'Compose Fallback Project' });
  const { mission, objectives } = await createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Fallback when composition fails.' }]
  });
  await ctx.db.run(`UPDATE objectives SET state = 'submitted' WHERE id = ?`, [objectives[0]?.id]);
  const attached = await attachSession({
    ctx,
    missionId: mission.displayId,
    agentIdentifier: 'codex'
  });
  const delivered = await deliverSession({
    ctx,
    missionId: mission.displayId,
    sessionKey: attached.sessionKey,
    summary: 'Deterministic fallback should remain readable.',
    noFileChanges: true
  });

  deliveryComposeWorker.setGenerateOverride(async () => 'not-json');
  try {
    await waitForJobStatus('succeeded', delivered.deliveryId);
    const row = (await ctx.db.get(`SELECT payload_json FROM deliveries WHERE id = ?`, [
      delivered.deliveryId
    ])) as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as {
      deliveryReport: { presentation: { status: string; markdown: string; generatedBy: string } };
    };
    assert.equal(payload.deliveryReport.presentation.status, 'fallback');
    assert.equal(payload.deliveryReport.presentation.generatedBy, 'deterministic');
    assert.equal(
      payload.deliveryReport.presentation.markdown,
      'Deterministic fallback should remain readable.'
    );
  } finally {
    deliveryComposeWorker.setGenerateOverride(null);
  }
});

test('duplicate compose jobs for the same delivery are not enqueued while one is active', async () => {
  const ctx = await serviceCtx();
  const { enqueueDeliveryComposeJob } = await import('../packages/core/service/worker-jobs.ts');
  const deliveryId = 'duplicate-delivery-id';
  const first = await enqueueDeliveryComposeJob({ ctx, deliveryId });
  const second = await enqueueDeliveryComposeJob({ ctx, deliveryId });
  assert.equal(first.enqueued, true);
  assert.equal(second.enqueued, false);
  assert.equal(second.jobId, first.jobId);
});
