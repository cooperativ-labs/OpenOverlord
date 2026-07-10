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
import { useCallback, useEffect, useRef, useState } from 'react';

import { type BoardDndResult, type ColumnMap, columnMapsEqual } from './board-shared.ts';

function findColumn(columns: ColumnMap, id: string): string | undefined {
  if (id in columns) return id;
  return Object.keys(columns).find(columnId => columns[columnId]?.includes(id));
}

/** Destination of a completed drop, handed to the page to persist. */
export interface MyMissionsDropTarget {
  /** The moved mission id. */
  movedMissionId: string;
  /** The destination merged-column key (its DnD droppable id). */
  dropColumnKey: string;
  /** Every mission id occupying the destination merged column, top-to-bottom. */
  orderedMissionIds: string[];
}

/**
 * Drag-and-drop state machine for the My Missions aggregate board. Mirrors the
 * project board's optimistic-override pattern (`useBoardColumnDnd`): a drop is
 * applied to a local override immediately, then handed to `onDrop` to persist.
 * Because My Missions merges like-named columns across workspaces, resolving a
 * drop to a concrete workspace status (and validating it exists in the card's
 * own workspace) is workspace-aware logic the page owns — the hook only decides
 * *that* something moved, not *how* it persists. `onDrop` rejects to signal an
 * invalid or failed move, which reverts the optimistic override.
 */
export function useMyMissionsDnd({
  columns,
  onDrop,
  draggable = true
}: {
  columns: ColumnMap;
  onDrop: (target: MyMissionsDropTarget) => Promise<void>;
  draggable?: boolean;
}): BoardDndResult {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [override, setOverride] = useState<ColumnMap | null>(null);
  // DnD Kit can deliver `onDragEnd` immediately after `onDragOver`, before
  // React has rendered the state update from the latter. Keep the active board
  // layout in a ref as well so a cross-column drop always persists the card in
  // its destination column rather than the stale pre-drag list.
  const overrideRef = useRef<ColumnMap | null>(null);

  const setOptimisticOverride = useCallback((next: ColumnMap | null) => {
    overrideRef.current = next;
    setOverride(next);
  }, []);

  // Drop the optimistic override once the real columns catch up to it.
  useEffect(() => {
    if (activeId === null && override !== null && columnMapsEqual(override, columns)) {
      setOptimisticOverride(null);
    }
  }, [activeId, override, columns, setOptimisticOverride]);

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

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      setActiveId(String(event.active.id));
      setOptimisticOverride(columns);
    },
    [columns, setOptimisticOverride]
  );

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const { active, over } = event;
      if (!over) return;
      const activeMissionId = String(active.id);
      const overId = String(over.id);
      const source = overrideRef.current ?? columns;
      const fromCol = findColumn(source, activeMissionId);
      const toCol = findColumn(source, overId);
      if (!fromCol || !toCol || fromCol === toCol) return;

      const fromItems = source[fromCol] ?? [];
      const toItems = source[toCol] ?? [];
      const overIndex = toItems.indexOf(overId);
      const insertAt = overIndex >= 0 ? overIndex : toItems.length;
      setOptimisticOverride({
        ...source,
        [fromCol]: fromItems.filter(id => id !== activeMissionId),
        [toCol]: [...toItems.slice(0, insertAt), activeMissionId, ...toItems.slice(insertAt)]
      });
    },
    [columns, setOptimisticOverride]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      const id = String(active.id);
      const source = overrideRef.current ?? columns;
      const dropColumn = over ? findColumn(source, String(over.id)) : undefined;

      setActiveId(null);

      if (!dropColumn) {
        setOptimisticOverride(null);
        return;
      }

      const items = source[dropColumn] ?? [];
      const fromIndex = items.indexOf(id);
      const overIndex =
        over && String(over.id) !== dropColumn ? items.indexOf(String(over.id)) : items.length - 1;
      const finalItems =
        fromIndex !== -1 && overIndex !== -1 && fromIndex !== overIndex
          ? arrayMove(items, fromIndex, overIndex)
          : items;

      const finalColumns: ColumnMap = { ...source, [dropColumn]: finalItems };
      setOptimisticOverride(finalColumns);

      if (columnMapsEqual(finalColumns, columns)) {
        setOptimisticOverride(null);
        return;
      }

      // Persist through the page. A rejection (invalid target workspace, or a
      // server error) rolls the optimistic override back to server truth.
      void onDrop({
        movedMissionId: id,
        dropColumnKey: dropColumn,
        orderedMissionIds: finalItems
      }).catch(() => setOptimisticOverride(null));
    },
    [columns, onDrop, setOptimisticOverride]
  );

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
    setOptimisticOverride(null);
  }, [setOptimisticOverride]);

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
