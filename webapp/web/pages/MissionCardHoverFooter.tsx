import { Tag } from 'lucide-react';
import type { MouseEvent, PointerEvent } from 'react';

import { DeleteMissionButton } from '@/components/DeleteMissionButton';
import { Button } from '@/components/ui/button';
import { CardFooter } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

import type { MissionTagFilterOption } from './board-shared.ts';

function TagsSelector({ tags }: { tags: MissionTagFilterOption[] }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(
              'h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground',
              tags.length > 0 && 'text-foreground'
            )}
            aria-label="View mission tags"
            onClick={event => event.stopPropagation()}
            onPointerDown={event => event.stopPropagation()}
          />
        }
      >
        <Tag className="h-3.5 w-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-48"
        onClick={event => event.stopPropagation()}
        onPointerDown={event => event.stopPropagation()}
      >
        <DropdownMenuLabel>Mission tags</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {tags.length > 0 ? (
          tags.map(tag => (
            <DropdownMenuItem key={tag.id} className="gap-2">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full border"
                style={
                  tag.color ? { backgroundColor: tag.color, borderColor: tag.color } : undefined
                }
              />
              <span className="truncate">{tag.label}</span>
            </DropdownMenuItem>
          ))
        ) : (
          <DropdownMenuItem disabled className="text-muted-foreground">
            No tags
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function MissionCardHoverFooter({
  missionId,
  projectId,
  displayId,
  tags
}: {
  missionId: string;
  projectId: string;
  displayId: string;
  tags: MissionTagFilterOption[];
}) {
  const stopPropagation = (event: MouseEvent | PointerEvent) => {
    event.stopPropagation();
  };

  return (
    <CardFooter
      className={cn(
        'p-0',
        'grid grid-rows-[0fr] opacity-0 transition-all duration-150 ease-out',
        'group-hover:grid-rows-[1fr] group-hover:opacity-100',
        'focus-within:grid-rows-[1fr] focus-within:opacity-100'
      )}
      onClick={stopPropagation}
      onPointerDown={stopPropagation}
    >
      <div className="overflow-hidden">
        <div className="flex items-center gap-1.5 border-t border-border/60 bg-muted/80 px-2 py-1">
          <TagsSelector tags={tags} />

          <div className="ml-auto flex items-center gap-1.5">
            <span
              className="text-[10px] tabular-nums text-muted-foreground"
              title={`Mission ID: ${displayId}`}
            >
              {displayId}
            </span>
            <DeleteMissionButton
              missionId={missionId}
              projectId={projectId}
              className="h-6 w-6 border-0 bg-transparent text-muted-foreground hover:bg-transparent hover:text-red-500 [&_svg]:h-3.5 [&_svg]:w-3.5"
            />
          </div>
        </div>
      </div>
    </CardFooter>
  );
}
