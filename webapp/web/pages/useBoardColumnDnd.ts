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
import { useReorderBoardColumn } from '../lib/queries.ts';

import { type ColumnMap, columnMapsEqual } from './board-shared.ts';

type DndContextProps = {
  sensors: ReturnType<typeof useSensors>;
  collisionDetection: typeof closestCenter;
  onDragStart: (event: DragStartEvent) => void;
  onDragOver: (event: DragOverEvent) => void;
  onDragEnd: (event: DragEndEvent) => void;
  onDragCancel: () => void;
};

/**
 * Shared drag-and-drop state machine for the project board's columns. Both the
 * board (`BoardPage`) and the list (`TicketListView`) move tickets between
 * status columns with identical optimistic-override + reorder-mutation logic;
 * this hook is the single source of that behaviour.
 *
 * `columns` is the source-of-truth mapping of status id → ordered ticket ids.
 * While a drag is in flight the hook keeps an optimistic `override` and exposes
 * it as `displayColumns`; on drop it persists the new order via
 * `useReorderBoardColumn` and reconciles the override once the real data
 * catches up. Pass `draggable: false` to disable drag activation (e.g. when a
 * filtered subset is shown and reordering would corrupt the hidden order).
 */
export function useBoardColumnDnd({
  columns,
  statuses,
  projectId,
  draggable = true
}: {
  columns: ColumnMap;
  statuses: WorkspaceStatusDto[];
  projectId: string;
  draggable?: boolean;
}): {
  activeId: string | null;
  displayColumns: ColumnMap;
  dndContextProps: DndContextProps;
} {
  const reorder = useReorderBoardColumn();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [override, setOverride] = useState<ColumnMap | null>(null);

  // Drop the optimistic override once the real columns catch up to it.
  useEffect(() => {
    if (activeId === null && override !== null && columnMapsEqual(override, columns)) {
      setOverride(null);
    }
  }, [activeId, override, columns]);

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
      const activeTicketId = String(active.id);
      const overId = String(over.id);
      const fromCol = findColumn(activeTicketId);
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
          [fromCol]: fromItems.filter(id => id !== activeTicketId),
          [toCol]: [...toItems.slice(0, insertAt), activeTicketId, ...toItems.slice(insertAt)]
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

      reorder.mutate({
        projectId,
        statusId: dropColumn,
        statusType: status.type,
        orderedTicketIds: finalItems
      });
    },
    [columns, findColumn, override, projectId, reorder, statuses]
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
