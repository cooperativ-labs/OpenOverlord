import { useState } from 'react';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { useProject, useProjects, useUpdateMission } from '@/lib/queries.ts';
import { cn } from '@/lib/utils';

import type { ProjectDto } from '../../shared/contract.ts';

type MissionProjectSelectProps = {
  missionId: string;
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

function ProjectOptionLabel({ project }: { project: ProjectDto }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <ProjectColorDot color={project.color} />
      <span className="truncate">{project.name}</span>
    </span>
  );
}

export function MissionProjectSelect({
  missionId,
  projectId,
  onProjectChanged
}: MissionProjectSelectProps) {
  const projectsQ = useProjects();
  const currentProjectQ = useProject(projectId);
  const update = useUpdateMission(missionId);
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);

  const projects = (projectsQ.data ?? []).filter(project => project.status === 'active');
  const selectedProjectId = pendingProjectId ?? projectId;
  const currentProject =
    projects.find(project => project.id === selectedProjectId) ??
    (selectedProjectId === projectId ? currentProjectQ.data : undefined);

  function handleChange(nextProjectId: string | null) {
    if (!nextProjectId || nextProjectId === selectedProjectId) return;
    setPendingProjectId(nextProjectId);
    update.mutate(
      { projectId: nextProjectId },
      {
        onSuccess: () => {
          setPendingProjectId(null);
          onProjectChanged?.(nextProjectId);
        },
        onError: () => setPendingProjectId(null)
      }
    );
  }

  return (
    <Select
      value={selectedProjectId}
      disabled={update.isPending}
      onValueChange={handleChange}
    >
      <SelectTrigger
        id="mission-project-select"
        aria-label="Select project"
        size="sm"
        className={cn(
          'h-[22px] w-auto max-w-36 rounded-full border-border/80 bg-transparent px-2 text-xs font-normal text-foreground hover:border-border hover:bg-muted/60 hover:text-foreground'
        )}
      >
        <SelectValue>
          {currentProject ? (
            <ProjectOptionLabel project={currentProject} />
          ) : (
            <span className="truncate">Project</span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {projects.map(project => (
          <SelectItem key={project.id} value={project.id}>
            <ProjectOptionLabel project={project} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
