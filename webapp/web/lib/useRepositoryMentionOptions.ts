import { useMemo } from 'react';

import type {
  ProjectMentionOption,
  TicketMentionOption
} from '../components/MentionableTextarea.tsx';

import { useProjectRepository, useProjects, useTickets } from './queries.ts';

/**
 * File, project, and ticket mention options for a project's repository context.
 * Shared by {@link RepositoryMentionTextarea} and inline objective editors.
 */
export function useRepositoryMentionOptions(projectId: string) {
  const repository = useProjectRepository(projectId, null);
  const projects = useProjects();
  const tickets = useTickets(projectId);

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

  const ticketMentionOptions = useMemo<TicketMentionOption[]>(
    () =>
      (tickets.data ?? []).map(ticket => ({
        id: ticket.id,
        displayId: ticket.displayId,
        title: ticket.title
      })),
    [tickets.data]
  );

  return { mentionPaths, projectMentionOptions, ticketMentionOptions };
}
