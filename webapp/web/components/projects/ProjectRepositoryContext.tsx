import { useQuery } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useMemo } from 'react';

import type {
  CapabilityResult,
  RepositoryTreeResult
} from '../../../../packages/core/service/local-target/types.ts';
import type {
  EligibleExecutionTargetDto,
  ProjectRepositoryDto,
  ProjectResourceDto
} from '../../../shared/contract.ts';
import { hasDesktopLocalTargetBridge, invokeLocalTarget } from '../../lib/local-target-client.ts';
import {
  useLaunchSettings,
  useProjectExecutionTarget,
  useProjectRepository,
  useProjectResources,
  useUpdateProjectExecutionTarget
} from '../../lib/queries.ts';
import { useResourceObservationReporter } from '../../lib/resource-observations.ts';

interface ProjectRepositoryContextValue {
  projectId: string;
  selectedExecutionTargetId: string | null;
  setSelectedExecutionTargetId: (executionTargetId: string | null) => void;
  eligibleTargets: EligibleExecutionTargetDto[];
  resources: ProjectResourceDto[];
  repository: ProjectRepositoryDto | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

const ProjectRepositoryContext = createContext<ProjectRepositoryContextValue | null>(null);

function mergeRepositoryWithBridge({
  restRepository,
  bridgeTree
}: {
  restRepository: ProjectRepositoryDto;
  bridgeTree: CapabilityResult<RepositoryTreeResult>;
}): ProjectRepositoryDto {
  if (!bridgeTree.ok) return restRepository;

  return {
    ...restRepository,
    status: 'ready',
    rootPath: bridgeTree.value.rootPath,
    gitRoot: bridgeTree.value.gitRoot,
    branch: bridgeTree.value.branch,
    commit: bridgeTree.value.commit,
    entries: bridgeTree.value.entries,
    truncated: bridgeTree.value.truncated,
    message: null
  };
}

export function ProjectRepositoryProvider({
  projectId,
  children
}: {
  projectId: string;
  children: ReactNode;
}) {
  const executionTarget = useProjectExecutionTarget(projectId);
  const updateExecutionTarget = useUpdateProjectExecutionTarget(projectId);
  const selectedExecutionTargetId = executionTarget.data?.selectedExecutionTargetId ?? null;
  const resources = useProjectResources(projectId);
  const launchSettings = useLaunchSettings();
  const localExecutionTargetId = launchSettings.data?.executionTargetId ?? null;
  const restRepository = useProjectRepository(projectId, selectedExecutionTargetId);

  useResourceObservationReporter({
    projectId,
    executionTargetId: localExecutionTargetId,
    resources: resources.data ?? [],
    enabled: Boolean(localExecutionTargetId)
  });

  const bridgeEnabled =
    hasDesktopLocalTargetBridge() &&
    restRepository.data?.resource?.type === 'local_directory' &&
    Boolean(restRepository.data.resource.path);

  const bridgeTree = useQuery({
    queryKey: [
      'local-target-repository-tree',
      projectId,
      selectedExecutionTargetId,
      restRepository.data?.resource?.id,
      restRepository.data?.resource?.path
    ],
    queryFn: () =>
      invokeLocalTarget({
        capability: 'readRepositoryTree',
        input: {
          resourceId: restRepository.data!.resource!.id,
          repoPath: restRepository.data!.resource!.path
        }
      }),
    enabled: bridgeEnabled,
    staleTime: 60_000
  });

  const repository = useMemo(() => {
    if (!restRepository.data) return null;
    if (!bridgeEnabled || !bridgeTree.data) return restRepository.data;
    return mergeRepositoryWithBridge({
      restRepository: restRepository.data,
      bridgeTree: bridgeTree.data
    });
  }, [bridgeEnabled, bridgeTree.data, restRepository.data]);

  const setSelectedExecutionTargetId = useCallback(
    (executionTargetId: string | null) => {
      updateExecutionTarget.mutate({ executionTargetId });
    },
    [updateExecutionTarget]
  );

  const value = useMemo<ProjectRepositoryContextValue>(
    () => ({
      projectId,
      selectedExecutionTargetId,
      setSelectedExecutionTargetId,
      eligibleTargets: executionTarget.data?.eligibleTargets ?? [],
      resources: resources.data ?? [],
      repository,
      isLoading:
        executionTarget.isLoading ||
        resources.isLoading ||
        restRepository.isLoading ||
        (bridgeEnabled && bridgeTree.isLoading),
      error:
        executionTarget.error instanceof Error
          ? executionTarget.error
          : resources.error instanceof Error
            ? resources.error
            : restRepository.error instanceof Error
              ? restRepository.error
              : bridgeTree.error instanceof Error
                ? bridgeTree.error
                : null,
      refetch: () => {
        void executionTarget.refetch();
        void resources.refetch();
        void restRepository.refetch();
        if (bridgeEnabled) void bridgeTree.refetch();
      }
    }),
    [
      projectId,
      executionTarget,
      repository,
      resources,
      selectedExecutionTargetId,
      setSelectedExecutionTargetId,
      restRepository,
      bridgeEnabled,
      bridgeTree
    ]
  );

  return (
    <ProjectRepositoryContext.Provider value={value}>{children}</ProjectRepositoryContext.Provider>
  );
}

export function useProjectRepositoryContext(): ProjectRepositoryContextValue {
  const value = useContext(ProjectRepositoryContext);
  if (!value) {
    throw new Error('useProjectRepositoryContext must be used within ProjectRepositoryProvider.');
  }
  return value;
}
