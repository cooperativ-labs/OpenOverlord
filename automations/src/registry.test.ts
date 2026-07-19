import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  getAutomation,
  listAutomations,
  loadExternalAutomations,
  registerAutomation,
  registerAutomations
} from './registry.js';

describe('automations registry', () => {
  it('includes built-in summarization tools', () => {
    const automationIds = listAutomations().map(automation => automation.id);
    assert.deepEqual(automationIds, [
      'manage-objective-lifecycle',
      'summarize-text',
      'summarize-objective-title',
      'compose-delivery'
    ]);
    assert.equal(getAutomation('summarize-text')?.label, 'Summarize text');
    assert.equal(getAutomation('manage-objective-lifecycle')?.label, 'Manage objective lifecycle');
    assert.equal(getAutomation('compose-delivery')?.label, 'Compose delivery presentation');
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

  it('registers several automations at once with registerAutomations', () => {
    registerAutomations([
      { id: 'fixture-batch-a', label: 'A', description: 'a', run: async () => null },
      { id: 'fixture-batch-b', label: 'B', description: 'b', run: async () => null }
    ]);

    assert.equal(getAutomation('fixture-batch-a')?.label, 'A');
    assert.equal(getAutomation('fixture-batch-b')?.label, 'B');
  });

  it('loadExternalAutomations is a no-op when OVERLORD_AUTOMATIONS_MODULE is unset', async () => {
    assert.deepEqual(await loadExternalAutomations({}), []);
    assert.deepEqual(await loadExternalAutomations({ OVERLORD_AUTOMATIONS_MODULE: '   ' }), []);
  });

  it('loadExternalAutomations imports modules named by OVERLORD_AUTOMATIONS_MODULE', async () => {
    const spec = './external-automation.fixture.js';

    const registered = await loadExternalAutomations({ OVERLORD_AUTOMATIONS_MODULE: spec });
    assert.deepEqual(registered, ['fixture-external-automation']);
    assert.equal(
      getAutomation('fixture-external-automation')?.label,
      'Fixture external automation'
    );

    // Idempotent per module specifier: a second load registers nothing more.
    assert.deepEqual(await loadExternalAutomations({ OVERLORD_AUTOMATIONS_MODULE: spec }), []);
  });
});
