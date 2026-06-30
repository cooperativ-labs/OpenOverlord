import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import type { RepositoryTreeResult } from '../../../packages/core/service/local-target/types.ts';
import type { ProjectResourceDto } from '../../shared/contract.ts';
import type {
  MissionMentionOption,
  ProjectMentionOption
} from '../components/MentionableTextarea.tsx';

import { hasDesktopLocalTargetBridge, invokeLocalTarget } from './local-target-client.ts';
import {
  useMissions,
  useProjectExecutionTarget,
  useProjectRepository,
  useProjectResources,
  useProjects
} from './queries.ts';

function resolvePrimaryResource({
  resources,
  executionTargetId
}: {
  resources: ProjectResourceDto[];
  executionTargetId: string | null;
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

  return (
    forTarget.find(resource => resource.isPrimary) ??
    forTarget.find(resource => resource.executionTargetId === executionTargetId) ??
    forTarget[0] ??
    null
  );
}

/**
 * File, project, and mission mention options for a project's repository context.
 * Shared by {@link RepositoryMentionTextarea} and inline objective editors.
 *
 * File paths use the unified desktop local-target bridge when available; otherwise
 * the REST repository tree (loopback SQLite dev fallback).
 */
export function useRepositoryMentionOptions(projectId: string) {
  const executionTarget = useProjectExecutionTarget(projectId);
  const selectedExecutionTargetId = executionTarget.data?.selectedExecutionTargetId ?? null;
  const resources = useProjectResources(projectId);
  const repository = useProjectRepository(projectId, selectedExecutionTargetId);
  const projects = useProjects();
  const missions = useMissions(projectId);

  const primaryResource = useMemo(
    () =>
      resolvePrimaryResource({
        resources: resources.data ?? [],
        executionTargetId: selectedExecutionTargetId
      }),
    [resources.data, selectedExecutionTargetId]
  );

  const useBridgePaths = hasDesktopLocalTargetBridge() && Boolean(primaryResource?.path);

  const bridgeMentions = useQuery({
    queryKey: ['repository-mention-paths', projectId, primaryResource?.id, primaryResource?.path],
    queryFn: async () => {
      const result = await invokeLocalTarget<RepositoryTreeResult>({
        capability: 'readRepositoryTree',
        input: {
          resourceId: primaryResource!.id,
          repoPath: primaryResource!.path
        }
      });
      if (!result.ok) return [];
      return result.value.entries.filter(entry => entry.type === 'file').map(entry => entry.path);
    },
    enabled: useBridgePaths,
    staleTime: 60_000
  });

  const mentionPaths = useMemo(() => {
    if (useBridgePaths) {
      return bridgeMentions.data ?? [];
    }
    return (repository.data?.entries ?? [])
      .filter(entry => entry.type === 'file')
      .map(entry => entry.path);
  }, [bridgeMentions.data, repository.data, useBridgePaths]);

  const projectMentionOptions = useMemo<ProjectMentionOption[]>(
    () => (projects.data ?? []).map(project => ({ id: project.id, name: project.name })),
    [projects.data]
  );

  const missionMentionOptions = useMemo<MissionMentionOption[]>(
    () =>
      (missions.data ?? []).map(mission => ({
        id: mission.id,
        displayId: mission.displayId,
        title: mission.title
      })),
    [missions.data]
  );

  return { mentionPaths, projectMentionOptions, missionMentionOptions };
}
