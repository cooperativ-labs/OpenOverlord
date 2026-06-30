import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useNavigate } from '@tanstack/react-router';
import { GripVertical, Tag } from 'lucide-react';

import { Badge, priorityClasses } from '@/components/ui.tsx';
import { cn } from '@/lib/utils';

import type { MissionDto, WorkspaceMemberDto } from '../../shared/contract.ts';

import { getMissionTags } from './board-shared.ts';
import { MissionAssigneeAvatar, MissionCompleteCheckbox } from './MissionCardPrimitives.tsx';

export function MissionListCard({
  mission,
  projectId,
  projectColor,
  assignee,
  selected,
  isDragOverlay,
  onComplete
}: {
  mission: MissionDto;
  projectId: string;
  projectName: string;
  projectColor: string | null;
  assignee?: WorkspaceMemberDto | null;
  selected?: boolean;
  isDragOverlay?: boolean;
  onComplete?: (missionId: string) => void;
}) {
  const navigate = useNavigate();
  const { listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: mission.id, disabled: isDragOverlay });

  const tags = getMissionTags(mission);

  const openMission = () =>
    navigate({
      to: '/projects/$projectId/missions/$missionId',
      params: { projectId, missionId: mission.id }
    });

  return (
    <div
      ref={isDragOverlay ? undefined : setNodeRef}
      style={
        isDragOverlay ? undefined : { transform: CSS.Transform.toString(transform), transition }
      }
      role="button"
      tabIndex={0}
      aria-label={`Open ${mission.displayId}: ${mission.title}`}
      onClick={openMission}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openMission();
        }
      }}
      className={cn(
        'group relative flex cursor-pointer items-center gap-2.5 rounded-md border border-transparent px-2 py-2 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        isDragging && 'opacity-40',
        isDragOverlay && 'border-border bg-card shadow-lg',
        selected && 'bg-primary/10 ring-1 ring-inset ring-primary/30'
      )}
    >
      {/* Drag handle — activates dnd-kit reorder/move without triggering navigation. */}
      <span
        ref={isDragOverlay ? undefined : setActivatorNodeRef}
        {...(isDragOverlay ? {} : listeners)}
        aria-label="Drag to reorder"
        onClick={event => event.stopPropagation()}
        className="-ml-0.5 flex h-4 w-3 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing"
      >
        <GripVertical className="h-3.5 w-3.5" />
      </span>

      <MissionCompleteCheckbox
        color={projectColor}
        completed={mission.statusType === 'complete'}
        onComplete={onComplete ? () => onComplete(mission.id) : undefined}
      />

      {/* Title + tags */}
      <div className="min-w-0 flex-1">
        <span
          className={cn(
            'block truncate text-sm font-semibold leading-snug text-foreground',
            mission.statusType === 'complete' && 'text-muted-foreground line-through'
          )}
        >
          {mission.title}
        </span>
        {tags.length > 0 ? (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {tags.map(tag => (
              <span
                key={tag.id}
                className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground"
                style={
                  tag.color ? { backgroundColor: `${tag.color}22`, color: tag.color } : undefined
                }
              >
                <Tag className="h-2.5 w-2.5" />
                {tag.label}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {/* Right metadata row */}
      <div className="flex shrink-0 items-center gap-2.5">
        <span
          className="font-mono text-[11px] tabular-nums text-muted-foreground"
          title={`Mission ID: ${mission.displayId}`}
        >
          {mission.displayId}
        </span>
        {mission.objectiveCount > 0 ? (
          <span
            className="hidden text-[11px] tabular-nums text-muted-foreground sm:inline"
            title={`${mission.completedObjectiveCount} of ${mission.objectiveCount} objectives complete`}
          >
            {mission.completedObjectiveCount}/{mission.objectiveCount}
          </span>
        ) : null}
        {mission.priority ? (
          <Badge className={priorityClasses(mission.priority)}>{mission.priority}</Badge>
        ) : null}
        <MissionAssigneeAvatar assignee={assignee} />
      </div>
    </div>
  );
}
