import { type ComponentPropsWithoutRef } from 'react';

import { useRepositoryMentionOptions } from '@/lib/useRepositoryMentionOptions.ts';
import { cn } from '@/lib/utils';

import { MentionableTextarea } from './MentionableTextarea.tsx';

// Mirrors the app Textarea chrome (see components/ui/textarea.tsx) so a mention
// field is visually indistinguishable from a plain one.
const TEXTAREA_CHROME =
  'field-sizing-content min-h-16 rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors placeholder:text-muted-foreground md:text-sm ';

type MentionableProps = ComponentPropsWithoutRef<typeof MentionableTextarea>;

type RepositoryMentionTextareaProps = Omit<
  MentionableProps,
  'mentionPaths' | 'projectMentionOptions' | 'missionMentionOptions'
> & {
  /** Project whose git tree supplies the `@`-mention file list. */
  projectId: string;
  /**
   * Resource key whose linked directory supplies the `@`-mention file tree. Lets a
   * multi-resource project's mentions follow the selected resource; a null/blank
   * key uses the project primary resource.
   */
  resourceKey?: string | null;
};

/**
 * A {@link MentionableTextarea} wired to project context, so typing:
 *   - `@` offers the selected resource's tracked repository files,
 *   - `#` offers any project by name (inserted as `#[name]`),
 *   - `$` offers a mission in the current project by display id (inserted as `$<displayId>`).
 *
 * Used by the mission and objective creation/edit forms.
 */
export function RepositoryMentionTextarea({
  projectId,
  resourceKey = null,
  className,
  menuOwnerId,
  ...props
}: RepositoryMentionTextareaProps) {
  const { mentionPaths, projectMentionOptions, missionMentionOptions } =
    useRepositoryMentionOptions(projectId, resourceKey);

  return (
    <MentionableTextarea
      mentionPaths={mentionPaths}
      projectMentionOptions={projectMentionOptions}
      missionMentionOptions={missionMentionOptions}
      mentionMenuMode="portal"
      menuOwnerId={menuOwnerId}
      className={cn(TEXTAREA_CHROME, className)}
      {...props}
    />
  );
}
