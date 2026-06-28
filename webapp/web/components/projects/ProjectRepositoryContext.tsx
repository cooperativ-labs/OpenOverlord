import { createContext, type ReactNode, useCallback, useContext, useMemo } from 'react';

import type { EligibleExecutionTargetDto, ProjectRepositoryDto, ProjectResourceDto } from '../../../shared/contract.ts';
import {
  useProjectExecutionTarget,
  useProjectRepository,
  useProjectResources,
  useUpdateProjectExecutionTarget
} from '../../lib/queries.ts';

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
  const repository = useProjectRepository(projectId, selectedExecutionTargetId);

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
      repository: repository.data ?? null,
      isLoading: executionTarget.isLoading || resources.isLoading || repository.isLoading,
      error:
        executionTarget.error instanceof Error
          ? executionTarget.error
          : resources.error instanceof Error
            ? resources.error
            : repository.error instanceof Error
              ? repository.error
              : null,
      refetch: () => {
        void executionTarget.refetch();
        void resources.refetch();
        void repository.refetch();
      }
    }),
    [
      projectId,
      executionTarget,
      repository,
      resources,
      selectedExecutionTargetId,
      setSelectedExecutionTargetId
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
