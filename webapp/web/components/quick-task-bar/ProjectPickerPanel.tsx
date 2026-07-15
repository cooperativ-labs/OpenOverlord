import { cn } from '@/lib/utils';

import type { ProjectOption } from './quick-task-helpers';

type ProjectPickerPanelProps = {
  projects: ProjectOption[];
  selectedProjectId: string;
  onSelect: (projectId: string) => void;
};

export function ProjectPickerPanel({
  projects,
  selectedProjectId,
  onSelect
}: ProjectPickerPanelProps) {
  // Projects can span every workspace the caller is a member of (coo:324);
  // label the groups only when more than one workspace is represented.
  const workspaceIds = [...new Set(projects.map(project => project.workspaceId))];
  const showWorkspaceGroups = workspaceIds.length > 1;

  return (
    <div className="electron-no-drag rounded-xl border bg-background/95 p-2 shadow-lg backdrop-blur-md">
      {projects.length === 0 ? (
        <p className="px-2 py-1.5 text-sm text-muted-foreground">No projects</p>
      ) : (
        workspaceIds.map(workspaceId => {
          const group = projects.filter(project => project.workspaceId === workspaceId);
          return (
            <div key={workspaceId}>
              {showWorkspaceGroups ? (
                <p className="px-2 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {group[0]?.workspaceName ?? 'Workspace'}
                </p>
              ) : null}
              {group.map(project => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => onSelect(project.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted',
                    project.id === selectedProjectId && 'bg-muted/60'
                  )}
                >
                  <span
                    className="h-3 w-3 rounded-[4px] border"
                    style={{
                      backgroundColor: project.color ?? undefined,
                      borderColor: project.color ?? undefined
                    }}
                  />
                  <span className="truncate">{project.name}</span>
                </button>
              ))}
            </div>
          );
        })
      )}
    </div>
  );
}
