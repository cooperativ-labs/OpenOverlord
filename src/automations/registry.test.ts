import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getAutomation, listAutomations, registerAutomation } from './registry.js';

describe('automations registry', () => {
  it('includes built-in summarization tools', () => {
    const automationIds = listAutomations().map(automation => automation.id);
    assert.deepEqual(automationIds, ['summarize-text', 'summarize-objective-title']);
    assert.equal(getAutomation('summarize-text')?.label, 'Summarize text');
  });

  it('rejects duplicate automation registration', () => {
    const customAutomation = {
      id: 'summarize-text',
      label: 'Duplicate',
      description: 'Should fail',
      run: async () => 'noop'
    };

    assert.throws(() => registerAutomation(customAutomation), /already registered/);
  });
});
