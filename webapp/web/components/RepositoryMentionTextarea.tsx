import { type ComponentPropsWithoutRef } from 'react';

import { useRepositoryMentionOptions } from '@/lib/useRepositoryMentionOptions.ts';
import { cn } from '@/lib/utils';

import { MentionableTextarea } from './MentionableTextarea.tsx';

// Mirrors the app Textarea chrome (see components/ui/textarea.tsx) so a mention
// field is visually indistinguishable from a plain one.
const TEXTAREA_CHROME =
  'field-sizing-content min-h-16 rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors placeholder:text-muted-foreground md:text-sm dark:bg-input/30';

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
  menuOwnerId,
  ...props
}: RepositoryMentionTextareaProps) {
  const { mentionPaths, projectMentionOptions, ticketMentionOptions } =
    useRepositoryMentionOptions(projectId);

  return (
    <MentionableTextarea
      mentionPaths={mentionPaths}
      projectMentionOptions={projectMentionOptions}
      ticketMentionOptions={ticketMentionOptions}
      mentionMenuMode="portal"
      menuOwnerId={menuOwnerId}
      className={cn(TEXTAREA_CHROME, className)}
      {...props}
    />
  );
}
