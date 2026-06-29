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
