// Runner-queue provider transport (WS-C): serves capabilities on a *remote* local
// target via outbound poll request/response jobs. Capability bodies land with
// WS-D remote routing; until then every call returns a typed failure so callers
// never fall through to the hosted backend filesystem.

import { UnavailableProvider } from './registry.ts';
import type { TargetMetadata } from './types.ts';

/**
 * Provider for a local execution target reached through the runner queue rather
 * than in-process calls. Stub until WS-D wires queue jobs for each capability.
 */
export class RunnerQueueProvider extends UnavailableProvider {
  constructor(target: TargetMetadata) {
    super(
      { ...target, transport: 'runner_queue' },
      'LOCAL_TARGET_UNREACHABLE',
      'This execution target is not co-located with the backend. Queue a runner job or select a local target with access to this checkout.'
    );
  }
}
