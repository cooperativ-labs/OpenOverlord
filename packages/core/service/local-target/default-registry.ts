// Default provider registration for the local-target capability resolver (WS-A/C).
// Callers pass runtime context (co-location, caller target id); the registry
// picks in-process vs runner-queue vs unavailable from the target ref alone.

import { InProcessProvider } from './in-process-provider.ts';
import { RunnerQueueProvider } from './runner-queue-provider.ts';
import {
  type ExecutionTargetRef,
  LocalTargetProviderRegistry,
  targetMetadata,
  UnavailableProvider
} from './registry.ts';

export type DefaultLocalTargetRegistryOptions = {
  /** True when the backend process can touch checkout paths directly (Local SQLite). */
  coLocatedWithCheckout: boolean;
  /** The execution target id for the device running this service-layer call, if known. */
  callerExecutionTargetId?: string | null;
};

/**
 * Build a registry with the standard transport priority:
 * 1. In-process for the caller's co-located local target, or any local target
 *    when the backend is co-located with checkouts.
 * 2. Runner queue for other reachable local targets (remote Desktop / Cloud).
 * 3. Unavailable for everything else (unreachable targets, unsupported types).
 */
export function createDefaultLocalTargetRegistry({
  coLocatedWithCheckout,
  callerExecutionTargetId = null
}: DefaultLocalTargetRegistryOptions): LocalTargetProviderRegistry {
  const registry = new LocalTargetProviderRegistry();

  registry.register(target => {
    if (target.type !== 'local' || !target.executionTargetId) return null;
    const isCallerTarget =
      callerExecutionTargetId !== null && target.executionTargetId === callerExecutionTargetId;
    if (coLocatedWithCheckout || isCallerTarget) {
      return new InProcessProvider(
        targetMetadata(target, isCallerTarget ? 'in_process' : 'in_process')
      );
    }
    if (target.reachable === false) {
      return new UnavailableProvider(
        targetMetadata(target, 'fake'),
        'LOCAL_TARGET_UNREACHABLE',
        'The selected execution target is offline. Start a runner on that device or choose another target.'
      );
    }
    return new RunnerQueueProvider(targetMetadata(target, 'runner_queue'));
  });

  return registry;
}

export function resolveDefaultLocalTargetProvider({
  target,
  options
}: {
  target: ExecutionTargetRef;
  options: DefaultLocalTargetRegistryOptions;
}): ReturnType<LocalTargetProviderRegistry['resolveOrUnavailable']> {
  return createDefaultLocalTargetRegistry(options).resolveOrUnavailable(target);
}
