import { useLaunchSettings, useProjectExecutionTarget } from './queries.ts';

/** True when the project's selected execution target is not this desktop device. */
export function isRemoteExecutionTargetSelected({
  localExecutionTargetId,
  selectedExecutionTargetId
}: {
  localExecutionTargetId: string | null;
  selectedExecutionTargetId: string | null;
}): boolean {
  if (!selectedExecutionTargetId) return false;
  if (!localExecutionTargetId) return true;
  return selectedExecutionTargetId !== localExecutionTargetId;
}

export function useIsRemoteExecutionTargetForProject(projectId: string): boolean {
  const launchSettings = useLaunchSettings();
  const executionTarget = useProjectExecutionTarget(projectId);
  return isRemoteExecutionTargetSelected({
    localExecutionTargetId: launchSettings.data?.executionTargetId ?? null,
    selectedExecutionTargetId: executionTarget.data?.selectedExecutionTargetId ?? null
  });
}

export function hasPendingLocalTargetMutation(
  executionRequests: Array<{ localTargetMutationKind?: string | null; status: string }>
): boolean {
  return executionRequests.some(
    request =>
      request.localTargetMutationKind &&
      (request.status === 'queued' ||
        request.status === 'claimed' ||
        request.status === 'launching')
  );
}
