import type { EligibleExecutionTargetDto, ProjectResourceDto } from '../../shared/contract.ts';

export const PRIMARY_RESOURCE_REPAIR_HINT =
  'Run `ovld add-cwd` from your project checkout or link a directory in project settings.';

export const EXECUTION_TARGET_REPAIR_HINT =
  "Try disconnecting and reconnecting this project's primary resource.";

export type PrimaryResourceConnectionState = {
  connected: boolean;
  primary: ProjectResourceDto | null;
  message: string | null;
};

export function primaryResourceConnection(
  resources: ProjectResourceDto[]
): PrimaryResourceConnectionState {
  const primary =
    resources.find(resource => resource.isPrimary && resource.status !== 'archived') ?? null;
  if (!primary) {
    return {
      connected: false,
      primary: null,
      message: `No primary resource is linked for this project. ${PRIMARY_RESOURCE_REPAIR_HINT}`
    };
  }
  if (primary.status === 'missing') {
    return {
      connected: false,
      primary,
      message: `Primary working directory is missing (${primary.path}). ${PRIMARY_RESOURCE_REPAIR_HINT}`
    };
  }
  if (primary.type !== 'local_directory') {
    return {
      connected: false,
      primary,
      message: `Primary resource type "${primary.type}" is not supported for local agent runs yet.`
    };
  }
  return { connected: true, primary, message: null };
}

/**
 * Pick the local-directory resource a client-side capability should read against
 * (e.g. the `@`-mention file tree).
 *
 * When `resourceKey` is provided and connected on the (optionally target-scoped)
 * set, the matching resource wins; otherwise this falls back to the project
 * primary so callers never end up with an empty resource just because a bound key
 * isn't linked on the current device. Passing a null/blank key reduces to
 * "resolve the primary resource for this target".
 */
export function resolveResourceForKey({
  resources,
  executionTargetId,
  resourceKey = null
}: {
  resources: ProjectResourceDto[];
  executionTargetId: string | null;
  resourceKey?: string | null;
}): ProjectResourceDto | null {
  const active = resources.filter(
    resource => resource.status === 'active' && resource.type === 'local_directory'
  );
  if (active.length === 0) return null;

  const forTarget =
    executionTargetId === null
      ? active
      : active.filter(
          resource =>
            resource.executionTargetId === executionTargetId || resource.executionTargetId === null
        );
  if (forTarget.length === 0) return null;

  const key = resourceKey?.trim();
  if (key) {
    const forKey = forTarget.filter(resource => resource.resourceKey === key);
    if (forKey.length > 0) {
      return (
        forKey.find(resource => resource.executionTargetId === executionTargetId) ??
        forKey.find(resource => resource.isPrimary) ??
        forKey[0] ??
        null
      );
    }
    // Bound key isn't linked on this target — fall through to the primary below.
  }

  return (
    forTarget.find(resource => resource.isPrimary) ??
    forTarget.find(resource => resource.executionTargetId === executionTargetId) ??
    forTarget[0] ??
    null
  );
}

export const OBJECTIVE_RESOURCE_REPAIR_HINT =
  'Link the resource in project settings or run `ovld add-cwd --key <key>` from the checkout.';

/**
 * Mission-create payload fragment for a single first objective, binding it to
 * `resourceKey` when one is chosen. Callers spread the result into
 * `CreateMissionBody` so a resource-bound draft and an unbound one share one path:
 * a bound key needs the `objectives[]` shape (the only one that carries
 * `resourceKey`), while the unbound case keeps the simpler `firstObjective`.
 */
export function firstObjectiveCreatePayload(
  objective: string,
  resourceKey?: string | null
): { objectives: Array<{ objective: string; resourceKey: string }> } | { firstObjective: string } {
  const key = resourceKey?.trim();
  return key ? { objectives: [{ objective, resourceKey: key }] } : { firstObjective: objective };
}

/**
 * Distinct resource keys offered in the resource picker. `read` (reference)
 * resources are intentionally excluded — they are readable context, not a working
 * directory a mission can be bound to and run in (coo:368). Primary resources are
 * always `read_write`, so they are never filtered out here.
 */
