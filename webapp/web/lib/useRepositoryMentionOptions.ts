import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import type { RepositoryTreeResult } from '../../../packages/core/service/local-target/types.ts';
import type {
  MissionMentionOption,
  ProjectMentionOption
} from '../components/MentionableTextarea.tsx';

import { hasDesktopLocalTargetBridge, invokeLocalTarget } from './local-target-client.ts';
import { resolveResourceForKey } from './project-resources.ts';
import {
  useMissions,
  useProjectExecutionTarget,
  useProjectRepository,
  useProjectResources,
  useProjects
} from './queries.ts';

/**
 * File, project, and mission mention options for a project's repository context.
 * Shared by {@link RepositoryMentionTextarea} and inline objective editors.
 *
 * `resourceKey` selects which linked resource supplies the `@`-mention file tree,
 * so a multi-resource project's mentions follow the objective's resource binding.
 * A null/blank key resolves the project primary resource.
 *
 * File paths use the unified desktop local-target bridge when available; otherwise
 * the REST repository tree (loopback SQLite dev fallback).
 */
export function useRepositoryMentionOptions(projectId: string, resourceKey?: string | null) {
  const executionTarget = useProjectExecutionTarget(projectId);
  const selectedExecutionTargetId = executionTarget.data?.selectedExecutionTargetId ?? null;
  const resources = useProjectResources(projectId);
  const repository = useProjectRepository(
    projectId,
    selectedExecutionTargetId,
    resourceKey ?? null
  );
  const projects = useProjects();
  const missions = useMissions(projectId);

  const mentionResource = useMemo(
    () =>
      resolveResourceForKey({
        resources: resources.data ?? [],
        executionTargetId: selectedExecutionTargetId,
        resourceKey: resourceKey ?? null
      }),
    [resources.data, selectedExecutionTargetId, resourceKey]
  );

  const useBridgePaths = hasDesktopLocalTargetBridge() && Boolean(mentionResource?.path);

  const bridgeMentions = useQuery({
    queryKey: ['repository-mention-paths', projectId, mentionResource?.id, mentionResource?.path],
    queryFn: async () => {
      const result = await invokeLocalTarget<RepositoryTreeResult>({
        capability: 'readRepositoryTree',
        input: {
          resourceId: mentionResource!.id,
          repoPath: mentionResource!.path
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
    () =>
      (projects.data ?? [])
        .filter(project => project.status === 'active')
        .map(project => ({ id: project.id, name: project.name })),
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
