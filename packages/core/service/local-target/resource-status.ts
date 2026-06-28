// Resource status, routed through the local-target capability interface (WS-D 1).
//
// Before this, three sites (core projects.ts ×2, webapp repository.ts) each
// derived a resource's status with a direct `existsSync(path)` gated on
// `dialect === 'sqlite'`. That conflated backend-owned *lifecycle* (active/
// archived) with a *target observation* (does the path exist on this machine),
// and let the hosted backend mark a path `missing` from its own filesystem.
//
// Now the lifecycle stays backend-owned and the availability comes from
// `observeResource` on a provider. When the backend is co-located with the
// checkout (Local SQLite) it resolves an in-process provider; otherwise it gets
// no provider and the status falls back to the recorded lifecycle — the hosted
// backend never infers `missing` from its own disk (design §5/§6, R1).

import type { SqlDialect } from '@overlord/database';

import { InProcessProvider } from './in-process-provider.ts';
import { UnavailableProvider } from './registry.ts';
import type { LocalTargetCapabilities, TargetMetadata } from './types.ts';

/**
 * Single source of truth for the co-location policy: the backend process can
 * touch linked checkouts only when it runs against the Local SQLite database
 * (the Postgres/cloud backend is never co-located with a checkout). Accepts a
 * `DatabaseClient` (or any `{ dialect }`) or a bare dialect so both the
 * ServiceContext callers and the webapp's module-level `DATABASE_DIALECT` can
 * share one spelling.
 */
export function isCoLocatedBackend(source: SqlDialect | { dialect: SqlDialect }): boolean {
  const dialect = typeof source === 'string' ? source : source.dialect;
  return dialect === 'sqlite';
}

/**
 * Resolve the provider that can observe a resource for the backend. When the
 * backend is co-located with the checkout (Local SQLite), that is the in-process
 * provider; otherwise there is no local target reachable from the backend, so
 * the returned provider reports every capability unavailable (and the caller
 * falls back to lifecycle status). This is the seam that replaces ad-hoc
 * `dialect === 'sqlite'` filesystem guards in the webapp backend.
 */
export function resolveBackendResourceProvider(
  coLocatedWithCheckout: boolean,
  target: TargetMetadata
): LocalTargetCapabilities {
  return coLocatedWithCheckout
    ? new InProcessProvider(target)
    : new UnavailableProvider(
        target,
        'LOCAL_TARGET_REQUIRED',
        'The backend is not co-located with this checkout; resource availability must be observed by a local target.'
      );
}

/**
 * Map backend lifecycle + a target observation to the resource status the REST
 * DTO exposes (`active | missing | archived`). Archived is terminal lifecycle
 * and never observed; otherwise an `available`/`missing` observation maps to
 * `active`/`missing`, and anything else (no provider, unreachable, …) preserves
 * the recorded lifecycle status.
 */
export async function deriveResourceStatus(
  provider: LocalTargetCapabilities,
  resource: { resourceId: string; status: string; path: string }
): Promise<string> {
  if (resource.status === 'archived') return 'archived';
  const observation = await provider.observeResource({
    resourceId: resource.resourceId,
    path: resource.path
  });
  if (!observation.ok) return resource.status;
  if (observation.value.state === 'available') return 'active';
  if (observation.value.state === 'missing') return 'missing';
  return resource.status;
}
