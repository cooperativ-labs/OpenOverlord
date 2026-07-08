import {
  closestCenter,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  type DayKey,
  groupMissionsByDay,
  parseCalendarDayDroppableId,
  parseDayKey
} from '@/lib/calendar-utils.ts';
import { buildDueDatetime } from '@/lib/due-datetime.ts';

import type { MissionDto } from '../../shared/contract.ts';
import { api } from '../lib/api.ts';
import { keys } from '../lib/queries.ts';
import { invalidateNonEverhourQueries } from '../lib/query-invalidation.ts';

import type { BoardDndResult } from './board-shared.ts';

export type CalendarDndResult = {
  activeMissionId: string | null;
  displayMissionsByDay: Map<DayKey, MissionDto[]>;
  dndContextProps: BoardDndResult['dndContextProps'];
};

function dayKeyByMissionIdFromGrouping(grouped: Map<DayKey, MissionDto[]>): Map<string, DayKey> {
  const map = new Map<string, DayKey>();
  for (const [dayKey, dayMissions] of grouped) {
    for (const mission of dayMissions) {
      map.set(mission.id, dayKey);
    }
  }
  return map;
}

function sortMissionsInDay(left: MissionDto, right: MissionDto): number {
  if (left.boardPosition !== right.boardPosition) {
    return left.boardPosition - right.boardPosition;
  }
  return right.sequenceNumber - left.sequenceNumber;
}

function buildGroupedMissions({
  missions,
  dayKeyByMissionId
}: {
  missions: MissionDto[];
  dayKeyByMissionId: Map<string, DayKey>;
}): Map<DayKey, MissionDto[]> {
  const missionById = new Map(missions.map(mission => [mission.id, mission]));
  const result = new Map<DayKey, MissionDto[]>();

  for (const [missionId, dayKey] of dayKeyByMissionId) {
    const mission = missionById.get(missionId);
    if (!mission) continue;
    const bucket = result.get(dayKey) ?? [];
    bucket.push(mission);
    result.set(dayKey, bucket);
  }

  for (const [key, bucket] of result) {
    bucket.sort(sortMissionsInDay);
    result.set(key, bucket);
  }

  return result;
}

function dayKeyMapsEqual(left: Map<string, DayKey>, right: Map<string, DayKey>): boolean {
  if (left.size !== right.size) return false;
  for (const [missionId, dayKey] of left) {
    if (right.get(missionId) !== dayKey) return false;
  }
  return true;
}

export function useCalendarDueDateDnd({
  missions,
  draggable = true
}: {
  missions: MissionDto[];
  draggable?: boolean;
}): CalendarDndResult {
  const queryClient = useQueryClient();
  const settledMissionsByDay = useMemo(() => groupMissionsByDay(missions), [missions]);
  const settledDayKeyByMissionId = useMemo(
    () => dayKeyByMissionIdFromGrouping(settledMissionsByDay),
    [settledMissionsByDay]
  );

  const [activeMissionId, setActiveMissionId] = useState<string | null>(null);
  const [optimisticDayByMissionId, setOptimisticDayByMissionId] = useState<Map<
    string,
    DayKey
  > | null>(null);
  const [dragStartDayByMissionId, setDragStartDayByMissionId] = useState<Map<
    string,
    DayKey
  > | null>(null);

  const updateDueDate = useMutation({
    mutationFn: ({ missionId, dueDatetime }: { missionId: string; dueDatetime: string }) =>
      api.updateMission(missionId, { dueDatetime }),
    onSuccess: data => {
      queryClient.setQueryData(keys.mission(data.id), data);
      invalidateNonEverhourQueries(queryClient);
    }
  });

  useEffect(() => {
    if (activeMissionId === null && optimisticDayByMissionId !== null) {
      if (dayKeyMapsEqual(optimisticDayByMissionId, settledDayKeyByMissionId)) {
        setOptimisticDayByMissionId(null);
        setDragStartDayByMissionId(null);
      }
    }
  }, [activeMissionId, optimisticDayByMissionId, settledDayKeyByMissionId]);

  const displayMissionsByDay = useMemo(() => {
    if (!optimisticDayByMissionId) return settledMissionsByDay;
    return buildGroupedMissions({ missions, dayKeyByMissionId: optimisticDayByMissionId });
  }, [missions, optimisticDayByMissionId, settledMissionsByDay]);

  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const noSensors = useSensors();
  const sensors = draggable ? dndSensors : noSensors;

  const collisionDetection = useCallback((...args: Parameters<typeof pointerWithin>) => {
    const hits = pointerWithin(...args);
    return hits.length > 0 ? hits : closestCenter(...args);
  }, []);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const missionId = String(event.active.id);
      setActiveMissionId(missionId);
      const seeded = dayKeyByMissionIdFromGrouping(settledMissionsByDay);
      setOptimisticDayByMissionId(seeded);
      setDragStartDayByMissionId(new Map(seeded));
    },
    [settledMissionsByDay]
  );

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;

    const targetDayKey = parseCalendarDayDroppableId(String(over.id));
    if (!targetDayKey) return;

    const missionId = String(active.id);
    setOptimisticDayByMissionId(prev => {
      const next = new Map(prev ?? []);
      next.set(missionId, targetDayKey);
      return next;
    });
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const missionId = String(event.active.id);
      const mission = missions.find(item => item.id === missionId);
      const targetDayKey = optimisticDayByMissionId?.get(missionId);
      const sourceDayKey = dragStartDayByMissionId?.get(missionId);

      setActiveMissionId(null);

      if (!mission || !targetDayKey || targetDayKey === sourceDayKey) {
        setOptimisticDayByMissionId(null);
        setDragStartDayByMissionId(null);
        return;
      }

      const nextDueDatetime = buildDueDatetime({
        selectedDate: parseDayKey(targetDayKey),
        currentDueDatetime: mission.dueDatetime
      });

      updateDueDate.mutate(
        { missionId, dueDatetime: nextDueDatetime },
        {
          onError: () => {
            setOptimisticDayByMissionId(null);
            setDragStartDayByMissionId(null);
          }
        }
      );
    },
    [dragStartDayByMissionId, missions, optimisticDayByMissionId, updateDueDate]
  );

  const handleDragCancel = useCallback(() => {
    setActiveMissionId(null);
    setOptimisticDayByMissionId(null);
    setDragStartDayByMissionId(null);
  }, []);

  return {
    activeMissionId,
    displayMissionsByDay,
    dndContextProps: {
      sensors,
      collisionDetection: collisionDetection as typeof closestCenter,
      onDragStart: handleDragStart,
      onDragOver: handleDragOver,
      onDragEnd: handleDragEnd,
      onDragCancel: handleDragCancel
    }
  };
}
