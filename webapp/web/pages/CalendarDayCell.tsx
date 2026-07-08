import { useDroppable } from '@dnd-kit/core';
import { type RefObject, useCallback } from 'react';

import { calendarDayDroppableId, dayKeyFromDate, isWeekend } from '@/lib/calendar-utils.ts';
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
  draggable,
  onDayClick
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
  onDayClick?: (day: Date) => void;
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

  const handleDayClick = useCallback(() => {
    if (!inMonth || !onDayClick) return;
    onDayClick(day);
  }, [day, inMonth, onDayClick]);

  return (
    <div
      ref={setRefs}
      data-day-key={dayKey}
      role={inMonth && onDayClick ? 'button' : undefined}
      tabIndex={inMonth && onDayClick ? 0 : undefined}
      onClick={handleDayClick}
      onKeyDown={event => {
        if (!inMonth || !onDayClick) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onDayClick(day);
        }
      }}
      className={cn(
        'min-h-24 border-r border-border p-1 last:border-r-0',
        inMonth && onDayClick && 'cursor-pointer',
        !inMonth && 'bg-muted/15',
        inMonth && isWeekend(day) && 'bg-muted/25 dark:bg-muted/40',
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
        <div className="flex flex-col gap-1" onClick={event => event.stopPropagation()}>
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
