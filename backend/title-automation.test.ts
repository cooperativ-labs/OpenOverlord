import { deriveTitleFromInstructionText } from '@overlord/automations';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('deriveTitleFromInstructionText (webapp title fallback)', () => {
  it('returns short instruction text unchanged', () => {
    assert.equal(
      deriveTitleFromInstructionText('Add retry logic to API client'),
      'Add retry logic to API client'
    );
  });

  it('truncates long instruction text locally', () => {
    const longText = 'Implement '.repeat(30);
    const title = deriveTitleFromInstructionText(longText);

    assert.equal(title.endsWith('…'), true);
    assert.equal(title.length, 101);
  });
});
