import { useProfile, useProjectRepository, useTicketFileChanges } from '@/lib/queries';

import { LiveFileChangeCard } from './LiveFileChangeCard.tsx';
import { Spinner } from './ui.tsx';

/**
 * Realtime File Changes section for the ticket panel. Lists the structured
 * per-file change rationales (`change_rationales`) recorded for the ticket,
 * newest-first, each rendered as a collapsible {@link LiveFileChangeCard}. The
 * query is invalidated by the global SSE change feed, so rationales written by
 * the agent or CLI in another process stream in without a manual refresh.
 * Adapted from the reference `LiveFileChanges` for this app's stack.
 */
export function LiveFileChanges({
  ticketId,
  projectId
}: {
  ticketId: string;
  projectId: string;
}) {
  const fileChangesQ = useTicketFileChanges(ticketId);
  const profileQ = useProfile();
  const repositoryQ = useProjectRepository(projectId, null);

  if (fileChangesQ.isLoading) {
    return (
      <div className="flex justify-center py-4">
        <Spinner />
      </div>
    );
  }

  if (fileChangesQ.isError) {
    return (
      <p className="text-sm text-red-400">
        Could not load file changes: {(fileChangesQ.error as Error)?.message ?? 'unknown error'}
      </p>
    );
  }

  const fileChanges = fileChangesQ.data ?? [];
  const rootPath = repositoryQ.data?.rootPath ?? null;
  const editorScheme = profileQ.data?.editorScheme ?? null;
  if (fileChanges.length === 0) {
    return <p className="text-sm italic text-[var(--color-ink-dim)]">No file changes yet.</p>;
  }

  return (
    <div className="grid gap-3">
      {fileChanges.map(fileChange => (
        <LiveFileChangeCard
          key={fileChange.id}
          fileChange={fileChange}
          rootPath={rootPath}
          editorScheme={editorScheme}
        />
      ))}
    </div>
  );
}
