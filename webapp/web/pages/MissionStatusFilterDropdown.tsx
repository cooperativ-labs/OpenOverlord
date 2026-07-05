import { Filter } from 'lucide-react';

import { STATUS_CONFIG, statusClasses } from '@/components/ui.tsx';
import { Button as ToolbarButton } from '@/components/ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu.tsx';
import { cn } from '@/lib/utils';

import type { StatusType } from '../../shared/contract.ts';

import { getStatusFilterLabel } from './board-shared.ts';

/**
 * Minimal status shape this dropdown needs. The project board passes
 * `WorkspaceStatusDto` rows (id = status id); My Missions passes its merged
 * columns (id = the lowercase-name column key) so filtering matches the
 * deduplicated columns rather than one workspace's status ids.
 */
export type StatusFilterOption = { id: string; name: string; type: StatusType };

export function MissionStatusFilterDropdown({
  statuses,
  selectedStatusIds,
  onClear,
  onToggle
}: {
  statuses: StatusFilterOption[];
  selectedStatusIds: string[];
  onClear: () => void;
  onToggle: (statusId: string) => void;
}) {
  if (statuses.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <ToolbarButton
            variant="outline"
            size="lg"
            className="px-3"
            aria-label="Filter missions by status"
          />
        }
      >
        <Filter className="h-3.5 w-3.5" />
        {getStatusFilterLabel(selectedStatusIds, statuses)}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel>Filter by status</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={selectedStatusIds.length === 0}
          onCheckedChange={onClear}
          onSelect={event => event.preventDefault()}
        >
          All statuses
        </DropdownMenuCheckboxItem>
        {statuses.map(status => {
          const StatusIcon = STATUS_CONFIG[status.type].icon;
          return (
            <DropdownMenuCheckboxItem
              key={status.id}
              checked={selectedStatusIds.includes(status.id)}
              onCheckedChange={() => onToggle(status.id)}
              onSelect={event => event.preventDefault()}
              className="gap-2"
            >
              <StatusIcon className={cn('h-3.5 w-3.5 shrink-0', statusClasses(status.type))} />
              <span className="truncate">{status.name}</span>
            </DropdownMenuCheckboxItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
