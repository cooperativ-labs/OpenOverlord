import { useMemo } from 'react';

import type {
  ProjectMentionOption,
  MissionMentionOption
} from '../components/MentionableTextarea.tsx';

import { useProjectRepository, useProjects, useMissions } from './queries.ts';

/**
 * File, project, and mission mention options for a project's repository context.
 * Shared by {@link RepositoryMentionTextarea} and inline objective editors.
 */
export function useRepositoryMentionOptions(projectId: string) {
  const repository = useProjectRepository(projectId, null);
  const projects = useProjects();
  const missions = useMissions(projectId);

  const mentionPaths = useMemo(
    () =>
      (repository.data?.entries ?? [])
        .filter(entry => entry.type === 'file')
        .map(entry => entry.path),
    [repository.data]
  );

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
