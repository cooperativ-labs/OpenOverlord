import { Building2 } from 'lucide-react';

import { Button as ToolbarButton } from '@/components/ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu.tsx';

import { getWorkspaceFilterLabel } from './board-shared.ts';

/**
 * Filters the aggregate My Missions board down to one or more workspaces. Only
 * rendered when the caller has missions in more than one workspace of the active
 * organization; a single-workspace board has nothing to filter.
 */
export function MissionWorkspaceFilterDropdown({
  workspaces,
  selectedWorkspaceIds,
  onClear,
  onToggle
}: {
  workspaces: Array<{ id: string; name: string }>;
  selectedWorkspaceIds: string[];
  onClear: () => void;
  onToggle: (workspaceId: string) => void;
}) {
  if (workspaces.length < 2) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <ToolbarButton
            variant="outline"
            size="lg"
            className="px-3"
            aria-label="Filter missions by workspace"
          />
        }
      >
        <Building2 className="h-3.5 w-3.5" />
        {getWorkspaceFilterLabel(selectedWorkspaceIds, workspaces)}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel>Filter by workspace</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={selectedWorkspaceIds.length === 0}
          onCheckedChange={onClear}
          onSelect={event => event.preventDefault()}
        >
          All workspaces
        </DropdownMenuCheckboxItem>
        {workspaces.map(workspace => (
          <DropdownMenuCheckboxItem
            key={workspace.id}
            checked={selectedWorkspaceIds.includes(workspace.id)}
            onCheckedChange={() => onToggle(workspace.id)}
            onSelect={event => event.preventDefault()}
            className="gap-2"
          >
            <span className="truncate">{workspace.name}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
