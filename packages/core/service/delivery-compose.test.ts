import type { DeliveryReportPayloadV1 } from '@overlord/contract';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deriveDeterministicActionCandidates,
  reconcileDeliveryComposeDraft
} from './delivery-compose.js';
import { buildDeliveryReport } from './delivery-report.js';

function baseReport(): DeliveryReportPayloadV1 {
  return buildDeliveryReport({
    summary: 'Shipped the compose worker.',
    deliveryReport: {
      schemaVersion: 1,
      agentReport: {
        humanActions: [
          {
            action: 'Set GEMINI_API_KEY in production.',
            reason: 'Composition needs a provider credential.',
            category: 'environment'
          }
        ],
        tradeoffsMade: [
          {
            decision: 'Compose asynchronously after delivery.',
            alternativesConsidered: ['Block on Gemini'],
            rationale: 'Delivery latency must not depend on the model.',
            impact: 'Users see deterministic content first.'
          }
        ],
        knownRisks: ['Model may paraphrase poorly.'],
        deferredWork: ['Webhook full-payload parity'],
        assumptions: ['worker_jobs is available']
      }
    }
  });
}

describe('delivery-compose reconciliation', () => {
  it('keeps deterministic evidence as fallback when the draft is null', () => {
    const report = baseReport();
    const presentation = reconcileDeliveryComposeDraft({
      report,
      draft: null,
      model: 'gemini-test'
    });
    assert.equal(presentation.status, 'fallback');
    assert.equal(presentation.generatedBy, 'deterministic');
    assert.equal(presentation.markdown, report.presentation.markdown);
    assert.deepEqual(presentation.humanActions, report.agentReport.humanActions);
  });

  it('drops hallucinated actions and tradeoffs without source ids', () => {
    const report = baseReport();
    const presentation = reconcileDeliveryComposeDraft({
      report,
      draft: {
        markdown: 'Polished delivery summary.',
        humanActions: [
          { sourceId: 'human-action-1', action: 'Set the Gemini API key in production.' },
          { sourceId: 'invented-action', action: 'Buy a new laptop for the team.' }
        ],
        tradeoffsMade: [
          {
            sourceId: 'tradeoff-1',
            decision: 'Compose after commit.',
            rationale: 'Keep delivery non-blocking.'
          },
          {
            sourceId: 'invented-tradeoff',
            decision: 'Rewrite the protocol in Rust.',
            rationale: 'Faster somehow.'
          }
        ]
      },
      model: 'gemini-test'
    });

    assert.equal(presentation.status, 'composed');
    assert.equal(presentation.generatedBy, 'gemini');
    assert.equal(presentation.markdown, 'Polished delivery summary.');
    assert.equal(presentation.humanActions.length, 1);
    assert.equal(presentation.humanActions[0]?.id, 'human-action-1');
    assert.equal(presentation.tradeoffsMade.length, 1);
    assert.equal(presentation.tradeoffsMade[0]?.id, 'tradeoff-1');
  });

  it('filters git and routine QA actions even when the model echoes them', () => {
    const report = baseReport();
    const presentation = reconcileDeliveryComposeDraft({
      report,
      draft: {
        markdown: 'Done.',
        humanActions: [
          { sourceId: 'human-action-1', action: 'git push the branch' },
          { sourceId: 'human-action-1', action: 'Review the code' }
        ],
        tradeoffsMade: []
      }
    });
    assert.equal(presentation.humanActions.length, 1);
    assert.equal(presentation.humanActions[0]?.action, report.agentReport.humanActions[0]?.action);
  });

  it('derives deterministic candidates from migration and env paths', () => {
    const candidates = deriveDeterministicActionCandidates({
      filePaths: [
        'database/sqlite/migrations/20260719124600_worker_jobs.sql',
        '.env.local.example',
        'src/feature.ts'
      ]
    });
    assert.ok(candidates.some(candidate => candidate.category === 'database'));
    assert.ok(candidates.some(candidate => candidate.category === 'environment'));
    assert.ok(candidates.every(candidate => candidate.source === 'deterministic_rule'));
  });
});
