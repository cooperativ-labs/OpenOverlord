import { DndContext, DragOverlay } from '@dnd-kit/core';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { EmptyState } from '@/components/ui.tsx';
import {
  calendarWindowRange,
  dayKeyFromDate,
  eachMonthInRange,
  formatMonthLabel,
  getWeeksForMonth,
  isoWeekdayLabels,
  startOfDay
} from '@/lib/calendar-utils.ts';

import type { MissionDto } from '../../shared/contract.ts';

import { CalendarDayCell } from './CalendarDayCell.tsx';
import { MissionCalendarCard } from './MissionCalendarCard.tsx';
import { useCalendarDueDateDnd } from './useCalendarDueDateDnd.ts';

const INITIAL_MONTHS_BEFORE = 3;
const INITIAL_MONTHS_AFTER = 3;
const SCROLL_SENTINEL_MARGIN = '240px';

function findScrollParent(node: HTMLElement | null): HTMLElement | null {
  let parent = node?.parentElement ?? null;
  while (parent) {
    const { overflowY } = getComputedStyle(parent);
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
      return parent;
    }
    parent = parent.parentElement;
  }
  return null;
}

export function MissionCalendarView({
  missions,
  projectId,
  projectColor,
  selectedMissionId,
  onCompleteMission
}: {
  missions: MissionDto[];
  projectId: string;
  projectColor: string | null;
  selectedMissionId?: string;
  onCompleteMission?: (missionId: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null);
  const todayRef = useRef<HTMLDivElement | null>(null);
  const scrollParentRef = useRef<HTMLElement | null>(null);
  const pendingScrollRestoreRef = useRef<number | null>(null);
  const expandingRef = useRef(false);
  const [monthsBefore, setMonthsBefore] = useState(INITIAL_MONTHS_BEFORE);
  const [monthsAfter, setMonthsAfter] = useState(INITIAL_MONTHS_AFTER);
  const anchor = useMemo(() => startOfDay(new Date()), []);
  const todayKey = dayKeyFromDate(anchor);
  const calendarDnd = useCalendarDueDateDnd({ missions });

  const months = useMemo(() => {
    const { start, end } = calendarWindowRange({
      anchor,
      monthsBefore,
      monthsAfter
    });
    return eachMonthInRange({ start, end });
  }, [anchor, monthsAfter, monthsBefore]);

  const expandMonthsBefore = useCallback(() => {
    if (expandingRef.current) return;
    expandingRef.current = true;
    const scrollParent = scrollParentRef.current;
    if (scrollParent) {
      pendingScrollRestoreRef.current = scrollParent.scrollHeight;
    }
    setMonthsBefore(current => current + 1);
  }, []);

  const expandMonthsAfter = useCallback(() => {
    if (expandingRef.current) return;
    expandingRef.current = true;
    setMonthsAfter(current => current + 1);
  }, []);

  useLayoutEffect(() => {
    const scrollParent = scrollParentRef.current;
    const previousHeight = pendingScrollRestoreRef.current;
    if (!scrollParent || previousHeight === null) {
      expandingRef.current = false;
      return;
    }

    const delta = scrollParent.scrollHeight - previousHeight;
    scrollParent.scrollTop += delta;
    pendingScrollRestoreRef.current = null;
    expandingRef.current = false;
  }, [monthsBefore]);

  useLayoutEffect(() => {
    expandingRef.current = false;
  }, [monthsAfter]);

  const weekdayLabels = isoWeekdayLabels();
  const hasScheduledMissions = calendarDnd.displayMissionsByDay.size > 0;

  const activeMission = useMemo(
    () =>
      calendarDnd.activeMissionId
        ? missions.find(mission => mission.id === calendarDnd.activeMissionId)
        : undefined,
    [calendarDnd.activeMissionId, missions]
  );

  useEffect(() => {
    scrollParentRef.current = findScrollParent(rootRef.current);
  }, []);

  useEffect(() => {
    todayRef.current?.scrollIntoView({ block: 'center' });
  }, []);

  useEffect(() => {
    const scrollParent = scrollParentRef.current;
    const topSentinel = topSentinelRef.current;
    const bottomSentinel = bottomSentinelRef.current;
    if (!scrollParent || !topSentinel || !bottomSentinel) return;

    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          if (entry.target === topSentinel) {
            expandMonthsBefore();
          } else if (entry.target === bottomSentinel) {
            expandMonthsAfter();
          }
        }
      },
      { root: scrollParent, rootMargin: SCROLL_SENTINEL_MARGIN, threshold: 0 }
    );

    observer.observe(topSentinel);
    observer.observe(bottomSentinel);
    return () => observer.disconnect();
  }, [expandMonthsAfter, expandMonthsBefore, months.length]);

  if (!hasScheduledMissions) {
    return (
      <EmptyState
        title="No scheduled missions"
        hint="Set due dates in the mission panel to see missions on the calendar."
      />
    );
  }

  return (
    <DndContext {...calendarDnd.dndContextProps}>
      <div ref={rootRef} className="pb-8">
        <div
          ref={topSentinelRef}
          aria-hidden
          className="pointer-events-none h-px w-full opacity-0"
        />

        <div className="sticky top-0 z-20 grid grid-cols-7 border-b border-border bg-background/95 text-center text-xs font-medium text-muted-foreground backdrop-blur-sm">
          {weekdayLabels.map(label => (
            <div key={label} className="border-r border-border px-1 py-2 last:border-r-0">
              {label}
            </div>
          ))}
        </div>

        {months.map(monthDate => {
          const monthKey = dayKeyFromDate(startOfDay(monthDate));
          const weeks = getWeeksForMonth(monthDate);

          return (
            <section key={monthKey}>
              <div className="sticky top-9 z-10 border-b border-border bg-background/95 px-3 py-2 text-sm font-semibold text-foreground backdrop-blur-sm">
                {formatMonthLabel(monthDate)}
              </div>

              {weeks.map((week, weekIndex) => (
                <div
                  key={`${monthKey}-week-${weekIndex}`}
                  className="grid grid-cols-7 border-b border-border"
                >
                  {week.map(day => {
                    const dayKey = dayKeyFromDate(day);
                    const inMonth = day.getMonth() === monthDate.getMonth();
                    const isToday = dayKey === todayKey;
                    const dayMissions = inMonth
                      ? (calendarDnd.displayMissionsByDay.get(dayKey) ?? [])
                      : [];

                    return (
                      <CalendarDayCell
                        key={dayKey}
                        day={day}
                        dayMissions={dayMissions}
                        inMonth={inMonth}
                        isToday={isToday}
                        todayRef={todayRef}
                        projectId={projectId}
                        projectColor={projectColor}
                        selectedMissionId={selectedMissionId}
                        onCompleteMission={onCompleteMission}
                        activeMissionId={calendarDnd.activeMissionId}
                        draggable
                      />
                    );
                  })}
                </div>
              ))}
            </section>
          );
        })}

        <div
          ref={bottomSentinelRef}
          aria-hidden
          className="pointer-events-none h-px w-full opacity-0"
        />
      </div>

      <DragOverlay>
        {activeMission ? (
          <MissionCalendarCard
            mission={activeMission}
            projectId={projectId}
            projectColor={projectColor}
            selected={activeMission.id === selectedMissionId}
            onComplete={onCompleteMission}
            isDragOverlay
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
