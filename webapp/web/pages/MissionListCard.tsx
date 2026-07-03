import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useNavigate } from '@tanstack/react-router';
import { GripVertical } from 'lucide-react';

import { MissionTimerCircleButton } from '@/components/everhour/MissionTimerButtons';
import { cn } from '@/lib/utils';

import type { MissionDto, WorkspaceMemberDto } from '../../shared/contract.ts';

import {
  MissionAssigneeAvatar,
  MissionCompleteCheckbox,
  MissionDueDateBadge
} from './MissionCardPrimitives.tsx';

export function MissionListCard({
  mission,
  projectId,
  projectColor,
  assignee,
  selected,
  isDragOverlay,
  onComplete,
  onOpen
}: {
  mission: MissionDto;
  projectId: string;
  projectName: string;
  projectColor: string | null;
  assignee?: WorkspaceMemberDto | null;
  selected?: boolean;
  isDragOverlay?: boolean;
  onComplete?: (missionId: string) => void;
  /** Override the default navigate-to-project-mission click (e.g. the My Missions board). */
  onOpen?: () => void;
}) {
  const navigate = useNavigate();
  const { listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: mission.id, disabled: isDragOverlay });

  const openMission =
    onOpen ??
    (() =>
      navigate({
        to: '/projects/$projectId/missions/$missionId',
        params: { projectId, missionId: mission.id }
      }));

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

      {/* Title */}
      <div className="min-w-0 flex-1">
        <span
          className={cn(
            'block truncate text-sm font-semibold leading-snug text-foreground',
            mission.statusType === 'complete' && 'text-muted-foreground line-through'
          )}
        >
          {mission.title}
        </span>
      </div>

      {/* Right metadata row */}
      <div className="flex shrink-0 items-center gap-2.5">
        <span
          className="font-mono text-[11px] tabular-nums text-muted-foreground"
          title={`Mission ID: ${mission.displayId}`}
        >
          {mission.displayId}
        </span>
        <MissionDueDateBadge dueDatetime={mission.dueDatetime} />
        {mission.objectiveCount > 0 ? (
          <span
            className="border rounded-full px-1.5 py-0.5 hidden text-[9px] tabular-nums text-muted-foreground bg-muted sm:inline"
            title={`${mission.completedObjectiveCount} of ${mission.objectiveCount} objectives complete`}
          >
            {mission.completedObjectiveCount}/{mission.objectiveCount}
          </span>
        ) : null}
        <MissionTimerCircleButton missionId={mission.id} />
        <MissionAssigneeAvatar assignee={assignee} />
      </div>
    </div>
  );
}
