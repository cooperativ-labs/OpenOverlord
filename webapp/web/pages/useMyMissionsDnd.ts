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
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { useCallback, useEffect, useState } from 'react';

import type { WorkspaceStatusDto } from '../../shared/contract.ts';
import { useReorderMyMissions } from '../lib/queries.ts';

import { type BoardDndResult, type ColumnMap, columnMapsEqual } from './board-shared.ts';

/**
 * Drag-and-drop state machine for the My Missions aggregate board. Mirrors the
 * project board's optimistic-override pattern (`useBoardColumnDnd`) but persists
 * through `useReorderMyMissions`: a within-column drop reorders the operator's
 * personal slots, a cross-column drop is a real status change. When the server
 * rejects a move (e.g. a status the mission's workspace lacks) the override is
 * reverted and `onReorderError` is invoked so the page can alert the operator.
 */
export function useMyMissionsDnd({
  columns,
  statuses,
  onReorderError
}: {
  columns: ColumnMap;
  statuses: WorkspaceStatusDto[];
  onReorderError: (status: WorkspaceStatusDto, error: unknown) => void;
}): BoardDndResult {
  const reorder = useReorderMyMissions();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [override, setOverride] = useState<ColumnMap | null>(null);

  // Drop the optimistic override once the real columns catch up to it.
  useEffect(() => {
    if (activeId === null && override !== null && columnMapsEqual(override, columns)) {
      setOverride(null);
    }
  }, [activeId, override, columns]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const collisionDetection = useCallback((...args: Parameters<typeof pointerWithin>) => {
    const hits = pointerWithin(...args);
    return hits.length > 0 ? hits : closestCenter(...args);
  }, []);

  const displayColumns = override ?? columns;

  const findColumn = useCallback(
    (id: string): string | undefined => {
      if (id in displayColumns) return id;
      return Object.keys(displayColumns).find(statusId => displayColumns[statusId]?.includes(id));
    },
    [displayColumns]
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      setActiveId(String(event.active.id));
      setOverride(columns);
    },
    [columns]
  );

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const { active, over } = event;
      if (!over) return;
      const activeMissionId = String(active.id);
      const overId = String(over.id);
      const fromCol = findColumn(activeMissionId);
      const toCol = findColumn(overId);
      if (!fromCol || !toCol || fromCol === toCol) return;

      setOverride(prev => {
        const source = prev ?? columns;
        const fromItems = source[fromCol] ?? [];
        const toItems = source[toCol] ?? [];
        const overIndex = toItems.indexOf(overId);
        const insertAt = overIndex >= 0 ? overIndex : toItems.length;
        return {
          ...source,
          [fromCol]: fromItems.filter(id => id !== activeMissionId),
          [toCol]: [...toItems.slice(0, insertAt), activeMissionId, ...toItems.slice(insertAt)]
        };
      });
    },
    [columns, findColumn]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      const id = String(active.id);
      const dropColumn = over ? findColumn(String(over.id)) : undefined;

      setActiveId(null);

      if (!dropColumn) {
        setOverride(null);
        return;
      }

      const source = override ?? columns;
      const items = source[dropColumn] ?? [];
      const fromIndex = items.indexOf(id);
      const overIndex =
        over && String(over.id) !== dropColumn ? items.indexOf(String(over.id)) : items.length - 1;
      const finalItems =
        fromIndex !== -1 && overIndex !== -1 && fromIndex !== overIndex
          ? arrayMove(items, fromIndex, overIndex)
          : items;

      const finalColumns: ColumnMap = { ...source, [dropColumn]: finalItems };
      setOverride(finalColumns);

      if (columnMapsEqual(finalColumns, columns)) {
        setOverride(null);
        return;
      }

      const status = statuses.find(s => s.id === dropColumn);
      if (!status) {
        setOverride(null);
        return;
      }

      reorder.mutate(
        {
          statusId: dropColumn,
          statusType: status.type,
          orderedMissionIds: finalItems
        },
        {
          onError: error => {
            setOverride(null);
            onReorderError(status, error);
          }
        }
      );
    },
    [columns, findColumn, onReorderError, override, reorder, statuses]
  );

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
    setOverride(null);
  }, []);

  return {
    activeId,
    displayColumns,
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