export function distinctProjectResourceKeys(resources: ProjectResourceDto[]): string[] {
  const keys = new Set<string>();
  for (const resource of resources) {
    if (
      resource.status !== 'archived' &&
      resource.accessMode !== 'read' &&
      resource.resourceKey.trim()
    ) {
      keys.add(resource.resourceKey);
    }
  }
  return [...keys].sort((left, right) => left.localeCompare(right));
}

export function projectResourceLabel({
  resources,
  resourceKey
}: {
  resources: ProjectResourceDto[];
  resourceKey: string;
}): string {
  const match = resources.find(resource => resource.resourceKey === resourceKey);
  return match?.label?.trim() || resourceKey;
}

/**
 * Resource key shown for a mission card: the draft objective's binding, falling
 * back to the project primary. Returns null when the project has only one
 * logical resource (nothing useful to distinguish on the card).
 */
export function missionDraftResourceBadgeKey({
  resources,
  draftObjectiveResourceKey
}: {
  resources: ProjectResourceDto[];
  draftObjectiveResourceKey: string | null;
}): string | null {
  const resourceKeys = distinctProjectResourceKeys(resources);
  if (resourceKeys.length <= 1) return null;

  const primaryKey = primaryResourceConnection(resources).primary?.resourceKey ?? null;
  return draftObjectiveResourceKey?.trim() || primaryKey || resourceKeys[0] || null;
}

export function objectiveResourceConnection({
  resources,
  resourceKey,
  executionTargetId = null
}: {
  resources: ProjectResourceDto[];
  resourceKey?: string | null;
  executionTargetId?: string | null;
}): PrimaryResourceConnectionState {
  const boundKey = resourceKey?.trim();
  if (!boundKey) {
    return primaryResourceConnection(resources);
  }

  const matches = resources.filter(
    resource => resource.resourceKey === boundKey && resource.status !== 'archived'
  );
  if (matches.length === 0) {
    return {
      connected: false,
      primary: null,
      message: `Objective resource "${boundKey}" is not linked to this project. ${OBJECTIVE_RESOURCE_REPAIR_HINT}`
    };
  }

  const resource =
    executionTargetId === null
      ? matches[0]!
      : (matches.find(item => item.executionTargetId === executionTargetId) ?? matches[0]!);

  if (resource.status === 'missing') {
    return {
      connected: false,
      primary: resource,
      message: `Objective resource "${boundKey}" working directory is missing (${resource.path}). Run \`ovld add-cwd --key ${boundKey}\` from the intended checkout.`
    };
  }
  if (resource.type !== 'local_directory') {
    return {
      connected: false,
      primary: resource,
      message: `Objective resource "${boundKey}" type "${resource.type}" is not supported for local agent runs yet.`
    };
  }

  return { connected: true, primary: resource, message: null };
}

export type ExecutionTargetAvailabilityState = {
  available: boolean;
  message: string | null;
};

/**
 * Mirror of {@link primaryResourceConnection} for execution targets: a project
 * can have a linked primary resource while pointing at an execution target that
 * no longer exists among the user's available targets (e.g. a device whose id
 * reset on update). When that happens there is nowhere to run, so surface the
 * same style of warning the missing-resource path uses and steer the user toward
 * disconnecting and reconnecting the primary resource to rebuild the target link.
 *
 * Only meaningful once a primary resource is connected; when the resource itself
 * is missing the primary-resource warning takes precedence and this stays quiet.
 */
export function executionTargetAvailability({
  primaryConnected,
  eligibleTargets
}: {
  primaryConnected: boolean;
  eligibleTargets: EligibleExecutionTargetDto[] | undefined;
}): ExecutionTargetAvailabilityState {
  if (!primaryConnected || eligibleTargets === undefined) {
    return { available: true, message: null };
  }
  if (eligibleTargets.length === 0) {
    return {
      available: false,
      message: `This project's primary resource is linked, but no matching execution target is available among your execution targets. ${EXECUTION_TARGET_REPAIR_HINT}`
    };
  }
  return { available: true, message: null };
}
