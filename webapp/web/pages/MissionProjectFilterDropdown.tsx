import { FolderOpen } from 'lucide-react';

import { Button as ToolbarButton } from '@/components/ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu.tsx';

import { getProjectFilterLabel, type MissionProjectFilterOption } from './board-shared.ts';

/**
 * Filters the aggregate My Missions board down to one or more projects. Only
 * rendered when the caller has missions in more than one project; a
 * single-project board has nothing to filter.
 */
export function MissionProjectFilterDropdown({
  projects,
  selectedProjectIds,
  onClear,
  onToggle
}: {
  projects: MissionProjectFilterOption[];
  selectedProjectIds: string[];
  onClear: () => void;
  onToggle: (projectId: string) => void;
}) {
  if (projects.length < 2) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <ToolbarButton
            variant="outline"
            size="lg"
            className="px-3"
            aria-label="Filter missions by project"
          />
        }
      >
        <FolderOpen className="h-3.5 w-3.5" />
        {getProjectFilterLabel(selectedProjectIds, projects)}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel>Filter by project</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={selectedProjectIds.length === 0}
          onCheckedChange={onClear}
          onSelect={event => event.preventDefault()}
        >
          All projects
        </DropdownMenuCheckboxItem>
        {projects.map(project => (
          <DropdownMenuCheckboxItem
            key={project.id}
            checked={selectedProjectIds.includes(project.id)}
            onCheckedChange={() => onToggle(project.id)}
            onSelect={event => event.preventDefault()}
            className="gap-2"
          >
            {project.color ? (
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full border"
                style={{ backgroundColor: project.color, borderColor: project.color }}
              />
            ) : null}
            <span className="truncate">{project.name}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
