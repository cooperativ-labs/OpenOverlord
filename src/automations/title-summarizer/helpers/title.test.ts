import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveTitleFromInstructionText } from './title.js';

describe('deriveTitleFromInstructionText', () => {
  it('returns short instruction text unchanged', () => {
    assert.equal(deriveTitleFromInstructionText('Add retry logic to API client'), 'Add retry logic to API client');
  });

  it('truncates long instruction text with an ellipsis', () => {
    const longText = 'x'.repeat(120);
    assert.equal(deriveTitleFromInstructionText(longText), `${'x'.repeat(100)}…`);
  });
});
