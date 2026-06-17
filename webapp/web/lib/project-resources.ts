import type { ProjectResourceDto } from '../../shared/contract.ts';

export const PRIMARY_RESOURCE_REPAIR_HINT =
  'Run `ovld add-cwd` from your project checkout or link a directory in project settings.';

export type PrimaryResourceConnectionState = {
  connected: boolean;
  primary: ProjectResourceDto | null;
  message: string | null;
};

export function primaryResourceConnection(
  resources: ProjectResourceDto[]
): PrimaryResourceConnectionState {
  const primary = resources.find(resource => resource.isPrimary && resource.status !== 'archived') ?? null;
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
