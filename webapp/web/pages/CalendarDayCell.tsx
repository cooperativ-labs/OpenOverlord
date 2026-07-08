import { useDroppable } from '@dnd-kit/core';
import { useCallback, type RefObject } from 'react';

import { calendarDayDroppableId, dayKeyFromDate } from '@/lib/calendar-utils.ts';
import { cn } from '@/lib/utils';

import type { MissionDto } from '../../shared/contract.ts';

import { MissionCalendarCard } from './MissionCalendarCard.tsx';

export function CalendarDayCell({
  day,
  dayMissions,
  inMonth,
  isToday,
  todayRef,
  projectId,
  projectColor,
  selectedMissionId,
  onCompleteMission,
  activeMissionId,
  draggable
}: {
  day: Date;
  dayMissions: MissionDto[];
  inMonth: boolean;
  isToday: boolean;
  todayRef: RefObject<HTMLDivElement | null>;
  projectId: string;
  projectColor: string | null;
  selectedMissionId?: string;
  onCompleteMission?: (missionId: string) => void;
  activeMissionId: string | null;
  draggable: boolean;
}) {
  const dayKey = dayKeyFromDate(day);
  const { isOver, setNodeRef } = useDroppable({ id: calendarDayDroppableId(dayKey) });

  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      setNodeRef(node);
      if (isToday) {
        todayRef.current = node;
      }
    },
    [isToday, setNodeRef, todayRef]
  );

  return (
    <div
      ref={setRefs}
      data-day-key={dayKey}
      className={cn(
        'min-h-24 border-r border-border p-1 last:border-r-0',
        !inMonth && 'bg-muted/15',
        isToday && 'bg-primary/5 ring-1 ring-inset ring-primary/20',
        isOver && inMonth && 'bg-primary/10 ring-2 ring-inset ring-primary/40'
      )}
    >
      <div
        className={cn(
          'mb-1 text-xs font-medium tabular-nums',
          inMonth ? 'text-foreground' : 'text-muted-foreground/50'
        )}
      >
        {day.getDate()}
      </div>
      {inMonth ? (
        <div className="flex flex-col gap-1">
          {dayMissions.map(mission => (
            <MissionCalendarCard
              key={mission.id}
              mission={mission}
              projectId={projectId}
              projectColor={projectColor}
              selected={mission.id === selectedMissionId}
              onComplete={onCompleteMission}
              draggable={draggable}
              isDragging={activeMissionId === mission.id}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
