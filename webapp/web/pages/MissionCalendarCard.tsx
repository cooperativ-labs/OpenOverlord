import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { useNavigate } from '@tanstack/react-router';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import type { MissionDto } from '../../shared/contract.ts';

import { MissionCompleteCheckbox, projectColorTint } from './MissionCardPrimitives.tsx';

export function MissionCalendarCard({
  mission,
  projectId,
  projectColor,
  selected,
  onComplete,
  draggable = true,
  isDragging = false,
  isDragOverlay = false
}: {
  mission: MissionDto;
  projectId: string;
  projectColor: string | null;
  selected?: boolean;
  onComplete?: (missionId: string) => void;
  draggable?: boolean;
  isDragging?: boolean;
  isDragOverlay?: boolean;
}) {
  const navigate = useNavigate();
  const { accent, tint } = projectColorTint(projectColor);
  const completed = mission.statusType === 'complete';
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: mission.id,
    disabled: isDragOverlay || !draggable
  });

  const openMission = () => {
    navigate({
      to: '/projects/$projectId/missions/$missionId',
      params: { projectId, missionId: mission.id }
    });
  };

  return (
    <div
      ref={isDragOverlay ? undefined : setNodeRef}
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
      {...(isDragOverlay || !draggable ? {} : { ...attributes, ...listeners })}
      className={cn(
        'flex cursor-pointer items-center gap-1.5 rounded border px-1.5 py-1 text-left transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        draggable && !isDragOverlay && 'touch-none',
        isDragging && 'opacity-40',
        isDragOverlay && 'shadow-lg',
        selected && 'bg-primary/10 ring-1 ring-inset ring-primary/30'
      )}
      style={{
        backgroundColor: tint,
        borderColor: accent,
        ...(isDragOverlay ? undefined : { transform: CSS.Translate.toString(transform) })
      }}
    >
      <span onPointerDown={event => event.stopPropagation()}>
        <MissionCompleteCheckbox
          color={projectColor}
          completed={completed}
          onComplete={onComplete ? () => onComplete(mission.id) : undefined}
        />
      </span>
      <div className="min-w-0 flex-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                className={cn(
                  'block truncate text-xs font-medium leading-snug text-foreground',
                  completed && 'text-muted-foreground line-through'
                )}
              >
                {mission.title}
              </span>
            }
          />
          <TooltipContent>
            <div className="flex max-w-xs flex-col gap-0.5">
              <span>{mission.title}</span>
              <span className="font-mono tabular-nums opacity-80">{mission.displayId}</span>
            </div>
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
