import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { getGeminiClient, resetGeminiClientForTests } from '../gemini-client.js';
import { AI_TITLE_THRESHOLD } from '../tools/summarize-objective-title.js';

import {
  generateAndSetObjectiveTitle,
  generateObjectiveTitle
} from './generate-objective-title.js';

describe('generateObjectiveTitle', () => {
  it('uses local derivation for short instruction text', async () => {
    const title = await generateObjectiveTitle({
      instructionText: 'Add retry logic to API client'
    });

    assert.equal(title, 'Add retry logic to API client');
  });

  it('falls back locally when no Gemini API key is configured', async () => {
    resetGeminiClientForTests();
    const longText = 'Implement '.repeat(30);
    const title = await generateObjectiveTitle({
      instructionText: longText,
      env: {}
    });

    assert.equal(title.endsWith('…'), true);
    assert.equal(title.length, 101);
  });

  it('falls back locally when the Gemini API call fails', async () => {
    resetGeminiClientForTests();
    const env = { GEMINI_API_KEY: 'test-key' };
    const client = getGeminiClient(env);
    assert.ok(client, 'a client should be constructed when an API key is present');
    // Simulate a real service failure (e.g. 503) rather than a missing key.
    const generateContent = mock.method(client!.models, 'generateContent', async () => {
      throw new Error('503 Service Unavailable');
    });

    try {
      const longText = 'Implement '.repeat(30);
      const title = await generateObjectiveTitle({ instructionText: longText, env });

      // We must actually reach the Gemini call (not short-circuit on a missing key),
      // and its thrown error must be swallowed and produce a local title.
      assert.equal(generateContent.mock.callCount(), 1, 'the Gemini call must be attempted');
      assert.equal(title.endsWith('…'), true);
      assert.equal(title.length, 101);
    } finally {
      mock.restoreAll();
      resetGeminiClientForTests();
    }
  });

  it('skips Gemini when AI title generation is disabled', async () => {
    const longText = 'y'.repeat(AI_TITLE_THRESHOLD + 1);
    const title = await generateObjectiveTitle({
      instructionText: longText,
      aiTitleGenerationEnabled: false,
      env: { GEMINI_API_KEY: 'test-key' }
    });

    assert.equal(title, `${'y'.repeat(100)}…`);
  });
});

describe('generateAndSetObjectiveTitle', () => {
  it('persists a generated title through the injected store', async () => {
    const updates: Array<{ objectiveId: string; title: string }> = [];

    await generateAndSetObjectiveTitle({
      store: {
        updateObjectiveTitle: async ({ objectiveId, title }) => {
          updates.push({ objectiveId, title });
        }
      },
      objectiveId: 'obj-1',
      instructionText: 'Wire objective title automation'
    });

    assert.deepEqual(updates, [
      {
        objectiveId: 'obj-1',
        title: 'Wire objective title automation'
      }
    ]);
  });

  it('skips persistence for blank instruction text', async () => {
    let storeCalls = 0;

    await generateAndSetObjectiveTitle({
      store: {
        updateObjectiveTitle: async () => {
          storeCalls += 1;
        }
      },
      objectiveId: 'obj-2',
      instructionText: '   '
    });

    assert.equal(storeCalls, 0);
  });
});
