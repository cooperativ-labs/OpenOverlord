import { Tag } from 'lucide-react';
import { useMemo, type MouseEvent, type PointerEvent } from 'react';

import { DeleteMissionButton } from '@/components/DeleteMissionButton';
import { MissionTimerCircleButton } from '@/components/everhour/MissionTimerButtons';
import { Button } from '@/components/ui/button';
import { CardFooter } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { useProjectTags, useUpdateMission } from '@/lib/queries.ts';
import { cn } from '@/lib/utils';

function TagsSelector({
  missionId,
  projectId,
  assignedTagIds
}: {
  missionId: string;
  projectId: string;
  assignedTagIds: string[];
}) {
  const tagsQ = useProjectTags(projectId);
  const updateMission = useUpdateMission(missionId);
  const assignedTagIdSet = useMemo(() => new Set(assignedTagIds), [assignedTagIds]);

  const tagOptions = useMemo(() => {
    const projectTags = tagsQ.data ?? [];
    const activeTags = projectTags.filter(tag => tag.active);
    const activeIds = new Set(activeTags.map(tag => tag.id));
    const inactiveAssigned = projectTags.filter(
      tag => !tag.active && assignedTagIdSet.has(tag.id)
    );
    return [...activeTags, ...inactiveAssigned];
  }, [assignedTagIdSet, tagsQ.data]);

  const toggleTag = (tagId: string) => {
    const next = assignedTagIdSet.has(tagId)
      ? assignedTagIds.filter(id => id !== tagId)
      : [...assignedTagIds, tagId];
    updateMission.mutate({ tagIds: next });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(
              'h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground',
              assignedTagIds.length > 0 && 'text-foreground'
            )}
            aria-label="Manage mission tags"
            disabled={updateMission.isPending}
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
        {tagOptions.length > 0 ? (
          tagOptions.map(tag => (
            <DropdownMenuCheckboxItem
              key={tag.id}
              checked={assignedTagIdSet.has(tag.id)}
              disabled={updateMission.isPending}
              onCheckedChange={() => toggleTag(tag.id)}
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
          ))
        ) : (
          <DropdownMenuItem disabled className="text-muted-foreground">
            No tags in project
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
  assignedTagIds
}: {
  missionId: string;
  projectId: string;
  displayId: string;
  assignedTagIds: string[];
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
          <TagsSelector
            missionId={missionId}
            projectId={projectId}
            assignedTagIds={assignedTagIds}
          />

          <div className="ml-auto flex items-center gap-1.5">
            <span
              className="text-[10px] tabular-nums text-muted-foreground"
              title={`Mission ID: ${displayId}`}
            >
              {displayId}
            </span>
            <MissionTimerCircleButton missionId={missionId} />
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
