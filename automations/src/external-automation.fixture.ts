// Test-only fixture for `loadExternalAutomations`. Mimics a downstream fork's
// automation bundle: registering happens as an import side effect, so pointing
// OVERLORD_AUTOMATIONS_MODULE at this module registers the automation below.
import { registerAutomation } from './registry.js';

registerAutomation({
  id: 'fixture-external-automation',
  label: 'Fixture external automation',
  description: 'Test-only automation registered via loadExternalAutomations',
  run: async () => null
});
