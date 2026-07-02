import { ChevronDown, Tag } from 'lucide-react';
import { useMemo } from 'react';

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
import { cn } from '@/lib/utils.ts';

import type { ProjectTagDto } from '../../shared/contract.ts';

import { MissionTagPill } from './MissionTagPill.tsx';

type MissionTagSelectProps = {
  missionId: string;
  projectId: string;
  assignedTags: ProjectTagDto[];
};

export function MissionTagSelect({ missionId, projectId, assignedTags }: MissionTagSelectProps) {
  const tagsQ = useProjectTags(projectId);
  const update = useUpdateMission(missionId);
  const assignedTagIds = useMemo(() => assignedTags.map(tag => tag.id), [assignedTags]);
  const assignedTagIdSet = useMemo(() => new Set(assignedTagIds), [assignedTagIds]);

  const tagOptions = useMemo(() => {
    const projectTags = tagsQ.data ?? [];
    const activeTags = projectTags.filter(tag => tag.active);
    const inactiveAssigned = projectTags.filter(tag => !tag.active && assignedTagIdSet.has(tag.id));
    return [...activeTags, ...inactiveAssigned];
  }, [assignedTagIdSet, tagsQ.data]);

  const toggleTag = (tagId: string) => {
    const next = assignedTagIdSet.has(tagId)
      ? assignedTagIds.filter(id => id !== tagId)
      : [...assignedTagIds, tagId];
    update.mutate({ tagIds: next });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {assignedTags.map(tag => (
        <MissionTagPill
          key={tag.id}
          label={tag.label}
          disabled={update.isPending}
          onRemove={() => toggleTag(tag.id)}
        />
      ))}
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            'px-2 inline-flex h-7 items-center gap-1 bg-transparent text-xs text-foreground/70 font-medium transition-colors',
            'hover:text-foreground',
            'disabled:cursor-not-allowed disabled:opacity-60'
          )}
          disabled={update.isPending || tagOptions.length === 0}
          aria-label="Add tag"
        >
          <Tag className="h-3.5 w-3.5 shrink-0 stroke-[1.75]" />
          Add tag
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[200px]">
          <DropdownMenuLabel>Tags</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {tagOptions.length > 0 ? (
            tagOptions.map(tag => (
              <DropdownMenuCheckboxItem
                key={tag.id}
                checked={assignedTagIdSet.has(tag.id)}
                disabled={update.isPending}
                onCheckedChange={() => toggleTag(tag.id)}
                onSelect={event => event.preventDefault()}
                className="gap-2 text-xs"
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
    </div>
  );
}
