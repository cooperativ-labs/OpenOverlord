import { type ComponentPropsWithoutRef, useMemo } from 'react';

import { cn } from '@/lib/utils';

import { useProjectRepository, useProjects, useTickets } from '../lib/queries.ts';

import {
  MentionableTextarea,
  type ProjectMentionOption,
  type TicketMentionOption
} from './MentionableTextarea.tsx';

// Mirrors the app Textarea chrome (see components/ui/textarea.tsx) so a mention
// field is visually indistinguishable from a plain one.
const TEXTAREA_CHROME =
  'field-sizing-content min-h-16 rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30';

type MentionableProps = ComponentPropsWithoutRef<typeof MentionableTextarea>;

type RepositoryMentionTextareaProps = Omit<
  MentionableProps,
  'mentionPaths' | 'projectMentionOptions' | 'ticketMentionOptions'
> & {
  /** Project whose git tree supplies the `@`-mention file list. */
  projectId: string;
};

/**
 * A {@link MentionableTextarea} wired to project context, so typing:
 *   - `@` offers the project's tracked repository files,
 *   - `#` offers any project by name (inserted as `#[name]`),
 *   - `$` offers a ticket in the current project by display id (inserted as `$<displayId>`).
 *
 * Used by the ticket and objective creation/edit forms.
 */
export function RepositoryMentionTextarea({
  projectId,
  className,
  ...props
}: RepositoryMentionTextareaProps) {
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

  return (
    <MentionableTextarea
      mentionPaths={mentionPaths}
      projectMentionOptions={projectMentionOptions}
      ticketMentionOptions={ticketMentionOptions}
      mentionMenuMode="portal"
      className={cn(TEXTAREA_CHROME, className)}
      {...props}
    />
  );
}
