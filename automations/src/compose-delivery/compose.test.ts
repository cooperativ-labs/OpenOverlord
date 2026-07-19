import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type ComposeDeliveryInput, composeDeliveryWithGemini } from './compose.js';

const sampleInput: ComposeDeliveryInput = {
  summary: 'Implemented async delivery composition.',
  objectiveTitle: 'Execute Phase 3',
  humanActions: [
    {
      id: 'human-action-1',
      action: 'Set GEMINI_API_KEY',
      reason: 'Needed for composition',
      category: 'environment',
      source: 'agent'
    }
  ],
  tradeoffsMade: [
    {
      id: 'tradeoff-1',
      decision: 'Use a durable worker job',
      rationale: 'Survives restarts',
      alternativesConsidered: ['Fire-and-forget void'],
      source: 'agent'
    }
  ],
  knownRisks: [],
  deferredWork: [],
  assumptions: [],
  candidateActions: [],
  changeRationales: []
};

describe('compose-delivery automation', () => {
  it('returns null when the generator yields no text', async () => {
    const draft = await composeDeliveryWithGemini({
      input: sampleInput,
      generate: async () => null
    });
    assert.equal(draft, null);
  });

  it('returns null when the generator yields invalid JSON', async () => {
    const draft = await composeDeliveryWithGemini({
      input: sampleInput,
      generate: async () => 'not-json'
    });
    assert.equal(draft, null);
  });

  it('parses schema-shaped JSON from the generator', async () => {
    const draft = await composeDeliveryWithGemini({
      input: sampleInput,
      generate: async () =>
        JSON.stringify({
          markdown: 'Polished markdown.',
          humanActions: [{ sourceId: 'human-action-1', action: 'Set GEMINI_API_KEY' }],
          tradeoffsMade: [
            {
              sourceId: 'tradeoff-1',
              decision: 'Use a durable worker job',
              rationale: 'Survives restarts'
            }
          ]
        })
    });
    assert.ok(draft);
    assert.equal(draft?.markdown, 'Polished markdown.');
    assert.equal(draft?.humanActions?.length, 1);
  });
});
