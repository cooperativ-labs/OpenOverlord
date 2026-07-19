import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createMissionWithObjectives } from './missions.js';
import { createProject } from './projects.js';
import { attachSession, deliverSession } from './protocol.js';
import { createSeededServiceContext } from './test-helpers.js';
import { buildWebhookEnvelope } from './webhook-events.js';

describe('delivery webhook envelopes', () => {
  it('includes a normalized report only in full mission.delivered envelopes', async () => {
    const { db, ctx } = await createSeededServiceContext({ source: 'cli' });
    try {
      const project = await createProject({ ctx, name: 'Webhook delivery report' });
      const { mission, objectives } = await createMissionWithObjectives({
        ctx,
        projectId: project.id,
        objectives: [{ objective: 'Deliver a report through a webhook.' }]
      });
      await ctx.db.run(`UPDATE objectives SET state = 'submitted' WHERE id = ?`, [
        objectives[0]?.id
      ]);
      const attached = await attachSession({
        ctx,
        missionId: mission.displayId,
        agentIdentifier: 'codex'
      });
      const delivered = await deliverSession({
        ctx,
        missionId: mission.displayId,
        sessionKey: attached.sessionKey,
        summary: 'Configured full webhook delivery reports.',
        payloadJson: {
          deliveryReport: {
            schemaVersion: 1,
            agentReport: {
              humanActions: [
                {
                  action: 'Set GEMINI_API_KEY in the production environment.',
                  category: 'environment'
                }
              ],
              tradeoffsMade: [
                {
                  decision: 'Compose after delivery commits.',
                  rationale: 'Delivery must remain non-blocking.'
                }
              ]
            }
          }
        },
        noFileChanges: true
      });

      const refs = {
        missionId: mission.id,
        objectiveId: objectives[0]?.id,
        sessionId: attached.session.id,
        deliveryId: delivered.deliveryId
      };
      const full = await buildWebhookEnvelope(ctx, {
        outboxMessageId: 'full-envelope',
        type: 'mission.delivered',
        entity: refs,
        occurredAt: new Date().toISOString(),
        mode: 'full'
      });
      assert.equal(full.delivery?.report?.schemaVersion, 1);
      assert.equal(full.delivery?.report?.presentation.status, 'pending');
      assert.equal(full.delivery?.report?.agentReport.humanActions[0]?.source, 'agent');
      assert.equal(full.delivery?.report?.agentReport.tradeoffsMade[0]?.source, 'agent');

      const thin = await buildWebhookEnvelope(ctx, {
        outboxMessageId: 'thin-envelope',
        type: 'mission.delivered',
        entity: refs,
        occurredAt: new Date().toISOString(),
        mode: 'thin'
      });
      assert.deepEqual(thin.delivery, { id: delivered.deliveryId });
    } finally {
      await db.close();
    }
  });
});
