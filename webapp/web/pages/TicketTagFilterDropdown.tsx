import { Tag } from 'lucide-react';

import { Button as ToolbarButton } from '@/components/ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu.tsx';

import { getTagFilterLabel, type TicketTagFilterOption } from './board-shared.ts';

export function TicketTagFilterDropdown({
  tagOptions,
  selectedTagIds,
  onClear,
  onToggle
}: {
  tagOptions: TicketTagFilterOption[];
  selectedTagIds: string[];
  onClear: () => void;
  onToggle: (tagId: string) => void;
}) {
  if (tagOptions.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <ToolbarButton
            variant="outline"
            size="sm"
            className="gap-1.5"
            aria-label="Filter tickets by tag"
          />
        }
      >
        <Tag className="h-3.5 w-3.5" />
        {getTagFilterLabel(selectedTagIds, tagOptions)}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel>Filter by tag</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={selectedTagIds.length === 0}
          onCheckedChange={onClear}
          onSelect={event => event.preventDefault()}
        >
          All tags
        </DropdownMenuCheckboxItem>
        {tagOptions.map(tag => (
          <DropdownMenuCheckboxItem
            key={tag.id}
            checked={selectedTagIds.includes(tag.id)}
            onCheckedChange={() => onToggle(tag.id)}
            onSelect={event => event.preventDefault()}
            className="gap-2"
          >
            {tag.color ? (
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full border"
                style={{ backgroundColor: tag.color, borderColor: tag.color }}
              />
            ) : null}
            <span className="truncate">{tag.label}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
