import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type { ProjectRepositoryDto, ProjectResourceDto } from "../../../shared/contract.ts";
import { useProjectRepository, useProjectResources } from "../../lib/queries.ts";

interface ProjectRepositoryContextValue {
  projectId: string;
  selectedExecutionTargetId: string | null;
  setSelectedExecutionTargetId: (executionTargetId: string | null) => void;
  resources: ProjectResourceDto[];
  repository: ProjectRepositoryDto | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

const ProjectRepositoryContext = createContext<ProjectRepositoryContextValue | null>(null);

export function ProjectRepositoryProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const [selectedExecutionTargetId, setSelectedExecutionTargetId] = useState<string | null>(null);
  const resources = useProjectResources(projectId);
  const repository = useProjectRepository(projectId, selectedExecutionTargetId);

  useEffect(() => {
    setSelectedExecutionTargetId(null);
  }, [projectId]);

  const value = useMemo<ProjectRepositoryContextValue>(
    () => ({
      projectId,
      selectedExecutionTargetId,
      setSelectedExecutionTargetId,
      resources: resources.data ?? [],
      repository: repository.data ?? null,
      isLoading: resources.isLoading || repository.isLoading,
      error:
        resources.error instanceof Error
          ? resources.error
          : repository.error instanceof Error
            ? repository.error
            : null,
      refetch: () => {
        void resources.refetch();
        void repository.refetch();
      },
    }),
    [
      projectId,
      repository.data,
      repository.error,
      repository.isLoading,
      repository.refetch,
      resources.data,
      resources.error,
      resources.isLoading,
      resources.refetch,
      selectedExecutionTargetId,
    ],
  );

  return (
    <ProjectRepositoryContext.Provider value={value}>
      {children}
    </ProjectRepositoryContext.Provider>
  );
}

export function useProjectRepositoryContext(): ProjectRepositoryContextValue {
  const value = useContext(ProjectRepositoryContext);
  if (!value) {
    throw new Error("useProjectRepositoryContext must be used within ProjectRepositoryProvider.");
  }
  return value;
}
