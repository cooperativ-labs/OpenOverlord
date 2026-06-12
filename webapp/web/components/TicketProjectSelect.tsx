import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { useProjects, useProject, useUpdateTicket } from '@/lib/queries.ts';
import { cn } from '@/lib/utils';

type TicketProjectSelectProps = {
  ticketId: string;
  projectId: string;
  onProjectChanged?: (projectId: string) => void;
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

export function TicketProjectSelect({
  ticketId,
  projectId,
  onProjectChanged
}: TicketProjectSelectProps) {
  const projectsQ = useProjects();
  const currentProjectQ = useProject(projectId);
  const update = useUpdateTicket(ticketId);

  const projects = (projectsQ.data ?? []).filter(project => project.status === 'active');
  const currentProject = projects.find(project => project.id === projectId) ?? currentProjectQ.data;

  function handleChange(nextProjectId: string | null) {
    if (!nextProjectId || nextProjectId === projectId) return;
    update.mutate(
      { projectId: nextProjectId },
      {
        onSuccess: () => onProjectChanged?.(nextProjectId)
      }
    );
  }

  return (
    <Select value={projectId} disabled={update.isPending} onValueChange={handleChange}>
      <SelectTrigger
        id="ticket-project-select"
        aria-label="Select project"
        size="sm"
        className={cn(
          'h-6 w-auto max-w-[10rem] rounded-md border bg-transparent px-2 text-xs font-base hover:bg-muted'
        )}
      >
        <SelectValue>
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <ProjectColorDot color={currentProject?.color ?? null} />
            <span className="truncate">{currentProject?.name ?? 'Project'}</span>
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {projects.map(project => (
          <SelectItem key={project.id} value={project.id}>
            <span className="inline-flex items-center gap-1.5">
              <ProjectColorDot color={project.color} />
              <span className="truncate">{project.name}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
