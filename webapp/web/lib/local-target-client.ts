import type { LocalTargetBridgeCall } from '../../packages/core/service/local-target/desktop-bridge.ts';
import type { CapabilityResult } from '../../packages/core/service/local-target/types.ts';
import { useQuery } from '@tanstack/react-query';

import type { LocalTargetServerCapability } from './api.ts';
import { api } from './api.ts';

let cachedServerLocalTarget: LocalTargetServerCapability | null = null;
let serverLocalTargetPromise: Promise<LocalTargetServerCapability> | null = null;

async function resolveServerLocalTarget(): Promise<LocalTargetServerCapability> {
  if (cachedServerLocalTarget) return cachedServerLocalTarget;
  if (!serverLocalTargetPromise) {
    serverLocalTargetPromise = api
      .meta()
      .then(meta => {
        cachedServerLocalTarget = meta.capabilities.localTarget;
        return cachedServerLocalTarget;
      })
      .catch(() => 'unavailable' as const);
  }
  return serverLocalTargetPromise;
}

/** True when the desktop shell exposes the unified local-target IPC bridge. */
export function hasDesktopLocalTargetBridge(): boolean {
  return (
    typeof window !== 'undefined' && typeof window.overlord?.invokeLocalTarget === 'function'
  );
}

/**
 * Invoke a checkout-local capability through the desktop bridge when available,
 * otherwise through the loopback SQLite dev proxy, otherwise fail typed.
 */
export async function invokeLocalTarget<T>(
  call: LocalTargetBridgeCall
): Promise<CapabilityResult<T>> {
  if (hasDesktopLocalTargetBridge()) {
    return (await window.overlord!.invokeLocalTarget!(call)) as CapabilityResult<T>;
  }

  const serverCapability = await resolveServerLocalTarget();
  if (serverCapability === 'in_process_server') {
    return (await api.invokeLocalTarget(call)) as CapabilityResult<T>;
  }

  return {
    ok: false,
    code: 'LOCAL_TARGET_REQUIRED',
    message: 'Open Overlord Desktop to browse linked checkouts on this machine.',
    target: {
      executionTargetId: null,
      deviceLabel: null,
      transport: 'in_process'
    }
  };
}

/** True when checkout-local capabilities can run (desktop bridge or loopback dev proxy). */
export function useLocalTargetCapabilityAvailable(): boolean {
  const meta = useQuery({
    queryKey: ['meta-local-target-capability'],
    queryFn: () => api.meta().then(response => response.capabilities.localTarget),
    enabled: !hasDesktopLocalTargetBridge(),
    staleTime: 60_000
  });

  if (hasDesktopLocalTargetBridge()) return true;
  return meta.data === 'in_process_server';
}

/** True when neither the desktop bridge nor the dev server proxy is available. */
export function useLocalTargetUnavailable(): boolean {
  const meta = useQuery({
    queryKey: ['meta-local-target-capability'],
    queryFn: () => api.meta().then(response => response.capabilities.localTarget),
    enabled: !hasDesktopLocalTargetBridge(),
    staleTime: 60_000
  });

  if (hasDesktopLocalTargetBridge()) return false;
  return meta.data === 'unavailable';
}

export async function isLocalTargetCapabilityAvailable(): Promise<boolean> {
  if (hasDesktopLocalTargetBridge()) return true;
  const capability = await resolveServerLocalTarget();
  return capability === 'in_process_server';
}
