import { useProject } from '@/lib/queries.ts';
import { cn } from '@/lib/utils';

type TicketProjectSelectProps = {
  projectId: string;
};

function ProjectColorDot({ color }: { color: string | null }) {
  return (
    <span
      aria-hidden
      className="inline-block size-2 shrink-0 rounded-full ring-1 ring-black/10"
      style={{ backgroundColor: color ?? 'var(--color-border)' }}
    />
  );
}

/** Read-only project label until ticket project moves are exposed on the REST API. */
export function TicketProjectSelect({ projectId }: TicketProjectSelectProps) {
  const projectQ = useProject(projectId);
  const projectName = projectQ.data?.name ?? 'Project';

  return (
    <div
      aria-label={`Project: ${projectName}`}
      className={cn(
        'inline-flex h-7 max-w-[10rem] items-center gap-1.5 rounded-lg border border-input px-2 text-xs',
        'bg-transparent text-muted-foreground'
      )}
    >
      <ProjectColorDot color={projectQ.data?.color ?? null} />
      <span className="truncate">{projectName}</span>
    </div>
  );
}
