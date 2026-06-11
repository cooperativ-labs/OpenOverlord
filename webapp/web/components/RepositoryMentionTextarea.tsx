import { type ComponentPropsWithoutRef, useMemo } from 'react';

import { cn } from '@/lib/utils';

import { useProjectRepository } from '../lib/queries.ts';

import { MentionableTextarea } from './MentionableTextarea.tsx';

// Mirrors the app Textarea chrome (see components/ui/textarea.tsx) so a mention
// field is visually indistinguishable from a plain one.
const TEXTAREA_CHROME =
  'field-sizing-content min-h-16 rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30';

type MentionableProps = ComponentPropsWithoutRef<typeof MentionableTextarea>;

type RepositoryMentionTextareaProps = Omit<MentionableProps, 'mentionPaths'> & {
  /** Project whose git tree supplies the `@`-mention file list. */
  projectId: string;
};

/**
 * A {@link MentionableTextarea} wired to a project's repository file tree, so
 * typing `@` offers that project's tracked files. Used by the ticket and
 * objective creation forms.
 */
export function RepositoryMentionTextarea({
  projectId,
  className,
  ...props
}: RepositoryMentionTextareaProps) {
  const repository = useProjectRepository(projectId, null);

  const mentionPaths = useMemo(
    () =>
      (repository.data?.entries ?? [])
        .filter(entry => entry.type === 'file')
        .map(entry => entry.path),
    [repository.data]
  );

  return (
    <MentionableTextarea
      mentionPaths={mentionPaths}
      mentionMenuMode="portal"
      className={cn(TEXTAREA_CHROME, className)}
      {...props}
    />
  );
}
